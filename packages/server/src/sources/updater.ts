/**
 * Connectors updater: sync the legacy Hakuneko connectors + engine from the
 * upstream GitHub repository into the data directory, so the list of sources
 * can be refreshed from the dashboard without rebuilding the image.
 */

import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getVendorDirectory } from '@tanko/core';
import type { ConnectorsUpdateInfo, ConnectorsUpdateStatus } from '@tanko/shared';
import type { Database } from '../db.js';

const execFile = promisify(execFileCallback);

const UPSTREAM_URL = 'https://github.com/manga-download/hakuneko.git';
const UPSTREAM_PATH = 'src/web/mjs';
/** Minimum plausible connector count — guards against a broken upstream checkout. */
const MIN_CONNECTORS = 1000;

export const CONNECTORS_UPDATE_KEY = 'connectors-update';

export type { ConnectorsUpdateInfo, ConnectorsUpdateStatus };

/** Clone step — injectable so tests can run against a local fixture. Returns the upstream commit hash. */
export type CloneUpstream = (destination: string) => Promise<string>;

let running = false;

function countConnectors(directory: string): number {
    try {
        return fs.readdirSync(directory).filter(file => file.endsWith('.mjs') && !file.startsWith('.')).length;
    } catch {
        return 0;
    }
}

/** Default clone: shallow sparse checkout limited to src/web/mjs (skips the large assets). */
async function cloneUpstream(destination: string): Promise<string> {
    await execFile('git', ['clone', '--depth', '1', '--filter', 'blob:none', '--sparse', UPSTREAM_URL, destination], { timeout: 120_000 });
    await execFile('git', ['sparse-checkout', 'set', UPSTREAM_PATH], { cwd: destination, timeout: 120_000 });
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: destination, timeout: 30_000 });
    return stdout.trim();
}

function validateTree(connectorsDir: string, engineDir: string): void {
    if (!fs.existsSync(engineDir)) {
        throw new Error('Dossier engine introuvable dans les sources Hakuneko');
    }
    const count = countConnectors(connectorsDir);
    if (count < MIN_CONNECTORS) {
        throw new Error(`Arborescence suspecte : seulement ${count} connecteurs`);
    }
}

export async function syncConnectors(options: { dataDirectory: string; db: Database; clone?: CloneUpstream }): Promise<ConnectorsUpdateInfo> {
    if (running) {
        throw new Error('Une mise à jour des sources est déjà en cours');
    }
    running = true;
    const clone = options.clone ?? cloneUpstream;
    const vendorDir = path.join(options.dataDirectory, 'vendor');
    const backupDir = `${vendorDir}.bak`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-connectors-'));
    try {
        const previousCount = countConnectors(path.join(vendorDir, 'connectors')) || countConnectors(path.join(getVendorDirectory(), 'connectors'));
        const commit = await clone(tempDir);
        validateTree(path.join(tempDir, UPSTREAM_PATH, 'connectors'), path.join(tempDir, UPSTREAM_PATH, 'engine'));

        // Back up the previous synced copy (if any) so we can roll back on failure.
        if (fs.existsSync(backupDir)) {
            fs.rmSync(backupDir, { recursive: true, force: true });
        }
        const hadPrevious = fs.existsSync(vendorDir);
        if (hadPrevious) {
            fs.renameSync(vendorDir, backupDir);
        }
        try {
            fs.cpSync(path.join(tempDir, UPSTREAM_PATH, 'connectors'), path.join(vendorDir, 'connectors'), { recursive: true });
            fs.cpSync(path.join(tempDir, UPSTREAM_PATH, 'engine'), path.join(vendorDir, 'engine'), { recursive: true });
            validateTree(path.join(vendorDir, 'connectors'), path.join(vendorDir, 'engine'));
        } catch (error) {
            fs.rmSync(vendorDir, { recursive: true, force: true });
            if (hadPrevious) {
                fs.renameSync(backupDir, vendorDir);
            }
            throw error;
        }
        if (hadPrevious) {
            fs.rmSync(backupDir, { recursive: true, force: true });
        }

        const info: ConnectorsUpdateInfo = {
            date: new Date().toISOString(),
            commit,
            previousCount,
            connectorCount: countConnectors(path.join(vendorDir, 'connectors'))
        };
        options.db.kvSet(CONNECTORS_UPDATE_KEY, JSON.stringify(info));
        return info;
    } finally {
        running = false;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

export function isSyncRunning(): boolean {
    return running;
}

export function getUpdateStatus(db: Database): ConnectorsUpdateStatus {
    let last: ConnectorsUpdateInfo | null = null;
    try {
        const raw = db.kvGet(CONNECTORS_UPDATE_KEY);
        last = raw ? JSON.parse(raw) : null;
    } catch {
        last = null;
    }
    return {
        running,
        last,
        activeCount: countConnectors(path.join(getVendorDirectory(), 'connectors'))
    };
}
