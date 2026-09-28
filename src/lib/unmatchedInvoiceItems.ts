import type Database from 'better-sqlite3';

export interface UnmatchedInvoiceLineInput {
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
  unitPrice: number | null;
  quantity: number | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
}

export interface UnmatchedInvoiceItem {
  id: number;
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
  unitPrice: number | null;
  quantity: number | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  searchQuery: string;
  lastDiscogsMissAt: string | null;
}

interface UnmatchedInvoiceRow {
  id: number;
  catalog_number: string;
  artist: string;
  title: string;
  raw_description: string;
  unit_price: number | null;
  quantity: number | null;
  invoice_number: string | null;
  invoice_date: string | null;
  search_query: string;
  last_discogs_miss_at: string | null;
}

export function createUnmatchedInvoiceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS invoice_unmatched_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_key TEXT NOT NULL UNIQUE,
      catalog_number TEXT NOT NULL,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      raw_description TEXT NOT NULL,
      unit_price REAL,
      quantity INTEGER,
      invoice_number TEXT,
      invoice_date TEXT,
      search_query TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed')),
      last_discogs_miss_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function defaultUnmatchedSearchQuery(line: Pick<UnmatchedInvoiceLineInput, 'catalogNumber' | 'artist' | 'title'>): string {
  return [line.catalogNumber, line.artist, line.title].filter((part) => part.trim().length > 0).join(' ');
}

export function shouldRecordUnmatchedMiss(input: { candidateCount: number; allSearchesFailed: boolean }): boolean {
  return input.candidateCount === 0 && !input.allSearchesFailed;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function identityKey(line: Pick<UnmatchedInvoiceLineInput, 'catalogNumber' | 'artist' | 'title'>): string {
  return [line.catalogNumber, line.artist, line.title].map(normalizeText).join('|');
}

export function unmatchedInvoiceIdentity(line: Pick<UnmatchedInvoiceLineInput, 'catalogNumber' | 'artist' | 'title'>): string {
  return identityKey(line);
}

function toItem(row: UnmatchedInvoiceRow): UnmatchedInvoiceItem {
  return {
    id: row.id,
    catalogNumber: row.catalog_number,
    artist: row.artist,
    title: row.title,
    rawDescription: row.raw_description,
    unitPrice: row.unit_price,
    quantity: row.quantity,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    searchQuery: row.search_query,
    lastDiscogsMissAt: row.last_discogs_miss_at,
  };
}

export function saveUnmatchedInvoiceLine(
  db: Database.Database,
  line: UnmatchedInvoiceLineInput,
): { status: 'saved' | 'updated' | 'dismissed' } {
  createUnmatchedInvoiceTables(db);
  const key = identityKey(line);
  const existing = db.prepare(
    'SELECT id, status FROM invoice_unmatched_items WHERE identity_key = ?',
  ).get(key) as { id: number; status: string } | undefined;

  if (existing?.status === 'dismissed') {
    return { status: 'dismissed' };
  }

  if (existing) {
    db.prepare(`
      UPDATE invoice_unmatched_items
      SET
        raw_description = ?,
        unit_price = ?,
        quantity = ?,
        invoice_number = ?,
        invoice_date = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      line.rawDescription,
      line.unitPrice,
      line.quantity,
      line.invoiceNumber,
      line.invoiceDate,
      existing.id,
    );
    return { status: 'updated' };
  }

  db.prepare(`
    INSERT INTO invoice_unmatched_items (
      identity_key,
      catalog_number,
      artist,
      title,
      raw_description,
      unit_price,
      quantity,
      invoice_number,
      invoice_date,
      search_query
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    key,
    line.catalogNumber,
    line.artist,
    line.title,
    line.rawDescription,
    line.unitPrice,
    line.quantity,
    line.invoiceNumber,
    line.invoiceDate,
    defaultUnmatchedSearchQuery(line),
  );

  return { status: 'saved' };
}

export function listOpenUnmatchedInvoiceItems(db: Database.Database): UnmatchedInvoiceItem[] {
  createUnmatchedInvoiceTables(db);
  const rows = db.prepare(`
    SELECT
      id,
      catalog_number,
      artist,
      title,
      raw_description,
      unit_price,
      quantity,
      invoice_number,
      invoice_date,
      search_query,
      last_discogs_miss_at
    FROM invoice_unmatched_items
    WHERE status = 'open'
    ORDER BY id
  `).all() as UnmatchedInvoiceRow[];

  return rows.map(toItem);
}

export function dismissUnmatchedInvoiceItem(db: Database.Database, id: number): void {
  createUnmatchedInvoiceTables(db);
  db.prepare(`
    UPDATE invoice_unmatched_items
    SET status = 'dismissed', updated_at = datetime('now')
    WHERE id = ? AND status = 'open'
  `).run(id);
}

export function updateUnmatchedSearchQuery(db: Database.Database, id: number, query: string): boolean {
  createUnmatchedInvoiceTables(db);
  const trimmed = query.trim();
  if (!trimmed) {
    return false;
  }

  const result = db.prepare(`
    UPDATE invoice_unmatched_items
    SET search_query = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'open'
  `).run(trimmed, id);

  return result.changes > 0;
}

export function getOpenUnmatchedInvoiceItem(db: Database.Database, id: number): UnmatchedInvoiceItem | null {
  createUnmatchedInvoiceTables(db);
  const row = db.prepare(`
    SELECT
      id,
      catalog_number,
      artist,
      title,
      raw_description,
      unit_price,
      quantity,
      invoice_number,
      invoice_date,
      search_query,
      last_discogs_miss_at
    FROM invoice_unmatched_items
    WHERE id = ? AND status = 'open'
  `).get(id) as UnmatchedInvoiceRow | undefined;

  return row ? toItem(row) : null;
}

export function recordUnmatchedDiscogsMiss(db: Database.Database, id: number, checkedAt: string): void {
  createUnmatchedInvoiceTables(db);
  db.prepare(`
    UPDATE invoice_unmatched_items
    SET last_discogs_miss_at = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'open'
  `).run(checkedAt, id);
}

export function removeOpenUnmatchedInvoiceItem(db: Database.Database, id: number): void {
  createUnmatchedInvoiceTables(db);
  db.prepare(`
    DELETE FROM invoice_unmatched_items
    WHERE id = ? AND status = 'open'
  `).run(id);
}

const EXACT_TEXT_SIMILARITY = 0.85;

export function textSimilarity(left: string, right: string): number {
  return tokenSimilarity(left, right);
}

export function textsLookExact(left: string, right: string): boolean {
  return textSimilarity(left, right) >= EXACT_TEXT_SIMILARITY;
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

export interface CollectionReleaseMatch {
  discogsId: number;
  title: string;
  artist: string;
  year: number | null;
  addedManually: boolean;
}

interface CollectionReleaseRow {
  discogs_id: number;
  title: string;
  year: number | null;
  import_source: string | null;
  artist_name: string;
}

export function findCollectionRelease(
  db: Database.Database,
  artist: string,
  title: string,
): CollectionReleaseMatch | null {
  const rows = db.prepare(`
    SELECT r.discogs_id, r.title, r.year, r.import_source, a.name AS artist_name
    FROM releases r
    JOIN release_artists ra ON ra.release_id = r.id
    JOIN artists a ON a.id = ra.artist_id
    ORDER BY r.discogs_id, ra.position
  `).all() as CollectionReleaseRow[];

  const grouped = new Map<number, CollectionReleaseMatch & { artistNames: string[] }>();
  for (const row of rows) {
    const current = grouped.get(row.discogs_id) ?? {
      discogsId: row.discogs_id,
      title: row.title,
      artist: '',
      year: row.year,
      addedManually: row.import_source !== 'deejay.de',
      artistNames: [],
    };
    current.artistNames.push(row.artist_name);
    current.artist = current.artistNames.join(' ');
    grouped.set(row.discogs_id, current);
  }

  let best: { match: CollectionReleaseMatch; score: number } | null = null;
  for (const release of grouped.values()) {
    const artistScore = tokenSimilarity(artist, release.artist);
    const titleScore = tokenSimilarity(title, release.title);
    if (artistScore < EXACT_TEXT_SIMILARITY || titleScore < EXACT_TEXT_SIMILARITY) {
      continue;
    }

    const score = artistScore + titleScore;
    if (!best || score > best.score) {
      best = {
        score,
        match: {
          discogsId: release.discogsId,
          title: release.title,
          artist: release.artist,
          year: release.year,
          addedManually: release.addedManually,
        },
      };
    }
  }

  return best?.match ?? null;
}

export async function retryMissedReleaseSearch<T>(input: {
  findInCollection: () => CollectionReleaseMatch | null;
  searchDiscogs: (query: string) => Promise<T[]>;
  query?: string;
  now?: string;
}): Promise<
  | { outcome: 'in-collection'; match: CollectionReleaseMatch }
  | { outcome: 'candidates'; candidates: T[] }
  | { outcome: 'not-found'; checkedAt: string }
> {
  const match = input.findInCollection();
  if (match) {
    return { outcome: 'in-collection', match };
  }

  const candidates = await input.searchDiscogs(input.query ?? '');
  if (candidates.length === 0) {
    return {
      outcome: 'not-found',
      checkedAt: input.now ?? new Date().toISOString(),
    };
  }

  return { outcome: 'candidates', candidates };
}
