// -----------------------------------------------------------------------------
// Anova constants, manifest keys, limits and timings.
//
// The endpoint, the query parameters, the commands and the device types are
// those of the official Anova Developer documentation
// (https://developer.anovaculinary.com/docs/devices/wifi-devices). The state
// messages of the Precision Cookers are not in that documentation: their
// fields come from anova-wifi (MIT, https://github.com/Lash-L/anova_wifi), the
// library of the Anova integration of Home Assistant (THIRD_PARTY_NOTICES.md).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The WebSocket endpoint of the Anova Developer API. */
export const BASE_URL = 'wss://devices.anovaculinary.io';

/** Both device families are asked for: Precision Cookers (APC) and Precision Ovens (APO). */
export const ACCESSORIES = 'APC,APO';

/**
 * The connection URL. The documentation puts the personal access token in
 * the query string (there is no other way): this URL is a secret, never
 * logged, never shown, never kept in /data.
 */
export const connectionUrl = (token) =>
  `${BASE_URL}/?token=${encodeURIComponent(token)}&supportedAccessories=${ACCESSORIES}`;

/** The version of this integration, from package.json (copied in the image). */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** An honest User-Agent on the WebSocket handshake. */
export const USER_AGENT = `gladys-anova/${VERSION} (+https://github.com/LM1LC3N7/gladys-anova)`;

export const FAMILIES = { COOKER: 'APC', OVEN: 'APO' };

/** The device types of the documentation, by family. */
export const DEVICE_TYPES = {
  APC: ['a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'pro'],
  APO: ['oven_v1', 'oven_v2'],
};

export const COMMANDS = {
  APC_START: 'CMD_APC_START',
  APC_STOP: 'CMD_APC_STOP',
  APO_STOP: 'CMD_APO_STOP',
};

export const EVENTS = {
  APC_LIST: 'EVENT_APC_WIFI_LIST',
  APO_LIST: 'EVENT_APO_WIFI_LIST',
  APC_STATE: 'EVENT_APC_STATE',
  APO_STATE: 'EVENT_APO_STATE',
  RESPONSE: 'RESPONSE',
};

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  TEMPERATURE: 'temperature',
  TARGET: 'target-temperature',
  TIMER_REMAINING: 'timer-remaining',
  TIMER_TOTAL: 'timer-total',
  STATE: 'state',
  ALERT: 'alert',
  STOP: 'stop',
};

/** The device kinds of the external ids (`ext:<selector>:<kind>:<cookerId>`): frozen. */
export const KINDS = { APC: 'cooker', APO: 'oven' };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

export const SCENE_ACTIONS = {
  START_COOK: 'start_cook',
  STOP_COOK: 'stop_cook',
};

/**
 * What a start may ask, checked by the module whatever the scene sends.
 * 25 to 92 °C: the range every documented Precision Cooker accepts (the
 * oven documentation gives 25 °C as its wet-bulb minimum); 1 min to 99 h 59.
 */
export const START_LIMITS = {
  minTemperature: 25,
  maxTemperature: 92,
  minMinutes: 1,
  maxMinutes: 99 * 60 + 59,
};

export const LIMITS = {
  /** Gladys: 300 states per minute. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Largest message accepted from Anova (an oven state is a few KB). */
  messageBytes: 256 * 1024,
  /** Devices read from one list. */
  devices: 20,
  /** Longest text kept from a message (names). */
  textLength: 60,
  /** Longest personal access token accepted from the configuration. */
  tokenLength: 4096,
  /** Pending answers to our own commands. */
  pending: 20,
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** WebSocket handshake. */
  handshakeTimeout: 15 * SECOND,
  /** The device lists after the open: none, the connection is cut (a failed attempt). */
  listTimeout: 30 * SECOND,
  /** A WebSocket ping every 30 s; no pong before the next one: the connection is cut. */
  pingInterval: 30 * SECOND,
  /** Open this long with a message or a pong: the backoff is forgotten. */
  stableAfter: 3 * MINUTE,
  /** Reconnection: 5 s .. 30 min, with jitter (half to the whole). */
  backoff: [
    5 * SECOND,
    15 * SECOND,
    30 * SECOND,
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    30 * MINUTE,
  ],
  /** A 429 at the handshake: its Retry-After bounded to 1 min .. 6 h, 15 min without. */
  tooManyMin: MINUTE,
  tooManyMax: 6 * HOUR,
  tooManyDefault: 15 * MINUTE,
  /**
   * Anova pushes a state when it changes: silent this long, the connection is
   * opened again for fresh states (Anova closes an idle one after 30 min).
   */
  silenceRefresh: 25 * MINUTE,
  /** A start decides on a state of the open connection at most this old. */
  freshState: 30 * MINUTE,
  /** A close without a message within this time of the open may be a refused token (1005 only). */
  silentCloseWindow: 5 * SECOND,
  /** Longest wait for the attempt and /data at shutdown. */
  shutdownWait: 2 * SECOND,
  /** Longest wait for a write to /data on the way of an attempt. */
  dataWriteWait: 500,
  /** A stop proves the connection alive (answer, message or pong) within this time, else reconnects. */
  stopProof: 1_500,
  /** At most this many dead connections found by one stop, then the backoff. */
  stopProbes: 3,
  /** A kept stop with a known cook waits this long for the first state of a new connection. */
  stopFirstState: 2 * SECOND,
  /** A start must leave within this time of the scene reaching it (Gladys waits 45 s). */
  startSendBy: 10 * SECOND,
  /** A normal close (1000), then the socket is cut. */
  closeGrace: 2 * SECOND,
  /** The answer (RESPONSE) to a start. */
  startResponse: 10 * SECOND,
  /** A start confirmed by a state showing the cook, within this time. */
  startConfirm: 20 * SECOND,
  /** A stop: connection and answer within this budget (Gladys waits 5 s). */
  stopBudget: 3_500,
  /** A stop still contradicted by a state this long after its answer is sent again. */
  stopRecheck: 20 * SECOND,
  /** A stop is sent at most this many times. */
  stopSends: 3,
  /** A stop not sent (no connection) is kept this long, /data included. */
  stopKeep: 10 * MINUTE,
  /** Without any cook identity, a stop is sent again only within this time of the first. */
  stopWindow: 2 * MINUTE,
  /** The "Test the connection" button acts at most this often, and waits this long. */
  testCooldown: 30 * SECOND,
  testWait: 40 * SECOND,
  /** /data unreadable, or the configuration not read: tried again on this timer. */
  dataRetry: 10 * SECOND,
  configRetry: [5 * SECOND, 10 * SECOND, 30 * SECOND, MINUTE],
  /** Longest a persisted pause may still hold at a restart. */
  persistedMax: 25 * HOUR,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** A state older than this is never published again (deviceCreated, Gladys reconnection). */
  stateMaxAge: 2 * HOUR,
  /** Older than this, a state published again carries its date. */
  stateDated: MINUTE,
  /** The same warning is logged at most once in this window. */
  logWindow: 10 * MINUTE,
};
