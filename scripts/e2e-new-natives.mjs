import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeBrowser, createEngine, SourceRegistry } from '@tanko/core';

const QUERIES = {
    comick: 'one piece',
    'mangatoon-en': 'daughter',
    'mangatoon-cn': '楚医生',
    'mangatoon-id': 'guru',
    'mangatoon-vi': 'tổng',
    tappytoonen: '',
    comizy: 'daemuljeon',
    hentaihand: 'milk',
    threehentai: 'good ending',
    zeurelscan: 'martial peak',
    mangapill: 'one piece',
    heavenmanga2: '3d kanojo',
    'linewebtoon-th': 'lookism',
    blackarmy: 'hatchling',
    shoujohearts: 'six half',
    mangahanta: 'again my life',
    natsuid: 'mythic',
    komikindoid: '',
    comicaction: '',
    youngjump: '',
    deathtollscans: '',
    bigcomics: '',
    takecomic: '',
    kimicomi: '',
    magapoke: '',
    mangadenizi: 'one piece',
    mangagg: 'wild',
    webcomicsapp: 'desharow',
    kumanga: '',
    neteasecomic: '',
    mgkomik: '',
    drakescans: 'necromancer',
    'flamescans-org': 'heavenly',
    azoraworld: 'sword',
    helveticascans: 'king',
    mangalib: 'wind',
    mangabuddy: 'daemuljeon',
    'tappytoon-en': ''
};
const IDS = [
    'comicaction',
    'youngjump',
    'deathtollscans',
    'mangatoon-en',
    'mangatoon-cn',
    'mangatoon-id',
    'mangatoon-vi',
    'comick',
    'mangabuddy',
    'hentaihand',
    'tappytoon-en',
    'mangapill',
    'heavenmanga2',
    'linewebtoon-th',
    '3hentai',
    'zeurelscan',
    'komikindoid',
    'natsuid',
    'blackarmy',
    'shoujohearts',
    'mangahanta',
    'drakescans',
    'flamescans-org',
    'azoraworld',
    'helveticascans',
    'bigcomics',
    'takecomic',
    'kimicomi',
    'mangalib',
    'shonenmagazine-pocket',
    'mangadenizi',
    'mangagg',
    'webcomicsapp',
    'kumanga',
    'neteasecomic',
    'mgkomik'
];

await createEngine({ dataDirectory: fs.mkdtempSync(path.join(os.tmpdir(), 't-e2e-')) });
const reg = new SourceRegistry();
await reg.ensureLoaded();

async function check(id) {
    const out = { id, health: '-', search: '-', ch: '-', pg: '-' };
    try {
        const a = await reg.get(id);
        if (a.kind !== 'native') {
            out.health = 'NOT-NATIVE';
            return out;
        }
        const h = await a.checkHealth().catch(e => ({ ok: false, error: String(e.message).slice(0, 40) }));
        out.health = h.ok ? 'OK' : `FAIL:${(h.error || '').slice(0, 40)}`;
        if (!h.ok) return out;
        const list = await a.searchMangas(QUERIES[id] ?? 'one').catch(e => ({ err: String(e.message).slice(0, 40) }));
        if (!Array.isArray(list)) {
            out.search = `ERR:${list.err}`;
            return out;
        }
        out.search = list.length;
        if (!list.length) return out;
        const ch = await a.getChapters(list[0]).catch(e => ({ err: String(e.message).slice(0, 40) }));
        if (!Array.isArray(ch)) {
            out.ch = `ERR:${ch.err}`;
            return out;
        }
        out.ch = ch.length;
        if (!ch.length) return out;
        const pg = await a.getPages(list[0], ch[Math.max(0, ch.length - 1)]).catch(e => ({ err: String(e.message).slice(0, 40) }));
        out.pg = Array.isArray(pg) ? pg.length : `ERR:${pg.err}`;
    } catch (e) {
        out.health = `EXC:${String(e.message).slice(0, 30)}`;
    }
    return out;
}

const results = [];
const queue = [...IDS];
const workers = Array.from({ length: 3 }, async () => {
    while (queue.length) {
        const id = queue.shift();
        results.push(await check(id));
        console.error(`${id} done (${results.length}/${IDS.length})`);
    }
});
await Promise.all(workers);
results.sort((a, b) => IDS.indexOf(a.id) - IDS.indexOf(b.id));
for (const r of results) {
    console.log(`${r.id.padEnd(22)} h=${String(r.health).padEnd(42)} s=${String(r.search).padEnd(5)} ch=${String(r.ch).padEnd(5)} pg=${r.pg}`);
}
await closeBrowser().catch(() => {});
