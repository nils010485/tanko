import { readFileSync } from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: {
        __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
        alias: {
            '@tanko/shared': path.resolve(__dirname, '../shared/src/index.ts')
        }
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:8080',
            '/health': 'http://localhost:8080',
            '/ws': { target: 'ws://localhost:8080', ws: true }
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true
    }
});
