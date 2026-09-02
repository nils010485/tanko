/**
 * Canonical series directories: every library entry owns a stable folder,
 * stored relative to the data directory and allocated once at add time. The
 * stored path survives source migrations (the failover rewrites title and
 * source in place) and layout changes — the layout only decides where NEW
 * entries are allocated, never where existing files are expected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type DirectoryLayout, directoryKey, sanitizeName } from '../downloader/paths.js';
import type { StoreContext } from './context.js';
import { seriesDirectory } from './context.js';
import type { EntryRow } from './rows.js';

/** Whether a library entry already owns this relative directory. */
function directoryTaken(ctx: StoreContext, rel: string): boolean {
    return Boolean(ctx.q.get('SELECT id FROM library WHERE directory = ? LIMIT 1', rel));
}

/** Relative ('/'-separated) form of `directory` when it lies inside the data
 *  directory, null otherwise (outside the library, or the base itself). */
export function relativeOrNull(dataDirectory: string, directory: string): string | null {
    const rel = path.relative(path.resolve(dataDirectory), path.resolve(directory));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return null;
    }
    return rel.split(path.sep).join('/');
}

/** Sub-directories of a parent folder (missing parent = nothing to adopt). */
function subDirectories(base: string, parent: string[]): string[] {
    try {
        return fs
            .readdirSync(path.join(base, ...parent), { withFileTypes: true })
            .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
            .map(entry => entry.name);
    } catch {
        return [];
    }
}

/**
 * Allocate the series directory of a NEW entry: the layout-derived candidate,
 * suffixed « (2) », « (3) »… while another entry owns it, adopting an on-disk
 * folder that names the same series with a different spelling (typographic
 * apostrophe, case, punctuation) so downloads complete it instead of creating
 * a sibling. The suffix is numeric on purpose: source labels and team names
 * change, a rank does not.
 */
export function allocateDirectory(ctx: StoreContext, opts: { title: string; sourceLabel: string; layout: DirectoryLayout }): string {
    const base = ctx.queueSettings.dataDirectory;
    const leaf = sanitizeName(opts.title);
    const parent = opts.layout === 'series' ? [] : [sanitizeName(opts.sourceLabel)];
    const rel = (name: string): string => [...parent, name].join('/');
    const siblings = subDirectories(base, parent);
    for (let rank = 1; rank <= 99; rank++) {
        const name = rank === 1 ? leaf : `${leaf} (${rank})`;
        if (directoryTaken(ctx, rel(name))) {
            continue;
        }
        const match = siblings.find(sibling => directoryKey(sibling) === directoryKey(name));
        if (match) {
            // adopt the on-disk spelling unless it belongs to another entry
            if (!directoryTaken(ctx, rel(match))) {
                return rel(match);
            }
            continue;
        }
        return rel(name);
    }
    throw new Error(`Could not allocate a series directory for "${opts.title}"`);
}

/** Whether the entry has downloaded chapter files recorded under `rel`. */
function hasRecordedPaths(ctx: StoreContext, entryId: number, rel: string): boolean {
    const base = ctx.queueSettings.dataDirectory;
    const rows = ctx.q.all<{ path: string }>('SELECT path FROM library_chapters WHERE entry_id = ? AND path IS NOT NULL AND length(path) > 0', entryId);
    return rows.some(row => relativeOrNull(base, path.dirname(row.path)) === rel);
}

/**
 * Backfill (idempotent): give every legacy row its canonical directory — the
 * folder its downloaded chapters actually live in, or a fresh allocation when
 * nothing pins it there. Entries sharing a folder they both have files in
 * keep sharing it (recorded reality wins); an entry with no files in a folder
 * owned by someone else gets its own.
 */
export function backfillDirectories(ctx: StoreContext): number {
    const base = ctx.queueSettings.dataDirectory;
    // entries with recorded files pin their folder first: an empty same-titled
    // legacy entry then sees the folder taken and gets its own suffix instead
    // of silently sharing the other's
    const rows = ctx.q.all<EntryRow & { directory: string | null }>(
        `SELECT * FROM library WHERE directory IS NULL
         ORDER BY (SELECT COUNT(*) FROM library_chapters WHERE library_chapters.entry_id = library.id AND path IS NOT NULL) DESC, id ASC`
    );
    const allocate = (row: EntryRow): string =>
        allocateDirectory(ctx, { title: row.title, sourceLabel: row.source_label, layout: ctx.queueSettings.directoryLayout });
    let updated = 0;
    for (const row of rows) {
        const resolved = seriesDirectory(ctx, row.id, row);
        let rel = resolved ? relativeOrNull(base, resolved) : null;
        if (!rel || (directoryTaken(ctx, rel) && !hasRecordedPaths(ctx, row.id, rel))) {
            rel = allocate(row);
        }
        ctx.db.db.prepare('UPDATE library SET directory = ? WHERE id = ?').run(rel, row.id);
        updated++;
    }
    return updated;
}
