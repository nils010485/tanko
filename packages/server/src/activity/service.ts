/**
 * Activity log persistence: every `log` event published on the event bus is
 * also written to SQLite, so the dashboard Activity tab can load an history
 * that survives server restarts (in addition to the live WS stream).
 */
import type { ActivityLogDto, LogCategory, LogLevel } from '@tanko/shared';
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
    category: string | null;
    code: string | null;
    params: string | null;
    entry_id: number | null;
    source_id: string | null;
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
        // structured events: rows written before v2 keep NULL everywhere and
        // read back as legacy 'system' entries with their raw message
        const columns = this.db.db.prepare('PRAGMA table_info(activity_log)').all() as Array<{ name: string }>;
        const addColumn = (name: string, ddl: string) => {
            if (!columns.some(column => column.name === name)) {
                this.db.db.exec(`ALTER TABLE activity_log ADD COLUMN ${ddl}`);
            }
        };
        addColumn('category', 'category TEXT');
        addColumn('code', 'code TEXT');
        addColumn('params', 'params TEXT');
        addColumn('entry_id', 'entry_id INTEGER');
        addColumn('source_id', 'source_id TEXT');
    }

    /** Persist one entry; returns its row id (used to tag the broadcast WS event). */
    add(event: {
        level: LogLevel;
        message: string;
        at: string;
        category?: LogCategory;
        code?: string;
        params?: Record<string, string | number>;
        entryId?: number;
        sourceId?: string;
    }): number {
        const result = this.db.db
            .prepare('INSERT INTO activity_log (level, message, at, category, code, params, entry_id, source_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(
                event.level,
                event.message,
                event.at,
                event.category ?? null,
                event.code ?? null,
                event.params ? JSON.stringify(event.params) : null,
                event.entryId ?? null,
                event.sourceId ?? null
            );
        const id = Number(result.lastInsertRowid);
        this.db.db.prepare('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?').run(RETENTION_ROWS);
        return id;
    }

    /** Newest entries first; rows without a category (pre-v2) read as 'system'. */
    list(limit = ACTIVITY_PAGE_SIZE, offset = 0): ActivityLogDto[] {
        const rows = this.db.db
            .prepare('SELECT id, level, message, at, category, code, params, entry_id, source_id FROM activity_log ORDER BY id DESC LIMIT ? OFFSET ?')
            .all(limit, offset) as unknown as LogRow[];
        return rows.map(row => ({
            id: row.id,
            level: row.level as LogLevel,
            message: row.message,
            at: row.at,
            category: (row.category as LogCategory | null) ?? 'system',
            code: row.code ?? undefined,
            params: row.params ? (JSON.parse(row.params) as Record<string, string | number>) : undefined,
            entryId: row.entry_id ?? undefined,
            sourceId: row.source_id ?? undefined
        }));
    }

    /** Attention-worthy rows (warn or error) newer than `since` (ISO) —
     *  drives the dashboard's unread badge. */
    errorCountSince(since: string): number {
        const row = this.db.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE level IN ('warn', 'error') AND at > ?").get(since) as unknown as {
            n: number;
        };
        return row.n;
    }

    /** Sum of the new-chapter counts of check.newChapters rows newer than
     *  `since` (ISO timestamp) — bounded by the table retention. */
    newChaptersSince(since: string): number {
        const rows = this.db.db.prepare("SELECT params FROM activity_log WHERE code = 'check.newChapters' AND at > ?").all(since) as unknown as Array<{
            params: string | null;
        }>;
        return rows.reduce((sum, row) => sum + ((row.params ? (JSON.parse(row.params) as Record<string, number>).count : 0) ?? 0), 0);
    }
}
