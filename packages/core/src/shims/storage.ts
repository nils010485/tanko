/**
 * Headless replacement for Engine.Storage. The server owns downloads (its
 * downloader writes files/CBZ itself); what the legacy engine still needs is
 * the catalog cache (<data>/config/hakuneko.mangas-<connector>) and the path
 * sanitizer the vendor Chapter/Manga constructors call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LegacyConnector, LegacyManga } from '../legacy-types.js';
import type { HeadlessSettings } from './settings.js';

export function createComicInfoXML(mangaName: string, chapterName: string, pageCount: number): string {
    const escapeXml = (text: unknown) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Series>${escapeXml(mangaName)}</Series>
  <Title>${escapeXml(chapterName)}</Title>
  <PageCount>${pageCount}</PageCount>
  <LanguageISO>en</LanguageISO>
  <Manga>Yes</Manga>
</ComicInfo>`;
}

export class HeadlessStorage {
    readonly settings: HeadlessSettings;
    readonly platform: string;
    readonly temp: string;
    private readonly _configDir: string;

    constructor(settings: HeadlessSettings) {
        this.settings = settings;
        this.platform = process.platform;
        this.temp = path.join(os.tmpdir(), 'hakuneko-headless');
        fs.mkdirSync(this.temp, { recursive: true });
        this._configDir = path.join(path.dirname(settings.file), 'config');
        fs.mkdirSync(this._configDir, { recursive: true });
    }

    private _configFile(key: string): string {
        return path.join(this._configDir, `hakuneko.${key}`);
    }

    async saveConfig(key: string, value: unknown, indentation?: number): Promise<void> {
        fs.writeFileSync(this._configFile(key), JSON.stringify(value, undefined, indentation));
    }

    async loadConfig<T = unknown>(key: string): Promise<T> {
        return JSON.parse(fs.readFileSync(this._configFile(key), 'utf8')) as T;
    }

    saveMangaList(connectorID: string, mangas: Array<{ id: string; title: string }>): Promise<void> {
        return this.saveConfig(
            `mangas-${connectorID}`,
            mangas.map(manga => ({ id: manga.id, title: manga.title }))
        );
    }

    loadMangaList(connectorID: string): Promise<Array<{ id: string; title: string }>> {
        return this.loadConfig(`mangas-${connectorID}`);
    }

    /** List names on disk (optionally directories only); missing directory -> empty. */
    private _existingNames(directory: string, directoriesOnly: boolean): Record<string, boolean> {
        const names: Record<string, boolean> = {};
        try {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!directoriesOnly || entry.isDirectory()) {
                    names[entry.name] = true;
                }
            }
        } catch {
            /* directory does not exist yet */
        }
        return names;
    }

    async getExistingMangaTitles(connector: LegacyConnector): Promise<Record<string, boolean>> {
        return this._existingNames(this._connectorOutputPath(connector), true);
    }

    async getExistingChapterTitles(manga: LegacyManga): Promise<Record<string, boolean>> {
        return this._existingNames(this._mangaOutputPath(manga), false);
    }

    _connectorOutputPath(connector: LegacyConnector): string {
        let output = String(this.settings.baseDirectory.value);
        if (connector.config?.path) {
            output = connector.config.path.value;
        } else if (this.settings.useSubdirectory.value) {
            output = path.join(output, this.sanatizePath(connector.label));
        }
        return output;
    }

    _mangaOutputPath(manga: LegacyManga): string {
        return path.join(this._connectorOutputPath(manga.connector), this.sanatizePath(manga.title));
    }

    sanatizePath(name: string): string {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping C0/C1 control characters is the whole point of this sanitizer
        name = name.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
        if (this.platform.startsWith('win')) {
            name = name.replace(/[\\/:*?"<>|]/g, '');
        }
        if (this.platform.startsWith('linux')) {
            name = name.replace(/[/]/g, '');
        }
        if (this.platform.startsWith('darwin')) {
            name = name.replace(/[/:]/g, '');
        }
        return name.replace(/[.\s]+$/g, '').trim();
    }

    async saveTempFile(name: string, data: string | NodeJS.ArrayBufferView): Promise<string> {
        const file = path.join(this.temp, this.sanatizePath(name));
        fs.writeFileSync(file, data);
        return file;
    }
}
