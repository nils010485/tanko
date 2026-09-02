/**
 * Parent side of the evaluation sandbox: run the page scripts in a dedicated,
 * permission-hardened child process instead of a vm context inside the server.
 *
 * Layers:
 *  - the child carries no session state (cookies, jar, gate stay here);
 *  - every sandbox fetch is proxied over IPC through the caller's transport;
 *  - the child runs with `--permission` (read-only allow-list), a wiped env
 *    and is SIGKILLed past the caller's timeout;
 *  - if the hardened spawn is refused (older node, restricted environment),
 *    retry once without the permission flags, and as a last resort fall back
 *    to the in-process evaluation (same code, weakest containment —
 *    TANKO_EVAL_INPROCESS=1 forces it).
 */
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EvalOutcome, type EvalPayload, type FetchVia, runPageEvaluation, type WireRequest, type WireResponse } from './evaluate-child.js';

const CHILD_ENTRY = fileURLToPath(new URL('./evaluate-child.js', import.meta.url));
/** Grace beyond the caller's timeout before the child is SIGKILLed. */
const KILL_GRACE_MS = 2000;
/** Set to 1 to force the (weaker) in-process evaluation, e.g. in odd sandboxes. */
const INPROCESS_ENV = 'TANKO_EVAL_INPROCESS';

type ChildMode = 'unknown' | 'hardened' | 'plain' | 'unavailable';
let childMode: ChildMode = 'unknown';

type ParentToChild =
    | { type: 'evaluate'; payload: EvalPayload }
    | { type: 'fetch-result'; reqId: number; response: WireResponse }
    | { type: 'fetch-error'; reqId: number; message: string };
type ChildToParent = { type: 'ready' } | { type: 'fetch'; reqId: number; request: WireRequest } | { type: 'result'; outcome: EvalOutcome };

/**
 * Read allow-list for the hardened child: the monorepo root covering its own
 * entry file and the runtime dependencies it imports (linkedom). Found by
 * walking up to the topmost package.json — npm workspaces put node_modules
 * there.
 */
function dependencyRoot(): string {
    let dir = path.dirname(CHILD_ENTRY);
    let top = dir;
    for (let hop = 0; hop < 10; hop++) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            top = dir;
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { workspaces?: unknown };
                if (pkg.workspaces) {
                    return dir;
                }
            } catch {
                /* unreadable package.json — keep walking */
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return top;
}

function unwrap(outcome: EvalOutcome): unknown {
    if (!outcome.ok) {
        throw new Error(outcome.error);
    }
    return outcome.value;
}
/** Indirection: keeps TS control-flow analysis from over-narrowing the module state. */
function currentMode(): ChildMode {
    return childMode;
}

/** Run one evaluation: hardened child > plain child > in-process fallback. */
export async function evaluateIsolated(payload: EvalPayload, fetchVia: FetchVia): Promise<unknown> {
    const mode = currentMode();
    if (mode === 'unavailable' || process.env[INPROCESS_ENV] === '1') {
        return unwrap(await runPageEvaluation(payload, fetchVia));
    }
    if (mode === 'plain') {
        return unwrap(await withChild(payload, fetchVia, false));
    }
    try {
        return unwrap(await withChild(payload, fetchVia, true));
    } catch (error) {
        if (currentMode() !== 'plain') {
            throw error;
        }
        return unwrap(await withChild(payload, fetchVia, false));
    }
}

async function withChild(payload: EvalPayload, fetchVia: FetchVia, hardened: boolean): Promise<EvalOutcome> {
    const execArgv = hardened ? ['--permission', `--allow-fs-read=${dependencyRoot()}`] : [];
    const child = fork(CHILD_ENTRY, { serialization: 'advanced', env: { TANKO_EVAL_CHILD: '1' }, execArgv, stdio: 'ignore' });
    child.unref(); // the kill timer below owns the lifecycle, not the loop

    let settled = false;
    let gotReady = false;
    let settle: (outcome: EvalOutcome) => void = () => undefined;
    const outcomePromise = new Promise<EvalOutcome>(resolve => {
        settle = resolve;
    });
    const finish = (outcome: EvalOutcome) => {
        if (!settled) {
            settled = true;
            settle(outcome);
        }
    };

    child.on('message', (message: ChildToParent) => {
        if (message.type === 'ready') {
            gotReady = true;
            childMode = hardened ? 'hardened' : 'plain';
            return;
        }
        if (message.type === 'fetch') {
            const reqId = message.reqId;
            fetchVia(message.request)
                .then(response => child.send({ type: 'fetch-result', reqId, response } satisfies ParentToChild))
                .catch((error: unknown) => child.send({ type: 'fetch-error', reqId, message: String(error) } satisfies ParentToChild));
            return;
        }
        if (message.type === 'result') {
            finish(message.outcome);
        }
    });
    child.on('exit', (code, signal) => {
        if (!gotReady) {
            // refused to boot: unknown --permission flag on this node, or a
            // bare runtime that cannot even load the entry
            childMode = hardened ? 'plain' : 'unavailable';
        }
        finish({ ok: false, error: `evaluation worker exited (code ${String(code)}, signal ${String(signal)})` });
    });
    child.on('error', (error: Error) => {
        finish({ ok: false, error: `evaluation worker error: ${error.message}` });
    });

    const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, error: 'script evaluation timed out' });
    }, payload.timeoutMs + KILL_GRACE_MS);
    killTimer.unref?.();

    child.send({ type: 'evaluate', payload } satisfies ParentToChild);
    try {
        return await outcomePromise;
    } finally {
        clearTimeout(killTimer);
        child.kill('SIGKILL'); // one evaluation per process, always
    }
}
