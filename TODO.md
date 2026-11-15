# TODO — Anova v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1 — core** (2026-11-15): one WebSocket connection per token
      (official URL and parameters), device lists and states (cookers: `job`,
      A3 and `nodes` shapes ported from anova-wifi; ovens: `nodes`), one device
      per cooker/oven, stop button and scene action (never refused, kept in
      `/data`, sent again 3 times at most), sous vide start scene action behind
      `allow_start` (off), stop at the end of the timer (option, off), backoff,
      429 pause and refused token persisted, test button, docs en/fr, cover.
      Tested against a fake server only.
- [ ] **Milestone 2 — real device**: run against a real cooker and a real oven
      (state shapes, units, whether an oven needs the `ANOVA_V2` subprotocol,
      what Anova sends on an invalid token, whether pings count as activity).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- No `keywords` in the manifest; category `appliances`; no `countries`
  (Anova sells worldwide); `gladys_version >=5.1.0` (scene actions, dynamic
  selects).
- Reference: the official documentation (endpoint, parameters, commands,
  device types). The official example repository has no license: nothing of
  its code is read or used. The cooker state shapes, not documented, are
  ported from anova-wifi (MIT, THIRD_PARTY_NOTICES.md). The oven state fields
  are taken as facts from community descriptions (no code ported); never
  verified.
- Only the personal access token: no e-mail/password login, no Firebase key,
  no `platform` parameter, no imitation of the app. Honest User-Agent.
- The token goes in the query string (the only documented way): never logged;
  errors of `ws` are reduced to a kind and a status.
- Start = scene action only (needs parameters, never a switch or a button);
  `allow_start` off by default, checked again just before the send; /data
  written before the first byte. A running cook is never changed (refused
  while cooking): the PAT command list has no "set target".
- Stop = button + scene action, never refused. It cannot be sent "from /data
  without getConfig()" after a restart: the token lives only in the Gladys
  configuration, so a kept stop leaves at the first connection after the
  configuration is read.
- Verified on the real service (2026-11-15, one connection with a fake
  token): Anova accepts the handshake of an invalid token, then closes at once
  (code 1005) without any message. So a refused token is an HTTP 401, or two
  connections in a row closed by Anova before any message (like a session
  closed between password and OK: refusal at the 2nd case in a row). A close
  after a message, or a cut by our own timers, never counts.
- A refused token is kept as 8 bits of its SHA-256: a new
  token is recognised in memory; after a restart, a new token sharing the
  8 bits (1/256) waits for the test button. A 403 is not a refusal.
- Freshness: Anova pushes changes only; the connection is opened again after
  25 min of silence, and a start needs a state of the current connection of
  less than 30 min.
- The target temperature is a read-only `thermostat`/`target-temperature`;
  temperatures are `temperature-sensor`/`probe` (kept out of room averages).

## Next

- Oven start (stages), probe target, temperature unit command.
- Changing the target or timer of a running cook, if Anova adds it to the PAT
  commands.
- Telemetry export (CMD_EXPORT_TELEMETRY) is not used.
