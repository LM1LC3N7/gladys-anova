# CLAUDE.md

Rules for coding assistants and contributors of `gladys-anova`, a Gladys
Assistant external integration (Node 22+, ESM, no build step) for Anova
Precision Cookers and Ovens through the official Anova Developer WebSocket API.

## Commands

```bash
npm install
npm test                 # node --test --test-timeout=60000
npm run lint && npm run format:check
node scripts/mutants.mjs # local mutation check (run under memcap)
```

## Architecture

```
index.js           SDK wiring only
src/handlers.js    handlers registered before connect()
src/app.js         connection, backoff, pauses, refusals, stop and start
src/channel.js     one `ws` connection (bounded, no token in errors)
src/protocol.js    message parsing (strict numbers) and documented commands
src/devices.js     Gladys devices and states
src/store.js       /data (missing = empty, unreadable != empty)
src/publisher.js   states within 300 per minute
test/              fake Gladys (SDK), fake Anova (test/helpers), virtual clock (test/kit)
```

## Rules

- External ids are forever: `ext:<selector>:cooker:<cookerId>` and
  `ext:<selector>:oven:<cookerId>`, feature roles in `src/constants.js`.
- The stop is never refused (no option, pause, refusal or /data check). The
  start is off by default, a scene action only, never a switch.
- Never log the token or the connection URL; never write the token to /data.
- Decisions on the monotonic clock; the wall clock only for /data and dates.
- Versions belong to the Release workflow; texts in English and French; a
  line in `CHANGELOG.md` under `## [Unreleased]` for every visible change.
