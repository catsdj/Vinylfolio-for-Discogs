import { NextRequest, NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { getDatabase } from '@/lib/database';
import { rejectIfNotLocal } from '@/lib/requestSecurity';
import { rejectIfNotConfigured } from '@/lib/setup';
import {
  DeejayInvoiceItem,
  generateCatalogVariants,
  normalizeCatalogNumber,
  parseDeejayInvoicePdf,
} from '@/lib/invoiceImport';
import { extractYouTubeVideoId } from '@/lib/urlValidation';
import { secureFetch } from '@/lib/secureFetch';

export const runtime = 'nodejs';

interface DiscogsSearchResult {
  id: number;
  type: string;
  title?: string;
  year?: string;
  country?: string;
  format?: string[];
  label?: string[];
  catno?: string;
  thumb?: string;
  cover_image?: string;
  uri?: string;
}

interface CandidateMatch {
  id: number;
  title: string;
  year: string | null;
  country: string | null;
  format: string[];
  labels: string[];
  catalogNumber: string | null;
  thumb: string | null;
  discogsUrl: string;
  score: number;
  confidence: 'strong' | 'possible' | 'weak';
  reasons: string[];
  inCollection: boolean;
}

interface DiscogsCollectionFolder {
  id: number;
  name: string;
  count: number;
}

interface DiscogsCollectionInstance {
  instanceId: number;
  folderId: number;
}

interface AddCollectionSelection {
  releaseId: number;
  folderId: number;
  invoiceItemLabel?: string;
}

interface AddCollectionRequest {
  releaseIds?: number[];
  selections?: AddCollectionSelection[];
  importId: string;
}

interface ImportSessionMetadata {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  shippingPrice: number | null;
}

type DiscogsSearchCache = Map<string, DiscogsSearchResult[]>;

interface ImportSession {
  releaseIds: Set<number>;
  expiresAt: number;
  metadata: ImportSessionMetadata;
  searchResults: DiscogsSearchCache;
}

interface InvoiceAddLogContext {
  importId: string;
  releaseId: number;
  folderId: number;
  folderName: string;
  itemNumber: number;
  totalItems: number;
  invoiceItemLabel?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MATCHER_VERSION = 'deejay-progressive-2026-04-27-2';
const EXCELLENT_MATCH_SCORE = 90;
// Discogs allows 60 authenticated requests per minute. 1200ms matches the
// collection sync spacer (about 50/minute). A 429 still backs off separately.
const DISCOGS_REQUEST_DELAY_MS = 1200;
const DISCOGS_429_BACKOFF_MS = 30000;
const DISCOGS_REQUEST_TIMEOUT_MS = 30000;
const DEEJAY_DEFAULT_MEDIA_CONDITION = 'Mint (M)';
const DEEJAY_DEFAULT_SLEEVE_CONDITION = 'Mint (M)';
const MAX_INVOICE_UPLOAD_BYTES = 5 * 1024 * 1024;
const IMPORT_SESSION_TTL_MS = 30 * 60 * 1000;
const COLLECTION_FOLDERS_CACHE_TTL_MS = 5 * 60 * 1000;
let nextDiscogsRequestAt = 0;
const importSessions = new Map<string, ImportSession>();
let cachedCollectionFolders: { folders: DiscogsCollectionFolder[]; expiresAt: number } | null = null;

function logInvoiceAddEvent(
  event: string,
  context: Partial<InvoiceAddLogContext> = {},
  details: Record<string, unknown> = {},
) {
  console.info('[invoice-add]', {
    event,
    at: new Date().toISOString(),
    ...context,
    ...details,
  });
}

function getDiscogsEndpoint(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

function cleanupImportSessions() {
  const now = Date.now();
  for (const [importId, session] of importSessions) {
    if (session.expiresAt <= now) {
      importSessions.delete(importId);
    }
  }
}

function createImportSession(metadata: ImportSessionMetadata): string {
  cleanupImportSessions();
  const importId = crypto.randomUUID();
  importSessions.set(importId, {
    releaseIds: new Set(),
    expiresAt: Date.now() + IMPORT_SESSION_TTL_MS,
    metadata,
    searchResults: new Map(),
  });
  return importId;
}

function addCandidatesToImportSession(importId: string, candidates: CandidateMatch[]) {
  cleanupImportSessions();
  const session = importSessions.get(importId);

  if (!session) {
    return;
  }

  for (const candidate of candidates) {
    session.releaseIds.add(candidate.id);
  }
}

function getImportSession(importId: string | undefined) {
  cleanupImportSessions();

  if (!importId) {
    return null;
  }

  return importSessions.get(importId) || null;
}

async function waitForDiscogsSlot() {
  const waitMs = nextDiscogsRequestAt - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  nextDiscogsRequestAt = Date.now() + DISCOGS_REQUEST_DELAY_MS;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const buildTokens = (value: string): { tokens: Set<string>; compact: string } => {
    const normalizedTokens = normalizeText(value).split(' ').filter(Boolean);
    const compact = normalizedTokens.join('');
    return {
      tokens: new Set([...normalizedTokens, compact].filter(Boolean)),
      compact,
    };
  };
  const leftParts = buildTokens(left);
  const rightParts = buildTokens(right);
  const leftTokens = leftParts.tokens;
  const rightTokens = rightParts.tokens;

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  if (leftParts.compact && rightParts.compact && leftParts.compact === rightParts.compact) {
    return 1;
  }

  const overlap = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function splitDiscogsTitle(value: string): { artist: string; title: string } {
  const [artist, ...titleParts] = value.split(' - ');
  return {
    artist: artist?.trim() || '',
    title: titleParts.join(' - ').trim() || value,
  };
}

function getFormatSignals(formats: string[]): { hasVinyl: boolean; isDigitalOnly: boolean } {
  const hasVinyl = formats.some((format) => /vinyl|lp|12"|7"|10"/i.test(format));
  const hasDigitalFormat = formats.some((format) => /file|mp3|wav|flac|aac|ogg|alac/i.test(format));

  return {
    hasVinyl,
    isDigitalOnly: hasDigitalFormat && !hasVinyl,
  };
}

function scoreCandidate(item: DeejayInvoiceItem, result: DiscogsSearchResult): CandidateMatch {
  const discogsTitle = splitDiscogsTitle(result.title || '');
  const reasons: string[] = [];
  let score = 0;

  const itemCatno = normalizeCatalogNumber(item.catalogNumber);
  const resultCatno = normalizeCatalogNumber(result.catno || '');

  if (itemCatno && resultCatno && itemCatno === resultCatno) {
    score += 55;
    reasons.push(`Catalog number matches ${result.catno}`);
  } else if (itemCatno && resultCatno && (itemCatno.includes(resultCatno) || resultCatno.includes(itemCatno))) {
    score += 35;
    reasons.push(`Catalog number is close to ${result.catno}`);
  }

  const artistSimilarity = tokenSimilarity(item.artist, discogsTitle.artist);
  if (artistSimilarity >= 0.85) {
    score += 20;
    reasons.push('Artist looks like an exact match');
  } else if (artistSimilarity >= 0.45) {
    score += 12;
    reasons.push('Artist is similar');
  }

  const titleSimilarity = tokenSimilarity(item.title, discogsTitle.title);
  if (titleSimilarity >= 0.85) {
    score += 20;
    reasons.push('Title looks like an exact match');
  } else if (titleSimilarity >= 0.45) {
    score += 12;
    reasons.push('Title is similar');
  }

  const formats = result.format || [];
  const formatSignals = getFormatSignals(formats);
  if (formatSignals.hasVinyl) {
    score += 5;
    reasons.push('Format appears to be vinyl');
  }

  if (formatSignals.isDigitalOnly) {
    score -= 45;
    reasons.push('Format appears to be digital only');
  }

  const itemArtistQuery = normalizeText(item.artist);
  const itemTitleQuery = normalizeText(item.title);
  const resultTitleQuery = normalizeText(result.title || '');

  if (itemArtistQuery && itemTitleQuery && resultTitleQuery.includes(`${itemArtistQuery} ${itemTitleQuery}`)) {
    score += 25;
    reasons.push('Discogs title contains invoice artist and title');
  } else if (itemTitleQuery && resultTitleQuery.includes(itemTitleQuery)) {
    score += 18;
    reasons.push('Discogs title contains invoice title');
  }

  if (result.type === 'release') {
    score += 5;
  }

  const cappedScore = Math.max(0, Math.min(score, 100));
  const confidence = cappedScore >= 75 ? 'strong' : cappedScore >= 45 ? 'possible' : 'weak';

  return {
    id: result.id,
    title: result.title || 'Untitled release',
    year: result.year || null,
    country: result.country || null,
    format: formats,
    labels: result.label || [],
    catalogNumber: result.catno || null,
    thumb: result.thumb || result.cover_image || null,
    discogsUrl: result.uri ? `https://www.discogs.com${result.uri}` : `https://www.discogs.com/release/${result.id}`,
    score: cappedScore,
    confidence,
    reasons: reasons.length > 0 ? reasons : ['Fallback Discogs search result'],
    inCollection: false,
  };
}

function markCollectionPresence(candidates: CandidateMatch[]): CandidateMatch[] {
  if (candidates.length === 0) {
    return candidates;
  }

  const db = getDatabase();
  const placeholders = candidates.map(() => '?').join(',');
  const rows = db.getDb().prepare(
    `SELECT discogs_id FROM releases WHERE discogs_id IN (${placeholders})`
  ).all(...candidates.map((candidate) => candidate.id)) as Array<{ discogs_id: number }>;
  const collectionIds = new Set(rows.map((row) => row.discogs_id));

  return candidates.map((candidate) => ({
    ...candidate,
    inCollection: collectionIds.has(candidate.id),
  }));
}

async function searchDiscogs(query: URLSearchParams, queryCache?: DiscogsSearchCache): Promise<DiscogsSearchResult[]> {
  const queryKey = query.toString();
  const cachedResults = queryCache?.get(queryKey);
  if (cachedResults) {
    return cachedResults;
  }

  const url = `https://api.discogs.com/database/search?${queryKey}`;
  const request = () => fetch(url, {
      headers: {
        'Authorization': `Discogs token=${config.discogsToken}`,
        'User-Agent': config.userAgent,
      },
    });

  await waitForDiscogsSlot();
  let response = await request();

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after') || '8');
    const backoffMs = Math.max(DISCOGS_429_BACKOFF_MS, retryAfter * 1000);
    nextDiscogsRequestAt = Date.now() + backoffMs;
    await sleep(backoffMs);
    await waitForDiscogsSlot();
    response = await request();
  }

  if (!response.ok) {
    throw new Error(`Discogs search failed with ${response.status}`);
  }

  const data = await response.json() as { results?: DiscogsSearchResult[] };
  const results = data.results || [];
  queryCache?.set(queryKey, results);
  return results;
}

async function discogsFetch(
  url: string,
  init: RequestInit = {},
  invoiceAddContext?: InvoiceAddLogContext,
  operation = 'Discogs request',
): Promise<Response> {
  const startedAt = Date.now();
  const endpoint = getDiscogsEndpoint(url);
  const method = init.method || 'GET';

  if (invoiceAddContext) {
    logInvoiceAddEvent('discogs_request_started', invoiceAddContext, {
      operation,
      method,
      endpoint,
    });
  }

  await waitForDiscogsSlot();
  const rateLimitWaitMs = Date.now() - startedAt;

  try {
    const response = await secureFetch(url, {
      ...init,
      // A Discogs request must not keep the invoice endpoint open forever. A
      // retry is useful for transient failures, while keeping add operations
      // bounded; duplicate adds are handled by the collection-instance check.
      timeout: DISCOGS_REQUEST_TIMEOUT_MS,
      retries: 1,
      headers: {
        'User-Agent': config.userAgent,
        'Authorization': `Discogs token=${config.discogsToken}`,
        ...(init.headers || {}),
      },
    });

    if (invoiceAddContext) {
      logInvoiceAddEvent('discogs_request_completed', invoiceAddContext, {
        operation,
        method,
        endpoint,
        status: response.status,
        rateLimitWaitMs,
        durationMs: Date.now() - startedAt,
      });
    }

    return response;
  } catch (error) {
    if (invoiceAddContext) {
      logInvoiceAddEvent('discogs_request_failed', invoiceAddContext, {
        operation,
        method,
        endpoint,
        rateLimitWaitMs,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'Unknown Discogs request error',
      });
    }
    throw error;
  }
}

async function fetchDiscogsCollectionFolders(options: { forceRefresh?: boolean } = {}): Promise<DiscogsCollectionFolder[]> {
  if (
    !options.forceRefresh &&
    cachedCollectionFolders &&
    cachedCollectionFolders.expiresAt > Date.now()
  ) {
    return cachedCollectionFolders.folders;
  }

  const response = await discogsFetch(`https://api.discogs.com/users/${config.discogsUsername}/collection/folders`);

  if (!response.ok) {
    throw new Error(`Discogs collection folders fetch failed with ${response.status}`);
  }

  const data = await response.json() as { folders?: DiscogsCollectionFolder[] };
  const folders = (data.folders || [])
    .filter((folder) => (
      Number.isInteger(folder.id) &&
      folder.id > 0 &&
      typeof folder.name === 'string' &&
      folder.name.trim().length > 0
    ))
    .map((folder) => ({
      id: folder.id,
      name: folder.name,
      count: Number.isFinite(folder.count) ? folder.count : 0,
    }));

  cachedCollectionFolders = {
    folders,
    expiresAt: Date.now() + COLLECTION_FOLDERS_CACHE_TTL_MS,
  };

  return folders;
}

async function fetchDiscogsRelease(releaseId: number, invoiceAddContext?: InvoiceAddLogContext): Promise<any> {
  const response = await discogsFetch(
    `https://api.discogs.com/releases/${releaseId}`,
    {},
    invoiceAddContext,
    'fetch release details',
  );

  if (!response.ok) {
    throw new Error(`Discogs release fetch failed with ${response.status}`);
  }

  return response.json();
}

async function fetchDiscogsMarketplaceStats(releaseId: number, invoiceAddContext?: InvoiceAddLogContext): Promise<any | null> {
  const response = await discogsFetch(
    `https://api.discogs.com/marketplace/stats/${releaseId}`,
    {},
    invoiceAddContext,
    'fetch marketplace stats',
  );

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function getDiscogsCollectionInstances(
  releaseId: number,
  invoiceAddContext?: InvoiceAddLogContext,
): Promise<DiscogsCollectionInstance[]> {
  const response = await discogsFetch(
    `https://api.discogs.com/users/${config.discogsUsername}/collection/releases/${releaseId}`,
    {},
    invoiceAddContext,
    'look up collection instances',
  );

  if (!response.ok) {
    return [];
  }

  const data = await response.json();
  const releases = Array.isArray(data?.releases) ? data.releases : [];

  return releases
    .map((release: any): DiscogsCollectionInstance | null => {
      const instanceId = Number(release?.instance_id || release?.id);
      const folderId = Number(release?.folder_id);

      if (!Number.isInteger(instanceId) || !Number.isInteger(folderId)) {
        return null;
      }

      return { instanceId, folderId };
    })
    .filter((instance: DiscogsCollectionInstance | null): instance is DiscogsCollectionInstance => instance !== null);
}

async function setDiscogsCollectionField(
  releaseId: number,
  folderId: number,
  instanceId: number,
  fieldId: number,
  value: string,
  invoiceAddContext?: InvoiceAddLogContext,
): Promise<void> {
  const response = await discogsFetch(
    `https://api.discogs.com/users/${config.discogsUsername}/collection/folders/${folderId}/releases/${releaseId}/instances/${instanceId}/fields/${fieldId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value }),
    },
    invoiceAddContext,
    `set collection field ${fieldId}`,
  );

  if (!response.ok) {
    throw new Error(`Discogs collection field ${fieldId} update failed with ${response.status}`);
  }
}

async function setDiscogsDefaultConditions(
  releaseId: number,
  folderId: number,
  instanceId: number,
  invoiceAddContext?: InvoiceAddLogContext,
): Promise<void> {
  await setDiscogsCollectionField(releaseId, folderId, instanceId, 1, DEEJAY_DEFAULT_MEDIA_CONDITION, invoiceAddContext);
  await setDiscogsCollectionField(releaseId, folderId, instanceId, 2, DEEJAY_DEFAULT_SLEEVE_CONDITION, invoiceAddContext);
}

async function addReleaseToDiscogsCollection(
  releaseId: number,
  folderId: number,
  invoiceAddContext?: InvoiceAddLogContext,
): Promise<{
  instanceId: number | null;
  added: boolean;
  alreadyInDifferentFolder: boolean;
  existingFolderId: number | null;
}> {
  // Prevent duplicate Discogs instances: if already present in another folder, do not POST add again.
  const existingInstances = await getDiscogsCollectionInstances(releaseId, invoiceAddContext);
  const targetInstance = existingInstances.find((instance) => instance.folderId === folderId);

  if (targetInstance) {
    return {
      instanceId: targetInstance.instanceId,
      added: false,
      alreadyInDifferentFolder: false,
      existingFolderId: folderId,
    };
  }

  if (existingInstances.length > 0) {
    return {
      instanceId: existingInstances[0].instanceId,
      added: false,
      alreadyInDifferentFolder: true,
      existingFolderId: existingInstances[0].folderId,
    };
  }

  const response = await discogsFetch(
    `https://api.discogs.com/users/${config.discogsUsername}/collection/folders/${folderId}/releases/${releaseId}`,
    {
      method: 'POST',
    },
    invoiceAddContext,
    'add release to collection folder',
  );

  if (!response.ok) {
    if (response.status === 409 || response.status === 422) {
      const fallbackInstances = await getDiscogsCollectionInstances(releaseId, invoiceAddContext);
      const fallbackTargetInstance = fallbackInstances.find((instance) => instance.folderId === folderId);
      if (fallbackTargetInstance) {
        return {
          instanceId: fallbackTargetInstance.instanceId,
          added: false,
          alreadyInDifferentFolder: false,
          existingFolderId: folderId,
        };
      }
    }
    throw new Error(`Discogs collection add failed with ${response.status}`);
  }

  const data = await response.json().catch(() => null);
  const addedInstanceId = Number(data?.instance_id || data?.id);
  const fallbackInstances = Number.isInteger(addedInstanceId) ? [] : await getDiscogsCollectionInstances(releaseId, invoiceAddContext);
  const fallbackTargetInstance = fallbackInstances.find((instance) => instance.folderId === folderId);
  const instanceId = Number.isInteger(addedInstanceId) ? addedInstanceId : fallbackTargetInstance?.instanceId || null;

  if (typeof instanceId !== 'number') {
    throw new Error('Discogs collection add succeeded, but no instance ID was returned');
  }

  await setDiscogsDefaultConditions(releaseId, folderId, instanceId, invoiceAddContext);

  return {
    instanceId,
    added: true,
    alreadyInDifferentFolder: false,
    existingFolderId: folderId,
  };
}

async function importReleaseToLocalCollection(
  releaseId: number,
  importMetadata: ImportSessionMetadata,
  invoiceAddContext?: InvoiceAddLogContext,
): Promise<'added' | 'updated-local'> {
  const db = getDatabase();
  const startedAt = Date.now();
  logInvoiceAddEvent('local_import_started', invoiceAddContext);
  const releaseData = await fetchDiscogsRelease(releaseId, invoiceAddContext);
  const existingRelease = await db.getReleaseByDiscogsId(releaseId);
  let localReleaseId: number;

  if (existingRelease) {
    localReleaseId = existingRelease.id;
    await db.updateRelease(existingRelease.id, {
      title: releaseData.title || existingRelease.title,
      year: releaseData.year || null,
      cover_image_url: releaseData.images?.[0]?.uri || releaseData.thumb || null,
      media_condition: DEEJAY_DEFAULT_MEDIA_CONDITION,
      sleeve_condition: DEEJAY_DEFAULT_SLEEVE_CONDITION,
      last_sync_at: new Date().toISOString(),
      sync_status: 'synced',
      metadata_version: (existingRelease.metadata_version || 0) + 1,
      import_source: 'deejay.de',
      import_invoice_number: importMetadata.invoiceNumber,
      import_invoice_date: importMetadata.invoiceDate,
      imported_via_invoice_at: new Date().toISOString(),
      import_shipping_price: importMetadata.shippingPrice,
    });
  } else {
    const imageUrl = releaseData.images?.[0]?.uri || releaseData.thumb || null;
    localReleaseId = await db.createRelease({
      discogs_id: releaseId,
      title: releaseData.title || 'Unknown',
      year: releaseData.year || null,
      cover_image_url: imageUrl,
      date_added: new Date().toISOString(),
      media_condition: DEEJAY_DEFAULT_MEDIA_CONDITION,
      sleeve_condition: DEEJAY_DEFAULT_SLEEVE_CONDITION,
      last_sync_at: new Date().toISOString(),
      sync_status: 'synced',
      metadata_version: 1,
      import_source: 'deejay.de',
      import_invoice_number: importMetadata.invoiceNumber,
      import_invoice_date: importMetadata.invoiceDate,
      imported_via_invoice_at: new Date().toISOString(),
      import_shipping_price: importMetadata.shippingPrice,
    });
  }

  logInvoiceAddEvent('local_release_upserted', invoiceAddContext, {
    localReleaseId,
    localStatus: existingRelease ? 'updated-local' : 'added',
    durationMs: Date.now() - startedAt,
  });

  // Always refresh relation tables from Discogs for invoice-driven syncs.
  db.getDb().prepare('DELETE FROM release_artists WHERE release_id = ?').run(localReleaseId);
  db.getDb().prepare('DELETE FROM release_styles WHERE release_id = ?').run(localReleaseId);
  db.getDb().prepare('DELETE FROM release_genres WHERE release_id = ?').run(localReleaseId);
  db.getDb().prepare('DELETE FROM release_labels WHERE release_id = ?').run(localReleaseId);
  db.getDb().prepare('DELETE FROM videos WHERE release_id = ?').run(localReleaseId);
  db.getDb().prepare('DELETE FROM tracks WHERE release_id = ?').run(localReleaseId);

  for (let index = 0; index < (releaseData.artists || []).length; index++) {
    const artist = releaseData.artists[index];
    if (artist?.name) {
      const artistId = await db.createOrGetArtist(artist.name);
      await db.linkReleaseToArtist(localReleaseId, artistId, index);
    }
  }

  for (const styleName of releaseData.styles || []) {
    const styleId = await db.createOrGetStyle(styleName);
    await db.linkReleaseToStyle(localReleaseId, styleId);
  }

  for (const genreName of releaseData.genres || []) {
    const genreId = await db.createOrGetGenre(genreName);
    await db.linkReleaseToGenre(localReleaseId, genreId);
  }

  for (let index = 0; index < (releaseData.labels || []).length; index++) {
    const label = releaseData.labels[index];
    if (label?.name) {
      const labelId = await db.createOrGetLabel(label.name);
      await db.linkReleaseToLabel(localReleaseId, labelId, index);
    }
  }

  // Persist Discogs videos during invoice import add flow.
  const videos = Array.isArray(releaseData.videos) ? releaseData.videos : [];
  if (videos.length > 0) {
    for (const video of videos) {
      let videoType: 'discogs' | 'youtube' | 'other' = 'discogs';
      let youtubeVideoId: string | null = null;

      if (video?.uri && (video.uri.includes('youtube.com') || video.uri.includes('youtu.be'))) {
        videoType = 'youtube';
        youtubeVideoId = extractYouTubeVideoId(video.uri);
      } else if (video?.uri) {
        videoType = 'other';
      }

      await db.createVideo({
        release_id: localReleaseId,
        uri: video?.uri || '',
        title: video?.title || 'Untitled video',
        description: video?.description || null,
        duration: Number.isFinite(video?.duration) ? video.duration : null,
        embed: Boolean(video?.embed),
        video_type: videoType,
        youtube_video_id: youtubeVideoId,
        youtube_playlist_id: null,
      });
    }
  }

  // Fetch and persist current marketplace price for the newly added release.
  const marketplaceStats = await fetchDiscogsMarketplaceStats(releaseId, invoiceAddContext);
  const lowestPrice = marketplaceStats?.lowest_price?.value;
  const lowestPriceCurrency = marketplaceStats?.lowest_price?.currency;
  if (typeof lowestPrice === 'number' && typeof lowestPriceCurrency === 'string' && lowestPriceCurrency.length > 0) {
    await db.createOrUpdatePrice({
      release_id: localReleaseId,
      lowest_price: lowestPrice,
      currency: lowestPriceCurrency,
      price_source: 'discogs',
      last_updated: new Date().toISOString(),
    });
  }

  const localStatus = existingRelease ? 'updated-local' : 'added';
  logInvoiceAddEvent('local_import_completed', invoiceAddContext, {
    localReleaseId,
    localStatus,
    durationMs: Date.now() - startedAt,
  });
  return localStatus;
}

async function addSelectedReleasesToCollection(
  selections: AddCollectionSelection[],
  allowedReleaseIds: Set<number>,
  importMetadata: ImportSessionMetadata,
  folderById: Map<number, DiscogsCollectionFolder>,
  importId: string,
) {
  const batchStartedAt = Date.now();
  const uniqueSelections = Array.from(
    new Map(
      selections
        .filter((selection) => (
          Number.isInteger(selection.releaseId) &&
          selection.releaseId > 0 &&
          Number.isInteger(selection.folderId) &&
          folderById.has(selection.folderId)
        ))
        .map((selection) => [selection.releaseId, selection]),
    ).values(),
  );
  const results = [];
  let syncedFromDiscogsCount = 0;
  let invoiceMetadataUpdatedCount = 0;

  logInvoiceAddEvent('batch_started', { importId }, {
    selectedCount: uniqueSelections.length,
  });

  for (const [index, selection] of uniqueSelections.entries()) {
    const { releaseId, folderId } = selection;
    const folder = folderById.get(folderId);
    const releaseStartedAt = Date.now();

    if (!folder) {
      logInvoiceAddEvent('release_rejected', {
        importId,
        releaseId,
        folderId,
        itemNumber: index + 1,
        totalItems: uniqueSelections.length,
        invoiceItemLabel: selection.invoiceItemLabel,
      }, {
        durationMs: Date.now() - releaseStartedAt,
        error: 'Selected Discogs folder does not exist',
      });
      results.push({
        releaseId,
        folderId,
        status: 'rejected',
        error: 'Selected Discogs folder does not exist',
      });
      continue;
    }

    const invoiceAddContext: InvoiceAddLogContext = {
      importId,
      releaseId,
      folderId,
      folderName: folder.name,
      itemNumber: index + 1,
      totalItems: uniqueSelections.length,
      invoiceItemLabel: selection.invoiceItemLabel,
    };
    logInvoiceAddEvent('release_started', invoiceAddContext);

    try {
      if (!allowedReleaseIds.has(releaseId)) {
        logInvoiceAddEvent('release_rejected', invoiceAddContext, {
          durationMs: Date.now() - releaseStartedAt,
          error: 'Release was not produced by this invoice import session',
        });
        results.push({
          releaseId,
          folderId,
          folderName: folder.name,
          status: 'rejected',
          error: 'Release was not produced by this invoice import session',
        });
        continue;
      }

      let discogsAddResult: Awaited<ReturnType<typeof addReleaseToDiscogsCollection>> | null = null;
      try {
        discogsAddResult = await addReleaseToDiscogsCollection(releaseId, folderId, invoiceAddContext);
        logInvoiceAddEvent('discogs_collection_completed', invoiceAddContext, {
          added: discogsAddResult.added,
          alreadyInDifferentFolder: discogsAddResult.alreadyInDifferentFolder,
          existingFolderId: discogsAddResult.existingFolderId,
          durationMs: Date.now() - releaseStartedAt,
        });
      } catch (discogsError) {
        logInvoiceAddEvent('discogs_collection_failed', invoiceAddContext, {
          durationMs: Date.now() - releaseStartedAt,
          error: discogsError instanceof Error ? discogsError.message : 'Discogs add failed',
        });
        results.push({
          releaseId,
          folderId,
          folderName: folder.name,
          status: 'error',
          discogsStatus: 'failed',
          conditionStatus: 'skipped',
          localStatus: 'skipped',
          error: discogsError instanceof Error ? discogsError.message : 'Discogs add failed',
        });
        continue;
      }

      if (!discogsAddResult) {
        logInvoiceAddEvent('discogs_collection_failed', invoiceAddContext, {
          durationMs: Date.now() - releaseStartedAt,
          error: 'Discogs add did not return a result',
        });
        results.push({
          releaseId,
          folderId,
          folderName: folder.name,
          status: 'error',
          discogsStatus: 'failed',
          conditionStatus: 'skipped',
          localStatus: 'skipped',
          error: 'Discogs add did not return a result',
        });
        continue;
      }

      if (discogsAddResult.alreadyInDifferentFolder) {
        const existingFolder = discogsAddResult.existingFolderId ? folderById.get(discogsAddResult.existingFolderId) : null;
        logInvoiceAddEvent('release_rejected', invoiceAddContext, {
          durationMs: Date.now() - releaseStartedAt,
          error: `Release already exists in Discogs folder "${existingFolder?.name || discogsAddResult.existingFolderId || 'unknown'}"`,
        });
        results.push({
          releaseId,
          folderId,
          folderName: folder.name,
          status: 'rejected',
          discogsStatus: 'already-in-different-folder',
          conditionStatus: 'skipped',
          localStatus: 'skipped',
          error: `Release already exists in Discogs folder "${existingFolder?.name || discogsAddResult.existingFolderId || 'unknown'}"; this flow avoids creating a duplicate copy.`,
        });
        continue;
      }

      let conditionStatus = 'updated';
      if (!discogsAddResult?.instanceId) {
        conditionStatus = 'missing-instance';
      }

      try {
        const localStatus = await importReleaseToLocalCollection(releaseId, importMetadata, invoiceAddContext);
        syncedFromDiscogsCount += 1;
        invoiceMetadataUpdatedCount += 1;
        logInvoiceAddEvent('release_completed', invoiceAddContext, {
          localStatus,
          durationMs: Date.now() - releaseStartedAt,
        });
        results.push({
          releaseId,
          folderId,
          folderName: folder.name,
          status: localStatus === 'updated-local' ? 'already-local' : 'added',
          discogsStatus: discogsAddResult?.added ? 'added' : 'already-in-discogs',
          conditionStatus,
          localStatus,
        });
      } catch (localError) {
        logInvoiceAddEvent('local_import_failed', invoiceAddContext, {
          durationMs: Date.now() - releaseStartedAt,
          error: localError instanceof Error ? localError.message : 'Local import failed',
        });
        results.push({
          releaseId,
          folderId,
          folderName: folder.name,
          status: 'partial',
          discogsStatus: 'added',
          conditionStatus,
          localStatus: 'failed',
          error: localError instanceof Error ? localError.message : 'Local import failed',
        });
        continue;
      }
    } catch (error) {
      logInvoiceAddEvent('release_failed', invoiceAddContext, {
        durationMs: Date.now() - releaseStartedAt,
        error: error instanceof Error ? error.message : 'Failed to add release',
      });
      results.push({
        releaseId,
        folderId,
        folderName: folder.name,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to add release',
      });
    }
  }

  logInvoiceAddEvent('batch_completed', { importId }, {
    selectedCount: uniqueSelections.length,
    succeededCount: results.filter((result) => result.status === 'added' || result.status === 'already-local').length,
    failedCount: results.filter((result) => result.status === 'error' || result.status === 'partial' || result.status === 'rejected').length,
    durationMs: Date.now() - batchStartedAt,
  });

  return {
    results,
    syncedFromDiscogsCount,
    invoiceMetadataUpdatedCount,
  };
}

function parseAddSelections(
  body: AddCollectionRequest,
  folderById: Map<number, DiscogsCollectionFolder>,
  defaultFolderId: number | null,
): { selections: AddCollectionSelection[]; error?: string } {
  const rawSelections = Array.isArray(body.selections)
    ? body.selections
    : Array.isArray(body.releaseIds)
      ? body.releaseIds.map((releaseId) => ({ releaseId, folderId: defaultFolderId, invoiceItemLabel: undefined }))
      : null;

  if (!rawSelections) {
    return { selections: [], error: 'selections must be an array' };
  }

  if (!defaultFolderId && !Array.isArray(body.selections)) {
    return { selections: [], error: 'No default Discogs folder is available' };
  }

  const selections: AddCollectionSelection[] = [];
  const seenReleaseIds = new Set<number>();

  for (const rawSelection of rawSelections) {
    const releaseId = Number(rawSelection?.releaseId);
    const folderId = Number(rawSelection?.folderId);
    const invoiceItemLabel = typeof rawSelection?.invoiceItemLabel === 'string'
      ? rawSelection.invoiceItemLabel.trim().slice(0, 240) || undefined
      : undefined;

    if (!Number.isInteger(releaseId) || releaseId <= 0) {
      continue;
    }

    if (!Number.isInteger(folderId) || !folderById.has(folderId)) {
      return { selections: [], error: `Invalid Discogs folder ID for release ${releaseId}` };
    }

    if (seenReleaseIds.has(releaseId)) {
      continue;
    }

    seenReleaseIds.add(releaseId);
    selections.push({ releaseId, folderId, invoiceItemLabel });
  }

  if (selections.length === 0) {
    return { selections: [], error: 'No valid releases were selected' };
  }

  return { selections };
}

async function findCandidates(
  item: DeejayInvoiceItem,
  debugTrace?: string[],
  queryCache?: DiscogsSearchCache,
): Promise<CandidateMatch[]> {
  const seenQueries = new Set<string>();
  const seenResults = new Map<number, DiscogsSearchResult>();

  const queries: URLSearchParams[] = [];
  const catalogVariants = generateCatalogVariants(item.catalogNumber);

  queries.push(new URLSearchParams({ type: 'release', catno: item.catalogNumber, per_page: '10' }));

  queries.push(new URLSearchParams({
    type: 'release',
    q: `${item.catalogNumber} - ${item.artist}`,
    per_page: '10',
  }));

  queries.push(new URLSearchParams({
    type: 'release',
    artist: item.artist,
    title: item.title,
    per_page: '10',
  }));

  queries.push(new URLSearchParams({
    type: 'release',
    q: `${item.artist} ${item.title}`,
    per_page: '5',
  }));

  queries.push(new URLSearchParams({
    type: 'release',
    q: item.rawDescription,
    per_page: '10',
  }));

  for (const variant of catalogVariants.filter((variant) => variant !== item.catalogNumber)) {
    queries.push(new URLSearchParams({ type: 'release', catno: variant, per_page: '10' }));
  }

  for (const variant of catalogVariants.slice(0, 1)) {
    queries.push(new URLSearchParams({
      type: 'release',
      q: `${variant} ${item.artist} ${item.title}`,
      per_page: '10',
    }));
  }

  for (const query of queries) {
    const queryKey = query.toString();
    if (seenQueries.has(queryKey)) {
      continue;
    }

    seenQueries.add(queryKey);
    debugTrace?.push(`${queryCache?.has(queryKey) ? 'cache-hit' : 'query'}:${queryKey}`);

    try {
      const results = await searchDiscogs(query, queryCache);
      debugTrace?.push(`results:${results.length}`);
      for (const result of results) {
        if (result.type === 'release' && !seenResults.has(result.id)) {
          seenResults.set(result.id, result);
        }
      }

      const bestScore = Array.from(seenResults.values())
        .map((result) => scoreCandidate(item, result).score)
        .reduce((highest, score) => Math.max(highest, score), 0);

      if (bestScore >= EXCELLENT_MATCH_SCORE) {
        break;
      }
    } catch (error) {
      console.error('Invoice Discogs search failed:', error);
    }
  }

  const candidates = Array.from(seenResults.values())
    .map((result) => scoreCandidate(item, result))
    .sort((left, right) => right.score - left.score);
  const bestScore = candidates[0]?.score || 0;
  const relevantCandidates = candidates.filter((candidate) => {
    const hasArtistOrTitleSignal = candidate.reasons.some((reason) => (
      reason.includes('Artist') || reason.includes('Title')
    ));

    if (bestScore >= EXCELLENT_MATCH_SCORE) {
      return candidate.score >= EXCELLENT_MATCH_SCORE;
    }

    if (candidate.score >= 75) {
      return candidate.format.length === 0 || getFormatSignals(candidate.format).hasVinyl;
    }

    return candidate.score >= 45 &&
      hasArtistOrTitleSignal &&
      (candidate.format.length === 0 || getFormatSignals(candidate.format).hasVinyl);
  });

  return markCollectionPresence((relevantCandidates.length > 0 ? relevantCandidates : [])
    .slice(0, 8))
    .sort((left, right) => {
      if (left.inCollection !== right.inCollection) {
        return left.inCollection ? -1 : 1;
      }

      return right.score - left.score;
    });
}

export async function GET(request: NextRequest) {
  const localOnlyResponse = rejectIfNotLocal(request);

  if (localOnlyResponse) {
    return localOnlyResponse;
  }

  const setupResponse = rejectIfNotConfigured();
  if (setupResponse) {
    return setupResponse;
  }

  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    if (action !== 'folders') {
      return NextResponse.json({ error: 'Unsupported invoice import action' }, { status: 400 });
    }

    const folders = await fetchDiscogsCollectionFolders();

    return NextResponse.json({ folders });
  } catch (error) {
    console.error('Failed to fetch Discogs collection folders:', error);
    return NextResponse.json({ error: 'Failed to fetch Discogs collection folders' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const localOnlyResponse = rejectIfNotLocal(request);

  if (localOnlyResponse) {
    return localOnlyResponse;
  }

  const setupResponse = rejectIfNotConfigured();
  if (setupResponse) {
    return setupResponse;
  }

  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'parse';

    if (action === 'match') {
      const item = await request.json() as DeejayInvoiceItem;
      const debug = process.env.NODE_ENV !== 'production' &&
        process.env.ENABLE_INVOICE_DEBUG === '1' &&
        searchParams.get('debug') === '1';
      const debugTrace: string[] = [];
      const importId = searchParams.get('importId') || undefined;
      const session = getImportSession(importId);

      if (!item?.id || !item.catalogNumber || !item.title) {
        return NextResponse.json({ error: 'Invoice item is required' }, { status: 400 });
      }

      const candidates = await findCandidates(item, debug ? debugTrace : undefined, session?.searchResults);
      if (importId) {
        addCandidatesToImportSession(importId, candidates);
      }

      return NextResponse.json({
        ...(debug ? { matcherVersion: MATCHER_VERSION } : {}),
        itemId: item.id,
        candidates,
        ...(debug ? { debugTrace } : {}),
      });
    }

    if (action === 'add') {
      const body = await request.json() as AddCollectionRequest;

      const session = getImportSession(body.importId);
      if (!session) {
        return NextResponse.json({ error: 'Import session expired or invalid' }, { status: 400 });
      }

      const folders = await fetchDiscogsCollectionFolders();
      const folderById = new Map(folders.map((folder) => [folder.id, folder]));
      const defaultFolderId = folderById.has(1) ? 1 : folders[0]?.id ?? null;
      const parsedSelections = parseAddSelections(body, folderById, defaultFolderId);

      if (parsedSelections.error) {
        return NextResponse.json({ error: parsedSelections.error }, { status: 400 });
      }

      const addOutcome = await addSelectedReleasesToCollection(
        parsedSelections.selections,
        session.releaseIds,
        session.metadata,
        folderById,
        body.importId,
      );
      const results = addOutcome.results;

      return NextResponse.json({
        success: results.every((result) => !['error', 'partial', 'rejected'].includes(result.status)),
        results,
        message: `Records synced from Discogs: ${addOutcome.syncedFromDiscogsCount}. Invoice metadata updated: ${addOutcome.invoiceMetadataUpdatedCount}.`,
      });
    }

    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      return NextResponse.json({ error: 'PDF file is required' }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: 'Only PDF invoices are supported in this POC' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_INVOICE_UPLOAD_BYTES) {
      return NextResponse.json({ error: 'Invoice PDF is too large' }, { status: 400 });
    }

    const invoice = parseDeejayInvoicePdf(buffer);
    const { extractedText, ...safeInvoice } = invoice;
    void extractedText;
    const importId = createImportSession({
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      shippingPrice: invoice.shippingPrice,
    });

    return NextResponse.json({
      ...safeInvoice,
      importId,
      items: invoice.items.map((item) => ({
        ...item,
        catalogVariants: generateCatalogVariants(item.catalogNumber),
        candidates: [],
      })),
    });
  } catch (error) {
    console.error('Failed to import deejay invoice:', error);
    return NextResponse.json({ error: 'Failed to import invoice' }, { status: 500 });
  }
}
