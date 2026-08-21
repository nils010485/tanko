/**
 * Shim verification: the linkedom `text` patch must unbreak the legacy
 * connectors that crashed on `element.text` (WordPressMadara family,
 * MangaKatana). Network test — run manually.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, SourceRegistry } from '@tanko/core';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-shim-'));
await createEngine({ dataDirectory: dataDir });
const registry = new SourceRegistry();
await registry.ensureLoaded();

// 1. MangaDNA getChapters — was crashing on element.text (WordPressMadara.mjs:114)
const dna = await registry.get('mangadna');
try {
    const chapters = await dna.getChapters({ id: '/manga/existence-6e', title: 'Existence' });
    console.log(`mangadna getChapters: OK (${chapters.length} chapters)`);
} catch (error) {
    console.log(`mangadna getChapters: STILL BROKEN — ${error.message.split('\n')[0]}`);
}

// 2. MangaKatana searchMangas — was crashing on element.text.trim (line 52)
const kat = await registry.get('mangakatana');
try {
    const results = await Promise.race([kat.searchMangas('one piece'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 60s')), 60_000))]);
    console.log(`mangakatana searchMangas: OK (${results.length} matches)`);
} catch (error) {
    const broken = /trim|replace|undefined/.test(error.message);
    console.log(`mangakatana searchMangas: ${broken ? 'STILL BROKEN' : 'network/site issue'} — ${error.message.split('\n')[0]}`);
}
process.exit(0);
