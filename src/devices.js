// -----------------------------------------------------------------------------
// An Anova device -> one Gladys device and its states (pure).
//
// `ext:<selector>:cooker:<cookerId>` for a Precision Cooker,
// `ext:<selector>:oven:<cookerId>` for a Precision Oven: the cookerId of the
// Anova device lists. Readings are read only. The only command feature is
// the stop, a `button`/`push` (never a switch nor a binary); a start is a
// scene action (src/app.js), refused unless the configuration allows it.
//
// Every device carries all its features, and a device published again keeps
// every feature of the device the user created.
//
// Temperatures in °C on `temperature-sensor`/`probe` (a probe in the water or
// the oven, kept out of the room average of Gladys); the target on
// `thermostat`/`target-temperature`, read only; times in minutes on
// `duration`. Units from DEVICE_FEATURE_UNITS_BY_CATEGORY of the core.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FAMILIES, FEATURES, KINDS } from './constants.js';
import { ALERT_NAMES, DEFAULT_NAMES, FEATURE_NAMES, STATE_NAMES, word } from './i18n.js';

/** BUTTON_PUSH.PRESSED of the core: the only value a button sends. */
export const PRESSED = 1;

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});

const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });

const minutes = sensor({
  category: C.DURATION,
  type: T.DURATION.INTEGER,
  unit: U.MINUTES,
  min: 0,
  max: 6000,
  keep_history: false,
});

/** The features of a family, by role, in display order. */
export function definitions(family) {
  const max = family === FAMILIES.OVEN ? 300 : 110;
  return {
    [FEATURES.TEMPERATURE]: sensor({
      category: C.TEMPERATURE_SENSOR,
      type: T.TEMPERATURE_SENSOR.PROBE,
      unit: U.CELSIUS,
      min: -10,
      max,
    }),
    [FEATURES.TARGET]: sensor({
      category: C.THERMOSTAT,
      type: T.THERMOSTAT.TARGET_TEMPERATURE,
      unit: U.CELSIUS,
      min: 0,
      max,
    }),
    [FEATURES.TIMER_REMAINING]: minutes,
    [FEATURES.TIMER_TOTAL]: minutes,
    [FEATURES.STATE]: text,
    [FEATURES.ALERT]: text,
    [FEATURES.STOP]: {
      category: C.BUTTON,
      type: T.BUTTON.PUSH,
      min: 0,
      max: 1,
      read_only: false,
      has_feedback: false,
      keep_history: false,
    },
  };
}

export const deviceIds = (gladys, family, cookerId) => gladys.externalIds(KINDS[family], cookerId);

/**
 * An external id of this integration -> { family, cookerId, role }, else
 * undefined (another integration, another kind, a malformed id).
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const prefix = gladys.externalId('');
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const m = /^(cooker|oven):([A-Za-z0-9_-]{4,64})(?::([a-z-]{1,32}))?$/.exec(
    externalId.slice(prefix.length),
  );
  if (!m) {
    return undefined;
  }
  return {
    family: m[1] === KINDS.APO ? FAMILIES.OVEN : FAMILIES.COOKER,
    cookerId: m[2],
    role: m[3],
  };
}

/** The device of an Anova device, with every feature of the created device kept. */
export function buildDevice(gladys, device, { language }, created) {
  const ids = deviceIds(gladys, device.family, device.cookerId);
  const names = FEATURE_NAMES[device.family];
  const features = Object.entries(definitions(device.family)).map(([role, definition]) => ({
    ...definition,
    name: word(names[role], language),
    external_id: ids.feature(role),
    selector: ids.feature(role),
  }));
  // Features of the created device that this version does not publish stay.
  for (const old of created?.features ?? []) {
    if (!features.some((f) => f.external_id === old.external_id)) {
      features.push(old);
    }
  }
  const params = [];
  if (device.type) {
    params.push({ name: 'anova_type', value: device.type });
  }
  return {
    name: device.name ?? word(DEFAULT_NAMES[device.family], language),
    external_id: ids.device,
    selector: ids.device,
    model: device.type ?? (device.family === FAMILIES.OVEN ? 'oven' : 'cooker'),
    should_poll: false,
    params,
    features,
  };
}

const toMinutes = (seconds) => (seconds === undefined ? undefined : Math.ceil(seconds / 60));

/**
 * The states of a device from its parsed values: [featureId, value], value
 * being { state } or { text }. An unknown value is not published (never 0).
 */
export function statesOf(gladys, family, cookerId, values, language) {
  const ids = deviceIds(gladys, family, cookerId);
  const out = [];
  const number = (role, value) => {
    if (value !== undefined && Number.isFinite(value)) {
      out.push([ids.feature(role), { state: value }]);
    }
  };
  number(FEATURES.TEMPERATURE, values.temperature);
  number(FEATURES.TARGET, values.target);
  number(FEATURES.TIMER_REMAINING, toMinutes(values.remaining));
  number(FEATURES.TIMER_TOTAL, toMinutes(values.total));
  out.push([
    ids.feature(FEATURES.STATE),
    { text: word(STATE_NAMES[values.state] ?? STATE_NAMES.unknown, language) },
  ]);
  if (values.alert !== undefined) {
    out.push([ids.feature(FEATURES.ALERT), { text: word(ALERT_NAMES[values.alert], language) }]);
  }
  return out;
}
