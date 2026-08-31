/**
 * Unified source registry: native connectors first (curated, reliable),
 then every legacy Hakuneko connector behind the LegacySourceAdapter.
 *
 * A legacy connector is skipped when its id is already taken by a native
 * connector, but also when it points at the same *site* as a native one
 * (compared on hostname) — so a site we curate natively stays ours even if
 * Hakuneko later ships a connector for it under a different id.
 */

import { loadConnectors } from '../engine.js';
import { LegacySourceAdapter } from './legacy-adapter.js';
import { createNativeConnectors } from './native/index.js';
import type { SourceAdapter } from './types.js';

/** Hostname of a site url, `www.`-stripped; undefined when unusable. */
function hostOf(url: string | undefined): string | undefined {
    try {
        return new URL(url || '').hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return undefined;
    }
}

/** True when both hosts are equal, or one is a subdomain of the other. */
function sameSite(a: string, b: string): boolean {
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export class SourceRegistry {
    private readonly adapters = new Map<string, SourceAdapter>();
    private loading?: Promise<void>;

    /** Native connectors registered up-front (no network needed). */
    constructor(private readonly wrap: (adapter: SourceAdapter) => SourceAdapter = adapter => adapter) {
        for (const native of createNativeConnectors()) {
            this.adapters.set(native.id, native);
        }
    }

    ensureLoaded(): Promise<void> {
        // shared promise: concurrent callers wait for the same load, and a
        // failed load can be retried on the next call instead of sticking
        this.loading ??= this._load().catch(error => {
            this.loading = undefined;
            throw error;
        });
        return this.loading;
    }

    private async _load(): Promise<void> {
        const nativeHosts = [...this.adapters.values()].map(adapter => hostOf(adapter.url)).filter((host): host is string => !!host);
        const { connectors, failures } = await loadConnectors();
        for (const connector of connectors) {
            const id = String(connector.id);
            const host = hostOf(connector.url);
            // same id as a native connector -> theirs loses
            // same site as a native connector (any id) -> theirs loses too
            const shadowed = this.adapters.has(id) || (host !== undefined && nativeHosts.some(native => sameSite(native, host)));
            if (!shadowed) {
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
