/**
 * Parse an HTML string into a linkedom document. linkedom's parseHTML() return
 * type does not expose the document field, so the cast lives here, once, for
 * every consumer (request shim, native connectors).
 */
import { parseHTML } from 'linkedom';

export function parseDocument(html: string): Document {
    const { document } = parseHTML(html) as { document: Document };
    patchAnchorPathname(document);
    return document;
}

/**
 * linkedom (0.18) does not implement `pathname` on <a> elements, unlike
 * every browser and jsdom. Connectors read `element.pathname` to build
 * manga/chapter ids, so without this patch every MadTheme-family source
 * silently yields `id: undefined` and crashes later at chapter listing.
 */
function patchAnchorPathname(document: Document): void {
    const anchor = document.querySelector('a');
    const prototype = anchor?.constructor?.prototype as { pathname?: string } | undefined;
    if (!prototype || 'pathname' in prototype) {
        return;
    }
    Object.defineProperty(prototype, 'pathname', {
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
        },
        configurable: true
    });
}
