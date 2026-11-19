// -----------------------------------------------------------------------------
// The points of the r1 review (dead connection, bytes with the 101, kept stop
// and another cook, false refusals, slow /data, second start) and the guards
// whose mutants survived.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOCKET_OPTIONS } from '../src/channel.js';
import { refusedMark } from '../src/config.js';
import { TIMINGS, connectionUrl } from '../src/constants.js';
import { parseState } from '../src/protocol.js';
import { StatePublisher } from '../src/publisher.js';
import { testClock } from './kit/clock.mjs';
import {
  COOKER,
  OVEN,
  TOKEN,
  createSetup,
  fakeAnova,
  jobState,
  memoryStore,
  ovenState,
  settle,
} from './helpers/fakeAnova.js';

const MIN = 60_000;

async function connectedSetup(options = {}) {
  const s = createSetup(options);
  await s.start();
  await s.advance(1);
  return s;
}

const startFields = (s, o = {}) => ({
  device: s.ext(`cooker:${COOKER}`),
  temperature: o.temperature ?? 60,
  minutes: o.minutes ?? 30,
});

const cooking = (jobId = 'job-1') => jobState(COOKER, { cooking: true, jobId });

/** Runs a command while the virtual clock moves (its budget is on that clock). */
async function during(s, promise, ms = 5000, step = 100) {
  let done = false;
  let value;
  promise.then((v) => {
    done = true;
    value = v;
  });
  for (let t = 0; t < ms && !done; t += step) {
    await s.advance(step);
  }
  await settle();
  assert.ok(done, 'the command answered');
  return value;
}

test('I1: a stop on a dead (half-open) connection reconnects and leaves on the new one', async () => {
  const s = await connectedSetup();
  s.server.states[COOKER] = cooking();
  s.server.push(s.server.states[COOKER]);
  await settle();
  s.server.main.frozen = true;
  const result = await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  assert.ok(['accepted', 'confirmed'].includes(result), result);
  assert.equal(s.server.sockets.length, 2, 'a new connection');
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1, 'received once, on the live one');
  assert.equal(s.server.sockets[1].sent[0].command, 'CMD_APC_STOP');
  await settle();
  assert.equal(s.app.stops.size, 0);
  await s.stopAll();
});

test('I1: dead connections found by a stop are bounded, then the backoff', async () => {
  const s = await connectedSetup();
  s.server.states[COOKER] = cooking();
  s.server.push(cooking());
  await settle();
  for (const socket of s.server.sockets) socket.frozen = true;
  const original = s.server.factory;
  s.server.factory = (url, options) => {
    const socket = original(url, options);
    socket.frozen = true;
    return socket;
  };
  // Swap the factory used by the app.
  s.app.socketFactory = s.server.factory;
  const result = await during(
    s,
    s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }),
    8000,
  );
  assert.equal(result, 'queued');
  assert.ok(s.server.sockets.length <= 1 + TIMINGS.stopProbes, `${s.server.sockets.length}`);
  assert.equal(s.app.stops.get(COOKER).sends, 0, 'a send without a sign of life never counts');
  await s.stopAll();
});

test('I2: lists and states sent with the 101 are used', async () => {
  const server = fakeAnova();
  server.syncLists = true;
  const s = await connectedSetup({ server });
  assert.equal(s.app.listed, true);
  assert.ok(s.app.states.has(COOKER));
  await s.advance(TIMINGS.listTimeout + 1);
  assert.equal(server.sockets.length, 1, 'never cut for a missing list');
  await s.stopAll();
});

/** A stop kept in /data for a cook, then the connection comes back with `state`. */
async function keptStop(state, { cookKey = 'job-OLD' } = {}) {
  const server = fakeAnova();
  if (state) server.states[COOKER] = state;
  else delete server.states[COOKER];
  server.noStateAfterCommand = true;
  const clock = testClock();
  const store = memoryStore({
    stops: [
      { cookerId: COOKER, family: 'APC', type: 'a4', at: clock.now() - 30_000, sends: 0, cookKey },
    ],
  });
  const s = createSetup({ server, store, clock });
  await s.start();
  await s.advance(1);
  return s;
}

test('I3: a kept stop never cuts another cook started meanwhile', async () => {
  const s = await keptStop(cooking('job-NEW'));
  await s.advance(TIMINGS.stopFirstState + 1);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 0);
  assert.equal(s.app.stops.size, 0);
  assert.deepEqual(s.store.data.stops, []);
  await s.stopAll();
});

test('I3: a kept stop of the same cook, or without any state in 2 s, leaves; idle = done', async () => {
  const same = await keptStop(cooking('job-OLD'));
  await same.advance(500);
  assert.equal(same.server.commands('CMD_APC_STOP').length, 1);
  await same.stopAll();

  const silent = await keptStop(undefined);
  assert.equal(silent.server.commands('CMD_APC_STOP').length, 0, 'waits for the first state');
  await silent.advance(TIMINGS.stopFirstState + 1);
  assert.equal(silent.server.commands('CMD_APC_STOP').length, 1, 'in doubt, the stop leaves');
  await silent.stopAll();

  const idle = await keptStop(jobState(COOKER));
  await idle.advance(TIMINGS.stopFirstState + 1);
  assert.equal(idle.server.commands('CMD_APC_STOP').length, 0);
  assert.equal(idle.app.stops.size, 0);
  await idle.stopAll();

  const unknown = await keptStop(cooking('job-X'), { cookKey: null });
  assert.equal(unknown.server.commands('CMD_APC_STOP').length, 1, 'no identity: sent at once');
  await unknown.stopAll();
});

test('I3: the identity of the cook is kept in /data, the oven one read', async () => {
  const s = await connectedSetup({
    server: fakeAnova({ cookers: [{ cookerId: COOKER, type: 'a4' }] }),
  });
  s.server.down = true;
  s.server.push(cooking('job-77'));
  await settle();
  s.server.main.drop();
  await s.advance(1);
  await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  assert.equal(s.store.data.stops[0].cookKey, 'job-77');
  await s.stopAll();
  const oven = ovenState(OVEN, { mode: 'cook' });
  oven.payload.state.cook = { cookId: 'oven-cook-1' };
  const parsed = parseState(JSON.parse(JSON.stringify(oven)));
  assert.equal(parsed.values.cookKey, 'oven-cook-1');
});

test('I4: network drops and 1012/1013 closes are never a refusal; a late 1005 neither', async () => {
  for (const code of [1006, 1012, 1013]) {
    const server = fakeAnova();
    server.closeSilently = true;
    server.closeCode = code;
    const s = await connectedSetup({ server });
    await s.advance(TIMINGS.backoff[0]);
    await s.advance(TIMINGS.backoff[1]);
    assert.ok(server.sockets.length >= 3, `${code}: tried again`);
    assert.equal(s.app.blocked, false, `${code}`);
    assert.equal(s.store.data.block, null);
    await s.stopAll();
  }
  // A 1005 more than 5 s after the open, without a message: not a refusal.
  const server = fakeAnova();
  server.silentLists = true;
  const s = await connectedSetup({ server });
  for (let i = 0; i < 2; i += 1) {
    for (let t = 0; t < 40 * MIN && server.open.length === 0; t += 1000) {
      await s.advance(1000);
    }
    assert.equal(server.open.length, 1);
    await s.advance(TIMINGS.silentCloseWindow + 1000);
    server.main.drop(1005);
    await s.advance(1);
  }
  assert.equal(server.sockets.length, 2);
  assert.equal(s.app.blocked, false);
  assert.equal(s.store.data.block, null);
  await s.stopAll();
});

test('I4: our own cut is not a silent close; a live close resets the count', async () => {
  const server = fakeAnova();
  server.silentLists = true;
  const s = await connectedSetup({ server });
  await s.advance(TIMINGS.listTimeout + 1); // our list timeout kills it
  await s.advance(TIMINGS.backoff[0]);
  server.main.drop(1005); // one silent close from Anova
  await s.advance(TIMINGS.backoff[1]);
  assert.equal(s.app.blocked, false, 'one silent close only');
  await s.stopAll();

  const b = fakeAnova();
  b.closeSilently = true;
  const r = await connectedSetup({ server: b, random: () => 1 });
  b.closeSilently = false;
  await r.advance(TIMINGS.backoff[0]);
  assert.equal(r.app.listed, true);
  r.server.main.drop(1006); // a live close after messages
  b.closeSilently = true;
  await r.advance(1);
  await r.advance(TIMINGS.backoff[1] + 10);
  assert.equal(b.sockets.length, 3, 'the third connection closed silently');
  assert.equal(r.app.blocked, false, 'the earlier silent close was forgotten');
  await r.stopAll();
});

test('I4: a kept stop has its attempt under a refusal mark; another token mark does not block', async () => {
  const clock = testClock();
  const store = memoryStore({
    block: { mark: refusedMark(TOKEN) },
    stops: [{ cookerId: COOKER, family: 'APC', type: 'a4', at: clock.now() - 1000, sends: 0 }],
  });
  const s = createSetup({ store, clock });
  s.server.states[COOKER] = cooking();
  await s.start();
  await s.advance(1);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1);
  await s.stopAll();

  const other = memoryStore({
    block: {
      mark: refusedMark('anova-other') === refusedMark(TOKEN) ? 'zz' : refusedMark('anova-other'),
    },
  });
  const t = await connectedSetup({ store: other });
  assert.equal(t.server.sockets.length, 1, 'a mark of another token never blocks');
  await t.stopAll();
});

test('I5: a slow /data never holds a stop; a start past its deadline sends nothing', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true } });
  s.server.push(cooking());
  await settle();
  s.server.main.drop();
  await s.advance(1);
  const keep = s.store.save;
  s.store.save = () => new Promise(() => {}); // never returns
  const result = await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  assert.ok(['accepted', 'confirmed'].includes(result), result);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1);
  s.store.save = keep;
  await s.stopAll();

  const b = await connectedSetup({ config: { token: TOKEN, allow_start: true } });
  let release;
  const save = b.store.save.bind(b.store);
  b.store.save = (data) =>
    data.start ? new Promise((r) => (release = () => r(save(data)))) : save(data);
  const pending = b.gladys.fake.sceneAction('start_cook', startFields(b));
  await settle();
  await b.advance(TIMINGS.startSendBy + 1);
  const ack = await pending;
  assert.equal(ack.success, false);
  release();
  await settle();
  assert.equal(b.server.commands('CMD_APC_START').length, 0, 'never sent after the deadline');
  b.store.save = save;
  await b.stopAll();
});

test('I6: no second start on the idle state from before the first', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true } });
  s.server.silentCommands.add('CMD_APC_START');
  const first = s.gladys.fake.sceneAction('start_cook', startFields(s));
  await settle();
  await s.advance(TIMINGS.startResponse + TIMINGS.startConfirm);
  assert.equal((await first).data.outputs.result, 'sent');
  const second = await s.gladys.fake.sceneAction('start_cook', startFields(s, { temperature: 70 }));
  assert.equal(second.success, false);
  assert.equal(s.server.commands('CMD_APC_START').length, 1);
  // A state after it (idle: the start did not take) opens the way again.
  s.server.silentCommands.delete('CMD_APC_START');
  s.server.push(jobState(COOKER));
  await settle();
  const third = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.equal(third.success, true, third.error);
  await s.stopAll();
});

test('the start: rechecked just before the send, one at a time, busy state refused', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  const save = s.store.save.bind(s.store);
  s.store.save = async (data) => {
    if (data.start) {
      s.server.push(cooking('job-app'));
      await settle();
    }
    return save(data);
  };
  let ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /already cooking/);
  s.store.save = save;
  s.server.push(jobState(COOKER));
  await settle();
  const [a, b] = await Promise.all([
    s.gladys.fake.sceneAction('start_cook', startFields(s)),
    s.gladys.fake.sceneAction('start_cook', startFields(s)),
  ]);
  assert.equal([a, b].filter((x) => x.success).length, 1);
  assert.equal(s.server.commands('CMD_APC_START').length, 1);
  s.server.push(jobState(COOKER, { mode: 'OTA' }));
  await settle();
  ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.equal(ack.success, false);
  await s.stopAll();
});

test('a stop is confirmed only by a known idle state after it; rechecks use later states', async () => {
  const s = await connectedSetup();
  s.server.noStateAfterCommand = true;
  s.server.push(cooking('job-1'));
  await settle();
  await s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  s.server.push(jobState(COOKER, { mode: 'SOMETHING' })); // unknown
  await settle();
  assert.equal(s.app.stops.size, 1, 'an unknown state does not confirm');
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 2, 'unknown after the send: sent again');
  await s.stopAll();

  // No state after the send, the last one (before it) showed idle: sent again anyway.
  const b = await connectedSetup();
  b.server.noStateAfterCommand = true;
  b.app.states.get(COOKER).values.cooking = false;
  await b.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  await b.advance(TIMINGS.stopRecheck);
  assert.equal(b.server.commands('CMD_APC_STOP').length, 2);
  await b.stopAll();
});

test('a stop without cook identity is not sent again past 2 min', async () => {
  const s = await connectedSetup();
  s.server.noStateAfterCommand = true;
  const noId = jobState(COOKER, { cooking: true });
  delete noId.payload.state.job.id;
  s.server.push(noId);
  await settle();
  await s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  s.app.stops.get(COOKER).firstAt -= TIMINGS.stopWindow;
  s.server.push(noId);
  await settle();
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1);
  assert.equal(s.app.stops.size, 0);
  await s.stopAll();
});

test('a stop after a failed forced attempt still goes through the 429 pause', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 429, headers: { 'retry-after': '3600' } });
  server.refusals.push({ status: 503 });
  const s = await connectedSetup({ server });
  const result = await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  assert.equal(result, 'queued');
  await s.advance(TIMINGS.backoff[1] + 1);
  assert.equal(server.commands('CMD_APC_STOP').length, 1, 'not held until the end of the pause');
  await s.stopAll();
});

test('the stop answers Gladys within its budget even when the connection hangs', async () => {
  const s = await connectedSetup();
  s.server.main.drop();
  await s.advance(1);
  // A handshake that never ends (until terminated).
  s.app.socketFactory = () => {
    const socket = new EventEmitter();
    socket.readyState = 0;
    socket.terminate = () => {
      socket.readyState = 3;
      setImmediate(() => socket.emit('close', 1006));
    };
    return socket;
  };
  const t0 = s.clock.elapsed;
  const result = await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  assert.equal(result, 'queued');
  assert.ok(s.clock.elapsed - t0 <= TIMINGS.stopBudget + 200);
  await s.stopAll();
});

test('Retry-After 0 still pauses a minute; no silence refresh during a start; one connection', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 429, headers: { 'retry-after': '0' } });
  const s = await connectedSetup({ server });
  await s.advance(TIMINGS.tooManyMin - 1000);
  assert.equal(server.sockets.length, 1);
  await s.advance(2000);
  assert.equal(server.sockets.length, 2);
  await s.app.connect({ force: true });
  await settle();
  assert.equal(server.sockets.length, 2, 'never a second connection');
  s.app.starting.add(COOKER);
  await s.advance(TIMINGS.stableAfter + TIMINGS.silenceRefresh + TIMINGS.pingInterval);
  assert.equal(server.sockets.length, 2, 'no refresh while a start runs');
  s.app.starting.delete(COOKER);
  await s.stopAll();
});

test('the connection options: bounded handshake, no redirect, no compression, token encoded', () => {
  assert.equal(SOCKET_OPTIONS.handshakeTimeout, TIMINGS.handshakeTimeout);
  assert.equal(SOCKET_OPTIONS.followRedirects, false);
  assert.equal(SOCKET_OPTIONS.perMessageDeflate, false);
  const url = new URL(connectionUrl('anova-a&b=c+d#e'));
  assert.equal(url.searchParams.get('token'), 'anova-a&b=c+d#e');
  assert.equal(url.searchParams.get('supportedAccessories'), 'APC,APO');
});

test('an unknown unit never gives a target', () => {
  const v = parseState(
    JSON.parse(JSON.stringify(jobState(COOKER, { target: 50, unit: 'K' }))),
  ).values;
  assert.equal(v.target, undefined);
});

test('the publisher keeps to 300 states per minute', async () => {
  const clock = testClock();
  const sent = [];
  const gladys = {
    publishChangedStates: async (batch) => {
      sent.push(...batch);
      return { count: batch.length };
    },
  };
  const p = new StatePublisher({
    gladys,
    logger: console,
    now: clock.monotonic,
    timers: clock.timers,
  });
  for (let i = 0; i < 450; i += 1) p.push(`f${i}`, { state: i });
  for (let i = 0; i < 5; i += 1) await p.flush();
  assert.equal(sent.length, 300);
  await clock.advance(MIN);
  await p.flush();
  assert.equal(sent.length, 400);
});

test('a stop wakes a start waiting for its state; a busy start is refused as busy', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  s.server.noStateAfterCommand = true;
  const pending = s.gladys.fake.sceneAction('start_cook', startFields(s));
  await settle();
  const t0 = s.clock.elapsed;
  await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  const ack = await during(s, pending, 2000);
  assert.ok(s.clock.elapsed - t0 < TIMINGS.startConfirm, 'woken by the stop');
  assert.equal(ack.data.outputs.result, 'accepted');
  await s.stopAll();

  const b = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  let release;
  const save = b.store.save.bind(b.store);
  b.store.save = (data) =>
    data.start && !release ? new Promise((r) => (release = () => r(save(data)))) : save(data);
  const first = b.gladys.fake.sceneAction('start_cook', startFields(b));
  await settle();
  const second = await b.gladys.fake.sceneAction('start_cook', startFields(b));
  assert.match(second.error, /Another start/);
  release();
  assert.equal((await first).success, true);
  b.store.save = save;
  await b.stopAll();
});

test('a stop not confirmed is given up after 10 min', async () => {
  const s = await connectedSetup();
  s.server.noStateAfterCommand = true;
  s.server.push(cooking('job-1'));
  await settle();
  await s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  s.app.stops.get(COOKER).firstAt -= TIMINGS.stopKeep;
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1, 'not sent again');
  assert.equal(s.app.stops.size, 0);
  await s.stopAll();
});

test('J1: a click always leaves, even when the cook changed and its state comes with the 101', async () => {
  for (const via of ['button', 'scene']) {
    const server = fakeAnova();
    server.syncLists = true;
    server.noStateAfterCommand = true;
    server.states[COOKER] = cooking('job-OLD');
    const s = await connectedSetup({ server });
    server.main.drop();
    await s.advance(1);
    server.states[COOKER] = cooking('job-NEW');
    const pending =
      via === 'scene'
        ? s.gladys.fake.sceneAction('stop_cook', { device: s.ext(`cooker:${COOKER}`) })
        : s.gladys.fake.setValue(
            { external_id: s.ext(`cooker:${COOKER}`) },
            { external_id: s.ext(`cooker:${COOKER}:stop`) },
            1,
          );
    const ack = await during(s, pending);
    assert.equal(ack.success, true);
    assert.equal(server.commands('CMD_APC_STOP').length, 1, via);
    if (via === 'scene') {
      assert.equal(ack.data.outputs.result, 'accepted');
    }
    await s.stopAll();
  }
});

test('J2: a stop accepted then kept never cuts a cook started meanwhile (state with the 101)', async () => {
  const server = fakeAnova();
  server.syncLists = true;
  server.noStateAfterCommand = true;
  server.states[COOKER] = cooking('job-NEW');
  const clock = testClock();
  const store = memoryStore({
    stops: [
      {
        cookerId: COOKER,
        family: 'APC',
        type: 'a4',
        at: clock.now() - 30_000,
        sends: 1,
        acked: true,
        cookKey: 'job-OLD',
      },
    ],
  });
  const s = createSetup({ server, store, clock });
  await s.start();
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(server.commands('CMD_APC_STOP').length, 0);
  assert.equal(s.app.stops.size, 0);
  await s.stopAll();

  // The same cook still running: the accepted stop is sent again (N22: acked read back).
  const same = fakeAnova();
  same.syncLists = true;
  same.noStateAfterCommand = true;
  same.states[COOKER] = cooking('job-OLD');
  const c2 = testClock();
  const s2 = createSetup({
    server: same,
    clock: c2,
    store: memoryStore({
      stops: [
        {
          cookerId: COOKER,
          family: 'APC',
          type: 'a4',
          at: c2.now() - 30_000,
          sends: 1,
          acked: true,
          cookKey: 'job-OLD',
        },
      ],
    }),
  });
  await s2.start();
  await s2.advance(1);
  assert.equal(
    same.commands('CMD_APC_STOP').length,
    0,
    'accepted: checked first, not sent at once',
  );
  await s2.advance(TIMINGS.stopFirstState * 2 + 10);
  assert.equal(same.commands('CMD_APC_STOP').length, 1);
  await s2.stopAll();
});

test('n1: a start held by a slow /data says it took too long', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  const save = s.store.save.bind(s.store);
  s.store.save = (data) => (data.start ? new Promise(() => {}) : save(data));
  const pending = s.gladys.fake.sceneAction('start_cook', startFields(s));
  await settle();
  await s.advance(TIMINGS.startSendBy + 1);
  const ack = await pending;
  assert.match(ack.error, /too long/);
  s.store.save = save;
  await s.stopAll();
});

test('N17, N18: nothing connects after stop()', async () => {
  const s = await connectedSetup();
  await s.stopAll();
  const statuses = s.gladys.fake.connectionStatuses.length;
  await s.app.connect({ force: true });
  await s.app.resume();
  await settle();
  assert.equal(s.server.sockets.length, 1);
  assert.equal(s.gladys.fake.connectionStatuses.length, statuses, 'no status after stop()');
});

test('N23: a new click keeps the identity of the cook of the previous one', async () => {
  const clock = testClock();
  const server = fakeAnova();
  server.down = true;
  const store = memoryStore({
    stops: [
      {
        cookerId: COOKER,
        family: 'APC',
        type: 'a4',
        at: clock.now() - 1000,
        sends: 0,
        cookKey: 'job-OLD',
      },
    ],
  });
  const s = createSetup({ server, store, clock });
  await s.start();
  await during(s, s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' }));
  assert.equal(store.data.stops[0].cookKey, 'job-OLD');
  await s.stopAll();
});
