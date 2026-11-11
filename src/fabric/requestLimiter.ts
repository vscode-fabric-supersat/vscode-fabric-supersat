/**
 * When Fabric requests may be sent, so they stay within Fabric's quotas. No `vscode`
 * dependency.
 *
 * Fabric's Unified Quota for REST APIs (https://learn.microsoft.com/rest/api/fabric/articles/throttling)
 * gives each identity (user or service principal) independent buckets: Platform APIs 500
 * calls/min and Long-Running Operations APIs 500 calls/min (Job Scheduler APIs, 200/min, aren't
 * used). Each is a fixed 60-second window refilled all at once: a burst that uses it up blocks
 * every request (HTTP 429, `RequestBlocked`) until the window ends, up to about a minute.
 * Endpoints can have their own, lower limits (List Workspace Role Assignments: 200/min), and
 * the notebook definition endpoints publish none, so throttling is still handled when it comes.
 *
 * So each bucket (`RequestBucket`) has a budget, a token bucket: Platform up to `BURST` (180)
 * requests at once, then `RATE_PER_SECOND` (5) a second; operations `OPERATIONS_BURST` (300)
 * at once, then `OPERATIONS_RATE_PER_SECOND` (3) a second. Either way, in any 60 seconds a
 * bucket sends at most 480 requests, under the 500 quota, with a little left for other VS Code
 * windows and tools using the same account. Jobs up to the burst run at full speed; bigger
 * ones settle at a steady rate instead of bursting then stalling for a minute. Operations get
 * the bigger burst because a bulk command's status checks and results come all together
 * (about 2.4 per notebook: 102 notebooks took 244, seen 2026-11).
 *
 * **Definition requests (`getDefinition`) also have a sliding limit**: at most
 * `DEFINITION_LIMIT` (150) in any 60 seconds. Fabric publishes no limit for them, but throttled
 * them after about 170-200 in a sliding minute (seen 2026-11, its `Retry-After` ending 60s
 * after the earliest ones), well before the Platform quota. Waiting here instead of getting the
 * 429 avoids the pause and the halved budget.
 *
 * - **At most `MAX_CONCURRENT_REQUESTS` (32) run at once**, across both buckets: a safety cap
 *   (connections, memory, limits Fabric doesn't publish), fixed. The budget, not the cap,
 *   keeps requests within quota.
 * - **A 429 for the rate (`RequestBlocked`, or any other code)** pauses that bucket's
 *   requests until its `Retry-After` has passed, and halves its rate and burst, once per
 *   pause however many requests are throttled together. Each `RECOVERY_RUN` requests in a row
 *   that aren't throttled raise them by a tenth of the full budget, back up to it.
 * - **A 429 for the capacity (`CapacityLimitExceeded`)**: the Fabric capacity is overloaded,
 *   which sending fewer requests doesn't fix. It pauses the bucket with exponential backoff
 *   (5s, 10s, 20s... up to 60s, or Fabric's `Retry-After` if longer), and doesn't lower the
 *   budget. A request that isn't throttled starts the backoff again from 5s.
 *
 * Every request the client sends goes through here, from any command, including polls of
 * long-running operations (the operations bucket). Waiting between polls doesn't hold a slot
 * or use the budget; only the requests themselves do.
 */

/** Fabric's quota buckets: Platform APIs, and Long-Running Operations APIs (`/operations/...`). */
export type RequestBucket = 'platform' | 'operations';
export const REQUEST_BUCKETS: readonly RequestBucket[] = ['platform', 'operations'];

/** The most requests running at once, across both buckets. */
export const MAX_CONCURRENT_REQUESTS = 32;
/**
 * The most notebooks a bulk command works on at once. Higher than `MAX_CONCURRENT_REQUESTS`
 * because a notebook spends most of its time waiting for its long-running operation, which
 * holds no request slot; the limiter still decides how many requests actually run.
 */
export const BULK_CONCURRENCY = 128;
/** Requests the Platform bucket may send at once before its rate applies. */
export const BURST = 180;
/** Requests the Platform bucket may send each second, after a burst. */
export const RATE_PER_SECOND = 5;
/** The operations bucket's burst and rate: 300 + 60 × 3 = 480 in any minute, like Platform's. */
export const OPERATIONS_BURST = 300;
export const OPERATIONS_RATE_PER_SECOND = 3;
/** Definition requests allowed in any `DEFINITION_WINDOW_MS`. */
export const DEFINITION_LIMIT = 150;
export const DEFINITION_WINDOW_MS = 60_000;
/** Requests in a row not throttled, after which a lowered budget goes up a step. */
export const RECOVERY_RUN = 20;
/** A step up of a lowered budget, as a share of the full one. */
const RECOVERY_STEP = 0.1;
/** The lowest share of the full budget that throttling halves it to. */
const MIN_SHARE = 1 / 16;
/** Exponential backoff for `CapacityLimitExceeded`: the first wait and the longest. */
const CAPACITY_BACKOFF_MS = 5000;
const MAX_CAPACITY_BACKOFF_MS = 60_000;

export type ThrottleReason = 'rate' | 'capacity';

export interface RequestLimiterOptions {
  /** The most requests running at once; defaults to `MAX_CONCURRENT_REQUESTS`. */
  maxConcurrent?: number;
  /** Each bucket's burst; defaults to `BURST` (Platform) and `OPERATIONS_BURST`. */
  burst?: number;
  /** Each bucket's rate per second; defaults to `RATE_PER_SECOND` (Platform) and `OPERATIONS_RATE_PER_SECOND`. */
  ratePerSecond?: number;
  /** Definition requests allowed in any minute; defaults to `DEFINITION_LIMIT`. */
  definitionLimit?: number;
  /** Waits for the given number of milliseconds; replaceable in tests. */
  delay?: (ms: number) => Promise<void>;
  /** The current time in ms; replaceable in tests. */
  now?: () => number;
}

/** What one 429 did: the pause it started (0 if it only extended one under way) and the bucket's budget after it. */
export interface Throttled {
  pausedMs: number;
  ratePerSecond: number;
  burst: number;
}

/** One bucket's budget and pause. */
class Budget {
  /** Share of the full budget in effect (1 unless throttling lowered it). */
  share = 1;
  tokens: number;
  updated: number;
  pausedUntil = 0;
  /** Requests in a row not throttled, since the budget last changed. */
  successes = 0;
  /** `CapacityLimitExceeded` pauses in a row, for the backoff. */
  capacityPauses = 0;

  constructor(
    private readonly fullBurst: number,
    private readonly fullRate: number,
    now: number,
  ) {
    this.tokens = fullBurst;
    this.updated = now;
  }

  get burst(): number {
    // The epsilon keeps float error (180 × 0.6 = 107.99...) from losing a request.
    return Math.max(1, Math.floor(this.fullBurst * this.share + 1e-9));
  }

  get rate(): number {
    // Rounded so steps of a tenth don't show float error (4.999999...).
    return Math.round(this.fullRate * this.share * 1e6) / 1e6;
  }

  refill(now: number): void {
    if (now > this.updated) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.updated) / 1000) * this.rate);
    }
    this.updated = Math.max(this.updated, now);
  }

  /** Ms until a token is available (0 if one is). */
  waitForToken(): number {
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }
}

export class RequestLimiter {
  readonly maxConcurrent: number;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly budgets: Record<RequestBucket, Budget>;
  private readonly definitionLimit: number;
  /** When each definition request in the last `DEFINITION_WINDOW_MS` was sent, oldest first. */
  private readonly definitionTimes: number[] = [];
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: RequestLimiterOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? MAX_CONCURRENT_REQUESTS));
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    const burst = (fallback: number) => Math.max(1, Math.floor(options.burst ?? fallback));
    const start = this.now();
    this.budgets = {
      platform: new Budget(burst(BURST), options.ratePerSecond ?? RATE_PER_SECOND, start),
      operations: new Budget(burst(OPERATIONS_BURST), options.ratePerSecond ?? OPERATIONS_RATE_PER_SECOND, start),
    };
    this.definitionLimit = Math.max(1, Math.floor(options.definitionLimit ?? DEFINITION_LIMIT));
  }

  /** How many requests are running now. */
  get running(): number {
    return this.active;
  }

  /** A bucket's budget in effect now. */
  budget(bucket: RequestBucket): { burst: number; ratePerSecond: number } {
    const b = this.budgets[bucket];
    return { burst: b.burst, ratePerSecond: b.rate };
  }

  /**
   * Waits until a request in `bucket` may be sent: its bucket isn't paused, has budget, and
   * fewer than `maxConcurrent` requests are running; for a `definition` request, also fewer
   * than the definition limit in the last minute. Returns the number of requests running,
   * this one included. Call `release` when it has finished.
   */
  async acquire(bucket: RequestBucket, definition = false): Promise<number> {
    const b = this.budgets[bucket];
    for (;;) {
      const now = this.now();
      b.refill(now);
      if (now < b.pausedUntil) {
        await this.waitOutside(b.pausedUntil - now);
        continue;
      }
      const wait = b.waitForToken();
      if (wait > 0) {
        await this.waitOutside(wait);
        continue;
      }
      if (definition) {
        const times = this.definitionTimes;
        while (times.length && times[0] <= now - DEFINITION_WINDOW_MS) {
          times.shift();
        }
        if (times.length >= this.definitionLimit) {
          await this.waitOutside(times[0] + DEFINITION_WINDOW_MS - now);
          continue;
        }
      }
      if (this.active >= this.maxConcurrent) {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
        continue;
      }
      // Budget and slot are taken together (no await in between), so the budget counts sends, not waits.
      b.tokens -= 1;
      if (definition) {
        this.definitionTimes.push(now);
      }
      return ++this.active;
    }
  }

  /** Frees the slot taken by `acquire`. */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }

  /**
   * Waits for a request's own bucket (its pause, budget or definition limit) without holding
   * a slot. A request woken by `release` may land here instead of taking the free slot, so the
   * next request waiting for a slot is woken first: otherwise a request in the other bucket,
   * or one with budget, would sit behind a free slot until this one's wait was over. Whoever
   * is woken checks its own bucket again, so no pause or budget is skipped.
   */
  private waitOutside(ms: number): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.waiting.shift()?.();
    }
    return this.delay(ms);
  }

  /** A request in `bucket` wasn't throttled: after `RECOVERY_RUN` in a row, a lowered budget goes up a step. */
  succeeded(bucket: RequestBucket): void {
    const b = this.budgets[bucket];
    b.capacityPauses = 0;
    if (b.share >= 1) {
      return;
    }
    if (++b.successes >= RECOVERY_RUN) {
      b.refill(this.now());
      // Rounded, so steps up from a half really reach 1 (0.9999999... otherwise).
      b.share = Math.min(1, Math.round((b.share + RECOVERY_STEP) * 1e6) / 1e6);
      b.successes = 0;
    }
  }

  /**
   * A request in `bucket` was throttled. `retryAfterMs` is Fabric's `Retry-After`, if it sent
   * one. For the rate, pauses the bucket for it and halves its budget; for the capacity,
   * pauses it with exponential backoff and keeps its budget. Requests throttled during a pause
   * under way extend it, without lowering the budget or the backoff again.
   */
  throttled(bucket: RequestBucket, reason: ThrottleReason, retryAfterMs: number | undefined): Throttled {
    const b = this.budgets[bucket];
    const now = this.now();
    b.refill(now);
    const pausing = now >= b.pausedUntil;
    let pauseMs: number;
    if (reason === 'capacity') {
      const backoff = Math.min(MAX_CAPACITY_BACKOFF_MS, CAPACITY_BACKOFF_MS * 2 ** (pausing ? b.capacityPauses : Math.max(0, b.capacityPauses - 1)));
      pauseMs = Math.max(backoff, retryAfterMs ?? 0);
      if (pausing) {
        b.capacityPauses++;
      }
    } else {
      pauseMs = Math.max(0, retryAfterMs ?? CAPACITY_BACKOFF_MS);
      b.successes = 0;
      if (pausing) {
        b.share = Math.max(MIN_SHARE, b.share / 2);
        // The window Fabric counts is used up: start again from nothing, refilling at the new rate.
        b.tokens = 0;
      }
    }
    const until = now + pauseMs;
    b.pausedUntil = Math.max(b.pausedUntil, until);
    return { pausedMs: pausing ? until - now : 0, ratePerSecond: b.rate, burst: b.burst };
  }
}
