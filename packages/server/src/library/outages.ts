/**
 * Source outages and failure counters: the store's "source health / failover"
 * half. Outage rows track source-wide download waves (with flap handling and
 * escalation); the counters feed the failover regimes; the staleness helpers
 * learn each series' release rhythm to detect stalled ones.
 */
import type { StoreContext } from './context.js';
import { OUTAGE_ESCALATION_MS, OUTAGE_SILENCE_MS } from './failover.js';
import type { OutageRow, SourceOutage, StalledCandidate } from './rows.js';
import { toOutage } from './rows.js';

/** Stalled-series detection (failover's "stalled" regime): an entry becomes a
 *  probe candidate when its last new chapter is older than
 *  max(STALE_RHYTHM_FACTOR × its own observed rhythm, STALE_FLOOR_DAYS). The
 *  rhythm is learned from the gaps between distinct chapter-discovery events
 *  (a check that finds several chapters counts as one event); too few events
 *  (series imported in bulk) falls back to a fixed STALE_FALLBACK_DAYS. A
 *  probe that finds no richer source (probable hiatus) backs off
 *  exponentially before probing again. */
const DAY_MS = 86_400_000;
/** Rhythm multiplier: stalled = idle for 3 × the series' own median gap. */
const STALE_RHYTHM_FACTOR = 3;
/** Floor: even a fast series must be idle this long before looking stalled. */
const STALE_FLOOR_DAYS = 14;
/** Fallback when too few distinct discovery events exist to learn a rhythm. */
const STALE_FALLBACK_DAYS = 30;
/** Distinct discovery events used to learn the rhythm (their ~12 gaps). */
const STALE_CADENCE_EVENTS = 13;
/** Minimum distinct gaps before the learned rhythm is trusted. */
const STALE_CADENCE_MIN_GAPS = 4;
/** Back-off after a probe that found no richer source: 7d, 14d, 28d… */
const STALE_BACKOFF_BASE_MS = 7 * DAY_MS;
/** …capped so a probable hiatus stops costing probes. */
const STALE_BACKOFF_MAX_MS = 45 * DAY_MS;

/** Download failures since the last failover probe (the probe resets the
 *  counter). Successes deliberately do not: a failing batch interleaved
 *  with successes must still trip the failover. */
export function recordDownloadFailure(ctx: StoreContext, entryId: number): number {
    ctx.db.db.prepare('UPDATE library SET download_failures = download_failures + 1 WHERE id = ?').run(entryId);
    return Number((ctx.q.get('SELECT download_failures AS n FROM library WHERE id = ?', entryId) as { n: number } | undefined)?.n ?? 0);
}

export function resetDownloadFailures(ctx: StoreContext, entryId: number): void {
    ctx.db.db.prepare('UPDATE library SET download_failures = 0 WHERE id = ?').run(entryId);
}

/** Distinct entries of this source with a failed download job inside the
 *  window — several at once is a source outage, not per-series rot. */
export function countRecentSourceFailures(ctx: StoreContext, sourceId: string, windowMs: number): number {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = ctx.q.get<{ n: number }>(
        "SELECT COUNT(DISTINCT entry_id) AS n FROM download_jobs WHERE source_id = ? AND status = 'failed' AND entry_id IS NOT NULL AND updated_at > ?",
        sourceId,
        cutoff
    );
    return Number(row?.n ?? 0);
}

/** Entries of this source currently failing their checks (the counter
 *  resets on the first success). Several at once means the source itself
 *  is broken (API change, block) — not per-series rot. */
export function countEntriesWithCheckFailures(ctx: StoreContext, sourceId: string): number {
    const row = ctx.q.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM library WHERE source_id = ? AND hidden = 0 AND paused = 0 AND check_failures > 0',
        sourceId
    );
    return Number(row?.n ?? 0);
}

/** Note a failure on the source-outage record. `open` creates the row
 *  (INSERT OR IGNORE keeps the original started_at of the wave); a refresh
 *  only bumps an existing one. A closed record is reactivated on open: a
 *  quick reopen (flap) resumes the previous wave — escalation included —
 *  while a stale close starts a fresh clock. Arms the escalation stamp
 *  when the outage has lasted long enough — idempotent. Returns undefined
 *  when no outage row exists (refresh without a prior open). */
export function noteSourceFailure(ctx: StoreContext, sourceId: string, open: boolean): SourceOutage | undefined {
    const now = new Date();
    const iso = now.toISOString();
    if (open) {
        ctx.db.db.prepare('INSERT OR IGNORE INTO source_outages (source_id, started_at, last_seen_at, failures) VALUES (?, ?, ?, 0)').run(sourceId, iso, iso);
    }
    const row = ctx.q.get<OutageRow>('SELECT * FROM source_outages WHERE source_id = ?', sourceId);
    if (!row) {
        return undefined;
    }
    if (row.closed_at !== null) {
        const flap = Date.parse(row.closed_at) + OUTAGE_SILENCE_MS > now.getTime();
        const startedAt = flap ? row.started_at : iso;
        const escalatedAt = flap ? row.escalated_at : null;
        ctx.db.db
            .prepare('UPDATE source_outages SET closed_at = NULL, started_at = ?, last_seen_at = ?, failures = 1, escalated_at = ? WHERE source_id = ?')
            .run(startedAt, iso, escalatedAt, sourceId);
        return toOutage({ source_id: sourceId, started_at: startedAt, last_seen_at: iso, failures: 1, escalated_at: escalatedAt, closed_at: null });
    }
    const escalatedAt = row.escalated_at ?? (Date.parse(row.started_at) + OUTAGE_ESCALATION_MS <= now.getTime() ? iso : null);
    ctx.db.db
        .prepare('UPDATE source_outages SET last_seen_at = ?, failures = failures + 1, escalated_at = ? WHERE source_id = ?')
        .run(iso, escalatedAt, sourceId);
    return toOutage({ ...row, last_seen_at: iso, failures: row.failures + 1, escalated_at: escalatedAt });
}

export function getSourceOutage(ctx: StoreContext, sourceId: string): SourceOutage | undefined {
    const row = ctx.q.get<OutageRow>('SELECT * FROM source_outages WHERE source_id = ? AND closed_at IS NULL', sourceId);
    return row ? toOutage(row) : undefined;
}

/** Every open outage (scheduler maintenance: silence-close, escalation). */
export function listSourceOutages(ctx: StoreContext): SourceOutage[] {
    return ctx.q.all<OutageRow>('SELECT * FROM source_outages WHERE closed_at IS NULL').map(toOutage);
}

/** Close an outage (source healed). The row is kept with a closed_at
 *  stamp: a quick reopen (flap) resumes the wave instead of restarting
 *  the escalation clock from scratch. Returns whether an open outage was
 *  closed. */
export function closeSourceOutage(ctx: StoreContext, sourceId: string): boolean {
    return (
        Number(
            ctx.db.db.prepare('UPDATE source_outages SET closed_at = ? WHERE source_id = ? AND closed_at IS NULL').run(new Date().toISOString(), sourceId)
                .changes
        ) > 0
    );
}

/** Arm the escalation stamp of an open outage whose started_at is old
 *  enough — the arming also happens on noteSourceFailure; this entry
 *  point covers outages whose jobs stopped retrying (silence) before the
 *  escalation delay elapsed. No-op otherwise. */
export function armOutageEscalation(ctx: StoreContext, sourceId: string): SourceOutage | undefined {
    const row = ctx.q.get<OutageRow>('SELECT * FROM source_outages WHERE source_id = ? AND closed_at IS NULL', sourceId);
    if (row && !row.escalated_at && Date.parse(row.started_at) + OUTAGE_ESCALATION_MS <= Date.now()) {
        ctx.db.db.prepare('UPDATE source_outages SET escalated_at = ? WHERE source_id = ?').run(new Date().toISOString(), sourceId);
    }
    return getSourceOutage(ctx, sourceId);
}

/** Entries whose downloads keep failing (candidates for a source failover). */
export function listDownloadFailing(ctx: StoreContext, minimum: number): Array<{ id: number; sourceId: string; title: string; downloadFailures: number }> {
    return ctx.q
        .all<{ id: number; source_id: string; title: string; download_failures: number }>(
            'SELECT id, source_id, title, download_failures FROM library WHERE hidden = 0 AND paused = 0 AND download_failures >= ? ORDER BY download_failures DESC',
            minimum
        )
        .map(row => ({ id: row.id, sourceId: row.source_id, title: row.title, downloadFailures: Number(row.download_failures) }));
}

/** Entries with no new chapter for more than `maxAgeDays` (stale-series
 *  auto-pause). Entries with pending check failures are skipped: an
 *  unreachable source must not be mistaken for an abandoned series. */
export function listStaleEntries(ctx: StoreContext, maxAgeDays: number): Array<{ id: number; title: string; lastChapterAt: string }> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    return ctx.q
        .all<{ id: number; title: string; last_chapter_at: string }>(
            `SELECT id, title, last_chapter_at FROM library
             WHERE hidden = 0 AND paused = 0 AND check_failures = 0 AND last_chapter_at IS NOT NULL AND last_chapter_at < ?`,
            cutoff
        )
        .map(row => ({ id: row.id, title: row.title, lastChapterAt: row.last_chapter_at }));
}

/** Entries whose series looks stalled relative to its own release rhythm
 *  (see the STALE_* constants): probe candidates for the stalled-source
 *  failover regime. Excludes entries with pending check failures — an
 *  unreachable source is the failure regime's job (maybeMigrate), not a
 *  stalled series. Most-stale first. */
export function listStalledCandidates(ctx: StoreContext): StalledCandidate[] {
    const now = new Date();
    const rows = ctx.q.all<{ id: number; source_id: string; title: string; last_chapter_at: string }>(
        `SELECT id, source_id, title, last_chapter_at FROM library
         WHERE hidden = 0 AND paused = 0 AND check_failures = 0 AND last_chapter_at IS NOT NULL
           AND migration_suggestion IS NULL
           AND (staleness_next_probe_at IS NULL OR staleness_next_probe_at <= ?)
         ORDER BY last_chapter_at ASC`,
        now.toISOString()
    );
    const candidates: StalledCandidate[] = [];
    for (const row of rows) {
        if (now.getTime() - Date.parse(row.last_chapter_at) < stalenessThresholdMs(ctx, row.id)) {
            continue;
        }
        const count = ctx.q.get<{ n: number }>('SELECT COUNT(*) AS n FROM library_chapters WHERE entry_id = ?', row.id);
        candidates.push({ id: row.id, sourceId: row.source_id, title: row.title, chapterCount: Number(count?.n ?? 0) });
    }
    return candidates;
}

/** Record the outcome of a stalled-source probe: a hit (suggestion stored)
 *  resets the back-off; a miss (probable hiatus) spaces the next probe out
 *  exponentially — 7d, 14d, 28d… capped at STALE_BACKOFF_MAX_MS. */
export function recordStalenessProbe(ctx: StoreContext, entryId: number, hit: boolean): void {
    if (hit) {
        ctx.db.db.prepare('UPDATE library SET staleness_misses = 0, staleness_next_probe_at = NULL WHERE id = ?').run(entryId);
        return;
    }
    const row = ctx.q.get<{ n: number }>('SELECT staleness_misses AS n FROM library WHERE id = ?', entryId);
    const misses = Number(row?.n ?? 0) + 1;
    const delay = Math.min(STALE_BACKOFF_BASE_MS * 2 ** (misses - 1), STALE_BACKOFF_MAX_MS);
    ctx.db.db
        .prepare('UPDATE library SET staleness_misses = ?, staleness_next_probe_at = ? WHERE id = ?')
        .run(misses, new Date(Date.now() + delay).toISOString(), entryId);
}

/** Idle time after which a series looks stalled, learned from its own
 *  release rhythm (gaps between distinct discovery events); falls back to
 *  a fixed delay when too few events are on record. */
function stalenessThresholdMs(ctx: StoreContext, entryId: number): number {
    const events = ctx.q
        .all<{ discovered_at: string }>(
            'SELECT DISTINCT discovered_at FROM library_chapters WHERE entry_id = ? ORDER BY discovered_at DESC LIMIT ?',
            entryId,
            STALE_CADENCE_EVENTS
        )
        .map(row => Date.parse(row.discovered_at))
        .filter(timestamp => Number.isFinite(timestamp));
    const gaps: number[] = [];
    for (let index = 1; index < events.length; index++) {
        const gap = events[index - 1] - events[index];
        if (gap > 0) {
            gaps.push(gap);
        }
    }
    if (gaps.length < STALE_CADENCE_MIN_GAPS) {
        return STALE_FALLBACK_DAYS * DAY_MS;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const medianGap = sorted[Math.floor(sorted.length / 2)];
    return Math.max(STALE_RHYTHM_FACTOR * medianGap, STALE_FLOOR_DAYS * DAY_MS);
}

export function recordCheckFailure(ctx: StoreContext, entryId: number): number {
    ctx.db.db.prepare('UPDATE library SET check_failures = check_failures + 1 WHERE id = ?').run(entryId);
    const row = ctx.q.get<{ n: number }>('SELECT check_failures AS n FROM library WHERE id = ?', entryId);
    return Number(row?.n || 0);
}

export function resetCheckFailures(ctx: StoreContext, entryId: number): void {
    ctx.db.db.prepare('UPDATE library SET check_failures = 0 WHERE id = ?').run(entryId);
}
