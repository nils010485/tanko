import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { CoverService } from '../src/library/covers.js';
import { LibraryStore } from '../src/library/store.js';
import { registerCoverRoutes } from '../src/routes/covers.js';
import { EventBus } from '../src/ws.js';

let tmpDir: string;
let database: Database;
let covers: CoverService;
let libraryStore: LibraryStore;
let app: FastifyInstance;

/** Tiny solid-color page PNG. */
async function page(color: { r: number; g: number; b: number }): Promise<Buffer> {
    return sharp({ create: { width: 32, height: 48, channels: 3, background: color } })
        .png()
        .toBuffer();
}

/** Write a CBZ whose first page has `firstColor` and second page another color. */
async function writeCbz(file: string, firstColor: { r: number; g: number; b: number }): Promise<void> {
    const zip = new JSZip();
    zip.file('001.png', await page(firstColor));
    zip.file('002.png', await page({ r: 20, g: 20, b: 20 }));
    zip.file('ComicInfo.xml', Buffer.from('<ComicInfo/>'));
    await fs.promises.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function addEntry(title: string): number {
    const row = database.db
        .prepare("INSERT INTO library (source_id, source_label, manga_id, title, auto_download, added_at) VALUES ('s', 'Source', ?, ?, 1, ?)")
        .run(title.toLowerCase().replace(/\s+/g, '-'), title, new Date().toISOString());
    return Number(row.lastInsertRowid);
}

function addChapter(entryId: number, title: string, chapterPath: string | null): void {
    database.db
        .prepare(
            "INSERT INTO library_chapters (entry_id, chapter_id, title, status, path, discovered_at, downloaded_at) VALUES (?, ?, ?, 'downloaded', ?, ?, ?)"
        )
        .run(entryId, title, title, chapterPath, new Date().toISOString(), new Date().toISOString());
}

/** Wait until the background regeneration loop finishes. */
async function waitForIdle(timeoutMs = 10_000): Promise<void> {
    const startedAt = Date.now();
    while (covers.status().running) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('cover regeneration did not finish in time');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

let entryCbz: number;
let entryEarliest: number;
let entryFolder: number;
let entryDisk: number;
let entryEmpty: number;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-covers-'));
    database = new Database(tmpDir);
    // the store creates the library tables the covers FK points to
    const store = new LibraryStore({
        db: database,
        registry: { get: async () => undefined, list: async () => [] } as never,
        queueSettings: {
            dataDirectory: tmpDir,
            directoryLayout: 'source',
            chapterFormat: 'cbz',
            concurrency: 1,
            throttleMs: 0
        }
    });
    covers = new CoverService({ db: database, events: new EventBus(), directoryOf: entryId => store.seriesDirectory(entryId) });
    libraryStore = store;

    // entry with one cbz chapter
    entryCbz = addEntry('Solo Leveling');
    await writeCbz(path.join(tmpDir, 'solo-1.cbz'), { r: 255, g: 0, b: 0 });
    addChapter(entryCbz, 'Chapter 1', path.join(tmpDir, 'solo-1.cbz'));

    // entry with chapters 10 and 2 on disk: the cover must come from chapter 2
    entryEarliest = addEntry('One Piece');
    await writeCbz(path.join(tmpDir, 'op-10.cbz'), { r: 0, g: 0, b: 255 });
    addChapter(entryEarliest, 'Chapter 10', path.join(tmpDir, 'op-10.cbz'));
    await writeCbz(path.join(tmpDir, 'op-2.cbz'), { r: 255, g: 0, b: 0 });
    addChapter(entryEarliest, 'Chapter 2', path.join(tmpDir, 'op-2.cbz'));

    // entry with an img-format chapter folder
    entryFolder = addEntry('Berserk');
    const chapterDir = path.join(tmpDir, 'berserk-1');
    fs.mkdirSync(chapterDir, { recursive: true });
    fs.writeFileSync(path.join(chapterDir, '001.png'), await page({ r: 0, g: 255, b: 0 }));
    fs.writeFileSync(path.join(chapterDir, '002.png'), await page({ r: 20, g: 20, b: 20 }));
    addChapter(entryFolder, 'Chapter 1', chapterDir);

    // entry whose chapters exist on disk but were never registered in the
    // database (import whose source-based sync failed) — disk fallback
    entryDisk = addEntry('Damn Reincarnation');
    const diskSeries = path.join(tmpDir, 'Source', 'Damn Reincarnation');
    fs.mkdirSync(diskSeries, { recursive: true });
    await writeCbz(path.join(diskSeries, 'Chapter 001.cbz'), { r: 120, g: 0, b: 120 });

    // entry without any downloaded chapter
    entryEmpty = addEntry('Nirvana');

    app = Fastify();
    registerCoverRoutes(app, covers);
});

afterAll(async () => {
    await app.close();
    database.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CoverService', () => {
    it('starts disabled and with an empty status', () => {
        expect(covers.isEnabled()).toBe(false);
        expect(covers.status()).toMatchObject({ enabled: false, running: false });
    });

    it('regenerates webp covers from the earliest downloaded chapter', async () => {
        const { started } = covers.regenerate();
        expect(started).toBe(true);
        await waitForIdle();

        const status = covers.status();
        expect(status.done).toBe(4);
        expect(status.skipped).toBe(1);
        expect(status.failed).toBe(0);
        // counts of the disk-only entry come from the folder, not the database
        const entries = await libraryStore.listEntries('all');
        const disk = entries.find(entry => entry.id === entryDisk)!;
        expect(disk.chapterCount).toBe(1);
        expect(disk.downloadedCount).toBe(1);
        const empty = entries.find(entry => entry.id === entryEmpty)!;
        expect(empty.chapterCount).toBe(0);
        expect(empty.downloadedCount).toBe(0);

        // webp magic bytes
        const cover = covers.getCover(entryCbz)!;
        expect(cover.subarray(0, 4)).toEqual(Buffer.from('RIFF'));
        expect(cover.subarray(8, 12)).toEqual(Buffer.from('WEBP'));

        // chapter 2 (red) must win over chapter 10 (blue)
        const earliest = await sharp(covers.getCover(entryEarliest)!).stats();
        expect(earliest.dominant.r).toBeGreaterThan(150);
        expect(earliest.dominant.b).toBeLessThan(100);

        // img-format folder also produces a cover (green first page)
        const folder = await sharp(covers.getCover(entryFolder)!).stats();
        expect(folder.dominant.g).toBeGreaterThan(150);

        expect(covers.hasCover(entryEmpty)).toBe(false);
        expect(covers.coveredEntryIds()).toEqual(new Set([entryCbz, entryEarliest, entryFolder, entryDisk]));
    });

    it('serves covers through the route with image/webp content type', async () => {
        const ok = await app.inject({ method: 'GET', url: `/api/library/${entryCbz}/cover` });
        expect(ok.statusCode).toBe(200);
        expect(ok.headers['content-type']).toBe('image/webp');
        expect(Buffer.from(ok.rawPayload).subarray(0, 4)).toEqual(Buffer.from('RIFF'));

        const missing = await app.inject({ method: 'GET', url: `/api/library/${entryEmpty}/cover` });
        expect(missing.statusCode).toBe(404);

        const status = await app.inject({ method: 'GET', url: '/api/library/covers/status' });
        expect(status.statusCode).toBe(200);
        expect(status.json()).toMatchObject({ running: false, done: 4, skipped: 1 });
    });

    it('crops very tall pages (webtoon strips) instead of failing', async () => {
        const entryStrip = addEntry('Webtoon Strip');
        const chapterDir = path.join(tmpDir, 'strip-1');
        fs.mkdirSync(chapterDir, { recursive: true });
        // 400x20000px: a width-only resize to 400 would exceed WebP's 16383px limit
        fs.writeFileSync(
            path.join(chapterDir, '001.png'),
            await sharp({ create: { width: 400, height: 20000, channels: 3, background: { r: 10, g: 10, b: 200 } } })
                .png()
                .toBuffer()
        );
        addChapter(entryStrip, 'Chapter 1', chapterDir);

        expect(await covers.generateForEntry(entryStrip)).toBe(true);
        const meta = await sharp(covers.getCover(entryStrip)!).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBe(400);
        expect(meta.height).toBe(600);
    });

    it('clears the cache', () => {
        covers.clear();
        expect(covers.coveredEntryIds().size).toBe(0);
    });
});
