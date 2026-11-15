// -----------------------------------------------------------------------------
// One WebSocket connection to Anova (the `ws` package, MIT): opened with a
// handshake timeout, messages bounded (maxPayload, no compression), parsed by
// src/protocol.js. The connection never reopens by itself: the app decides
// when (src/app.js, backoff and pauses).
//
// Why `ws` and not the WebSocket of Node 22: only `ws` lets us read the HTTP
// status and the Retry-After of a refused handshake ('unexpected-response'),
// bound the size of a message (maxPayload) and send pings.
//
// The URL carries the personal access token (the only way the documentation
// gives): it is never logged, and no error text of `ws` or of the network is
// passed on (only a kind and a status).
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { LIMITS, TIMINGS, USER_AGENT } from './constants.js';
import { parseMessage } from './protocol.js';

/** An error of the connection, with a kind the app understands (never a server text). */
export class ChannelError extends Error {
  constructor(kind, { status, code, retryAfter } = {}) {
    super(kind);
    this.name = 'ChannelError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    /** A 429: the Retry-After of the answer (ms), when it gives one. */
    this.retryAfter = retryAfter;
  }
}

/** The options of every connection: bounded handshake and messages, no compression. */
export const SOCKET_OPTIONS = Object.freeze({
  handshakeTimeout: TIMINGS.handshakeTimeout,
  maxPayload: LIMITS.messageBytes,
  perMessageDeflate: false,
  followRedirects: false,
  headers: Object.freeze({ 'User-Agent': USER_AGENT }),
});

/** The default socket factory: a `ws` client. */
export function defaultSocketFactory(url, options) {
  return new WebSocket(url, { ...options, headers: { ...options.headers } });
}

/**
 * The kind of a refused handshake. Only a 401 says the token is refused; a
 * 403 may come from a proxy or a firewall in between and is a plain HTTP
 * error (backoff), like any other status.
 */
export function rejectKind(status) {
  if (status === 401) {
    return 'refused';
  }
  return status === 429 ? 'too_many' : 'http';
}

/** A Retry-After header (seconds or an HTTP date, read against `wall`) -> ms, else undefined. */
export function retryAfterOf(value, wall) {
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) {
    return Number(text) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - wall) : undefined;
}

export class Channel {
  /**
   * @param {object} options
   * @param {string} options.url - the connection URL (a secret).
   * @param {Function} options.factory - (url, options) => a `ws`-like socket.
   * @param {Function} options.onMessage - (message) => void, every parsed message.
   * @param {Function} options.onClose - (ChannelError) => void, once, after the open.
   * @param {Function} [options.onIgnored] - () => void, a message not usable.
   * @param {object} [options.timers] - setTimeout/clearTimeout (the close delay).
   * @param {Function} [options.now] - the wall clock (an HTTP-date Retry-After only).
   */
  constructor({
    url,
    factory = defaultSocketFactory,
    onMessage,
    onClose,
    onIgnored = () => {},
    timers = globalThis,
    now = Date.now,
  }) {
    this.url = url;
    this.factory = factory;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onIgnored = onIgnored;
    this.timers = timers;
    this.now = now;
    this.socket = undefined;
    this.isOpen = false;
    this.ended = false;
    this.waitingPong = false;
    /** A pong or a message came since the open. */
    this.alive = false;
    /** Cut by us (kill), not closed by Anova. */
    this.killed = false;
  }

  /** Opens the connection: resolves once open, rejects with a ChannelError. */
  open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let refusal;
      let socket;
      try {
        socket = this.factory(this.url, SOCKET_OPTIONS);
      } catch {
        reject(new ChannelError('network'));
        return;
      }
      this.socket = socket;
      socket.on('unexpected-response', (_request, response) => {
        const status = Number(response?.statusCode) || undefined;
        const headers = response?.headers ?? {};
        refusal = new ChannelError(rejectKind(status), {
          status,
          retryAfter: retryAfterOf(headers['retry-after'], this.now()),
        });
        try {
          response?.resume?.();
        } catch {
          // nothing to drain
        }
        socket.terminate();
      });
      socket.on('open', () => {
        if (this.ended) {
          this.terminate(socket);
          return;
        }
        settled = true;
        this.isOpen = true;
        resolve();
      });
      socket.on('message', (data) => {
        if (this.socket !== socket || this.ended) {
          return;
        }
        this.alive = true;
        const message = parseMessage(data);
        if (message) {
          this.onMessage(message);
        } else {
          this.onIgnored();
        }
      });
      socket.on('pong', () => {
        this.waitingPong = false;
        this.alive = true;
      });
      // An 'error' is always followed by a 'close': the close decides. Its text
      // is never kept (it may hold the host or more).
      socket.on('error', (err) => {
        if (!refusal && /timeout|timed out/i.test(String(err?.message))) {
          refusal = new ChannelError('timeout');
        } else if (!refusal && err?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
          refusal = new ChannelError('too_big');
        }
      });
      socket.on('close', (code) => {
        const wasOpen = this.isOpen;
        this.isOpen = false;
        this.timers.clearTimeout(this.closeTimer);
        if (!settled) {
          settled = true;
          reject(refusal ?? new ChannelError('network', { code }));
          return;
        }
        if (wasOpen && !this.ended) {
          this.ended = true;
          this.onClose(refusal ?? new ChannelError('closed', { code }));
        }
      });
    });
  }

  /**
   * Sends one command. Returns true when the socket took it (it may have left),
   * false when it could not have left (not open).
   */
  send(command) {
    if (!this.isOpen || !this.socket || this.ended) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(command));
      return true;
    } catch {
      // ws throws only before writing (not open): nothing left.
      return false;
    }
  }

  /** A ping; false when the previous one got no pong (the connection is dead). */
  ping() {
    if (!this.isOpen || this.waitingPong) {
      return false;
    }
    this.waitingPong = true;
    try {
      this.socket.ping();
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Closes without calling onClose (a close we asked for): a normal close
   * (1000), then the socket is cut if it is not closed within 2 s.
   */
  close() {
    this.ended = true;
    this.isOpen = false;
    const socket = this.socket;
    if (!socket) {
      return;
    }
    if (socket.readyState === 0) {
      // Still connecting: there is nothing to close politely.
      this.terminate(socket);
      return;
    }
    try {
      socket.close(1000);
    } catch {
      this.terminate(socket);
      return;
    }
    if (socket.readyState === 3) {
      return;
    }
    this.closeTimer = this.timers.setTimeout(() => this.terminate(socket), TIMINGS.closeGrace);
    this.closeTimer?.unref?.();
  }

  terminate(socket = this.socket) {
    try {
      socket?.terminate();
    } catch {
      // already closed
    }
  }

  /** Cuts a dead connection: onClose is called, as for a close from the server. */
  kill() {
    this.killed = true;
    this.terminate();
  }
}
