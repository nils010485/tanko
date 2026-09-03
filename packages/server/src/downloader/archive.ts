/**
 * Chapter archive handling: CBZ finalization (ComicInfo.xml + integrity
 * check) and the in-memory-budget spill that falls a giant chapter back to
 * the img-folder layout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createComicInfoXML } from '@tanko/core';
import type JSZip from 'jszip';
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
    // integrity check: the archive must hold every page. A corrupt file is
    // removed so a later run retries instead of treating it as "already
    // downloaded". Only the zip central directory is read back — re-opening
    // the whole file would copy it into RAM a third time.
    try {
        const entries = countZipEntries(paths.cbzFile, 'ComicInfo.xml');
        if (entries !== pageCount) {
            throw new Error(`archive incohérente : ${entries}/${pageCount} pages`);
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

/** Count a zip's file entries by reading its central directory directly
 *  (EOCD at the tail, then the directory chunk itself): a few KB read
 *  instead of the whole archive. Any structural surprise throws — the
 *  caller treats that as a corrupt file. */
export function countZipEntries(file: string, ...exclude: string[]): number {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const { entryCount, directoryOffset, directorySize } = locateZipCentralDirectory(fd, size);
        if (directoryOffset + directorySize > size) {
            throw new Error('central directory hors fichier');
        }
        const directory = Buffer.alloc(directorySize);
        fs.readSync(fd, directory, 0, directorySize, directoryOffset);
        // walk the entry headers: signature, name/extra/comment lengths
        let count = 0;
        let seen = 0;
        let pos = 0;
        while (pos + 46 <= directorySize) {
            if (directory.readUInt32LE(pos) !== 0x02014b50) {
                throw new Error('central directory corrompu');
            }
            const nameLength = directory.readUInt16LE(pos + 28);
            const name = directory.toString('utf8', pos + 46, pos + 46 + nameLength);
            if (!name.endsWith('/') && !exclude.includes(name)) {
                count++;
            }
            seen++;
            pos += 46 + nameLength + directory.readUInt16LE(pos + 30) + directory.readUInt16LE(pos + 32);
        }
        if (seen !== entryCount) {
            throw new Error(`central directory incohérent : ${seen}/${entryCount} entrées`);
        }
        return count;
    } finally {
        fs.closeSync(fd);
    }
}

/** Find the End-Of-Central-Directory record in the file's tail: its comment
 *  length must land exactly on the end of the file. */
function locateZipCentralDirectory(fd: number, size: number): { entryCount: number; directoryOffset: number; directorySize: number } {
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    for (let pos = tailLength - 22; pos >= 0; pos--) {
        if (tail.readUInt32LE(pos) === 0x06054b50 && tail.readUInt16LE(pos + 20) === tailLength - pos - 22) {
            return {
                entryCount: tail.readUInt16LE(pos + 10),
                directoryOffset: tail.readUInt32LE(pos + 16),
                directorySize: tail.readUInt32LE(pos + 12)
            };
        }
    }
    throw new Error('enregistrement EOCD introuvable');
}
