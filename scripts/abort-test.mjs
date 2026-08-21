import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEngine, SourceRegistry } from '@tanko/core';
import { withAbortScope } from '../packages/core/dist/shims/abort-scope.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-abort-'));
await createEngine({ dataDirectory: dataDir });
const registry = new SourceRegistry();
await registry.ensureLoaded();
const adapter = await registry.get('mangadna');

const t0 = Date.now();
let settled = null;
const p = withAbortScope(scope => {
    setTimeout(() => scope.abort(new Error('test abort')), 3000).unref?.();
    return adapter.searchMangas('one piece').then(
        () => {
            settled = 'RESOLVED';
        },
        e => {
            settled = `REJECTED: ${e.message.slice(0, 80)}`;
        }
    );
});
await p;
const ms = Date.now() - t0;
console.log(`settled in ${ms}ms → ${settled}`);
console.log(ms < 8000 ? '✓ abort kills the crawl fast (was ~34s)' : '✗ crawl NOT aborted');
process.exit(ms < 8000 ? 0 : 1);
