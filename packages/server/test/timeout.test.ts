import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/util/timeout.js';

describe('withTimeout', () => {
    it('resolves with the promise value when it settles in time', async () => {
        const fast = new Promise<string>(resolve => setTimeout(() => resolve('done'), 10));
        expect(await withTimeout(fast, 1000, 'fast op')).toBe('done');
    });

    it('rejects with a labelled timeout error when the promise hangs', async () => {
        const hanging = new Promise<string>(() => undefined);
        await expect(withTimeout(hanging, 20, 'chapter check')).rejects.toThrow('chapter check timed out after 20ms');
    });

    it('propagates the original rejection untouched', async () => {
        const failing = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error('boom')), 10));
        await expect(withTimeout(failing, 1000, 'op')).rejects.toThrow('boom');
    });
});
