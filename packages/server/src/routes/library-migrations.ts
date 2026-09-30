/**
 * Library routes — migrations: manual and bulk source re-matches, migration
 * suggestions (confirm/dismiss), manual migration and rollback. Extracted
 * from routes/library.ts, which registers the whole library API.
 */
import type { SourceAlternativeDto } from '@tanko/shared';
import type { FastifyInstance } from 'fastify';
import { INCOMPLETE_SOURCE_CHAPTERS } from '../library/failover.js';
import { failoverDetail } from '../scheduler/notify.js';
import type { LibraryRouteDeps } from './library.js';
import { assertNoRunningDownloads, requireEntry, requireFailover } from './library-entries.js';

export function registerLibraryMigrationsRoutes(app: FastifyInstance, deps: LibraryRouteDeps): void {
    const { store, queue, events, failover, jobs, scheduler } = deps;
    const publishEntry = deps.publishEntry;

    // Re-match every entry whose source keeps failing (bulk failover, cached catalogs)
    app.post('/api/library/rematch-failed', async (_request, reply) => {
        if (!failover) {
            return requireFailover(reply);
        }
        const entries = (await store.listEntries()).filter(entry => (entry.checkFailures ?? 0) > 0);
        return jobs.runBulk(events, {
            label: 'Re-match',
            recapHits: 'migration(s)',
            category: 'failover',
            prefix: 'failover.rematch',
            entries,
            action: async entry => {
                // leave the entry failed so the next bulk run picks it up again
                if (queue.hasPendingJobs(entry.id)) {
                    return { outcome: 'skipped', detail: 'ignorée (téléchargements en cours)' };
                }
                const outcome = await failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
                if (outcome === 'migrated') {
                    store.requeueFailedAfterMigration(entry.id, queue);
                }
                return {
                    outcome,
                    detail: failoverDetail(outcome),
                    hit: outcome === 'migrated',
                    level: outcome === 'migrated' ? 'info' : 'warn'
                };
            }
        });
    });

    // Bulk tool (dashboard "better sources" scan): probe healthier sources for
    // every visible entry with at most `maxChapters` chapters. Matches become
    // migration suggestions awaiting confirmation — nothing is applied here.
    app.post<{ Body: { maxChapters?: number } }>('/api/library/rematch-incomplete', async (request, reply) => {
        if (!failover) {
            return requireFailover(reply);
        }
        const maxChapters = Number(request.body?.maxChapters ?? INCOMPLETE_SOURCE_CHAPTERS);
        if (!Number.isInteger(maxChapters) || maxChapters < 1 || maxChapters > 50) {
            return reply.code(400).send({ error: 'maxChapters doit être un entier entre 1 et 50' });
        }
        const entries = (await store.listEntries('visible')).filter(entry => !entry.migrationSuggestion && entry.chapterCount <= maxChapters);
        return jobs.runBulk(events, {
            label: 'Meilleures sources',
            recapHits: 'suggestion(s)',
            category: 'scan',
            prefix: 'scan.betterSources',
            entries,
            notifyFinished: summary =>
                scheduler.notify(
                    'scans',
                    'Recherche de meilleures sources',
                    `${summary.cancelled ? 'Annulée' : 'Terminée'} : ${summary.done}/${summary.total} série(s) traitée(s), ${summary.hits} suggestion(s)`
                ),
            action: async entry => {
                const outcome = await failover.suggestIfIncomplete(entry, entry.chapterCount, { manual: true, maxChapters });
                const done = outcome === 'suggested';
                if (done) {
                    publishEntry(entry.id);
                }
                return { outcome: done ? 'suggested' : 'none', detail: done ? 'migration suggérée (à confirmer)' : 'aucune source plus complète', hit: done };
            }
        });
    });

    // Force a source re-match: auto-applies a confident match, otherwise stores a suggestion
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/rematch', async (request, reply) => {
        if (!failover) {
            return requireFailover(reply);
        }
        const entry = requireEntry(reply, store, Number(request.params.entryId));
        if (!entry) {
            return reply;
        }
        try {
            const outcome = await failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
            const updated = publishEntry(entry.id);
            return { outcome, entry: updated };
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });

    app.post<{ Params: { entryId: string }; Body: { apply: boolean } }>('/api/library/:entryId/rematch/confirm', async (request, reply) => {
        const { entryId } = request.params;
        const entry = store.getEntry(Number(entryId));
        if (!entry?.migrationSuggestion) {
            return reply.code(404).send({ error: 'Aucune suggestion en attente' });
        }
        if (request.body?.apply) {
            if (queue.hasPendingJobs(Number(entryId))) {
                return assertNoRunningDownloads(reply);
            }
            try {
                const result = await store.migrateEntry(Number(entryId), entry.migrationSuggestion);
                store.requeueFailedAfterMigration(Number(entryId), queue);
                const updated = publishEntry(Number(entryId));
                return { applied: true, ...result, entry: updated };
            } catch (error) {
                return reply.code(502).send({ error: (error as Error).message });
            }
        }
        // remember the refusal so the background detection does not re-suggest it
        store.dismissMigrationSuggestion(Number(entryId), entry.migrationSuggestion);
        return { applied: false };
    });

    app.post<{ Params: { entryId: string }; Body: Partial<SourceAlternativeDto> }>('/api/library/:entryId/migrate', async (request, reply) => {
        const entry = requireEntry(reply, store, Number(request.params.entryId));
        if (!entry) {
            return reply;
        }
        const target = request.body;
        if (
            typeof target?.sourceId !== 'string' ||
            !target.sourceId ||
            typeof target.mangaId !== 'string' ||
            !target.mangaId ||
            typeof target.mangaTitle !== 'string' ||
            !target.mangaTitle ||
            typeof target.sourceLabel !== 'string' ||
            !target.sourceLabel ||
            (target.url !== undefined && typeof target.url !== 'string')
        ) {
            return reply.code(400).send({ error: 'Body must contain string sourceId, sourceLabel, mangaId and mangaTitle' });
        }
        if (target.sourceId === entry.sourceId && target.mangaId === entry.mangaId) {
            return reply.code(400).send({ error: 'Entry already on this source' });
        }
        if (queue.hasPendingJobs(entry.id)) {
            return assertNoRunningDownloads(reply);
        }
        try {
            const result = await store.migrateEntry(entry.id, {
                sourceId: target.sourceId,
                sourceLabel: target.sourceLabel,
                mangaId: target.mangaId,
                mangaTitle: target.mangaTitle,
                url: target.url,
                score: target.score
            });
            store.requeueFailedAfterMigration(entry.id, queue);
            const updated = publishEntry(entry.id);
            return { ...result, entry: updated };
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/migration/rollback', async (request, reply) => {
        const { entryId } = request.params;
        const ok = store.rollbackMigration(Number(entryId));
        if (!ok) {
            return reply.code(404).send({ error: 'Aucune migration à annuler' });
        }
        const entry = publishEntry(Number(entryId));
        return { ok: true, entry };
    });
}
