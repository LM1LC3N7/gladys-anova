// -----------------------------------------------------------------------------
// The connection (src/channel.js) on a real local `ws` server: refused
// handshakes (401, 403, 429 with Retry-After), an oversized message cut
// before it is read whole, the User-Agent, and no token in any error.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { Channel, ChannelError, retryAfterOf } from '../src/channel.js';

const SECRET = 'anova-SECRET-in-the-url';

/** A local server: `status` refuses the handshake, else accepts and runs `onConnection`. */
async function localServer(t, { status, headers = {}, onConnection } = {}) {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const seen = [];
  http.on('upgrade', (request, socket, head) => {
    seen.push({ url: request.url, ua: request.headers['user-agent'] });
    if (status) {
      const extra = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('');
      socket.end(`HTTP/1.1 ${status} No\r\n${extra}Content-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => onConnection?.(ws));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise((resolve) => http.close(resolve));
  });
  const url = `ws://127.0.0.1:${http.address().port}/?token=${encodeURIComponent(SECRET)}`;
  return { url, seen };
}

function channel(url, extra = {}) {
  return new Channel({ url, onMessage: () => {}, onClose: () => {}, ...extra });
}

async function refusal(promise) {
  const err = await promise.then(
    () => undefined,
    (e) => e,
  );
  assert.ok(err instanceof ChannelError, String(err));
  assert.ok(!JSON.stringify({ m: err.message, s: err.stack }).includes('SECRET'));
  return err;
}

test('a 401 is a refused token; a 403 is only an HTTP error', async (t) => {
  const a = await localServer(t, { status: 401 });
  assert.equal((await refusal(channel(a.url).open())).kind, 'refused');
  const b = await localServer(t, { status: 403 });
  const err = await refusal(channel(b.url).open());
  assert.deepEqual([err.kind, err.status], ['http', 403]);
  assert.match(
    a.seen[0].ua,
    /^gladys-anova\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-anova\)$/,
  );
});

test('a 429 carries its Retry-After', async (t) => {
  const s = await localServer(t, { status: 429, headers: { 'Retry-After': '120' } });
  const err = await refusal(channel(s.url).open());
  assert.deepEqual([err.kind, err.retryAfter], ['too_many', 120_000]);
  assert.equal(retryAfterOf('Wed, 21 Oct 2026 07:28:00 GMT', Date.UTC(2026, 9, 21, 7, 27)), 60_000);
  assert.equal(retryAfterOf('soon', 0), undefined);
});

test('unreachable: a network error without any text of the socket', async () => {
  const err = await refusal(channel(`ws://127.0.0.1:1/?token=${SECRET}`).open());
  assert.equal(err.kind, 'network');
});

test('messages are delivered parsed; an oversized one closes the connection unread', async (t) => {
  let server;
  const s = await localServer(t, {
    onConnection: (ws) => {
      server = ws;
      ws.send(JSON.stringify({ command: 'EVENT_APC_WIFI_LIST', payload: [] }));
    },
  });
  const messages = [];
  let closed;
  const done = new Promise((resolve) => {
    closed = resolve;
  });
  const c = channel(s.url, { onMessage: (m) => messages.push(m), onClose: (e) => closed(e) });
  await c.open();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages[0].command, 'EVENT_APC_WIFI_LIST');
  server.send('x'.repeat(300 * 1024));
  const err = await done;
  assert.ok(err instanceof ChannelError);
  assert.equal(messages.length, 1);
  assert.equal(c.send({ command: 'X' }), false, 'nothing leaves a closed connection');
});

test('ping and pong; close() never calls onClose', async (t) => {
  const s = await localServer(t, { onConnection: () => {} });
  let closes = 0;
  const c = channel(s.url, { onClose: () => (closes += 1) });
  await c.open();
  assert.equal(c.ping(), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(c.alive, true);
  assert.equal(c.ping(), true);
  c.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closes, 0);
  assert.equal(c.socket.readyState, WebSocket.CLOSED);
});
