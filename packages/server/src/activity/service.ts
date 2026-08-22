/**
 * Activity log persistence: every `log` event published on the event bus is
 * also written to SQLite, so the dashboard Activity tab can load an history
 * that survives server restarts (in addition to the live WS stream).
 */
import type { ActivityLogDto, LogLevel } from '@tanko/shared';
import type { Database } from '../db.js';

/** Rows kept in the table; older entries are pruned on insert. */
const RETENTION_ROWS = 1000;
/** Default page size for GET /api/activity. */
export const ACTIVITY_PAGE_SIZE = 100;

interface LogRow {
    id: number;
    level: string;
    message: string;
    at: string;
}

export class ActivityService {
    private readonly db: Database;

    constructor(opts: { db: Database }) {
        this.db = opts.db;
        this.migrate();
    }

    private migrate(): void {
        this.db.db.exec(`
            CREATE TABLE IF NOT EXISTS activity_log (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                level   TEXT NOT NULL,
                message TEXT NOT NULL,
                at      TEXT NOT NULL
            );
        `);
    }

    /** Persist one entry; returns its row id (used to tag the broadcast WS event). */
    add(level: LogLevel, message: string, at: string): number {
        const result = this.db.db.prepare('INSERT INTO activity_log (level, message, at) VALUES (?, ?, ?)').run(level, message, at);
        const id = Number(result.lastInsertRowid);
        this.db.db.prepare('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?').run(RETENTION_ROWS);
        return id;
    }

    /** Newest entries first. */
    list(limit = ACTIVITY_PAGE_SIZE): ActivityLogDto[] {
        const rows = this.db.db.prepare('SELECT id, level, message, at FROM activity_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as LogRow[];
        return rows.map(row => ({ id: row.id, level: row.level as LogLevel, message: row.message, at: row.at }));
    }
}
