import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  dismissUnmatchedInvoiceItem,
  findCollectionRelease,
  listOpenUnmatchedInvoiceItems,
  recordUnmatchedDiscogsMiss,
  removeOpenUnmatchedInvoiceItem,
  retryMissedReleaseSearch,
  saveUnmatchedInvoiceLine,
  shouldRecordUnmatchedMiss,
  updateUnmatchedSearchQuery,
  type CollectionReleaseMatch,
} from './unmatchedInvoiceItems.ts';

function openDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const missedLine = {
  catalogNumber: 'ABC001',
  artist: 'Artist Name',
  title: 'Track Title',
  rawDescription: 'ABC001 Artist Name - Track Title',
  unitPrice: 12.5,
  quantity: 1,
  invoiceNumber: 'INV-1',
  invoiceDate: '2026-04-01',
};

test('saving a missed invoice line lists it with a default search query', () => {
  const db = openDb();

  const result = saveUnmatchedInvoiceLine(db, missedLine);
  const items = listOpenUnmatchedInvoiceItems(db);

  assert.equal(result.status, 'saved');
  assert.equal(items.length, 1);
  assert.equal(items[0].catalogNumber, 'ABC001');
  assert.equal(items[0].artist, 'Artist Name');
  assert.equal(items[0].title, 'Track Title');
  assert.equal(items[0].invoiceNumber, 'INV-1');
  assert.equal(items[0].searchQuery, 'ABC001 Artist Name Track Title');
  assert.equal(items[0].lastDiscogsMissAt, null);
  db.close();
});

test('saving the same catalog, artist, and title updates the open row', () => {
  const db = openDb();
  saveUnmatchedInvoiceLine(db, missedLine);
  db.prepare(`UPDATE invoice_unmatched_items SET search_query = ?`).run('edited query');

  const result = saveUnmatchedInvoiceLine(db, {
    ...missedLine,
    rawDescription: 'ABC001 Artist Name - Track Title (reissue)',
    unitPrice: 14,
    invoiceNumber: 'INV-2',
    invoiceDate: '2026-05-01',
  });
  const items = listOpenUnmatchedInvoiceItems(db);

  assert.equal(result.status, 'updated');
  assert.equal(items.length, 1);
  assert.equal(items[0].invoiceNumber, 'INV-2');
  assert.equal(items[0].invoiceDate, '2026-05-01');
  assert.equal(items[0].unitPrice, 14);
  assert.equal(items[0].searchQuery, 'edited query');
  db.close();
});

test('a dismissed line stays hidden when the same invoice line is saved again', () => {
  const db = openDb();
  const saved = saveUnmatchedInvoiceLine(db, missedLine);
  const id = listOpenUnmatchedInvoiceItems(db)[0].id;
  dismissUnmatchedInvoiceItem(db, id);

  const again = saveUnmatchedInvoiceLine(db, {
    ...missedLine,
    invoiceNumber: 'INV-9',
  });

  assert.equal(saved.status, 'saved');
  assert.equal(again.status, 'dismissed');
  assert.deepEqual(listOpenUnmatchedInvoiceItems(db), []);
  db.close();
});

test('a Discogs miss keeps the row and records when it was checked', () => {
  const db = openDb();
  saveUnmatchedInvoiceLine(db, missedLine);
  const id = listOpenUnmatchedInvoiceItems(db)[0].id;

  recordUnmatchedDiscogsMiss(db, id, '2026-09-28T16:00:00.000Z');
  const items = listOpenUnmatchedInvoiceItems(db);

  assert.equal(items.length, 1);
  assert.equal(items[0].lastDiscogsMissAt, '2026-09-28T16:00:00.000Z');
  db.close();
});

test('removing an open row lets the same line be saved again', () => {
  const db = openDb();
  saveUnmatchedInvoiceLine(db, missedLine);
  const id = listOpenUnmatchedInvoiceItems(db)[0].id;
  removeOpenUnmatchedInvoiceItem(db, id);

  const again = saveUnmatchedInvoiceLine(db, missedLine);

  assert.equal(again.status, 'saved');
  assert.equal(listOpenUnmatchedInvoiceItems(db).length, 1);
  db.close();
});

function openCollectionDb() {
  const db = openDb();
  db.exec(`
    CREATE TABLE releases (
      id INTEGER PRIMARY KEY,
      discogs_id INTEGER UNIQUE NOT NULL,
      title TEXT NOT NULL,
      year INTEGER,
      import_source TEXT
    );
    CREATE TABLE artists (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE release_artists (
      release_id INTEGER NOT NULL,
      artist_id INTEGER NOT NULL,
      position INTEGER NOT NULL
    );
  `);
  return db;
}

function insertRelease(
  db: Database.Database,
  release: { id: number; discogsId: number; title: string; year: number | null; importSource: string | null; artists: string[] },
) {
  db.prepare(
    'INSERT INTO releases (id, discogs_id, title, year, import_source) VALUES (?, ?, ?, ?, ?)',
  ).run(release.id, release.discogsId, release.title, release.year, release.importSource);
  release.artists.forEach((name, position) => {
    const artistId = release.id * 10 + position;
    db.prepare('INSERT INTO artists (id, name) VALUES (?, ?)').run(artistId, name);
    db.prepare(
      'INSERT INTO release_artists (release_id, artist_id, position) VALUES (?, ?, ?)',
    ).run(release.id, artistId, position);
  });
}

test('a manually added release matches a missed line when artist and title both look exact', () => {
  const db = openCollectionDb();
  insertRelease(db, {
    id: 1,
    discogsId: 999,
    title: 'Track Title',
    year: 2024,
    importSource: null,
    artists: ['Artist Name'],
  });

  const match = findCollectionRelease(db, 'Artist Name', 'Track Title');

  assert.equal(match?.discogsId, 999);
  assert.equal(match?.title, 'Track Title');
  assert.equal(match?.artist, 'Artist Name');
  assert.equal(match?.year, 2024);
  assert.equal(match?.addedManually, true);
  db.close();
});

test('a different title does not count as already in the collection', () => {
  const db = openCollectionDb();
  insertRelease(db, {
    id: 1,
    discogsId: 999,
    title: 'Some Other Record',
    year: 2024,
    importSource: null,
    artists: ['Artist Name'],
  });

  assert.equal(findCollectionRelease(db, 'Artist Name', 'Track Title'), null);
  db.close();
});

const collectionHit: CollectionReleaseMatch = {
  discogsId: 999,
  title: 'Track Title',
  artist: 'Artist Name',
  year: 2024,
  addedManually: true,
};

test('retry reports a collection hit without searching Discogs', async () => {
  const result = await retryMissedReleaseSearch({
    findInCollection: () => collectionHit,
    searchDiscogs: () => {
      throw new Error('Discogs should not be searched when the release is already in the collection');
    },
    now: '2026-09-28T16:00:00.000Z',
  });

  assert.deepEqual(result, { outcome: 'in-collection', match: collectionHit });
});

test('retry returns Discogs hits when the release is not in the collection', async () => {
  const candidates = [{ id: 42, title: 'Artist Name - Track Title' }];

  const result = await retryMissedReleaseSearch({
    findInCollection: () => null,
    searchDiscogs: async (query) => {
      assert.equal(query, 'ABC001 Artist Name Track Title');
      return candidates;
    },
    query: 'ABC001 Artist Name Track Title',
    now: '2026-09-28T16:00:00.000Z',
  });

  assert.deepEqual(result, { outcome: 'candidates', candidates });
});

test('retry tells the user to try later when Discogs still has no hits', async () => {
  const result = await retryMissedReleaseSearch({
    findInCollection: () => null,
    searchDiscogs: async () => [],
    query: 'ABC001 Artist Name Track Title',
    now: '2026-09-28T16:00:00.000Z',
  });

  assert.deepEqual(result, {
    outcome: 'not-found',
    checkedAt: '2026-09-28T16:00:00.000Z',
  });
});

test('a Discogs outage is not stored as a miss, and an empty result is', () => {
  assert.equal(shouldRecordUnmatchedMiss({ candidateCount: 0, allSearchesFailed: true }), false);
  assert.equal(shouldRecordUnmatchedMiss({ candidateCount: 0, allSearchesFailed: false }), true);
  assert.equal(shouldRecordUnmatchedMiss({ candidateCount: 2, allSearchesFailed: false }), false);
});

test('an edited search query replaces the default and a blank edit is ignored', () => {
  const db = openDb();
  saveUnmatchedInvoiceLine(db, missedLine);
  const id = listOpenUnmatchedInvoiceItems(db)[0].id;

  updateUnmatchedSearchQuery(db, id, '  custom catno  ');
  assert.equal(listOpenUnmatchedInvoiceItems(db)[0].searchQuery, 'custom catno');

  updateUnmatchedSearchQuery(db, id, '   ');
  assert.equal(listOpenUnmatchedInvoiceItems(db)[0].searchQuery, 'custom catno');
  db.close();
});
