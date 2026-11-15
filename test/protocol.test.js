// -----------------------------------------------------------------------------
// The Anova messages (src/protocol.js): lists, states in their shapes,
// answers and the documented commands.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numberIn,
  parseList,
  parseMessage,
  parseResponse,
  parseState,
  shortText,
  startCommand,
  stopCommand,
} from '../src/protocol.js';
import { COOKER, OVEN, apcList, apoList, jobState, ovenState } from './helpers/fakeAnova.js';

const parse = (message) => parseMessage(JSON.stringify(message));

test('numbers are strict: empty, null and text are unknown, never 0', () => {
  assert.equal(numberIn(12.5, 0, 100), 12.5);
  assert.equal(numberIn('12.5', 0, 100), 12.5);
  for (const bad of ['', ' ', null, undefined, 'hot', '12,5', '1e3', NaN, Infinity, true, [], {}]) {
    assert.equal(numberIn(bad, -100, 100), undefined, String(bad));
  }
  assert.equal(numberIn(101, 0, 100), undefined);
});

test('a message is bounded, JSON, and its keys are own keys only', () => {
  assert.equal(parseMessage('not json'), undefined);
  assert.equal(parseMessage('x'.repeat(300 * 1024)), undefined);
  assert.equal(parseMessage('{"payload":{}}'), undefined);
  const m = parseMessage('{"command":"RESPONSE","requestId":"r1","__proto__":{"payload":1}}');
  assert.equal(m.payload, undefined);
  assert.equal({}.payload, undefined, 'no prototype pollution');
});

test('device lists: valid ids only, bounded, family from the event', () => {
  const list = parseList(
    parse(
      apcList([
        { cookerId: COOKER, type: 'a4' },
        { cookerId: '../x', type: 'a4' },
        { cookerId: 'ab:cd', type: 'a4' },
        { cookerId: 'id.with.dots', type: 'a4' },
        { cookerId: COOKER, type: 'a5' },
        { cookerId: 'other123', type: 'BAD TYPE' },
      ]),
    ),
  );
  assert.equal(list.family, 'APC');
  assert.deepEqual(
    list.devices.map((d) => [d.cookerId, d.type]),
    [
      [COOKER, 'a4'],
      ['other123', undefined],
    ],
  );
  assert.equal(parseList(parse(apoList([{ cookerId: OVEN }]))).family, 'APO');
  const many = Array.from({ length: 60 }, (_, i) => ({ cookerId: `cooker${i}x`, type: 'a7' }));
  assert.equal(parseList(parse(apcList(many))).devices.length, 20);
  assert.equal(shortText('a\u0000b\u001fc'), 'abc');
  assert.equal(shortText('x'.repeat(100)).length, 60);
});

test('the job shape: idle, cooking, timer done, °F target converted, unknown unit unknown', () => {
  let v = parseState(parse(jobState(COOKER))).values;
  assert.equal(v.state, 'idle');
  assert.equal(v.cooking, false);
  assert.equal(v.remaining, 0);
  assert.equal(v.temperature, 21.4);
  assert.equal(v.alert, 'none');
  v = parseState(parse(jobState(COOKER, { cooking: true, remaining: 1200, jobId: 'j1' }))).values;
  assert.deepEqual(
    [v.state, v.cooking, v.remaining, v.total, v.cookKey],
    ['cooking', true, 1200, 3600, 'j1'],
  );
  v = parseState(
    parse(jobState(COOKER, { cooking: true, jobState: 'TIMER EXPIRED', remaining: 500 })),
  ).values;
  assert.deepEqual([v.state, v.timerDone, v.remaining], ['maintaining', true, 0]);
  v = parseState(parse(jobState(COOKER, { target: 140, unit: 'F' }))).values;
  assert.equal(v.target, 60);
  v = parseState(parse(jobState(COOKER, { target: 140, unit: 'K' }))).values;
  assert.equal(v.target, undefined);
  v = parseState(parse(jobState(COOKER, { water: '' }))).values;
  assert.equal(v.temperature, undefined);
  v = parseState(parse(jobState(COOKER, { low: true }))).values;
  assert.equal(v.alert, 'water_low');
  v = parseState(parse(jobState(COOKER, { mode: 'LOW WATER' }))).values;
  assert.deepEqual([v.state, v.cooking], ['low_water', false]);
  v = parseState(parse(jobState(COOKER, { mode: 'SOMETHING NEW' }))).values;
  assert.deepEqual([v.state, v.cooking], ['unknown', undefined]);
});

test('the A3 shape and the nodes shape', () => {
  const a3 = {
    command: 'EVENT_APC_STATE',
    payload: {
      cookerId: COOKER,
      type: 'a3',
      state: {
        firmwareVersion: '1.0',
        isCooking: true,
        currentTemperature: 131,
        targetTemperature: 140,
        timerInSeconds: 600,
        unit: 'F',
        currentJob: { jobStage: 'heating' },
      },
    },
  };
  let v = parseState(parse(a3)).values;
  assert.deepEqual([v.state, v.temperature, v.target, v.remaining], ['preheating', 55, 60, 600]);
  const nodes = {
    command: 'EVENT_APC_STATE',
    payload: {
      cookerId: COOKER,
      type: 'a6',
      state: {
        systemInfo: { firmwareVersion: '2.0' },
        state: { mode: 'cook' },
        updatedTimestamp: '2026-01-01T10:10:00Z',
        cook: { activeStageMode: 'holding', cookId: 'c-1' },
        nodes: {
          timer: { mode: 'running', initial: 3600, startedAtTimestamp: '2026-01-01T10:00:00Z' },
          waterTemperatureSensor: { current: { celsius: 59.94 }, setpoint: { celsius: 60 } },
          lowWater: { warning: false, empty: false },
        },
      },
    },
  };
  v = parseState(parse(nodes)).values;
  assert.deepEqual(
    [v.state, v.remaining, v.temperature, v.cookKey, v.alert],
    ['cooking', 3000, 59.9, 'c-1', 'none'],
  );
  nodes.payload.state.state.mode = 'idle';
  v = parseState(parse(nodes)).values;
  assert.deepEqual([v.state, v.cooking, v.remaining], ['idle', false, 0]);
});

test('the oven state; a state without cookerId or state is dropped', () => {
  let v = parseState(parse(ovenState(OVEN))).values;
  assert.deepEqual([v.state, v.temperature, v.target, v.alert], ['idle', 24.4, undefined, 'none']);
  v = parseState(
    parse(
      ovenState(OVEN, { mode: 'cook', timerMode: 'running', timerCurrent: 300, closed: false }),
    ),
  ).values;
  assert.deepEqual([v.state, v.target, v.remaining, v.alert], ['cooking', 180, 300, 'door_open']);
  assert.equal(
    parseState(parse({ command: 'EVENT_APC_STATE', payload: { state: {} } })),
    undefined,
  );
  assert.equal(
    parseState(parse({ command: 'EVENT_APC_STATE', payload: { cookerId: COOKER } })),
    undefined,
  );
});

test('answers: only "ok" is a success', () => {
  assert.deepEqual(
    parseResponse(parse({ command: 'RESPONSE', requestId: 'r', payload: { status: 'ok' } })),
    {
      requestId: 'r',
      ok: true,
      status: 'ok',
    },
  );
  assert.equal(
    parseResponse(parse({ command: 'RESPONSE', requestId: 'r', payload: {} })).ok,
    false,
  );
  assert.equal(parseResponse(parse({ command: 'RESPONSE', payload: { status: 'ok' } })), undefined);
});

test('the commands are those of the documentation', () => {
  assert.deepEqual(stopCommand({ cookerId: COOKER, family: 'APC', type: 'a4' }), {
    command: 'CMD_APC_STOP',
    payload: { cookerId: COOKER, type: 'a4' },
  });
  assert.deepEqual(stopCommand({ cookerId: OVEN, family: 'APO', type: 'oven_v1' }), {
    command: 'CMD_APO_STOP',
    payload: { id: OVEN, type: 'CMD_APO_STOP' },
  });
  assert.deepEqual(
    startCommand({ cookerId: COOKER, type: 'a7' }, { temperature: 65, minutes: 60 }),
    {
      command: 'CMD_APC_START',
      payload: { cookerId: COOKER, type: 'a7', targetTemperature: 65, unit: 'C', timer: 3600 },
    },
  );
});
