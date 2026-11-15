// -----------------------------------------------------------------------------
// The messages of the Anova WebSocket API (pure).
//
// Lists, commands and answers: the official documentation. The state of a
// Precision Cooker comes in three shapes, read as anova-wifi (MIT, Lash-L,
// see THIRD_PARTY_NOTICES.md) reads them: a `job` object (A4/A5 and most
// cookers), the flat A3 object, and the `nodes` object of the A6/A7 (also
// read here for any other type that sends it). The state of a Precision Oven
// is read from its `nodes` (temperature bulbs, timer, door, water tank) and
// `state.mode`; never verified with a real oven (docs).
//
// Every value is checked: a missing, non-numeric or out-of-range value is
// unknown (undefined), never 0; a text is never a measure.
// -----------------------------------------------------------------------------

import { COMMANDS, DEVICE_TYPES, EVENTS, FAMILIES, LIMITS } from './constants.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Own property only (never the prototype). */
const own = (object, key) =>
  isObject(object) && Object.hasOwn(object, key) ? object[key] : undefined;

/** A path of own properties. */
const at = (object, ...keys) => keys.reduce((node, key) => own(node, key), object);

const DECIMAL = /^-?\d{1,6}(\.\d{1,6})?$/;

/** A strict number within [min, max]: a number, or a decimal string; '' / null / text: undefined. */
export function numberIn(value, min, max) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && DECIMAL.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return undefined;
  }
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** A strict boolean: true/false (or 1/0 as the job shape sends its pins), else undefined. */
const bool = (value) => {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0) {
    return false;
  }
  return undefined;
};

/** Fahrenheit -> Celsius, rounded to 0.01. */
const toCelsius = (f) => Math.round(((f - 32) * 5 * 100) / 9) / 100;

const round1 = (n) => (n === undefined ? undefined : Math.round(n * 10) / 10);

/** A short printable text from Anova (a name), else undefined. */
export function shortText(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Control characters dropped, bounded.
  // eslint-disable-next-line no-control-regex
  const text = [...value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()]
    .slice(0, LIMITS.textLength)
    .join('');
  return text === '' ? undefined : text;
}

/** A cooker id: letters, digits, `-` and `_` (no `.`, no `:`), bounded. */
const COOKER_ID = /^[A-Za-z0-9_-]{4,64}$/;
export const isCookerId = (value) => typeof value === 'string' && COOKER_ID.test(value);

/** A device type: lower case letters, digits and `_`, bounded. */
const TYPE = /^[a-z0-9_]{1,16}$/;
export const isDeviceType = (value) => typeof value === 'string' && TYPE.test(value);

/** One message (a Buffer or a string) -> { command, requestId, payload }, else undefined. */
export function parseMessage(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data ?? '');
  if (text.length === 0 || text.length > LIMITS.messageBytes) {
    return undefined;
  }
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return undefined;
  }
  const command = own(message, 'command');
  if (typeof command !== 'string' || command.length > 64) {
    return undefined;
  }
  const requestId = own(message, 'requestId');
  return {
    command,
    requestId: typeof requestId === 'string' && requestId.length <= 64 ? requestId : undefined,
    payload: own(message, 'payload'),
  };
}

/**
 * A device list (EVENT_APC_WIFI_LIST, EVENT_APO_WIFI_LIST) -> its family and
 * devices [{ cookerId, family, type, name }]; entries without a valid id are
 * dropped, the list is bounded.
 */
export function parseList(message) {
  const family =
    message.command === EVENTS.APC_LIST
      ? FAMILIES.COOKER
      : message.command === EVENTS.APO_LIST
        ? FAMILIES.OVEN
        : undefined;
  if (!family || !Array.isArray(message.payload)) {
    return undefined;
  }
  const devices = [];
  const seen = new Set();
  for (const entry of message.payload.slice(0, LIMITS.devices * 2)) {
    const cookerId = own(entry, 'cookerId');
    if (!isCookerId(cookerId) || seen.has(cookerId) || devices.length >= LIMITS.devices) {
      continue;
    }
    seen.add(cookerId);
    const type = own(entry, 'type');
    devices.push({
      cookerId,
      family,
      type: isDeviceType(type) ? type : undefined,
      name: shortText(own(entry, 'name')),
    });
  }
  return { family, devices };
}

/** A RESPONSE -> { requestId, ok, status } (status: a short code, never shown raw). */
export function parseResponse(message) {
  if (message.command !== EVENTS.RESPONSE || !message.requestId) {
    return undefined;
  }
  const status = own(message.payload, 'status');
  return {
    requestId: message.requestId,
    ok: status === 'ok',
    status: typeof status === 'string' && /^[A-Za-z0-9_ -]{1,32}$/.test(status) ? status : 'error',
  };
}

/** The states of a cooker or an oven, as this integration names them. */
export const STATES = [
  'idle',
  'preheating',
  'cooking',
  'maintaining',
  'low_water',
  'high_temperature',
  'failure',
  'busy',
  'unknown',
];

/** The alerts, by priority (the first true one is shown). */
export const ALERTS = [
  'water_leak',
  'water_critical',
  'water_temperature_high',
  'water_low',
  'water_tank_empty',
  'door_open',
];

/** The alert of a set of flags: the first true one, 'none' when every flag is known false. */
function alertOf(flags) {
  for (const key of ALERTS) {
    if (flags[key] === true) {
      return key;
    }
  }
  const known = Object.values(flags);
  return known.length > 0 && known.every((v) => v === false) ? 'none' : undefined;
}

const JOB_MODES = {
  IDLE: 'idle',
  'LOW WATER': 'low_water',
  'HIGH TEMP': 'high_temperature',
  'DEVICE FAILURE': 'failure',
  STARTUP: 'busy',
  OTA: 'busy',
  PROVISIONING: 'busy',
};

const JOB_STATES = {
  PREHEATING: 'preheating',
  COOKING: 'cooking',
  'SET TIMER': 'cooking',
  MAINTAINING: 'maintaining',
  'TIMER EXPIRED': 'maintaining',
};

/** The `job` shape (anova-wifi build_wifi_cooker_state_body / to_apc_update). */
function jobState(state) {
  const job = own(state, 'job');
  const status = own(state, 'job-status');
  const mode = own(job, 'mode');
  const jobStatus = own(status, 'state');
  let name;
  let cooking;
  if (mode === 'COOK') {
    cooking = true;
    name = JOB_STATES[jobStatus] ?? 'cooking';
  } else if (typeof mode === 'string' && Object.hasOwn(JOB_MODES, mode)) {
    name = JOB_MODES[mode];
    cooking = false;
  }
  const unit = own(job, 'temperature-unit');
  let target = numberIn(own(job, 'target-temperature'), -50, 250);
  if (target !== undefined && unit === 'F') {
    target = toCelsius(target);
  } else if (unit !== 'C') {
    target = undefined; // unit unknown: never guessed
  }
  const total = numberIn(own(job, 'cook-time-seconds'), 0, 360_000);
  const remaining = numberIn(own(status, 'cook-time-remaining'), 0, 360_000);
  const pins = own(state, 'pin-info');
  const flags = {};
  for (const [key, field] of [
    ['water_leak', 'water-leak'],
    ['water_critical', 'water-level-critical'],
    ['water_temperature_high', 'water-temp-too-high'],
    ['water_low', 'water-level-low'],
  ]) {
    const value = bool(own(pins, field));
    if (value !== undefined) {
      flags[key] = value;
    }
  }
  const timerDone = jobStatus === 'MAINTAINING' || jobStatus === 'TIMER EXPIRED';
  const jobId = own(job, 'id');
  return {
    state: name ?? 'unknown',
    cooking,
    timerDone: cooking === true && timerDone,
    temperature: numberIn(at(state, 'temperature-info', 'water-temperature'), -10, 110),
    target: numberIn(target, 0, 100),
    total,
    // Past the timer the device counts up: the remaining time is 0 (anova-wifi).
    remaining: cooking === true && timerDone ? 0 : cooking === false ? undefined : remaining,
    alert: alertOf(flags),
    cookKey: typeof jobId === 'string' && jobId.length <= 64 ? jobId : undefined,
  };
}

const A3_STAGES = {
  heating: 'preheating',
  cooking: 'cooking',
  keeping_warm: 'maintaining',
};

/** The flat A3 shape (anova-wifi build_a3_payload). */
function a3State(state) {
  const cooking = bool(own(state, 'isCooking'));
  const stage = at(state, 'currentJob', 'jobStage');
  const unit = own(state, 'unit');
  // Without a unit, read as °C like anova-wifi; an unknown unit is never guessed.
  const convert = (value) => {
    const n = numberIn(value, -50, 250);
    if (n === undefined) {
      return undefined;
    }
    if (unit === undefined || unit === 'C' || unit === 'c') {
      return n;
    }
    return unit === 'F' || unit === 'f' ? toCelsius(n) : undefined;
  };
  const name =
    cooking === true ? (A3_STAGES[stage] ?? 'cooking') : cooking === false ? 'idle' : 'unknown';
  const jobId = own(state, 'currentJobID');
  return {
    state: name,
    cooking,
    timerDone: cooking === true && stage === 'keeping_warm',
    temperature: numberIn(convert(own(state, 'currentTemperature')), -10, 110),
    target: numberIn(convert(own(state, 'targetTemperature')), 0, 100),
    total: undefined,
    remaining: cooking === true ? numberIn(own(state, 'timerInSeconds'), 0, 360_000) : undefined,
    alert: undefined,
    cookKey: typeof jobId === 'string' && jobId.length <= 64 ? jobId : undefined,
  };
}

/** An ISO date of Anova -> epoch ms, else undefined. */
function isoTime(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return undefined;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

/** The `nodes` shape of the A6/A7 (anova-wifi build_a6_a7_payload). */
function nodesState(state) {
  const nodes = own(state, 'nodes');
  const mode = at(state, 'state', 'mode');
  const timer = own(nodes, 'timer');
  const timerMode = own(timer, 'mode');
  const stageMode = at(state, 'cook', 'activeStageMode');
  const total = numberIn(own(timer, 'initial'), 0, 360_000);
  let name = 'unknown';
  let cooking;
  let remaining;
  let timerDone = false;
  if (mode === 'cook') {
    cooking = true;
    if (timerMode === 'completed') {
      name = 'maintaining';
      timerDone = true;
      remaining = 0;
    } else if (stageMode === 'entering') {
      name = 'preheating';
      remaining = total;
    } else if (timerMode === 'running') {
      name = 'cooking';
      // Both dates are Anova's: no local clock in this difference.
      const started = isoTime(own(timer, 'startedAtTimestamp'));
      const updated = isoTime(own(state, 'updatedTimestamp'));
      remaining =
        total !== undefined && started !== undefined && updated !== undefined
          ? Math.max(0, total - Math.round((updated - started) / 1000))
          : undefined;
    } else {
      name = 'maintaining';
      remaining = total;
    }
  } else if (mode === 'idle') {
    name = 'idle';
    cooking = false;
  }
  const flags = {};
  const low = bool(at(nodes, 'lowWater', 'warning'));
  const empty = bool(at(nodes, 'lowWater', 'empty'));
  if (low !== undefined) {
    flags.water_low = low;
  }
  if (empty !== undefined) {
    flags.water_critical = empty;
  }
  const cookId = at(state, 'cook', 'cookId');
  const startedKey = own(timer, 'startedAtTimestamp');
  return {
    state: name,
    cooking,
    timerDone,
    temperature: numberIn(at(nodes, 'waterTemperatureSensor', 'current', 'celsius'), -10, 110),
    target: numberIn(at(nodes, 'waterTemperatureSensor', 'setpoint', 'celsius'), 0, 100),
    total,
    remaining,
    alert: alertOf(flags),
    cookKey:
      typeof cookId === 'string' && cookId.length <= 64
        ? cookId
        : typeof startedKey === 'string' && startedKey.length <= 40
          ? `t:${startedKey}`
          : undefined,
  };
}

/** The state of an oven (EVENT_APO_STATE). */
function ovenState(state) {
  const nodes = own(state, 'nodes');
  const mode = at(state, 'state', 'mode');
  const bulbMode = at(nodes, 'temperatureBulbs', 'mode');
  const bulb = bulbMode === 'dry' || bulbMode === 'wet' ? bulbMode : undefined;
  const cooking = mode === 'idle' ? false : typeof mode === 'string' ? true : undefined;
  const timerMode = at(nodes, 'timer', 'mode');
  const flags = {};
  const empty = bool(at(nodes, 'waterTank', 'empty'));
  const closed = bool(at(nodes, 'door', 'closed'));
  if (empty !== undefined) {
    flags.water_tank_empty = empty;
  }
  if (closed !== undefined) {
    flags.door_open = !closed;
  }
  return {
    state: cooking === false ? 'idle' : cooking === true ? 'cooking' : 'unknown',
    cooking,
    timerDone: false,
    temperature: bulb
      ? numberIn(at(nodes, 'temperatureBulbs', bulb, 'current', 'celsius'), -10, 300)
      : undefined,
    target:
      bulb && cooking === true
        ? numberIn(at(nodes, 'temperatureBulbs', bulb, 'setpoint', 'celsius'), 0, 300)
        : undefined,
    total: cooking === true ? numberIn(at(nodes, 'timer', 'initial'), 0, 360_000) : undefined,
    remaining:
      cooking === true && timerMode === 'running'
        ? numberIn(at(nodes, 'timer', 'current'), 0, 360_000)
        : undefined,
    alert: alertOf(flags),
    cookKey: undefined,
  };
}

/**
 * A state message -> { cookerId, family, values } where values holds
 * state, cooking (true/false/undefined), timerDone, temperature and target
 * (°C), total and remaining (seconds), alert and cookKey (the identity of
 * the cook, when Anova gives one). Undefined when not a usable state.
 */
export function parseState(message) {
  const family =
    message.command === EVENTS.APC_STATE
      ? FAMILIES.COOKER
      : message.command === EVENTS.APO_STATE
        ? FAMILIES.OVEN
        : undefined;
  const cookerId = own(message.payload, 'cookerId');
  const state = own(message.payload, 'state');
  if (!family || !isCookerId(cookerId) || !isObject(state)) {
    return undefined;
  }
  const type = own(message.payload, 'type');
  let values;
  if (family === FAMILIES.OVEN) {
    values = ovenState(state);
  } else if (isObject(own(state, 'job'))) {
    values = jobState(state);
  } else if (type === 'a3') {
    values = a3State(state);
  } else if (isObject(own(state, 'nodes'))) {
    values = nodesState(state);
  } else {
    return undefined;
  }
  if (values.cooking === false) {
    values.remaining = 0; // no cook: nothing remains
  }
  values.temperature = round1(values.temperature);
  values.target = round1(values.target);
  return { cookerId, family, type: isDeviceType(type) ? type : undefined, values };
}

/** Is this a documented type of the family (a stop needs the type of a cooker)? */
export const knownType = (family, type) => DEVICE_TYPES[family]?.includes(type) ?? false;

/** The stop of a cooker or an oven (documented payloads). */
export function stopCommand({ cookerId, family, type }) {
  if (family === FAMILIES.OVEN) {
    return {
      command: COMMANDS.APO_STOP,
      payload: { id: cookerId, type: COMMANDS.APO_STOP },
    };
  }
  return { command: COMMANDS.APC_STOP, payload: { cookerId, type } };
}

/** The start of a cooker (documented payload): temperature in °C, timer in seconds. */
export function startCommand({ cookerId, type }, { temperature, minutes }) {
  return {
    command: COMMANDS.APC_START,
    payload: { cookerId, type, targetTemperature: temperature, unit: 'C', timer: minutes * 60 },
  };
}
