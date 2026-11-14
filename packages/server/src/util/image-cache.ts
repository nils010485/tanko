/**
 * In-memory LRU cache bounded by a total byte budget. Shared by the image
 * proxies (cost = body length) and the parsed-value cache tier (cost = JSON
 * string length): one eviction policy, several uses.
 */
export class ByteBudgetCache<T> {
    private readonly map = new Map<string, T>();
    private bytes = 0;

    constructor(
        private readonly maxBytes: number,
        private readonly costOf: (value: T) => number
    ) {}

    get(key: string): T | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            // refresh LRU recency
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }

    set(key: string, value: T): void {
        const previous = this.map.get(key);
        if (previous !== undefined) {
            this.bytes -= this.costOf(previous);
        }
        this.map.set(key, value);
        this.bytes += this.costOf(value);
        while (this.bytes > this.maxBytes && this.map.size > 0) {
            const oldest = this.map.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            const oldestValue = this.map.get(oldest);
            if (oldestValue !== undefined) {
                this.bytes -= this.costOf(oldestValue);
            }
            this.map.delete(oldest);
        }
    }

    delete(key: string): void {
        const previous = this.map.get(key);
        if (previous !== undefined) {
            this.bytes -= this.costOf(previous);
            this.map.delete(key);
        }
    }

    clear(): void {
        this.map.clear();
        this.bytes = 0;
    }

    get size(): number {
        return this.map.size;
    }
}
