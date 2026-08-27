import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONNECTOR_OVERRIDES, VENDOR_PATH } from '@tanko/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { type CloneUpstream, CONNECTORS_UPDATE_KEY, syncConnectors } from '../src/sources/updater.js';

let dataDir: string;
let database: Database;

beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haku-updater-'));
    database = new Database(dataDir);
});

afterEach(() => {
    database.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Fake upstream checkout: writes a src/web/mjs fixture into the destination, returns a commit hash. */
function upstreamFixture(connectorCount: number): CloneUpstream {
    return async destination => {
        const root = path.join(destination, 'src/web/mjs');
        fs.mkdirSync(path.join(root, 'connectors'), { recursive: true });
        fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
        fs.writeFileSync(path.join(root, 'engine', 'Connector.mjs'), 'export default class {}');
        for (let index = 0; index < connectorCount; index++) {
            fs.writeFileSync(path.join(root, 'connectors', `Connector${index}.mjs`), 'export default {}');
        }
        return 'abc123def4567890abcdef';
    };
}

/** Expected synced count: upstream fixture + our patched connectors overlaid on top. */
const overrides = CONNECTOR_OVERRIDES.length;

describe('syncConnectors', () => {
    it('copies connectors and engine into the data directory and persists metadata', async () => {
        const info = await syncConnectors({ dataDirectory: dataDir, db: database, clone: upstreamFixture(1001) });

        expect(fs.existsSync(path.join(dataDir, 'vendor', 'connectors', 'Connector0.mjs'))).toBe(true);
        expect(fs.existsSync(path.join(dataDir, 'vendor', 'engine', 'Connector.mjs'))).toBe(true);
        expect(info.commit).toBe('abc123def4567890abcdef');
        expect(info.connectorCount).toBe(1001 + overrides);
        expect(info.previousCount).toBeGreaterThanOrEqual(1000); // built-in baseline
        expect(info.date).toBeTruthy();

        const stored = JSON.parse(database.kvGet(CONNECTORS_UPDATE_KEY)!);
        expect(stored.commit).toBe(info.commit);
        expect(stored.connectorCount).toBe(1001 + overrides);
        // every bundled override must shadow its upstream copy after sync
        for (const file of CONNECTOR_OVERRIDES) {
            expect(fs.readFileSync(path.join(dataDir, 'vendor', 'connectors', file), 'utf8')).toBe(
                fs.readFileSync(path.join(VENDOR_PATH, 'connectors', file), 'utf8')
            );
        }
        expect(fs.existsSync(path.join(dataDir, 'vendor.bak'))).toBe(false);
    });

    it('reuses the synced copy as baseline on a second sync', async () => {
        await syncConnectors({ dataDirectory: dataDir, db: database, clone: upstreamFixture(1001) });
        const second = await syncConnectors({ dataDirectory: dataDir, db: database, clone: upstreamFixture(1005) });
        expect(second.previousCount).toBe(1001 + overrides);
        expect(second.connectorCount).toBe(1005 + overrides);
    });

    it('rolls back the previous vendor copy when the sync fails', async () => {
        fs.mkdirSync(path.join(dataDir, 'vendor', 'connectors'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'vendor', 'connectors', 'Previous.mjs'), 'export default {}');

        // A file name beyond the filesystem limit passes the pre-check (readdir works)
        // but makes the copy itself fail, exercising the rollback path.
        const failing: CloneUpstream = async destination => {
            const commit = await upstreamFixture(1000)(destination);
            fs.writeFileSync(path.join(destination, 'src/web/mjs/connectors', `${'x'.repeat(300)}.mjs`), '');
            return commit;
        };

        await expect(syncConnectors({ dataDirectory: dataDir, db: database, clone: failing })).rejects.toThrow();

        expect(fs.readFileSync(path.join(dataDir, 'vendor', 'connectors', 'Previous.mjs'), 'utf8')).toBe('export default {}');
        expect(database.kvGet(CONNECTORS_UPDATE_KEY)).toBeUndefined();
        expect(fs.existsSync(path.join(dataDir, 'vendor.bak'))).toBe(false);
    });

    it('rejects a second concurrent sync', async () => {
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const slow: CloneUpstream = async destination => {
            const commit = await upstreamFixture(1001)(destination);
            await gate;
            return commit;
        };
        const first = syncConnectors({ dataDirectory: dataDir, db: database, clone: slow });
        await expect(syncConnectors({ dataDirectory: dataDir, db: database, clone: upstreamFixture(1001) })).rejects.toThrow(
            'Une mise à jour des sources est déjà en cours'
        );
        release();
        expect((await first).connectorCount).toBe(1001 + overrides);
    });

    it('rejects a suspect upstream with too few connectors', async () => {
        await expect(syncConnectors({ dataDirectory: dataDir, db: database, clone: upstreamFixture(10) })).rejects.toThrow('Arborescence suspecte');
        expect(fs.existsSync(path.join(dataDir, 'vendor'))).toBe(false);
    });
});
