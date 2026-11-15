# gladys-anova

Anova Precision Cookers (sous vide) and Anova Precision Ovens for
[Gladys Assistant](https://gladysassistant.com), through the official
[Anova Developer](https://developer.anovaculinary.com) WebSocket API and a
personal access token: temperature, target, time remaining, state and alerts,
a **Stop** that is never refused, and a sous vide **start** (scene action)
behind an option that is off by default.

Never tested with a real device. Not affiliated with Anova. The use of the API
is subject to the [Anova API Terms of Use](https://developer.anovaculinary.com/terms).

- User guide: [English](docs/en.md) · [Français](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md) · decisions and next steps: [TODO.md](TODO.md)

## Development

```bash
npm install
npm test               # node --test (fake Gladys, fake Anova server, virtual clock)
npm run lint
npm run format:check
node scripts/mutants.mjs   # mutation check of the guards (local only)
node scripts/cover.mjs cover.png
```

Architecture: `src/app.js` (connection, backoff, pauses, stop and start),
`src/channel.js` (one `ws` connection), `src/protocol.js` (messages),
`src/devices.js` (Gladys devices), `src/store.js` (`/data`),
`src/publisher.js` (states within 300 per minute), `src/handlers.js` (SDK
wiring). The state shapes of the cookers are ported from
[anova-wifi](https://github.com/Lash-L/anova_wifi) (MIT, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## License

Apache-2.0, see [LICENSE](LICENSE).
