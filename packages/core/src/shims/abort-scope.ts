/**
 * Operation-scoped abort for legacy connector calls.
 *
 * A legacy catalog/chapter crawl is a long sequence of fetches with no
 * cancellation API of its own: when the adapter gives up on it (timeout,
 * health-check race), the crawl keeps running in the background and its
 * in-memory catalog stays alive — the "zombie crawl" that stacks heaps until
 * the process OOMs. Running a call inside an abort scope lets the global
 * fetch wrapper (engine.ts) combine every in-flight request signal with the
 * scope's: aborting the scope kills the whole crawl at once.
 *
 * The scope flows through AsyncLocalStorage, so vendor code started inside
 * `withAbortScope` (awaits, timers, callbacks) inherits it automatically.
 * Limitation: the puppeteer fallback (request.ts getPageHTML) runs outside
 * the wrapped fetch and is only bounded by its own 30s timeout.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<AbortController>();

/** Run `fn` inside a fresh abort scope; nested scopes chain (outer abort kills inner). */
export function withAbortScope<T>(fn: (scope: AbortController) => T): T {
    const outer = storage.getStore();
    const controller = new AbortController();
    if (outer) {
        if (outer.signal.aborted) {
            controller.abort(outer.signal.reason);
        } else {
            outer.signal.addEventListener('abort', () => controller.abort(outer.signal.reason), { once: true });
        }
    }
    return storage.run(controller, () => fn(controller));
}

/** The current scope's signal, if any (used by the fetch wrapper). */
export function currentAbortSignal(): AbortSignal | undefined {
    return storage.getStore()?.signal;
}
