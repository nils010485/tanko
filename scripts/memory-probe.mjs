/**
 * Memory probe — measures where the scheduled run actually spends memory.
 *
 * Phase 1: engine + connector load baseline (1309 legacy connectors)
 * Phase 2: legacy catalog search (failover path, searchMangas = full catalog)
 * Phase 3: CBZ assembly (JSZip in-memory → generateAsync → reread + loadAsync)
 *
 * Usage: node --expose-gc scripts/memory-probe.mjs [--quick]
 * Metrics: heapUsed/arrayBuffers separate V8 heap from Buffer (external) memory.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, SourceRegistry } from '@tanko/core';
import JSZip from 'jszip';

const QUICK = process.argv.includes('--quick');
const MB = 1024 * 1024;

// ---------------------------------------------------------------- sampling
let peak = null;
function startSampling() {
    peak = { heapUsed: 0, arrayBuffers: 0, external: 0, rss: 0 };
    return setInterval(() => {
        const m = process.memoryUsage();
        for (const key of ['heapUsed', 'arrayBuffers', 'external', 'rss']) {
            if (m[key] > peak[key]) {
                peak[key] = m[key];
            }
        }
    }, 20);
}
function stopSampling(timer) {
    clearInterval(timer);
    return peak;
}
function snapshot() {
    const m = process.memoryUsage();
    return { heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers, rss: m.rss };
}
function compact() {
    global.gc?.();
    global.gc?.();
}
const fmt = n => `${(n / MB).toFixed(1).padStart(8)} MB`;
function report(label, baseline, peakSnap, retained) {
    console.log(`    ${label}`);
    console.log(
        `    heap:    base ${fmt(baseline.heapUsed)}  peak ${fmt(peakSnap.heapUsed)} (+${((peakSnap.heapUsed - baseline.heapUsed) / MB).toFixed(1)} MB)  retained +${((retained.heapUsed - baseline.heapUsed) / MB).toFixed(1)} MB`
    );
    console.log(
        `    buffers: base ${fmt(baseline.arrayBuffers)}  peak ${fmt(peakSnap.arrayBuffers)} (+${((peakSnap.arrayBuffers - baseline.arrayBuffers) / MB).toFixed(1)} MB)  retained +${((retained.arrayBuffers - baseline.arrayBuffers) / MB).toFixed(1)} MB`
    );
    console.log(`    rss:     base ${fmt(baseline.rss)}  peak ${fmt(peakSnap.rss)} (+${((peakSnap.rss - baseline.rss) / MB).toFixed(1)} MB)`);
}

// ---------------------------------------------------------------- setup
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-probe-'));
await createEngine({ dataDirectory: dataDir });
const registry = new SourceRegistry();

// ---------------------------------------------------------------- phase 1: load
{
    compact();
    const base = snapshot();
    const timer = startSampling();
    const started = Date.now();
    await registry.ensureLoaded();
    const peakSnap = stopSampling(timer);
    compact();
    const retained = snapshot();
    console.log(`\n=== Phase 1: engine + connector load (${((Date.now() - started) / 1000).toFixed(1)}s) ===`);
    report('load 1309 connectors', base, peakSnap, retained);
}

// ---------------------------------------------------------------- phase 2: catalog searches (failover path)
const CATALOG_SOURCES = QUICK ? ['mangadna'] : ['mangakakalot', 'mangakatana', 'mangadna'];
console.log(`\n=== Phase 2: searchMangas (full catalog per source, failover path) ===`);
for (const id of CATALOG_SOURCES) {
    const adapter = await registry.get(id);
    if (!adapter) {
        console.log(`${id}: not found, skipped`);
        continue;
    }
    compact();
    const base = snapshot();
    const timer = startSampling();
    const started = Date.now();
    let count = -1;
    let err = null;
    const catalogSize = -1;
    try {
        const results = await Promise.race([
            adapter.searchMangas('one piece'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('PROBE-TIMEOUT-150s')), 150_000))
        ]);
        count = results.length;
    } catch (error) {
        err = error.message;
    }
    const peakSnap = stopSampling(timer);
    compact();
    const retained = snapshot();
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\n[${id}] (${adapter.label}) ${secs}s  matches=${count}${catalogSize > 0 ? ` catalog=${catalogSize}` : ''}${err ? `  ERROR: ${err}` : ''}`);
    report(`searchMangas('one piece')`, base, peakSnap, retained);
}

// bonus: the exact MangaDNA getChapters crash from prod logs
{
    const adapter = await registry.get('mangadna');
    if (adapter) {
        try {
            await adapter.getChapters({ id: '/manga/existence-6e', title: 'Existence' });
            console.log('\n[mangadna] getChapters: OK (bug not reproduced)');
        } catch (error) {
            console.log(`\n[mangadna] getChapters reproduces prod crash: ${error.message.split('\n')[0]}`);
        }
    }
}

// ---------------------------------------------------------------- phase 3: CBZ assembly
console.log(`\n=== Phase 3: CBZ assembly (queue.ts _finalizeCbz flow, synthetic pages) ===`);
const SCENARIOS = QUICK
    ? [{ name: 'manga 20p×300KB', pages: 20, size: 300 * 1024 }]
    : [
          { name: 'manga 20p×300KB', pages: 20, size: 300 * 1024 },
          { name: 'webtoon 120p×1.5MB', pages: 120, size: 1.5 * MB },
          { name: 'webtoon 200p×2MB', pages: 200, size: 2 * MB }
      ];
const yieldLoop = () => new Promise(resolve => setImmediate(resolve));
for (const scenario of SCENARIOS) {
    const total = scenario.pages * scenario.size;
    compact();
    const base = snapshot();
    const timer = startSampling();
    const steps = {};
    const started = Date.now();
    const out = path.join(dataDir, `probe-${scenario.pages}.cbz`);
    try {
        const zip = new JSZip();
        for (let i = 0; i < scenario.pages; i++) {
            const page = Buffer.allocUnsafe(scenario.size);
            page.fill(i);
            zip.file(`${String(i + 1).padStart(4, '0')}.jpg`, page);
            await yieldLoop(); // prod awaits a network fetch per page
        }
        steps.afterBuffering = snapshot();
        const buffer = await zip.generateAsync({ compression: 'STORE', type: 'nodebuffer' });
        steps.afterGenerate = snapshot();
        fs.writeFileSync(out, buffer);
        const reread = await JSZip.loadAsync(fs.readFileSync(out));
        const entries = Object.values(reread.files).filter(f => !f.dir).length;
        steps.afterReread = snapshot();
        if (entries !== scenario.pages) {
            throw new Error(`entries ${entries}`);
        }
    } catch (error) {
        console.log(`  ERROR: ${error.message}`);
    }
    const peakSnap = stopSampling(timer);
    compact();
    const retained = snapshot();
    fs.rmSync(out, { force: true });
    console.log(`\n[${scenario.name}] chapter=${(total / MB).toFixed(0)}MB  ${((Date.now() - started) / 1000).toFixed(1)}s`);
    report('zip.file → generateAsync → write → reread+loadAsync', base, peakSnap, retained);
    for (const [step, snap] of Object.entries(steps)) {
        console.log(`    ${step.padEnd(14)} heap ${fmt(snap.heapUsed)}  buffers ${fmt(snap.arrayBuffers)}  rss ${fmt(snap.rss)}`);
    }
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\nDone.');
