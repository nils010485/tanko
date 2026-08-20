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
 * Covers are public-domain Golden Age comic covers (Wikimedia Commons,
 * cached under scripts/screenshot-assets/covers/):
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Planet_Comics_03.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/WhizComicsNo22.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/MasterComics005.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Fight_Comics_29.jpg?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/FlashGordonStrangeAdventuresDecember1936.png?width=700
 *   https://commons.wikimedia.org/wiki/Special:FilePath/Planet_stories_1940spr.jpg?width=700
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
        sourceId: 'dcm',
        sourceLabel: 'Digital Comic Museum',
        mangaId: 'planet-comics',
        title: 'Planet Comics',
        coverUrl: '/covers/planet-comics.jpg',
        autoDownload: true,
        chapterCount: 73,
        downloadedCount: 61,
        newCount: 4,
        lastCheckedAt: hours(-1),
        addedAt: hours(-2400)
    },
    {
        id: 2,
        sourceId: 'cbp',
        sourceLabel: 'Comic Book Plus',
        mangaId: 'whiz-comics',
        title: 'Whiz Comics',
        coverUrl: '/covers/whiz-comics.jpg',
        autoDownload: true,
        chapterCount: 155,
        downloadedCount: 155,
        newCount: 0,
        lastCheckedAt: hours(-2),
        addedAt: hours(-2200)
    },
    {
        id: 3,
        sourceId: 'dcm',
        sourceLabel: 'Digital Comic Museum',
        mangaId: 'master-comics',
        title: 'Master Comics',
        coverUrl: '/covers/master-comics.jpg',
        autoDownload: true,
        chapterCount: 133,
        downloadedCount: 42,
        newCount: 2,
        lastCheckedAt: hours(-3),
        addedAt: hours(-2000)
    },
    {
        id: 4,
        sourceId: 'cbp',
        sourceLabel: 'Comic Book Plus',
        mangaId: 'fight-comics',
        title: 'Fight Comics',
        coverUrl: '/covers/fight-comics.jpg',
        autoDownload: false,
        chapterCount: 88,
        downloadedCount: 30,
        newCount: 0,
        lastCheckedAt: hours(-5),
        addedAt: hours(-3000)
    },
    {
        id: 5,
        sourceId: 'dcm',
        sourceLabel: 'Digital Comic Museum',
        mangaId: 'flash-gordon',
        title: 'Flash Gordon: Strange Adventures',
        coverUrl: '/covers/flash-gordon.png',
        autoDownload: true,
        chapterCount: 1,
        downloadedCount: 1,
        newCount: 0,
        lastCheckedAt: hours(-6),
        addedAt: hours(-1800),
        canRollbackMigration: true
    }
];

const SOURCES = [
    { id: 'dcm', label: 'Digital Comic Museum', tags: ['en', 'public-domain'], kind: 'native', health: 'ok', healthLatencyMs: 312 },
    { id: 'cbp', label: 'Comic Book Plus', tags: ['en', 'public-domain'], kind: 'native', health: 'ok', healthLatencyMs: 480 },
    { id: 'gutenberg', label: 'Project Gutenberg', tags: ['en', 'ebooks'], kind: 'legacy', health: 'ok', healthLatencyMs: 1250 },
    { id: 'archive', label: 'Internet Archive', tags: ['en', 'scans'], kind: 'legacy', health: 'untested' }
];

const SEARCH = [
    { sourceId: 'dcm', id: 'planet-comics', title: 'Planet Comics', thumbnail: '/covers/planet-comics.jpg' },
    { sourceId: 'dcm', id: 'planet-stories', title: 'Planet Stories', thumbnail: '/covers/planet-stories.jpg' },
    { sourceId: 'dcm', id: 'whiz-comics', title: 'Whiz Comics', thumbnail: '/covers/whiz-comics.jpg' },
    { sourceId: 'dcm', id: 'master-comics', title: 'Master Comics', thumbnail: '/covers/master-comics.jpg' },
    { sourceId: 'dcm', id: 'fight-comics', title: 'Fight Comics', thumbnail: '/covers/fight-comics.jpg' },
    { sourceId: 'dcm', id: 'strange-adventures', title: 'Flash Gordon: Strange Adventures', thumbnail: '/covers/flash-gordon.png' }
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
            res.writeHead(200, { 'Content-Type': MIME[extname(coverPath)] ?? 'image/jpeg' });
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
        [...document.querySelectorAll('button')].find(btn => btn.textContent.includes('Digital Comic Museum'))?.click();
    });
    await page.type('main input', 'planet');
    await page.evaluate(() => {
        [...document.querySelectorAll('button')].find(btn => btn.textContent.match(/Search|Rechercher/))?.click();
    });
    await page.waitForFunction(() => document.querySelectorAll('main .grid img').length >= 6, { timeout: 15000 });
});

await shot('schedule.png', '/schedule', page => page.waitForFunction(() => document.body.textContent.length > 500, { timeout: 15000 }));

await browser.close();
server.close();
