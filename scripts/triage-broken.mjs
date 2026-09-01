/**
 * Triage of broken sources: re-probes every id from broken-ids.json through
 * the real adapters, captures the raw error, and classifies it:
 *   dead      — DNS/connection failure (domain gone) -> forget it
 *   antibot   — site up, protected (Cloudflare/JS) -> fixable via browser
 *   http_*    — site answers with 4xx/5xx -> maybe moved, needs URL fix
 *   empty     — root OK but catalog empty/broken -> connector rot (fixable)
 *   timeout   — too slow to tell -> re-check manually
 *   other     — anything else
 * Writes triage-results.json next to this script. Network script — run manually:
 *   node scripts/triage-broken.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeBrowser, createEngine, SourceRegistry } from '@tanko/core';

const CONCURRENCY = 10;
const PROBE_CAP_MS = 90_000;
const here = import.meta.dirname;
const idsFile = process.argv[2] ?? 'broken-ids.json';
const ids = JSON.parse(fs.readFileSync(path.join(here, idsFile), 'utf8'));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-triage-'));
await createEngine({ dataDirectory: dataDir });
const registry = new SourceRegistry();
await registry.ensureLoaded();

function classify(error) {
    const text = (error || '').toLowerCase();
    if (!text) return 'ok';
    if (/(enotfound|eai_again|econnrefused|getaddrinfo|fetch failed|domaine introuvable|connexion impossible|cert|tls|certificate)/.test(text)) return 'dead';
    if (text.includes('anti-bot') || text.includes('javascript requis')) return 'antibot';
    if (/http 5/.test(text)) return 'http_5xx';
    if (/http 4/.test(text)) return 'http_4xx';
    if (text.includes('liste de mangas vide')) return 'empty';
    if (/timeout|timed out/.test(text)) return 'timeout';
    return 'other';
}

const results = [];
let index = 0;
let done = 0;

async function worker() {
    while (index < ids.length) {
        const id = ids[index++];
        const adapter = await registry.get(id);
        if (!adapter) {
            results.push({ id, label: null, url: null, ok: false, error: 'Unknown source (not in registry)', cls: 'missing' });
            continue;
        }
        let outcome;
        try {
            const health = await Promise.race([
                adapter.checkHealth(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout (global cap)')), PROBE_CAP_MS))
            ]);
            outcome = { ok: health.ok, error: health.error ?? null, via: health.via ?? null, latencyMs: health.latencyMs };
        } catch (error) {
            outcome = { ok: false, error: String(error?.message ?? error), via: null, latencyMs: null };
        }
        results.push({
            id,
            label: adapter.label,
            url: adapter.url ?? null,
            kind: adapter.kind,
            ...outcome,
            cls: classify(outcome.error)
        });
        done++;
        process.stderr.write(`\r${done}/${ids.length} probed`);
    }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
process.stderr.write('\n');
await closeBrowser().catch(() => {});

results.sort((a, b) => (a.cls + a.id).localeCompare(b.cls + b.id));
fs.writeFileSync(path.join(here, idsFile.replace('-ids.json', '-results.json')), JSON.stringify(results, null, 2));

const counts = {};
for (const r of results) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
console.log('=== Triage summary ===');
for (const [cls, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`${cls.padEnd(10)} ${n}`);
}
console.log(`\nDetails: scripts/triage-results.json`);
