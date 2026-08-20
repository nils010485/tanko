/**
 * Simple per-domain rate limiter: guarantees a minimum delay between two
 * requests to the same hostname (politeness towards source sites).
 */
export class DomainGate {
    private readonly lastHit = new Map<string, number>();
    constructor(private minIntervalMs: number) {}

    setMinInterval(ms: number): void {
        this.minIntervalMs = Math.max(0, ms);
    }

    async pass(url: string): Promise<void> {
        let host: string;
        try {
            host = new URL(url).hostname;
        } catch {
            return;
        }
        const now = Date.now();
        const next = Math.max(now, (this.lastHit.get(host) || 0) + this.minIntervalMs);
        this.lastHit.set(host, next);
        const delay = next - now;
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}
