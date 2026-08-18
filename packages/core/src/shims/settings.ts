/**
 * Headless replacement for Engine.Settings.
 * Provides the same `{ key: { value, ... } }` shape that the legacy engine
 * expects, persisted as JSON in the data directory.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SettingEntry {
    value: any;
    label?: string;
}

/** True when the value looks like a setting entry ({ value, ... }). */
function isSettingEntry(value: unknown): value is SettingEntry {
    return value !== null && typeof value === 'object' && 'value' in value;
}

export class HeadlessSettings extends EventTarget {

    [key: string]: any;

    readonly file: string;

    constructor(dataDirectory: string) {
        super();
        this.file = path.join(dataDirectory, 'settings.json');
        fs.mkdirSync(dataDirectory, { recursive: true });

        this.baseDirectory = { value: path.join(dataDirectory, 'downloads'), label: 'Download Directory' };
        this.bookmarkDirectory = { value: path.join(dataDirectory, 'bookmarks'), label: 'Bookmark Directory' };
        this.useSubdirectory = { value: true, label: 'Use Connector Sub-Directories' };
        this.chapterFormat = { value: 'img', label: 'Chapter Format' }; // img | .cbz
        this.chapterTitleFormat = { value: '%O%', label: 'Chapter Title Format' };
        this.useSequentialMediaDownloads = { value: false, label: 'Sequential Downloads' };
        this.ignoreErrorOnDownload = { value: false, label: 'Ignore Download Errors' };
        this.postChapterDownloadCommand = { value: '', label: 'Post Download Command' };
        this.proxyRules = { value: '', label: 'Proxy' };
        this.proxyAuth = { value: '', label: 'Proxy Auth' };
        this.hCaptchaAccessibilityUUID = { value: '', label: 'hCaptcha UUID' };

        this.load();
    }

    load(): void {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            for (const key of Object.keys(data)) {
                if (isSettingEntry(this[key])) {
                    this[key].value = data[key];
                }
            }
        } catch { /* no persisted settings yet */ }
        this.dispatchEvent(new CustomEvent('loaded', { detail: this }));
    }

    save(): void {
        const data: Record<string, any> = {};
        for (const key of Object.keys(this)) {
            if (key.startsWith('_') || key === 'file') {
                continue;
            }
            const entry = this[key];
            if (isSettingEntry(entry)) {
                data[key] = entry.value;
            }
        }
        fs.writeFileSync(this.file, JSON.stringify(data, undefined, 2));
        this.dispatchEvent(new CustomEvent('saved', { detail: this }));
    }
}
