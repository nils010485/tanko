/**
 * Library schema: tables, indexes and column migrations for older databases.
 * Runs on every store construction (CREATE IF NOT EXISTS + addColumn no-ops).
 */
import type { Database } from '../db.js';

/** Create the library tables and bring older databases up to date. */
export function migrateLibrarySchema(db: Database): void {
    db.db.exec(`
        CREATE TABLE IF NOT EXISTS library (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id           TEXT NOT NULL,
            source_label        TEXT NOT NULL,
            manga_id            TEXT NOT NULL,
            title               TEXT NOT NULL,
            url                 TEXT,
            thumbnail           TEXT,
            auto_download       INTEGER NOT NULL DEFAULT 1,
            check_failures      INTEGER NOT NULL DEFAULT 0,
            migration_suggestion TEXT,
            last_checked_at     TEXT,
            added_at            TEXT NOT NULL,
            UNIQUE(source_id, manga_id)
        );
        CREATE TABLE IF NOT EXISTS library_chapters (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id      INTEGER NOT NULL REFERENCES library(id) ON DELETE CASCADE,
            chapter_id    TEXT NOT NULL,
            title         TEXT NOT NULL,
            language      TEXT,
            status        TEXT NOT NULL DEFAULT 'new',
            path          TEXT,
            discovered_at TEXT NOT NULL,
            downloaded_at TEXT,
            UNIQUE(entry_id, chapter_id)
        );
        CREATE INDEX IF NOT EXISTS idx_library_chapters_entry ON library_chapters(entry_id, status);
        CREATE TABLE IF NOT EXISTS chapter_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id   INTEGER NOT NULL,
            chapter_id TEXT NOT NULL,
            title      TEXT NOT NULL,
            event      TEXT NOT NULL,
            old_status TEXT,
            old_path   TEXT,
            new_status TEXT,
            new_path   TEXT,
            at         TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chapter_history ON chapter_history(entry_id, chapter_id);
        CREATE TABLE IF NOT EXISTS entry_snapshots (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id INTEGER NOT NULL,
            reason   TEXT NOT NULL,
            data     TEXT NOT NULL,
            at       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS source_outages (
            source_id    TEXT PRIMARY KEY,
            started_at   TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            failures     INTEGER NOT NULL DEFAULT 0,
            escalated_at TEXT,
            closed_at    TEXT
        );
    `);
    // databases created before the soft-close redesign: add the closed_at stamp
    const outageColumns = db.db.prepare('PRAGMA table_info(source_outages)').all() as Array<{ name: string }>;
    addColumn(db, 'source_outages', outageColumns, 'closed_at', 'closed_at TEXT');

    // existing databases: add columns when missing
    const columns = db.db.prepare('PRAGMA table_info(library)').all() as Array<{ name: string }>;
    addColumn(db, 'library', columns, 'thumbnail', 'thumbnail TEXT');
    addColumn(db, 'library', columns, 'check_failures', 'check_failures INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'library', columns, 'migration_suggestion', 'migration_suggestion TEXT');
    addColumn(db, 'library', columns, 'migration_dismissed', 'migration_dismissed TEXT');
    addColumn(db, 'library', columns, 'hidden', 'hidden INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'library', columns, 'download_failures', 'download_failures INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'library', columns, 'last_chapter_at', 'last_chapter_at TEXT');
    addColumn(db, 'library', columns, 'staleness_misses', 'staleness_misses INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'library', columns, 'staleness_next_probe_at', 'staleness_next_probe_at TEXT');
    addColumn(db, 'library', columns, 'paused', 'paused INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'library', columns, 'aliases', 'aliases TEXT');
    // unknown last-new-chapter date (existing databases, imports, or rows
    // created between the ALTER and a crash): start from today so the
    // auto-unfollow cannot fire right on startup — runs on every boot, a
    // no-op once every row carries a date
    db.db.prepare('UPDATE library SET last_chapter_at = ? WHERE last_chapter_at IS NULL').run(new Date().toISOString());
    const chapterColumns = db.db.prepare('PRAGMA table_info(library_chapters)').all() as Array<{ name: string }>;
    addColumn(db, 'library_chapters', chapterColumns, 'prev_status', 'prev_status TEXT');
}

/** ALTER TABLE helper: adds `ddl` (must reference `name`) to `table` when the column is missing. */
function addColumn(db: Database, table: string, columns: Array<{ name: string }>, name: string, ddl: string): void {
    if (!columns.some(column => column.name === name)) {
        db.db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
}
