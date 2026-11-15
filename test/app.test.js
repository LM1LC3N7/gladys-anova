// -----------------------------------------------------------------------------
// The app end to end, on the SDK's fake Gladys, the fake Anova server and a
// virtual clock that moves at every read (test/kit/clock.mjs).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refusedMark } from '../src/config.js';
import { TIMINGS } from '../src/constants.js';
import {
  COOKER,
  COOKER2,
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
const HOUR = 60 * MIN;

const startFields = (s, o = {}) => ({
  device: s.ext(`cooker:${o.cooker ?? COOKER}`),
  temperature: 'temperature' in o ? o.temperature : 60,
  minutes: 'minutes' in o ? o.minutes : 90,
});

async function connectedSetup(options = {}) {
  const s = createSetup(options);
  await s.start();
  await s.advance(1);
  return s;
}

test('connects with the token, lists the devices, publishes their states', async () => {
  const server = fakeAnova({
    cookers: [{ cookerId: COOKER, type: 'a4' }],
    ovens: [{ cookerId: OVEN }],
  });
  const s = await connectedSetup({ server });
  assert.equal(server.sockets.length, 1);
  const url = new URL(server.sockets[0].url);
  assert.equal(url.origin, 'wss://devices.anovaculinary.io');
  assert.equal(url.searchParams.get('token'), TOKEN);
  assert.equal(url.searchParams.get('supportedAccessories'), 'APC,APO');
  assert.match(server.sockets[0].options.headers['User-Agent'], /^gladys-anova\/0\.1\.0 \(\+https/);
  assert.equal(server.sockets[0].options.maxPayload, 256 * 1024);
  assert.equal(s.status().connected, true);
  const devices = s.gladys.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.external_id),
    [s.ext(`cooker:${COOKER}`), s.ext(`oven:${OVEN}`)],
  );
  assert.deepEqual(devices[0].params, [{ name: 'anova_type', value: 'a4' }]);
  await s.advance(TIMINGS.flushInterval);
  const f = (id, role) => s.gladys.fake.lastState(s.ext(`${id}:${role}`));
  assert.equal(f(`cooker:${COOKER}`, 'temperature'), 21.4);
  assert.equal(f(`cooker:${COOKER}`, 'target-temperature'), 60);
  assert.equal(f(`cooker:${COOKER}`, 'timer-remaining'), 0);
  assert.equal(f(`cooker:${COOKER}`, 'state'), 'À l’arrêt');
  assert.equal(f(`cooker:${COOKER}`, 'alert'), 'Aucune');
  assert.equal(f(`oven:${OVEN}`, 'temperature'), 24.4);
  // An idle oven: no target published (unknown, never 0).
  assert.equal(f(`oven:${OVEN}`, 'target-temperature'), undefined);
  await s.stopAll();
});

test('the token never reaches the logs, the status, /data nor Gladys', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 429, headers: { 'retry-after': '120' } });
  const s = createSetup({ server });
  await s.start();
  await s.advance(3 * MIN);
  await s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  await s.advance(TIMINGS.flushInterval);
  const secret = TOKEN.slice(6);
  const seen = JSON.stringify([
    s.logger.lines,
    s.store.data,
    s.gladys.fake.requests,
    s.gladys.fake.wsMessages,
  ]);
  assert.ok(server.sockets.length >= 2);
  assert.ok(!seen.includes(secret));
  await s.stopAll();
});

test('getConfig failing in connected is tried again on a timer, then starts', async () => {
  const s = createSetup();
  let fails = 2;
  let calls = 0;
  const original = s.gladys.getConfig.bind(s.gladys);
  s.gladys.getConfig = async () => {
    calls += 1;
    // The first call is the resynchronization of the SDK itself.
    if (calls > 1 && fails > 0) {
      fails -= 1;
      throw Object.assign(new Error('boom'), { status: 503 });
    }
    return original();
  };
  await s.start();
  assert.equal(s.status().connected, false);
  assert.equal(s.server.sockets.length, 0);
  await s.advance(TIMINGS.configRetry[0]);
  assert.equal(s.server.sockets.length, 0);
  await s.advance(TIMINGS.configRetry[1]);
  await s.advance(1);
  assert.equal(s.server.sockets.length, 1);
  assert.equal(s.status().connected, true);
  await s.stopAll();
});

test('a reconnection of Gladys keeps the Anova connection and republishes', async () => {
  const s = await connectedSetup();
  const statuses = s.gladys.fake.connectionStatuses.length;
  await s.app.connected();
  await settle();
  assert.equal(s.server.sockets.length, 1);
  assert.ok(s.gladys.fake.connectionStatuses.length > statuses);
  assert.equal(s.status().connected, true);
  await s.stopAll();
});

test('a 401 stops: persisted, no new try by itself, lifted by a new token or the button', async () => {
  const server = fakeAnova();
  server.token = 'anova-other';
  const store = memoryStore();
  const s = await connectedSetup({ server, store });
  assert.equal(server.sockets.length, 1);
  assert.equal(s.status().connected, false);
  assert.match(s.status().message.en, /refused/);
  assert.deepEqual(store.data.block, { mark: refusedMark(TOKEN) });
  await s.advance(48 * HOUR);
  assert.equal(server.sockets.length, 1, 'never sent again by itself');
  await s.stopAll();

  // A restart with the same token: still nothing sent.
  const again = await connectedSetup({ server, store });
  assert.equal(server.sockets.length, 1);
  assert.match(again.status().message.en, /refused/);
  // The button tries once (the server still refuses).
  await again.gladys.fake.action('test_connection', {});
  await settle();
  assert.equal(server.sockets.length, 2);
  // A new token: tried after the shortest gap, accepted, the refusal is forgotten.
  server.token = 'anova-new-token-value';
  await again.gladys.fake.configUpdated({ token: 'anova-new-token-value' });
  await again.advance(1);
  assert.equal(server.sockets.length, 2, 'never faster than 5 s after the last attempt');
  await again.advance(TIMINGS.backoff[0]);
  assert.equal(server.sockets.length, 3);
  assert.equal(again.status().connected, true);
  assert.equal(store.data.block, null);
  await again.stopAll();
});

test('closed twice right after the open without a message: the token is taken as refused', async () => {
  const server = fakeAnova();
  server.closeSilently = true;
  const store = memoryStore();
  const s = await connectedSetup({ server, store });
  assert.equal(server.sockets.length, 1);
  assert.notEqual(store.data.block?.mark, refusedMark(TOKEN), 'one silent close is not a refusal');
  await s.advance(TIMINGS.backoff[0]);
  assert.equal(server.sockets.length, 2);
  assert.deepEqual(store.data.block, { mark: refusedMark(TOKEN) });
  assert.match(s.status().message.en, /probably refused/);
  await s.advance(48 * HOUR);
  assert.equal(server.sockets.length, 2, 'no new try by itself');
  // The button tries again; a working token lifts the refusal.
  server.closeSilently = false;
  const ack = await s.gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(server.sockets.length, 3);
  assert.equal(store.data.block, null);
  await s.stopAll();
});

test('a 403 is not a refused token: backoff', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 403 });
  const s = await connectedSetup({ server });
  assert.equal(s.store.data.block, null);
  assert.match(s.status().message.en, /HTTP 403/);
  await s.advance(TIMINGS.backoff[0]);
  assert.equal(server.sockets.length, 2);
  assert.equal(s.status().connected, true);
  await s.stopAll();
});

test('a 429 pauses for its Retry-After (bounded), kept across a restart', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 429, headers: { 'retry-after': '1200' } });
  const store = memoryStore();
  const s = await connectedSetup({ server, store });
  assert.match(s.status().message.en, /429/);
  await s.stopAll();
  const again = await connectedSetup({ server, store, clock: s.clock });
  await again.advance(10 * MIN);
  assert.equal(server.sockets.length, 1, 'no connection during the pause, restart included');
  await again.advance(11 * MIN);
  assert.equal(server.sockets.length, 2);
  assert.equal(again.status().connected, true);
  await again.stopAll();

  const big = fakeAnova();
  big.refusals.push({ status: 429, headers: { 'retry-after': '999999' } });
  const capped = await connectedSetup({ server: big });
  await capped.advance(6 * HOUR + MIN);
  assert.equal(big.sockets.length, 2, 'a Retry-After is capped at 6 h');
  await capped.stopAll();
});

test('network failures back off, growing, never faster, and a restart keeps the pace', async () => {
  const server = fakeAnova();
  server.down = true;
  const store = memoryStore();
  const s = await connectedSetup({ server, store, random: () => 1 });
  const times = [];
  for (let i = 0; i < 8; i += 1) {
    times.push(s.clock.elapsed);
    const before = server.sockets.length;
    while (server.sockets.length === before) {
      await s.advance(1000);
    }
  }
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / 1000));
  // 5, 15, 30, 60, 120, 300, 600 s (random = 1: the whole step), 1 s resolution.
  assert.deepEqual(
    gaps.map((g, i) => g >= TIMINGS.backoff[i] / 1000 && g <= TIMINGS.backoff[i] / 1000 + 1),
    Array(7).fill(true),
    `gaps ${gaps}`,
  );
  await s.stopAll();
  // A restart right after: not before half of the last step.
  const count = server.sockets.length;
  const again = await connectedSetup({ server, store, clock: s.clock, random: () => 1 });
  await again.advance(60_000);
  assert.equal(server.sockets.length, count);
  await again.stopAll();
});

test('a connection closed before it is stable backs off more each time; a stable one resets', async () => {
  const s = await connectedSetup({ random: () => 1 });
  s.server.main.drop();
  await s.advance(1);
  assert.equal(s.store.data.backoff.level, 1);
  await s.advance(TIMINGS.backoff[0]);
  assert.equal(s.server.sockets.length, 2);
  s.server.main.drop();
  await s.advance(1);
  await s.advance(TIMINGS.backoff[0]);
  assert.equal(s.server.sockets.length, 2, 'the second close waits 15 s');
  await s.advance(TIMINGS.backoff[1]);
  assert.equal(s.server.sockets.length, 3);
  await s.advance(TIMINGS.stableAfter + TIMINGS.pingInterval);
  assert.equal(s.store.data.backoff.level, 0);
  await s.stopAll();
});

test('no device list within 30 s: cut and tried again later', async () => {
  const server = fakeAnova();
  server.silentLists = true;
  const s = await connectedSetup({ server });
  await s.advance(TIMINGS.listTimeout + 1);
  assert.equal(server.sockets[0].readyState, 3);
  await s.stopAll();
});

test('a ping without pong cuts the connection; a long silence opens a fresh one', async () => {
  const s = await connectedSetup();
  s.server.answerPings = false;
  await s.advance(TIMINGS.pingInterval);
  await s.advance(TIMINGS.pingInterval);
  assert.equal(s.server.sockets[0].readyState, 3);
  s.server.answerPings = true;
  await s.advance(TIMINGS.backoff[0]);
  assert.equal(s.server.sockets.length, 2);
  await s.advance(TIMINGS.silenceRefresh + TIMINGS.pingInterval + TIMINGS.backoff[0]);
  assert.equal(s.server.sockets.length, 3, 'silent 25 min: opened again');
  await s.stopAll();
});

test('the stop button sends the documented stop, confirmed by the idle state', async () => {
  const s = await connectedSetup();
  s.server.states[COOKER] = jobState(COOKER, { cooking: true, jobId: 'job-9' });
  s.server.push(s.server.states[COOKER]);
  await settle();
  const ack = await s.gladys.fake.setValue(
    { external_id: s.ext(`cooker:${COOKER}`) },
    { external_id: s.ext(`cooker:${COOKER}:stop`) },
    1,
  );
  assert.equal(ack.success, true);
  const [stop] = s.server.commands('CMD_APC_STOP');
  assert.deepEqual(stop.payload, { cookerId: COOKER, type: 'a4' });
  assert.equal(typeof stop.requestId, 'string');
  await settle();
  assert.equal(s.app.stops.size, 0, 'confirmed by the idle state');
  assert.deepEqual(s.store.data.stops, []);
  await s.stopAll();
});

test('an oven stop uses the oven payload', async () => {
  const server = fakeAnova({ cookers: [], ovens: [{ cookerId: OVEN }] });
  const s = await connectedSetup({ server });
  const ack = await s.gladys.fake.sceneAction('stop_cook', { device: s.ext(`oven:${OVEN}`) });
  assert.equal(ack.success, true);
  assert.deepEqual(server.commands('CMD_APO_STOP')[0].payload, {
    id: OVEN,
    type: 'CMD_APO_STOP',
  });
  await s.stopAll();
});

test('the stop leaves despite a 429 pause, a refused token and no connection', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 429, headers: { 'retry-after': '3600' } });
  const s = await connectedSetup({ server });
  assert.equal(server.open.length, 0);
  const t0 = s.clock.elapsed;
  const ack = await s.gladys.fake.sceneAction('stop_cook', { device: s.ext(`cooker:${COOKER}`) });
  assert.equal(ack.success, true);
  assert.ok(['accepted', 'confirmed'].includes(ack.data.outputs.result), ack.data.outputs.result);
  assert.ok(s.clock.elapsed - t0 < TIMINGS.stopBudget);
  assert.equal(server.commands('CMD_APC_STOP').length, 1);
  await s.stopAll();

  // A refused token: the click still tries once (the stop is never refused).
  const refused = fakeAnova();
  refused.token = 'anova-other';
  const r = await connectedSetup({ server: refused });
  assert.match(r.status().message.en, /refused/);
  refused.token = TOKEN; // accepted again on Anova's side
  const ack2 = await r.gladys.fake.sceneAction('stop_cook', { device: r.ext(`cooker:${COOKER}`) });
  assert.equal(ack2.success, true);
  assert.equal(refused.commands('CMD_APC_STOP').length, 1);
  await r.stopAll();
});

test('the stop leaves with the option off, /data unreadable and the type from the Gladys device', async () => {
  const server = fakeAnova();
  server.silentLists = true;
  const store = memoryStore();
  store.unreadable = true;
  const s = createSetup({
    server,
    store,
    devices: [
      {
        name: 'Cooker',
        external_id: `ext:test-integration:cooker:${COOKER}`,
        params: [{ name: 'anova_type', value: 'a6' }],
        features: [],
      },
    ],
  });
  await s.start();
  assert.equal(server.sockets.length, 0, '/data unreadable: no connection by itself');
  assert.match(s.status().message.en, /cannot be read/);
  const ack = await s.gladys.fake.setValue(
    { external_id: s.ext(`cooker:${COOKER}`), params: [{ name: 'anova_type', value: 'a6' }] },
    { external_id: s.ext(`cooker:${COOKER}:stop`) },
    1,
  );
  assert.equal(ack.success, true);
  assert.deepEqual(server.commands('CMD_APC_STOP')[0].payload, { cookerId: COOKER, type: 'a6' });
  assert.equal(store.saves, 0, 'nothing written over an unreadable /data');
  await s.stopAll();
});

test('a stop without a connection is queued, kept in /data and sent after a restart', async () => {
  const server = fakeAnova();
  server.down = true;
  const store = memoryStore();
  const devices = [
    {
      name: 'Cooker',
      external_id: `ext:test-integration:cooker:${COOKER}`,
      params: [{ name: 'anova_type', value: 'a5' }],
      features: [],
    },
  ];
  const s = await connectedSetup({ server, store, devices });
  const ack = await s.gladys.fake.sceneAction('stop_cook', { device: s.ext(`cooker:${COOKER}`) });
  assert.equal(ack.data.outputs.result, 'queued');
  assert.equal(store.data.stops.length, 1);
  assert.equal(store.data.stops[0].type, 'a5', 'the type from the Gladys device');
  await s.stopAll();
  server.down = false;
  const again = await connectedSetup({ server, store, clock: s.clock });
  assert.equal(server.commands('CMD_APC_STOP').length, 1, 'sent at the first connection');
  assert.deepEqual(server.commands('CMD_APC_STOP')[0].payload, { cookerId: COOKER, type: 'a5' });
  await settle();
  assert.deepEqual(store.data.stops, []);
  await again.stopAll();
});

test('a stop still contradicted is sent again (3 times at most); a new cook is left alone', async () => {
  const s = await connectedSetup();
  s.server.noStateAfterCommand = true;
  s.server.push(jobState(COOKER, { cooking: true, jobId: 'job-1' }));
  await settle();
  await s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  s.server.push(jobState(COOKER, { cooking: true, jobId: 'job-1' }));
  await settle();
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 2);
  s.server.push(jobState(COOKER, { cooking: true, jobId: 'job-1' }));
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 3);
  s.server.push(jobState(COOKER, { cooking: true, jobId: 'job-1' }));
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 3, 'never more than 3');
  assert.equal(s.app.stops.size, 0);

  // A cook started afterwards (another job id): the stop is not sent again.
  await s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  s.server.push(jobState(COOKER, { cooking: true, jobId: 'job-from-the-app' }));
  await settle();
  await s.advance(TIMINGS.stopRecheck);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 4);
  assert.equal(s.app.stops.size, 0);
  await s.stopAll();
});

test('stops of 5 cookers from a scene: all 5 sent', async () => {
  const ids = ['cook1abc', 'cook2abc', 'cook3abc', 'cook4abc', 'cook5abc'];
  const server = fakeAnova({ cookers: ids.map((cookerId) => ({ cookerId, type: 'a7' })) });
  const s = await connectedSetup({ server });
  server.status.CMD_APC_STOP = 'error';
  const acks = await Promise.all(
    ids.map((id) => s.gladys.fake.sceneAction('stop_cook', { device: s.ext(`cooker:${id}`) })),
  );
  assert.ok(acks.every((a) => a.success));
  assert.deepEqual(
    server
      .commands('CMD_APC_STOP')
      .map((c) => c.payload.cookerId)
      .sort(),
    ids,
  );
  await s.stopAll();
});

test('the start is refused by default, nothing sent', async () => {
  const s = await connectedSetup();
  const ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas autorisé/);
  assert.equal(s.server.commands('CMD_APC_START').length, 0);
  // Checked first: nothing written to /data, whatever the fields.
  const saves = s.store.saves;
  const bad = await s.gladys.fake.sceneAction('start_cook', startFields(s, { temperature: 99 }));
  assert.match(bad.error, /pas autorisé/);
  assert.equal(s.store.saves, saves);
  assert.equal(s.store.data.start, null);
  await s.stopAll();
});

test('the start sends the documented payload and is confirmed by the state', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  const ack = await s.gladys.fake.sceneAction(
    'start_cook',
    startFields(s, { temperature: '57.25' }),
  );
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { result: 'started' });
  const [start] = s.server.commands('CMD_APC_START');
  assert.deepEqual(start.payload, {
    cookerId: COOKER,
    type: 'a4',
    targetTemperature: 57.3,
    unit: 'C',
    timer: 5400,
  });
  assert.ok(s.store.data.start.cookerId === COOKER);
  await s.stopAll();
});

test('the start bounds and checks every field', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  const bad = [
    { temperature: 92.06 },
    { temperature: 24.9 },
    { temperature: '' },
    { temperature: null },
    { temperature: 'hot' },
    { minutes: 1.5 },
    { minutes: 0 },
    { minutes: 6000 },
    { minutes: '' },
  ];
  for (const o of bad) {
    const ack = await s.gladys.fake.sceneAction('start_cook', startFields(s, o));
    assert.equal(ack.success, false, JSON.stringify(o));
  }
  for (const device of [
    s.ext(`oven:${OVEN}`),
    'ext:other:cooker:abcd',
    s.ext(`cooker:${COOKER}:stop`),
  ]) {
    const ack = await s.gladys.fake.sceneAction('start_cook', { ...startFields(s), device });
    assert.equal(ack.success, false, device);
  }
  assert.equal(s.server.commands('CMD_APC_START').length, 0);
  const ok = await s.gladys.fake.sceneAction(
    'start_cook',
    startFields(s, { temperature: 92.04, minutes: 5999 }),
  );
  assert.equal(ok.success, true, ok.error);
  assert.equal(s.server.commands('CMD_APC_START')[0].payload.targetTemperature, 92);
  await s.stopAll();
});

test('the start needs a fresh, idle state without a problem', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  s.server.push(jobState(COOKER, { cooking: true }));
  await settle();
  let ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /already cooking/);
  s.server.push(jobState(COOKER, { low: true }));
  await settle();
  ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /problem/);
  s.server.push(jobState(COOKER, { mode: 'LOW WATER' }));
  await settle();
  ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /problem/);
  // A state of an earlier connection is not enough.
  s.server.push(jobState(COOKER));
  await settle();
  delete s.server.states[COOKER];
  s.server.main.drop();
  await s.advance(TIMINGS.backoff[0] + 1);
  assert.equal(s.server.open.length, 1);
  ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /No recent state/);
  // Older than 30 min on this connection: refused too.
  s.server.push(jobState(COOKER));
  await settle();
  s.app.lastDeviceMessageAt = Infinity; // no silence refresh in this test
  await s.advance(TIMINGS.freshState + 1);
  ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /No recent state/);
  assert.equal(s.server.commands('CMD_APC_START').length, 0);
  await s.stopAll();
});

test('a failed write to /data refuses the start, nothing sent', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  s.store.failSaves = true;
  const ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /\/data/);
  assert.equal(s.server.commands('CMD_APC_START').length, 0);
  await s.stopAll();
});

test('a stop pressed while the start writes /data cancels it: nothing sent after the stop', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  const save = s.store.save.bind(s.store);
  let release;
  s.store.save = async (data) => {
    if (data.start && !release) {
      await new Promise((r) => {
        release = r;
      });
    }
    return save(data);
  };
  const starting = s.gladys.fake.sceneAction('start_cook', startFields(s));
  await settle();
  assert.ok(release, 'the start waits for /data');
  const stop = s.app.stopDevice({ cookerId: COOKER, family: 'APC', type: 'a4' });
  await settle();
  release();
  const ack = await starting;
  await stop;
  assert.equal(ack.success, false);
  assert.match(ack.error, /stop/);
  assert.equal(s.server.commands('CMD_APC_START').length, 0);
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1);
  await s.stopAll();
});

test('the option turned off while the start writes /data: refused before the send', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  const save = s.store.save.bind(s.store);
  s.store.save = async (data) => {
    if (data.start) {
      await s.app.configUpdated({ token: TOKEN, allow_start: false });
    }
    return save(data);
  };
  const ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.equal(ack.success, false);
  assert.equal(s.server.commands('CMD_APC_START').length, 0);
  await s.stopAll();
});

test('a start refused by Anova fails; without answer it is "sent", never a success', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, allow_start: true, language: 'en' } });
  s.server.status.CMD_APC_START = 'error';
  let ack = await s.gladys.fake.sceneAction('start_cook', startFields(s));
  assert.match(ack.error, /refused/);
  delete s.server.status.CMD_APC_START;
  s.server.silentCommands.add('CMD_APC_START');
  const pending = s.gladys.fake.sceneAction('start_cook', startFields(s));
  await settle();
  await s.advance(TIMINGS.startResponse);
  await s.advance(TIMINGS.startConfirm);
  ack = await pending;
  assert.deepEqual(ack.data.outputs, { result: 'sent' });
  await s.stopAll();
});

test('stop at the end of the timer: once per cook, only with the option', async () => {
  const s = await connectedSetup({ config: { token: TOKEN, stop_at_timer_end: true } });
  s.server.noStateAfterCommand = true;
  const done = jobState(COOKER, { cooking: true, jobState: 'MAINTAINING', jobId: 'job-5' });
  s.server.push(done);
  s.server.push(done);
  await settle();
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1);
  s.server.push(jobState(COOKER));
  await settle();
  s.server.push(done);
  await settle();
  assert.equal(s.server.commands('CMD_APC_STOP').length, 1, 'once per cook');
  await s.stopAll();

  const off = await connectedSetup();
  off.server.push(done);
  await settle();
  assert.equal(off.server.commands('CMD_APC_STOP').length, 0);
  await off.stopAll();
});

test('a created device gets its fresh states; dated when old, nothing past 2 h', async () => {
  const s = await connectedSetup();
  await s.advance(TIMINGS.flushInterval);
  const id = s.ext(`cooker:${COOKER}:temperature`);
  const count = () =>
    s.gladys.fake.states.filter((x) => x.device_feature_external_id === id).length;
  const before = count();
  s.app.lastDeviceMessageAt = Infinity;
  await s.advance(5 * MIN);
  s.gladys.forgetPublishedStates();
  await s.gladys.fake.deviceCreated({ external_id: s.ext(`cooker:${COOKER}`), features: [] });
  await s.advance(TIMINGS.flushInterval);
  const dated = s.gladys.fake.states.filter((x) => x.device_feature_external_id === id).at(-1);
  assert.equal(count(), before + 1);
  assert.ok(dated.created_at, 'an older state carries its date');
  await s.advance(2 * HOUR);
  s.gladys.forgetPublishedStates();
  await s.gladys.fake.deviceCreated({ external_id: s.ext(`cooker:${COOKER}`), features: [] });
  await s.advance(TIMINGS.flushInterval);
  assert.equal(count(), before + 1, 'older than 2 h: not published again');
  await s.stopAll();
});

test('/data unreadable: read again every 10 s; the button starts from an empty state', async () => {
  const store = memoryStore();
  store.unreadable = true;
  const s = await connectedSetup({ store });
  assert.equal(s.server.sockets.length, 0);
  await s.advance(TIMINGS.dataRetry);
  assert.equal(s.server.sockets.length, 0);
  store.unreadable = false;
  await s.advance(TIMINGS.dataRetry);
  await s.advance(1);
  assert.equal(s.server.sockets.length, 1);
  await s.stopAll();

  const store2 = memoryStore();
  store2.unreadable = true;
  const b = await connectedSetup({ store: store2 });
  const ack = await b.gladys.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  assert.equal(b.server.sockets.length, 1);
  assert.ok(store2.saves > 0);
  await b.stopAll();
});

test('the test button: at most every 30 s, respects a 429 pause', async () => {
  const server = fakeAnova();
  server.refusals.push({ status: 429, headers: { 'retry-after': '600' } });
  const s = await connectedSetup({ server });
  let ack = await s.gladys.fake.action('test_connection', {});
  assert.match(ack.data.en ?? JSON.stringify(ack.data), /429/);
  ack = await s.gladys.fake.action('test_connection', {});
  assert.match(JSON.stringify(ack.data), /30 s/);
  assert.equal(server.sockets.length, 1);
  await s.stopAll();
});

test('the only command feature is the stop; the rest is read only', async () => {
  const s = await connectedSetup();
  const ack = await s.gladys.fake.setValue(
    { external_id: s.ext(`cooker:${COOKER}`) },
    { external_id: s.ext(`cooker:${COOKER}:target-temperature`) },
    80,
  );
  assert.equal(ack.success, false);
  assert.equal(s.server.received.length, 0);
  await s.stopAll();
});

test('a second cooker and an unlisted state: the state of an unlisted device is ignored', async () => {
  const server = fakeAnova({
    cookers: [
      { cookerId: COOKER, type: 'a4' },
      { cookerId: COOKER2, type: 'a3' },
    ],
  });
  const s = await connectedSetup({ server });
  server.push(jobState('unlisted1'));
  server.push(ovenState(COOKER2)); // wrong family
  await s.advance(TIMINGS.flushInterval);
  assert.equal(s.gladys.fake.lastState(s.ext('cooker:unlisted1:temperature')), undefined);
  assert.equal(s.app.states.has('unlisted1'), false);
  await s.stopAll();
});

test('stop() closes everything: no timer, no connection left', async () => {
  const s = await connectedSetup();
  await s.stopAll();
  assert.equal(s.server.open.length, 0);
  const pending = s.clock.pending;
  await s.advance(HOUR);
  assert.equal(s.server.sockets.length, 1);
  assert.ok(pending <= 1, `${pending} timers left`);
});
