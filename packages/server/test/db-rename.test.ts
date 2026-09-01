import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../src/db.js';

// hakuneko.db → tanko.db rename at startup.
const tmpDirs: string[] = [];
function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-rename-'));
    tmpDirs.push(dir);
    return dir;
}

/** Write a legacy hakuneko.db; `pendingWal` restores a crash-leftover pair
 *  where the row only exists in the -wal. */
function seedLegacyDatabase(dir: string, value: string, pendingWal = false): void {
    const file = path.join(dir, 'hakuneko.db');
    const legacy = new DatabaseSync(file);
    legacy.exec('PRAGMA journal_mode = WAL;');
    legacy.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    legacy.prepare("INSERT INTO settings (key, value) VALUES ('flavor', ?)").run(value);
    if (!pendingWal) {
        legacy.close();
        return;
    }
    fs.copyFileSync(file, `${file}.copy`);
    fs.copyFileSync(`${file}-wal`, `${file}-wal.copy`);
    legacy.close(); // checkpoints the originals
    fs.renameSync(`${file}.copy`, file);
    fs.renameSync(`${file}-wal.copy`, `${file}-wal`);
}

afterAll(() => {
    for (const dir of tmpDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('Database file naming', () => {
    it('creates tanko.db on a fresh install', () => {
        const dir = makeDir();
        const database = new Database(dir);
        expect(fs.existsSync(path.join(dir, 'tanko.db'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'hakuneko.db'))).toBe(false);
        database.kvSet('flavor', 'fresh');
        expect(database.kvGet('flavor')).toBe('fresh');
        database.close();
    });

    it('renames hakuneko.db to tanko.db and keeps its data', () => {
        const dir = makeDir();
        seedLegacyDatabase(dir, 'migrated');
        const database = new Database(dir);
        expect(fs.existsSync(path.join(dir, 'tanko.db'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'hakuneko.db'))).toBe(false);
        expect(database.kvGet('flavor')).toBe('migrated');
        database.close();
    });

    it('checkpoints the legacy WAL before renaming so pending writes survive', () => {
        const dir = makeDir();
        seedLegacyDatabase(dir, 'pending', true);
        const database = new Database(dir);
        expect(fs.existsSync(path.join(dir, 'tanko.db'))).toBe(true);
        expect(fs.existsSync(path.join(dir, 'hakuneko.db'))).toBe(false);
        expect(database.kvGet('flavor')).toBe('pending');
        database.close();
    });

    it('ignores hakuneko.db with a warning when both files exist', () => {
        const dir = makeDir();
        const first = new Database(dir);
        first.kvSet('flavor', 'tanko');
        first.close();
        seedLegacyDatabase(dir, 'legacy');

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const second = new Database(dir);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('hakuneko.db'));
            expect(second.kvGet('flavor')).toBe('tanko');
            expect(fs.existsSync(path.join(dir, 'hakuneko.db'))).toBe(true);
            second.close();
        } finally {
            warn.mockRestore();
        }
    });
});
