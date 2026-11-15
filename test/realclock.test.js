// -----------------------------------------------------------------------------
// Real clock, sped up 100 times: the ping period is measured (30 s), and the
// reconnection never comes faster than the backoff. The app is stopped in
// t.after, so a failure never leaves timers running.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIMINGS } from '../src/constants.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { createSetup, fakeAnova } from './helpers/fakeAnova.js';

test('real clock: one ping every 30 s, measured', async (t) => {
  const clock = realClock({ speed: 100 });
  const server = fakeAnova();
  const s = createSetup({ clock, server });
  t.after(async () => {
    await s.app.stop();
    clock.close();
  });
  await s.start();
  const waitOpen = Date.now() + 5000;
  while (server.open.length === 0 && Date.now() < waitOpen) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(server.open.length, 1);
  const spy = spyOn(s.app.channel, 'ping', clock);
  await measurePeriod(spy, { count: 4, period: TIMINGS.pingInterval });
  spy.restore();
});

test('real clock: failed attempts spaced by the backoff, never faster', async (t) => {
  const clock = realClock({ speed: 100 });
  const server = fakeAnova();
  server.down = true;
  const s = createSetup({ clock, server, random: () => 0.5 });
  t.after(async () => {
    await s.app.stop();
    clock.close();
  });
  const spy = spyOn(s.app, 'link', clock);
  await s.start();
  // random 0.5: 0.75 of each step (jitter half to whole): 3.75 s, 11.25 s, 22.5 s (simulated).
  const gaps = [];
  const deadline = Date.now() + 5000;
  while (spy.calls.length < 4 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (let i = 1; i < spy.calls.length; i += 1) {
    gaps.push(spy.calls[i].at - spy.calls[i - 1].at);
  }
  assert.equal(spy.calls.length, 4);
  gaps.forEach((gap, i) => {
    const step = TIMINGS.backoff[i] * 0.75;
    assert.ok(gap >= step * 0.95 && gap <= step * 1.5, `gap ${i}: ${gap} ms for ${step}`);
  });
});
