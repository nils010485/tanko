import { type MangaInfo, type SourceAdapter, SourceError, type SourceRegistry } from '@tanko/core';
import type { ChapterDto, MangaDto, SourceDto } from '@tanko/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { adultAllowed, chapterAllowed, mangaLanguagesAllowed } from '../languages.js';
import { assertPublicHttpUrl, fetchGuarded, readBodyCapped } from '../util/net-guard.js';

function handleSourceError(reply: FastifyReply, error: unknown) {
    if (error instanceof SourceError) {
        return reply.code(502).send({ error: error.message, details: 'source' });
    }
    console.error('[sources]', error);
    const message = error instanceof Error && error.message ? error.message : 'erreur inattendue';
    return reply.code(502).send({ error: `La source n'a pas répondu correctement : ${message}`, details: 'source' });
}

/** Resolve a source or reply 404; null means the reply has already been sent. */
async function requireSource(reply: FastifyReply, sourceRegistry: SourceRegistry, sourceId: string): Promise<SourceAdapter | null> {
    const source = await sourceRegistry.get(sourceId);
    if (!source) {
        reply.code(404).send({ error: `Source "${sourceId}" not found` });
        return null;
    }
    return source;
}

/** Shared route body for /search, /chapters and /pages: 404 on unknown source, 502 mapping on source errors. */
async function withSource(
    reply: FastifyReply,
    sourceRegistry: SourceRegistry,
    sourceId: string,
    run: (source: SourceAdapter) => Promise<unknown>
): Promise<unknown> {
    const source = await requireSource(reply, sourceRegistry, sourceId);
    if (!source) {
        return reply;
    }
    try {
        return await run(source);
    } catch (error) {
        return handleSourceError(reply, error);
    }
}

// Best-effort cover enrichment for MangaDex: the legacy catalog only carries
// id+title, so we batch-resolve cover_art from the public API to show thumbnails.
interface MangaDexResponse {
    data?: Array<{
        id: string;
        relationships?: Array<{ type?: string; attributes?: { fileName?: string } }>;
    }>;
}

async function enrichMangaDexCovers(mangas: MangaInfo[]): Promise<void> {
    try {
        const ids = mangas.map(m => m.id).filter((id): id is string => typeof id === 'string');
        if (ids.length === 0) return;
        const url = new URL('https://api.mangadex.org/manga');
        url.searchParams.set('limit', String(ids.length));
        for (const id of ids) url.searchParams.append('ids[]', id);
        url.searchParams.append('includes[]', 'cover_art');
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const json: MangaDexResponse = await response.json();
        const covers = new Map<string, string>();
        for (const item of json.data || []) {
            const rel = (item.relationships || []).find(r => r.type === 'cover_art');
            if (rel?.attributes?.fileName) {
                covers.set(item.id, `https://uploads.mangadex.org/covers/${item.id}/${rel.attributes.fileName}.256.jpg`);
            }
        }
        for (const manga of mangas) {
            if (covers.has(manga.id)) manga.thumbnail = covers.get(manga.id);
        }
    } catch {
        /* covers are best-effort */
    }
}

/** Minimal shape of the caching decorator around a legacy connector (engine RequestOptions). */
interface ConnectorHolder {
    connector?: { requestOptions?: RequestInit };
    inner?: { connector?: { requestOptions?: RequestInit } };
}

/** Global Engine injected by the boot shims (legacy fetch honouring connector requestOptions). */
type EngineGlobal = typeof globalThis & { Engine: { Request: { fetch: (request: Request) => Promise<Response> } } };
/** Hard cap on proxied page images (memory safety). */
const MAX_PAGE_IMAGE_BYTES = 8 * 1024 * 1024;

/** Fetch a page image: connector:// indirection, legacy engine fetch, or plain fetch with browser-ish headers. */
async function fetchPageImage(url: string, source: SourceAdapter | undefined): Promise<Response> {
    if (url.startsWith('connector://')) {
        return fetch(url);
    }
    // SSRF guard: entry URL must resolve publicly; the plain-fetch branch
    // re-checks every redirect hop (the legacy engine's internal redirects are not)
    await assertPublicHttpUrl(url);
    if (source && source.kind === 'legacy') {
        // unwrap caching decorator to reach the legacy connector (requestOptions)
        const holder = source as unknown as ConnectorHolder;
        const connector = holder.connector || holder.inner?.connector;
        const legacyRequest = new Request(url, connector?.requestOptions);
        const response = await (globalThis as EngineGlobal).Engine.Request.fetch(legacyRequest);
        // the legacy engine follows redirects internally and cannot be
        // hop-checked: the final URL is the last guard available — refuse to
        // serve bodies that ended up on a private address
        await assertPublicHttpUrl(response.url || url);
        return response;
    }
    return fetchGuarded(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0',
            Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
            Referer: source?.url ? `${source.url}/` : url
        },
        signal: AbortSignal.timeout(60000)
    });
}

export function registerSourceRoutes(
    app: FastifyInstance,
    sourceRegistry: SourceRegistry,
    getPreferredLanguages: () => string[] = () => [],
    getHideAdultSources: () => boolean = () => false
): void {
    app.get('/api/sources', async (): Promise<SourceDto[]> => {
        const sources = await sourceRegistry.list();
        const hideAdult = getHideAdultSources();
        const visible = sources.filter(source => adultAllowed(source.tags || [], hideAdult));
        const health = app.healthService ? app.healthService.getAll() : {};
        const hidden = app.healthService ? app.healthService.getHiddenSet() : new Set<string>();
        return visible.map(source => {
            const record = health[source.id];
            return {
                id: source.id,
                label: source.label,
                tags: source.tags || [],
                kind: source.kind,
                url: source.url,
                health: record?.status || 'untested',
                healthLatencyMs: record?.latencyMs,
                healthCheckedAt: record?.checkedAt,
                healthVia: record?.via,
                hidden: hidden.has(source.id)
            };
        });
    });

    // Hide every source whose last health check failed (re-surfaced by a full re-check)
    app.post('/api/sources/hide-broken', async () => {
        const count = app.healthService ? app.healthService.hideBroken() : 0;
        return { hidden: count };
    });

    app.get<{ Params: { sourceId: string }; Querystring: { q?: string } }>('/api/sources/:sourceId/search', async (request, reply) => {
        const { sourceId } = request.params;
        const query = (request.query.q || '').trim();
        if (!query) {
            return reply.code(400).send({ error: 'Query parameter "q" is required' });
        }
        return withSource(reply, sourceRegistry, sourceId, async source => {
            const mangas = await source.searchMangas(query);
            // drop titles known (native MangaDex metadata) to lack chapters in
            // the preferred languages — they would list 0 chapters later
            const allowed = mangas.filter(manga => mangaLanguagesAllowed(manga.languages, getPreferredLanguages()));
            // native MangaDex emits one entry per title/alt-title (import matching
            // relies on it): display keeps a single card per manga
            const unique = new Map<string, MangaInfo>();
            for (const manga of allowed) {
                if (!unique.has(String(manga.id))) {
                    unique.set(String(manga.id), manga);
                }
            }
            const sliced = [...unique.values()].slice(0, 50);
            if (sourceId === 'mangadex') {
                await enrichMangaDexCovers(sliced);
            }
            return sliced.map(
                (manga): MangaDto => ({
                    sourceId,
                    id: manga.id,
                    title: manga.title,
                    url: manga.url,
                    thumbnail: manga.thumbnail
                })
            );
        });
    });

    // Global search across every visible source: returns a jobId, poll the
    // route below for progressive per-source results
    app.post<{ Body: { q?: string } }>('/api/sources/search-all', async (request, reply) => {
        const query = String(request.body?.q || '').trim();
        if (!query) {
            return reply.code(400).send({ error: 'Body field "q" is required' });
        }
        return app.globalSearch.start(query);
    });

    app.get<{ Params: { jobId: string } }>('/api/sources/search-all/:jobId', async (request, reply) => {
        const jobId = Number(request.params.jobId);
        const status = Number.isInteger(jobId) && jobId > 0 ? app.globalSearch.get(jobId) : undefined;
        if (!status) {
            return reply.code(404).send({ error: `Search job "${request.params.jobId}" not found` });
        }
        return status;
    });

    app.get<{ Params: { sourceId: string }; Querystring: { mangaId?: string; title?: string } }>('/api/sources/:sourceId/chapters', async (request, reply) => {
        const { sourceId } = request.params;
        const mangaId = request.query.mangaId;
        const title = request.query.title || mangaId || '';
        if (!mangaId) {
            return reply.code(400).send({ error: 'Query parameter "mangaId" is required' });
        }
        return withSource(reply, sourceRegistry, sourceId, async source => {
            const preferred = getPreferredLanguages();
            const chapters = await source.getChapters({ id: mangaId, title });
            // multi-lingual sources (MangaDex, ...) carry the same chapter in
            // many languages: keep only the preferred ones, like library ingestion
            const filtered = chapters.filter(chapter => chapterAllowed(chapter.language, preferred));
            return filtered.map(
                (chapter): ChapterDto => ({
                    sourceId,
                    mangaId,
                    id: chapter.id,
                    title: chapter.title,
                    language: chapter.language
                })
            );
        });
    });

    // Page image URLs of a chapter (for the quality preview in the dashboard)
    app.get<{ Params: { sourceId: string }; Querystring: { mangaId?: string; chapterId?: string; mangaTitle?: string; chapterTitle?: string } }>(
        '/api/sources/:sourceId/pages',
        async (request, reply) => {
            const { sourceId } = request.params;
            const { mangaId, chapterId, mangaTitle, chapterTitle } = request.query;
            if (!mangaId || !chapterId) {
                return reply.code(400).send({ error: 'Query parameters "mangaId" and "chapterId" are required' });
            }
            return withSource(reply, sourceRegistry, sourceId, async source => {
                const pages = await source.getPages({ id: mangaId, title: mangaTitle || mangaId }, { id: chapterId, title: chapterTitle || chapterId });
                return { pages };
            });
        }
    );

    // Proxy a chapter page image so the browser can preview it regardless of
    // hotlink protection or connector:// indirection (adds referer/cookies).
    // NB: unlike /search, /chapters and /pages, no 404 when the source is
    // unknown: the plain-fetch fallback keeps the proxy usable regardless.
    app.get<{ Params: { sourceId: string }; Querystring: { url?: string } }>('/api/sources/:sourceId/page-image', async (request, reply) => {
        const { sourceId } = request.params;
        const url = request.query.url;
        if (!url) {
            return reply.code(400).send({ error: 'Query parameter "url" is required' });
        }
        const source = await sourceRegistry.get(sourceId);
        try {
            const response = await fetchPageImage(url, source);
            if (!response.ok) {
                return reply.code(502).send({ error: `HTTP ${response.status}` });
            }
            const buffer = await readBodyCapped(response, MAX_PAGE_IMAGE_BYTES);
            reply.header('Content-Type', response.headers.get('content-type') || 'image/jpeg');
            reply.header('Cache-Control', 'public, max-age=3600');
            return reply.send(buffer);
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });
}
