import { defineConfig } from 'vitest/config';

/**
 * Root entry point so `npx vitest run …` works from the monorepo root.
 * Delegates to each package's own config (the server's raises the test
 * timeout to 30s for its retry-backoff scenarios — the 5s default is too
 * short and cascading timeouts follow).
 */
export default defineConfig({
    test: {
        projects: ['packages/server']
    }
});
