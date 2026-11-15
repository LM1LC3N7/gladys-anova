// -----------------------------------------------------------------------------
// The Anova integration: one WebSocket connection per personal access token
// (src/channel.js), the device lists and states pushed by Anova, the stop
// (never blocked) and the start (off by default, scene action only).
//
// Clocks: every decision (pauses, backoff, freshness, budgets) reads the
// monotonic clock (`monotonic`); the wall clock (`now`) only dates what goes
// to /data and the `created_at` of an old state.
//
// The stop, a protective command, never waits for an option, a pause, the
// backoff, a refused token, /data or the configuration being read again: it
// leaves on the open connection, or opens one at once (one attempt within its
// 3.5 s budget), and is kept (memory and /data, 10 min, 3 sends at most)
// until a state of the device shows it idle. It cancels a start not yet sent.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Channel, ChannelError, defaultSocketFactory } from './channel.js';
import { normalizeConfig, refusedMark } from './config.js';
import {
  EVENTS,
  FAMILIES,
  FEATURES,
  LIMITS,
  START_LIMITS,
  TIMINGS,
  connectionUrl,
} from './constants.js';
import { buildDevice, parseExternalId, statesOf } from './devices.js';
import { ERRORS, T, age, word } from './i18n.js';
import {
  isDeviceType,
  numberIn,
  parseList,
  parseResponse,
  parseState,
  startCommand,
  stopCommand,
} from './protocol.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory } from './store.js';

/** An error whose message is shown to the user, in the configured language. */
const userError = (texts, language) => new Error(word(texts, language));

const STATE_EVENTS = new Set([EVENTS.APC_STATE, EVENTS.APO_STATE]);
const LIST_EVENTS = new Set([EVENTS.APC_LIST, EVENTS.APO_LIST]);

/** A strict number from a scene field (a number or a decimal string). */
const fieldNumber = (value) => numberIn(value, -1e6, 1e6);

export class AnovaApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'anova' }),
    socketFactory = defaultSocketFactory,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    random = Math.random,
    uuid = randomUUID,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.socketFactory = socketFactory;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    this.uuid = uuid;
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.memory = emptyMemory();
    /** 'loading' | 'ok' | 'unreadable': nothing is written to /data unless 'ok'. */
    this.memoryState = 'loading';
    this.generation = 0;
    this.started = false;
    this.stopped = false;
    this.channel = undefined;
    this.connecting = undefined;
    this.linking = undefined;
    /** Number of connections opened: a state belongs to one. */
    this.connId = 0;
    this.openedAt = 0;
    this.stable = false;
    this.listed = false;
    this.lastDeviceMessageAt = 0;
    /** cookerId -> { cookerId, family, type, name } (a Map: no prototype). */
    this.devices = new Map();
    /** cookerId -> { values, at (monotonic), wall, conn } */
    this.states = new Map();
    /** requestId -> resolve({ ok, status } | null) */
    this.pending = new Map();
    /** cookerId -> stop record (see stopDevice). */
    this.stops = new Map();
    /** cookerId -> number of stops pressed (never reset: a count taken before a stop never matches again). */
    this.stopCount = new Map();
    /** Cookers with a start in progress. */
    this.starting = new Set();
    /** cookerId -> when the last start left (monotonic). */
    this.startSent = new Map();
    /** Waiters of a state: { cookerId, match, resolve }. */
    this.watchers = new Set();
    /** Waiters of a connection step (waitFor). */
    this.stepWaiters = new Set();
    /** Cooks already stopped at the end of their timer (stop_at_timer_end). */
    this.timerStopped = new Set();
    this.pauseUntil = 0;
    this.blocked = false;
    this.timer = undefined;
    this.pingTimer = undefined;
    this.listTimer = undefined;
    this.dataTimer = undefined;
    this.configTimer = undefined;
    this.configFailures = 0;
    /** Connections closed by Anova right after the open, without any message, in a row. */
    this.silentCloses = 0;
    this.lastStatus = undefined;
    this.published = undefined;
    this.lastTestAt = -Infinity;
    this.logged = new Map();
  }

  get language() {
    return this.config.language;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connected to Gladys (first time or again). The configuration is read
   * here; when Gladys cannot give it, it is asked again on a timer, without
   * end. A reconnection keeps the pauses, the refusal and the connection to
   * Anova, and sends again what Gladys keeps in memory only.
   */
  async connected() {
    const raw = await this.readConfig();
    if (raw === undefined || this.stopped) {
      return;
    }
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (await this.configUpdated(raw)) {
      return;
    }
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    this.published = undefined;
    await this.publishDevices();
    this.queueAllStates();
    await this.flush();
  }

  async readConfig() {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    try {
      const raw = await this.gladys.getConfig();
      this.configFailures = 0;
      return raw ?? {};
    } catch (err) {
      const delays = TIMINGS.configRetry;
      const wait = delays[Math.min(this.configFailures, delays.length - 1)];
      this.configFailures += 1;
      this.logger.warn(`Reading the configuration failed (${err?.status ?? 'error'}): new try`);
      if (!this.started) {
        await this.setStatus(false, T.configUnreadable);
      }
      if (!this.stopped) {
        this.configTimer = this.timers.setTimeout(() => {
          this.configTimer = undefined;
          this.connected().catch((e) => this.logger.error(`Start failed: ${e?.message}`));
        }, wait);
      }
      return undefined;
    }
  }

  async start(raw = {}, { clearBlock = false } = {}) {
    this.halt();
    await this.linking?.catch(() => {});
    this.config = normalizeConfig(raw);
    this.devices = new Map();
    this.states = new Map();
    this.published = undefined;
    this.blocked = false;
    this.publisher.start();
    if (this.memoryState !== 'ok') {
      await this.loadMemory();
    }
    if (this.memoryState !== 'ok') {
      await this.setStatus(false, T.dataUnreadable);
      this.scheduleDataRetry();
      return;
    }
    if (clearBlock && this.memory.block) {
      this.memory.block = null;
      await this.saveMemory();
    }
    await this.resume();
  }

  /** Reads /data once: 'ok' (missing = empty), or 'unreadable' (nothing written then). */
  async loadMemory() {
    const result = await this.store.load().catch(() => ({ status: 'unreadable' }));
    if (result.status === 'unreadable') {
      this.memoryState = 'unreadable';
      return;
    }
    const wall = this.now();
    this.memory = normalizeMemory(result.data ?? null, wall);
    this.memoryState = 'ok';
    const mono = this.monotonic();
    if (this.memory.pause) {
      this.pauseUntil = Math.max(this.pauseUntil, mono + (this.memory.pause.until - wall));
    }
    // The last start: no other start before a state received after it.
    if (this.memory.start && !this.startSent.has(this.memory.start.cookerId)) {
      this.startSent.set(this.memory.start.cookerId, mono - (wall - this.memory.start.at));
    }
    // Stops kept in /data: sent at the next connection (the token is in the configuration only).
    for (const s of this.memory.stops) {
      if (!this.stops.has(s.cookerId)) {
        this.stops.set(s.cookerId, {
          cookerId: s.cookerId,
          family: s.family,
          type: s.type,
          firstAt: mono - (wall - s.at),
          wallAt: s.at,
          sends: s.sends,
          probes: 0,
          sentAt: undefined,
          acked: s.acked,
          cookKey: s.cookKey,
          recheck: undefined,
          awaitFirst: undefined,
        });
      }
    }
  }

  /** /data unreadable: read again every 10 s, one read at a time. */
  scheduleDataRetry() {
    if (this.dataTimer || this.stopped) {
      return;
    }
    const generation = this.generation;
    this.dataTimer = this.timers.setTimeout(async () => {
      this.dataTimer = undefined;
      if (generation !== this.generation || this.memoryState === 'ok') {
        return;
      }
      await this.loadMemory();
      if (generation !== this.generation) {
        return;
      }
      if (this.memoryState === 'ok') {
        await this.resume();
      } else {
        this.scheduleDataRetry();
      }
    }, TIMINGS.dataRetry);
  }

  /** What to do with a readable memory: wait (refusal, pause, backoff) or connect. */
  async resume() {
    const generation = this.generation;
    if (this.stopped) {
      return;
    }
    if (!this.config.token) {
      await this.setStatus(false, this.config.tokenInvalid ? T.tokenInvalid : T.noToken);
      return;
    }
    const block = this.memory.block;
    if (block && block.mark === refusedMark(this.config.token)) {
      this.blocked = true;
      await this.setStatus(false, T.refused);
      // A kept stop still has its one attempt (the stop is never refused).
      if (this.stops.size > 0) {
        this.connect({ force: true });
      }
      return;
    }
    if (block) {
      this.memory.block = null;
      await this.saveMemory();
    }
    if (generation !== this.generation) {
      return;
    }
    if (this.stops.size > 0) {
      // A stop waits: no backoff, no pause.
      await this.setStatus(false, T.connecting);
      this.connect({ force: true });
      return;
    }
    const mono = this.monotonic();
    if (mono < this.pauseUntil) {
      await this.setStatus(false, T.tooMany(age(this.pauseUntil - mono)));
      this.schedule(this.pauseUntil - mono);
      return;
    }
    // Never faster than the backoff after a restart: the time of the last
    // attempt is written to /data before each attempt.
    const { level, lastAttemptAt } = this.memory.backoff;
    const gap = level === 0 ? TIMINGS.backoff[0] : TIMINGS.backoff[level - 1] / 2;
    const wait = Math.min(Math.max(0, lastAttemptAt + gap - this.now()), TIMINGS.backoff.at(-1));
    await this.setStatus(false, T.connecting);
    if (wait > 0) {
      this.schedule(wait);
    } else {
      this.connect();
    }
  }

  /** Stops every timer and the connection (a new generation: late answers are muted). */
  halt() {
    this.generation += 1;
    for (const name of ['timer', 'listTimer', 'dataTimer']) {
      if (this[name]) {
        this.timers.clearTimeout(this[name]);
        this[name] = undefined;
      }
    }
    this.stopPing();
    this.connecting?.close();
    this.connecting = undefined;
    if (this.channel) {
      this.channel.close();
      this.channel = undefined;
    }
    this.listed = false;
    this.endPending();
    for (const record of this.stops.values()) {
      this.clearRecheck(record);
    }
    for (const watcher of this.watchers) {
      watcher.resolve(false);
    }
    this.watchers.clear();
    this.publisher.stop();
    this.step();
  }

  /** The container stops: everything is closed, /data written. */
  async stop() {
    this.stopped = true;
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    this.halt();
    // Bounded: a hung attempt or a slow /data never holds the shutdown.
    await this.bounded(this.linking?.catch(() => {}) ?? Promise.resolve(), TIMINGS.shutdownWait);
    if (this.memoryState === 'ok') {
      await this.bounded(this.saveMemory(), TIMINGS.shutdownWait);
    }
  }

  /** A new token restarts (and lifts a refusal); a new language renames. Returns true on a restart. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const previous = this.config;
    if (next.token !== previous.token || next.tokenInvalid !== previous.tokenInvalid) {
      await this.start(raw, { clearBlock: true });
      return true;
    }
    this.config = next;
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishDevices();
      this.queueAllStates();
      await this.flush();
    }
    return false;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err?.message}`));
  }

  /** The message of the last status (multi-language), or undefined. */
  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  /** Writes /data (never while it is unreadable); false when it failed. */
  async saveMemory() {
    if (this.memoryState !== 'ok') {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.warnLimited('save', `Saving the state to /data failed (${err?.code ?? 'error'})`);
      return false;
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err?.message}`));
  }

  /** A warning logged at most once per window for its key (never flooding the logs). */
  warnLimited(key, text) {
    const mono = this.monotonic();
    if (mono - (this.logged.get(key) ?? -Infinity) < TIMINGS.logWindow) {
      return;
    }
    this.logged.set(key, mono);
    this.logger.warn(text);
  }

  // --- Connection ------------------------------------------------------------

  /** The next connection attempt, in `wait` ms. */
  schedule(wait) {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.run();
        }
      },
      Math.max(0, wait),
    );
  }

  /** A timer fired: the end of a pause or of the backoff. */
  run() {
    if (!this.config.token || this.memoryState !== 'ok' || this.blocked) {
      return;
    }
    const mono = this.monotonic();
    // A stop waiting goes through a pause (protective), never the others.
    const stopWaiting = this.stops.size > 0;
    if (mono < this.pauseUntil && !stopWaiting) {
      this.schedule(this.pauseUntil - mono);
      return;
    }
    this.connect({ force: stopWaiting });
  }

  /**
   * One attempt at a time. `force` (a stop, the test button) does not wait
   * for the backoff, a pause or a refused token: one attempt, now.
   */
  connect({ force = false } = {}) {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.linking) {
      return this.linking;
    }
    if (this.channel || !this.config.token) {
      return Promise.resolve();
    }
    if (!force && (this.blocked || this.monotonic() < this.pauseUntil)) {
      return Promise.resolve();
    }
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const generation = this.generation;
    this.linking = this.link(generation).finally(() => {
      this.linking = undefined;
      this.step();
    });
    return this.linking;
  }

  async link(generation) {
    // The time of the attempt goes to /data first: a restart never comes faster.
    // Bounded: a slow /data never holds an attempt (a stop) more than 500 ms.
    this.memory.backoff.lastAttemptAt = this.now();
    await this.bounded(this.saveMemory(), TIMINGS.dataWriteWait);
    if (generation !== this.generation) {
      return;
    }
    const channel = new Channel({
      url: connectionUrl(this.config.token),
      factory: this.socketFactory,
      timers: this.timers,
      now: this.now,
      onMessage: (message) => this.onMessage(channel, message),
      onClose: (err) => this.onClosed(channel, err),
      onSign: () => this.step(),
      onIgnored: () => this.warnLimited('ignored', 'Anova sent a message that is not usable'),
    });
    this.connecting = channel;
    try {
      await channel.open();
    } catch (err) {
      if (this.connecting === channel) {
        this.connecting = undefined;
      }
      if (generation === this.generation) {
        await this.failed(err instanceof ChannelError ? err : new ChannelError('network'));
      }
      return;
    }
    if (this.connecting === channel) {
      this.connecting = undefined;
    }
    if (generation !== this.generation) {
      channel.close();
      return;
    }
    this.channel = channel;
    this.connId += 1;
    this.openedAt = this.monotonic();
    this.lastDeviceMessageAt = this.openedAt;
    this.stable = false;
    this.listed = false;
    // Accepted: a refusal kept in /data no longer holds.
    this.blocked = false;
    if (this.memory.block) {
      this.memory.block = null;
      this.saveMemory();
    }
    this.startPing(channel);
    this.listTimer = this.timers.setTimeout(() => {
      this.listTimer = undefined;
      if (this.channel === channel && !this.listed) {
        this.logger.warn('Anova sent no device list: reconnecting');
        channel.kill();
      }
    }, TIMINGS.listTimeout);
    // The messages that came with the 101 (before the open resolved) first.
    const early = channel.early ?? [];
    channel.early = undefined;
    for (const message of early) {
      this.onMessage(channel, message);
    }
    if (this.channel !== channel) {
      return;
    }
    // The stops waiting for a connection leave first.
    this.resendStops();
  }

  /** A promise within `ms` (resolves undefined past it; the work goes on). */
  bounded(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(resolve, ms);
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  /** A failed attempt: a refused token stops, a 429 pauses, anything else backs off. */
  async failed(err) {
    const generation = this.generation;
    if (err.kind === 'refused') {
      await this.refuse(T.refused);
      return;
    }
    if (err.kind === 'too_many') {
      const wait = Math.min(
        Math.max(err.retryAfter ?? TIMINGS.tooManyDefault, TIMINGS.tooManyMin),
        TIMINGS.tooManyMax,
      );
      this.pauseUntil = this.monotonic() + wait;
      this.memory.pause = { kind: 'busy', until: this.now() + wait };
      this.logger.warn(`Anova answered 429: pause of ${Math.round(wait / 1000)} s`);
      await this.saveMemory();
      if (generation !== this.generation) {
        return;
      }
      await this.setStatus(false, T.tooMany(age(wait)));
      this.schedule(wait);
      return;
    }
    const wait = await this.nextBackoff();
    if (generation !== this.generation) {
      return;
    }
    this.logger.warn(
      `Connecting to Anova failed (${err.kind}${err.status ? ` ${err.status}` : ''}): new try in ${Math.round(wait / 1000)} s`,
    );
    await this.setStatus(
      false,
      err.kind === 'http' && err.status
        ? T.httpError(err.status, age(wait))
        : T.unreachable(age(wait)),
    );
    this.schedule(wait);
  }

  /** The token is refused: kept in /data (8 bits of its hash), no new try by itself. */
  async refuse(message) {
    const generation = this.generation;
    this.blocked = true;
    this.logger.warn('Anova refused the personal access token');
    this.memory.block = { mark: refusedMark(this.config.token) };
    await this.saveMemory();
    if (generation === this.generation) {
      await this.setStatus(false, message);
    }
  }

  /** The next backoff delay (jitter: half to the whole), its level kept in /data. */
  async nextBackoff() {
    const steps = TIMINGS.backoff;
    const level = Math.min(this.memory.backoff.level, steps.length - 1);
    const wait = Math.round(steps[level] * (0.5 + 0.5 * this.random()));
    this.memory.backoff.level = Math.min(level + 1, steps.length);
    await this.saveMemory();
    return wait;
  }

  onClosed(channel, err) {
    if (this.channel !== channel) {
      return;
    }
    this.channel = undefined;
    this.listed = false;
    this.stopPing();
    if (this.listTimer) {
      this.timers.clearTimeout(this.listTimer);
      this.listTimer = undefined;
    }
    this.endPending();
    this.step();
    this.checkStable(channel);
    // Anova accepts the handshake of an invalid token, then closes at once
    // without a message (seen on the real service): closed silently twice in
    // a row, the token is taken as refused (persisted, no new try by itself).
    if (
      !channel.alive &&
      !channel.killed &&
      err?.code === 1005 &&
      this.monotonic() - this.openedAt <= TIMINGS.silentCloseWindow
    ) {
      this.silentCloses += 1;
      if (this.silentCloses >= 2) {
        this.silentCloses = 0;
        this.refuse(T.refusedClosed).catch(() => {});
        return;
      }
    } else {
      this.silentCloses = 0;
    }
    const generation = this.generation;
    this.nextBackoff()
      .then(async (wait) => {
        if (generation !== this.generation) {
          return;
        }
        this.logger.warn(
          `The connection to Anova closed (${err?.kind ?? 'closed'} ${err?.code ?? ''}): new try in ${Math.round(wait / 1000)} s`,
        );
        await this.setStatus(false, channel.killed ? T.dead(age(wait)) : T.lost(age(wait)));
        // A stop waiting does not wait for the backoff.
        this.schedule(this.stops.size > 0 ? Math.min(wait, TIMINGS.backoff[0]) : wait);
      })
      .catch(() => {});
  }

  /** Open long enough, listed, with a message or a pong: the backoff is forgotten. */
  checkStable(channel) {
    if (
      !this.stable &&
      this.listed &&
      channel.alive &&
      this.monotonic() - this.openedAt >= TIMINGS.stableAfter
    ) {
      this.stable = true;
      this.memory.backoff.level = 0;
      this.saveMemory();
    }
  }

  startPing(channel) {
    this.stopPing();
    this.pingTimer = this.timers.setInterval(() => {
      if (this.channel !== channel) {
        return;
      }
      this.checkStable(channel);
      if (!channel.ping()) {
        this.logger.warn('Anova did not answer the ping: reconnecting');
        channel.kill();
        return;
      }
      // Silent too long (Anova pushes changes only): opened again for fresh
      // states, once stable, never during a start.
      if (
        this.stable &&
        this.starting.size === 0 &&
        this.monotonic() - this.lastDeviceMessageAt >= TIMINGS.silenceRefresh
      ) {
        this.channel = undefined;
        this.listed = false;
        this.stopPing();
        channel.close();
        this.endPending();
        this.schedule(TIMINGS.backoff[0]);
      }
    }, TIMINGS.pingInterval);
  }

  stopPing() {
    if (this.pingTimer) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  // --- Messages --------------------------------------------------------------

  onMessage(channel, message) {
    if (this.channel !== channel) {
      // Sent with the 101, before the open resolved: kept for link().
      if (this.connecting === channel && (channel.early ??= []).length < 50) {
        channel.early.push(message);
      }
      return;
    }
    if (LIST_EVENTS.has(message.command)) {
      const list = parseList(message);
      if (list) {
        this.onList(list);
      }
    } else if (STATE_EVENTS.has(message.command)) {
      const state = parseState(message);
      if (state) {
        this.onState(state);
      } else {
        this.warnLimited('state', 'Anova sent a state that is not usable');
      }
    } else if (message.command === EVENTS.RESPONSE) {
      const response = parseResponse(message);
      const resolve = response && this.pending.get(response.requestId);
      if (resolve) {
        this.pending.delete(response.requestId);
        resolve(response);
      }
    }
  }

  onList({ family, devices }) {
    this.lastDeviceMessageAt = this.monotonic();
    for (const [id, device] of this.devices) {
      if (device.family === family && !devices.some((d) => d.cookerId === id)) {
        this.devices.delete(id);
      }
    }
    for (const device of devices) {
      if (this.devices.size >= LIMITS.devices && !this.devices.has(device.cookerId)) {
        continue;
      }
      this.devices.set(device.cookerId, device);
    }
    this.listed = true;
    if (this.listTimer) {
      this.timers.clearTimeout(this.listTimer);
      this.listTimer = undefined;
    }
    const count = this.devices.size;
    this.setStatus(true, count > 0 ? T.connected(count) : T.noDevice).catch(() => {});
    this.publishDevices().catch(() => {});
    this.step();
  }

  onState({ cookerId, family, type, values }) {
    const device = this.devices.get(cookerId);
    if (!device || device.family !== family) {
      this.warnLimited('unlisted', 'Anova sent the state of a device it did not list');
      return;
    }
    if (!device.type && type) {
      device.type = type;
    }
    if (values.cooking === false) {
      values.remaining = 0;
    }
    const entry = { values, at: this.monotonic(), wall: this.now(), conn: this.connId };
    this.states.set(cookerId, entry);
    this.lastDeviceMessageAt = entry.at;
    for (const [id, value] of statesOf(this.gladys, family, cookerId, values, this.language)) {
      this.publisher.push(id, value);
    }
    this.checkStop(cookerId, entry);
    this.checkTimerEnd(device, entry);
    for (const watcher of this.watchers) {
      if (watcher.cookerId === cookerId && watcher.match(entry)) {
        this.watchers.delete(watcher);
        watcher.resolve(true);
      }
    }
  }

  /** Every fresh state again (Gladys reconnected, a new language): dated when old. */
  queueAllStates() {
    for (const cookerId of this.states.keys()) {
      this.queueStates(cookerId);
    }
  }

  queueStates(cookerId) {
    const entry = this.states.get(cookerId);
    const device = this.devices.get(cookerId);
    if (!entry || !device) {
      return;
    }
    const ageMs = this.monotonic() - entry.at;
    if (ageMs > TIMINGS.stateMaxAge) {
      return;
    }
    const dated = ageMs > TIMINGS.stateDated ? new Date(entry.wall).toISOString() : undefined;
    for (const [id, value] of statesOf(
      this.gladys,
      device.family,
      cookerId,
      entry.values,
      this.language,
    )) {
      this.publisher.push(id, dated ? { ...value, created_at: dated } : value);
    }
  }

  async publishDevices() {
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const list = [...this.devices.values()]
      .sort((a, b) => a.cookerId.localeCompare(b.cookerId))
      .map((device) => {
        const ids = this.gladys.externalIds(
          device.family === FAMILIES.OVEN ? 'oven' : 'cooker',
          device.cookerId,
        );
        return buildDevice(this.gladys, device, this.config, created.get(ids.device));
      });
    const key = JSON.stringify(list);
    if (key === this.published) {
      return;
    }
    this.published = key;
    try {
      await this.gladys.publishDiscoveredDevices(list);
    } catch (err) {
      this.published = undefined;
      this.logger.warn(`Publishing the devices failed: ${err?.message}`);
    }
  }

  // --- Commands --------------------------------------------------------------

  /** Sends a command with a new requestId: { sent, answer } (answer: { ok, status } or null). */
  request(command) {
    const requestId = this.uuid();
    let resolve;
    const answer = new Promise((r) => {
      resolve = r;
    });
    const sent = this.channel?.send({ ...command, requestId }) ?? false;
    if (sent) {
      this.pending.set(requestId, resolve);
      // Bounded: the oldest answer still awaited is given up.
      if (this.pending.size > LIMITS.pending) {
        const [oldest, done] = this.pending.entries().next().value;
        this.pending.delete(oldest);
        done(null);
      }
    } else {
      resolve(null);
    }
    return { sent, answer };
  }

  /** The answer within `ms`, else null. */
  waitAnswer(answer, ms) {
    let timer;
    return Promise.race([
      answer,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(null), Math.max(0, ms));
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  /** A state of `cookerId` matching `match` within `ms`: true, else false. */
  waitState(cookerId, match, ms) {
    return new Promise((resolve) => {
      let timer;
      const watcher = {
        cookerId,
        match,
        resolve: (value) => {
          this.timers.clearTimeout(timer);
          this.watchers.delete(watcher);
          resolve(value);
        },
      };
      timer = this.timers.setTimeout(() => watcher.resolve(false), ms);
      this.watchers.add(watcher);
    });
  }

  /**
   * Waits until `ready()` or `ms` (bounded): checked again at every step of
   * the connection (attempt ended, list received, closed), never by polling.
   */
  waitFor(ready, ms) {
    if (ready()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      let timer;
      const waiter = () => {
        if (ready()) {
          done();
        }
      };
      const done = () => {
        this.timers.clearTimeout(timer);
        this.stepWaiters.delete(waiter);
        resolve(ready());
      };
      timer = this.timers.setTimeout(done, Math.max(0, ms));
      this.stepWaiters.add(waiter);
    });
  }

  /** A step of the connection: the waiters look again. */
  step() {
    for (const waiter of [...this.stepWaiters]) {
      waiter();
    }
  }

  endPending() {
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
  }

  /** The stop target of an external id: family, id, and the type (list, Gladys device params). */
  targetOf(ref, gladysDevice) {
    const listed = this.devices.get(ref.cookerId);
    let type = listed?.family === ref.family ? listed.type : undefined;
    if (!type) {
      const ids = this.gladys.externalIds(
        ref.family === FAMILIES.OVEN ? 'oven' : 'cooker',
        ref.cookerId,
      );
      const device =
        gladysDevice?.external_id === ids.device
          ? gladysDevice
          : (this.gladys.devices ?? []).find((d) => d.external_id === ids.device);
      const param = (device?.params ?? []).find((p) => p?.name === 'anova_type')?.value;
      type = isDeviceType(param) ? param : undefined;
    }
    if (!type) {
      type = this.stops.get(ref.cookerId)?.type;
    }
    return { cookerId: ref.cookerId, family: ref.family, type };
  }

  /**
   * Stops a cooker or an oven: never refused. Resolves within the stop budget
   * with 'confirmed' (a state shows it idle), 'accepted' (Anova answered ok),
   * 'refused' (Anova answered an error; kept, checked again), 'sent' (sent on
   * a live connection, no answer yet) or 'queued' (not sent yet: sent as soon
   * as a live connection opens).
   */
  async stopDevice(target, { reason = 'button' } = {}) {
    const start = this.monotonic();
    const deadline = start + TIMINGS.stopBudget;
    const { cookerId } = target;
    this.stopCount.set(cookerId, (this.stopCount.get(cookerId) ?? 0) + 1);
    // A start waiting for its answer or its state learns that a stop came.
    for (const watcher of [...this.watchers]) {
      if (watcher.cookerId === cookerId) {
        watcher.resolve(false);
      }
    }
    const previous = this.stops.get(cookerId);
    if (previous) {
      this.clearRecheck(previous);
    }
    const record = {
      ...target,
      type: target.type ?? previous?.type,
      firstAt: start,
      wallAt: this.now(),
      sends: 0,
      probes: 0,
      sentAt: undefined,
      acked: false,
      cookKey: this.states.get(cookerId)?.values.cookKey ?? previous?.cookKey,
      recheck: undefined,
      awaitFirst: undefined,
    };
    this.stops.set(cookerId, record);
    this.keepStop(record);
    this.logger.info(`Stop of ${cookerId} (${reason})`);
    if (!this.channel && this.config.token) {
      this.connect({ force: true });
      await this.waitFor(() => this.channel !== undefined || !this.linking, deadline - start);
    }
    if (this.stops.get(cookerId) !== record) {
      return 'confirmed';
    }
    if (record.sentAt !== undefined) {
      // Sent by resendStops when the connection opened: wait for its answer.
      return this.stopOutcome(record, deadline);
    }
    if (!this.channel) {
      return 'queued';
    }
    // Pressed just now: sent at once, whatever cook the device shows.
    this.clearRecheck(record);
    return this.sendStop(record, deadline);
  }

  /** The stop record in /data (not awaited: a stop never waits for /data). */
  keepStop(record) {
    if (this.memoryState !== 'ok') {
      return;
    }
    this.memory.stops = this.memory.stops.filter((s) => s.cookerId !== record.cookerId);
    this.memory.stops.push({
      cookerId: record.cookerId,
      family: record.family,
      type: record.type,
      at: record.wallAt,
      sends: record.sends,
      acked: record.acked,
      cookKey: record.cookKey,
    });
    this.saveMemory();
  }

  forgetStop(record, why) {
    if (this.stops.get(record.cookerId) !== record) {
      return;
    }
    this.clearRecheck(record);
    this.stops.delete(record.cookerId);
    this.logger.info(`Stop of ${record.cookerId}: ${why}`);
    if (this.memoryState === 'ok') {
      this.memory.stops = this.memory.stops.filter((s) => s.cookerId !== record.cookerId);
      this.saveMemory();
    }
  }

  clearRecheck(record) {
    if (record.recheck) {
      this.timers.clearTimeout(record.recheck);
      record.recheck = undefined;
    }
    if (record.awaitFirst) {
      this.timers.clearTimeout(record.awaitFirst);
      record.awaitFirst = undefined;
    }
  }

  /** Cuts a connection found dead by us, at once (no backoff: a stop reconnects). */
  dropChannel(channel) {
    if (this.channel !== channel) {
      return;
    }
    this.channel = undefined;
    this.listed = false;
    this.stopPing();
    if (this.listTimer) {
      this.timers.clearTimeout(this.listTimer);
      this.listTimer = undefined;
    }
    this.endPending();
    channel.kill();
    this.step();
  }

  /**
   * Sends the stop on the open connection with a ping. A send counts only on
   * a proof that the connection is alive (the answer, any message or the
   * pong within 1.5 s); without it, the connection is cut, opened again at
   * once and the stop sent on the new one (3 dead connections at most per
   * stop, then the backoff). Then waits for the answer until `deadline`.
   */
  async sendStop(record, deadline) {
    const channel = this.channel;
    if (!channel) {
      return 'queued';
    }
    const signs = channel.signs;
    const { sent, answer } = this.request(stopCommand(record));
    if (!sent) {
      return 'queued';
    }
    channel.probe();
    record.sentAt = this.monotonic();
    record.acked = false;
    record.answer = answer;
    // A late answer still counts.
    answer.then((res) => {
      if (res?.ok && this.stops.get(record.cookerId) === record) {
        record.acked = true;
        this.keepStop(record);
      }
    });
    const alive = () => channel.signs > signs;
    await this.waitFor(() => alive() || this.channel !== channel, TIMINGS.stopProof);
    if (this.stops.get(record.cookerId) !== record) {
      return 'confirmed';
    }
    if (alive()) {
      record.sends += 1;
      this.keepStop(record);
      this.armRecheck(record);
      return this.stopOutcome(record, deadline);
    }
    // No sign of life: this send does not count.
    record.sentAt = undefined;
    record.probes += 1;
    this.logger.warn(`Stop of ${record.cookerId}: the connection is dead, opening a new one`);
    this.dropChannel(channel);
    if (record.probes >= TIMINGS.stopProbes) {
      this.schedule(TIMINGS.backoff[0]);
      return 'queued';
    }
    this.connect({ force: true });
    await this.waitFor(
      () => this.channel !== undefined || !this.linking,
      Math.max(0, deadline - this.monotonic()),
    );
    if (this.stops.get(record.cookerId) !== record) {
      return 'confirmed';
    }
    if (record.sentAt !== undefined) {
      return this.stopOutcome(record, deadline);
    }
    if (!this.channel) {
      return 'queued';
    }
    this.clearRecheck(record);
    return this.sendStop(record, deadline);
  }

  async stopOutcome(record, deadline) {
    const res = await this.waitAnswer(record.answer, deadline - this.monotonic());
    if (this.stops.get(record.cookerId) !== record) {
      return 'confirmed';
    }
    if (res?.ok) {
      return 'accepted';
    }
    return res ? 'refused' : 'sent';
  }

  /** After a send: checked again once the device had time to report. */
  armRecheck(record, delay = TIMINGS.stopRecheck) {
    if (record.recheck) {
      this.timers.clearTimeout(record.recheck);
    }
    const generation = this.generation;
    record.recheck = this.timers.setTimeout(() => {
      record.recheck = undefined;
      if (generation === this.generation) {
        this.recheckStop(record);
      }
    }, delay);
  }

  /**
   * A state of the device. Waiting for the first state of a new connection
   * (a kept stop of a known cook): idle = done, another cook = not sent (a
   * cook started afterwards), the same cook or no identity = sent. Otherwise,
   * a state after the send showing the device idle: the stop is done.
   */
  checkStop(cookerId, entry) {
    const record = this.stops.get(cookerId);
    if (!record) {
      return;
    }
    if (record.awaitFirst && entry.conn === this.connId) {
      this.timers.clearTimeout(record.awaitFirst);
      record.awaitFirst = undefined;
      const key = entry.values.cookKey;
      if (entry.values.cooking === false) {
        this.forgetStop(record, 'the device is idle');
      } else if (key !== undefined && record.cookKey !== undefined && key !== record.cookKey) {
        this.forgetStop(record, 'another cook started meanwhile: not sent');
      } else {
        this.sendStop(record, this.monotonic() + TIMINGS.stopBudget).catch(() => {});
      }
      return;
    }
    if (record.sentAt !== undefined && entry.at > record.sentAt && entry.values.cooking === false) {
      this.forgetStop(record, 'confirmed by the state');
    }
  }

  /**
   * The device still reports a cook after the stop: the stop is sent again
   * (3 sends in all, 10 min at most), unless a different cook is shown (a
   * cook started afterwards, from the app or the device). In doubt (no state
   * since the send, no identity of the cook within 2 min), the stop leaves.
   */
  recheckStop(record) {
    if (this.stops.get(record.cookerId) !== record) {
      return;
    }
    const mono = this.monotonic();
    if (mono - record.firstAt > TIMINGS.stopKeep) {
      this.forgetStop(record, 'given up after 10 min without confirmation');
      return;
    }
    const latest = this.states.get(record.cookerId);
    if (latest && record.sentAt !== undefined && latest.at > record.sentAt) {
      if (latest.values.cooking === false) {
        this.forgetStop(record, 'confirmed by the state');
        return;
      }
      const key = latest.values.cookKey;
      if (record.cookKey !== undefined && key !== undefined && key !== record.cookKey) {
        this.forgetStop(record, 'a new cook started after it: not sent again');
        return;
      }
      if (
        (record.cookKey === undefined || key === undefined) &&
        mono - record.firstAt > TIMINGS.stopWindow
      ) {
        this.forgetStop(record, 'the cook cannot be told apart: not sent again');
        return;
      }
    }
    if (record.sends >= TIMINGS.stopSends) {
      this.forgetStop(record, 'sent 3 times without confirmation');
      return;
    }
    if (!this.channel) {
      return; // sent again when a connection opens (resendStops)
    }
    this.logger.warn(`Stop of ${record.cookerId} not confirmed: sent again`);
    this.sendStop(record, this.monotonic() + TIMINGS.stopBudget).catch(() => {});
  }

  /**
   * A connection opened. Each stop waiting: accepted earlier = decided on
   * the states of this connection; a known cook = sent after the first state
   * of the device (2 s at most: in doubt, it leaves); otherwise sent at once.
   */
  resendStops() {
    for (const record of [...this.stops.values()]) {
      this.clearRecheck(record);
      if (this.monotonic() - record.firstAt > TIMINGS.stopKeep) {
        this.forgetStop(record, 'given up after 10 min without a connection');
      } else if (record.acked) {
        record.sentAt = this.monotonic();
        this.armRecheck(record, TIMINGS.stopFirstState * 2);
      } else if (record.cookKey !== undefined) {
        const generation = this.generation;
        record.awaitFirst = this.timers.setTimeout(() => {
          record.awaitFirst = undefined;
          if (generation === this.generation && this.stops.get(record.cookerId) === record) {
            this.sendStop(record, this.monotonic() + TIMINGS.stopBudget).catch(() => {});
          }
        }, TIMINGS.stopFirstState);
        // A state that came with the 101 already decides.
        const entry = this.states.get(record.cookerId);
        if (entry?.conn === this.connId) {
          this.checkStop(record.cookerId, entry);
        }
      } else {
        this.sendStop(record, this.monotonic() + TIMINGS.stopBudget).catch(() => {});
      }
    }
  }

  /** The timer of a cook ended and the option asks for it: the cooker is stopped once. */
  checkTimerEnd(device, entry) {
    if (
      !this.config.stopAtTimerEnd ||
      device.family !== FAMILIES.COOKER ||
      entry.values.cooking !== true ||
      !entry.values.timerDone ||
      this.stops.has(device.cookerId)
    ) {
      return;
    }
    const key = `${device.cookerId}|${entry.values.cookKey ?? `conn${entry.conn}`}`;
    if (this.timerStopped.has(key)) {
      return;
    }
    this.timerStopped.add(key);
    if (this.timerStopped.size > 100) {
      this.timerStopped.delete(this.timerStopped.values().next().value);
    }
    this.stopDevice(
      { cookerId: device.cookerId, family: device.family, type: device.type },
      { reason: 'end of the timer' },
    ).catch(() => {});
  }

  /** The stop button of a device (Gladys `setValue`): the only command feature. */
  async setValue(device, feature) {
    const ref = parseExternalId(this.gladys, feature?.external_id);
    if (!ref || ref.role !== FEATURES.STOP) {
      throw userError(ERRORS.readOnly, this.language);
    }
    const result = await this.stopDevice(this.targetOf(ref, device), { reason: 'button' });
    this.logger.info(`Stop of ${ref.cookerId}: ${result}`);
  }

  /** Scene action "Stop cooking". */
  async sceneStop(fields) {
    const ref = parseExternalId(this.gladys, fields?.device);
    if (!ref || ref.role !== undefined) {
      throw userError(ERRORS.unknownDevice, this.language);
    }
    const result = await this.stopDevice(this.targetOf(ref), { reason: 'scene' });
    return { result };
  }

  /** The state a start decides on: of this connection, recent, idle, without a problem. */
  checkStartState(cookerId) {
    const entry = this.states.get(cookerId);
    if (!entry || entry.conn !== this.connId || this.monotonic() - entry.at > TIMINGS.freshState) {
      throw userError(ERRORS.noFreshState, this.language);
    }
    // A start sent earlier is not confirmed by a state from before it.
    const lastStart = this.startSent.get(cookerId);
    if (lastStart !== undefined && entry.at <= lastStart) {
      throw userError(ERRORS.previousStart, this.language);
    }
    if (entry.values.cooking !== false) {
      throw userError(ERRORS.alreadyCooking, this.language);
    }
    if (
      ['low_water', 'high_temperature', 'failure', 'busy', 'unknown'].includes(
        entry.values.state,
      ) ||
      ['water_leak', 'water_critical', 'water_temperature_high', 'water_low'].includes(
        entry.values.alert,
      )
    ) {
      throw userError(ERRORS.deviceAlert, this.language);
    }
    return entry;
  }

  /**
   * Scene action "Start a sous vide cook": refused unless allowed, checked
   * against a fresh state, /data written before the first byte, everything
   * checked again just before the send. Resolves { result }: 'started' (a
   * state shows the cook), 'accepted' (Anova answered ok, no state yet) or
   * 'sent' (no answer: without confirmation).
   */
  async startCook(fields) {
    const L = this.language;
    // Gladys waits 45 s: the start leaves within 10 s of the scene, or nothing is sent.
    const sendBy = this.monotonic() + TIMINGS.startSendBy;
    if (!this.config.allowStart) {
      throw userError(ERRORS.startDisabled, L);
    }
    const ref = parseExternalId(this.gladys, fields?.device);
    if (!ref || ref.role !== undefined) {
      throw userError(ERRORS.notCooker, L);
    }
    if (ref.family === FAMILIES.OVEN) {
      throw userError(ERRORS.ovenStart, L);
    }
    const { minTemperature, maxTemperature, minMinutes, maxMinutes } = START_LIMITS;
    const raw = fieldNumber(fields?.temperature);
    const temperature = raw === undefined ? undefined : Math.round(raw * 10) / 10;
    if (temperature === undefined || temperature < minTemperature || temperature > maxTemperature) {
      throw userError(ERRORS.temperature(minTemperature, maxTemperature), L);
    }
    const minutes = fieldNumber(fields?.minutes);
    if (!Number.isInteger(minutes) || minutes < minMinutes || minutes > maxMinutes) {
      throw userError(ERRORS.minutes(minMinutes, maxMinutes), L);
    }
    const { cookerId } = ref;
    if (this.memoryState !== 'ok') {
      throw userError(ERRORS.dataNotSaved, L);
    }
    if (this.stops.has(cookerId)) {
      throw userError(ERRORS.stopping, L);
    }
    if (this.starting.has(cookerId)) {
      throw userError(ERRORS.busy, L);
    }
    this.starting.add(cookerId);
    try {
      const check = () => {
        const device = this.devices.get(cookerId);
        if (!device || device.family !== FAMILIES.COOKER || !device.type) {
          throw userError(this.listed ? ERRORS.unknownDevice : ERRORS.notConnected, L);
        }
        if (!this.channel || !this.listed) {
          throw userError(ERRORS.notConnected, L);
        }
        this.checkStartState(cookerId);
        return device;
      };
      check();
      const count = this.stopCount.get(cookerId) ?? 0;
      // The start is written to /data before its first byte; a failed write sends nothing.
      this.memory.start = { cookerId, at: this.now() };
      const saved = await this.bounded(this.saveMemory(), Math.max(0, sendBy - this.monotonic()));
      if (saved !== true) {
        throw userError(ERRORS.dataNotSaved, L);
      }
      if (this.monotonic() > sendBy) {
        throw userError(ERRORS.tooLate, L);
      }
      // Just before the send: the option, a stop meanwhile, the connection and the state again.
      if (!this.config.allowStart) {
        throw userError(ERRORS.startDisabled, L);
      }
      if ((this.stopCount.get(cookerId) ?? 0) !== count || this.stops.has(cookerId)) {
        throw userError(ERRORS.cancelledByStop, L);
      }
      const device = check();
      const sentAt = this.monotonic();
      const { sent, answer } = this.request(startCommand(device, { temperature, minutes }));
      if (!sent) {
        throw userError(ERRORS.notConnected, L);
      }
      // Until a state after it, no other start of this cooker.
      this.startSent.set(cookerId, sentAt);
      this.logger.info(`Start of ${cookerId}: ${temperature} °C, ${minutes} min`);
      const res = await this.waitAnswer(answer, TIMINGS.startResponse);
      if (res && !res.ok) {
        this.startSent.delete(cookerId); // refused: nothing started
        throw userError(ERRORS.refusedByAnova, L);
      }
      if ((this.stopCount.get(cookerId) ?? 0) !== count) {
        return { result: res ? 'accepted' : 'sent' }; // stopped meanwhile
      }
      const shows = (entry) =>
        entry !== undefined &&
        entry.at > sentAt &&
        entry.values.cooking === true &&
        (entry.values.target === undefined || Math.abs(entry.values.target - temperature) <= 0.6);
      // The state may have come with the answer, before the watcher.
      const started =
        shows(this.states.get(cookerId)) ||
        (await this.waitState(cookerId, shows, TIMINGS.startConfirm));
      const result = started ? 'started' : res ? 'accepted' : 'sent';
      this.logger.info(`Start of ${cookerId}: ${result}`);
      return { result };
    } finally {
      this.starting.delete(cookerId);
    }
  }

  // --- Gladys ------------------------------------------------------------------

  /** Discovery: the devices of the last lists (no new connection, never faster). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  /** A created device gets its fresh states (dated when old, nothing past 2 h). */
  async deviceCreated(device) {
    const ref = parseExternalId(this.gladys, device?.external_id);
    if (ref) {
      this.queueStates(ref.cookerId);
      await this.flush();
    }
  }

  async deviceDeleted(device) {
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /**
   * "Test the connection": at most every 30 s; respects a 429 pause; tries a
   * refused token once more; starts again from an empty state when /data is
   * unreadable.
   */
  async testConnection() {
    const mono = this.monotonic();
    if (mono - this.lastTestAt < TIMINGS.testCooldown) {
      return T.test.cooldown;
    }
    this.lastTestAt = mono;
    if (this.memoryState !== 'ok') {
      this.memory = emptyMemory();
      this.memoryState = 'ok';
      if (this.dataTimer) {
        this.timers.clearTimeout(this.dataTimer);
        this.dataTimer = undefined;
      }
      await this.saveMemory();
    }
    if (!this.config.token) {
      return this.config.tokenInvalid ? T.tokenInvalid : T.noToken;
    }
    if (mono < this.pauseUntil) {
      return T.tooMany(age(this.pauseUntil - mono));
    }
    if (this.channel && this.listed) {
      return T.connected(this.devices.size);
    }
    if (this.blocked) {
      this.blocked = false;
      this.memory.block = null;
      await this.saveMemory();
    }
    this.connect({ force: true });
    // Until listed, or the attempt over without a connection (refused, unreachable).
    await this.waitFor(() => this.listed || (!this.linking && !this.channel), TIMINGS.testWait);
    if (this.listed) {
      return this.devices.size > 0 ? T.connected(this.devices.size) : T.noDevice;
    }
    return this.lastMessage ?? T.test.waiting;
  }
}
