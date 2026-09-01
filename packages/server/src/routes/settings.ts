import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import type { DownloadQueue, QueueSettings } from '../downloader/queue.js';
import { parseLanguageList } from '../languages.js';
import type { CoverService } from '../library/covers.js';

const QUEUE_SETTINGS_KEY = 'queue-settings';
const LANGUAGES_KEY = 'preferred-languages';
const UI_LANGUAGE_KEY = 'ui-language';
const INCOMPLETE_DETECTION_KEY = 'incomplete-detection';
const STALLED_DETECTION_KEY = 'stalled-detection';
const AUTO_MIGRATE_EXACT_KEY = 'auto-migrate-exact';

/** Opt-in boolean flags sharing the same validate/persist/read logic:
 *  PATCH body field → KV store key. */
const BOOLEAN_FLAGS = [
    { field: 'incompleteSourceDetection', key: INCOMPLETE_DETECTION_KEY },
    { field: 'stalledSourceDetection', key: STALLED_DETECTION_KEY },
    { field: 'autoMigrateExactMatch', key: AUTO_MIGRATE_EXACT_KEY }
] as const;

type BooleanFlagField = (typeof BOOLEAN_FLAGS)[number]['field'];

export type UiLanguage = 'en' | 'fr';

/** Read a JSON value from the KV store, falling back when missing or corrupt. */
function readJsonSetting<T>(db: Database, key: string, fallback: T): T {
    try {
        const raw = db.kvGet(key);
        return raw === undefined ? fallback : (JSON.parse(raw) as T);
    } catch {
        return fallback;
    }
}

/** Current value of every opt-in boolean flag (served by GET/PATCH /api/settings). */
function readBooleanFlags(db: Database): Record<BooleanFlagField, boolean> {
    return Object.fromEntries(BOOLEAN_FLAGS.map(({ field, key }) => [field, readJsonSetting<boolean>(db, key, false)])) as Record<BooleanFlagField, boolean>;
}

/** Queue settings persisted in the KV store. Legacy installs (single global
 * concurrency cap) may still carry an old "concurrency" value, hence the extra field. */
export type PersistedQueueSettings = Partial<QueueSettings> & { concurrency?: number };

/** Load persisted queue settings (merged over the built-in defaults at startup). */
export function loadPersistedQueueSettings(db: Database): PersistedQueueSettings {
    return readJsonSetting<PersistedQueueSettings>(db, QUEUE_SETTINGS_KEY, {});
}

/** Persist queue settings in the KV store (read back at startup). */
export function persistQueueSettings(db: Database, settings: QueueSettings): void {
    db.kvSet(QUEUE_SETTINGS_KEY, JSON.stringify(settings));
}

/** Preferred chapter/source languages (ISO codes); empty = no filter (all).
 *  Defaults to English until the user picks otherwise; the dashboard always
 *  saves an explicit list (possibly empty), so the default only applies to
 *  installs that never touched the setting. Persisted in the KV store. */
export function createLanguagePreference(db: Database): () => string[] {
    return () => readJsonSetting<string[]>(db, LANGUAGES_KEY, ['en']);
}

/** Opt-in starved-source detection: after a check, entries carrying very few
 *  chapters get searched on the other sources and a migration suggestion is
 *  stored when one of them offers far more chapters. Persisted in the KV store. */
export function createIncompleteDetectionPref(db: Database): () => boolean {
    return () => readJsonSetting<boolean>(db, INCOMPLETE_DETECTION_KEY, false);
}

/** Opt-in stalled-source detection: series with no new chapter for
 *  abnormally long given their own release rhythm get searched on the other
 *  sources; a migration suggestion is stored when one of them carries more
 *  chapters. Persisted in the KV store. */
export function createStalledDetectionPref(db: Database): () => boolean {
    return () => readJsonSetting<boolean>(db, STALLED_DETECTION_KEY, false);
}

/** Opt-in auto-migration: migration suggestions whose title match is exact
 *  (score ~1) are applied immediately without user confirmation. Persisted in
 *  the KV store. */
export function createAutoMigrateExactPref(db: Database): () => boolean {
    return () => readJsonSetting<boolean>(db, AUTO_MIGRATE_EXACT_KEY, false);
}

/** Dashboard interface language; English until the user picks otherwise. */
export function readUiLanguage(db: Database): UiLanguage {
    return db.kvGet(UI_LANGUAGE_KEY) === 'fr' ? 'fr' : 'en';
}

/** Total size in bytes of all files under a directory (recursive). */
export function directorySize(directory: string): number {
    let total = 0;
    const walk = (dir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                try {
                    total += fs.statSync(full).size;
                } catch {
                    /* skip unreadable files */
                }
            }
        }
    };
    walk(directory);
    return total;
}

export function registerSettingsRoutes(app: FastifyInstance, queue: DownloadQueue, db: Database, covers?: CoverService): void {
    const getLanguages = createLanguagePreference(db);

    app.get('/api/settings', async () => {
        const settings = queue.getSettings();
        return {
            queue: settings,
            diskUsedBytes: directorySize(settings.dataDirectory),
            preferredLanguages: getLanguages(),
            uiLanguage: readUiLanguage(db),
            useFirstChapterCovers: covers?.isEnabled() ?? false,
            ...readBooleanFlags(db)
        };
    });

    app.patch<{
        Body: Partial<QueueSettings> & {
            preferredLanguages?: string[] | string;
            uiLanguage?: string;
            useFirstChapterCovers?: boolean;
            incompleteSourceDetection?: boolean;
            stalledSourceDetection?: boolean;
            autoMigrateExactMatch?: boolean;
        };
    }>('/api/settings', async (request, reply) => {
        const body = request.body;
        if (!body || typeof body !== 'object') {
            return reply.code(400).send({ error: 'Body must be an object' });
        }
        if (body.chapterFormat !== undefined && body.chapterFormat !== 'img' && body.chapterFormat !== 'cbz') {
            return reply.code(400).send({ error: 'chapterFormat must be "img" or "cbz"' });
        }
        if (body.uiLanguage !== undefined && body.uiLanguage !== 'en' && body.uiLanguage !== 'fr') {
            return reply.code(400).send({ error: 'uiLanguage must be "en" or "fr"' });
        }
        if (
            body.historyRetentionDays !== undefined &&
            (typeof body.historyRetentionDays !== 'number' || !Number.isFinite(body.historyRetentionDays) || body.historyRetentionDays < 0)
        ) {
            return reply.code(400).send({ error: 'historyRetentionDays must be a number of days (0 keeps everything)' });
        }
        if (body.useFirstChapterCovers !== undefined && typeof body.useFirstChapterCovers !== 'boolean') {
            return reply.code(400).send({ error: 'useFirstChapterCovers must be a boolean' });
        }
        for (const { field } of BOOLEAN_FLAGS) {
            if (body[field] !== undefined && typeof body[field] !== 'boolean') {
                return reply.code(400).send({ error: `${field} must be a boolean` });
            }
        }
        if (body.dataDirectory !== undefined) {
            if (typeof body.dataDirectory !== 'string' || !body.dataDirectory.trim()) {
                return reply.code(400).send({ error: 'dataDirectory must be a non-empty path' });
            }
            try {
                fs.mkdirSync(path.resolve(body.dataDirectory.trim()), { recursive: true });
            } catch (error) {
                return reply.code(400).send({ error: `Cannot create/use directory: ${(error as Error).message}` });
            }
        }
        if (body.preferredLanguages !== undefined) {
            const raw = Array.isArray(body.preferredLanguages) ? body.preferredLanguages.join(',') : String(body.preferredLanguages);
            db.kvSet(LANGUAGES_KEY, JSON.stringify(parseLanguageList(raw)));
        }
        if (body.uiLanguage !== undefined) {
            db.kvSet(UI_LANGUAGE_KEY, body.uiLanguage);
        }
        for (const { field, key } of BOOLEAN_FLAGS) {
            if (body[field] !== undefined) {
                db.kvSet(key, JSON.stringify(body[field]));
            }
        }
        if (body.useFirstChapterCovers !== undefined && covers) {
            const previous = covers.isEnabled();
            covers.setEnabled(body.useFirstChapterCovers);
            if (body.useFirstChapterCovers && !previous) {
                covers.regenerate(); // builds the cache in the background
            } else if (!body.useFirstChapterCovers && previous) {
                covers.clear();
            }
        }
        const settings = queue.updateSettings(body);
        persistQueueSettings(db, settings);
        return {
            queue: settings,
            preferredLanguages: getLanguages(),
            uiLanguage: readUiLanguage(db),
            useFirstChapterCovers: covers?.isEnabled() ?? false,
            ...readBooleanFlags(db)
        };
    });
}
