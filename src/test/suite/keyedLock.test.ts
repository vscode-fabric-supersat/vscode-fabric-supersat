// Tasks with the same key run one at a time; waiting shareable tasks are shared.
import * as assert from 'assert';
import { KeyedLock } from '../../util/keyedLock';

/** A task that records when it starts and ends, and finishes when `finish` is called. */
function gated(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const task = async (waited: boolean) => {
    log.push(`${name} start${waited ? ' (waited)' : ''}`);
    await done;
    log.push(`${name} end`);
    return name;
  };
  return { task, finish };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

suite('KeyedLock', () => {
  test('tasks with the same key run one at a time, in order; other keys run at once', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const a = gated(log, 'a');
    const b = gated(log, 'b');
    const c = gated(log, 'c');
    const pa = lock.run('x', a.task);
    const pb = lock.run('x', b.task);
    const pc = lock.run('y', c.task);
    await tick();
    assert.deepStrictEqual(log, ['a start', 'c start']);
    assert.ok(lock.busy('x'));
    a.finish();
    await tick();
    assert.deepStrictEqual(log, ['a start', 'c start', 'a end', 'b start (waited)']);
    b.finish();
    c.finish();
    assert.deepStrictEqual(await Promise.all([pa, pb, pc]), ['a', 'b', 'c']);
    await tick();
    assert.ok(!lock.busy('x') && !lock.busy('y'));
  });

  test('a failed task doesn’t stop the next one', async () => {
    const lock = new KeyedLock();
    const first = lock.run('x', async () => {
      throw new Error('boom');
    });
    const second = lock.run('x', async (waited) => waited);
    await assert.rejects(first, /boom/);
    assert.strictEqual(await second, true);
  });

  test('shareable tasks asked for while one is waiting share it, and its result', async () => {
    const lock = new KeyedLock();
    const log: string[] = [];
    const a = gated(log, 'a');
    const b = gated(log, 'b');
    const c = gated(log, 'c');
    const pa = lock.run('x', a.task, { share: true });
    const pb = lock.run('x', b.task, { share: true });
    const pc = lock.run('x', c.task, { share: true });
    a.finish();
    b.finish();
    assert.deepStrictEqual(await Promise.all([pa, pb, pc]), ['a', 'b', 'b']);
    assert.deepStrictEqual(log, ['a start', 'a end', 'b start (waited)', 'b end']);
    // Once b has started, a new request queues again.
    const pd = lock.run('x', async () => 'd', { share: true });
    assert.strictEqual(await pd, 'd');
  });

  test('a shareable task isn’t shared with a waiting task that isn’t shareable', async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const run = (name: string, share: boolean) =>
      lock.run(
        'x',
        async () => {
          order.push(name);
          return name;
        },
        { share },
      );
    const results = await Promise.all([run('a', false), run('b', false), run('c', true), run('d', true)]);
    assert.deepStrictEqual(results, ['a', 'b', 'c', 'c']);
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
  });
});
