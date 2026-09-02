/**
 * Fixed-interval poll loop for views waiting on a background job (health
 * re-checks, imports): sleeps first — the job just started — then calls `fn`
 * until `done` says so or the attempt budget runs out. Bails out silently
 * when `cancelled` flips (component unmounted). Errors propagate.
 */
export async function pollUntil<T>(
    fn: () => Promise<T>,
    options: { attempts?: number; intervalMs?: number; done?: (value: T, attempt: number) => boolean; cancelled?: () => boolean } = {}
): Promise<void> {
    const attempts = options.attempts ?? 40;
    const intervalMs = options.intervalMs ?? 3000;
    for (let attempt = 0; attempt < attempts; attempt++) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        if (options.cancelled?.()) {
            return;
        }
        const value = await fn();
        if (options.done?.(value, attempt)) {
            return;
        }
    }
}
