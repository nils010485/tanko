import { describe, expect, it } from 'vitest';
import { normalizeAsuraPath } from '../src/sources/native/asurascans.js';

describe('normalizeAsuraPath', () => {
    it('strips the shared build code from series paths (decimal or hex)', () => {
        expect(normalizeAsuraPath('/comics/murim-login-08677664')).toBe('/comics/murim-login');
        expect(normalizeAsuraPath('/comics/murim-login-53fc8424/chapter/250')).toBe('/comics/murim-login/chapter/250');
    });

    it('is idempotent and leaves foreign paths alone', () => {
        expect(normalizeAsuraPath('/comics/murim-login')).toBe('/comics/murim-login');
        expect(normalizeAsuraPath('/comics/murim-login/chapter/3')).toBe('/comics/murim-login/chapter/3');
        expect(normalizeAsuraPath('/other/path')).toBe('/other/path');
        // a slug chunk of plain hex-looking words must not be eaten
        expect(normalizeAsuraPath('/comics/solo-leveling-2nd-season')).toBe('/comics/solo-leveling-2nd-season');
    });
});
