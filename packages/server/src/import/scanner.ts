/**
 * Existing-library scanner: recursively walks a data folder, finds CBZ
 * archives (or image folders), groups them into series and extracts chapter
 * numbers from the many naming variants (001.cbz, ch 001.cbz, chapter-12.cbz,
 * 12 - Title.cbz, Vol.1 Ch.5.cbz, ...).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ScannedChapter {
    file: string;
    /** Parsed chapter number (null when no number could be extracted). */
    number: number | null;
}

export interface ScannedSeries {
    name: string;
    path: string;
    chapterCount: number;
    chapters: ScannedChapter[];
    /** Title hint from an optional series.json metadata file (Kavita-style). */
    metaName?: string;
}

export interface ScanResult {
    root: string;
    series: ScannedSeries[];
    totalChapters: number;
    truncated: boolean;
}

export interface ScanOptions {
    maxDepth?: number;
    maxSeries?: number;
    maxChaptersPerSeries?: number;
    maxVisitedDirs?: number;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

/** Also match frequent misspellings of the chapter marker. */
const CHAPTER_MARKER = '(?:ch(?:apter|aopter|apoter|apte|ap)?|épisode|episode)';

/** Pre-built marker pattern: "ch 001", "chapter-12", "episode 3" (+ typos "chaopter", "chapte"). */
const CHAPTER_NUMBER_PATTERN = new RegExp(`\\b${CHAPTER_MARKER}\\b[\\s._#-]*(\\d+(?:[.,]\\d+)?)`, 'i');

/** Extract a chapter number from a filename or chapter title. */
export function parseChapterNumber(text: string): number | null {
    const cleaned = text.replace(/_/g, ' ');
    // 1) explicit chapter marker: "ch 001", "chapter-12", "chap. 5", "episode 3" (+ typos "chaopter", "chapte")
    const chapterMatch = cleaned.match(CHAPTER_NUMBER_PATTERN);
    if (chapterMatch) {
        return normalizeNumber(chapterMatch[1]);
    }
    // 2) first number that is not a volume marker: "001.cbz", "12 - Title", "Solo Leveling 127"
    const volumeStripped = cleaned.replace(/\bvol(?:ume)?[\s._-]*\d+(?:[.,]\d+)?/gi, '');
    const plainMatch = volumeStripped.match(/(\d+(?:[.,]\d+)?)/);
    if (plainMatch) {
        return normalizeNumber(plainMatch[1]);
    }
    return null;
}

function normalizeNumber(raw: string): number | null {
    const value = Number.parseFloat(raw.replace(',', '.'));
    return Number.isFinite(value) ? value : null;
}

/** Best-effort title hint from a Kavita-style series.json ({"metadata":{"name": ...}}). */
function readMetaName(seriesDir: string): string | undefined {
    try {
        const raw = fs.readFileSync(path.join(seriesDir, 'series.json'), 'utf8');
        const name = JSON.parse(raw)?.metadata?.name;
        return typeof name === 'string' && name.trim() ? name.trim() : undefined;
    } catch {
        return undefined;
    }
}

/** Resolve a directory path and validate it (same guard/error message for scan + import). */
export function assertValidDirectory(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Chemin invalide : ${inputPath}`);
    }
    return resolved;
}

/** Recursively scan a directory and group chapters into series. */
export function scanLibrary(rootPath: string, options: ScanOptions = {}): ScanResult {
    const maxDepth = options.maxDepth ?? 8;
    const maxSeries = options.maxSeries ?? 5000;
    const maxChaptersPerSeries = options.maxChaptersPerSeries ?? 20000;
    const maxVisitedDirs = options.maxVisitedDirs ?? 100000;
    const root = assertValidDirectory(rootPath);

    const seriesMap = new Map<string, ScannedSeries>();
    let truncated = false;
    let visited = 0;

    const addChapter = (seriesDir: string, file: string) => {
        let series = seriesMap.get(seriesDir);
        if (!series) {
            if (seriesMap.size >= maxSeries) {
                truncated = true;
                return;
            }
            series = {
                name: path.basename(seriesDir) || root,
                path: seriesDir,
                chapterCount: 0,
                chapters: [],
                metaName: readMetaName(seriesDir)
            };
            seriesMap.set(seriesDir, series);
        }
        if (series.chapters.length >= maxChaptersPerSeries) {
            truncated = true;
            return;
        }
        series.chapters.push({ file, number: parseChapterNumber(file) });
        series.chapterCount++;
    };

    /** Returns true when the directory looks like a chapter folder (mostly images). */
    const isImageChapterFolder = (entries: fs.Dirent[], dir: string): boolean => {
        const isImage = (file: string) => IMAGE_EXTENSIONS.has(path.extname(file).toLowerCase());
        const files = entries.filter(entry => entry.isFile());
        if (files.length === 0) {
            return false;
        }
        const images = files.filter(entry => isImage(entry.name));
        return images.length / files.length >= 0.7 && images.length >= 2;
    };
    const walk = (dir: string, depth: number) => {
        if (depth > maxDepth) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        visited++;
        if (visited > maxVisitedDirs) {
            truncated = true;
            return;
        }

        const visible = entries.filter(entry => !entry.name.startsWith('.'));
        const cbzFiles = visible.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.cbz'));

        // a folder of images is itself a chapter -> the parent directory is the series
        if (cbzFiles.length === 0 && depth > 0 && isImageChapterFolder(visible, dir)) {
            addChapter(path.dirname(dir), path.basename(dir));
            return; // do not recurse into chapter folders
        }

        for (const entry of cbzFiles) {
            addChapter(dir, entry.name);
        }
        for (const entry of visible) {
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), depth + 1);
            }
        }
    };

    walk(root, 0);

    // chapters found directly at the root -> group them under the root name
    const series = [...seriesMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    const totalChapters = series.reduce((sum, item) => sum + item.chapterCount, 0);
    return { root, series, totalChapters, truncated };
}
