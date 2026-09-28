import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createTagTables } from './tags';
import { createUnmatchedInvoiceTables } from './unmatchedInvoiceItems';
import { backfillProcessedInvoices, createProcessedInvoiceTables } from './processedInvoices';

const DB_PATH = path.join(process.cwd(), 'data', 'discogs_collection.db');

function ensureDatabaseDirectory(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

export interface ReleaseRecord {
  id: number;
  discogs_id: number;
  title: string;
  year: number | null;
  cover_image_url: string | null;
  date_added: string;
  media_condition: string | null;
  sleeve_condition: string | null;
  created_at: string;
  updated_at: string;
  last_sync_at: string | null;
  sync_status: 'pending' | 'synced' | 'failed';
  metadata_version: number;
  import_source: string | null;
  import_invoice_number: string | null;
  import_invoice_date: string | null;
  imported_via_invoice_at: string | null;
  import_shipping_price: number | null;
}

export interface ArtistRecord {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseArtistRecord {
  id: number;
  release_id: number;
  artist_id: number;
  position: number; // For ordering multiple artists
  created_at: string;
}

export interface StyleRecord {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseStyleRecord {
  id: number;
  release_id: number;
  style_id: number;
  created_at: string;
}

export interface GenreRecord {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseGenreRecord {
  id: number;
  release_id: number;
  genre_id: number;
  created_at: string;
}

export interface LabelRecord {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface ReleaseLabelRecord {
  id: number;
  release_id: number;
  label_id: number;
  position: number; // For ordering multiple labels
  created_at: string;
}

export interface VideoRecord {
  id: number;
  release_id: number;
  uri: string;
  title: string;
  description: string | null;
  duration: number | null;
  embed: boolean;
  video_type: 'discogs' | 'youtube' | 'other';
  youtube_video_id: string | null;
  youtube_playlist_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackRecord {
  id: number;
  release_id: number;
  position: string;
  title: string;
  duration: string | null;
  type_: string | null;
  created_at: string;
  updated_at: string;
}

export interface PriceRecord {
  id: number;
  release_id: number;
  lowest_price: number | null;
  currency: string;
  price_source: string; // 'discogs', 'manual', etc.
  last_updated: string;
  created_at: string;
  updated_at: string;
}

export interface SyncLogRecord {
  id: number;
  release_id: number;
  sync_type: 'metadata' | 'videos' | 'tracklist' | 'price' | 'full';
  status: 'success' | 'failed' | 'partial';
  error_message: string | null;
  records_updated: number;
  sync_duration_ms: number;
  created_at: string;
}

type ColumnDefinition = {
  name: string;
  sqlDefinition: string;
};

type SchemaMigration = {
  id: string;
  apply: () => void;
};

export class DiscogsDatabase {
  private db: Database.Database;

  constructor() {
    ensureDatabaseDirectory();
    this.db = new Database(DB_PATH);
    this.configurePragmas();
    this.initializeDatabase();
  }

  private configurePragmas() {
    // Enable foreign key constraints
    this.db.pragma('foreign_keys = ON');
    
    // Enable WAL mode for better concurrency
    this.db.pragma('journal_mode = WAL');
    
    // Set synchronous mode for better performance
    this.db.pragma('synchronous = NORMAL');
    
    // Optimize cache size (10MB cache)
    this.db.pragma('cache_size = 10000');
    
    // Optimize page size for better I/O
    this.db.pragma('page_size = 8192');
    
    // Use memory for temporary tables
    this.db.pragma('temp_store = MEMORY');
    
    // Set reasonable busy timeout (5 seconds)
    this.db.pragma('busy_timeout = 5000');
    
    console.log('Database pragmas configured for optimal performance');
  }

  /**
   * Get the underlying database instance for custom queries
   * Use with caution - prefer using the provided methods
   */
  public getDb(): Database.Database {
    return this.db;
  }

  private initializeDatabase() {
    // Create tables with proper relationships and indexes
    
    // Releases table (main entity)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discogs_id INTEGER UNIQUE NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        cover_image_url TEXT,
        date_added TEXT NOT NULL,
        media_condition TEXT,
        sleeve_condition TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_sync_at TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
        metadata_version INTEGER NOT NULL DEFAULT 1,
        import_source TEXT,
        import_invoice_number TEXT,
        import_invoice_date TEXT,
        imported_via_invoice_at TEXT,
        import_shipping_price REAL,
        no_videos_available INTEGER NOT NULL DEFAULT 0,
        no_condition_available INTEGER NOT NULL DEFAULT 0,
        video_check_attempt_count INTEGER NOT NULL DEFAULT 0,
        condition_check_attempt_count INTEGER NOT NULL DEFAULT 0,
        video_consecutive_failures INTEGER NOT NULL DEFAULT 0,
        condition_consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_video_check_attempt TEXT,
        last_condition_check_attempt TEXT
      )
    `);

    // Artists table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Release-Artist junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS release_artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        artist_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
        FOREIGN KEY (artist_id) REFERENCES artists(id) ON DELETE CASCADE,
        UNIQUE(release_id, artist_id, position)
      )
    `);

    // Styles table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS styles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Release-Style junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS release_styles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        style_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
        FOREIGN KEY (style_id) REFERENCES styles(id) ON DELETE CASCADE,
        UNIQUE(release_id, style_id)
      )
    `);

    // Genres table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS genres (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Release-Genre junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS release_genres (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        genre_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
        FOREIGN KEY (genre_id) REFERENCES genres(id) ON DELETE CASCADE,
        UNIQUE(release_id, genre_id)
      )
    `);

    // Labels table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Release-Label junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS release_labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        label_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
        FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE,
        UNIQUE(release_id, label_id, position)
      )
    `);

    // Videos table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        uri TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        duration INTEGER,
        embed BOOLEAN NOT NULL DEFAULT 0,
        video_type TEXT NOT NULL DEFAULT 'discogs' CHECK (video_type IN ('discogs', 'youtube', 'other')),
        youtube_video_id TEXT,
        youtube_playlist_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
      )
    `);

    // Tracks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        position TEXT NOT NULL,
        title TEXT NOT NULL,
        duration TEXT,
        type_ TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
      )
    `);

    // Prices table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        lowest_price REAL,
        currency TEXT NOT NULL DEFAULT 'USD',
        price_source TEXT NOT NULL DEFAULT 'discogs',
        last_updated TEXT NOT NULL,
        no_listing_available INTEGER NOT NULL DEFAULT 0,
        last_check_attempt TEXT,
        check_attempt_count INTEGER NOT NULL DEFAULT 0,
        price_stale INTEGER NOT NULL DEFAULT 0,
        last_marketplace_check TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
      )
    `);

    // Sync logs table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        release_id INTEGER NOT NULL,
        sync_type TEXT NOT NULL CHECK (sync_type IN ('metadata', 'videos', 'tracklist', 'price', 'full')),
        status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'partial')),
        error_message TEXT,
        records_updated INTEGER NOT NULL DEFAULT 0,
        sync_duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
      )
    `);

    // Upgrade existing databases before creating indexes or using newer columns.
    this.applyPendingMigrations();

    // Create indexes for performance
    this.createIndexes();
    
    // Create triggers for updated_at timestamps
    this.createTriggers();
  }

  /**
   * Applies schema-only upgrades once per local database. Migrations must not
   * reinterpret or reset collection data: an app upgrade must preserve the
   * user's current sync state.
   */
  private applyPendingMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    const migrations: SchemaMigration[] = [
      {
        id: '001_release_availability_tracking',
        apply: () => this.ensureColumns('releases', [
          { name: 'no_videos_available', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          { name: 'no_condition_available', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          { name: 'video_check_attempt_count', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          { name: 'condition_check_attempt_count', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          { name: 'last_video_check_attempt', sqlDefinition: 'TEXT' },
          { name: 'last_condition_check_attempt', sqlDefinition: 'TEXT' },
        ]),
      },
      {
        id: '002_price_retry_tracking',
        apply: () => this.ensureColumns('prices', [
          { name: 'no_listing_available', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          { name: 'last_check_attempt', sqlDefinition: 'TEXT' },
          { name: 'check_attempt_count', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
        ]),
      },
      {
        id: '003_flagging_strategy',
        apply: () => {
          this.ensureColumns('prices', [
            { name: 'price_stale', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'last_marketplace_check', sqlDefinition: 'TEXT' },
            { name: 'consecutive_failures', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          ]);
          this.ensureColumns('releases', [
            { name: 'video_consecutive_failures', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
            { name: 'condition_consecutive_failures', sqlDefinition: 'INTEGER NOT NULL DEFAULT 0' },
          ]);
        },
      },
      {
        id: '004_invoice_import_metadata',
        apply: () => this.ensureColumns('releases', [
          { name: 'import_source', sqlDefinition: 'TEXT' },
          { name: 'import_invoice_number', sqlDefinition: 'TEXT' },
          { name: 'import_invoice_date', sqlDefinition: 'TEXT' },
          { name: 'imported_via_invoice_at', sqlDefinition: 'TEXT' },
          { name: 'import_shipping_price', sqlDefinition: 'REAL' },
        ]),
      },
      {
        id: '005_database_playlists',
        apply: () => this.createPlaylistTables(),
      },
      {
        id: '006_collection_tags',
        apply: () => createTagTables(this.db),
      },
      {
        id: '007_unmatched_invoice_items',
        apply: () => createUnmatchedInvoiceTables(this.db),
      },
      {
        id: '008_processed_invoices',
        apply: () => {
          createProcessedInvoiceTables(this.db);
          backfillProcessedInvoices(this.db);
        },
      },
    ];

    const alreadyApplied = this.db.prepare(
      'SELECT 1 FROM schema_migrations WHERE id = ?',
    );
    const recordMigration = this.db.prepare(
      'INSERT INTO schema_migrations (id) VALUES (?)',
    );

    for (const migration of migrations) {
      if (alreadyApplied.get(migration.id)) {
        continue;
      }

      this.db.transaction(() => {
        migration.apply();
        recordMigration.run(migration.id);
      })();
    }
  }

  private ensureColumns(
    tableName: 'prices' | 'releases',
    requiredColumns: ColumnDefinition[],
  ): void {
    const tableInfo = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    const existingColumns = new Set(tableInfo.map((column) => column.name));

    for (const column of requiredColumns) {
      if (existingColumns.has(column.name)) {
        continue;
      }

      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${column.sqlDefinition}`);
    }
  }

  private createPlaylistTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS playlist_releases (
        playlist_id TEXT NOT NULL,
        release_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (playlist_id, release_id),
        FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
      )
    `);
  }

  private createIndexes() {
    // Release indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_discogs_id ON releases(discogs_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_title ON releases(title)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_year ON releases(year)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_sync_status ON releases(sync_status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_last_sync ON releases(last_sync_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_created_at ON releases(created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_updated_at ON releases(updated_at)`);

    // Composite index for sync queries (sync_status + last_sync_at + created_at)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_sync_composite ON releases(sync_status, last_sync_at, created_at)`);
    
    // Indexes for availability flags
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_no_videos ON releases(no_videos_available)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_releases_no_condition ON releases(no_condition_available)`);

    // Artist indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_artists_name ON artists(name)`);

    // Style indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_styles_name ON styles(name)`);

    // Genre indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_genres_name ON genres(name)`);

    // Label indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_labels_name ON labels(name)`);

    // Junction table composite indexes for better join performance
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_styles_composite ON release_styles(release_id, style_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_styles_reverse ON release_styles(style_id, release_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_artists_composite ON release_artists(release_id, artist_id, position)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_genres_composite ON release_genres(release_id, genre_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_labels_composite ON release_labels(release_id, label_id, position)`);

    // Video indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_release_id ON videos(release_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_youtube_video_id ON videos(youtube_video_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_videos_youtube_playlist_id ON videos(youtube_playlist_id)`);

    // Track indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_release_id ON tracks(release_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_position ON tracks(position)`);
    // Composite index for ordered track retrieval
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tracks_release_position ON tracks(release_id, position)`);

    // Price indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prices_release_id ON prices(release_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prices_last_updated ON prices(last_updated)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prices_no_listing ON prices(no_listing_available)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prices_stale ON prices(price_stale)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prices_consecutive_failures ON prices(consecutive_failures)`);

    // Playlist indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_playlists_updated_at ON playlists(updated_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_playlist_releases_playlist_position ON playlist_releases(playlist_id, position)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_playlist_releases_release_id ON playlist_releases(release_id)`);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_normalized_name ON tags(normalized_name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_tags_release_id ON release_tags(release_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_release_tags_tag_id ON release_tags(tag_id)`);

    // Sync log indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_logs_release_id ON sync_logs(release_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_logs_created_at ON sync_logs(created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON sync_logs(status)`);
    // Composite index for sync log queries
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_logs_composite ON sync_logs(release_id, created_at, status)`);
  }

  private createTriggers() {
    // Trigger to update updated_at timestamp on releases
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_releases_updated_at
      AFTER UPDATE ON releases
      BEGIN
        UPDATE releases SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on artists
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_artists_updated_at
      AFTER UPDATE ON artists
      BEGIN
        UPDATE artists SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on styles
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_styles_updated_at
      AFTER UPDATE ON styles
      BEGIN
        UPDATE styles SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on genres
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_genres_updated_at
      AFTER UPDATE ON genres
      BEGIN
        UPDATE genres SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on labels
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_labels_updated_at
      AFTER UPDATE ON labels
      BEGIN
        UPDATE labels SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on videos
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_videos_updated_at
      AFTER UPDATE ON videos
      BEGIN
        UPDATE videos SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on tracks
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_tracks_updated_at
      AFTER UPDATE ON tracks
      BEGIN
        UPDATE tracks SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    // Trigger to update updated_at timestamp on prices
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_prices_updated_at
      AFTER UPDATE ON prices
      BEGIN
        UPDATE prices SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS update_playlists_updated_at
      AFTER UPDATE ON playlists
      BEGIN
        UPDATE playlists SET updated_at = datetime('now') WHERE id = NEW.id;
      END
    `);
  }

  // Release CRUD operations
  async createRelease(
    releaseData: Omit<
      ReleaseRecord,
      'id' |
      'created_at' |
      'updated_at' |
      'import_source' |
      'import_invoice_number' |
      'import_invoice_date' |
      'imported_via_invoice_at' |
      'import_shipping_price'
    > & Partial<
      Pick<
        ReleaseRecord,
        'import_source' |
        'import_invoice_number' |
        'import_invoice_date' |
        'imported_via_invoice_at' |
        'import_shipping_price'
      >
    >,
  ): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO releases (
        discogs_id,
        title,
        year,
        cover_image_url,
        date_added,
        media_condition,
        sleeve_condition,
        last_sync_at,
        sync_status,
        metadata_version,
        import_source,
        import_invoice_number,
        import_invoice_date,
        imported_via_invoice_at,
        import_shipping_price
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      releaseData.discogs_id,
      releaseData.title,
      releaseData.year,
      releaseData.cover_image_url,
      releaseData.date_added,
      releaseData.media_condition,
      releaseData.sleeve_condition,
      releaseData.last_sync_at,
      releaseData.sync_status,
      releaseData.metadata_version,
      releaseData.import_source ?? null,
      releaseData.import_invoice_number ?? null,
      releaseData.import_invoice_date ?? null,
      releaseData.imported_via_invoice_at ?? null,
      releaseData.import_shipping_price ?? null,
    );
    
    return result.lastInsertRowid as number;
  }

  async getReleaseByDiscogsId(discogsId: number): Promise<ReleaseRecord | null> {
    const stmt = this.db.prepare('SELECT * FROM releases WHERE discogs_id = ?');
    return stmt.get(discogsId) as ReleaseRecord | null;
  }

  async getAllReleases(): Promise<ReleaseRecord[]> {
    const stmt = this.db.prepare('SELECT * FROM releases ORDER BY created_at DESC');
    return stmt.all() as ReleaseRecord[];
  }

  async updateRelease(id: number, updates: Partial<ReleaseRecord>): Promise<void> {
    const fields = Object.keys(updates).filter(key => key !== 'id' && key !== 'created_at');
    const setClause = fields.map(field => `${field} = ?`).join(', ');
    const values = fields.map(field => updates[field as keyof ReleaseRecord]);
    
    const stmt = this.db.prepare(`UPDATE releases SET ${setClause} WHERE id = ?`);
    stmt.run(...values, id);
  }

  // Artist operations
  async createOrGetArtist(name: string): Promise<number> {
    let stmt = this.db.prepare('SELECT id FROM artists WHERE name = ?');
    const artist = stmt.get(name) as { id: number } | null;
    
    if (!artist) {
      stmt = this.db.prepare('INSERT INTO artists (name) VALUES (?)');
      const result = stmt.run(name);
      return result.lastInsertRowid as number;
    }
    
    return artist.id;
  }

  async linkReleaseToArtist(releaseId: number, artistId: number, position: number = 0): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO release_artists (release_id, artist_id, position)
      VALUES (?, ?, ?)
    `);
    stmt.run(releaseId, artistId, position);
  }

  // Style operations
  async createOrGetStyle(name: string): Promise<number> {
    let stmt = this.db.prepare('SELECT id FROM styles WHERE name = ?');
    const style = stmt.get(name) as { id: number } | null;
    
    if (!style) {
      stmt = this.db.prepare('INSERT INTO styles (name) VALUES (?)');
      const result = stmt.run(name);
      return result.lastInsertRowid as number;
    }
    
    return style.id;
  }

  async linkReleaseToStyle(releaseId: number, styleId: number): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO release_styles (release_id, style_id)
      VALUES (?, ?)
    `);
    stmt.run(releaseId, styleId);
  }

  // Genre operations
  async createOrGetGenre(name: string): Promise<number> {
    let stmt = this.db.prepare('SELECT id FROM genres WHERE name = ?');
    const genre = stmt.get(name) as { id: number } | null;
    
    if (!genre) {
      stmt = this.db.prepare('INSERT INTO genres (name) VALUES (?)');
      const result = stmt.run(name);
      return result.lastInsertRowid as number;
    }
    
    return genre.id;
  }

  async linkReleaseToGenre(releaseId: number, genreId: number): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO release_genres (release_id, genre_id)
      VALUES (?, ?)
    `);
    stmt.run(releaseId, genreId);
  }

  // Label operations
  async createOrGetLabel(name: string): Promise<number> {
    let stmt = this.db.prepare('SELECT id FROM labels WHERE name = ?');
    const label = stmt.get(name) as { id: number } | null;
    
    if (!label) {
      stmt = this.db.prepare('INSERT INTO labels (name) VALUES (?)');
      const result = stmt.run(name);
      return result.lastInsertRowid as number;
    }
    
    return label.id;
  }

  async linkReleaseToLabel(releaseId: number, labelId: number, position: number = 0): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO release_labels (release_id, label_id, position)
      VALUES (?, ?, ?)
    `);
    stmt.run(releaseId, labelId, position);
  }

  // Video operations
  async createVideo(videoData: Omit<VideoRecord, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO videos (release_id, uri, title, description, duration, embed, video_type, youtube_video_id, youtube_playlist_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      videoData.release_id,
      videoData.uri,
      videoData.title,
      videoData.description,
      videoData.duration,
      videoData.embed ? 1 : 0,
      videoData.video_type,
      videoData.youtube_video_id,
      videoData.youtube_playlist_id
    );
    
    return result.lastInsertRowid as number;
  }

  // Track operations
  async createTrack(trackData: Omit<TrackRecord, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO tracks (release_id, position, title, duration, type_)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      trackData.release_id,
      trackData.position,
      trackData.title,
      trackData.duration,
      trackData.type_
    );
    
    return result.lastInsertRowid as number;
  }

  // Price operations
  async createOrUpdatePrice(priceData: Omit<PriceRecord, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    // Check if price already exists for this release
    const existingStmt = this.db.prepare('SELECT id FROM prices WHERE release_id = ?');
    const existing = existingStmt.get(priceData.release_id) as { id: number } | null;
    
    if (existing) {
      // Update existing price
      const updateStmt = this.db.prepare(`
        UPDATE prices 
        SET lowest_price = ?, currency = ?, price_source = ?, last_updated = ?
        WHERE release_id = ?
      `);
      updateStmt.run(
        priceData.lowest_price,
        priceData.currency,
        priceData.price_source,
        priceData.last_updated,
        priceData.release_id
      );
      return existing.id;
    } else {
      // Create new price record
      const insertStmt = this.db.prepare(`
        INSERT INTO prices (release_id, lowest_price, currency, price_source, last_updated)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = insertStmt.run(
        priceData.release_id,
        priceData.lowest_price,
        priceData.currency,
        priceData.price_source,
        priceData.last_updated
      );
      return result.lastInsertRowid as number;
    }
  }

  // Sync log operations
  async createSyncLog(logData: Omit<SyncLogRecord, 'id' | 'created_at'>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO sync_logs (release_id, sync_type, status, error_message, records_updated, sync_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    const result = stmt.run(
      logData.release_id,
      logData.sync_type,
      logData.status,
      logData.error_message,
      logData.records_updated,
      logData.sync_duration_ms
    );
    
    return result.lastInsertRowid as number;
  }

  // Query operations
  async getReleaseWithDetails(discogsId: number): Promise<any> {
    const releaseStmt = this.db.prepare('SELECT * FROM releases WHERE discogs_id = ?');
    const release = releaseStmt.get(discogsId) as ReleaseRecord | null;
    
    if (!release) return null;
    
    // Get artists
    const artistsStmt = this.db.prepare(`
      SELECT a.name FROM artists a
      JOIN release_artists ra ON a.id = ra.artist_id
      WHERE ra.release_id = ?
      ORDER BY ra.position
    `);
    const artists = artistsStmt.all(release.id) as { name: string }[];
    
    // Get styles
    const stylesStmt = this.db.prepare(`
      SELECT s.name FROM styles s
      JOIN release_styles rs ON s.id = rs.style_id
      WHERE rs.release_id = ?
    `);
    const styles = stylesStmt.all(release.id) as { name: string }[];
    
    // Get genres
    const genresStmt = this.db.prepare(`
      SELECT g.name FROM genres g
      JOIN release_genres rg ON g.id = rg.genre_id
      WHERE rg.release_id = ?
    `);
    const genres = genresStmt.all(release.id) as { name: string }[];
    
    // Get labels
    const labelsStmt = this.db.prepare(`
      SELECT l.name FROM labels l
      JOIN release_labels rl ON l.id = rl.label_id
      WHERE rl.release_id = ?
      ORDER BY rl.position
    `);
    const labels = labelsStmt.all(release.id) as { name: string }[];
    
    // Get videos
    const videosStmt = this.db.prepare('SELECT * FROM videos WHERE release_id = ?');
    const videos = videosStmt.all(release.id) as VideoRecord[];
    
    // Get tracks
    const tracksStmt = this.db.prepare('SELECT * FROM tracks WHERE release_id = ? ORDER BY position');
    const tracks = tracksStmt.all(release.id) as TrackRecord[];
    
    // Get price
    const priceStmt = this.db.prepare('SELECT * FROM prices WHERE release_id = ?');
    const price = priceStmt.get(release.id) as PriceRecord | null;
    
    return {
      ...release,
      artists: artists.map(a => ({ name: a.name })),
      styles: styles.map(s => s.name),
      genres: genres.map(g => g.name),
      labels: labels.map(l => ({ name: l.name })),
      videos: videos,
      tracklist: tracks,
      priceInfo: price ? {
        lowest_price: price.lowest_price,
        currency: price.currency
      } : null
    };
  }

  async getCollectionStats(): Promise<any> {
    const totalReleases = this.db.prepare('SELECT COUNT(*) as count FROM releases').get() as { count: number };
    const totalArtists = this.db.prepare('SELECT COUNT(*) as count FROM artists').get() as { count: number };
    const totalStyles = this.db.prepare('SELECT COUNT(*) as count FROM styles').get() as { count: number };
    const totalGenres = this.db.prepare('SELECT COUNT(*) as count FROM genres').get() as { count: number };
    const totalLabels = this.db.prepare('SELECT COUNT(*) as count FROM labels').get() as { count: number };
    const totalVideos = this.db.prepare('SELECT COUNT(*) as count FROM videos').get() as { count: number };
    const totalTracks = this.db.prepare('SELECT COUNT(*) as count FROM tracks').get() as { count: number };
    const totalPrices = this.db.prepare('SELECT COUNT(*) as count FROM prices').get() as { count: number };
    
    return {
      releases: totalReleases.count,
      artists: totalArtists.count,
      styles: totalStyles.count,
      genres: totalGenres.count,
      labels: totalLabels.count,
      videos: totalVideos.count,
      tracks: totalTracks.count,
      prices: totalPrices.count
    };
  }

  async getTopStyles(limit: number = 10): Promise<Array<{ name: string; count: number }>> {
    const stmt = this.db.prepare(`
      SELECT s.name, COUNT(rs.release_id) as count
      FROM styles s
      JOIN release_styles rs ON s.id = rs.style_id
      GROUP BY s.id, s.name
      ORDER BY count DESC
      LIMIT ?
    `);
    return stmt.all(limit) as Array<{ name: string; count: number }>;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: DiscogsDatabase | null = null;

export function getDatabase(): DiscogsDatabase {
  if (!dbInstance) {
    dbInstance = new DiscogsDatabase();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
