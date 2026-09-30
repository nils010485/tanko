import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, loadOverrides } from '../src/sources/native/config.js';

function writePack(pack: unknown) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-config-')), 'sources-overrides.json');
    fs.writeFileSync(file, JSON.stringify(pack));
    loadOverrides(file);
    return file;
}

describe('config', () => {
    it('returns defaults when no override file exists', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tanko-config-')), 'sources-overrides.json');
        loadOverrides(file);
        expect(config('toonily', { base: 'https://toonily.com', tags: ['manga'] })).toEqual({ base: 'https://toonily.com', tags: ['manga'] });
    });

    it('keeps previous overrides when the file becomes unreadable', () => {
        const file = writePack({ sources: { toonily: { base: 'https://example.org' } } });
        expect(config('toonily', { base: 'https://toonily.com' }).base).toBe('https://example.org');
        fs.writeFileSync(file, '{corrupt');
        loadOverrides(file);
        expect(config('toonily', { base: 'https://toonily.com' }).base).toBe('https://example.org');
    });

    it('merges scalars, string arrays and string maps matching the default type', () => {
        writePack({
            sources: {
                toonily: { base: 'https://example.org', capturePages: true, chapterApiPath: '/api/comics' },
                manhwaread: { tags: ['a', 'b'], selectors: { chapters: '.x' } }
            }
        });
        expect(config('toonily', { base: 'https://toonily.com', capturePages: false, chapterApiPath: '/wp-json' })).toEqual({
            base: 'https://example.org',
            capturePages: true,
            chapterApiPath: '/api/comics'
        });
        expect(config('manhwaread', { tags: ['manga'], selectors: { chapters: '.a', chapterAnchor: '' } })).toEqual({
            tags: ['a', 'b'],
            selectors: { chapters: '.x' }
        });
    });

    it('ignores id overrides, unknown sources and keys, and type mismatches', () => {
        writePack({
            sources: {
                toonily: { id: 'renamed', unknown: 'x', tags: 'not-an-array', capturePages: 'not-a-boolean', base: 'https://example.org' },
                ghost: { base: 'https://ghost.example' }
            }
        });
        const merged = config('toonily', { id: 'toonily', base: 'https://toonily.com', tags: ['manga'], capturePages: false });
        expect(merged).toEqual({ id: 'toonily', base: 'https://example.org', tags: ['manga'], capturePages: false });
        expect(config('other', { base: 'https://other.com' })).toEqual({ base: 'https://other.com' });
    });

    it('never overrides RegExp defaults', () => {
        writePack({ sources: { manhwaread: { captureImagePattern: 'https://evil.example/' } } });
        const pattern = /native_/gi;
        expect(config('manhwaread', { captureImagePattern: pattern }).captureImagePattern).toBe(pattern);
    });
});
