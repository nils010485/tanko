/**
 * Path & naming helpers — keep the same on-disk layout as Hakuneko:
 *   <base>/<Source label>/<Manga title>/<Chapter title>/{01.jpg,...}   (folder)
 *   <base>/<Source label>/<Manga title>/<Chapter title>.cbz            (cbz)
 * With directoryLayout 'series', the source level is dropped so downloads
 * complete an existing flat library:
 *   <base>/<Manga title>/<Chapter title>.cbz
 */
import fs from 'node:fs';
import path from 'node:path';

export function sanitizeName(name: string): string {
    let result = String(name).replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
    if (process.platform.startsWith('win')) {
        result = result.replace(/[\\/:*?"<>|]/g, '');
    } else if (process.platform.startsWith('darwin')) {
        result = result.replace(/[/:]/g, '');
    } else {
        result = result.replace(/[/]/g, '');
    }
    return result.replace(/[.\s]+$/g, '').trim() || 'untitled';
}

export interface ChapterPaths {
    /** Directory for 'folder' format (also the parent of the .cbz file). */
    directory: string;
    /** Target file for 'cbz' format. */
    cbzFile: string;
    /** Already-present output for this chapter under an accepted naming variant
     *  (e.g. « Chapter 2.cbz » for « Chapter 2 - Let Her Go!.cbz »). */
    existing?: string;
}

export type DirectoryLayout = 'source' | 'series';

/**
 * Normalize a source chapter title to the conventional file name:
 * ' Ch.107' / 'Ch 12' -> 'Chapter 107' / 'Chapter 12' ('Chapter 12' unchanged).
 */
export function normalizeChapterTitle(title: string): string {
    return title.trim().replace(/^ch[\s.]*(?=\d)/i, 'Chapter ');
}

/**
 * Accepted file names for one chapter: the (normalized) full title, plus the
 * short « Chapter <number> » form — sources suffix chapter names with titles
 * (« Ch.2 - Let Her Go! ») while an existing library usually stores the bare
 * number, and both spellings mean the same chapter on disk.
 */
export function chapterFileNames(chapterTitle: string): string[] {
    const normalized = sanitizeName(normalizeChapterTitle(chapterTitle));
    const names = [normalized];
    // legacy spelling straight from the source (« Ch.01 »), for files written
    // before the normalization landed — without it they'd look missing
    const raw = sanitizeName(chapterTitle.trim());
    if (raw && raw !== normalized && !names.includes(raw)) {
        names.push(raw);
    }
    const match = normalized.match(/^Chapter\s+(\d+(?:\.\d+)?)/i) || normalized.match(/^(\d+(?:\.\d+)?)/);
    if (match) {
        const number = match[1]!;
        // padded and unpadded spellings: a library written by another tool
        // may use « Chapter 1 » where the source says « Ch.001 »
        const variants = [`Chapter ${number}`, `Chapter ${Number(number)}`, `Ch.${number}`, `Ch.${Number(number)}`];
        for (const variant of variants) {
            if (variant !== normalized && !names.includes(variant)) {
                names.push(variant);
            }
        }
    }
    return names;
}

export function chapterPaths(baseDirectory: string, sourceLabel: string, mangaTitle: string, chapterTitle: string, layout: DirectoryLayout = 'source'): ChapterPaths {
    const seriesDir = layout === 'series'
        ? path.join(baseDirectory, sanitizeName(mangaTitle))
        : path.join(baseDirectory, sanitizeName(sourceLabel), sanitizeName(mangaTitle));
    const names = chapterFileNames(chapterTitle);
    const chapterName = names[0]!;
    let existing: string | undefined;
    for (const name of names) {
        if (fs.existsSync(path.join(seriesDir, name + '.cbz'))) {
            existing = path.join(seriesDir, name + '.cbz');
            break;
        }
        if (fs.existsSync(path.join(seriesDir, name)) && fs.readdirSync(path.join(seriesDir, name)).some(entry => !entry.startsWith('.'))) {
            existing = path.join(seriesDir, name);
            break;
        }
    }
    return {
        directory: path.join(seriesDir, chapterName),
        cbzFile: path.join(seriesDir, chapterName + '.cbz'),
        existing
    };
}

/** mime sniff → file extension, most specific first ('image/' is the catch-all). */
const MIME_EXTENSIONS: Array<[string, string]> = [
    ['image/webp', '.webp'],
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/gif', '.gif'],
    ['image/bmp', '.bmp'],
    ['image/avif', '.avif'],
    ['image/', '.img']
];

export function pageFileName(index: number, mimeType: string, leadingZeroes: number): string {
    const fileName = String(index).padStart(leadingZeroes, '0');
    const extension = MIME_EXTENSIONS.find(([mime]) => Boolean(mimeType) && mimeType.indexOf(mime) > -1);
    return fileName + (extension ? extension[1] : '.bin');
}

interface MimeSignature {
    mime: string;
    /** Offset of the signature inside the file. */
    offset: number;
    /** The data must be longer than this many bytes (mirrors the legacy checks). */
    minLength: number;
    bytes: number[];
}

/** Magic-byte signatures, in detection order (first match wins). */
const SIGNATURES: MimeSignature[] = [
    { mime: 'image/webp', offset: 8, minLength: 11, bytes: [0x57, 0x45, 0x42, 0x50] },                                     // WEBP
    { mime: 'image/jpeg', offset: 0, minLength: 3, bytes: [0xFF, 0xD8, 0xFF] },
    { mime: 'image/png', offset: 1, minLength: 3, bytes: [0x50, 0x4E, 0x47] },                                             // PNG
    { mime: 'image/gif', offset: 0, minLength: 3, bytes: [0x47, 0x49, 0x46] },                                             // GIF
    { mime: 'image/bmp', offset: 0, minLength: 2, bytes: [0x42, 0x4D] },                                                   // BM
    { mime: 'image/avif', offset: 4, minLength: 12, bytes: [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66] }              // ftypavif
];

/** Detect the real mime type from the file signature (like legacy Storage._applyRealMime). */
export function detectMime(data: Uint8Array, fallback: string): string {
    for (const signature of SIGNATURES) {
        const matches = data.length > signature.minLength
            && signature.bytes.every((byte, index) => data[signature.offset + index] === byte);
        if (matches) {
            return signature.mime;
        }
    }
    return fallback || 'application/octet-stream';
}

/** True when a chapter output already exists on disk under any accepted name. */
export function outputExists(paths: ChapterPaths, format: 'img' | 'cbz'): boolean {
    if (paths.existing) {
        return true;
    }
    if (format === 'cbz') {
        return fs.existsSync(paths.cbzFile);
    }
    try {
        return fs.readdirSync(paths.directory).some(entry => !entry.startsWith('.'));
    } catch {
        return false;
    }
}
/**
 * Chapter entries of a series folder on disk: CBZ files plus image-folder
 * chapters (sub-directories), dot-files excluded. Empty when the folder is
 * missing. Purely local — no source involved.
 */
export function listChapterEntries(seriesDirectory: string): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(seriesDirectory, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => !entry.name.startsWith('.')
            && ((entry.isFile() && entry.name.toLowerCase().endsWith('.cbz')) || entry.isDirectory()))
        .map(entry => entry.name);
}

/**
 * Chapter count of a series folder on disk — used to display counts for
 * entries whose chapters were never registered in the database.
 */
export function countLocalChapters(seriesDirectory: string): number {
    return listChapterEntries(seriesDirectory).length;
}
