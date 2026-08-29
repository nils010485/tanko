/**
 * Library routes — chapters: chapter listing, per-entry checks, ad-hoc
 * enqueueing (download-new), change history and file rollback. Extracted
 * from routes/library.ts, which registers the whole library API.
 */
import type { FastifyInstance } from 'fastify';
import type { LibraryRouteDeps } from './library.js';
import { requireEntry } from './library-entries.js';

export function registerLibraryChaptersRoutes(app: FastifyInstance, deps: LibraryRouteDeps): void {
    const { store, queue, failover } = deps;
    const publishEntry = deps.publishEntry;

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

    // Same sweep including the pre-follow backlog ('new' + 'missing' + 'failed')
    // across all visible entries — the Tasks-page bulk "download missing".
    app.post('/api/library/download-missing', async () => {
        const entries = await store.listEntries('visible');
        let queued = 0;
        let affected = 0;
        for (const entry of entries) {
            const count = store.enqueueNewChapters(entry.id, queue, true);
            if (count > 0) {
                queued += count;
                affected += 1;
                publishEntry(entry.id);
            }
        }
        return { queued, entries: affected };
    });

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
}
