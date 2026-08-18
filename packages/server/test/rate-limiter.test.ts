import { describe, expect, it } from 'vitest';
import { DomainGate } from '../src/downloader/rate-limiter.js';

describe('DomainGate', () => {
    it('enforces a minimum delay between requests to the same domain', async () => {
        const gate = new DomainGate(120);
        const start = Date.now();
        await gate.pass('https://example.com/a.jpg');
        await gate.pass('https://example.com/b.jpg');
        const elapsed = Date.now() - start;
        expect(elapsed).toBeGreaterThanOrEqual(110);
    });

    it('does not throttle different domains against each other', async () => {
        const gate = new DomainGate(500);
        const start = Date.now();
        await gate.pass('https://one.com/a.jpg');
        await gate.pass('https://two.com/a.jpg');
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(400);
    });

    it('allows reconfiguring the interval', async () => {
        const gate = new DomainGate(1000);
        gate.setMinInterval(0);
        const start = Date.now();
        await gate.pass('https://example.com/a.jpg');
        await gate.pass('https://example.com/b.jpg');
        expect(Date.now() - start).toBeLessThan(300);
    });
});
