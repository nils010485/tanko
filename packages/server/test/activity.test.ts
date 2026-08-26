import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/activity/service.js';
import { Database } from '../src/db.js';

let tmpDir: string;
let database: Database;
let activity: ActivityService;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-activity-'));
    database = new Database(tmpDir);
    activity = new ActivityService({ db: database });
});

afterAll(() => {
    database.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ActivityService', () => {
    it('reads legacy rows (written before the structured columns) as system events', () => {
        // simulate a pre-v2 row written directly with the old column set
        database.db.prepare('INSERT INTO activity_log (level, message, at) VALUES (?, ?, ?)').run('warn', 'old school message', new Date().toISOString());
        const row = activity.list()[0];
        expect(row.category).toBe('system');
        expect(row.message).toBe('old school message');
        expect(row.code).toBeUndefined();
        expect(row.entryId).toBeUndefined();
    });

    it('persists and reads back the structured fields', () => {
        const id = activity.add({
            level: 'info',
            message: 'fallback',
            at: new Date().toISOString(),
            category: 'check',
            code: 'check.newChapters',
            params: { title: 'Planet Comics', count: 3 },
            entryId: 7,
            sourceId: 'dcm'
        });
        const row = activity.list().find(log => log.id === id);
        expect(row).toMatchObject({ category: 'check', code: 'check.newChapters', entryId: 7, sourceId: 'dcm' });
        expect(row?.params).toEqual({ title: 'Planet Comics', count: 3 });
    });

    it('paginates newest first with limit and offset', () => {
        for (let index = 0; index < 5; index++) {
            activity.add({ level: 'info', message: `page-${index}`, at: new Date().toISOString() });
        }
        const page = activity.list(2, 2);
        expect(page).toHaveLength(2);
        expect(page.map(log => log.message)).toEqual(['page-2', 'page-1']);
    });

    it('counts attention rows (warn or error) newer than a timestamp', () => {
        const now = Date.now();
        activity.add({ level: 'error', message: 'stale error', at: new Date(now - 3600_000).toISOString() });
        activity.add({ level: 'error', message: 'fresh error', at: new Date(now).toISOString() });
        activity.add({ level: 'warn', message: 'fresh warn', at: new Date(now).toISOString() });
        const since = new Date(now - 60_000).toISOString();
        const rows = activity.list();
        const expected = rows.filter(log => (log.level === 'warn' || log.level === 'error') && log.at > since).length;
        expect(activity.errorCountSince(since)).toBe(expected);
        expect(activity.errorCountSince(since)).toBeGreaterThan(0);
        expect(activity.errorCountSince(new Date(now + 60_000).toISOString())).toBe(0);
    });

    it('sums check.newChapters counts newer than a timestamp', () => {
        const at = new Date().toISOString();
        activity.add({ level: 'info', message: 'a', at, category: 'check', code: 'check.newChapters', params: { title: 'A', count: 2 } });
        activity.add({ level: 'info', message: 'b', at, category: 'check', code: 'check.newChapters', params: { title: 'B', count: 5 } });
        activity.add({ level: 'info', message: 'c', at, category: 'check', code: 'check.failed', params: { title: 'C' } });
        const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
        expect(activity.newChaptersSince(weekAgo)).toBeGreaterThanOrEqual(7);
    });
});
