// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULTS, LANGUAGES } from '../src/config.js';
import { ACTIONS, SCENE_ACTIONS, START_LIMITS } from '../src/constants.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const allFields = [
  ...manifest.config_schema,
  ...[...manifest.actions, ...manifest.scene_actions].flatMap((a) => a.fields ?? []),
];

test('the store basics, and the version the same everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-anova:${manifest.version}`);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(manifest.gladys_version, '>=5.1.0', 'scene_actions and dynamic selects need 5.1');
  assert.equal(manifest.countries, undefined, 'Anova sells worldwide');
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['appliances']);
  assert.equal(manifest.keywords, undefined);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(
      docs,
      /not[\s>]+affiliated[\s>]+with[\s>]+Anova|sans[\s>]+lien[\s>]+avec[\s>]+Anova/i,
    );
    assert.match(
      docs,
      /never[\s>]+tested[\s>]+with[\s>]+a[\s>]+real[\s>]+device|jamais[\s>]+testé[\s>]+avec[\s>]+un[\s>]+vrai[\s>]+appareil/i,
    );
    assert.match(docs, /Personal\s+Access\s+Tokens/);
    assert.match(docs, /developer\.anovaculinary\.com\/terms/, 'the API terms of Anova');
  }
  for (const file of [
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'gladys-assistant-integration.json',
  ]) {
    assert.doesNotMatch(
      read(file),
      /chiffr|encrypt|hachage/i,
      `${file}: a secret is not encrypted`,
    );
  }
});

test('the licenses ship in the image', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'no name of a person');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Lash-L\/anova_wifi/);
  assert.match(notices, /MIT License/);
  assert.match(notices, /Copyright \(c\) 2022 Luke/);
  assert.ok(existsSync(new URL('../cover.png', import.meta.url)));
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code; the start off by default; the token a secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  assert.equal(fields.allow_start.type, 'boolean');
  assert.equal(fields.allow_start.default, false);
  assert.equal(fields.stop_at_timer_end.default, false);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    LANGUAGES,
  );
  assert.equal(fields.token.type, 'secret');
  assert.ok(fields.token.required);
  for (const f of allFields) {
    assert.match(f.key, /^[a-z0-9_]+$/);
    assert.ok(!f.key.startsWith('gladys_'), `${f.key}: never prefixed gladys_`);
    if (f.type === 'secret') {
      assert.equal(f.default, undefined, `${f.key}: no default on a secret`);
    }
    for (const o of f.options ?? []) {
      assert.equal(typeof o.value, 'string');
    }
  }
  const intro = fields.intro;
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
  }
  assert.ok(intro.links.every((l) => l.url.startsWith('https://')));
});

test('the actions and scene actions are those of the code, within their timeout', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  for (const name of Object.keys(SCENE_ACTIONS)) {
    assert.ok(handlers.includes(`onSceneAction(SCENE_ACTIONS.${name}`), `${name} has no handler`);
  }
  for (const action of [...manifest.actions, ...manifest.scene_actions]) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
  const start = manifest.scene_actions.find((a) => a.key === SCENE_ACTIONS.START_COOK);
  const f = Object.fromEntries(start.fields.map((x) => [x.key, x]));
  assert.deepEqual(
    [f.temperature.min, f.temperature.max],
    [START_LIMITS.minTemperature, START_LIMITS.maxTemperature],
  );
  assert.deepEqual(
    [f.minutes.min, f.minutes.max],
    [START_LIMITS.minMinutes, START_LIMITS.maxMinutes],
  );
  assert.equal(f.device.source, 'devices');
});
