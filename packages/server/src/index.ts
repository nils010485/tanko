/**
 * Headless Hakuneko service entrypoint.
 * Boots: engine -> database -> event bus -> Fastify (REST + WS + dashboard).
 */
import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket, { type WebSocket } from '@fastify/websocket';
import { createEngine, loadConnectors, SourceRegistry } from '@tanko/core';
import type { DownloadJobDto, DownloadStatus } from '@tanko/shared';
import Fastify from 'fastify';
import { ActivityService } from './activity/service.js';
import { CachedSourceAdapter } from './cache/cached-adapter.js';
import { SqliteCacheStore } from './cache/sqlite-store.js';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { DownloadQueue, type QueueSettings } from './downloader/queue.js';
import { ImportService } from './import/service.js';
import { CoverService } from './library/covers.js';
import { DOWNLOAD_FAILOVER_FAILURES, FailoverService, SOURCE_OUTAGE_ENTRIES, SOURCE_OUTAGE_WINDOW_MS } from './library/failover.js';
import { LibraryStore } from './library/store.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerCoverRoutes } from './routes/covers.js';
import { registerDownloadRoutes } from './routes/downloads.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerImageRoutes } from './routes/images.js';
import { registerImportRoutes } from './routes/import.js';
import { registerLibraryRoutes } from './routes/library.js';
import { createIncompleteDetectionPref, createLanguagePreference, loadPersistedQueueSettings, registerSettingsRoutes } from './routes/settings.js';
import { registerSourceHealthRoutes } from './routes/source-health.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerSourceUpdateRoutes } from './routes/sources-update.js';
import { Scheduler } from './scheduler/scheduler.js';
import { GlobalSearchService } from './sources/global-search.js';
import { SourceHealthService } from './sources/health.js';
import { EventBus } from './ws.js';

const config = loadConfig();

// --- engine ----------------------------------------------------------------
const engine = await createEngine({ dataDirectory: config.dataDirectory });
const { connectors, failures } = await loadConnectors();
console.log(`[engine] loaded ${connectors.length} connectors (${failures} failed)`);

// --- persistence + events ----------------------------------------------------
const database = new Database(config.dataDirectory);
const events = new EventBus();
const activity = new ActivityService({ db: database });
// every `log` event is persisted; the returned row id tags the broadcast copy
events.setLogSink(({ level, message, at }) => activity.add(level, message, at));
const cacheStore = new SqliteCacheStore(database);
const sourceRegistry = new SourceRegistry(adapter => new CachedSourceAdapter(adapter, cacheStore));
const persistedQueueSettings = loadPersistedQueueSettings(database);
const queueSettings: QueueSettings = {
    // persisted settings win over the built-in defaults so a reboot keeps the
    // user-configured values (all editable in the Settings tab)
    dataDirectory: persistedQueueSettings.dataDirectory || config.dataDirectory,
    directoryLayout: persistedQueueSettings.directoryLayout || 'source',
    chapterFormat: persistedQueueSettings.chapterFormat || 'cbz',
    // NB: || (not ??) on the concurrency fields is intentional — a persisted 0
    // must not override the default, while throttleMs 0 is a valid value (hence ??).
    // Old installs only knew "concurrency": it becomes the per-source cap.
    parallelSources: persistedQueueSettings.parallelSources || 2,
    concurrencyPerSource: persistedQueueSettings.concurrencyPerSource || persistedQueueSettings.concurrency || 2,
    throttleMs: persistedQueueSettings.throttleMs ?? 250,
    historyRetentionDays: persistedQueueSettings.historyRetentionDays ?? 30
};
const preferredLanguages = createLanguagePreference(database);
const library = new LibraryStore({ db: database, registry: sourceRegistry, queueSettings, getPreferredLanguages: preferredLanguages });
const covers = new CoverService({ db: database, events, directoryOf: entryId => library.seriesDirectory(entryId) });
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
/** Library chapter status for each finished download-job status (absent = handled separately). */
const CHAPTER_STATUS: Partial<Record<DownloadStatus, 'downloaded' | 'failed'>> = {
    completed: 'downloaded',
    failed: 'failed'
};
const failover = new FailoverService({
    registry: sourceRegistry,
    store: library,
    listSources: listSourceInfos,
    getPreferredLanguages: preferredLanguages,
    isDetectionEnabled: createIncompleteDetectionPref(database)
});

const queue = new DownloadQueue({
    db: database,
    registry: sourceRegistry,
    events,
    settings: queueSettings,
    onJobFinished: job => {
        if (job.entryId == null) {
            return;
        }
        if (job.status === 'cancelled') {
            // a cancel restores the pre-queue status ('missing' stays out of the new-chapter badge)
            library.revertCancelledChapter(job.entryId, job.chapterId);
        } else {
            const chapterStatus = CHAPTER_STATUS[job.status];
            if (chapterStatus) {
                // job.path is only ever set on completion, so failed chapters keep a null path
                library.markChapter(job.entryId, job.chapterId, chapterStatus, job.path);
            }
        }
        if (job.status === 'failed') {
            handleDownloadFailure(job);
        }
        if (job.status === 'completed' && covers.isEnabled() && !covers.hasCover(job.entryId)) {
            // first downloaded chapter of this series: fill the cover cache in the background
            void covers.generateForEntry(job.entryId).catch(() => undefined);
        }
        const entry = library.getEntry(job.entryId);
        if (entry) {
            events.publish({ type: 'library.updated', entry });
        }
    },
    /** "Clear queue" drops the jobs without finishing them — put the chapters back. */
    onJobsCleared: pairs => library.revertClearedChapters(pairs)
});

/** A hard download failure on one entry: probe the alternative sources right
 *  away instead of waiting for the next scheduler run (hours later). When a
 *  migration is applied, the failed chapters are re-queued on the new source
 *  so the interrupted download resumes by itself. */
function handleDownloadFailure(job: DownloadJobDto): void {
    const { entryId } = job;
    if (entryId == null) {
        return;
    }
    // the entry may have been deleted since its downloads were queued —
    // recordDownloadFailure must not run against a missing row
    const entry = library.getEntry(entryId);
    if (!entry) {
        return;
    }

    // several entries of the same source failing together = temporary outage,
    // not per-series rot: suspend migration, the queue's auto-retry will heal
    // the failed jobs when the source comes back
    const outageEntries = library.countRecentSourceFailures(entry.sourceId, SOURCE_OUTAGE_WINDOW_MS);
    if (outageEntries >= SOURCE_OUTAGE_ENTRIES) {
        if (failover.tryBeginProbe(entryId)) {
            events.publish({
                type: 'log',
                level: 'warn',
                message: `"${entry.title}" : panne de la source ${entry.sourceLabel} (${outageEntries} séries en échec) — migration suspendue, les échecs seront retentés automatiquement`,
                at: new Date().toISOString()
            });
            failover.endProbe(entryId);
        }
        return;
    }
    const failures = library.recordDownloadFailure(entryId);
    // sibling jobs may still settle (their own finish events re-arm the probe)
    // or the entry sits in its probe cooldown
    if (failures < DOWNLOAD_FAILOVER_FAILURES || queue.hasPendingJobs(entryId) || !failover.tryBeginProbe(entryId)) {
        return;
    }
    void (async () => {
        try {
            const outcome = await failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
            events.publish({
                type: 'log',
                level: outcome === 'migrated' ? 'info' : 'warn',
                message:
                    outcome === 'migrated'
                        ? `"${entry.title}" : ${failures} téléchargements en échec — migré vers une autre source, reprise du téléchargement`
                        : outcome === 'suggested'
                          ? `"${entry.title}" : ${failures} téléchargements en échec — migration de source suggérée (à confirmer)`
                          : `"${entry.title}" : ${failures} téléchargements en échec — aucune source de rechange trouvée`,
                at: new Date().toISOString()
            });
            if (outcome === 'migrated') {
                library.requeueFailedAfterMigration(entryId, queue);
            }
        } catch (error) {
            console.warn(`[failover] "${entry.title}":`, (error as Error).message);
        } finally {
            // implicit backoff: the cooldown in tryBeginProbe plus this reset
            // keep a dead source from re-arming a probe on every failure
            library.resetDownloadFailures(entryId);
            failover.endProbe(entryId);
            const updated = library.getEntry(entryId);
            if (updated) {
                events.publish({ type: 'library.updated', entry: updated });
            }
        }
    })();
}

const scheduler = new Scheduler({ db: database, store: library, queue, events, failover });
const importer = new ImportService({
    db: database,
    registry: sourceRegistry,
    store: library,
    getPreferredLanguages: preferredLanguages,
    listSources: listSourceInfos
});

const globalSearch = new GlobalSearchService({
    getAdapter: id => sourceRegistry.get(id),
    getPreferredLanguages: preferredLanguages,
    listSources: async () => {
        const hidden = healthService.getHiddenSet();
        return (await sourceRegistry.list())
            .filter(source => !hidden.has(source.id))
            .map(source => ({ id: source.id, label: source.label, kind: source.kind, tags: source.tags }));
    }
});

// --- http server -------------------------------------------------------------
const app = Fastify({ logger: false });
await app.register(fastifyWebsocket);

app.decorate('config', config);
app.decorate('database', database);
app.decorate('events', events);
app.decorate('engine', engine);
app.decorate('healthService', healthService);
app.decorate('globalSearch', globalSearch);
registerHealthRoutes(app);
registerActivityRoutes(app, activity);
registerSourceRoutes(app, sourceRegistry, preferredLanguages);
registerSourceHealthRoutes(app, healthService);
registerSourceUpdateRoutes(app, config, database);
registerDownloadRoutes(app, queue, sourceRegistry, library);
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
        importer
            .start(config.importPath, {
                autoConfirm: config.importAutoConfirm,
                autoDownload: config.importAutoDownload
            })
            .catch(error => console.error('[import] auto-import failed:', error));
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
        globalSearch: GlobalSearchService;
    }
}
