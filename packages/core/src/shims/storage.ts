/**
 * Headless replacement for Engine.Storage.
 * Keeps the same on-disk layout as Hakuneko:
 *   <base>/<Connector>/<Manga>/<Chapter>/{01.jpg,...}   (format 'img')
 *   <base>/<Connector>/<Manga>/<Chapter>.cbz            (format '.cbz')
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import JSZip from 'jszip';
import type { HeadlessSettings } from './settings.js';

const extensions = {
    img: 'img',
    cbz: '.cbz'
};

/** One page of a chapter, ready to be written to disk. */
interface PageData {
    name: string;
    data: Blob;
}

export function createComicInfoXML(mangaName: string, chapterName: string, pageCount: number): string {
    const escape = (text: any) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <Series>${escape(mangaName)}</Series>
  <Title>${escape(chapterName)}</Title>
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

    // ------------------------------------------------------------------
    // config (manga lists, etc.)
    // ------------------------------------------------------------------

    private _configFile(key: string): string {
        return path.join(this._configDir, 'hakuneko.' + key);
    }

    async saveConfig(key: string, value: any, indentation?: number): Promise<void> {
        fs.writeFileSync(this._configFile(key), JSON.stringify(value, undefined, indentation));
    }

    async loadConfig(key: string): Promise<any> {
        return JSON.parse(fs.readFileSync(this._configFile(key), 'utf8'));
    }

    saveMangaList(connectorID: string, mangas: any[]): Promise<void> {
        return this.saveConfig('mangas-' + connectorID, mangas.map(manga => ({ id: manga.id, title: manga.title })));
    }

    loadMangaList(connectorID: string): Promise<any[]> {
        return this.loadConfig('mangas-' + connectorID);
    }

    // ------------------------------------------------------------------
    // existing content on disk
    // ------------------------------------------------------------------

    /** List names on disk (optionally directories only); missing directory -> empty. */
    private _existingNames(directory: string, directoriesOnly: boolean): Record<string, boolean> {
        const names: Record<string, boolean> = {};
        try {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (!directoriesOnly || entry.isDirectory()) {
                    names[entry.name] = true;
                }
            }
        } catch { /* directory does not exist yet */ }
        return names;
    }

    async getExistingMangaTitles(connector: any): Promise<Record<string, boolean>> {
        return this._existingNames(this._connectorOutputPath(connector), true);
    }

    async getExistingChapterTitles(manga: any): Promise<Record<string, boolean>> {
        return this._existingNames(this._mangaOutputPath(manga), false);
    }

    // ------------------------------------------------------------------
    // chapter download
    // ------------------------------------------------------------------

    async saveChapterPages(chapter: any, content: Blob[]): Promise<void> {
        const leadingZeroes = String(content.length).length;
        const pageData: PageData[] = content.map((page, index) => ({
            name: this._pageFileName(index + 1, page.type, leadingZeroes),
            data: page
        }));

        const output = this._chapterOutputPath(chapter);
        const format = this.settings.chapterFormat.value;
        if (format === extensions.img) {
            this._createDirectoryChain(output);
            await this._saveChapterPagesFolder(output, pageData);
        } else if (format === extensions.cbz) {
            this._createDirectoryChain(path.dirname(output));
            await this._saveChapterPagesCBZ(output, pageData, chapter.manga.title, chapter.title);
        } else {
            throw new Error('Unsupported output format: ' + format);
        }
        this._runPostChapterDownloadCommand(chapter, output);
    }

    private async _saveChapterPagesFolder(directory: string, pageData: PageData[]): Promise<void> {
        for (const page of pageData) {
            const data = Buffer.from(await page.data.arrayBuffer());
            fs.writeFileSync(path.join(directory, page.name), data);
        }
    }

    private async _saveChapterPagesCBZ(archive: string, pageData: PageData[], mangaName: string, chapterName: string): Promise<void> {
        const zip = new JSZip();
        zip.file('ComicInfo.xml', createComicInfoXML(mangaName, chapterName, pageData.length));
        for (const page of pageData) {
            zip.file(page.name, Buffer.from(await page.data.arrayBuffer()));
        }
        const data = await zip.generateAsync({ compression: 'STORE', type: 'nodebuffer' });
        fs.writeFileSync(archive, data);
    }

    private _runPostChapterDownloadCommand(chapter: any, outputPath: string): void {
        let command = this.settings.postChapterDownloadCommand.value;
        if (command) {
            command = command.replace(/%PATH%/g, outputPath)
                .replace(/%C%/g, chapter.manga.connector.label)
                .replace(/%M%/g, chapter.manga.title)
                .replace(/%O%/g, chapter.title);
            exec(command, { cwd: path.dirname(outputPath) }, error => {
                if (error) {
                    console.error('[storage] post-download command failed:', error);
                }
            });
        }
    }

    async loadChapterPages(chapter: any): Promise<string[]> {
        const directory = this._chapterOutputPath(chapter);
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
            throw new Error('No chapter content found: ' + directory);
        }
        return fs.readdirSync(directory)
            .filter(file => !file.startsWith('.'))
            .sort()
            .map(file => encodeURI('file://' + path.join(directory, file).replace(/\\/g, '/')));
    }

    // ------------------------------------------------------------------
    // output paths (same layout as legacy Storage)
    // ------------------------------------------------------------------

    _connectorOutputPath(connector: any): string {
        let output = this.settings.baseDirectory.value;
        if (connector.config && connector.config.path) {
            output = connector.config.path.value;
        } else if (this.settings.useSubdirectory.value) {
            output = path.join(output, this.sanatizePath(connector.label));
        }
        return output;
    }

    _mangaOutputPath(manga: any): string {
        return path.join(this._connectorOutputPath(manga.connector), this.sanatizePath(manga.title));
    }

    _chapterOutputPath(chapter: any): string {
        let output = path.join(this._mangaOutputPath(chapter.manga), this.sanatizePath(chapter.title));
        const format = this.settings.chapterFormat.value;
        if (format !== extensions.img) {
            output += format;
        }
        return output;
    }

    _createDirectoryChain(directory: string): void {
        fs.mkdirSync(directory, { recursive: true });
    }

    sanatizePath(name: string): string {
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

    _pageFileName(number: number, mimeType: string, leadingZeroes: number): string {
        const fileName = String(number).padStart(leadingZeroes, '0');
        const map: Array<[string, string]> = [
            ['image/webp', '.webp'],
            ['image/jpeg', '.jpg'],
            ['image/png', '.png'],
            ['image/gif', '.gif'],
            ['image/bmp', '.bmp'],
            ['image/', '.img']
        ];
        for (const [mime, ext] of map) {
            if (mimeType && mimeType.indexOf(mime) > -1) {
                return fileName + ext;
            }
        }
        return fileName + '.bin';
    }

    async saveTempFile(name: string, data: any): Promise<string> {
        const file = path.join(this.temp, this.sanatizePath(name));
        fs.writeFileSync(file, data);
        return file;
    }
}
