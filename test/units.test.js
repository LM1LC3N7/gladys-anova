// -----------------------------------------------------------------------------
// Configuration, /data and devices (pure parts).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, refusedMark } from '../src/config.js';
import { buildDevice, definitions, parseExternalId, statesOf } from '../src/devices.js';
import { fileStore, normalizeMemory } from '../src/store.js';
import { assertCoreDevice } from './helpers/coreFeature.js';

const gladys = createFakeGladys();

test('the token: "anova-" and printable ASCII only; options off by default', () => {
  assert.equal(normalizeConfig({ token: ' anova-abc.DEF_123 ' }).token, 'anova-abc.DEF_123');
  for (const bad of [
    'abc',
    'anova-',
    'anova-a b',
    'anova-a\nb',
    'anova-é',
    `anova-${'x'.repeat(5000)}`,
  ]) {
    const c = normalizeConfig({ token: bad });
    assert.equal(c.token, '', bad);
    assert.equal(c.tokenInvalid, true);
  }
  const c = normalizeConfig({});
  assert.deepEqual(
    [c.allowStart, c.stopAtTimerEnd, c.language, c.tokenInvalid],
    [false, false, 'fr', false],
  );
  assert.equal(normalizeConfig({ allow_start: 'true' }).allowStart, true);
  assert.equal(normalizeConfig({ allow_start: 'yes' }).allowStart, false);
  assert.match(refusedMark('anova-x'), /^[0-9a-f]{2}$/, 'only 8 bits of a refused token');
});

test('/data: missing is empty, unreadable or corrupt is not; 0600; bounded on read', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anova-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { status: 'missing' });
  await store.save({ a: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(), { status: 'ok', data: { a: 1 } });
  await writeFile(path, '{broken');
  assert.deepEqual(await store.load(), { status: 'unreadable' });
  assert.deepEqual(await fileStore(dir).load(), { status: 'unreadable' }, 'a directory');
  assert.doesNotMatch(await readFile(path, 'utf8'), /token/);

  const wall = Date.UTC(2026, 5, 1);
  const m = normalizeMemory(
    {
      pause: { kind: 'busy', until: wall + 100 * 3600_000 },
      block: { mark: 'zz' },
      backoff: { level: 99, lastAttemptAt: wall + 1000 },
      stops: [
        { cookerId: 'cookerA1', family: 'APC', type: 'a4', at: wall - 1000, sends: 9 },
        { cookerId: 'cookerB1', family: 'APC', at: wall + 1000 },
        { cookerId: 'cookerC1', family: 'APC', at: wall - 3600_000 },
        { cookerId: '../x', family: 'APC', at: wall - 1000 },
      ],
    },
    wall,
  );
  assert.equal(m.pause.until, wall + 6 * 3600_000, 'a pause is bounded to 6 h');
  assert.equal(m.block, null);
  assert.equal(m.backoff.level, 8);
  assert.equal(m.backoff.lastAttemptAt, 0, 'a date in the future is invalid');
  assert.deepEqual(
    m.stops.map((s) => [s.cookerId, s.sends]),
    [['cookerA1', 3]],
  );
});

test('devices follow the rules of the core; the stop is a button, no switch nor binary', () => {
  for (const family of ['APC', 'APO']) {
    const device = buildDevice(
      gladys,
      { cookerId: 'cookerA1', family, type: family === 'APC' ? 'a4' : 'oven_v2', name: 'Kitchen' },
      { language: 'en' },
    );
    assertCoreDevice(device, family);
    for (const f of device.features) {
      assert.notEqual(f.category, C.SWITCH);
      assert.notEqual(f.type, 'binary');
      assert.equal(f.read_only, f.category !== C.BUTTON, f.external_id);
      assert.equal(f.supported_options, undefined);
    }
    const stop = device.features.find((f) => f.external_id.endsWith(':stop'));
    assert.deepEqual([stop.category, stop.type], [C.BUTTON, T.BUTTON.PUSH]);
  }
  assert.equal(Object.keys(definitions('APC')).length, 7);
});

test('a device published again keeps every feature of the created one', () => {
  const ids = gladys.externalIds('cooker', 'cookerA1');
  const created = { features: [{ external_id: ids.feature('old-role'), name: 'Old' }] };
  const device = buildDevice(
    gladys,
    { cookerId: 'cookerA1', family: 'APC' },
    { language: 'fr' },
    created,
  );
  assert.ok(device.features.some((f) => f.external_id === ids.feature('old-role')));
  assert.deepEqual(device.params, []);
  assert.equal(device.name, 'Anova Precision Cooker');
});

test('external ids: ours only, exact shape', () => {
  assert.deepEqual(parseExternalId(gladys, gladys.externalId('cooker:cookerA1:stop')), {
    family: 'APC',
    cookerId: 'cookerA1',
    role: 'stop',
  });
  assert.equal(parseExternalId(gladys, gladys.externalId('oven:ovenAB12')).family, 'APO');
  for (const bad of [
    'ext:other:cooker:cookerA1',
    gladys.externalId('fridge:cookerA1'),
    gladys.externalId('cooker:a.b.c.d'),
    gladys.externalId('cooker:abc'),
    gladys.externalId('cooker:cookerA1:stop:x'),
    42,
  ]) {
    assert.equal(parseExternalId(gladys, bad), undefined, String(bad));
  }
});

test('states: an unknown value is never published as 0', () => {
  const states = statesOf(
    gladys,
    'APC',
    'cookerA1',
    {
      state: 'cooking',
      temperature: undefined,
      target: 60,
      remaining: 61,
      total: undefined,
      alert: undefined,
    },
    'en',
  );
  assert.deepEqual(
    states.map(([id, v]) => [id.split(':').at(-1), v]),
    [
      ['target-temperature', { state: 60 }],
      ['timer-remaining', { state: 2 }],
      ['state', { text: 'Cooking' }],
    ],
  );
});
