/**
 * Global shims required by the legacy Hakuneko engine + connectors when
 * running outside of the Electron renderer (headless Node.js).
 */
import { parseHTML } from 'linkedom';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

declare global {
    // eslint-disable-next-line no-var
    var __hakunekoShimsInstalled: boolean | undefined;
    // eslint-disable-next-line no-var
    var EventListener: Record<string, string>;
    // eslint-disable-next-line no-var
    var Engine: any;
}

/**
 * Container returned by document.createElement('html').
 * The legacy connectors fill it via `innerHTML` and query it with
 * querySelectorAll/querySelector. linkedom's detached-element innerHTML
 * parsing corrupts its internal node list on some pages (querySelectorAll
 * then throws "Cannot read properties of null (reading 'nodeType')"),
 * so parse with parseHTML() instead — far more robust.
 */
class DOMContainer {
    private _document: any = null;

    set innerHTML(content: string) {
        this._document = parseHTML('<!doctype html>' + content).document;
    }

    get innerHTML(): string {
        return this._document ? this._document.documentElement.innerHTML : '';
    }

    querySelectorAll(selector: string): any {
        return this._document ? this._document.querySelectorAll(selector) : [];
    }

    querySelector(selector: string): any {
        return this._document ? this._document.querySelector(selector) : null;
    }

    getElementsByTagName(tag: string): any {
        return this._document ? this._document.getElementsByTagName(tag) : [];
    }

    getElementById(id: string): any {
        return this._document ? this._document.getElementById(id) : null;
    }

    get body(): any {
        return this._document?.body;
    }

    get documentElement(): any {
        return this._document?.documentElement;
    }

    get textContent(): string {
        return this._document?.documentElement?.textContent || '';
    }
}

export function installGlobals(): void {
    if (globalThis.__hakunekoShimsInstalled) {
        return;
    }
    globalThis.__hakunekoShimsInstalled = true;

    // DOM environment (used by Connector.createDOM, querySelectorAll, etc.)
    const dom: any = parseHTML('<!doctype html><html><head></head><body></body></html>');
    // document events are frontend-only notifications -> make dispatching a no-op
    // (linkedom rejects Node's native CustomEvent instances)
    dom.document.dispatchEvent = () => true;
    // createElement('html') must return the robust parseHTML-backed container
    const realCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = (tag: string) => {
        if (String(tag).toLowerCase() === 'html') {
            return new DOMContainer();
        }
        return realCreateElement(tag);
    };
    Object.assign(globalThis, {
        document: dom.document,
        window: dom.window,
        DOMParser: dom.window.DOMParser
    });

    // Event name constants dispatched by Manga/Chapter/DownloadJob on `document`
    globalThis.EventListener = {
        onChapterStatusChanged: 'onChapterStatusChanged',
        onDownloadStatusUpdated: 'onDownloadStatusUpdated',
        onMangaStatusChanged: 'onMangaStatusChanged',
        onSelectChapter: 'onSelectChapter',
        onSelectConnector: 'onSelectConnector',
        onSelectManga: 'onSelectManga'
    };

    // Minimal FileReader. The legacy engine assigns property handlers
    // (reader.onload / reader.onerror) which Node's EventTarget does not
    // invoke, so call them directly here.
    if (!(globalThis as any).FileReader) {
        (globalThis as any).FileReader = class FileReader {
            result: any;
            error: any;
            onload: ((event: any) => void) | undefined;
            onerror: ((event: any) => void) | undefined;
            readAsArrayBuffer(blob: Blob) {
                blob.arrayBuffer()
                    .then(buffer => {
                        this.result = buffer;
                        this.onload?.({ target: this });
                    })
                    .catch(error => {
                        this.error = error;
                        this.onerror?.({ target: this });
                    });
            }
        };
    }

    // Image validation shim used by some connectors (e.g. MangaDex)
    if (!(globalThis as any).createImageBitmap) {
        (globalThis as any).createImageBitmap = async () => ({ width: 1, height: 1 });
    }

    // Lazy optional dependencies used by some connectors
    Object.defineProperty(globalThis, 'CryptoJS', {
        get: () => require('crypto-js')
    });
    Object.defineProperty(globalThis, 'protobuf', {
        get: () => require('protobufjs')
    });
}
