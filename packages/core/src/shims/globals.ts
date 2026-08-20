/**
 * Global shims required by the legacy Hakuneko engine + connectors when
 * running outside of the Electron renderer (headless Node.js).
 */

import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';
import type { EngineContext } from '../engine.js';

const require = createRequire(import.meta.url);

declare global {
    var __hakunekoShimsInstalled: boolean | undefined;
    var EventListener: Record<string, string>;
    var Engine: EngineContext;
}

/** linkedom document type, inferred once (no deep import into linkedom's types). */
type ShimDocument = ReturnType<typeof parseHTML>['window']['document'];

/**
 * Container returned by document.createElement('html').
 * The legacy connectors fill it via `innerHTML` and query it with
 * querySelectorAll/querySelector. linkedom's detached-element innerHTML
 * parsing corrupts its internal node list on some pages (querySelectorAll
 * then throws "Cannot read properties of null (reading 'nodeType')"),
 * so parse with parseHTML() instead — far more robust.
 */
class DOMContainer {
    private _document: ShimDocument | null = null;

    set innerHTML(content: string) {
        this._document = parseHTML(`<!doctype html>${content}`).document;
    }

    get innerHTML(): string {
        return this._document ? this._document.documentElement.innerHTML : '';
    }

    querySelectorAll(selector: string) {
        return this._document ? this._document.querySelectorAll(selector) : [];
    }

    querySelector(selector: string) {
        return this._document ? this._document.querySelector(selector) : null;
    }

    getElementsByTagName(tag: string) {
        return this._document ? this._document.getElementsByTagName(tag) : [];
    }

    getElementById(id: string) {
        return this._document ? this._document.getElementById(id) : null;
    }

    get body() {
        return this._document?.body;
    }

    get documentElement() {
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
    const dom = parseHTML('<!doctype html><html><head></head><body></body></html>');
    // document events are frontend-only notifications -> make dispatching a no-op
    // (linkedom rejects Node's native CustomEvent instances)
    dom.document.dispatchEvent = () => true;
    // createElement('html') must return the robust parseHTML-backed container
    const realCreateElement = dom.document.createElement.bind(dom.document);
    dom.document.createElement = ((tag: string) => {
        if (String(tag).toLowerCase() === 'html') {
            return new DOMContainer();
        }
        return realCreateElement(tag);
    }) as typeof dom.document.createElement;
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
    if (typeof globalThis.FileReader === 'undefined') {
        class HeadlessFileReader {
            result: unknown;
            error: unknown;
            onload: ((event: { target: unknown }) => void) | undefined;
            onerror: ((event: { target: unknown }) => void) | undefined;
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
        }
        Object.assign(globalThis, { FileReader: HeadlessFileReader });
    }

    // Image validation shim used by some connectors (e.g. MangaDex)
    if (typeof globalThis.createImageBitmap === 'undefined') {
        Object.assign(globalThis, { createImageBitmap: async () => ({ width: 1, height: 1 }) });
    }

    // Lazy optional dependencies used by some connectors
    Object.defineProperty(globalThis, 'CryptoJS', {
        get: () => require('crypto-js')
    });
    Object.defineProperty(globalThis, 'protobuf', {
        get: () => require('protobufjs')
    });
}
