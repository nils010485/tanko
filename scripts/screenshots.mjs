/**
 * Regenerates the README screenshots (docs/screenshots/*.png).
 *
 * Serves the built dashboard (packages/dashboard/dist) on a stub HTTP server
 * with a mocked REST/WebSocket API, seeds the library with real public-domain
 * artwork (Wikimedia Commons, cached under scripts/screenshot-assets/covers/),
 * then captures the views with headless Chromium via puppeteer-core.
 *
 * Usage:  node scripts/screenshots.mjs          (run from app/, after `npm run build -w @tanko/dashboard`)
 *
 * Covers were fetched from (all public domain):
 *   https://commons.wikimedia.org/wiki/Special:FilePath/The_Great_Wave_off_Kanagawa.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Edvard_Munch_-_The_Scream_-_Google_Art_Project.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Toshusai_Sharaku-_Otani_Oniji,_1794.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Vincent_van_Gogh_-_Self-Portrait_-_Google_Art_Project.jpg?width=700
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'packages/dashboard/dist');
const coversDir = join(root, 'scripts/screenshot-assets/covers');
const outDir = join(root, 'docs/screenshots');

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2'
};

const hours = n => new Date(Date.now() + n * 3_600_000).toISOString();

const LIBRARY = [
    {
        id: 1,
        sourceId: 'asurascans',
        sourceLabel: 'Asura Scans',
        mangaId: 'solo-leveling',
        title: 'Solo Leveling',
        coverUrl: '/covers/c4.jpg',
        autoDownload: true,
        chapterCount: 179,
        downloadedCount: 171,
        newCount: 12,
        lastCheckedAt: hours(-1),
        addedAt: hours(-2400)
    },
    {
        id: 2,
        sourceId: 'kaliscan',
        sourceLabel: 'KaliScan',
        mangaId: 'tbate',
        title: 'The Beginning After The End',
        coverUrl: '/covers/c2.jpg',
        autoDownload: true,
        chapterCount: 145,
        downloadedCount: 145,
        newCount: 0,
        lastCheckedAt: hours(-2),
        addedAt: hours(-2200)
    },
    {
        id: 3,
        sourceId: 'mangahere',
        sourceLabel: 'MangaHere',
        mangaId: 'orv',
        title: "Omniscient Reader's Viewpoint",
        coverUrl: '/covers/c3.jpg',
        autoDownload: true,
        chapterCount: 210,
        downloadedCount: 98,
        newCount: 3,
        lastCheckedAt: hours(-3),
        addedAt: hours(-2000)
    },
    {
        id: 4,
        sourceId: 'kaliscan',
        sourceLabel: 'KaliScan',
        mangaId: 'tog',
        title: 'Tower of God',
        coverUrl: '/covers/c1.jpg',
        autoDownload: false,
        chapterCount: 590,
        downloadedCount: 350,
        newCount: 0,
        lastCheckedAt: hours(-5),
        addedAt: hours(-3000)
    },
    {
        id: 5,
        sourceId: 'asurascans',
        sourceLabel: 'Asura Scans',
        mangaId: 'northern-blade',
        title: 'The Legend of the Northern Blade',
        coverUrl: '/covers/c7.jpg',
        autoDownload: true,
        chapterCount: 102,
        downloadedCount: 76,
        newCount: 5,
        lastCheckedAt: hours(-6),
        addedAt: hours(-1800),
        canRollbackMigration: true
    }
];

const SOURCES = [
    { id: 'asurascans', label: 'Asura Scans', tags: ['en', 'webtoon'], kind: 'native', health: 'ok', healthLatencyMs: 312 },
    { id: 'kaliscan', label: 'KaliScan', tags: ['fr', 'webtoon'], kind: 'native', health: 'ok', healthLatencyMs: 480 },
    { id: 'mangahere', label: 'MangaHere', tags: ['en'], kind: 'legacy', health: 'ok', healthLatencyMs: 1250 },
    { id: 'mangaplus', label: 'MangaPlus by Shueisha', tags: ['en', 'official'], kind: 'legacy', health: 'untested' }
];

const SEARCH = [
    { sourceId: 'asurascans', id: 'solo-leveling', title: 'Solo Leveling', thumbnail: '/covers/c4.jpg' },
    { sourceId: 'asurascans', id: 'solo-leveling-ragnarok', title: 'Solo Leveling: Ragnarok', thumbnail: '/covers/c2.jpg' },
    { sourceId: 'asurascans', id: 'leveling-with-the-gods', title: 'Leveling with the Gods', thumbnail: '/covers/c1.jpg' },
    { sourceId: 'asurascans', id: 'max-level-player', title: "The Max-Level Player's 100th Regression", thumbnail: '/covers/c3.jpg' },
    { sourceId: 'asurascans', id: 'tomb-raider-king', title: 'Tomb Raider King', thumbnail: '/covers/c7.jpg' },
    { sourceId: 'asurascans', id: 'leveling-beyond', title: 'Leveling Beyond the Max', thumbnail: '/covers/c4.jpg' }
];

const ROUTES = {
    'GET /api/library': LIBRARY,
    'GET /api/library/covers/status': { enabled: true, running: false, total: 5, done: 5, failed: 0, skipped: 0 },
    'GET /api/downloads': { jobs: [], total: 0, counts: {} },
    'GET /api/downloads/status': { paused: false, active: 0, queued: 0 },
    'GET /api/schedule': {
        settings: {
            enabled: true,
            cron: '0 */6 * * *',
            autoDownload: true,
            notifications: { enabled: true, webhookUrl: 'https://discord.com/api/webhooks/…' }
        },
        status: {
            enabled: true,
            cron: '0 */6 * * *',
            nextRunAt: hours(3),
            lastRunAt: hours(-3),
            lastRunResult: '5 series checked, 20 new chapters',
            seriesChecked: 5,
            newChaptersFound: 20
        }
    },
    'GET /api/sources': SOURCES,
    'GET /api/sources/health': {},
    'GET /api/sources/update': { running: false, last: null, activeCount: SOURCES.length },
    'GET /api/settings': { queue: {}, preferredLanguages: ['en'], uiLanguage: 'en', useFirstChapterCovers: true }
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock.local');
    const path = url.pathname;

    // mocked JSON API
    const route = ROUTES[`${req.method} ${path}`];
    if (route) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(route));
        return;
    }
    if (req.method === 'GET' && /^\/api\/sources\/[^/]+\/search$/.test(path)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(SEARCH));
        return;
    }

    // cover files: /covers/cN.jpg directly, or through the /api/image proxy
    const coverPath = path.startsWith('/covers/')
        ? path
        : path === '/api/image'
          ? new URL(url.searchParams.get('url') ?? '', 'http://mock.local').pathname
          : null;
    if (coverPath?.startsWith('/covers/')) {
        try {
            const data = await readFile(join(coversDir, coverPath.replace('/covers/', '')));
            res.writeHead(200, { 'Content-Type': 'image/jpeg' });
            res.end(data);
        } catch {
            res.writeHead(404).end();
        }
        return;
    }

    // static dashboard build (SPA fallback to index.html)
    try {
        const file = path === '/' ? '/index.html' : path;
        const data = await readFile(join(distDir, file));
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(data);
    } catch {
        const data = await readFile(join(distDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    }
});

// idle WebSocket so the dashboard shows the green "connected" dot
new WebSocketServer({ server, path: '/ws' }).on('connection', socket => socket.on('message', () => undefined));

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb']
});

const imagesLoaded = () => [...document.images].every(img => img.complete && img.naturalWidth > 0);

async function shot(name, hash, prepare) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${base}/#${hash}`, { waitUntil: 'networkidle0' });
    if (prepare) await prepare(page);
    await page.waitForFunction(imagesLoaded, { timeout: 15000 }).catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 400));
    await page.screenshot({ path: join(outDir, name) });
    console.log(`✓ docs/screenshots/${name}`);
    await page.close();
}

await shot('library.png', '/library', page => page.waitForSelector('article', { timeout: 15000 }));

await shot('discover.png', '/discover', async page => {
    await page.waitForSelector('main div.relative > button', { timeout: 15000 });
    await page.click('main div.relative > button'); // open the source picker
    await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Asura Scans'))?.click();
    });
    await page.type('main input', 'solo leveling');
    await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(btn => btn.textContent.match(/Search|Rechercher/))?.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('main .grid img').length >= 6, { timeout: 15000 });
});

await shot('schedule.png', '/schedule', page => page.waitForFunction(() => document.body.textContent.length > 500, { timeout: 15000 }));

await browser.close();
server.close();
