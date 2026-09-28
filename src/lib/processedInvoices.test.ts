import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  dismissUnmatchedInvoiceItem,
  listOpenUnmatchedInvoiceItems,
  saveUnmatchedInvoiceLine,
} from './unmatchedInvoiceItems.ts';
import {
  backfillProcessedInvoices,
  classifyInvoiceLines,
  compareUploadedInvoice,
  completeProcessedInvoice,
  findProcessedInvoice,
  markProcessedInvoiceLineAdded,
  mergeProcessedInvoiceLines,
  recordInvoiceWithNoMatches,
  reconcileInvoiceLines,
} from './processedInvoices.ts';

function openDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const addedLine = {
  catalogNumber: 'ADD1',
  artist: 'Added Artist',
  title: 'Added Title',
  rawDescription: 'ADD1 Added Artist - Added Title',
  outcome: 'added' as const,
  discogsId: 55,
  releaseTitle: 'Added Title',
};

const skippedLine = {
  catalogNumber: 'SKIP1',
  artist: 'Skipped Artist',
  title: 'Skipped Title',
  rawDescription: 'SKIP1 Skipped Artist - Skipped Title',
  outcome: 'skipped' as const,
  discogsId: null,
  releaseTitle: null,
};

test('an invoice is not treated as processed before it is completed', () => {
  const db = openDb();
  assert.equal(findProcessedInvoice(db, 'INV-1'), null);
  assert.equal(findProcessedInvoice(db, '   '), null);
  db.close();
});

test('completing an invoice separates added lines from lines that were not added', () => {
  const db = openDb();

  completeProcessedInvoice(db, {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-04-01',
    lines: [addedLine, skippedLine],
  });
  const summary = findProcessedInvoice(db, 'INV-1');

  assert.equal(summary?.invoiceNumber, 'INV-1');
  assert.equal(summary?.invoiceDate, '2026-04-01');
  assert.deepEqual(summary?.added.map((line) => line.catalogNumber), ['ADD1']);
  assert.equal(summary?.added[0].discogsId, 55);
  assert.deepEqual(summary?.notAdded.map((line) => line.outcome), ['skipped']);
  db.close();
});

test('recording an invoice whose every line was not found makes a later upload skip search', () => {
  const db = openDb();

  const recorded = recordInvoiceWithNoMatches(db, {
    invoiceNumber: 'INV-EMPTY',
    invoiceDate: '2026-04-02',
    lines: [{
      catalogNumber: 'MISS1',
      artist: 'Miss Artist',
      title: 'Miss Title',
      rawDescription: 'MISS1 Miss Artist - Miss Title',
    }],
  });
  const summary = findProcessedInvoice(db, 'INV-EMPTY');

  assert.equal(recorded, 'recorded');
  assert.deepEqual(summary?.added, []);
  assert.equal(summary?.notAdded[0].outcome, 'not-found');
  assert.equal(summary?.notAdded[0].catalogNumber, 'MISS1');
  db.close();
});

test('a second all-not-found record does not replace a finished invoice', () => {
  const db = openDb();
  completeProcessedInvoice(db, {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-04-01',
    lines: [addedLine],
  });

  const recorded = recordInvoiceWithNoMatches(db, {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-04-01',
    lines: [{
      catalogNumber: 'MISS1',
      artist: 'Miss Artist',
      title: 'Miss Title',
      rawDescription: 'miss',
    }],
  });

  assert.equal(recorded, 'already-processed');
  assert.deepEqual(findProcessedInvoice(db, 'INV-1')?.added.map((line) => line.catalogNumber), ['ADD1']);
  db.close();
});

test('a dismissed not-found line is reported as dismissed', () => {
  const db = openDb();
  saveUnmatchedInvoiceLine(db, {
    catalogNumber: 'MISS1',
    artist: 'Miss Artist',
    title: 'Miss Title',
    rawDescription: 'miss',
    unitPrice: 1,
    quantity: 1,
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-04-01',
  });
  const id = listOpenUnmatchedInvoiceItems(db)[0].id;
  dismissUnmatchedInvoiceItem(db, id);
  recordInvoiceWithNoMatches(db, {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-04-01',
    lines: [{
      catalogNumber: 'MISS1',
      artist: 'Miss Artist',
      title: 'Miss Title',
      rawDescription: 'miss',
    }],
  });

  assert.equal(findProcessedInvoice(db, 'INV-1')?.notAdded[0].outcome, 'dismissed');
  db.close();
});

test('adding a previously missed line moves it to the added list', () => {
  const db = openDb();
  recordInvoiceWithNoMatches(db, {
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-04-01',
    lines: [{
      catalogNumber: 'MISS1',
      artist: 'Miss Artist',
      title: 'Miss Title',
      rawDescription: 'miss',
    }],
  });

  markProcessedInvoiceLineAdded(db, {
    invoiceNumber: 'INV-1',
    catalogNumber: 'MISS1',
    artist: 'Miss Artist',
    title: 'Miss Title',
    discogsId: 77,
  });
  const summary = findProcessedInvoice(db, 'INV-1');

  assert.equal(summary?.added[0].discogsId, 77);
  assert.deepEqual(summary?.notAdded, []);
  db.close();
});

test('backfill builds a processed invoice from releases and not-found lines without replacing a finished one', () => {
  const db = openDb();
  db.exec(`
    CREATE TABLE releases (
      id INTEGER PRIMARY KEY,
      discogs_id INTEGER,
      title TEXT,
      import_invoice_number TEXT,
      import_invoice_date TEXT
    );
    CREATE TABLE artists (
      id INTEGER PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE release_artists (
      release_id INTEGER,
      artist_id INTEGER,
      position INTEGER
    );
  `);
  db.prepare(
    'INSERT INTO releases (id, discogs_id, title, import_invoice_number, import_invoice_date) VALUES (1, 88, \'Kept Title\', \'OLD-1\', \'2026-01-01\')',
  ).run();
  db.prepare('INSERT INTO artists (id, name) VALUES (1, \'Kept Artist\')').run();
  db.prepare('INSERT INTO release_artists (release_id, artist_id, position) VALUES (1, 1, 0)').run();
  saveUnmatchedInvoiceLine(db, {
    catalogNumber: 'OLD-MISS',
    artist: 'Old Artist',
    title: 'Old Title',
    rawDescription: 'old miss',
    unitPrice: null,
    quantity: null,
    invoiceNumber: 'OLD-1',
    invoiceDate: '2026-01-01',
  });
  completeProcessedInvoice(db, {
    invoiceNumber: 'KEEP-1',
    invoiceDate: '2026-02-01',
    lines: [skippedLine],
  });

  backfillProcessedInvoices(db);
  const oldInvoice = findProcessedInvoice(db, 'OLD-1');
  const kept = findProcessedInvoice(db, 'KEEP-1');

  assert.equal(oldInvoice?.added[0].discogsId, 88);
  assert.equal(oldInvoice?.added[0].artist, 'Kept Artist');
  assert.equal(oldInvoice?.added[0].title, 'Kept Title');
  assert.equal(oldInvoice?.notAdded[0].catalogNumber, 'OLD-MISS');
  assert.equal(oldInvoice?.notAdded[0].outcome, 'not-found');
  assert.deepEqual(kept?.notAdded.map((line) => line.outcome), ['skipped']);
  db.close();
});

test('classify keeps successful adds, unselected matches, misses, and failed adds apart', () => {
  const classified = classifyInvoiceLines({
    lines: [
      { catalogNumber: 'A', artist: 'A', title: 'Added', rawDescription: 'a', matchStatus: 'matched', selectedReleaseId: 10 },
      { catalogNumber: 'B', artist: 'B', title: 'Skipped', rawDescription: 'b', matchStatus: 'matched', selectedReleaseId: null },
      { catalogNumber: 'C', artist: 'C', title: 'Missing', rawDescription: 'c', matchStatus: 'no-match', selectedReleaseId: null },
      { catalogNumber: 'D', artist: 'D', title: 'Failed', rawDescription: 'd', matchStatus: 'matched', selectedReleaseId: 11 },
    ],
    addResults: [
      { releaseId: 10, status: 'already-local' },
      { releaseId: 11, status: 'error' },
    ],
  });

  assert.deepEqual(classified?.map((line) => [line.catalogNumber, line.outcome, line.discogsId]), [
    ['A', 'added', 10],
    ['B', 'skipped', null],
    ['C', 'not-found', null],
    ['D', 'add-failed', 11],
  ]);
});

test('reconciling an upload counts invoice lines against added releases and saved misses', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'ADD1', artist: 'Added Artist', title: 'Added Title', rawDescription: 'added' },
      { catalogNumber: 'ADD2', artist: 'Second Artist', title: 'Second Title', rawDescription: 'added 2' },
      { catalogNumber: 'MISS1', artist: 'Miss Artist', title: 'Miss Title', rawDescription: 'miss' },
    ],
    addedReleases: [
      { discogsId: 11, artist: 'Added Artist', title: 'Added Title' },
      { discogsId: 12, artist: 'Second Artist', title: 'Second Title' },
    ],
    knownLines: [{
      catalogNumber: 'MISS1',
      artist: 'Miss Artist',
      title: 'Miss Title',
      rawDescription: 'miss',
      outcome: 'not-found',
      discogsId: null,
      releaseTitle: null,
    }],
  });

  assert.equal(compared.invoiceLineCount, 3);
  assert.equal(compared.systemCount, 3);
  assert.equal(compared.unaccountedCount, 0);
  assert.deepEqual(compared.added.map((line) => [line.catalogNumber, line.discogsId]), [
    ['ADD1', 11],
    ['ADD2', 12],
  ]);
  assert.deepEqual(compared.notAdded.map((line) => [line.catalogNumber, line.outcome]), [
    ['MISS1', 'not-found'],
  ]);
});

test('an invoice line with no system record is reported when the invoice is longer than the system', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'ADD1', artist: 'Added Artist', title: 'Added Title', rawDescription: 'added' },
      { catalogNumber: 'ADD2', artist: 'Second Artist', title: 'Second Title', rawDescription: 'added 2' },
      { catalogNumber: 'GONE1', artist: 'Gone Artist', title: 'Gone Title', rawDescription: 'gone' },
    ],
    addedReleases: [
      { discogsId: 11, artist: 'Added Artist', title: 'Added Title' },
      { discogsId: 12, artist: 'Second Artist', title: 'Second Title' },
    ],
    knownLines: [],
  });

  assert.equal(compared.invoiceLineCount, 3);
  assert.equal(compared.systemCount, 2);
  assert.equal(compared.unaccountedCount, 1);
  assert.deepEqual(compared.notAdded.map((line) => [line.catalogNumber, line.outcome]), [
    ['GONE1', 'missing'],
  ]);
});

test('a saved miss stays visible when added releases use different titles and the counts still match', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'A', artist: 'Invoice Artist', title: 'Invoice Title', rawDescription: 'a' },
      { catalogNumber: 'B', artist: 'Other Artist', title: 'Other Title', rawDescription: 'b' },
      { catalogNumber: 'MISS1', artist: 'Miss Artist', title: 'Miss Title', rawDescription: 'miss' },
    ],
    addedReleases: [
      { discogsId: 11, artist: 'Discogs Artist', title: 'Discogs Title' },
      { discogsId: 12, artist: 'Another Discogs Artist', title: 'Another Discogs Title' },
    ],
    knownLines: [{
      catalogNumber: 'MISS1',
      artist: 'Miss Artist',
      title: 'Miss Title',
      rawDescription: 'miss',
      outcome: 'not-found',
      discogsId: null,
      releaseTitle: null,
    }],
  });

  assert.equal(compared.unaccountedCount, 0);
  assert.equal(compared.added.length, 2);
  assert.deepEqual(compared.notAdded.map((line) => line.outcome), ['not-found']);
});

test('a saved miss that the new invoice text does not match is not paired with extra invoice lines', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'ADD1', artist: 'Added Artist', title: 'Added Title', rawDescription: 'added' },
      { catalogNumber: 'ADD2', artist: 'Second Artist', title: 'Second Title', rawDescription: 'added 2' },
      { catalogNumber: 'NEW1', artist: 'New Artist', title: 'New Title', rawDescription: 'new 1' },
      { catalogNumber: 'NEW2', artist: 'Newer Artist', title: 'Newer Title', rawDescription: 'new 2' },
    ],
    addedReleases: [
      { discogsId: 11, artist: 'Added Artist', title: 'Added Title' },
      { discogsId: 12, artist: 'Second Artist', title: 'Second Title' },
    ],
    knownLines: [{
      catalogNumber: 'OLD-MISS',
      artist: 'Old Miss Artist',
      title: 'Old Miss Title',
      rawDescription: 'old',
      outcome: 'not-found',
      discogsId: null,
      releaseTitle: null,
    }],
  });

  assert.equal(compared.unaccountedCount, 1);
  assert.deepEqual(compared.notAdded.map((line) => [line.catalogNumber, line.outcome]), [
    ['OLD-MISS', 'not-found'],
  ]);
});

test('invoice lines that only loosely match saved releases leave the unmatched lines named', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'CAT1', artist: 'The Sentinel', title: 'EP1', rawDescription: 'CAT1 The Sentinel - EP1' },
      { catalogNumber: 'CAT2', artist: 'Galaxians', title: 'Remix In Motion', rawDescription: 'CAT2 Galaxians - Remix In Motion' },
      { catalogNumber: 'MISS', artist: 'Nobody', title: 'Missing Title', rawDescription: 'MISS Nobody - Missing Title' },
    ],
    addedReleases: [
      { discogsId: 1, artist: 'The Sentinel (5)', title: 'EP1' },
      { discogsId: 2, artist: 'Galaxians (2)', title: 'Remix In Motion' },
    ],
    knownLines: [],
  });

  assert.equal(compared.unaccountedCount, 1);
  assert.deepEqual(compared.notAdded.map((line) => [line.catalogNumber, line.outcome]), [
    ['MISS', 'missing'],
  ]);
  assert.deepEqual(compared.added.map((line) => line.catalogNumber), ['CAT1', 'CAT2']);
});

test('a badly split invoice line still pairs when its raw description names the saved release', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'CAT1', artist: 'Wrong Split', title: 'Also Wrong', rawDescription: 'CAT1 Trancefeld - Pure Fiction EP' },
      { catalogNumber: 'MISS', artist: 'Nobody', title: 'Missing Title', rawDescription: 'MISS Nobody - Missing Title' },
    ],
    addedReleases: [
      { discogsId: 1, artist: 'Trancefeld', title: 'Pure Fiction EP' },
    ],
    knownLines: [],
  });

  assert.deepEqual(compared.notAdded.map((line) => [line.catalogNumber, line.outcome]), [
    ['MISS', 'missing'],
  ]);
  assert.equal(compared.added[0].catalogNumber, 'CAT1');
});

test('a later search result is merged onto the invoice without dropping releases already stored', () => {
  const merged = mergeProcessedInvoiceLines(
    [addedLine],
    [skippedLine],
  );
  const replaced = mergeProcessedInvoiceLines(
    [skippedLine],
    [{ ...skippedLine, outcome: 'added', discogsId: 9, releaseTitle: 'Skipped Title' }],
  );

  assert.deepEqual(merged.map((line) => line.catalogNumber), ['ADD1', 'SKIP1']);
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].outcome, 'added');
  assert.equal(replaced[0].discogsId, 9);
});

test('extra invoice lines are counted but not guessed when added releases cannot be paired', () => {
  const compared = reconcileInvoiceLines({
    invoiceLines: [
      { catalogNumber: 'A', artist: 'Invoice Artist', title: 'Invoice Title', rawDescription: 'a' },
      { catalogNumber: 'B', artist: 'Other Artist', title: 'Other Title', rawDescription: 'b' },
      { catalogNumber: 'C', artist: 'Third Artist', title: 'Third Title', rawDescription: 'c' },
    ],
    addedReleases: [
      { discogsId: 11, artist: 'Discogs Artist', title: 'Discogs Title' },
      { discogsId: 12, artist: 'Another Discogs Artist', title: 'Another Discogs Title' },
    ],
    knownLines: [],
  });

  assert.equal(compared.invoiceLineCount, 3);
  assert.equal(compared.systemCount, 2);
  assert.equal(compared.unaccountedCount, 1);
  assert.deepEqual(compared.notAdded, []);
});

test('comparing an upload includes a miss saved after the invoice snapshot was finished', () => {
  const db = openDb();
  db.exec(`
    CREATE TABLE releases (
      id INTEGER PRIMARY KEY,
      discogs_id INTEGER,
      title TEXT,
      import_invoice_number TEXT,
      import_invoice_date TEXT
    );
    CREATE TABLE artists (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE release_artists (release_id INTEGER, artist_id INTEGER, position INTEGER);
  `);
  db.prepare(
    'INSERT INTO releases (id, discogs_id, title, import_invoice_number, import_invoice_date) VALUES (1, 88, \'Added Title\', \'0077-210924\', \'2024-09-21\')',
  ).run();
  db.prepare('INSERT INTO artists (id, name) VALUES (1, \'Added Artist\')').run();
  db.prepare('INSERT INTO release_artists (release_id, artist_id, position) VALUES (1, 1, 0)').run();
  completeProcessedInvoice(db, {
    invoiceNumber: '0077-210924',
    invoiceDate: '2024-09-21',
    lines: [{
      catalogNumber: '',
      artist: 'Added Artist',
      title: 'Added Title',
      rawDescription: '',
      outcome: 'added',
      discogsId: 88,
      releaseTitle: 'Added Title',
    }],
  });
  saveUnmatchedInvoiceLine(db, {
    catalogNumber: 'TEMPA132V',
    artist: 'Tempa',
    title: 'Archive',
    rawDescription: 'TEMPA132V Tempa - Archive',
    unitPrice: null,
    quantity: null,
    invoiceNumber: '0077-210924',
    invoiceDate: '2024-09-21',
  });

  const compared = compareUploadedInvoice(db, {
    invoiceNumber: '0077 - 210924',
    invoiceDate: '2024-09-21',
    items: [
      { catalogNumber: 'ADD1', artist: 'Added Artist', title: 'Added Title', rawDescription: 'added' },
      { catalogNumber: 'TEMPA132V', artist: 'Tempa', title: 'Archive', rawDescription: 'TEMPA132V Tempa - Archive' },
    ],
  });

  assert.equal(compared?.invoiceNumber, '0077-210924');
  assert.equal(compared?.invoiceLineCount, 2);
  assert.equal(compared?.systemCount, 2);
  assert.equal(compared?.unaccountedCount, 0);
  assert.equal(compared?.added[0].discogsId, 88);
  assert.deepEqual(compared?.notAdded.map((line) => [line.catalogNumber, line.outcome]), [
    ['TEMPA132V', 'not-found'],
  ]);
  db.close();
});

test('an invoice with no system records is left for a new search', () => {
  const db = openDb();
  assert.equal(compareUploadedInvoice(db, {
    invoiceNumber: 'NEW-1',
    invoiceDate: null,
    items: [{ catalogNumber: 'A', artist: 'Artist', title: 'Title', rawDescription: 'a' }],
  }), null);
  db.close();
});

test('classify refuses to finish an invoice while a line is still searching', () => {
  const classified = classifyInvoiceLines({
    lines: [
      { catalogNumber: 'A', artist: 'A', title: 'Wait', rawDescription: 'a', matchStatus: 'searching', selectedReleaseId: null },
    ],
    addResults: [],
  });

  assert.equal(classified, null);
});
