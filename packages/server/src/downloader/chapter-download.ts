/**
 * Chapter page download loop: every page to the output folder (or in-memory
 * zip), with cancel/pause checks, the chapter deadline, signed-URL refresh
 * recovery and the CBZ memory spill. Extracted from DownloadQueue so the
 * queue class only orchestrates (claim, schedule, persist).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SourceAdapter } from '@tanko/core';
import type JSZip from 'jszip';
import type { EventBus } from '../ws.js';
import { CBZ_MEMORY_GUARD_BYTES, spillArchiveToDirectory } from './archive.js';
import { fetchPageWithRetries, getPageListWithRetries, PAGE_LIST_REFRESHES } from './pages.js';
import { type ChapterPaths, pageFileName } from './paths.js';
import type { JobRow } from './queue.js';
import type { DomainGate } from './rate-limiter.js';

/** Hard budget for one chapter's pages (excludes paused time). */
const CHAPTER_DEADLINE_MS = 20 * 60 * 1000;

/** Everything the loop needs from the queue — explicit, so the download
 *  logic stays testable and free of queue invariants. */
export interface ChapterDownloadContext {
    events: EventBus;
    gate: DomainGate;
    /** throws Error('cancelled') — the tested abort contract */
    checkCancel: (jobId: number) => void;
    waitWhilePaused: () => Promise<void>;
    update: (jobId: number, patch: Partial<Pick<JobRow, 'status' | 'progress' | 'pages_total' | 'pages_done' | 'error' | 'path'>>) => void;
}

/**
 * Download every page to the output folder (or in-memory zip), publishing progress.
 * Returns the mode actually used: a CBZ chapter whose pages outgrow the
 * memory guard is flushed to the img directory mid-flight and stays 'img'.
 * Pages served through signed URLs that expire mid-chapter are recovered
 * by refreshing the page list (fresh URLs) and retrying the same index.
 */
export async function downloadChapterPages(
    row: JobRow,
    pages: string[],
    source: SourceAdapter,
    paths: ChapterPaths,
    zip: JSZip | undefined,
    ctx: ChapterDownloadContext
): Promise<{ mode: 'cbz' | 'img'; pageCount: number }> {
    let leadingZeroes = String(pages.length).length;
    const startedAt = Date.now();
    let pausedMs = 0;
    let archive = zip;
    let archiveBytes = 0;
    let refreshesLeft = PAGE_LIST_REFRESHES;
    for (let index = 0; index < pages.length; index++) {
        ctx.checkCancel(row.id);
        const pauseStart = Date.now();
        await ctx.waitWhilePaused();
        pausedMs += Date.now() - pauseStart;
        ctx.checkCancel(row.id);
        if (Date.now() - startedAt - pausedMs > CHAPTER_DEADLINE_MS) {
            throw new Error(`chapter download timed out after ${Math.round(CHAPTER_DEADLINE_MS / 60000)}min (${index}/${pages.length} pages)`);
        }

        let page: { mime: string; data: Uint8Array };
        try {
            page = await fetchPageWithRetries(pages[index], source, ctx.gate);
        } catch (error) {
            // Signed image URLs (connector:// payloads carrying ?acc=…&expires=…)
            // go stale while the chapter downloads: the CDN then answers with a
            // tiny HTML error page that retrying the same URL can never fix.
            // Refresh the page list for a fresh set of URLs and retry once.
            if (refreshesLeft <= 0) {
                throw error;
            }
            refreshesLeft--;
            let fresh: string[];
            try {
                fresh = await getPageListWithRetries(source, row, () => ctx.checkCancel(row.id));
            } catch (refreshError) {
                if ((refreshError as Error)?.message === 'cancelled') {
                    throw refreshError;
                }
                throw new Error(`${(error as Error).message} (page-list refresh failed: ${(refreshError as Error).message})`);
            }
            if (index >= fresh.length) {
                throw error; // the chapter shrank server-side: don't guess a mapping
            }
            if (fresh.length !== pages.length) {
                ctx.update(row.id, { pages_total: fresh.length });
            }
            pages = fresh;
            // the refreshed list may be longer: keep zero-padding in step
            leadingZeroes = String(pages.length).length;
            page = await fetchPageWithRetries(pages[index], source, ctx.gate);
        }
        const { mime, data } = page;
        const fileName = pageFileName(index + 1, mime, leadingZeroes);
        if (archive) {
            archiveBytes += data.length;
            if (archiveBytes > CBZ_MEMORY_GUARD_BYTES) {
                await spillArchiveToDirectory(ctx.events, archive, paths, row.id);
                archive = undefined;
            }
        }
        if (archive) {
            archive.file(fileName, Buffer.from(data));
        } else {
            fs.writeFileSync(path.join(paths.directory, fileName), Buffer.from(data));
        }

        ctx.update(row.id, {
            pages_done: index + 1,
            progress: Math.round(((index + 1) / pages.length) * 100)
        });
    }
    return { mode: archive ? 'cbz' : 'img', pageCount: pages.length };
}
