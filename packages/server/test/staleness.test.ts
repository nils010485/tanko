import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { LibraryStore } from '../src/library/store.js';

const DAY_MS = 86_400_000;
const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

let tmpDir: string;
let database: Database;
let store: LibraryStore;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-staleness-'));
    database = new Database(tmpDir);
    store = new LibraryStore({
        db: database,
        // minimal live source: enough label for addEntry, no chapters to snapshot
        registry: { get: async (id: string) => ({ label: id, getChapters: async () => [] }), list: async () => [] } as never,
        queueSettings: {
            dataDirectory: path.join(tmpDir, 'downloads'),
            directoryLayout: 'source',
            chapterFormat: 'img',
            parallelSources: 1,
            concurrencyPerSource: 1,
            throttleMs: 0
        }
    });
});

afterAll(() => {
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a tracked entry whose chapters were discovered at the given day
 *  offsets (each offset = one discovery event; equal offsets collapse into a
 *  single event) and whose last new chapter dates back to the most recent
 *  one. Returns the entry id. */
async function tracked(title: string, eventsDaysAgo: number[]): Promise<number> {
    const { entry } = await store.addEntry({ sourceId: `src-${title}`, mangaId: 'm', title, backlog: 'ignore' });
    const insert = database.db.prepare(
        'INSERT OR IGNORE INTO library_chapters (entry_id, chapter_id, title, language, status, discovered_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    eventsDaysAgo.forEach((daysAgo, index) => {
        insert.run(entry.id, `c${index}`, `Ch. ${index}`, 'en', 'downloaded', isoDaysAgo(daysAgo));
    });
    database.db.prepare('UPDATE library SET last_chapter_at = ? WHERE id = ?').run(isoDaysAgo(Math.min(...eventsDaysAgo)), entry.id);
    return entry.id;
}

const candidateIds = () => store.listStalledCandidates().map(candidate => candidate.id);

describe('listStalledCandidates (rhythm-aware staleness)', () => {
    it('flags a weekly series idle for 3+ weeks', async () => {
        // 13 weekly events: learned rhythm 7d -> threshold max(3×7, 14) = 21d; idle 22d
        const weekly = await tracked(
            'Weekly',
            Array.from({ length: 13 }, (_, index) => 22 + index * 7)
        );
        expect(candidateIds()).toContain(weekly);
    });

    it('keeps a weekly series idle for less than 3 weeks', async () => {
        const fresh = await tracked(
            'Fresh Weekly',
            Array.from({ length: 13 }, (_, index) => 10 + index * 7)
        );
        expect(candidateIds()).not.toContain(fresh);
    });

    it('learns slow rhythms: a monthly series 40 days idle is not stalled', async () => {
        // gaps of 30d -> threshold 90d; last chapter 40d ago
        const monthly = await tracked(
            'Monthly',
            Array.from({ length: 13 }, (_, index) => 40 + index * 30)
        );
        expect(candidateIds()).not.toContain(monthly);
    });

    it('falls back to a fixed 30-day window when the rhythm is unknown', async () => {
        // a single bulk-import event: no gaps to learn from
        const imported = await tracked('Bulk', [40]);
        const young = await tracked('Bulk Young', [20]);
        const listed = candidateIds();
        expect(listed).toContain(imported);
        expect(listed).not.toContain(young);
    });

    it('excludes hidden entries, failing sources and pending suggestions', async () => {
        const hidden = await tracked('Hidden', [40]);
        database.db.prepare('UPDATE library SET hidden = 1 WHERE id = ?').run(hidden);
        const failing = await tracked('Failing', [40]);
        database.db.prepare('UPDATE library SET check_failures = 2 WHERE id = ?').run(failing);
        const suggested = await tracked('Suggested', [40]);
        database.db.prepare("UPDATE library SET migration_suggestion = '{}' WHERE id = ?").run(suggested);
        const listed = candidateIds();
        expect(listed).not.toContain(hidden);
        expect(listed).not.toContain(failing);
        expect(listed).not.toContain(suggested);
    });

    it('honours the probe back-off window', async () => {
        const backed = await tracked('Backed Off', [40]);
        store.recordStalenessProbe(backed, false); // next probe not due for 7 days
        expect(candidateIds()).not.toContain(backed);
    });
});

describe('recordStalenessProbe (exponential back-off)', () => {
    const rowOf = (entryId: number) =>
        database.db.prepare('SELECT staleness_misses AS misses, staleness_next_probe_at AS next FROM library WHERE id = ?').get(entryId) as {
            misses: number;
            next: string | null;
        };

    it('spaces misses out exponentially and resets on a hit', async () => {
        const entryId = await tracked('Backoff', [40]);
        const before = Date.now();
        store.recordStalenessProbe(entryId, false);
        expect(rowOf(entryId).misses).toBe(1);
        expect(Date.parse(rowOf(entryId).next ?? '')).toBeGreaterThanOrEqual(before + 7 * DAY_MS - 1000);
        store.recordStalenessProbe(entryId, false);
        expect(rowOf(entryId).misses).toBe(2);
        expect(Date.parse(rowOf(entryId).next ?? '')).toBeGreaterThanOrEqual(before + 14 * DAY_MS - 1000);
        // deep in the ladder the delay stays capped at 45 days
        store.recordStalenessProbe(entryId, false);
        store.recordStalenessProbe(entryId, false);
        store.recordStalenessProbe(entryId, false);
        expect(rowOf(entryId).misses).toBe(5);
        expect(Date.parse(rowOf(entryId).next ?? '')).toBeLessThanOrEqual(Date.now() + 45 * DAY_MS);
        // a hit (suggestion stored) resets the ladder entirely
        store.recordStalenessProbe(entryId, true);
        expect(rowOf(entryId)).toEqual({ misses: 0, next: null });
    });

    it('clears the back-off when a check discovers a new chapter', async () => {
        // real discovery path: a store whose registry serves one brand-new chapter
        const live = new LibraryStore({
            db: database,
            registry: {
                get: async () => ({ label: 'Live', getChapters: async () => [{ id: `c-${Date.now()}`, title: 'Ch. New', language: 'en' }] }),
                list: async () => []
            } as never,
            queueSettings: {
                dataDirectory: path.join(tmpDir, 'downloads'),
                directoryLayout: 'source',
                chapterFormat: 'img',
                parallelSources: 1,
                concurrencyPerSource: 1,
                throttleMs: 0
            }
        });
        const { entry } = await live.addEntry({ sourceId: 'live-src', mangaId: 'm', title: 'Live Series', backlog: 'ignore' });
        live.recordStalenessProbe(entry.id, false);
        expect(rowOf(entry.id).misses).toBe(1);
        const { fresh } = await live.checkForNewChapters(entry.id);
        expect(fresh.length).toBe(1);
        expect(rowOf(entry.id)).toEqual({ misses: 0, next: null });
    });
});
