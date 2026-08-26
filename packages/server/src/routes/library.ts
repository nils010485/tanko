import type { LibraryBulkAction, LibraryEntryDto, SourceAlternativeDto, SourceAlternativesResponseDto } from '@tanko/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { JobRunner } from '../activity/jobs.js';
import type { DownloadQueue } from '../downloader/queue.js';
import type { CoverService } from '../library/covers.js';
import { type FailoverService, INCOMPLETE_SOURCE_CHAPTERS } from '../library/failover.js';
import type { LibraryStore } from '../library/store.js';
import type { Scheduler, ScheduleSettings } from '../scheduler/scheduler.js';
import type { EventBus } from '../ws.js';

/** Load an entry or reply 404; undefined means the reply has already been sent. */
function requireEntry(reply: FastifyReply, store: LibraryStore, entryId: number): LibraryEntryDto | undefined {
    const entry = store.getEntry(entryId);
    if (!entry) {
        reply.code(404).send({ error: 'Entry not found' });
    }
    return entry;
}

/** Shape accepted by Scheduler.updateSettings (notifications may be partial). */
type SchedulePatch = Partial<Omit<ScheduleSettings, 'notifications'>> & { notifications?: Partial<ScheduleSettings['notifications']> };
/** Actions accepted by POST /api/library/bulk (library selection mode). */
const BULK_ACTIONS: readonly LibraryBulkAction[] = ['pause', 'resume', 'hide', 'unhide', 'check', 'downloadNew', 'rematch', 'delete'];
export function registerLibraryRoutes(
    app: FastifyInstance,
    store: LibraryStore,
    scheduler: Scheduler,
    queue: DownloadQueue,
    events: EventBus,
    failover?: FailoverService,
    covers?: CoverService,
    /** Shared with the activity routes — index.ts passes the same instance. */
    jobs: JobRunner = new JobRunner()
): void {
    /** Re-read an entry and broadcast it to the dashboard (no-op when it vanished). */
    const publishEntry = (entryId: number): LibraryEntryDto | undefined => {
        const entry = store.getEntry(entryId);
        if (entry) {
            events.publish({ type: 'library.updated', entry });
        }
        return entry;
    };

    // ------------------------------------------------------------------
    // Library entries
    // ------------------------------------------------------------------
    /** Entries with their cached cover URL when the first-chapter cover cache is enabled. */
    const listDecorated = async (hidden?: boolean): Promise<LibraryEntryDto[]> => {
        const entries = await store.listEntries(hidden ? 'hidden' : 'visible');
        if (!covers?.isEnabled()) {
            return entries;
        }
        const covered = covers.coveredEntryIds();
        return entries.map(entry => (covered.has(entry.id) ? { ...entry, coverUrl: `/api/library/${entry.id}/cover` } : entry));
    };

    app.get<{ Querystring: { hidden?: string } }>('/api/library', async request =>
        listDecorated(request.query.hidden === '1' || request.query.hidden === 'true' ? true : undefined)
    );

    app.post<{
        Body: {
            sourceId: string;
            mangaId: string;
            title: string;
            url?: string;
            thumbnail?: string;
            autoDownload?: boolean;
            backlog?: 'ignore' | 'grab';
            force?: boolean;
        };
    }>('/api/library', async (request, reply) => {
        const body = request.body;
        if (!body?.sourceId || !body?.mangaId || !body?.title) {
            return reply.code(400).send({ error: 'Body must contain sourceId, mangaId and title' });
        }
        // duplicate guard: the same series already tracked under another
        // source (or another id on the same source) — refuse unless forced;
        // the dashboard surfaces the message so the user can decide
        const existing = store.findEntryByTitle(body.title);
        if (existing && body.force !== true) {
            return reply.code(409).send({
                error: `Série déjà suivie via ${existing.source_label} (#${existing.id})`,
                existingEntry: { id: existing.id, title: existing.title, sourceId: existing.source_id, sourceLabel: existing.source_label }
            });
        }
        try {
            const backlog = body.backlog === 'ignore' || body.backlog === 'grab' ? body.backlog : undefined;
            const result = await store.addEntry({ ...body, backlog });
            // explicit grab: queue the freshly snapshotted backlog right away;
            // a queueing failure must not fail the request — the entry exists
            let queued: number | undefined;
            if (backlog === 'grab') {
                try {
                    queued = store.enqueueNewChapters(result.entry.id, queue);
                } catch (error) {
                    console.warn(`[library] backlog grab failed for "${body.title}":`, (error as Error).message);
                    queued = 0;
                }
            }
            events.publish({ type: 'library.updated', entry: store.getEntry(result.entry.id) ?? result.entry });
            return reply.code(201).send({ ...result, queued });
        } catch (error) {
            return reply.code(400).send({ error: (error as Error).message });
        }
    });

    app.delete<{ Params: { entryId: string }; Querystring: { disk?: string } }>('/api/library/:entryId', async (request, reply) => {
        const { entryId } = request.params;
        const disk = request.query.disk === '1' || request.query.disk === 'true';
        const result = store.removeEntry(Number(entryId), { disk });
        if (!result.ok) {
            return reply.code(404).send({ error: 'Entry not found' });
        }
        return { ok: true, deletedPath: result.deletedPath ?? null };
    });

    // Dry-run disk sync: list entries whose files disappeared from the library folder
    app.post('/api/library/rescan', async () => ({ dead: store.findDeadEntries() }));

    // Apply a rescan: drop the dead entries listed by a previous /rescan
    app.post<{ Body: { ids?: number[] } }>('/api/library/prune', async request => {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter(id => Number.isInteger(id)) : [];
        return { removed: store.pruneEntries(ids) };
    });

    // Folder that a "remove from disk" would delete (preview for the dashboard)
    app.get<{ Params: { entryId: string } }>('/api/library/:entryId/disk-path', async (request, reply) => {
        const { entryId } = request.params;
        if (!requireEntry(reply, store, Number(entryId))) {
            return reply;
        }
        return { path: store.seriesDirectory(Number(entryId)) };
    });

    // Toggle auto-download for an entry
    app.patch<{ Params: { entryId: string }; Body: { autoDownload?: boolean; hidden?: boolean; paused?: boolean } }>(
        '/api/library/:entryId',
        async (request, reply) => {
            const { entryId } = request.params;
            if (typeof request.body?.autoDownload === 'boolean') {
                const ok = store.setAutoDownload(Number(entryId), request.body.autoDownload);
                if (!ok) {
                    return reply.code(404).send({ error: 'Entry not found' });
                }
                return publishEntry(Number(entryId));
            }
            if (typeof request.body?.hidden === 'boolean') {
                const ok = store.setHidden(Number(entryId), request.body.hidden);
                if (!ok) {
                    return reply.code(404).send({ error: 'Entry not found' });
                }
                return publishEntry(Number(entryId));
            }
            if (typeof request.body?.paused === 'boolean') {
                const ok = store.setPaused(Number(entryId), request.body.paused);
                if (!ok) {
                    return reply.code(404).send({ error: 'Entry not found' });
                }
                return publishEntry(Number(entryId));
            }
            return reply.code(400).send({ error: 'Body must contain boolean "autoDownload", "hidden" or "paused"' });
        }
    );

    // Bulk operations for the library selection mode: same actions as the
    // per-entry routes, applied sequentially; individual failures are counted
    // and never abort the run.
    app.post<{ Body: { ids?: number[]; action?: LibraryBulkAction; disk?: boolean } }>('/api/library/bulk', async (request, reply) => {
        const action = request.body?.action;
        const disk = request.body?.disk === true;
        const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter(id => Number.isInteger(id)) : [];
        if (!action || !BULK_ACTIONS.includes(action)) {
            return reply.code(400).send({ error: `action must be one of: ${BULK_ACTIONS.join(', ')}` });
        }
        if (ids.length === 0) {
            return reply.code(400).send({ error: 'ids must be a non-empty array of integers' });
        }
        if (action === 'rematch' && !failover) {
            return reply.code(501).send({ error: 'Failover non disponible' });
        }
        const summary = { processed: 0, failed: 0, skipped: 0, newChapters: 0, queued: 0, deleted: 0 };
        for (const id of ids) {
            let outcome: 'ok' | 'skip' | 'fail' = 'fail';
            try {
                const entry = store.getEntry(id);
                if (!entry && action !== 'delete') {
                    summary.failed += 1; // vanished since the selection
                    continue;
                }
                switch (action) {
                    case 'pause':
                    case 'resume':
                        outcome = store.setPaused(id, action === 'pause') ? 'ok' : 'fail';
                        publishEntry(id);
                        break;
                    case 'hide':
                    case 'unhide':
                        outcome = store.setHidden(id, action === 'hide') ? 'ok' : 'fail';
                        publishEntry(id);
                        break;
                    case 'check': {
                        // unlike the single /check, no starved-source probe: a
                        // large selection would hammer every source at once
                        const { fresh } = await store.checkForNewChapters(id);
                        summary.newChapters += fresh.length;
                        outcome = 'ok';
                        publishEntry(id);
                        break;
                    }
                    case 'downloadNew': {
                        const queued = store.enqueueNewChapters(id, queue);
                        summary.queued += queued;
                        outcome = 'ok';
                        if (queued > 0) {
                            publishEntry(id);
                        }
                        break;
                    }
                    case 'rematch': {
                        if (!entry || !failover) {
                            break; // vanished or failover unavailable — failed
                        }
                        // migrating under running downloads would orphan their
                        // files and double-queue the requeued chapters — skip:
                        // the next rematch run picks the entry up again
                        if (queue.hasPendingJobs(id)) {
                            outcome = 'skip';
                            break;
                        }
                        const migrated = await failover.maybeMigrate({ id, sourceId: entry.sourceId, title: entry.title });
                        if (migrated === 'migrated') {
                            store.requeueFailedAfterMigration(id, queue);
                        }
                        outcome = 'ok';
                        publishEntry(id);
                        break;
                    }
                    case 'delete': {
                        const result = store.removeEntry(id, { disk });
                        outcome = result.ok ? 'ok' : 'fail';
                        summary.deleted += result.ok ? 1 : 0;
                        break;
                    }
                }
            } catch {
                outcome = 'fail';
            }
            if (outcome === 'ok') {
                summary.processed += 1;
            } else if (outcome === 'skip') {
                summary.skipped += 1;
            } else {
                summary.failed += 1;
            }
        }
        events.publishLog({
            level: 'info',
            category: 'system',
            code: 'system.bulk',
            params: { action, processed: summary.processed, skipped: summary.skipped, failed: summary.failed },
            message: `Action groupée « ${action} » : ${summary.processed} traitée(s), ${summary.skipped} ignorée(s), ${summary.failed} échec(s)`
        });
        return summary;
    });

    // Re-match every entry whose source keeps failing (bulk failover, cached catalogs)
    app.post('/api/library/rematch-failed', async (_request, reply) => {
        if (!failover) {
            return reply.code(501).send({ error: 'Failover non disponible' });
        }
        const entries = (await store.listEntries()).filter(entry => (entry.checkFailures ?? 0) > 0);
        return jobs.runBulk(events, {
            label: 'Re-match',
            recapHits: 'migration(s)',
            category: 'failover',
            prefix: 'failover.rematch',
            entries,
            action: async entry => {
                // migrating under running downloads would orphan their files
                // and double-queue the requeued chapters — leave the entry
                // failed so the next bulk run picks it up again
                if (queue.hasPendingJobs(entry.id)) {
                    return { outcome: 'skipped', detail: 'ignorée (téléchargements en cours)' };
                }
                const outcome = await failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
                if (outcome === 'migrated') {
                    store.requeueFailedAfterMigration(entry.id, queue);
                }
                return {
                    outcome,
                    detail:
                        outcome === 'migrated'
                            ? 'migré vers une nouvelle source'
                            : outcome === 'suggested'
                              ? 'migration suggérée (à confirmer)'
                              : 'aucune source de rechange',
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
            return reply.code(501).send({ error: 'Failover non disponible' });
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

    // Chapters of one entry
    app.get<{ Params: { entryId: string } }>('/api/library/:entryId/chapters', async (request, reply) => {
        const { entryId } = request.params;
        if (!requireEntry(reply, store, Number(entryId))) {
            return reply;
        }
        return store.listChapters(Number(entryId));
    });

    // Check one entry now for new chapters (does not auto-enqueue)
    // NB: no 404 guard here on purpose — /check stays callable for any id and
    // reports its outcome through the store instead of the route.
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/check', async (request, reply) => {
        const { entryId } = request.params;
        try {
            const { fresh } = await store.checkForNewChapters(Number(entryId));
            // opt-in starved-source detection: probe other sources in the background
            // when the check found nothing and the entry carries very few chapters
            if (failover && fresh.length === 0) {
                const checked = store.getEntry(Number(entryId));
                if (checked && !checked.hidden) {
                    void failover
                        .suggestIfIncomplete({ id: checked.id, sourceId: checked.sourceId, title: checked.title }, checked.chapterCount)
                        .then(outcome => {
                            if (outcome === 'suggested') {
                                publishEntry(checked.id);
                            }
                        })
                        .catch(() => undefined);
                }
            }
            publishEntry(Number(entryId));
            return { newChapters: fresh.length };
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });

    // Enqueue every not-yet-downloaded chapter ('new' + failed retries) for this entry
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/download-new', async (request, reply) => {
        const { entryId } = request.params;
        if (!requireEntry(reply, store, Number(entryId))) {
            return reply;
        }
        const queued = store.enqueueNewChapters(Number(entryId), queue);
        return { queued };
    });

    // Enqueue every already-detected new or failed chapter across all visible
    // (no source re-check, no auto-download flag required)
    app.post('/api/library/download-new', async () => {
        const entries = await store.listEntries('visible');
        let queued = 0;
        let affected = 0;
        for (const entry of entries) {
            const count = store.enqueueNewChapters(entry.id, queue);
            if (count > 0) {
                queued += count;
                affected += 1;
                publishEntry(entry.id);
            }
        }
        return { queued, entries: affected };
    });

    // ------------------------------------------------------------------
    // Scheduler
    // ------------------------------------------------------------------

    app.get('/api/schedule', async () => ({ settings: scheduler.getSettings(), status: scheduler.status() }));

    app.patch<{ Body: SchedulePatch }>('/api/schedule', async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object') {
            return reply.code(400).send({ error: 'Body must be an object' });
        }
        try {
            return { settings: scheduler.updateSettings(body), status: scheduler.status() };
        } catch (error) {
            return reply.code(400).send({ error: (error as Error).message });
        }
    });

    // Trigger a full check of all entries right now
    app.post('/api/schedule/run', async () => {
        const result = await scheduler.runNow();
        return result;
    });

    // ------------------------------------------------------------------
    // Failover & rollback
    // ------------------------------------------------------------------

    // Change history of an entry's chapters
    app.get<{ Params: { entryId: string } }>('/api/library/:entryId/history', async request => {
        const { entryId } = request.params;
        return store.chapterHistory(Number(entryId));
    });

    // Restore a chapter's previous downloaded file
    app.post<{ Params: { entryId: string; chapterId: string } }>('/api/library/:entryId/chapters/:chapterId/rollback', async (request, reply) => {
        const { entryId, chapterId } = request.params;
        const ok = store.rollbackChapter(Number(entryId), chapterId);
        if (!ok) {
            return reply.code(404).send({ error: 'Aucun fichier précédent à restaurer' });
        }
        return { ok: true };
    });

    // Force a source re-match: auto-applies a confident match, otherwise stores a suggestion
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/rematch', async (request, reply) => {
        if (!failover) {
            return reply.code(501).send({ error: 'Failover non disponible' });
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

    // Confirm or dismiss the stored migration suggestion
    app.post<{ Params: { entryId: string }; Body: { apply: boolean } }>('/api/library/:entryId/rematch/confirm', async (request, reply) => {
        const { entryId } = request.params;
        const entry = store.getEntry(Number(entryId));
        if (!entry?.migrationSuggestion) {
            return reply.code(404).send({ error: 'Aucune suggestion en attente' });
        }
        if (request.body?.apply) {
            // migrating under running downloads would orphan their files and
            // double-queue the requeued chapters — let the jobs settle first
            if (queue.hasPendingJobs(Number(entryId))) {
                return reply.code(409).send({ error: 'Des téléchargements sont encore en cours pour cette série — réessayez quand ils sont terminés' });
            }
            const result = await store.migrateEntry(Number(entryId), entry.migrationSuggestion);
            store.requeueFailedAfterMigration(Number(entryId), queue);
            const updated = publishEntry(Number(entryId));
            return { applied: true, ...result, entry: updated };
        }
        // remember the refusal so the background detection does not re-suggest it
        store.dismissMigrationSuggestion(Number(entryId), entry.migrationSuggestion);
        return { applied: false };
    });

    // Manual source picker: same series on other sources with their chapter counts
    app.get<{ Params: { entryId: string } }>('/api/library/:entryId/alternatives', async (request, reply) => {
        if (!failover) {
            return reply.code(501).send({ error: 'Failover non disponible' });
        }
        const entry = requireEntry(reply, store, Number(request.params.entryId));
        if (!entry) {
            return reply;
        }
        try {
            const alternatives = await failover.listAlternatives({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
            const payload: SourceAlternativesResponseDto = {
                current: { sourceId: entry.sourceId, sourceLabel: entry.sourceLabel, chapterCount: entry.chapterCount },
                alternatives
            };
            return payload;
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });

    // Migrate an entry to a source picked manually in the picker
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
    // Undo the latest source migration
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
