import type { LibraryEntryDto, SourceAlternativeDto, SourceAlternativesResponseDto } from '@tanko/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DownloadQueue } from '../downloader/queue.js';
import type { CoverService } from '../library/covers.js';
import type { FailoverService } from '../library/failover.js';
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
export function registerLibraryRoutes(
    app: FastifyInstance,
    store: LibraryStore,
    scheduler: Scheduler,
    queue: DownloadQueue,
    events: EventBus,
    failover?: FailoverService,
    covers?: CoverService
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
        Body: { sourceId: string; mangaId: string; title: string; url?: string; thumbnail?: string; autoDownload?: boolean; backlog?: 'ignore' | 'grab' };
    }>('/api/library', async (request, reply) => {
        const body = request.body;
        if (!body?.sourceId || !body?.mangaId || !body?.title) {
            return reply.code(400).send({ error: 'Body must contain sourceId, mangaId and title' });
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
    app.patch<{ Params: { entryId: string }; Body: { autoDownload?: boolean; hidden?: boolean } }>('/api/library/:entryId', async (request, reply) => {
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
        return reply.code(400).send({ error: 'Body must contain boolean "autoDownload" or "hidden"' });
    });

    // Re-match every entry whose source keeps failing (bulk failover, cached catalogs)
    let rematchAllRunning = false;
    app.post('/api/library/rematch-failed', async (_request, reply) => {
        if (!failover) {
            return reply.code(501).send({ error: 'Failover non disponible' });
        }
        if (rematchAllRunning) {
            return { started: false, count: 0, reason: 'already-running' };
        }
        const entries = (await store.listEntries()).filter(entry => (entry.checkFailures ?? 0) > 0);
        if (entries.length === 0) {
            return { started: false, count: 0 };
        }
        rematchAllRunning = true;
        void (async () => {
            let migrated = 0;
            try {
                for (const entry of entries) {
                    try {
                        const outcome = await failover.maybeMigrate({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
                        if (outcome === 'migrated') {
                            migrated++;
                        }
                        events.publish({
                            type: 'log',
                            level: outcome === 'migrated' ? 'info' : 'warn',
                            message: `Re-match : « ${entry.title} » → ${outcome === 'migrated' ? 'migré vers une nouvelle source' : outcome === 'suggested' ? 'migration suggérée (à confirmer)' : 'aucune source de rechange'}`,
                            at: new Date().toISOString()
                        });
                    } catch (error) {
                        events.publish({
                            type: 'log',
                            level: 'warn',
                            message: `Re-match « ${entry.title} » : ${(error as Error).message}`,
                            at: new Date().toISOString()
                        });
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            } finally {
                rematchAllRunning = false;
                events.publish({
                    type: 'log',
                    level: 'info',
                    message: `Re-match terminé : ${entries.length} série(s) traitée(s), ${migrated} migration(s)`,
                    at: new Date().toISOString()
                });
            }
        })();
        return { started: true, count: entries.length };
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
                if (checked) {
                    void failover
                        .suggestIfIncomplete({ id: checked.id, sourceId: checked.sourceId, title: checked.title }, checked.chapterCount)
                        .then(suggested => {
                            if (suggested) {
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

    // Enqueue all chapters with status 'new' for this entry
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/download-new', async (request, reply) => {
        const { entryId } = request.params;
        if (!requireEntry(reply, store, Number(entryId))) {
            return reply;
        }
        const queued = store.enqueueNewChapters(Number(entryId), queue);
        return { queued };
    });

    // Enqueue every already-detected new chapter across all visible entries
    // (no source re-check, no auto-download flag required)
    app.post('/api/library/download-new', async () => {
        const entries = await store.listEntries('visible');
        let queued = 0;
        let affected = 0;
        for (const entry of entries) {
            if (entry.newCount === 0) {
                continue;
            }
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
            const result = await store.migrateEntry(Number(entryId), entry.migrationSuggestion);
            const updated = publishEntry(Number(entryId));
            return { applied: true, ...result, entry: updated };
        }
        store.setMigrationSuggestion(Number(entryId), null);
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
        if (!target?.sourceId || !target?.mangaId || !target?.mangaTitle || !target?.sourceLabel) {
            return reply.code(400).send({ error: 'Body must contain sourceId, sourceLabel, mangaId and mangaTitle' });
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
