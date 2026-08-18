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
        const file = path.join(dataDirectory, 'hakuneko.db');
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
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, value);
    }

    close(): void {
        this.db.close();
    }
}
