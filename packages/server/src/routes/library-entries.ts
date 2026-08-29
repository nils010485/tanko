/**
 * Library routes — entries: CRUD, hide/pause toggles, aliases, bulk actions,
 * dead-entry detection/pruning and disk resync. Extracted from routes/library.ts,
 * which registers the whole library API.
 */
import type { LibraryBulkAction, LibraryEntryDto, SourceAlternativesResponseDto } from '@tanko/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { fetchTitleAliases } from '../library/anilist.js';
import type { LibraryStore } from '../library/store.js';
import type { LibraryRouteDeps } from './library.js';

/** Load an entry or reply 404; undefined means the reply has already been sent. */
export function requireEntry(reply: FastifyReply, store: LibraryStore, entryId: number): LibraryEntryDto | undefined {
    const entry = store.getEntry(entryId);
    if (!entry) {
        reply.code(404).send({ error: 'Entry not found' });
    }
    return entry;
}

/** Cooldown between two automatic AniList lookups for the same entry (the
 *  manual fetch button is never throttled). */
const ANILIST_RETRY_MS = 24 * 60 * 60 * 1000;
const anilistTriedAt = new Map<number, number>();

/** Actions accepted by POST /api/library/bulk (library selection mode). */
const BULK_ACTIONS: readonly LibraryBulkAction[] = ['pause', 'resume', 'hide', 'unhide', 'check', 'downloadNew', 'rematch', 'delete'];

export function registerLibraryEntriesRoutes(app: FastifyInstance, deps: LibraryRouteDeps): void {
    const { store, queue, events, failover, covers } = deps;
    const publishEntry = deps.publishEntry;

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

    // Disk sync: re-attach local files to their chapters (by number), then
    // list entries whose files disappeared from the library folder (dry-run)
    app.post('/api/library/rescan', async () => {
        const resync = await store.resyncLocalFiles();
        return { dead: store.findDeadEntries(), ...resync };
    });

    // Apply a rescan: drop the dead entries listed by a previous /rescan
    app.post<{ Body: { ids?: number[] } }>('/api/library/prune', async request => {
        const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter(id => Number.isInteger(id)) : [];
        return { removed: store.pruneEntries(ids) };
    });

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
            let alternatives = await failover.listAlternatives({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
            // Nothing under the known names: the series is probably hosted under
            // another title — ask AniList once, merge what it knows, retry the
            // crawl once (the failover re-reads the aliases from the store).
            let autoAliases: string[] | undefined;
            if (alternatives.length === 0 && Date.now() - (anilistTriedAt.get(entry.id) ?? 0) > ANILIST_RETRY_MS) {
                try {
                    const names = await fetchTitleAliases(entry.title);
                    anilistTriedAt.set(entry.id, Date.now());
                    // re-read: a concurrent edit may have landed during the fetch
                    const fresh = store.getEntry(entry.id)?.aliases ?? [];
                    const merged = store.setAliases(entry.id, [...fresh, ...names]);
                    if (merged.length > fresh.length) {
                        autoAliases = merged;
                        publishEntry(entry.id);
                        alternatives = await failover.listAlternatives({ id: entry.id, sourceId: entry.sourceId, title: entry.title });
                    }
                } catch {
                    // AniList being unreachable must not fail the picker
                }
            }
            const payload: SourceAlternativesResponseDto = {
                current: { sourceId: entry.sourceId, sourceLabel: entry.sourceLabel, chapterCount: entry.chapterCount },
                alternatives
            };
            return autoAliases ? { ...payload, autoAliases } : payload;
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });

    // Alias titles the failover also searches (manual editor): replaces the list
    app.put<{ Params: { entryId: string }; Body: { aliases?: string[] } }>('/api/library/:entryId/aliases', async (request, reply) => {
        const entry = requireEntry(reply, store, Number(request.params.entryId));
        if (!entry) {
            return reply;
        }
        const aliases = request.body?.aliases;
        if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) {
            return reply.code(400).send({ error: 'Body must contain an aliases string array' });
        }
        store.setAliases(entry.id, aliases);
        return { entry: publishEntry(entry.id) };
    });

    // AniList lookup: merge the official + alternative titles into the aliases
    app.post<{ Params: { entryId: string } }>('/api/library/:entryId/aliases/fetch', async (request, reply) => {
        const entry = requireEntry(reply, store, Number(request.params.entryId));
        if (!entry) {
            return reply;
        }
        try {
            const names = await fetchTitleAliases(entry.title);
            // re-read: a concurrent edit may have landed during the fetch
            const fresh = store.getEntry(entry.id)?.aliases ?? [];
            const kept = store.setAliases(entry.id, [...fresh, ...names]);
            const fetched = kept.filter(name => !fresh.includes(name));
            return { entry: publishEntry(entry.id), fetched };
        } catch (error) {
            return reply.code(502).send({ error: (error as Error).message });
        }
    });
}
