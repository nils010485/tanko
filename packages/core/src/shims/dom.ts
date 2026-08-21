/**
 * Parse an HTML string into a linkedom document. linkedom's parseHTML() return
 * type does not expose the document field, so the cast lives here, once, for
 * every consumer (request shim, native connectors).
 */
import { parseHTML } from 'linkedom';

export function parseDocument(html: string): Document {
    const { document } = parseHTML(html) as { document: Document };
    patchLinkedomDocument(document);
    return document;
}

/**
 * Apply every linkedom compatibility patch to a freshly parsed document
 * (cheap and idempotent — safe to call on every parse point).
 */
export function patchLinkedomDocument(document: Document): void {
    patchAnchorPathname(document);
    patchAnchorText(document);
}

/**
 * linkedom (0.18) does not implement `pathname` on <a> elements, unlike
 * every browser and jsdom. Connectors read `element.pathname` to build
 * manga/chapter ids, so without this patch every MadTheme-family source
 * silently yields `id: undefined` and crashes later at chapter listing.
 */
function patchAnchorPathname(document: Document): void {
    defineAnchorProperty(document, 'pathname', {
        get(this: { getAttribute(name: string): string | null }) {
            const href = this.getAttribute('href') ?? '';
            if (!href) {
                return '';
            }
            try {
                return new URL(href, 'https://linkedom.invalid').pathname;
            } catch {
                return href;
            }
        }
    });
}

/**
 * linkedom (0.18) does not implement `text` on <a> elements either, unlike
 * browsers/jsdom. Many legacy connectors read `element.text` for titles
 * (WordPressMadara family, MangaKatana, ...) and crash with
 * "Cannot read properties of undefined (reading 'replace')" without it.
 */
function patchAnchorText(document: Document): void {
    defineAnchorProperty(document, 'text', {
        get(this: { textContent: string | null }) {
            return this.textContent ?? '';
        },
        set(this: { textContent: string | null }, value: string) {
            this.textContent = value;
        }
    });
}

/** Define a missing anchor property on the document's anchor prototype (no-op when implemented). */
function defineAnchorProperty(document: Document, name: string, descriptor: PropertyDescriptor): void {
    const prototype = document.querySelector('a')?.constructor?.prototype as object | undefined;
    if (!prototype || name in prototype) {
        return;
    }
    Object.defineProperty(prototype, name, { ...descriptor, configurable: true });
}
