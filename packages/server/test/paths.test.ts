import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { chapterFileNames, chapterPaths, detectMime, pageFileName, sanitizeName } from '../src/downloader/paths.js';

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
});

describe('chapterFileNames', () => {
    it('accepts normalized, short and raw spellings of the same chapter', () => {
        const names = chapterFileNames(' Ch.2 - Let Her Go!');
        expect(names[0]).toBe('Chapter 2 - Let Her Go!');
        expect(names).toContain('Chapter 2');
        expect(names).toContain('Ch.2 - Let Her Go!');
    });

    it('keeps a bare number unique', () => {
        const names = chapterFileNames('Chapter 7');
        expect(names).toEqual(['Chapter 7']);
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
        expect(detectMime(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]), 'image/')).toBe('image/jpeg');
    });

    it('detects png from magic bytes', () => {
        expect(detectMime(new Uint8Array([0x89, 0x50, 0x4E, 0x47]), 'image/')).toBe('image/png');
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
