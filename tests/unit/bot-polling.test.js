import test from 'node:test';
import assert from 'node:assert/strict';
import { setBot } from '../../src/modules/bot/runtime.js';
import { startBot, stopBot } from '../../src/modules/bot/bot.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('startup rejects failed initialization instead of announcing readiness', async () => {
  setBot({ start: async () => { throw new Error('invalid Telegram credentials'); } });
  await assert.rejects(startBot(), /invalid Telegram/);
  await stopBot();
});
test('readiness precedes polling lifetime; asynchronous failure invokes cleanup once', async () => {
  let fail, ready; let failures = 0;
  setBot({ start: ({ onStart }) => { ready = onStart; return new Promise((resolve, reject) => { fail = reject; }); } });
  let started = false;
  const start = startBot({ onFatal: async () => { failures++; await stopBot(); } }).then(() => { started = true; });
  await tick(); assert.equal(started, false);
  ready(); await start; assert.equal(started, true);
  fail(new Error('polling disconnected')); await tick(); await tick();
  assert.equal(failures, 1);
  await stopBot();
});
test('stop is awaitable and preserves asynchronous stop failure', async () => {
  let finish;
  setBot({
    start: async ({ onStart }) => { onStart(); await new Promise(resolve => { finish = resolve; }); },
    stop: async () => { await tick(); finish(); throw new Error('stop failed'); },
  });
  await startBot();
  await assert.rejects(stopBot(), /stop failed/);
  await tick(); await stopBot();
});
