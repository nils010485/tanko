import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db.js';
import type { DownloadQueue, QueueSettings } from '../downloader/queue.js';
import type { CoverService } from '../library/covers.js';
import { parseLanguageList } from '../languages.js';

const QUEUE_SETTINGS_KEY = 'queue-settings';
const LANGUAGES_KEY = 'preferred-languages';
const UI_LANGUAGE_KEY = 'ui-language';

export type UiLanguage = 'en' | 'fr';

/** Read a JSON value from the KV store, falling back when missing or corrupt. */
function readJsonSetting<T>(db: Database, key: string, fallback: T): T {
    try {
        const raw = db.kvGet(key);
        return raw === undefined ? fallback : JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

/** Load persisted queue settings (merged over env defaults at startup). */
export function loadPersistedQueueSettings(db: Database): Partial<QueueSettings> {
    return readJsonSetting<Partial<QueueSettings>>(db, QUEUE_SETTINGS_KEY, {});
}

/** Preferred chapter/source languages (ISO codes); env default, persisted override, live reads. */
export function createLanguagePreference(db: Database): () => string[] {
    const fallback = parseLanguageList(process.env.PREFERRED_LANGUAGES);
    return () => readJsonSetting<string[]>(db, LANGUAGES_KEY, fallback);
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
                } catch { /* skip unreadable files */ }
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
        return { queue: settings, diskUsedBytes: directorySize(settings.dataDirectory), preferredLanguages: getLanguages(), uiLanguage: readUiLanguage(db), useFirstChapterCovers: covers?.isEnabled() ?? false };
    });

    app.patch<{ Body: Partial<QueueSettings> & { preferredLanguages?: string[] | string; uiLanguage?: string; useFirstChapterCovers?: boolean } }>(
        '/api/settings',
        async (request, reply) => {
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
            if (body.historyRetentionDays !== undefined
                && (typeof body.historyRetentionDays !== 'number' || !Number.isFinite(body.historyRetentionDays) || body.historyRetentionDays < 0)) {
                return reply.code(400).send({ error: 'historyRetentionDays must be a number of days (0 keeps everything)' });
            }
            if (body.useFirstChapterCovers !== undefined && typeof body.useFirstChapterCovers !== 'boolean') {
                return reply.code(400).send({ error: 'useFirstChapterCovers must be a boolean' });
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
            return { queue: settings, preferredLanguages: getLanguages(), uiLanguage: readUiLanguage(db), useFirstChapterCovers: covers?.isEnabled() ?? false };
        }
    );
}
