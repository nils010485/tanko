/**
 * Parse an HTML string into a linkedom document. linkedom's parseHTML() return
 * type does not expose the document field, so the cast lives here, once, for
 * every consumer (request shim, native connectors).
 */
import { parseHTML } from 'linkedom';

export function parseDocument(html: string): Document {
    return (parseHTML(html) as { document: Document }).document;
}
