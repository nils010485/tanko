/**
 * SQLite persistence (node:sqlite, no native build step).
 * The schema grows with the features; scaffolding starts with a KV settings
 * table — library/chapters/jobs/schedules tables are added by their modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Database {
    readonly db: DatabaseSync;

    constructor(dataDirectory: string) {
        fs.mkdirSync(dataDirectory, { recursive: true });
        const file = resolveDatabaseFile(dataDirectory);
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.migrate();
    }

    private migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    }

    kvGet(key: string): string | undefined {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        return row?.value;
    }

    kvSet(key: string, value: string): void {
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }

    close(): void {
        this.db.close();
    }
}

/** Legacy hakuneko.db → tanko.db rename at startup. */
function resolveDatabaseFile(dataDirectory: string): string {
    const file = path.join(dataDirectory, 'tanko.db');
    const legacy = path.join(dataDirectory, 'hakuneko.db');
    if (fs.existsSync(file)) {
        if (fs.existsSync(legacy)) {
            console.warn(`[db] both tanko.db and hakuneko.db exist in ${dataDirectory}; ignoring hakuneko.db`);
        }
        return file;
    }
    if (fs.existsSync(legacy)) {
        // checkpoint so no pending write is lost by the rename; on contention
        // keep the legacy name and retry next boot
        const legacyDb = new DatabaseSync(legacy);
        const checkpoint = legacyDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number };
        legacyDb.close();
        if (checkpoint.busy || checkpoint.checkpointed !== checkpoint.log) {
            console.warn(`[db] could not checkpoint hakuneko.db (locked by another process); keeping the legacy name for this boot`);
            return legacy;
        }
        try {
            fs.renameSync(legacy, file);
        } catch (error) {
            console.warn(`[db] rename hakuneko.db → tanko.db failed (${(error as Error).message}); keeping the legacy name`);
            return legacy;
        }
    }
    return file;
}
