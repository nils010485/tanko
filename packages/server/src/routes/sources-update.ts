/**
 * Routes for the connectors updater:
 *   GET  /api/sources/update — updater status (lock, last sync, active count)
 *   POST /api/sources/update — sync connectors from upstream Hakuneko
 */
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db.js';
import { getUpdateStatus, isSyncRunning, syncConnectors } from '../sources/updater.js';

export function registerSourceUpdateRoutes(app: FastifyInstance, config: ServerConfig, database: Database): void {
    app.get('/api/sources/update', async () => getUpdateStatus(database));

    app.post('/api/sources/update', async (_request, reply) => {
        if (isSyncRunning()) {
            return reply.code(409).send({ error: 'Une mise à jour des sources est déjà en cours' });
        }
        try {
            const info = await syncConnectors({ dataDirectory: config.dataDirectory, db: database });
            // The ESM module cache cannot be cleared safely: restart the process
            // to load the new connectors. Under Docker (restart: unless-stopped)
            // the container comes back up automatically; set CONNECTORS_AUTO_RESTART=0 to disable.
            const restart = process.env.CONNECTORS_AUTO_RESTART !== '0';
            if (restart) {
                setTimeout(() => process.exit(0), 1000);
            }
            return reply.send({ info, restart });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'erreur inattendue';
            return reply.code(502).send({ error: `Échec de la mise à jour des sources : ${message}` });
        }
    });
}
