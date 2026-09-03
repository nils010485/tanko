/**
 * Tests for CBZ finalization: the written archive must pass the integrity
 * check (central-directory read-back instead of a full re-open), and corrupt
 * output must be detected and deleted so a later run retries.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countZipEntries, finalizeCbz } from '../src/downloader/archive.js';

let tmpDir: string;

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-archive-'));
});
afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeZip(name: string, pages: number): Promise<string> {
    const zip = new JSZip();
    for (let i = 1; i <= pages; i++) {
        zip.file(`page_${String(i).padStart(3, '0')}.jpg`, Buffer.alloc(2048, i));
    }
    // JSZip keeps everything in memory: fine at this size
    const file = path.join(tmpDir, `${name}.cbz`);
    fs.writeFileSync(file, Buffer.from(await zip.generateAsync({ compression: 'STORE', type: 'arraybuffer' })));
    return file;
}

const pathsFor = (file: string) => ({ directory: path.dirname(file), cbzFile: file });

describe('countZipEntries', () => {
    it('counts file entries and excludes the given names', async () => {
        const file = await writeZip('count', 4);
        expect(countZipEntries(file)).toBe(4);
        expect(countZipEntries(file, 'page_001.jpg')).toBe(3);
    });

    it('ignores directory entries', async () => {
        const zip = new JSZip();
        zip.file('a.jpg', 'x');
        zip.folder('sub');
        const file = path.join(tmpDir, 'dirs.cbz');
        fs.writeFileSync(file, Buffer.from(await zip.generateAsync({ type: 'arraybuffer' })));
        expect(countZipEntries(file)).toBe(1);
    });

    it('throws on a truncated archive (EOCD gone)', async () => {
        const file = await writeZip('trunc', 5);
        const full = fs.readFileSync(file);
        fs.writeFileSync(file, full.subarray(0, full.length - 512));
        expect(() => countZipEntries(file)).toThrow(/EOCD/);
    });

    it('throws on a corrupted central directory', async () => {
        const file = await writeZip('corrupt', 5);
        const full = fs.readFileSync(file);
        // garbage over the directory region (just before the EOCD tail)
        fs.writeFileSync(file, Buffer.concat([full.subarray(0, full.length - 128), Buffer.alloc(106, 0xff), full.subarray(full.length - 22)]));
        expect(() => countZipEntries(file)).toThrow(/corrompu|incohérent|EOCD/);
    });

    it('throws on an empty file', () => {
        const file = path.join(tmpDir, 'empty.cbz');
        fs.writeFileSync(file, Buffer.alloc(0));
        expect(() => countZipEntries(file)).toThrow(/EOCD/);
    });
});

describe('finalizeCbz', () => {
    it('writes a valid archive an independent zip reader accepts', async () => {
        const zip = new JSZip();
        for (let i = 1; i <= 3; i++) {
            zip.file(`page_${String(i).padStart(3, '0')}.jpg`, Buffer.alloc(2048, i));
        }
        const paths = pathsFor(path.join(tmpDir, 'ok', 'ok.cbz'));
        await finalizeCbz(zip, paths, 'Manga', 'Chapter 1', 3);
        const reread = await JSZip.loadAsync(fs.readFileSync(paths.cbzFile));
        const pages = Object.values(reread.files).filter(f => !f.dir && f.name !== 'ComicInfo.xml');
        expect(pages).toHaveLength(3);
    });

    it('rejects a page-count mismatch and deletes the file', async () => {
        const zip = new JSZip();
        for (let i = 1; i <= 3; i++) {
            zip.file(`page_${String(i).padStart(3, '0')}.jpg`, Buffer.alloc(16, i));
        }
        const paths = pathsFor(path.join(tmpDir, 'mismatch', 'mismatch.cbz'));
        await expect(finalizeCbz(zip, paths, 'Manga', 'Chapter 1', 4)).rejects.toThrow(/3\/4/);
        expect(fs.existsSync(paths.cbzFile)).toBe(false);
    });
});
