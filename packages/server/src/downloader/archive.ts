/**
 * Chapter archive handling: CBZ finalization (ComicInfo.xml + integrity
 * check) and the in-memory-budget spill that falls a giant chapter back to
 * the img-folder layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createComicInfoXML } from '@tanko/core';
import JSZip from 'jszip';
import type { EventBus } from '../ws.js';
import type { ChapterPaths } from './paths.js';

/** Past this in-memory zip size, the chapter falls back to the img-folder
 *  layout: giant chapters (artbooks) must not double their RAM footprint. */
export const CBZ_MEMORY_GUARD_BYTES = 200 * 1024 * 1024;

/** Memory guard tripped: write every buffered zip entry to the img directory
 *  and drop the archive; the rest of the chapter lands on disk directly. */
export async function spillArchiveToDirectory(events: EventBus, zip: JSZip, paths: ChapterPaths, jobId: number): Promise<void> {
    events.publishLog({
        level: 'warn',
        category: 'system',
        code: 'system.cbzBudget',
        params: { jobId },
        message: `Chapter exceeds the in-memory CBZ budget — saved as an image folder instead (job #${jobId})`
    });
    fs.mkdirSync(paths.directory, { recursive: true });
    for (const file of Object.values(zip.files)) {
        if (!file.dir) {
            fs.writeFileSync(path.join(paths.directory, file.name), await file.async('nodebuffer'));
        }
    }
}

/** Write the CBZ archive (ComicInfo.xml + downloaded pages) to disk. */
export async function finalizeCbz(zip: JSZip, paths: ChapterPaths, mangaTitle: string, chapterTitle: string, pageCount: number): Promise<void> {
    zip.file('ComicInfo.xml', createComicInfoXML(mangaTitle, chapterTitle, pageCount));
    fs.mkdirSync(path.dirname(paths.cbzFile), { recursive: true });
    const buffer = await zip.generateAsync({ compression: 'STORE', type: 'nodebuffer' });
    fs.writeFileSync(paths.cbzFile, buffer);
    // integrity check: the archive must re-open and hold every page. A
    // corrupt file is removed so a later run retries instead of treating
    // it as "already downloaded".
    try {
        const reread = await JSZip.loadAsync(fs.readFileSync(paths.cbzFile));
        const entries = Object.values(reread.files).filter(file => !file.dir && file.name !== 'ComicInfo.xml');
        if (entries.length !== pageCount) {
            throw new Error(`archive incohérente : ${entries.length}/${pageCount} pages`);
        }
    } catch (error) {
        try {
            fs.unlinkSync(paths.cbzFile);
        } catch {
            /* already gone */
        }
        throw new Error(`CBZ invalide après écriture : ${(error as Error).message}`);
    }
}
