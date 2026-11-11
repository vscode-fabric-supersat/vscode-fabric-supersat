// The limiter that keeps Fabric requests within each quota bucket's budget. Time is faked: `delay` moves the clock.
import * as assert from 'assert';
import {
  BURST,
  DEFINITION_LIMIT,
  DEFINITION_WINDOW_MS,
  MAX_CONCURRENT_REQUESTS,
  OPERATIONS_BURST,
  OPERATIONS_RATE_PER_SECOND,
  RATE_PER_SECOND,
  RECOVERY_RUN,
  RequestLimiter,
  type RequestLimiterOptions,
} from '../../fabric/requestLimiter';

function limiter(options: RequestLimiterOptions = {}) {
  let time = 0;
  const delays: number[] = [];
  const l = new RequestLimiter({
    now: () => time,
    delay: async (ms) => {
      delays.push(ms);
      time += ms;
    },
    ...options,
  });
  return { l, delays, advance: (ms: number) => (time += ms), time: () => time };
}

/** Sends `n` requests in `bucket` one after another (each released at once), returning when each was sent. */
async function sendTimes(l: RequestLimiter, n: number, time: () => number, bucket: 'platform' | 'operations' = 'platform') {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    await l.acquire(bucket);
    times.push(time());
    l.release();
  }
  return times;
}

suite('RequestLimiter', () => {
  test('defaults: 32 at once; Platform 180 then 5/s, operations 300 then 3/s (each 480 in any minute, under Fabric’s 500)', () => {
    assert.deepStrictEqual([MAX_CONCURRENT_REQUESTS, BURST, RATE_PER_SECOND], [32, 180, 5]);
    assert.deepStrictEqual([OPERATIONS_BURST, OPERATIONS_RATE_PER_SECOND], [300, 3]);
    assert.deepStrictEqual([DEFINITION_LIMIT, DEFINITION_WINDOW_MS], [150, 60_000]);
    const l = new RequestLimiter();
    assert.strictEqual(l.maxConcurrent, 32);
    assert.deepStrictEqual(l.budget('platform'), { burst: 180, ratePerSecond: 5 });
    assert.deepStrictEqual(l.budget('operations'), { burst: 300, ratePerSecond: 3 });
    assert.ok(BURST + 60 * RATE_PER_SECOND < 500);
    assert.ok(OPERATIONS_BURST + 60 * OPERATIONS_RATE_PER_SECOND < 500);
  });

  test('definition requests: at most the limit in any sliding minute; other requests aren’t held back', async () => {
    const { l, advance, time } = limiter({ definitionLimit: 3 });
    const send = async (definition: boolean) => {
      await l.acquire('platform', definition);
      l.release();
      return time();
    };
    assert.deepStrictEqual([await send(true), await send(true)], [0, 0]);
    advance(10_000);
    assert.strictEqual(await send(true), 10_000);
    // The limit is reached: a fourth waits until the first two are a minute old; other requests go now.
    assert.strictEqual(await send(false), 10_000);
    assert.deepStrictEqual([await send(true), await send(true)], [60_000, 60_000]);
    // The window slides: the next waits for the one sent at 10s.
    assert.strictEqual(await send(true), 70_000);
  });

  test('never lets more than the cap run; a released slot goes to a waiting request', async () => {
    const { l } = limiter({ maxConcurrent: 2 });
    assert.strictEqual(await l.acquire('platform'), 1);
    assert.strictEqual(await l.acquire('operations'), 2);
    let third = false;
    const waiting = l.acquire('platform').then((n) => {
      third = true;
      return n;
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(third, false);
    l.release();
    assert.strictEqual(await waiting, 2);
    assert.strictEqual(l.running, 2);
  });

  test('a burst goes out at once, then requests go out at the rate', async () => {
    const { l, time } = limiter({ burst: 3, ratePerSecond: 2 });
    assert.deepStrictEqual(await sendTimes(l, 6, time), [0, 0, 0, 500, 1000, 1500]);
  });

  test('no 60 seconds ever has more than burst + 60 × rate requests, at the defaults', async () => {
    const { l, time } = limiter();
    const times = await sendTimes(l, 900, time);
    let most = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while (times[i] - times[j] >= 60_000) {
        j++;
      }
      most = Math.max(most, i - j + 1);
    }
    assert.ok(most <= BURST + 60 * RATE_PER_SECOND, `${most} requests in 60s`);
    assert.strictEqual(times[BURST - 1], 0);
  });

  test('the two buckets have their own budgets', async () => {
    const { l, time } = limiter({ burst: 2, ratePerSecond: 1 });
    assert.deepStrictEqual(await sendTimes(l, 2, time, 'platform'), [0, 0]);
    // Platform's budget is used up; the operations bucket still has its whole burst.
    assert.deepStrictEqual(await sendTimes(l, 2, time, 'operations'), [0, 0]);
  });

  test('a rate 429 pauses only its bucket, and halves its rate and burst once however many are throttled together', async () => {
    const { l, delays, advance, time } = limiter();
    assert.deepStrictEqual(l.throttled('platform', 'rate', 5000), { pausedMs: 5000, ratePerSecond: 2.5, burst: 90 });
    // Others throttled during the same pause extend it, without halving again.
    advance(1000);
    assert.deepStrictEqual(l.throttled('platform', 'rate', 5000), { pausedMs: 0, ratePerSecond: 2.5, burst: 90 });
    // The operations bucket isn't paused.
    await l.acquire('operations');
    l.release();
    assert.deepStrictEqual(delays, []);
    // A platform request waits for the end of the (extended) pause.
    await l.acquire('platform');
    l.release();
    assert.strictEqual(time(), 6000);
    // A 429 after the pause has ended is a new one, and halves again.
    assert.deepStrictEqual(l.throttled('platform', 'rate', 2000), { pausedMs: 2000, ratePerSecond: 1.25, burst: 45 });
    assert.deepStrictEqual(l.budget('operations'), { burst: 300, ratePerSecond: 3 });
  });

  test('a request woken for a free slot but held by its own paused bucket passes the slot on; the pause is still kept', async () => {
    // The clock moves only after a wait's macrotask, so the order requests go out in is visible.
    let time = 0;
    const l = new RequestLimiter({
      maxConcurrent: 2,
      now: () => time,
      delay: async (ms) => {
        await new Promise((r) => setTimeout(r, 0));
        time += ms;
      },
    });
    await l.acquire('platform');
    await l.acquire('platform');
    // More platform requests wait for a slot than there are slots, then an operations request.
    const sent: string[] = [];
    const platform = [1, 2, 3].map(() =>
      l.acquire('platform').then(() => {
        sent.push(`platform@${time}`);
        l.release();
      }),
    );
    const operations = l.acquire('operations').then(() => {
      sent.push(`operations@${time}`);
      l.release();
    });
    l.throttled('platform', 'rate', 30_000);
    l.release();
    l.release();
    await Promise.all([...platform, operations]);
    // The operations bucket isn't paused, so its request goes out at once with a free slot;
    // every platform request waits out the whole pause.
    assert.strictEqual(sent[0], 'operations@0');
    assert.ok(sent.slice(1).every((s) => s.startsWith('platform@') && Number(s.split('@')[1]) >= 30_000), sent.join(', '));
  });

  test('throttling never changes the cap on requests at once', () => {
    const { l } = limiter();
    l.throttled('platform', 'rate', 1000);
    l.throttled('operations', 'capacity', 1000);
    assert.strictEqual(l.maxConcurrent, 32);
  });

  test('the budget never goes below a sixteenth, nor the burst below 1', () => {
    const { l, advance } = limiter({ burst: 4, ratePerSecond: 8 });
    for (let i = 0; i < 10; i++) {
      l.throttled('platform', 'rate', 10);
      advance(10);
    }
    assert.deepStrictEqual(l.budget('platform'), { burst: 1, ratePerSecond: 0.5 });
  });

  test('a lowered budget goes up a tenth after each 20 requests in a row aren’t throttled, back up to the full budget', () => {
    const { l, advance } = limiter();
    l.throttled('platform', 'rate', 0); // 2.5/s, 90
    advance(1);
    assert.strictEqual(RECOVERY_RUN, 20);
    for (let i = 0; i < 19; i++) {
      l.succeeded('platform');
    }
    assert.deepStrictEqual(l.budget('platform'), { burst: 90, ratePerSecond: 2.5 });
    l.succeeded('platform');
    assert.deepStrictEqual(l.budget('platform'), { burst: 108, ratePerSecond: 3 });
    for (let i = 0; i < 1000; i++) {
      l.succeeded('platform');
    }
    assert.deepStrictEqual(l.budget('platform'), { burst: 180, ratePerSecond: 5 });
  });

  test('a rate 429 resets the run of successes', () => {
    const { l, advance } = limiter();
    l.throttled('platform', 'rate', 0);
    advance(1);
    for (let i = 0; i < 19; i++) {
      l.succeeded('platform');
    }
    l.throttled('platform', 'rate', 0); // halved again; the 19 no longer count
    advance(1);
    l.succeeded('platform');
    assert.strictEqual(l.budget('platform').ratePerSecond, 1.25);
  });

  test('CapacityLimitExceeded: exponential backoff (5s, 10s, 20s... up to 60s), the budget kept', () => {
    const { l, advance } = limiter();
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const t = l.throttled('platform', 'capacity', undefined);
      pauses.push(t.pausedMs);
      assert.deepStrictEqual([t.ratePerSecond, t.burst], [5, 180]);
      advance(t.pausedMs);
    }
    assert.deepStrictEqual(pauses, [5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  test('CapacityLimitExceeded honours a longer Retry-After, and a request that isn’t throttled restarts the backoff', () => {
    const { l, advance } = limiter();
    assert.strictEqual(l.throttled('platform', 'capacity', 30_000).pausedMs, 30_000);
    advance(30_000);
    assert.strictEqual(l.throttled('platform', 'capacity', undefined).pausedMs, 10_000);
    advance(10_000);
    l.succeeded('platform');
    assert.strictEqual(l.throttled('platform', 'capacity', undefined).pausedMs, 5000);
  });
});
