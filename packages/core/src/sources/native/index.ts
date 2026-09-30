/**
 * Curated native connectors registered by default (before the legacy adapters).
 */
import type { SourceAdapter } from '../types.js';
import { AssortedScansConnector } from './assortedscans.js';
import { AsuraScansConnector } from './asurascans.js';
import { AzoraFlyConnector } from './azorofly.js';
import { BilibiliManhuaConnector } from './bilibili.js';
import { BlackArmyConnector } from './blackarmy.js';
import { ComiciConnector } from './comici.js';
import { comick as comickConnector } from './comick.js';
import { ComizyConnector } from './comizy.js';
import { config } from './config.js';
import { DrakeScansConnector } from './drakescans.js';
import { FlameScansConnector } from './flamescans.js';
import { FoolSlideConnector } from './foolslide.js';
import { GigaViewerConnector } from './gigaviewer.js';
import { HeavenMangaConnector } from './heavenmanga.js';
import { HentaiHandConnector } from './hentaihand.js';
import { KomikIndoConnector } from './komikindo.js';
import { KuMangaConnector } from './kumanga.js';
import { LineWebtoonConnector } from './linewebtoon.js';
import { MadaraConnector } from './madara.js';
import { MagaPokeConnector } from './magapoke.js';
import { MangadeniziConnector } from './mangadenizi.js';
import { MangaDexConnector } from './mangadex.js';
import { MangaGGConnector } from './mangagg.js';
import { MangaHantaConnector } from './mangahanta.js';
import { MangalibConnector } from './mangalib.js';
import { MangaPillConnector } from './mangapill.js';
import { MangastreamConnector } from './mangastream.js';
import { MangaToonConnector } from './mangatoon.js';
import { NatsuOneConnector } from './natsuone.js';
import { ShoujoHeartsConnector } from './shoujohearts.js';
import { TappytoonConnector } from './tappytoon.js';
import { ThreeHentaiConnector } from './threehentai.js';
import { VComicsConnector } from './vcomics.js';
import { WebComicsAppConnector } from './webcomicsapp.js';
import { ZeurelScanConnector } from './zeurelscan.js';

export function createNativeConnectors(): SourceAdapter[] {
    return [
        new MangaDexConnector(),
        new AsuraScansConnector(),
        new VComicsConnector(
            config('hivetoons', {
                id: 'hivetoons',
                label: 'HiveToons',
                base: 'https://hivetoons.org',
                tags: ['webtoon', 'english', 'manhwa']
            })
        ),
        new MadaraConnector(
            config('toonily', {
                id: 'toonily',
                label: 'Toonily',
                base: 'https://toonily.com',
                tags: ['webtoon', 'english', 'manhwa']
            })
        ),
        new MadaraConnector(
            config('mangadistrict', {
                id: 'mangadistrict',
                label: 'Manga District',
                base: 'https://mangadistrict.com',
                tags: ['manga', 'english', 'manhua']
            })
        ),
        // search page fallback covers NoAjax Madara sites (ToonGod, KunManga)
        new MadaraConnector(
            config('toongod', {
                id: 'toongod',
                label: 'ToonGod',
                base: 'https://www.toongod.org',
                tags: ['webtoon', 'english', 'manhwa']
            })
        ),
        new MadaraConnector(
            config('kunmanga', {
                id: 'kunmanga',
                label: 'KunManga',
                base: 'https://www.kunmanga.online',
                chapterApiPath: '/api/comics',
                tags: ['webtoon', 'english']
            })
        ),
        // theme decodes chapter pages client-side (blob:) -> capture mode
        new MadaraConnector(
            config('raijinscans', {
                id: 'raijinscans',
                label: 'Raijin Scans',
                base: 'https://raijin-scans.fr',
                capturePages: true,
                tags: ['manga', 'french', 'webtoon']
            })
        ),
        // Aqua theme renamed the Madara classes (aqua-*)
        new MadaraConnector(
            config('aquareader', {
                id: 'aquareader',
                label: 'Aqua Manga',
                base: 'https://aquareader.org',
                tags: ['manga', 'english', 'manhua'],
                selectors: { chapters: '.aqua-ch-item', chapterAnchor: '' }
            })
        ),
        // broken-legacy rescues verified end-to-end by scripts/probe-madara-e2e.mjs
        new MadaraConnector(
            config('apollcomics', {
                id: 'apollcomics',
                label: 'Apoll Comics',
                base: 'https://apollcomics.es',
                tags: ['manga', 'spanish']
            })
        ),
        new MadaraConnector(
            config('arthurscan', {
                id: 'arthurscan',
                label: 'Arthur Scan',
                base: 'https://arthurscan.xyz',
                tags: ['manga', 'portuguese']
            })
        ),
        new MadaraConnector(
            config('asurascans-tr', {
                id: 'asurascans-tr',
                label: 'Asura Scans (TR)',
                base: 'https://asurascans.com.tr',
                tags: ['manga', 'turkish', 'webtoon']
            })
        ),
        new MadaraConnector(
            config('decadencescans', {
                id: 'decadencescans',
                label: 'Decadence Scans',
                base: 'https://reader.decadencescans.com',
                tags: ['manga', 'english']
            })
        ),
        new MadaraConnector(
            config('mangareadco', {
                id: 'mangareadco',
                label: 'Manga Read',
                base: 'https://www.mangaread.org',
                tags: ['manga', 'english']
            })
        ),
        new MadaraConnector(
            config('coffeemanga', {
                id: 'coffeemanga',
                label: 'Coffee Manga',
                base: 'https://coffeemanga.net',
                tags: ['manga', 'english']
            })
        ),
        new MangastreamConnector(
            config('mangasusureborn', {
                id: 'mangasusureborn',
                label: 'MangaSusu',
                base: 'https://mangasusuku.com',
                path: '/komik/list-mode/',
                tags: ['manga', 'indonesian']
            })
        ),
        new MadaraConnector(
            config('opiatoon', {
                id: 'opiatoon',
                label: 'Opiatoon',
                base: 'https://opiatoon.shop',
                tags: ['manga', 'turkish', 'yaoi', 'yuri']
            })
        ),
        new GigaViewerConnector(
            config('comicaction', {
                id: 'comicaction',
                label: 'Comic Action',
                base: 'https://comic-action.com',
                paths: ['/series', '/series/oneshot', '/series/manga-action'],
                tags: ['manga', 'japanese']
            })
        ),
        new GigaViewerConnector(
            config('youngjump', {
                id: 'youngjump',
                label: 'Tonari no Young Jump',
                base: 'https://tonarinoyj.jp',
                paths: ['/series', '/series/oneshot', '/series/trial'],
                tags: ['manga', 'japanese']
            })
        ),
        new FoolSlideConnector(
            config('deathtollscans', {
                id: 'deathtollscans',
                label: 'DeathToll Scans',
                base: 'https://reader.deathtollscans.net',
                tags: ['manga', 'english']
            })
        ),
        new MangaToonConnector(config('mangatoon-en', { id: 'mangatoon-en', label: 'MangaToon (English)', language: 'en' as const })),
        new MangaToonConnector(
            config('mangatoon-cn', { id: 'mangatoon-cn', label: 'MangaToon (Chinese)', language: 'cn' as const, tags: ['manga', 'chinese'] })
        ),
        new MangaToonConnector(
            config('mangatoon-id', { id: 'mangatoon-id', label: 'MangaToon (Indonesian)', language: 'id' as const, tags: ['manga', 'indonesian'] })
        ),
        new MangaToonConnector(
            config('mangatoon-vi', { id: 'mangatoon-vi', label: 'MangaToon (Vietnamese)', language: 'vi' as const, tags: ['manga', 'vietnamese'] })
        ),
        comickConnector,
        new ComizyConnector(),
        new HentaiHandConnector(),
        new TappytoonConnector(),
        new MangaPillConnector(),
        new HeavenMangaConnector(),
        new LineWebtoonConnector(),
        new ThreeHentaiConnector(),
        new ZeurelScanConnector(),
        new KomikIndoConnector(config('komikindoid', { id: 'komikindoid', label: 'KomikIndo', base: 'https://komikindo.ch' })),
        new NatsuOneConnector(config('natsuid', { id: 'natsuid', label: 'Natsu', base: 'https://natsu.one' })),
        new BlackArmyConnector(config('blackarmy', { id: 'blackarmy', label: 'Black Army', base: 'https://blackarmy.fr' })),
        new ShoujoHeartsConnector(config('shoujohearts', { id: 'shoujohearts', label: 'Shoujo Hearts', base: 'http://shoujohearts.net' })),
        new MangaHantaConnector(config('mangahanta', { id: 'mangahanta', label: 'MangaHanta', base: 'https://www.mangahanta.com' })),
        new DrakeScansConnector(),
        new FlameScansConnector(),
        new AzoraFlyConnector(),
        new AssortedScansConnector(),
        new ComiciConnector(config('bigcomics', { id: 'bigcomics', label: 'BIG COMICS', base: 'https://bigcomics.jp', tags: ['manga', 'japanese'] })),
        new ComiciConnector(
            config('takecomic', { id: 'takecomic', label: 'Takeshobo (takecomic)', base: 'https://takecomic.jp', tags: ['manga', 'japanese'] })
        ),
        new ComiciConnector(config('kimicomi', { id: 'kimicomi', label: 'Kimi to Comic', base: 'https://kimicomi.com', tags: ['manga', 'japanese'] })),
        new MangalibConnector(),
        new MagaPokeConnector(),
        new MangadeniziConnector(),
        new MangaGGConnector(),
        new WebComicsAppConnector(),
        new KuMangaConnector(),
        new BilibiliManhuaConnector(),
        new MadaraConnector(
            config('mgkomik', {
                id: 'mgkomik',
                label: 'MG Komik',
                base: 'https://id.mgkomik.cc',
                tags: ['manga', 'indonesian']
            })
        ),
        new MadaraConnector(
            config('mangaeclipse', {
                id: 'mangaeclipse',
                label: 'Manga Eclipse',
                base: 'https://mangaeclipse.com',
                tags: ['manga', 'english']
            })
        ),
        new MadaraConnector(
            config('mangaowlio', {
                id: 'mangaowlio',
                label: 'MangaOwl.io',
                base: 'https://mangaowl.io',
                tags: ['manga', 'english']
            })
        ),
        new MadaraConnector(
            config('manhwaclub', {
                id: 'manhwaclub',
                label: 'ManhwaClub',
                base: 'https://manhwaclub.net',
                tags: ['webtoon', 'english', 'manhwa']
            })
        ),
        new MadaraConnector(
            config('webtoonscan', {
                id: 'webtoonscan',
                label: 'WebtoonScan',
                base: 'https://webtoonscan.com',
                tags: ['webtoon', 'english', 'manhwa']
            })
        ),
        // "mangomic" theme renamed the Madara classes and decodes reader pages client-side
        new MadaraConnector(
            config('manhwaread', {
                id: 'manhwaread',
                label: 'ManhwaRead',
                base: 'https://manhwaread.com',
                capturePages: true,
                captureImagePattern: /https?:\/\/[^\s"'\\]+?\/mr_(\d+)\.(?:jpe?g|png|webp|avif)/gi,
                selectors: {
                    searchRows: '.manga-item',
                    searchTitle: 'a.manga-item__link',
                    chapters: 'a.chapter-item',
                    chapterAnchor: ''
                },
                tags: ['webtoon', 'english', 'manhwa', 'adult']
            })
        ),
        // FR aggregator, moved from manga-scantrad.net (dead) to .io; native registration shadows the dead legacy connector
        new MadaraConnector(
            config('mangascantrad', {
                id: 'mangascantrad',
                label: 'Manga-Scantrad',
                base: 'https://manga-scantrad.io',
                tags: ['manga', 'french']
            })
        )
    ];
}
