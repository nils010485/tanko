import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, loadOverrides } from '../src/sources/native/config.js';

function freshOverridesFile(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-config-')), 'sources-overrides.json');
    loadOverrides(file);
    return file;
}

function writePack(pack: unknown) {
    fs.writeFileSync(overridesFile, JSON.stringify(pack));
    loadOverrides(overridesFile);
}

let overridesFile: string;

describe('config', () => {
    it('returns defaults when no override file exists', () => {
        overridesFile = freshOverridesFile();
        writePack({});
        expect(config('toonily', { base: 'https://toonily.com', tags: ['manga'] })).toEqual({ base: 'https://toonily.com', tags: ['manga'] });
    });

    it('merges known keys and ignores unknown sources and keys', () => {
        overridesFile = freshOverridesFile();
        writePack({
            sources: {
                toonily: { base: 'https://example.org', unknown: 'x' },
                ghost: { base: 'https://ghost.example' }
            }
        });
        expect(config('toonily', { base: 'https://toonily.com', tags: ['manga'] })).toEqual({ base: 'https://example.org', tags: ['manga'] });
        expect(config('other', { base: 'https://other.com' })).toEqual({ base: 'https://other.com' });
    });

    it('overrides booleans and keeps scalar types only', () => {
        overridesFile = freshOverridesFile();
        writePack({ sources: { madara: { capturePages: true, chapterApiPath: '/api/comics' } } });
        expect(config('madara', { capturePages: false, chapterApiPath: '/wp-json', base: 'https://m.example' })).toEqual({
            capturePages: true,
            chapterApiPath: '/api/comics',
            base: 'https://m.example'
        });
    });
});
