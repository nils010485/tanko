/**
 * First-chapter cover cache: when the user opts in, the first page of the
 * earliest downloaded chapter of each series is converted to a small WebP and
 * stored in SQLite, so the library grid renders instantly from local data
 * instead of remote thumbnails. Purely local: chapters registered in the
 * database are used first, and entries without any (e.g. import whose
 * source-based sync failed) fall back to a direct scan of their series
 * folder on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { JobRunner } from '../activity/jobs.js';
import type { Database } from '../db.js';
import { listChapterEntries } from '../downloader/paths.js';
import { parseChapterNumber } from '../import/scanner.js';
import type { EventBus } from '../ws.js';

const COVERS_KEY = 'first-chapter-covers';
const COVER_WIDTH = 400;
/** Crop height for webtoon-strip covers (2:3 ratio). */
const COVER_STRIP_HEIGHT = Math.round(COVER_WIDTH * 1.5);
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

    constructor(
        private readonly opts: {
            db: Database;
            events: EventBus;
            /** Resolves the on-disk series folder of an entry (LibraryStore.seriesDirectory). */
            directoryOf?: (entryId: number) => string | null;
            /** Activity job registry: makes regeneration visible (progress + cancel) in the dashboard. */
            jobs?: JobRunner;
        }
    ) {
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

    /** Abort an in-flight regeneration loop without wiping the cache (cancel from the Activity tab). */
    private abort(): void {
        this.generation++;
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
        void this.run().catch(error => console.warn('[covers] regeneration failed:', (error as Error).message));
        return { started: true };
    }

    private async run(): Promise<void> {
        this.running = true;
        const generation = this.generation;
        const entries = this.opts.db.db.prepare('SELECT id, title FROM library').all() as Array<{ id: number; title: string }>;
        this.counters = { total: entries.length, done: 0, failed: 0, skipped: 0 };
        // Activity job: progress is the settled count, hits the covers actually generated.
        // Cancelling bumps the generation, which aborts the loop below.
        const handle = this.opts.jobs?.begin('covers.regenerate', 'Régénération des couvertures', entries.length, {
            onCancel: () => this.abort()
        });
        this.log(`regenerating cover cache for ${entries.length} series`, 'info', 'scan.covers.started', { total: entries.length });
        let cancelled = false;
        try {
            for (const entry of entries) {
                if (generation !== this.generation) {
                    cancelled = true; // the cache was cleared (or the job cancelled): stop
                    break;
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
                    this.log(`cover failed for "${entry.title}": ${(error as Error).message}`, 'warn', 'scan.covers.entryFailed', {
                        title: entry.title,
                        error: (error as Error).message
                    });
                }
                const settled = this.counters.done + this.counters.failed + this.counters.skipped;
                handle?.update({ done: settled, hits: this.counters.done });
            }
        } finally {
            this.running = false;
            handle?.finish(cancelled);
        }
        if (cancelled) {
            this.log(
                `cover cache regeneration cancelled: ${this.counters.done} generated, ${this.counters.failed} failed, ${this.counters.skipped} skipped`,
                'warn',
                'scan.covers.cancelled',
                { done: this.counters.done, failed: this.counters.failed, skipped: this.counters.skipped }
            );
            return;
        }
        this.log(
            `cover cache done: ${this.counters.done} generated, ${this.counters.skipped} skipped, ${this.counters.failed} failed`,
            'info',
            'scan.covers.finished',
            { done: this.counters.done, skipped: this.counters.skipped, failed: this.counters.failed }
        );
    }

    /**
     * Build the cover for one entry from its earliest chapter on disk —
     * chapters registered in the database first, series-folder scan as a
     * fallback for entries the database knows nothing about. Resolves false
     * when no readable page exists (skipped).
     */
    async generateForEntry(entryId: number): Promise<boolean> {
        const registered = this.opts.db.db
            .prepare("SELECT title, path FROM library_chapters WHERE entry_id = ? AND status = 'downloaded' AND path IS NOT NULL")
            .all(entryId) as Array<{ title: string; path: string }>;
        registered.sort((a, b) => byChapterNumber(a.title, b.title));
        const candidates = [...registered.map(chapter => chapter.path), ...this.diskChapters(entryId)];
        for (const chapterPath of candidates) {
            const page = await this.firstPage(chapterPath);
            if (page && (await this.storeCover(entryId, page))) {
                return true;
            }
        }
        return false;
    }

    /** Chapter paths found by scanning the series folder on disk. */
    private diskChapters(entryId: number): string[] {
        const directory = this.opts.directoryOf?.(entryId);
        if (!directory) {
            return [];
        }
        return listChapterEntries(directory)
            .sort(byChapterNumber)
            .map(name => path.join(directory, name));
    }

    /** Convert a first page to WebP and persist it (false when unusable). */
    private async storeCover(entryId: number, page: Buffer): Promise<boolean> {
        if (page.byteLength > MAX_SOURCE_BYTES) {
            return false;
        }
        try {
            const image = sharp(page).rotate();
            const meta = await image.metadata();
            // Extremely tall pages (webtoon strips) would exceed WebP's 16383px
            // per-dimension limit after the width-only resize — crop the top in a
            // cover-like 2:3 ratio instead of shrinking the whole strip.
            const strip = (meta.height ?? 0) > (meta.width ?? 1) * 3;
            const webp = await image
                .resize(
                    strip
                        ? { width: COVER_WIDTH, height: COVER_STRIP_HEIGHT, fit: 'cover', position: 'top', withoutEnlargement: true }
                        : { width: COVER_WIDTH, withoutEnlargement: true }
                )
                .webp({ quality: COVER_QUALITY })
                .toBuffer();
            this.opts.db.db
                .prepare(
                    'INSERT INTO library_covers (entry_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
                )
                .run(entryId, webp, new Date().toISOString());
            return true;
        } catch (error) {
            this.log(`cover conversion failed for entry ${entryId}: ${(error as Error).message}`, 'warn', 'scan.covers.conversionFailed', { entryId });
            return false;
        }
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
            const first = names[0];
            if (!first) {
                return null;
            }
            return zip.files[first]?.async('nodebuffer');
        }
        if (stat.isDirectory()) {
            const files = fs
                .readdirSync(chapterPath)
                .filter(name => IMAGE_EXTENSIONS.has(extension(name)))
                .sort(naturalCompare);
            const first = files[0];
            if (!first) {
                return null;
            }
            return fs.promises.readFile(path.join(chapterPath, first));
        }
        return null;
    }

    private log(message: string, level: 'info' | 'warn' = 'info', code?: string, params?: Record<string, string | number>): void {
        this.opts.events.publishLog({ level, category: 'scan', code, params, message: `[covers] ${message}` });
    }
}

function extension(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot).toLowerCase();
}
/** Numeric-aware chapter ordering: parsed number first (unparsable last), then natural compare. */
function byChapterNumber(a: string, b: string): number {
    return (parseChapterNumber(a) ?? Number.MAX_SAFE_INTEGER) - (parseChapterNumber(b) ?? Number.MAX_SAFE_INTEGER) || naturalCompare(a, b);
}
