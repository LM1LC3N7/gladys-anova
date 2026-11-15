// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { LIMITS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  allow_start: false,
  stop_at_timer_end: false,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

/** A personal access token: `anova-` then printable ASCII without spaces, bounded. */
const TOKEN = /^anova-[\x21-\x7e]+$/;

/**
 * The mark of a REFUSED token kept in /data: 8 bits of its SHA-256 only, so
 * the file never helps to find the token. A new token is recognised in
 * memory (configUpdated); after a restart, a new token that happens to share
 * the 8 bits (1 in 256) waits for the "Test the connection" button.
 */
export const refusedMark = (token) => createHash('sha256').update(token).digest('hex').slice(0, 2);

/** A boolean field: only `true` (or the strings Gladys may send) turns it on. */
const flag = (value) => value === true || value === 'true' || value === 1 || value === '1';

export function normalizeConfig(raw = {}) {
  const typed = typeof raw?.token === 'string' ? raw.token.trim() : '';
  const valid = typed.length <= LIMITS.tokenLength && TOKEN.test(typed);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    token: valid ? typed : '',
    /** Something was typed, but it is not a personal access token. */
    tokenInvalid: typed !== '' && !valid,
    allowStart: flag(raw?.allow_start),
    stopAtTimerEnd: flag(raw?.stop_at_timer_end),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
