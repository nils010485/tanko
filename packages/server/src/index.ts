/**
 * Headless Hakuneko service entrypoint.
 * Boots: engine -> database -> event bus -> Fastify (REST + WS + dashboard).
 */
import fs from 'node:fs';
import Fastify from 'fastify';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { createEngine, loadConnectors, SourceRegistry } from '@tanko/core';
import type { DownloadStatus } from '@tanko/shared';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { EventBus } from './ws.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerDownloadRoutes } from './routes/downloads.js';
import { registerLibraryRoutes } from './routes/library.js';
import { FailoverService } from './library/failover.js';
import { CoverService } from './library/covers.js';
import { registerCoverRoutes } from './routes/covers.js';
import { registerSettingsRoutes, loadPersistedQueueSettings, createLanguagePreference } from './routes/settings.js';
import { registerSourceHealthRoutes } from './routes/source-health.js';
import { registerSourceUpdateRoutes } from './routes/sources-update.js';
import { registerImageRoutes } from './routes/images.js';
import { DownloadQueue, type QueueSettings } from './downloader/queue.js';
import { LibraryStore } from './library/store.js';
import { Scheduler } from './scheduler/scheduler.js';
import { SourceHealthService } from './sources/health.js';
import { registerImportRoutes } from './routes/import.js';
import { ImportService } from './import/service.js';
import { createCacheStore } from './cache/cache.js';
import { CachedSourceAdapter } from './cache/cached-adapter.js';

const config = loadConfig();

// --- engine ----------------------------------------------------------------
const engine = await createEngine({ dataDirectory: config.dataDirectory });
const { connectors, failures } = await loadConnectors();
console.log(`[engine] loaded ${connectors.length} connectors (${failures} failed)`);

// --- persistence + events ----------------------------------------------------
const database = new Database(config.dataDirectory);
const events = new EventBus();
const cacheStore = await createCacheStore(database, process.env.REDIS_URL);
const sourceRegistry = new SourceRegistry(adapter => new CachedSourceAdapter(adapter, cacheStore));
const persistedQueueSettings = loadPersistedQueueSettings(database);
const queueSettings: QueueSettings = {
    // persisted setting wins over the env default so a reboot keeps the
    // user-configured download destination
    dataDirectory: persistedQueueSettings.dataDirectory || config.dataDirectory,
    directoryLayout: persistedQueueSettings.directoryLayout || 'source',
    chapterFormat: persistedQueueSettings.chapterFormat || (process.env.CHAPTER_FORMAT === 'cbz' ? 'cbz' : 'img'),
    // NB: || (not ??) on concurrency is intentional — a persisted 0 must not
    // override the env default, while throttleMs 0 is a valid value (hence ??).
    concurrency: persistedQueueSettings.concurrency || Number(process.env.DOWNLOAD_CONCURRENCY || 2),
    throttleMs: persistedQueueSettings.throttleMs ?? Number(process.env.DOWNLOAD_THROTTLE_MS || 250)
};
const preferredLanguages = createLanguagePreference(database);
const library = new LibraryStore({ db: database, registry: sourceRegistry, queueSettings, getPreferredLanguages: preferredLanguages });
const covers = new CoverService({ db: database, events });
const healthService = new SourceHealthService({
    db: database,
    events,
    getAdapter: id => sourceRegistry.get(id),
    listAdapterIds: async () => (await sourceRegistry.list()).map(source => source.id)
});
const listSourceInfos = async () => {
    const sources = await sourceRegistry.list();
    const health = healthService.getAll();
    const hidden = healthService.getHiddenSet();
    return sources.map(source => ({
        id: source.id,
        label: source.label,
        tags: source.tags || [],
        kind: source.kind,
        health: health[source.id]?.status,
        hidden: hidden.has(source.id)
    }));
};
/** Library chapter status for each finished download-job status (absent = leave the chapter untouched). */
const CHAPTER_STATUS: Partial<Record<DownloadStatus, 'downloaded' | 'failed' | 'new'>> = {
    completed: 'downloaded',
    failed: 'failed',
    cancelled: 'new'
};
const queue = new DownloadQueue({
    db: database,
    registry: sourceRegistry,
    events,
    settings: queueSettings,
    onJobFinished: job => {
        if (job.entryId == null) {
            return;
        }
        const chapterStatus = CHAPTER_STATUS[job.status];
        if (chapterStatus) {
            // job.path is only ever set on completion, so failed/cancelled chapters keep a null path
            library.markChapter(job.entryId, job.chapterId, chapterStatus, job.path);
        }
        if (job.status === 'failed') {
            library.recordDownloadFailure(job.entryId);
        } else if (job.status === 'completed') {
            library.resetDownloadFailures(job.entryId);
        }
        if (job.status === 'completed' && covers.isEnabled() && !covers.hasCover(job.entryId)) {
            // first downloaded chapter of this series: fill the cover cache in the background
            void covers.generateForEntry(job.entryId).catch(() => undefined);
        }
        const entry = library.getEntry(job.entryId);
        if (entry) {
            events.publish({ type: 'library.updated', entry });
        }
    }
});
const failover = new FailoverService({
    registry: sourceRegistry,
    store: library,
    listSources: listSourceInfos,
    getPreferredLanguages: preferredLanguages
});
const scheduler = new Scheduler({ db: database, store: library, queue, events, failover });
const importer = new ImportService({
    db: database,
    registry: sourceRegistry,
    store: library,
    getPreferredLanguages: preferredLanguages,
    listSources: listSourceInfos
});

// --- http server -------------------------------------------------------------
const app = Fastify({ logger: false });
await app.register(fastifyWebsocket);

app.decorate('config', config);
app.decorate('database', database);
app.decorate('events', events);
app.decorate('engine', engine);
app.decorate('healthService', healthService);

registerHealthRoutes(app);
registerSourceRoutes(app, sourceRegistry);
registerSourceHealthRoutes(app, healthService);
registerSourceUpdateRoutes(app, config, database);
registerDownloadRoutes(app, queue, sourceRegistry);
registerLibraryRoutes(app, library, scheduler, queue, events, failover, covers);
registerSettingsRoutes(app, queue, database, covers);
registerCoverRoutes(app, covers);
registerImageRoutes(app);
registerImportRoutes(app, importer);

// WebSocket endpoint: dashboard live events
app.register(async fastify => {
    fastify.get('/ws', { websocket: true }, (socket: WebSocket) => {
        events.attach(socket);
    });
});

// Deploy automation: IMPORT_PATH triggers an unattended import at startup;
// skipped on reboots once a job for the same path has completed.
if (config.importPath) {
    const previous = importer.status();
    const alreadyDone = previous.job && previous.job.root === config.importPath && previous.job.status === 'done';
    if (alreadyDone) {
        console.log(`[import] ${config.importPath} déjà importé (job #${previous.job.id}) — saut de l'auto-import`);
    } else {
        console.log(`[import] auto-import of ${config.importPath} (confirm=${config.importAutoConfirm}, autoDownload=${config.importAutoDownload})`);
        importer.start(config.importPath, {
            autoConfirm: config.importAutoConfirm,
            autoDownload: config.importAutoDownload
        }).catch(error => console.error('[import] auto-import failed:', error));
    }
}

// note: a job that finds 0 series ends in 'error' (never 'done'), so a boot
// where the library mount was not ready yet simply retries next time.

// Serve the dashboard (SPA) when it has been built
if (fs.existsSync(config.dashboardDirectory)) {
    await app.register(fastifyStatic, { root: config.dashboardDirectory });
    app.setNotFoundHandler((request, reply) => {
        if (request.method === 'GET' && !request.url.startsWith('/api')) {
            return reply.sendFile('index.html');
        }
        return reply.code(404).send({ error: 'Not found' });
    });
} else {
    console.warn('[server] dashboard build not found — run the dashboard build to enable the web UI');
}

// Background health probe for the (few) native sources at startup
healthService.probeNative().catch(error => console.warn('[health] native probe failed:', error));

await app.listen({ host: config.host, port: config.port });
console.log(`[server] listening on http://${config.host}:${config.port} (data: ${config.dataDirectory})`);

// --- graceful shutdown -------------------------------------------------------
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
        console.log(`[server] received ${signal}, shutting down...`);
        queue.stop();
        scheduler.stop();
        await app.close();
        await cacheStore.close();
        database.close();
        process.exit(0);
    });
}

declare module 'fastify' {
    interface FastifyInstance {
        config: typeof config;
        database: Database;
        events: EventBus;
        engine: Awaited<ReturnType<typeof createEngine>>;
        healthService: SourceHealthService;
    }
}
