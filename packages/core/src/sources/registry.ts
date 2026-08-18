/**
 * Unified source registry: native connectors first (curated, reliable),
 * then every legacy Hakuneko connector behind the LegacySourceAdapter.
 */
import type { SourceAdapter } from './types.js';
import { LegacySourceAdapter } from './legacy-adapter.js';
import { createNativeConnectors } from './native/index.js';
import { loadConnectors } from '../engine.js';

export class SourceRegistry {

    private readonly adapters = new Map<string, SourceAdapter>();
    private loaded = false;

    /** Native connectors registered up-front (no network needed). */
    constructor(private readonly wrap: (adapter: SourceAdapter) => SourceAdapter = adapter => adapter) {
        for (const native of createNativeConnectors()) {
            this.adapters.set(native.id, native);
        }
    }

    async ensureLoaded(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        const { connectors, failures } = await loadConnectors();
        for (const connector of connectors) {
            const id = String(connector.id);
            if (!this.adapters.has(id)) {
                this.adapters.set(id, new LegacySourceAdapter(connector));
            }
        }
        if (failures > 0) {
            console.warn(`[sources] ${failures} legacy connectors failed to load`);
        }
    }

    async list(): Promise<SourceAdapter[]> {
        await this.ensureLoaded();
        return [...this.adapters.values()].map(adapter => this.wrap(adapter));
    }

    async get(id: string): Promise<SourceAdapter | undefined> {
        await this.ensureLoaded();
        const adapter = this.adapters.get(id);
        return adapter ? this.wrap(adapter) : undefined;
    }
}
