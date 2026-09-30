import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainGate } from '../src/downloader/rate-limiter.js';

describe('DomainGate', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('enforces a minimum delay between requests to the same domain', async () => {
        vi.useFakeTimers();
        const gate = new DomainGate(120);
        const start = Date.now();
        await gate.pass('https://example.com/a.jpg');
        let released = false;
        const second = gate.pass('https://example.com/b.jpg').then(() => {
            released = true;
        });
        await vi.advanceTimersByTimeAsync(119);
        expect(released).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await second;
        expect(released).toBe(true);
        expect(Date.now() - start).toBe(120);
    });

    it('does not throttle different domains against each other', async () => {
        vi.useFakeTimers();
        const gate = new DomainGate(500);
        const start = Date.now();
        await gate.pass('https://one.com/a.jpg');
        await gate.pass('https://two.com/a.jpg');
        expect(Date.now()).toBe(start);
    });

    it('allows reconfiguring the interval', async () => {
        vi.useFakeTimers();
        const gate = new DomainGate(1000);
        gate.setMinInterval(0);
        const start = Date.now();
        await gate.pass('https://example.com/a.jpg');
        await gate.pass('https://example.com/b.jpg');
        expect(Date.now()).toBe(start);
    });
});
