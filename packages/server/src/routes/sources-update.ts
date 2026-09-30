/**
 * Routes for the sources updater:
 *   GET  /api/sources/update — updater status (lock, last sync, active count, pack)
 *   POST /api/sources/update — sync legacy connectors (pinned commit) + sources
 *   pack (hot-applied); restarts only when the legacy tree changed
 */
import type { SourceRegistry } from '@tanko/core';
import type { ConnectorsUpdateInfo, SourcesPackInfo, SourcesUpdateStatus } from '@tanko/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db.js';
import { getPackStatus, isPackRunning, syncSourcesPack } from '../sources/pack-updater.js';
import { getUpdateStatus, isSyncRunning, syncConnectors } from '../sources/updater.js';
import type { EventBus } from '../ws.js';

export function registerSourceUpdateRoutes(
    app: FastifyInstance,
    config: ServerConfig,
    database: Database,
    deps: { registry: SourceRegistry; events: EventBus }
): void {
    app.get('/api/sources/update', async (): Promise<SourcesUpdateStatus> => ({ ...getUpdateStatus(database), pack: getPackStatus(database) }));

    app.post('/api/sources/update', async (_request, reply) => {
        if (isSyncRunning() || isPackRunning()) {
            return reply.code(409).send({ error: 'Une mise à jour des sources est déjà en cours' });
        }
        try {
            const previousCommit = getUpdateStatus(database).last?.commit;
            const info: ConnectorsUpdateInfo = await syncConnectors({ dataDirectory: config.dataDirectory, db: database });
            const changed = info.commit !== previousCommit;
            let pack: SourcesPackInfo = { date: new Date().toISOString(), version: '', applied: false };
            try {
                pack = await syncSourcesPack({ dataDirectory: config.dataDirectory, db: database });
                if (pack.applied) {
                    deps.registry.reloadNatives();
                    deps.events.publish({ type: 'sources.updated' });
                }
            } catch (error) {
                pack = { ...pack, error: error instanceof Error ? error.message : 'erreur inattendue' };
            }
            const restart = changed && process.env.CONNECTORS_AUTO_RESTART !== '0';
            if (restart) {
                setTimeout(() => process.exit(0), 1000);
            }
            return reply.send({ info, pack, changed, restart });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'erreur inattendue';
            return reply.code(502).send({ error: `Échec de la mise à jour des sources : ${message}` });
        }
    });
}
