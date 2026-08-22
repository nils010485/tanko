/**
 * Race a promise against a timeout. Rejects with an Error mentioning the
 * label so callers can tell a timeout apart from the underlying failure.
 * The timer is cleared as soon as the promise settles (no dangling handles).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}
