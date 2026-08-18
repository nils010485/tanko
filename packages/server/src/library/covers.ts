/**
 * First-chapter cover cache: when the user opts in, the first page of the
 * earliest downloaded chapter of each series is converted to a small WebP and
 * stored in SQLite, so the library grid renders instantly from local data
 * instead of remote thumbnails. Disk-only: series without a downloaded
 * chapter keep their source thumbnail (or letter placeholder).
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { Database } from '../db.js';
import type { EventBus } from '../ws.js';
import { parseChapterNumber } from '../import/scanner.js';

const COVERS_KEY = 'first-chapter-covers';
const COVER_WIDTH = 400;
const COVER_QUALITY = 80;
/** Hard cap on the source image size we feed to sharp (protection against huge scans). */
const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp']);

export interface CoverStatus {
    enabled: boolean;
    running: boolean;
    total: number;
    done: number;
    failed: number;
    skipped: number;
}

/** Numeric-aware ordering for page file names ("2.jpg" before "10.jpg"). */
function naturalCompare(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export class CoverService {

    private running = false;
    private counters = { total: 0, done: 0, failed: 0, skipped: 0 };
    /** Bumped on clear(): an in-flight regeneration loop aborts when it changes. */
    private generation = 0;

    constructor(private readonly opts: { db: Database; events: EventBus }) {
        // created after the library tables (FK) — LibraryStore runs first
        this.opts.db.db.exec(`
            CREATE TABLE IF NOT EXISTS library_covers (
                entry_id    INTEGER PRIMARY KEY REFERENCES library(id) ON DELETE CASCADE,
                data        BLOB NOT NULL,
                updated_at  TEXT NOT NULL
            );
        `);
    }

    // ------------------------------------------------------------------
    // setting
    // ------------------------------------------------------------------

    isEnabled(): boolean {
        return this.opts.db.kvGet(COVERS_KEY) === 'true';
    }

    setEnabled(value: boolean): void {
        this.opts.db.kvSet(COVERS_KEY, value ? 'true' : 'false');
    }

    // ------------------------------------------------------------------
    // cache reads
    // ------------------------------------------------------------------

    getCover(entryId: number): Buffer | undefined {
        const row = this.opts.db.db.prepare('SELECT data FROM library_covers WHERE entry_id = ?').get(entryId) as { data: Uint8Array } | undefined;
        return row ? Buffer.from(row.data) : undefined;
    }

    hasCover(entryId: number): boolean {
        return this.opts.db.db.prepare('SELECT 1 FROM library_covers WHERE entry_id = ?').get(entryId) !== undefined;
    }

    /** Entry ids that currently have a cached cover (library list decoration). */
    coveredEntryIds(): Set<number> {
        const rows = this.opts.db.db.prepare('SELECT entry_id FROM library_covers').all() as Array<{ entry_id: number }>;
        return new Set(rows.map(row => row.entry_id));
    }

    clear(): void {
        this.generation++;
        this.opts.db.db.exec('DELETE FROM library_covers');
    }

    // ------------------------------------------------------------------
    // generation
    // ------------------------------------------------------------------

    status(): CoverStatus {
        return { enabled: this.isEnabled(), running: this.running, ...this.counters };
    }

    /**
     * Wipe the cache and rebuild it for every library entry, in the
     * background. Returns immediately; progress is exposed via status().
     */
    regenerate(): { started: boolean } {
        if (this.running) {
            return { started: false };
        }
        this.clear();
        void this.run();
        return { started: true };
    }

    private async run(): Promise<void> {
        this.running = true;
        const generation = this.generation;
        const entries = this.opts.db.db.prepare('SELECT id, title FROM library').all() as Array<{ id: number; title: string }>;
        this.counters = { total: entries.length, done: 0, failed: 0, skipped: 0 };
        this.log(`regenerating cover cache for ${entries.length} series`);
        for (const entry of entries) {
            if (generation !== this.generation) {
                this.running = false; // the cache was cleared (or a new run started): stop
                return;
            }
            try {
                const generated = await this.generateForEntry(entry.id);
                if (generated) {
                    this.counters.done++;
                } else {
                    this.counters.skipped++;
                }
            } catch (error) {
                this.counters.failed++;
                this.log(`cover failed for "${entry.title}": ${(error as Error).message}`, 'warn');
            }
        }
        this.running = false;
        this.log(`cover cache done: ${this.counters.done} generated, ${this.counters.skipped} skipped, ${this.counters.failed} failed`);
    }

    /**
     * Build the cover for one entry from its earliest downloaded chapter on
     * disk. Resolves false when no readable chapter/page exists (skipped).
     */
    async generateForEntry(entryId: number): Promise<boolean> {
        const chapters = this.opts.db.db.prepare(
            "SELECT title, path FROM library_chapters WHERE entry_id = ? AND status = 'downloaded' AND path IS NOT NULL"
        ).all(entryId) as Array<{ title: string; path: string }>;
        // earliest chapter first: the cover must come from chapter 1 whenever it is on disk
        chapters.sort((a, b) => {
            const numberA = parseChapterNumber(a.title) ?? Number.MAX_SAFE_INTEGER;
            const numberB = parseChapterNumber(b.title) ?? Number.MAX_SAFE_INTEGER;
            return numberA - numberB || naturalCompare(a.title, b.title);
        });
        for (const chapter of chapters) {
            const page = await this.firstPage(chapter.path);
            if (!page || page.byteLength > MAX_SOURCE_BYTES) {
                continue;
            }
            const webp = await sharp(page)
                .rotate()
                .resize({ width: COVER_WIDTH, withoutEnlargement: true })
                .webp({ quality: COVER_QUALITY })
                .toBuffer();
            this.opts.db.db.prepare(
                'INSERT INTO library_covers (entry_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
            ).run(entryId, webp, new Date().toISOString());
            return true;
        }
        return false;
    }

    /**
     * First page of a downloaded chapter: either the first image inside the
     * CBZ archive or the first image file of the chapter folder.
     */
    private async firstPage(chapterPath: string): Promise<Buffer | null> {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(chapterPath);
        } catch {
            return null; // file moved/deleted since the download
        }
        if (stat.size > MAX_SOURCE_BYTES) {
            return null;
        }
        if (stat.isFile() && chapterPath.toLowerCase().endsWith('.cbz')) {
            const zip = await JSZip.loadAsync(await fs.promises.readFile(chapterPath));
            const names = Object.values(zip.files)
                .filter(entry => !entry.dir && IMAGE_EXTENSIONS.has(extension(entry.name)))
                .map(entry => entry.name)
                .sort(naturalCompare);
            if (names.length === 0) {
                return null;
            }
            return zip.files[names[0]!]!.async('nodebuffer');
        }
        if (stat.isDirectory()) {
            const files = fs.readdirSync(chapterPath)
                .filter(name => IMAGE_EXTENSIONS.has(extension(name)))
                .sort(naturalCompare);
            if (files.length === 0) {
                return null;
            }
            return fs.promises.readFile(path.join(chapterPath, files[0]!));
        }
        return null;
    }

    private log(message: string, level: 'info' | 'warn' = 'info'): void {
        this.opts.events.publish({ type: 'log', level, message: `[covers] ${message}`, at: new Date().toISOString() });
    }
}

function extension(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot).toLowerCase();
}
