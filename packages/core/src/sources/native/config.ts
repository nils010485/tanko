import fs from 'node:fs';

type ConfigValues = Record<string, unknown>;

const overrides = new Map<string, ConfigValues>();
let overridesFile: string | undefined;

export function loadOverrides(file: string): void {
    overridesFile = file;
    overrides.clear();
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sources?: Record<string, ConfigValues> };
        for (const [id, values] of Object.entries(parsed.sources ?? {})) {
            if (values && typeof values === 'object') {
                overrides.set(id, values);
            }
        }
    } catch {
        return;
    }
}

export function reloadOverrides(): void {
    if (overridesFile) {
        loadOverrides(overridesFile);
    }
}

export function config<T extends ConfigValues>(id: string, defaults: T): T {
    const over = overrides.get(id);
    if (!over) {
        return defaults;
    }
    const merged: ConfigValues = { ...defaults };
    for (const [key, value] of Object.entries(over)) {
        if (key in merged && (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')) {
            merged[key] = value;
        }
    }
    return merged as T;
}
