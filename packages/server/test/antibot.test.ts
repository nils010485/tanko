/**
 * Anti-bot detection heuristic + health `via` plumbing (no module mocks).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HealthResult, SourceAdapter } from '@tanko/core';
import { isAntiBotShell } from '@tanko/core';
import type { WsEvent } from '@tanko/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/db.js';
import { SourceHealthService } from '../src/sources/health.js';
import { EventBus } from '../src/ws.js';

describe('isAntiBotShell', () => {
    it('detects localized Cloudflare challenge titles', () => {
        expect(isAntiBotShell('<html><head><title>Un instant…</title></head><body>x</body></html>')).toBe(true);
        expect(isAntiBotShell('<html><head><title>Raijin Scans — Vérification de sécurité</title></head></html>')).toBe(true);
        expect(isAntiBotShell('<html><head><title>Just a moment...</title></head></html>')).toBe(true);
    });

    it('does not flag a solved page that still carries the challenge script', () => {
        const html = `<html><head><title>Raijin Scans - Manga</title>
            <script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>
            </head><body>${'lorem ipsum '.repeat(3000)}</body></html>`;
        expect(isAntiBotShell(html)).toBe(false);
    });

    it('flags challenge scripts only on thin pages', () => {
        const thin = '<html><head><title>Home</title><script src="/cdn-cgi/challenge-platform/x"></script></head><body>ok</body></html>';
        expect(isAntiBotShell(thin)).toBe(true);
    });

    it('a 403 body is a challenge as soon as it hints at one', () => {
        expect(isAntiBotShell(`<html><head><title>Home</title></head><body>${'x'.repeat(40000)}</body></html>`, 403)).toBe(false);
        expect(isAntiBotShell('<html><body>denied</body></html>', 403)).toBe(true); // thin 403
        expect(isAntiBotShell(`<html><body>${'y'.repeat(30000)} cf-chl-widget</body></html>`, 403)).toBe(true); // marker on a fat 403
    });

    it('keeps the legacy heuristics: empty and tiny pages are shells', () => {
        expect(isAntiBotShell('')).toBe(true);
        expect(isAntiBotShell('<html><body>hi</body></html>')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// health service: `via` round-trip (no browser involved)
// ---------------------------------------------------------------------------

let tmpDir: string;
let database: Database;
let events: EventBus;

function makeService(scripted: Record<string, HealthResult>): SourceHealthService {
    const adapters = new Map<string, SourceAdapter>();
    for (const [id, result] of Object.entries(scripted)) {
        adapters.set(id, { id, label: id, tags: [], kind: 'native', checkHealth: async () => result } as SourceAdapter);
    }
    return new SourceHealthService({
        db: database,
        events,
        listAdapterIds: async () => [...adapters.keys()],
        getAdapter: async (id: string) => adapters.get(id)
    });
}

describe('SourceHealthService via plumbing', () => {
    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-antibot-'));
        database = new Database(path.join(tmpDir, 'test.db'));
        events = new EventBus();
        events.publish = (event: WsEvent) => Promise.resolve(event);
    });
    afterAll(() => {
        database?.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists and returns the transport used by the probe', async () => {
        const service = makeService({
            browserguy: { ok: true, latencyMs: 8000, via: 'browser' },
            plain: { ok: true, latencyMs: 120, via: 'http' },
            oldrow: { ok: true, latencyMs: 50 }
        });
        await service.probeMany(['browserguy', 'plain', 'oldrow'], { quiet: true });
        const all = service.getAll();
        expect(all.browserguy?.via).toBe('browser');
        expect(all.plain?.via).toBe('http');
        expect(all.oldrow?.via).toBeUndefined();
        // persisted: a fresh service over the same db reads it back
        const reread = new SourceHealthService({
            db: database,
            events,
            listAdapterIds: async () => [],
            getAdapter: async () => undefined
        });
        expect(reread.getAll().browserguy?.via).toBe('browser');
    });
});
