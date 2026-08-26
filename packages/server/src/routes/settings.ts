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

/** Queue settings persisted in the KV store. Legacy installs (single global
 * concurrency cap) may still carry an old "concurrency" value, hence the extra field. */
export type PersistedQueueSettings = Partial<QueueSettings> & { concurrency?: number };

/** Load persisted queue settings (merged over the built-in defaults at startup). */
export function loadPersistedQueueSettings(db: Database): PersistedQueueSettings {
    return readJsonSetting<PersistedQueueSettings>(db, QUEUE_SETTINGS_KEY, {});
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
            incompleteSourceDetection: readJsonSetting<boolean>(db, INCOMPLETE_DETECTION_KEY, false),
            stalledSourceDetection: readJsonSetting<boolean>(db, STALLED_DETECTION_KEY, false)
        };
    });

    app.patch<{
        Body: Partial<QueueSettings> & {
            preferredLanguages?: string[] | string;
            uiLanguage?: string;
            useFirstChapterCovers?: boolean;
            incompleteSourceDetection?: boolean;
            stalledSourceDetection?: boolean;
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
        if (body.incompleteSourceDetection !== undefined && typeof body.incompleteSourceDetection !== 'boolean') {
            return reply.code(400).send({ error: 'incompleteSourceDetection must be a boolean' });
        }
        if (body.stalledSourceDetection !== undefined && typeof body.stalledSourceDetection !== 'boolean') {
            return reply.code(400).send({ error: 'stalledSourceDetection must be a boolean' });
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
        if (body.incompleteSourceDetection !== undefined) {
            db.kvSet(INCOMPLETE_DETECTION_KEY, JSON.stringify(body.incompleteSourceDetection));
        }
        if (body.stalledSourceDetection !== undefined) {
            db.kvSet(STALLED_DETECTION_KEY, JSON.stringify(body.stalledSourceDetection));
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
        db.kvSet(QUEUE_SETTINGS_KEY, JSON.stringify(settings));
        return {
            queue: settings,
            preferredLanguages: getLanguages(),
            uiLanguage: readUiLanguage(db),
            useFirstChapterCovers: covers?.isEnabled() ?? false,
            incompleteSourceDetection: readJsonSetting<boolean>(db, INCOMPLETE_DETECTION_KEY, false),
            stalledSourceDetection: readJsonSetting<boolean>(db, STALLED_DETECTION_KEY, false)
        };
    });
}
