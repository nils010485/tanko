import fs from 'node:fs';

type ConfigValues = Record<string, unknown>;

const overrides = new Map<string, ConfigValues>();
const warned = new Set<string>();
let overridesFile: string | undefined;

export function loadOverrides(file: string): void {
    overridesFile = file;
    let parsed: { sources?: Record<string, ConfigValues> };
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sources?: Record<string, ConfigValues> };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn('[config] overrides illisibles, valeurs embarquées conservées :', (error as Error).message);
        }
        return;
    }
    overrides.clear();
    for (const [id, values] of Object.entries(parsed.sources ?? {})) {
        if (values && typeof values === 'object' && !Array.isArray(values)) {
            overrides.set(id, values);
        }
    }
}

export function reloadOverrides(): void {
    if (overridesFile) {
        loadOverrides(overridesFile);
    }
}

function typeMatches(value: unknown, def: unknown): boolean {
    if (def instanceof RegExp) {
        return false;
    }
    if (typeof def === 'string' || typeof def === 'boolean' || typeof def === 'number') {
        return typeof value === typeof def;
    }
    if (Array.isArray(def)) {
        return Array.isArray(value) && value.every(item => typeof item === 'string');
    }
    if (def && typeof def === 'object') {
        return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
    }
    return false;
}

export function config<T extends ConfigValues>(id: string, defaults: T): T {
    const over = overrides.get(id);
    if (!over) {
        return defaults;
    }
    const merged: ConfigValues = { ...defaults };
    for (const [key, value] of Object.entries(over)) {
        if (key === 'id' || !(key in merged)) {
            continue;
        }
        if (!typeMatches(value, merged[key])) {
            const warnKey = `${id}.${key}`;
            if (!warned.has(warnKey)) {
                warned.add(warnKey);
                console.warn(`[config] override ignoré (type incompatible) : ${warnKey}`);
            }
            continue;
        }
        merged[key] = value;
    }
    return merged as T;
}
