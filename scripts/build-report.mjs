/**
 * Builds the final triage report (markdown + JSON) by merging:
 *  - triage-results.json  (probe outcome per broken source)
 *  - dead-analysis.json   (DNS / wayback verdicts for 'dead' rows)
 *  - dead-http-probe.json (curl verdict per dead host)
 *  - the vendored connector source (family detection via class imports)
 * Verdict per source: NATIVE-CANDIDATE (site answers, connector rotten),
 * MOVED (new domain found), DEAD, UNTESTABLE (antibot/5xx/timeout).
 *   node scripts/build-report.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const triage = JSON.parse(fs.readFileSync(path.join(here, 'triage-results.json'), 'utf8'));
const httpProbe = JSON.parse(fs.readFileSync(path.join(here, 'dead-http-probe.json'), 'utf8'));
const vendorDir = path.resolve(here, '../packages/core/vendor/connectors');

/** Findings from the deep/e2e probes that the automated classes can't know. */
const MANUAL = {
    decadencescans: { verdict: 'NATIVE-DONE', note: 'paged-mode fallback (?style=list) in MadaraConnector' },
    readmanhua: { verdict: 'DEAD', note: 'redirects to themeraider.com, now a t-shirt shop' },
    swordmanga: { verdict: 'NOVEL', note: 'Madara Novel: text chapters, no page images' },
    wbnovel: { verdict: 'NOVEL', note: 'Madara Novel: text chapters, no page images' },
    sleepytranslations: { verdict: 'NOVEL', note: 'Madara Novel: text chapters, no page images' },
    wordrain: { verdict: 'NOVEL', note: 'Madara Novel: text chapters, no page images' },
    apollcomics: { verdict: 'NATIVE-DONE', note: 'domain moved .xyz -> .es (post-deploy fix)' },
    arthurscan: { verdict: 'NATIVE-DONE', note: 'wired as native MadaraConnector' },
    mangapark: { verdict: 'DEAD', note: 'moved .net->.org->.me->.io; .io now bounces to an ad gate (nexusmart)' },
    'mangapark-en': { verdict: 'DEAD', note: 'same chain as mangapark, ends on the ad gate' },
    sirenkomik: { verdict: 'DEAD', note: '.my.id 301-> .xyz which only serves a "Redirecting..." shell' },
    '517mh': { verdict: 'DEAD', note: '517mh.net unreachable (DNS ok, no answer)' },
    'asurascans-tr': { verdict: 'NATIVE-DONE', note: 'wired as native MadaraConnector' },
    boosei: { verdict: 'DEAD', note: 'boosei.net redirects to a jewelry e-shop (ricestone-france)' },
    comick: { verdict: 'NATIVE-CANDIDATE', note: 'root renders via browser; catalog broken (site redesigned) — needs native rewrite (public API)' },
    mangagg: { verdict: 'NATIVE-CANDIDATE', note: 'root renders via browser; catalog broken — needs native rewrite' },
    imangascans: { verdict: 'DEAD', note: 'imangascans.org is now a plain .zip download archive, no reader' },
    dokifansubs: { verdict: 'DEAD', note: 'doki.co alive but releases on MangaDex (native mangadex connector covers it)' },
    '365manga': { verdict: 'DEAD', note: 'Joken JS-wall then Bodis parking + permanent 429 (casework)' },
    ainzscans: { verdict: 'DEAD', note: 'Blogger landing; real site v3.ainzscans01.com gates chapters behind accounts (casework)' },
    coloredmanga: { verdict: 'DEAD', note: 'Cloudflare 301 to a Discord invite on every path (casework)' },
    guncelmanga: { verdict: 'DEAD', note: '301 to rioc.cl casino spam (casework)' },
    bestmanga: { verdict: 'DEAD', note: 'above.com parked "for sale" (casework)' },
    mangagg: { verdict: 'NEEDS-TEMPLATE-EXT', note: 'Madara /comic/ post-type + madara_load_more search; chapters via browser (casework)' },
    drakescans: { verdict: 'NEEDS-CUSTOM', note: 'Next.js Flight payload, drakecomic.net (casework)' },
    'flamescans-org': { verdict: 'NEEDS-CUSTOM', note: 'Next.js __NEXT_DATA__ JSON + cdn.flamecomics.xyz (casework)' },
    comicmeteor: { verdict: 'OVERRIDE-DONE', note: 'moved to kirapo.jp/meteor; vendored override reusing SpeedBinb reader (casework)' },
    comicpolaris: { verdict: 'OVERRIDE-DONE', note: 'moved to kirapo.jp/polaris; vendored override reusing SpeedBinb reader (casework)' },
    lelscan: { verdict: 'OVERRIDE-DONE', note: 'moved to lelscans.net; selector + linkedom patches in vendored override (casework)' },
    tripleoren: { verdict: 'DEAD', note: 'NXDOMAIN everywhere, no wayback, no successor (casework)' },
    mangajp: { verdict: 'DEAD', note: 'Sedo parking since 2025, no successor (casework)' },
    kaguyadex: { verdict: 'DEAD', note: 'kaguya.io pivoted to a VN social network, comics gone (casework)' },
    comicbunch: { verdict: 'DEAD', note: 'domain is Korean casino spam; legal successor serves via kuragebunch (other connector)' },
    fallenangelsscans: { verdict: 'DEAD', note: 'domain hijacked into an ad-click funnel (casework r3)' },
    hoshikuzuuscans: { verdict: 'DEAD', note: 'no DNS; only a frozen 2017 wordpress archive (casework r3)' },
    cocorip: { verdict: 'DEAD', note: 'above.com parking (casework r3)' },
    azoraworld: { verdict: 'DEAD', note: 'redirects to azorafly.com (custom Astro platform, possible future custom) (casework r3)' },
    mangareadco: { verdict: 'NATIVE-DONE', note: 'old domain hijacked by gambling spam; wired native on www.mangaread.org (casework r3)' },
    helveticascans: { verdict: 'NEEDS-CUSTOM', note: 'moved to assortedscans.com running MangAdventure (API /api/v2/series, no trailing slash) (casework r3)' },
    deathtollscans: { verdict: 'NEEDS-TEMPLATE', note: 'FoolSlide 0.8.19 intact on reader.deathtollscans.net (casework r3)' },
    mangadenizi: { verdict: 'NEEDS-CUSTOM', note: 'custom JSON API + tiled-v1 scrambled images (seeded detile needed) (casework r3)' },
    mangahanta: { verdict: 'NEEDS-CUSTOM', note: 'MangaVerse WP theme, TR+EN verified, cdn.mangahanta.com (casework r3)' },
    comicaction: { verdict: 'NEEDS-TEMPLATE', note: 'GigaViewer alive on comic-action.com; selectors changed (casework r4)' },
    comicbushi: { verdict: 'DEAD', note: 'now a Comici white-label (comic-growl.com), viewer behind login (casework r4)' },
    herosweb: { verdict: 'DEAD', note: 'Comici white-label, viewer behind login (casework r4)' },
    'mangatoon-en': { verdict: 'NEEDS-CUSTOM', note: 'sg.mangatoon.mobi API, md5 signing documented, encrypted->watermark image trick (casework r4)' },
    'mangatoon-cn': { verdict: 'NEEDS-CUSTOM', note: 'same sg API, _language=cn (casework r4)' },
    'mangatoon-id': { verdict: 'NEEDS-CUSTOM', note: 'same sg API, _language=id, all episodes free (casework r4)' },
    akumanga: { verdict: 'DEAD', note: 'Cowboy 429 gate for every client, Joken JWT shells since 2024 (casework r4)' },
    leomanga: { verdict: 'DEAD', note: 'same Cowboy/Joken gate infrastructure (casework r4)' },
    hentaiwebtoon: { verdict: 'DEAD', note: 'live popunder redirect, domain sold (casework r4)' },
    iskultripscans: { verdict: 'DEAD', note: 'togel spam on old domain, NXDOMAIN elsewhere (casework r4)' },
    yuriism: { verdict: 'DEAD', note: 'ParkLogic parking; content lives on DynastyScans (casework r4)' },
    shoujohearts: { verdict: 'NEEDS-CUSTOM', note: 'shoujohearts.net is Madara over http; chapter list JS-walled, latest-releases workaround (casework r4)' },
    'on-manga': { verdict: 'FIXED-SHIM', note: 'window.location shim fix resurrected the legacy connector, e2e verified' },
    anzmanga: { verdict: 'FIXED-SHIM', note: 'window.location shim fix, e2e verified (7 series, 235 chapters, 47 pages)' },
    scanvf: { verdict: 'FIXED-SHIM', note: 'window.location shim fix, e2e verified (174 chapters, 22 pages)' },
    coffeemanga: { verdict: 'NATIVE-DONE', note: '.io chain dead; wired native on coffeemanga.net + acard selector + forbidden-ajax fallback (casework r5)' },
    mangabob: { verdict: 'DEAD', note: 'above.com for-sale lander (casework r5)' },
    mangagreat: { verdict: 'DEAD', note: 'Cowboy 429 gate, parked since 2024 (casework r5)' },
    radiantscans: { verdict: 'DEAD', note: 'Namecheap parking; group moved to MangaDex (casework r5)' },
    readmng: { verdict: 'DEAD', note: 'zombie domain serving wayback-demo spam (casework r5)' },
    bacakomikid: { verdict: 'DEAD', note: 'parked; successor id.mgkomik.cc is Madara behind Cloudflare (future native candidate)' },
    raindropfansub: { verdict: 'DEAD', note: 'whole domain behind a reCAPTCHA bot wall (casework r5)' },
    universoyuri: { verdict: 'DEAD', note: 'expireddomains parking (casework r5)' },
    gammaplus: { verdict: 'NEEDS-CUSTOM', note: 'merged into takecomic.jp (comici, signed+scrambled pages, referer required)' },
    storiadash: { verdict: 'NEEDS-CUSTOM', note: 'merged into takecomic.jp (casework r5)' },
    webcomicgamma: { verdict: 'NEEDS-CUSTOM', note: 'merged into takecomic.jp (casework r5)' },
    mangakik: { verdict: 'DEAD', note: 'GoDaddy for-sale via above.com (casework r6)' },
    'mangazuki-online': { verdict: 'DEAD', note: '301 to a One Piece fan site, Madara gone (casework r6)' },
    manytooncom: { verdict: 'DEAD', note: 'popunder chain to stripchat (casework r6)' },
    komikindoid: { verdict: 'NEEDS-CUSTOM', note: 'moved to komikindo.ch: animepost list, #chimg-auh imgs, 6 mirror CDNs (casework r6)' },
    mangasusureborn: { verdict: 'NATIVE-DONE', note: 'wired native MangastreamConnector on mangasusuku.com /komik/list-mode/ (casework r6)' },
    natsuid: { verdict: 'NEEDS-CUSTOM', note: 'moved to natsu.one: open wp-json index, 6575 series (casework r6)' },
    mangabuddy: { verdict: 'NEEDS-CUSTOM', note: 'rebranded comizy.io, api.comizy.io + Referer required (casework r6)' },
    mangapill: { verdict: 'NEEDS-CUSTOM', note: 'alive, selectors mostly intact: img data-src + one-genre-per-page catalog fix (casework r6)' },
    mangaromance: { verdict: 'DEAD', note: 'no DNS; .eu parked at expireddomains (casework r6)' },
    kkjscans: { verdict: 'DEAD', note: 'Bodis parking since 2024 (casework r7)' },
    lirescan: { verdict: 'DEAD', note: 'blanket 429 even in a real browser (casework r7)' },
    sleepypandascans: { verdict: 'DEAD', note: 'lander redirecting to alitools.io (casework r7)' },
    markscans: { verdict: 'DEAD', note: 'cloaker parking: curl->immanitys.com, browser->google.com (casework r7)' },
    mindafansub: { verdict: 'DEAD', note: '301 to expireddomains sale page (casework r7)' },
    miraclescans: { verdict: 'DEAD', note: 'domain recycled into an ultrasound clinic (casework r7)' },
    webcomicsapp: { verdict: 'NEEDS-CUSTOM', note: 'alive Nuxt SPA, reader needs JS+scroll render (casework r7)' },
    zeurelscan: { verdict: 'NEEDS-CUSTOM', note: 'alive static Italian site, old selectors dead (casework r7)' },
    kumanga: { verdict: 'NEEDS-CUSTOM', note: 'alive behind CF challenge + hex-encoded img.php (casework r7)' },
    mundowuxia: { verdict: 'DEAD', note: 'rebuilt as an Angular SPA serving 3 pt-BR text novels (casework r7)' },
    opiatoon: { verdict: 'NATIVE-DONE', note: '.biz dead; wired native on opiatoon.shop (casework r7)' },
    painfulnightz: { verdict: 'DEAD', note: 'Cloudflare lander to collectbladders spam (casework r7)' },
    beetoon: { verdict: 'DEAD', note: 'fetch failed on re-probe after shim fix' },
    goldenmangas: { verdict: 'DEAD', note: 'fetch failed on re-probe after shim fix' },
    'ravensscans-en': { verdict: 'DEAD', note: 'fetch failed on re-probe after shim fix' },
    tenshimoe: { verdict: 'DEAD', note: 'fetch failed on re-probe after shim fix' },
    'mangatoon-vi': { verdict: 'NEEDS-CUSTOM', note: 'same sg API as siblings, _language=vi (casework r4)' },
    '3hentai': { verdict: 'NEEDS-CUSTOM', note: 'alive: catalog + /d/<id> galleries work, thumb->full = strip t suffix (casework r8)' },
    hentaihand: { verdict: 'NEEDS-CUSTOM', note: 'alive: public Laravel API /api/comics... (casework r8)' },
    heavenmanga2: { verdict: 'NEEDS-CUSTOM', note: 'alive: ?pages= pagination + DataTables chapter ajax (casework r8)' },
    acescans: { verdict: 'DEAD', note: '.xyz blanket 429; successor acescans.com is Next.js custom (casework r8)' },
    blackarmy: { verdict: 'NEEDS-CUSTOM', note: 'alive WP custom theme: check_chapter ajax returns image list (casework r8)' },
    ngomik: { verdict: 'DEAD', note: 'link-farm gambling spam (casework r8)' },
    animeparadise: { verdict: 'DEAD', note: 'anime video streaming only, no manga (casework r8)' },
    'linewebtoon-th': { verdict: 'NEEDS-CUSTOM', note: 'alive: chapter selector changed, images need Referer webtoons.com (casework r8)' },
    hoducomics: { verdict: 'DEAD', note: 'anti-bot farm redirecting to a crypto casino (casework r8)' },
    batoscan: { verdict: 'DEAD', note: '.com NXDOMAIN, .net Cowboy 429 (casework r8)' },
    epikmanga: { verdict: 'DEAD', note: '301 to epiknovel.com: text novels only (casework r8)' },
    delitoonde: { verdict: 'DEAD', note: 'officially merged into Lezhin DE (Balcony-encrypted, custom only)' },
    comick: { verdict: 'NEEDS-CUSTOM', note: 'hybrid: api.comick.dev metadata + comick.art pages (Referer art) (casework r3)' },
    bigcomics: { verdict: 'NEEDS-CUSTOM', note: 'alive on comici platform: /api/book/contentsInfo signed+scrambled+referer (casework r9)' },
    comicvalkyrie: { verdict: 'DEAD', note: 'migrated to kimicomi.com (same comici platform) (casework r9)' },
    youngjump: { verdict: 'NEEDS-TEMPLATE', note: 'tonarinoyj.jp alive, GigaViewer episode-json unscrambled (casework r9)' },
    sukima: { verdict: 'DEAD', note: 'service shut down 2025-09-30 (casework r9)' },
    comicextra: { verdict: 'DEAD', note: 'domain parking rotator (casework r9)' },
    porncomixonline: { verdict: 'DEAD', note: 'domain expired, topdns sale lander (casework r9)' },
    rightdarkscan: { verdict: 'DEAD', note: 'for-sale wildcard parking faking health OK (casework r9)' },
    siyahmelek: { verdict: 'DEAD', note: 'all grimelek TLDs parked; no Madara successor (casework r9)' },
    vinmanga: { verdict: 'DEAD', note: 'Bodis parking via tr_uuid shell (casework r9)' },
    readmanhwa: { verdict: 'DEAD', note: 'NO_DNS apex, parked www; homonym readmanhwas.com is Nuxt custom (casework r9)' },
    iqiyi: { verdict: 'NEEDS-CUSTOM', note: 'service alive on manhua.iqiyi.com but API param-gated (E00002) (casework r9)' },
    neteasecomic: { verdict: 'NEEDS-CUSTOM', note: 'Bilibili manhua alive; twirp risk-control requires browser rendering (casework r9)' },
    useventeen: { verdict: 'DEAD', note: 'u17.com absorbed by Bilibili (covered by neteasecomic custom) (casework r9)' },
    'toomics-ko': { verdict: 'PARTIAL', note: 'vendored patched: search 379 + chapters OK; viewer pages need session cookies (casework r9 + final patch)' },
    'tappytoon-en': { verdict: 'NEEDS-CUSTOM', note: 'alive: __NEXT_DATA__ Bearer + X-Device-Uuid anonymous flow, signed CDN (casework r9)' },
    mangahome: { verdict: 'NEEDS-PATCH', note: 'alive over http, dm5/MangaFox chapterfun.ashx mechanism (casework r9)' },
    mangalib: { verdict: 'NEEDS-CUSTOM', note: 'alive: api.cdnlibs.org with Site-Id header, referer-gated CDN (casework r9)' },
    mangaoku: { verdict: 'DEAD', note: 'Chinese casino parking (casework r9)' },
    oxapk: { verdict: 'DEAD', note: 'now an Arabic APK blogger, no manga (casework r9)' },
    'shonenmagazine-pocket': {
        verdict: 'NEEDS-CUSTOM',
        note: 'alive: x-manga-hash with empty secret reproduced, CloudFront signed + WASM scramble (casework r9)'
    },
    mangabaz: { verdict: 'DEAD', note: 'Joken JWT wall landing on a linkless ww547 parking shell (final check)' },
    comicaction: { verdict: 'NATIVE-DONE', note: 'GigaViewer native (episode-json; free chapters only)' },
    youngjump: { verdict: 'NATIVE-DONE', note: 'GigaViewer native on tonarinoyj.jp' },
    deathtollscans: { verdict: 'NATIVE-DONE', note: 'FoolSlide native (var pages JSON, adult gate)' },
    'mangatoon-en': { verdict: 'NATIVE-DONE', note: 'sg.mangatoon.mobi signed API native (free episodes, watermark jpegs)' },
    'mangatoon-cn': { verdict: 'NATIVE-DONE', note: 'sg API native, _language=cn' },
    'mangatoon-id': { verdict: 'NATIVE-DONE', note: 'sg API native, _language=id' },
    'mangatoon-vi': { verdict: 'NATIVE-DONE', note: 'sg API native, _language=vi' },
    comick: { verdict: 'NATIVE-DONE', note: 'hybrid native: api.comick.dev + comick.art sv-data (Referer art)' },
    mangabuddy: { verdict: 'NATIVE-DONE', note: 'comizy.io API native (cmzcdn Referer via fetchPageImage)' },
    hentaihand: { verdict: 'NATIVE-DONE', note: 'Laravel public API native (slug-keyed, one-shot)' },
    'tappytoon-en': { verdict: 'NATIVE-DONE', note: '__NEXT_DATA__ anonymous bearer native (free chapters, signed CDN)' },
    mangapill: { verdict: 'NATIVE-DONE', note: 'static SSR native (img data-src, Referer fetchPageImage)' },
    heavenmanga2: { verdict: 'NATIVE-DONE', note: 'DataTables chapter ajax native' },
    'linewebtoon-th': { verdict: 'NATIVE-DONE', note: 'webtoons.com/th native (Naver CDN Referer)' },
    '3hentai': { verdict: 'NATIVE-DONE', note: '/d/<id> gallery markup native' },
    zeurelscan: { verdict: 'NATIVE-DONE', note: 'static italian site native (fake 400 tolerated)' },
    komikindoid: { verdict: 'NATIVE-DONE', note: 'komikindo.ch native (local search over 5 catalog pages)' },
    natsuid: { verdict: 'NATIVE-DONE', note: 'natsu.one wp-json native' },
    blackarmy: { verdict: 'NATIVE-DONE', note: 'WP custom native (check_chapter ajax, nonce per page)' },
    shoujohearts: { verdict: 'NATIVE-DONE', note: 'Madara-over-http native + ajax/chapters' },
    mangahanta: { verdict: 'NATIVE-DONE', note: 'MangaVerse native (TR, mangaverse_load_more pagination)' },
    drakescans: { verdict: 'NATIVE-DONE', note: 'drakecomic.net RSC flight-data native' },
    'flamescans-org': { verdict: 'NATIVE-DONE', note: 'flamecomics.xyz __NEXT_DATA__ native' },
    azoraworld: { verdict: 'NATIVE-DONE', note: 'azorafly.com Astro island native (arabic)' },
    helveticascans: { verdict: 'NATIVE-DONE', note: 'MangAdventure API v2 native (assortedscans.com)' },
    bigcomics: { verdict: 'NATIVE-DONE', note: 'comici native (signed 30min urls, 4x4 scramble NOT descrambled)' },
    takecomic: { verdict: 'NATIVE-DONE', note: 'comici native (ex-Takeshobo sites merged here)' },
    kimicomi: { verdict: 'NATIVE-DONE', note: 'comici native (ex-ComicValkyrie merged here)' },
    mangalib: { verdict: 'NATIVE-DONE', note: 'api.cdnlibs.org native (Site-Id 1, imglib Referer)' },
    'shonenmagazine-pocket': { verdict: 'NATIVE-DONE', note: 'magapoke native (x-manga-hash empty-secret reproduced; scramble_seed NOT descrambled)' },
    mangadenizi: { verdict: 'NATIVE-DONE', note: 'JSON API native (tiled-v1 scramble NOT descrambled)' },
    mangagg: { verdict: 'NATIVE-DONE', note: 'Madara-variant native; Cloudflare needs the Docker browser session' },
    webcomicsapp: { verdict: 'NATIVE-DONE', note: 'Nuxt native; reader = JS render + programmatic scroll (63 pages verified)' },
    kumanga: { verdict: 'NATIVE-DONE', note: 'cookie-jar + CF-challenge reader native (hex-decoded eve.manga.tel)' },
    neteasecomic: { verdict: 'NATIVE-DONE', note: 'Bilibili rendered native (chapters verified; reader pages best-effort)' },
    mgkomik: { verdict: 'NATIVE-DONE', note: 'Madara native on id.mgkomik.cc; Cloudflare needs the Docker browser session' },
    gammaplus: { verdict: 'NATIVE-DONE', note: 'superseded by the native takecomic connector' },
    storiadash: { verdict: 'NATIVE-DONE', note: 'superseded by the native takecomic connector' },
    webcomicgamma: { verdict: 'NATIVE-DONE', note: 'superseded by the native takecomic connector' },
    comicvalkyrie: { verdict: 'NATIVE-DONE', note: 'superseded by the native kimicomi connector' },
    mangaeclipse: { verdict: 'NATIVE-DONE', note: 'wired as native MadaraConnector' },
    mangaowlio: { verdict: 'NATIVE-DONE', note: 'wired as native MadaraConnector' },
    manhwaclub: { verdict: 'NATIVE-DONE', note: 'wired as native MadaraConnector' }
};

function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

/** Family of a legacy connector: walk its `import X from './Y.mjs'` chain. */
function connectorFamily(id) {
    const files = fs.readdirSync(vendorDir).filter(f => f.endsWith('.mjs'));
    const byId = files.find(f => {
        const src = fs.readFileSync(path.join(vendorDir, f), 'utf8');
        return src.includes(`id = '${id}'`) || src.includes(`id="${id}"`);
    });
    if (!byId) return 'unknown';
    let current = byId;
    const seen = new Set();
    while (!seen.has(current) && current.endsWith('.mjs')) {
        seen.add(current);
        const src = fs.readFileSync(path.join(vendorDir, current), 'utf8');
        const parentClass = src.match(/export default class \w+ extends (\w+)/)?.[1];
        if (!parentClass) break;
        const parent = src.match(new RegExp(`import\\s+${parentClass}\\s+from\\s+'\\./([\\w./-]+)\\.mjs'`))?.[1];
        if (!parent || !fs.existsSync(path.join(vendorDir, `${parent}.mjs`))) break;
        current = `${parent}.mjs`;
    }
    return current.replace(/\.mjs$/, '');
}

const rows = triage.map(row => {
    const out = { id: row.id, label: row.label, url: row.url, cls: row.cls, error: row.error, verdict: null, newUrl: null, family: connectorFamily(row.id) };
    if (row.cls === 'dead') {
        const host = hostOf(row.url);
        const probe = host ? (httpProbe[host] ?? '') : '';
        const code = probe.split('|')[0];
        const redirect = probe.split('|')[1] || '';
        if (code === '302' || code === '301' || code === '307' || code === '308') {
            out.verdict = 'MOVED';
            out.newUrl = redirect || null;
        } else if (code === '200' || code === '403' || code === '405' || code === '401') {
            out.verdict = 'NATIVE-CANDIDATE';
            out.cls = `dead-but-up(${code})`;
        } else {
            out.verdict = 'DEAD';
        }
    } else if (row.cls === 'antibot' || row.cls === 'timeout') {
        out.verdict = 'UNTESTABLE';
    } else if (row.cls === 'http_5xx') {
        out.verdict = 'UNSTABLE';
    } else {
        out.verdict = 'NATIVE-CANDIDATE';
    }
    const manual = MANUAL[row.id];
    if (manual) {
        out.verdict = manual.verdict;
        out.note = manual.note;
    }
    return out;
});

fs.writeFileSync(path.join(here, 'triage-report.json'), JSON.stringify(rows, null, 2));

const order = [
    'NATIVE-DONE',
    'OVERRIDE-DONE',
    'FIXED-SHIM',
    'NATIVE-CANDIDATE',
    'NEEDS-TEMPLATE',
    'NEEDS-TEMPLATE-EXT',
    'NEEDS-CUSTOM',
    'NEEDS-PATCH',
    'PARTIAL',
    'NEEDS-PAGED-MODE',
    'NOVEL',
    'MOVED',
    'UNTESTABLE',
    'UNSTABLE',
    'DEAD',
    'missing'
];
const lines = ['# Triage des 310 sources broken (tanko)', ''];
for (const verdict of order) {
    const group = rows.filter(r => r.verdict === verdict);
    if (!group.length) continue;
    lines.push(`## ${verdict} — ${group.length}`, '');
    lines.push('| id | label | url | classe | famille | new url | note |', '|---|---|---|---|---|---|---|');
    for (const r of group) {
        lines.push(`| ${r.id} | ${String(r.label).replace(/\|/g, '/')} | ${r.url} | ${r.cls} | ${r.family} | ${r.newUrl ?? ''} | ${r.note ?? ''} |`);
    }
    lines.push('');
}
const families = {};
for (const r of rows.filter(r => r.verdict === 'NATIVE-CANDIDATE')) families[r.family] = (families[r.family] ?? 0) + 1;
lines.push('## Familles des candidats natifs', '');
for (const [f, n] of Object.entries(families).sort((a, b) => b[1] - a[1])) lines.push(`- ${f}: ${n}`);
fs.writeFileSync(path.join(here, 'triage-report.md'), lines.join('\n'));

for (const verdict of order) console.log(`${verdict.padEnd(16)} ${rows.filter(r => r.verdict === verdict).length}`);
