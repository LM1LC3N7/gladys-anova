// -----------------------------------------------------------------------------
// A fake Anova WebSocket server behind the socket factory: `ws`-like sockets
// (EventEmitter: open, message, close, error, pong, unexpected-response),
// answering as the Anova Developer documentation describes. Answers go
// through setImmediate (never the mocked timers): settle() delivers them.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AnovaApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { testClock } from '../kit/clock.mjs';

export const TOKEN = 'anova-eyJ0eXAiOiJKV1QiSECRETTOKEN123';
export const COOKER = 'cookerA1b2c3';
export const COOKER2 = 'cookerZ9y8x7';
export const OVEN = 'ovenQ5w6e7';

/** Lets the pending promises and the fake answers settle (no timer involved). */
export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export const apcList = (devices = [{ cookerId: COOKER, type: 'a4' }]) => ({
  command: 'EVENT_APC_WIFI_LIST',
  payload: devices.map((d) => ({
    cookerId: d.cookerId,
    name: d.name ?? 'Sous vide',
    pairedAt: '2026-01-01T10:00:00.000Z',
    type: d.type,
  })),
});

export const apoList = (devices = []) => ({
  command: 'EVENT_APO_WIFI_LIST',
  payload: devices.map((d) => ({
    cookerId: d.cookerId,
    name: d.name ?? 'Anova Precision Oven',
    pairedAt: '2026-01-01T10:00:00.000Z',
    type: d.type ?? 'oven_v2',
  })),
});

/** A cooker state in the `job` shape (anova-wifi example data). */
export function jobState(cookerId = COOKER, o = {}) {
  const cooking = o.cooking ?? false;
  return {
    command: 'EVENT_APC_STATE',
    payload: {
      cookerId,
      type: o.type ?? 'a4',
      state: {
        'boot-id': 'boot',
        job: {
          'cook-time-seconds': o.total ?? 3600,
          id: o.jobId ?? 'job-1',
          mode: o.mode ?? (cooking ? 'COOK' : 'IDLE'),
          'ota-url': '',
          'target-temperature': o.target ?? 60,
          'temperature-unit': o.unit ?? 'C',
        },
        'job-status': {
          'cook-time-remaining': o.remaining ?? 1800,
          state: o.jobState ?? (cooking ? 'COOKING' : ''),
        },
        'pin-info': {
          'device-safe': 1,
          'water-leak': 0,
          'water-level-critical': 0,
          'water-level-low': o.low ? 1 : 0,
          'water-temp-too-high': 0,
        },
        'temperature-info': {
          'heater-temperature': 22.5,
          'triac-temperature': 36.1,
          'water-temperature': o.water ?? 21.4,
        },
      },
    },
  };
}

export const ovenState = (cookerId = OVEN, o = {}) => ({
  command: 'EVENT_APO_STATE',
  payload: {
    cookerId,
    type: 'oven_v2',
    state: {
      nodes: {
        door: { closed: o.closed ?? true },
        temperatureBulbs: {
          mode: 'dry',
          dry: {
            current: { celsius: o.current ?? 24.36 },
            setpoint: { celsius: o.setpoint ?? 180 },
          },
        },
        timer: {
          current: o.timerCurrent ?? 0,
          initial: o.timerInitial ?? 0,
          mode: o.timerMode ?? 'idle',
        },
        waterTank: { empty: o.empty ?? false },
      },
      state: { mode: o.mode ?? 'idle', temperatureUnit: 'C' },
      updatedTimestamp: '2026-01-01T10:00:00Z',
    },
  },
});

class FakeSocket extends EventEmitter {
  constructor(server, url, options) {
    super();
    this.server = server;
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
  }

  later(fn) {
    setImmediate(() => {
      if (this.readyState !== 3) {
        fn();
      }
    });
  }

  send(text) {
    if (this.readyState !== 1) {
      throw new Error('WebSocket is not open');
    }
    const message = JSON.parse(text);
    this.sent.push(message);
    this.server.received.push(message);
    for (const answer of this.server.answer(message, this)) {
      this.later(() => this.deliver(answer));
    }
  }

  deliver(answer) {
    if (this.readyState === 1) {
      this.emit(
        'message',
        Buffer.from(typeof answer === 'string' ? answer : JSON.stringify(answer)),
      );
    }
  }

  ping() {
    this.server.pings += 1;
    if (this.server.answerPings) {
      this.later(() => this.emit('pong'));
    }
  }

  /** The server closes the connection. */
  drop(code = 1006) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    setImmediate(() => this.emit('close', code, Buffer.alloc(0)));
  }

  terminate() {
    if (this.readyState === 3) {
      return;
    }
    const connecting = this.readyState === 0;
    this.readyState = 3;
    setImmediate(() => {
      if (connecting) {
        this.emit('error', new Error('WebSocket was closed before the connection was established'));
      }
      this.emit('close', 1006, Buffer.alloc(0));
    });
  }

  close() {
    this.terminate();
  }
}

/**
 * The fake server. By default: lists one a4 cooker (no oven) and its idle
 * state on every connection, answers every command `{ status: 'ok' }`, a
 * stop is followed by an idle state, a start by a cooking state.
 */
export function fakeAnova({ cookers = [{ cookerId: COOKER, type: 'a4' }], ovens = [] } = {}) {
  const server = {
    token: TOKEN,
    cookers,
    ovens,
    /** cookerId -> the state message sent at connection (and after commands). */
    states: Object.fromEntries([
      ...cookers.map((c) => [c.cookerId, jobState(c.cookerId, { type: c.type })]),
      ...ovens.map((o) => [o.cookerId, ovenState(o.cookerId)]),
    ]),
    sockets: [],
    received: [],
    pings: 0,
    answerPings: true,
    /** Handshake refusals for the next sockets: [{ status, headers }]. */
    refusals: [],
    /** Next sockets that fail to connect (network). */
    unreachable: 0,
    /** All connections fail to connect while true. */
    down: false,
    /** Accepts the handshake, then closes at once without a message (Anova, invalid token). */
    closeSilently: false,
    /** No list sent on connection. */
    silentLists: false,
    /** Commands left unanswered. */
    silentCommands: new Set(),
    /** Command -> answer status (default 'ok'). */
    status: {},
    /** No state follows a command. */
    noStateAfterCommand: false,
    get open() {
      return this.sockets.filter((s) => s.readyState === 1);
    },
    get main() {
      return this.open.at(-1);
    },
    commands(name) {
      return this.received.filter((m) => m.command === name);
    },
    factory: (url, options) => {
      const socket = new FakeSocket(server, url, options);
      server.sockets.push(socket);
      const refusal = server.refusals.shift();
      setImmediate(() => {
        if (socket.readyState === 3) {
          return;
        }
        if (refusal) {
          const response = new EventEmitter();
          response.statusCode = refusal.status;
          response.headers = { ...refusal.headers };
          response.resume = () => {};
          socket.emit('unexpected-response', {}, response);
          return;
        }
        if (server.down || server.unreachable > 0) {
          server.unreachable = Math.max(0, server.unreachable - 1);
          socket.readyState = 3;
          socket.emit('error', new Error('getaddrinfo ENOTFOUND devices.anovaculinary.io'));
          socket.emit('close', 1006, Buffer.alloc(0));
          return;
        }
        const token = new URL(url).searchParams.get('token');
        if (token !== server.token) {
          const response = new EventEmitter();
          response.statusCode = 401;
          response.headers = {};
          response.resume = () => {};
          socket.emit('unexpected-response', {}, response);
          return;
        }
        socket.readyState = 1;
        socket.emit('open');
        if (server.closeSilently) {
          socket.drop(1005);
          return;
        }
        if (!server.silentLists) {
          socket.later(() => {
            socket.deliver(apcList(server.cookers));
            socket.deliver(apoList(server.ovens));
            for (const id of Object.keys(server.states)) {
              socket.deliver(server.states[id]);
            }
          });
        }
      });
      return socket;
    },
    answer(message) {
      const out = [];
      if (server.silentCommands.has(message.command)) {
        return out;
      }
      out.push({
        command: 'RESPONSE',
        requestId: message.requestId,
        payload: { status: server.status[message.command] ?? 'ok' },
      });
      if (server.noStateAfterCommand) {
        return out;
      }
      const p = message.payload ?? {};
      if (message.command === 'CMD_APC_STOP') {
        server.states[p.cookerId] = jobState(p.cookerId, { type: p.type });
        out.push(server.states[p.cookerId]);
      } else if (message.command === 'CMD_APO_STOP') {
        server.states[p.id] = ovenState(p.id);
        out.push(server.states[p.id]);
      } else if (message.command === 'CMD_APC_START') {
        server.states[p.cookerId] = jobState(p.cookerId, {
          type: p.type,
          cooking: true,
          jobState: 'PREHEATING',
          target: p.targetTemperature,
          total: p.timer,
          remaining: p.timer,
          jobId: message.requestId,
        });
        out.push(server.states[p.cookerId]);
      }
      return out;
    },
    /** A message pushed by the server on the main connection. */
    push(message) {
      server.main?.deliver(message);
    },
  };
  return server;
}

/** An in-memory /data: load() as fileStore, save() can be made to fail. */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    unreadable: false,
    failSaves: false,
    async load() {
      if (this.unreadable) {
        return { status: 'unreadable' };
      }
      return this.data === null
        ? { status: 'missing' }
        : { status: 'ok', data: structuredClone(this.data) };
    },
    async save(data) {
      if (this.failSaves) {
        const err = new Error('EROFS');
        err.code = 'EROFS';
        throw err;
      }
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

export function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

/**
 * A whole setup: fake Gladys + fake Anova + virtual clock + app, wired as
 * the container (src/handlers.js). `await setup.start()` connects Gladys.
 */
export function createSetup({
  config = { token: TOKEN },
  server = fakeAnova(),
  store = memoryStore(),
  clock = testClock(),
  random = () => 0.5,
  devices = [],
} = {}) {
  const gladys = createFakeGladys({ config: { ...config }, devices });
  const logger = memoryLogger();
  let n = 0;
  const app = new AnovaApp({
    gladys,
    logger,
    socketFactory: server.factory,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    random,
    uuid: () => `req-${(n += 1)}`,
  });
  registerHandlers(gladys, app, logger);
  const setup = {
    gladys,
    server,
    store,
    clock,
    app,
    logger,
    async start() {
      await gladys.connect();
      await settle();
    },
    /** Advances the virtual clock, letting the fake answers come. */
    async advance(ms) {
      await clock.advance(ms);
      await settle();
    },
    status: () => gladys.fake.connectionStatus,
    ext: (suffix) => gladys.externalId(suffix),
    async stopAll() {
      await app.stop();
      await settle();
    },
  };
  return setup;
}
