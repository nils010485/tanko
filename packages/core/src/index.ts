// Public surface: only what server/tests actually import from the package
// root — internal modules use relative paths (see each shim/module).
export { CONNECTOR_OVERRIDES, createEngine, getVendorDirectory, loadConnectors, VENDOR_PATH } from './engine.js';
export { closeBrowser, isAntiBotShell } from './shims/browser.js';
export { HeadlessRequest, randomUserAgent, retryAfterMs } from './shims/request.js';
export { createComicInfoXML } from './shims/storage.js';
export { LegacySourceAdapter } from './sources/legacy-adapter.js';
export { normalizeAsuraPath } from './sources/native/asurascans.js';
export { MadaraConnector } from './sources/native/madara.js';
export { MangastreamConnector } from './sources/native/mangastream.js';
export { SourceRegistry } from './sources/registry.js';
export type { ChapterInfo, ChapterOptions, HealthResult, MangaInfo, PageList, SourceAdapter } from './sources/types.js';
export { NOT_IN_BROWSER_MODE, SourceError } from './sources/types.js';
