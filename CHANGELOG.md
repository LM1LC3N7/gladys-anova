# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Anova Precision Cookers and Precision Ovens through the official Anova
  Developer WebSocket API and a personal access token: temperature, target,
  time remaining, cook time, state and alert of each device.
- A Stop button on each device and a "stop cooking" scene action, never
  refused, kept and sent again until the device reports idle.
- A "start a sous vide cook" scene action (25 to 92 °C, 1 min to 99 h 59),
  off by default behind "Allow starting a cook".
- An option to stop a cooker when its timer ends (off by default).
- Reconnection with backoff, 429 pause and refused token kept in `/data`,
  "Test the connection" button, docs in English and French.
