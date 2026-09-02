#!/usr/bin/env node
// E2E regression check for tonight's commits, against a live tanko container.
// Usage: node e2e-regression.mjs [baseUrl]  (default http://localhost:18080)

const BASE = process.argv[2] ?? 'http://localhost:18080';
let failures = 0;
let passed = 0;

function check(name, ok, detail = '') {
    if (ok) {
        passed++;
        console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
    } else {
        failures++;
        console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

// boot token (same-origin guard on mutations)
let TOKEN = '';
TOKEN = (await api('GET', '/api/bootstrap')).json?.token ?? '';

async function api(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(method !== 'GET' && method !== 'HEAD' ? { 'x-tanko-token': TOKEN } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    let json = null;
    try {
        json = await res.json();
    } catch {}
    return { status: res.status, json };
}

console.log(`E2E regression suite → ${BASE}\n`);

// 1. health + dashboard ----------------------------------------------------
{
    console.log('[1] Health & dashboard');
    const h = await api('GET', '/health');
    check('GET /health = 200 ok', h.status === 200 && h.json?.status === 'ok');

    const page = await fetch(`${BASE}/`);
    const html = await page.text();
    check('GET / serves dashboard HTML', page.status === 200 && html.includes('<div id="root"'));
    // commit 3f73c37: settings moved into Manage nav — bundle must reference it
    const bundle = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    const js = bundle ? await (await fetch(`${BASE}${bundle}`)).text() : '';
    check('dashboard bundle built & reachable', Boolean(bundle) && js.length > 10000, bundle ?? 'no bundle');
    check('Manage nav section exists in bundle', /manage/i.test(js) && /settings/i.test(js));
}

// 2. settings + hideAdultSources (d1b5cf0) ----------------------------------
{
    console.log('\n[2] hideAdultSources setting');
    const before = await api('GET', '/api/sources');
    const s0 = await api('GET', '/api/settings');
    check('GET /api/settings has hideAdultSources', s0.status === 200 && 'hideAdultSources' in s0.json, `=${s0.json?.hideAdultSources}`);
    const allSources = before.json ?? [];
    check('GET /api/sources ok, non-empty', before.status === 200 && allSources.length > 0, `${allSources.length} sources`);
    const original = s0.json?.hideAdultSources;

    const patch = await api('PATCH', '/api/settings', { hideAdultSources: true });
    check('PATCH hideAdultSources=true accepted', patch.status === 200 && patch.json?.hideAdultSources === true);

    const after = await api('GET', '/api/sources');
    const filtered = after.json ?? [];
    const stillAdult = filtered.filter(s => /hentai|porn/i.test(`${s.tags ?? []}`) && /hentai|porn|adult/i.test(`${s.id}`));
    check(
        'adult sources hidden from list',
        filtered.length < allSources.length && stillAdult.length === 0,
        `${allSources.length} → ${filtered.length}, ${stillAdult.length} adult leaked`
    );
    const globalSearch = await api('POST', '/api/sources/search-all', { q: 'one piece' });
    check('global search job still starts', globalSearch.status === 200 || globalSearch.status === 202, `HTTP ${globalSearch.status}`);

    const restore = await api('PATCH', '/api/settings', { hideAdultSources: original ?? false });
    const restored = await api('GET', '/api/sources');
    check('restore works', restore.status === 200 && (restored.json ?? []).length === allSources.length);
}

// 3. maintenance cache clear (55a6247) --------------------------------------
{
    console.log('\n[3] Maintenance cache clear');
    // populate a bit of cache via a search
    await api('GET', '/api/sources/mangapill/search?q=one%20piece').catch(() => {});
    const r = await api('POST', '/api/maintenance/cache/clear');
    check('POST /api/maintenance/cache/clear ok', r.status === 200 && typeof r.json?.cleared === 'number', `cleared=${r.json?.cleared}`);
    const repeat = await api('POST', '/api/maintenance/cache/clear');
    check('idempotent second call', repeat.status === 200 && repeat.json?.cleared === 0, `cleared=${repeat.json?.cleared}`);
}

// 4. SSRF / network bounds (c1e13d8) ----------------------------------------
{
    console.log('\n[4] SSRF guards');
    // page-image proxy with a private-range URL must not be served
    const priv = await fetch(`${BASE}/api/sources/comick/page-image?url=${encodeURIComponent('http://127.0.0.1:8080/health')}`).catch(() => ({
        status: 0,
        ok: false
    }));
    check('page-image rejects private-range URL', !priv.ok, `HTTP ${priv.status}`);
    const priv2 = await fetch(`${BASE}/api/sources/comick/page-image?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`).catch(() => ({
        status: 0,
        ok: false
    }));
    check('page-image rejects link-local metadata IP', !priv2.ok, `HTTP ${priv2.status}`);
}

// 5. comick dedupe per scanlation group (e1d25fa) + live engine ------------
{
    console.log('\n[5] ComicK live: search + chapter dedupe');
    const search = await api('GET', '/api/sources/comick/search?q=one%20piece');
    check('comick search ok', search.status === 200 && (search.json ?? []).length > 0, `${(search.json ?? []).length} results`);

    if ((search.json ?? []).length > 0) {
        const mangaId = search.json[0].id;
        const chapters = await api(
            'GET',
            `/api/sources/comick/chapters?mangaId=${encodeURIComponent(mangaId)}&title=${encodeURIComponent(search.json[0].title)}`
        );
        const list = chapters.json ?? [];
        check('comick chapters ok', chapters.status === 200 && list.length > 0, `${list.length} chapters`);

        // dedupe (e1d25fa): no duplicate chapter ids, no duplicate titles
        const ids = new Set(list.map(ch => ch.id));
        const titles = new Set(list.map(ch => ch.title));
        check(
            'no duplicate chapters (dedupe per scanlation group)',
            ids.size === list.length && titles.size === list.length,
            `${list.length} chapters, ${list.length - ids.size} dup ids`
        );
    }
}

// 6. library: canonical series directory (569f97e) --------------------------
console.log('\n[6] Library canonical directories');
// purge stale "One Piece" entries from earlier runs
for (const old of ((await api('GET', '/api/library')).json ?? []).filter(e => e.title === 'One Piece')) {
    await api('DELETE', `/api/library/${old.id}?disk=true`);
}

const mpSearch = await api('GET', '/api/sources/mangapill/search?q=one%20piece');
const mp = (mpSearch.json ?? []).find(m => m.title === 'One Piece') ?? (mpSearch.json ?? [])[0];
const added = await api('POST', '/api/library', {
    sourceId: 'mangapill',
    mangaId: mp.id,
    title: mp.title
});
check('POST /api/library ok', [200, 201].includes(added.status), `HTTP ${added.status}`);

const lib = await api('GET', '/api/library');
const entry = (lib.json ?? []).find(e => e.title === 'One Piece');
check('entry appears in library', Boolean(entry));

if (entry) {
    // canonical dir: layout 'series' → <base>/<Manga title>, allocated at add time
    const dp = await api('GET', `/api/library/${entry.id}/disk-path`);
    const layout = (await api('GET', '/api/settings')).json?.queue?.directoryLayout;
    check(
        'canonical series directory allocated (layout=series)',
        layout === 'series' && dp.json?.path === '/data/One Piece',
        `layout=${layout}, path=${dp.json?.path}`
    );

    // real download: a chapter must land inside the canonical dir
    const chapters = await api('GET', `/api/sources/mangapill/chapters?mangaId=${encodeURIComponent(entry.mangaId)}&title=${encodeURIComponent(entry.title)}`);
    const ch = (chapters.json ?? []).at(-1);
    if (ch) {
        const dl = await api('POST', '/api/downloads', {
            sourceId: entry.sourceId,
            mangaId: entry.mangaId,
            mangaTitle: entry.title,
            chapters: [{ id: ch.id, title: ch.title }]
        });
        check('download job accepted', dl.status === 200 || dl.status === 201, `HTTP ${dl.status}`);

        let final = 'timeout';
        for (let i = 0; i < 60 && final === 'timeout'; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const jobs = await api('GET', '/api/downloads');
            const list = jobs.json?.jobs ?? jobs.json ?? [];
            const job = Array.isArray(list) ? list.find(j => j.chapterId === ch.id) : undefined;
            if (['completed', 'failed', 'cancelled'].includes(job?.status)) final = job.status;
        }
        check('chapter download completed', final === 'completed', `status=${final}`);
    }

    // cleanup test entry so the volume stays clean
    const del = await api('DELETE', `/api/library/${entry.id}?disk=true`);
    check('cleanup: delete test entry + files', del.status === 200 || del.status === 204, `HTTP ${del.status}`);
}

// 7. per-host rate-limit backoff (f4bce06) — smoke via mangapill chapters ---
{
    console.log('\n[7] Rate-limit backoff smoke (parallel same-host fetches)');
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => api('GET', '/api/sources/mangapill/search?q=one%20piece')));
    const okCount = results.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
    check('parallel same-host requests all succeed (backoff, not failure)', okCount === 3, `${okCount}/3 ok`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
