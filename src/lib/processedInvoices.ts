import type Database from 'better-sqlite3';
import {
  createUnmatchedInvoiceTables,
  textSimilarity,
  unmatchedInvoiceIdentity,
} from './unmatchedInvoiceItems.ts';

export type ProcessedLineOutcome = 'added' | 'not-found' | 'skipped' | 'dismissed' | 'add-failed' | 'search-failed';
export type ComparedLineOutcome = ProcessedLineOutcome | 'missing';

export interface ProcessedInvoiceLineInput {
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
  outcome: ProcessedLineOutcome;
  discogsId: number | null;
  releaseTitle: string | null;
}

export interface ProcessedInvoiceLine extends ProcessedInvoiceLineInput {}

export interface ProcessedInvoiceSummary {
  invoiceNumber: string;
  invoiceDate: string | null;
  added: ProcessedInvoiceLine[];
  notAdded: ProcessedInvoiceLine[];
}

export interface InvoiceComparisonLine {
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
  outcome: ComparedLineOutcome;
  discogsId: number | null;
  releaseTitle: string | null;
}

export interface InvoiceLineCounts {
  invoiceLineCount: number;
  systemCount: number;
  unaccountedCount: number;
  added: InvoiceComparisonLine[];
  notAdded: InvoiceComparisonLine[];
}

export interface UploadedInvoiceComparison extends InvoiceLineCounts {
  invoiceNumber: string;
  invoiceDate: string | null;
}

interface InvoiceIdentityLine {
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
}

type KnownInvoiceLine = InvoiceIdentityLine & {
  outcome: ProcessedLineOutcome;
  discogsId: number | null;
  releaseTitle: string | null;
};

export interface InvoiceLineForClassification {
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
  matchStatus: 'pending' | 'searching' | 'matched' | 'no-match' | 'error';
  selectedReleaseId: number | null;
}

interface ProcessedLineRow {
  catalog_number: string;
  artist: string;
  title: string;
  raw_description: string;
  outcome: ProcessedLineOutcome;
  discogs_id: number | null;
  release_title: string | null;
  identity_key: string;
}

const ADDED_STATUSES = new Set(['added', 'already-local']);
const RELEASE_PAIR_SCORE_MINIMUM = 0.34;

export function createProcessedInvoiceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_invoices (
      invoice_number TEXT PRIMARY KEY,
      invoice_date TEXT,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS processed_invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      catalog_number TEXT NOT NULL,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      raw_description TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('added', 'not-found', 'skipped', 'dismissed', 'add-failed', 'search-failed')),
      discogs_id INTEGER,
      release_title TEXT,
      FOREIGN KEY (invoice_number) REFERENCES processed_invoices(invoice_number) ON DELETE CASCADE,
      UNIQUE (invoice_number, identity_key)
    )
  `);
}

function hasTable(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function invoiceIsComplete(db: Database.Database, invoiceNumber: string): boolean {
  return Boolean(db.prepare(
    'SELECT 1 FROM processed_invoices WHERE invoice_number = ?',
  ).get(invoiceNumber));
}

export function completeProcessedInvoice(
  db: Database.Database,
  input: { invoiceNumber: string; invoiceDate: string | null; lines: ProcessedInvoiceLineInput[] },
): void {
  const invoiceNumber = input.invoiceNumber.trim();
  if (!invoiceNumber) {
    return;
  }

  createProcessedInvoiceTables(db);
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM processed_invoice_lines WHERE invoice_number = ?').run(invoiceNumber);
    db.prepare('DELETE FROM processed_invoices WHERE invoice_number = ?').run(invoiceNumber);
    db.prepare(
      'INSERT INTO processed_invoices (invoice_number, invoice_date) VALUES (?, ?)',
    ).run(invoiceNumber, input.invoiceDate);
    const insertLine = db.prepare(`
      INSERT INTO processed_invoice_lines (
        invoice_number, identity_key, catalog_number, artist, title, raw_description, outcome, discogs_id, release_title
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const seen = new Set<string>();
    for (const line of input.lines) {
      const identity = unmatchedInvoiceIdentity(line);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      insertLine.run(
        invoiceNumber,
        identity,
        line.catalogNumber,
        line.artist,
        line.title,
        line.rawDescription,
        line.outcome,
        line.discogsId,
        line.releaseTitle,
      );
    }
  });
  replace();
}

export function recordInvoiceWithNoMatches(
  db: Database.Database,
  input: {
    invoiceNumber: string;
    invoiceDate: string | null;
    lines: Array<Pick<ProcessedInvoiceLineInput, 'catalogNumber' | 'artist' | 'title' | 'rawDescription'>>;
  },
): 'recorded' | 'already-processed' | 'ignored' {
  const invoiceNumber = input.invoiceNumber.trim();
  if (!invoiceNumber) {
    return 'ignored';
  }

  createProcessedInvoiceTables(db);
  if (invoiceIsComplete(db, invoiceNumber)) {
    return 'already-processed';
  }

  completeProcessedInvoice(db, {
    invoiceNumber,
    invoiceDate: input.invoiceDate,
    lines: input.lines.map((line) => ({
      ...line,
      outcome: 'not-found' as const,
      discogsId: null,
      releaseTitle: null,
    })),
  });
  return 'recorded';
}

function displayedOutcome(db: Database.Database, row: ProcessedLineRow): ProcessedLineOutcome {
  if (row.outcome !== 'not-found' || !hasTable(db, 'invoice_unmatched_items')) {
    return row.outcome;
  }

  const stored = db.prepare(
    'SELECT status FROM invoice_unmatched_items WHERE identity_key = ?',
  ).get(row.identity_key) as { status: string } | undefined;
  return stored?.status === 'dismissed' ? 'dismissed' : row.outcome;
}

function toLine(db: Database.Database, row: ProcessedLineRow): ProcessedInvoiceLine {
  return {
    catalogNumber: row.catalog_number,
    artist: row.artist,
    title: row.title,
    rawDescription: row.raw_description,
    outcome: displayedOutcome(db, row),
    discogsId: row.discogs_id,
    releaseTitle: row.release_title,
  };
}

export function findProcessedInvoice(db: Database.Database, invoiceNumber: string): ProcessedInvoiceSummary | null {
  const trimmed = invoiceNumber.trim();
  if (!trimmed) {
    return null;
  }

  createProcessedInvoiceTables(db);
  const invoice = db.prepare(
    'SELECT invoice_number, invoice_date FROM processed_invoices WHERE invoice_number = ?',
  ).get(trimmed) as { invoice_number: string; invoice_date: string | null } | undefined;
  if (!invoice) {
    return null;
  }

  const rows = db.prepare(`
    SELECT catalog_number, artist, title, raw_description, outcome, discogs_id, release_title, identity_key
    FROM processed_invoice_lines
    WHERE invoice_number = ?
    ORDER BY id
  `).all(trimmed) as ProcessedLineRow[];
  const lines = rows.map((row) => toLine(db, row));

  return {
    invoiceNumber: invoice.invoice_number,
    invoiceDate: invoice.invoice_date,
    added: lines.filter((line) => line.outcome === 'added'),
    notAdded: lines.filter((line) => line.outcome !== 'added'),
  };
}

export function markProcessedInvoiceLineAdded(
  db: Database.Database,
  input: { invoiceNumber: string; catalogNumber: string; artist: string; title: string; discogsId: number },
): void {
  const invoiceNumber = input.invoiceNumber.trim();
  if (!invoiceNumber) {
    return;
  }

  createProcessedInvoiceTables(db);
  db.prepare(`
    UPDATE processed_invoice_lines
    SET outcome = 'added', discogs_id = ?, release_title = COALESCE(release_title, title)
    WHERE invoice_number = ? AND identity_key = ?
  `).run(input.discogsId, invoiceNumber, unmatchedInvoiceIdentity(input));
}

export function classifyInvoiceLines(input: {
  lines: InvoiceLineForClassification[];
  addResults: Array<{ releaseId: number; status: string }>;
}): ProcessedInvoiceLineInput[] | null {
  if (input.lines.some((line) => line.matchStatus === 'pending' || line.matchStatus === 'searching')) {
    return null;
  }

  const statusByReleaseId = new Map(input.addResults.map((result) => [result.releaseId, result.status]));

  return input.lines.map((line) => {
    const base = {
      catalogNumber: line.catalogNumber,
      artist: line.artist,
      title: line.title,
      rawDescription: line.rawDescription,
      releaseTitle: null,
    };

    if (line.matchStatus === 'no-match') {
      return { ...base, outcome: 'not-found' as const, discogsId: null };
    }

    if (line.matchStatus === 'error') {
      return { ...base, outcome: 'search-failed' as const, discogsId: null };
    }

    if (!line.selectedReleaseId) {
      return { ...base, outcome: 'skipped' as const, discogsId: null };
    }

    const status = statusByReleaseId.get(line.selectedReleaseId);
    if (status && ADDED_STATUSES.has(status)) {
      return { ...base, outcome: 'added' as const, discogsId: line.selectedReleaseId };
    }

    return { ...base, outcome: 'add-failed' as const, discogsId: line.selectedReleaseId };
  });
}

function normalizeInvoiceNumber(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, '');
}

function invoiceNumbersMatch(stored: string, requested: string): boolean {
  const left = stored.trim();
  const right = requested.trim();
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const normalized = normalizeInvoiceNumber(right);
  return normalized.length > 0 && normalizeInvoiceNumber(left) === normalized;
}

function toComparisonLine(
  line: InvoiceIdentityLine & { outcome: ComparedLineOutcome; discogsId: number | null; releaseTitle: string | null },
): InvoiceComparisonLine {
  return {
    catalogNumber: line.catalogNumber,
    artist: line.artist,
    title: line.title,
    rawDescription: line.rawDescription,
    outcome: line.outcome,
    discogsId: line.discogsId,
    releaseTitle: line.releaseTitle,
  };
}

export function reconcileInvoiceLines(input: {
  invoiceLines: InvoiceIdentityLine[];
  addedReleases: Array<{ discogsId: number; artist: string; title: string }>;
  knownLines: KnownInvoiceLine[];
}): InvoiceLineCounts {
  const knownNotAdded = input.knownLines.filter((line) => line.outcome !== 'added');
  const knownByIdentity = new Map(knownNotAdded.map((line) => [unmatchedInvoiceIdentity(line), line]));
  const usedReleaseIndexes = new Set<number>();
  const accountedInvoiceIndexes = new Set<number>();
  const pairedInvoiceByRelease = new Map<number, InvoiceIdentityLine>();

  input.invoiceLines.forEach((line, index) => {
    if (knownByIdentity.has(unmatchedInvoiceIdentity(line))) {
      accountedInvoiceIndexes.add(index);
    }
  });

  const pairCandidates: Array<{ lineIndex: number; releaseIndex: number; score: number }> = [];
  input.invoiceLines.forEach((line, lineIndex) => {
    if (accountedInvoiceIndexes.has(lineIndex)) {
      return;
    }
    input.addedReleases.forEach((release, releaseIndex) => {
      const fieldScore = (
        textSimilarity(line.artist, release.artist) + textSimilarity(line.title, release.title)
      ) / 2;
      const rawScore = textSimilarity(line.rawDescription, `${release.artist} ${release.title}`);
      const score = Math.max(fieldScore, rawScore);
      if (score >= RELEASE_PAIR_SCORE_MINIMUM) {
        pairCandidates.push({ lineIndex, releaseIndex, score });
      }
    });
  });
  pairCandidates.sort((left, right) => right.score - left.score);
  for (const pair of pairCandidates) {
    if (accountedInvoiceIndexes.has(pair.lineIndex) || usedReleaseIndexes.has(pair.releaseIndex)) {
      continue;
    }
    usedReleaseIndexes.add(pair.releaseIndex);
    accountedInvoiceIndexes.add(pair.lineIndex);
    pairedInvoiceByRelease.set(pair.releaseIndex, input.invoiceLines[pair.lineIndex]);
  }

  const added = input.addedReleases.map((release, index) => {
    const paired = pairedInvoiceByRelease.get(index);
    return toComparisonLine({
      catalogNumber: paired?.catalogNumber ?? '',
      artist: paired?.artist || release.artist,
      title: paired?.title || release.title,
      rawDescription: paired?.rawDescription ?? '',
      outcome: 'added',
      discogsId: release.discogsId,
      releaseTitle: release.title,
    });
  });

  const unaccountedInvoice = input.invoiceLines.filter((_, index) => !accountedInvoiceIndexes.has(index));
  const invoiceLineCount = input.invoiceLines.length;
  const systemCount = input.addedReleases.length + knownNotAdded.length;
  const unaccountedCount = Math.max(0, invoiceLineCount - systemCount);
  const missingLines = unaccountedInvoice.length === unaccountedCount && unaccountedCount > 0
    ? unaccountedInvoice.map((line) => toComparisonLine({
      ...line,
      outcome: 'missing',
      discogsId: null,
      releaseTitle: null,
    }))
    : [];

  return {
    invoiceLineCount,
    systemCount,
    unaccountedCount,
    added,
    notAdded: [...knownNotAdded.map(toComparisonLine), ...missingLines],
  };
}

interface AddedReleaseRow {
  discogs_id: number;
  title: string;
  import_invoice_number: string;
  artist_name: string | null;
}

function loadAddedReleases(db: Database.Database, invoiceNumber: string): Array<{ discogsId: number; artist: string; title: string }> {
  if (!hasTable(db, 'releases')) {
    return [];
  }

  const rows = db.prepare(`
    SELECT r.discogs_id, r.title, r.import_invoice_number, a.name AS artist_name
    FROM releases r
    LEFT JOIN release_artists ra ON ra.release_id = r.id
    LEFT JOIN artists a ON a.id = ra.artist_id
    WHERE r.import_invoice_number IS NOT NULL AND trim(r.import_invoice_number) != ''
    ORDER BY r.discogs_id, ra.position
  `).all() as AddedReleaseRow[];

  const grouped = new Map<number, { discogsId: number; title: string; artists: string[] }>();
  for (const row of rows) {
    if (!invoiceNumbersMatch(row.import_invoice_number, invoiceNumber)) {
      continue;
    }
    const current = grouped.get(row.discogs_id) ?? {
      discogsId: row.discogs_id,
      title: row.title,
      artists: [],
    };
    if (row.artist_name) {
      current.artists.push(row.artist_name);
    }
    grouped.set(row.discogs_id, current);
  }

  return Array.from(grouped.values()).map((release) => ({
    discogsId: release.discogsId,
    artist: release.artists.join(' '),
    title: release.title,
  }));
}

function loadKnownLines(db: Database.Database, invoiceNumber: string): KnownInvoiceLine[] {
  const lines: KnownInvoiceLine[] = [];
  const seen = new Set<string>();
  const push = (line: KnownInvoiceLine) => {
    if (line.outcome === 'added') {
      return;
    }
    const identity = unmatchedInvoiceIdentity(line);
    if (seen.has(identity)) {
      return;
    }
    seen.add(identity);
    lines.push(line);
  };

  if (hasTable(db, 'invoice_unmatched_items')) {
    const rows = db.prepare(`
      SELECT catalog_number, artist, title, raw_description, invoice_number, status
      FROM invoice_unmatched_items
      WHERE invoice_number IS NOT NULL AND trim(invoice_number) != ''
    `).all() as Array<{
      catalog_number: string;
      artist: string;
      title: string;
      raw_description: string;
      invoice_number: string;
      status: string;
    }>;
    for (const row of rows) {
      if (!invoiceNumbersMatch(row.invoice_number, invoiceNumber)) {
        continue;
      }
      push({
        catalogNumber: row.catalog_number,
        artist: row.artist,
        title: row.title,
        rawDescription: row.raw_description,
        outcome: row.status === 'dismissed' ? 'dismissed' : 'not-found',
        discogsId: null,
        releaseTitle: null,
      });
    }
  }

  const snapshot = findProcessedInvoiceLoose(db, invoiceNumber);
  for (const line of snapshot?.notAdded ?? []) {
    push(line);
  }

  return lines;
}

function findProcessedInvoiceLoose(db: Database.Database, invoiceNumber: string): ProcessedInvoiceSummary | null {
  const exact = findProcessedInvoice(db, invoiceNumber);
  if (exact) {
    return exact;
  }

  createProcessedInvoiceTables(db);
  const rows = db.prepare('SELECT invoice_number FROM processed_invoices').all() as Array<{ invoice_number: string }>;
  const match = rows.find((row) => invoiceNumbersMatch(row.invoice_number, invoiceNumber));
  return match ? findProcessedInvoice(db, match.invoice_number) : null;
}

export function compareUploadedInvoice(
  db: Database.Database,
  input: { invoiceNumber: string; invoiceDate: string | null; items: InvoiceIdentityLine[] },
): UploadedInvoiceComparison | null {
  const requested = input.invoiceNumber.trim();
  if (!requested) {
    return null;
  }

  createProcessedInvoiceTables(db);
  createUnmatchedInvoiceTables(db);
  const snapshot = findProcessedInvoiceLoose(db, requested);
  const addedReleases = loadAddedReleases(db, snapshot?.invoiceNumber ?? requested);
  const seenReleaseIds = new Set(addedReleases.map((release) => release.discogsId));
  for (const line of snapshot?.added ?? []) {
    if (line.discogsId && !seenReleaseIds.has(line.discogsId)) {
      seenReleaseIds.add(line.discogsId);
      addedReleases.push({
        discogsId: line.discogsId,
        artist: line.artist,
        title: line.releaseTitle || line.title,
      });
    }
  }
  const knownLines = loadKnownLines(db, snapshot?.invoiceNumber ?? requested);
  if (addedReleases.length === 0 && knownLines.length === 0) {
    return null;
  }

  return {
    invoiceNumber: snapshot?.invoiceNumber ?? requested,
    invoiceDate: snapshot?.invoiceDate ?? input.invoiceDate,
    ...reconcileInvoiceLines({
      invoiceLines: input.items,
      addedReleases,
      knownLines,
    }),
  };
}

export function mergeProcessedInvoiceLines(
  existing: ProcessedInvoiceLine[],
  updates: ProcessedInvoiceLineInput[],
): ProcessedInvoiceLineInput[] {
  const updatesByIdentity = new Map(updates.map((line) => [unmatchedInvoiceIdentity(line), line]));
  const merged = existing.map((line) => updatesByIdentity.get(unmatchedInvoiceIdentity(line)) ?? line);
  const seen = new Set(merged.map((line) => unmatchedInvoiceIdentity(line)));
  for (const line of updates) {
    const identity = unmatchedInvoiceIdentity(line);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    merged.push(line);
  }
  return merged;
}

export function backfillProcessedInvoices(db: Database.Database): void {
  createProcessedInvoiceTables(db);
  createUnmatchedInvoiceTables(db);

  const linesByInvoice = new Map<string, { invoiceDate: string | null; lines: ProcessedInvoiceLineInput[] }>();
  const ensureInvoice = (invoiceNumber: string, invoiceDate: string | null) => {
    const current = linesByInvoice.get(invoiceNumber) ?? { invoiceDate, lines: [] };
    if (!current.invoiceDate && invoiceDate) {
      current.invoiceDate = invoiceDate;
    }
    linesByInvoice.set(invoiceNumber, current);
    return current;
  };

  if (hasTable(db, 'releases')) {
    const rows = db.prepare(`
      SELECT r.discogs_id, r.title, r.import_invoice_number, r.import_invoice_date, a.name AS artist_name
      FROM releases r
      LEFT JOIN release_artists ra ON ra.release_id = r.id
      LEFT JOIN artists a ON a.id = ra.artist_id
      WHERE r.import_invoice_number IS NOT NULL AND trim(r.import_invoice_number) != ''
      ORDER BY r.import_invoice_number, r.discogs_id, ra.position
    `).all() as Array<{
      discogs_id: number;
      title: string;
      import_invoice_number: string;
      import_invoice_date: string | null;
      artist_name: string | null;
    }>;
    const grouped = new Map<string, { discogsId: number; title: string; invoiceDate: string | null; artists: string[] }>();
    for (const row of rows) {
      const key = `${row.import_invoice_number}\n${row.discogs_id}`;
      const current = grouped.get(key) ?? {
        discogsId: row.discogs_id,
        title: row.title,
        invoiceDate: row.import_invoice_date,
        artists: [],
      };
      if (row.artist_name) {
        current.artists.push(row.artist_name);
      }
      grouped.set(key, current);
    }

    for (const [key, release] of grouped) {
      const invoiceNumber = key.slice(0, key.lastIndexOf('\n'));
      const bucket = ensureInvoice(invoiceNumber, release.invoiceDate);
      bucket.lines.push({
        catalogNumber: '',
        artist: release.artists.join(' '),
        title: release.title,
        rawDescription: '',
        outcome: 'added',
        discogsId: release.discogsId,
        releaseTitle: release.title,
      });
    }
  }

  const unmatchedRows = db.prepare(`
    SELECT catalog_number, artist, title, raw_description, invoice_number, invoice_date, status
    FROM invoice_unmatched_items
    WHERE invoice_number IS NOT NULL AND trim(invoice_number) != ''
  `).all() as Array<{
    catalog_number: string;
    artist: string;
    title: string;
    raw_description: string;
    invoice_number: string;
    invoice_date: string | null;
    status: string;
  }>;

  for (const row of unmatchedRows) {
    const bucket = ensureInvoice(row.invoice_number, row.invoice_date);
    bucket.lines.push({
      catalogNumber: row.catalog_number,
      artist: row.artist,
      title: row.title,
      rawDescription: row.raw_description,
      outcome: row.status === 'dismissed' ? 'dismissed' : 'not-found',
      discogsId: null,
      releaseTitle: null,
    });
  }

  for (const [invoiceNumber, bucket] of linesByInvoice) {
    if (invoiceIsComplete(db, invoiceNumber)) {
      continue;
    }
    completeProcessedInvoice(db, {
      invoiceNumber,
      invoiceDate: bucket.invoiceDate,
      lines: bucket.lines,
    });
  }
}
