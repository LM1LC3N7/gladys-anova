// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never the personal access token:
//   - a 429 pause (its Retry-After): a restart never connects again before;
//   - the backoff level and the time of the last connection attempt: a
//     restart never connects faster than the backoff;
//   - a refused token, as 8 bits of its hash: a restart never sends it again
//     by itself;
//   - the stops not yet sent or not yet confirmed, sent again at the next
//     connection (10 min at most);
//   - the last start sent (which cooker, when), written before it leaves.
// Every time read back is bounded; a date in the future is invalid. The file
// is readable by the container user only (0600).
//
// A missing file is an empty memory; a file that cannot be read or parsed is
// NOT: the app then writes nothing and reads it again on a timer (src/app.js).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { FAMILIES, LIMITS, TIMINGS } from './constants.js';
import { isCookerId, isDeviceType } from './protocol.js';

export const STATE_FILE = '/data/anova-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** -> { status: 'ok', data } | { status: 'missing' } | { status: 'unreadable' } */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { status: 'missing' } : { status: 'unreadable' };
      }
      if (text.length > 64 * 1024) {
        return { status: 'unreadable' };
      }
      try {
        return { status: 'ok', data: JSON.parse(text) };
      } catch {
        return { status: 'unreadable' };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** A wall time read back from /data: in the future, at most `max` away, else undefined. */
export const ahead = (value, wall, max = TIMINGS.persistedMax) =>
  Number.isFinite(value) && value > wall ? Math.min(value, wall + max) : undefined;

/** A wall time of the past read back from /data, at most `max` ago, else undefined. */
export const recent = (value, wall, max) =>
  Number.isFinite(value) && value <= wall && wall - value <= max ? value : undefined;

export const emptyMemory = () => ({
  pause: null,
  block: null,
  backoff: { level: 0, lastAttemptAt: 0 },
  stops: [],
  start: null,
});

/** The persisted state, repaired and bounded. */
export function normalizeMemory(raw, wall) {
  const memory = emptyMemory();
  const until = ahead(raw?.pause?.until, wall, TIMINGS.tooManyMax);
  if (until !== undefined && raw.pause.kind === 'busy') {
    memory.pause = { kind: 'busy', until };
  }
  if (typeof raw?.block?.mark === 'string' && /^[0-9a-f]{2}$/.test(raw.block.mark)) {
    memory.block = { mark: raw.block.mark };
  }
  const level = raw?.backoff?.level;
  memory.backoff.level =
    Number.isInteger(level) && level >= 0 ? Math.min(level, TIMINGS.backoff.length) : 0;
  memory.backoff.lastAttemptAt =
    recent(raw?.backoff?.lastAttemptAt, wall, TIMINGS.persistedMax) ?? 0;
  const stops = Array.isArray(raw?.stops) ? raw.stops.slice(0, LIMITS.devices) : [];
  for (const s of stops) {
    const atWall = recent(s?.at, wall, TIMINGS.stopKeep);
    if (
      atWall !== undefined &&
      isCookerId(s.cookerId) &&
      (s.family === FAMILIES.COOKER || s.family === FAMILIES.OVEN) &&
      (s.type === undefined || isDeviceType(s.type)) &&
      !memory.stops.some((o) => o.cookerId === s.cookerId)
    ) {
      memory.stops.push({
        cookerId: s.cookerId,
        family: s.family,
        type: s.type,
        at: atWall,
        sends: Number.isInteger(s.sends) && s.sends >= 0 ? Math.min(s.sends, TIMINGS.stopSends) : 0,
      });
    }
  }
  const startAt = recent(raw?.start?.at, wall, TIMINGS.persistedMax);
  if (startAt !== undefined && isCookerId(raw.start.cookerId)) {
    memory.start = { cookerId: raw.start.cookerId, at: startAt };
  }
  return memory;
}
