import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chapterFileNames, chapterPaths, detectMime, outputExists, pageFileName, sanitizeName } from '../src/downloader/paths.js';

describe('sanitizeName', () => {
    it('strips control characters', () => {
        expect(sanitizeName('a\u0000b\u001Fc')).toBe('abc');
    });

    it('strips slashes on linux', () => {
        if (process.platform === 'linux') {
            expect(sanitizeName('vol/01')).toBe('vol01');
        }
    });

    it('trims trailing dots and spaces', () => {
        expect(sanitizeName('chapter 12. ')).toBe('chapter 12');
    });

    it('falls back to untitled for empty result', () => {
        expect(sanitizeName('///')).toBe('untitled');
    });
});

describe('chapterPaths', () => {
    it('builds the hakuneko-compatible layout', () => {
        const paths = chapterPaths('/base', 'MangaDex', 'One Piece', 'Ch.01');
        expect(paths.directory).toBe(path.join('/base', 'MangaDex', 'One Piece', 'Chapter 01'));
        expect(paths.cbzFile).toBe(path.join('/base', 'MangaDex', 'One Piece', 'Chapter 01.cbz'));
    });

    it('builds the flat series layout when requested', () => {
        const paths = chapterPaths('/base', 'MangaDex', 'One Piece', 'Ch.12', 'series');
        expect(paths.cbzFile).toBe(path.join('/base', 'One Piece', 'Chapter 12.cbz'));
    });

    it('accepts a series folder spelled with the other apostrophe', () => {
        // sources title with a typographic apostrophe, the NAS folder is ASCII — and vice versa
        for (const [folderTitle, entryTitle] of [
            ["Can't Level Up", 'Can’t Level Up'],
            ['Can’t Level Up', "Can't Level Up"]
        ] as const) {
            const base = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-paths-'));
            try {
                const folder = path.join(base, folderTitle);
                fs.mkdirSync(folder, { recursive: true });
                const paths = chapterPaths(base, 'MangaDex', entryTitle, 'Ch.1', 'series');
                expect(paths.cbzFile.startsWith(folder)).toBe(true);
            } finally {
                fs.rmSync(base, { recursive: true, force: true });
            }
        }
    });

    it('accepts a series folder differing only by case or punctuation', () => {
        // the disk folder predates the source title spelling (« Into the Light, Once Again » on Tapas)
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-paths-'));
        try {
            const folder = path.join(base, 'Into the light once again');
            fs.mkdirSync(folder, { recursive: true });
            const paths = chapterPaths(base, 'Tapas', 'Into the Light, Once Again', 'Ch.1', 'series');
            expect(paths.cbzFile.startsWith(folder)).toBe(true);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('does not fuzzy-match a different series folder', () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-paths-'));
        try {
            fs.mkdirSync(path.join(base, 'Other Series'), { recursive: true });
            const paths = chapterPaths(base, 'Tapas', 'Into the Light, Once Again', 'Ch.1', 'series');
            expect(paths.cbzFile.startsWith(path.join(base, 'Other Series'))).toBe(false);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});

describe('chapterFileNames', () => {
    it('accepts normalized, short and raw spellings of the same chapter', () => {
        const names = chapterFileNames(' Ch.2 - Let Her Go!');
        expect(names[0]).toBe('Chapter 2 - Let Her Go!');
        expect(names).toContain('Chapter 2');
        expect(names).toContain('Ch.2 - Let Her Go!');
    });

    it('keeps a bare number unique, plus its raw spelling', () => {
        expect(chapterFileNames('Chapter 7')).toEqual(['Chapter 7', 'Ch.7']);
    });

    it('accepts the unpadded spelling of a zero-padded number', () => {
        // MangaHere says « Ch.001 », the library on disk has « Chapter 1.cbz »
        const names = chapterFileNames('Ch.001');
        expect(names).toContain('Chapter 1');
        expect(names).toContain('Ch.1');
    });
});

describe('pageFileName', () => {
    it('pads with zeroes and maps mime to extension', () => {
        expect(pageFileName(1, 'image/jpeg', 3)).toBe('001.jpg');
        expect(pageFileName(12, 'image/webp', 3)).toBe('012.webp');
        expect(pageFileName(3, 'image/png', 2)).toBe('03.png');
        expect(pageFileName(4, 'application/octet-stream', 2)).toBe('04.bin');
    });
});

describe('detectMime', () => {
    it('detects jpeg from magic bytes', () => {
        expect(detectMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/')).toBe('image/jpeg');
    });

    it('detects png from magic bytes', () => {
        expect(detectMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/')).toBe('image/png');
    });

    it('detects webp from magic bytes', () => {
        const data = new Uint8Array(12);
        data.set([0x52, 0x49, 0x46, 0x46], 0);
        data.set([0x57, 0x45, 0x42, 0x50], 8);
        expect(detectMime(data, 'image/jpeg')).toBe('image/webp');
    });

    it('falls back to the given mime', () => {
        expect(detectMime(new Uint8Array([1, 2, 3]), 'image/gif')).toBe('image/gif');
    });
});

describe('outputExists', () => {
    it('treats a partially downloaded img chapter as missing', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-paths-'));
        try {
            const paths = chapterPaths(base, 'Src', 'Serie', 'Ch.1');
            fs.mkdirSync(paths.directory, { recursive: true });
            fs.writeFileSync(path.join(paths.directory, '001.jpg'), 'x');
            fs.writeFileSync(path.join(paths.directory, '002.jpg'), 'x');
            expect(outputExists(paths, 'img')).toBe(true); // legacy behavior: non-empty
            expect(outputExists(paths, 'img', 2)).toBe(true); // complete
            expect(outputExists(paths, 'img', 30)).toBe(false); // interrupted at 2/30
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('prefers a v2 file when both versions of a chapter exist', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-paths-'));
        try {
            const seriesDir = path.join(base, 'Src', 'Serie');
            fs.mkdirSync(seriesDir, { recursive: true });
            fs.writeFileSync(path.join(seriesDir, 'Serie - Ch.161.cbz'), 'old');
            fs.writeFileSync(path.join(seriesDir, 'Serie - Ch.161 v2.cbz'), 'fixed');
            const paths = chapterPaths(base, 'Src', 'Serie', 'Ch.161');
            expect(paths.existing).toBe(path.join(seriesDir, 'Serie - Ch.161 v2.cbz'));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('matches decimal chapters across comma and dot spellings', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-paths-'));
        try {
            const seriesDir = path.join(base, 'Src', 'Serie');
            fs.mkdirSync(seriesDir, { recursive: true });
            fs.writeFileSync(path.join(seriesDir, 'Serie - Ch.0,5.cbz'), 'x');
            const paths = chapterPaths(base, 'Src', 'Serie', 'Ch.0.5');
            expect(paths.existing).toBe(path.join(seriesDir, 'Serie - Ch.0,5.cbz'));
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });

    it('detects a HakuNeko-style « <manga> - <chapter> » CBZ as an existing output', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-paths-'));
        try {
            const seriesDir = path.join(base, 'Src', 'The Legendary Moonlight Sculptor');
            fs.mkdirSync(seriesDir, { recursive: true });
            fs.writeFileSync(path.join(seriesDir, 'The Legendary Moonlight Sculptor - Ch.161.cbz'), 'x');
            const paths = chapterPaths(base, 'Src', 'The Legendary Moonlight Sculptor', 'Ch.161');
            expect(paths.existing).toBe(path.join(seriesDir, 'The Legendary Moonlight Sculptor - Ch.161.cbz'));
            expect(outputExists(paths, 'cbz')).toBe(true);
        } finally {
            fs.rmSync(base, { recursive: true, force: true });
        }
    });
});
