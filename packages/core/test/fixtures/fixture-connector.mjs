/**
 * Legacy-style connector fixture for connector-worker.test.ts. It parses a
 * fetched page with the real createDOM path (linkedom through
 * document.createElement('html')) and records the pid of the process that ran
 * that parse, so the test can prove it did not happen in the runner.
 */
let parsePid = 0;

export default class FixtureConnector {
    constructor() {
        this.id = 'fixture';
        this.label = 'Fixture';
        this.tags = [];
        this.url = 'https://fixture.invalid';
        this.initialized = false;
        this.requestOptions = { method: 'GET', headers: new Headers() };
    }

    async initialize() {
        this.initialized = true;
    }

    _getMangaList(callback) {
        // parsePid is the process that ran the last synchronous parse; the
        // fallback is used before any parse happened (fresh worker)
        callback(null, [{ id: String(parsePid || process.pid), title: 'Fixture Manga' }]);
    }

    _getChapterList(_manga, callback) {
        callback(null, [{ id: '1', title: 'Chapter 1' }]);
    }

    async handleConnectorURI(_uri) {
        return { data: new TextEncoder().encode(`uri-from-${process.pid}`).buffer, mimeType: 'image/png' };
    }

    _getPageList(_manga, chapter, callback) {
        if (chapter.id === 'hang') {
            // never settles: exercises the pool's per-op timeout
            return new Promise(() => undefined);
        }
        return fetch(`${this.url}/chapter/${chapter.id}`, this.requestOptions)
            .then(response => response.text())
            .then(html => {
                const dom = document.createElement('html');
                dom.innerHTML = html;
                parsePid = process.pid;
                callback(
                    null,
                    [...dom.querySelectorAll('img.page')].map(element => element.getAttribute('src'))
                );
            })
            .catch(error => callback(error, undefined));
    }
}
