// Time helpers.
//
// Two jobs live here:
//   1. parseTimeInput() turns what a human types into the Seek box into seconds.
//   2. formatDuration() turns seconds into the "MM:SS" / "HH:MM:SS" string we
//      print on the control panel.
//
// Both are pure functions with no dependencies, which is why they are easy to
// unit test.

/**
 * Parse a human typed time string into whole seconds.
 *
 * Accepted shapes (the spec asks for these three, plus a couple of extras):
 *   "90"        -> 90            plain seconds
 *   "1:30"      -> 90            MM:SS
 *   "01:02:03"  -> 3723          HH:MM:SS
 *   "1:2:3"     -> 3723          sloppy but allowed
 *   "1h2m3s"    -> 3723          suffix form, handy to type
 *   "90s"       -> 90
 *   " 1:30 "    -> 90            surrounding spaces are trimmed
 *
 * @param {string|number} input raw text from the modal
 * @returns {{ ok: true, seconds: number } | { ok: false, error: string }}
 */
export function parseTimeInput(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      return { ok: false, error: 'Time must be a positive number.' };
    }
    return { ok: true, seconds: Math.floor(input) };
  }
  if (typeof input !== 'string') {
    return { ok: false, error: 'Time must be text like 90, 1:30 or 01:02:03.' };
  }

  const text = input.trim().toLowerCase();
  if (!text) return { ok: false, error: 'Time cannot be empty.' };

  // Suffix form: 1h2m3s / 90s / 5m
  if (/^[0-9hms\s]+$/.test(text) && /[hms]/.test(text)) {
    let total = 0;
    let matched = false;
    for (const m of text.matchAll(/(\d+)\s*([hms])/g)) {
      const n = Number(m[1]);
      const unit = m[2];
      total += unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
      matched = true;
    }
    if (!matched) return { ok: false, error: 'Could not read that time.' };
    return { ok: true, seconds: total };
  }

  // Colon form: S, MM:SS or HH:MM:SS
  if (!/^[0-9]+(:[0-9]+){0,2}$/.test(text)) {
    return { ok: false, error: 'Use 90, 1:30 or 01:02:03.' };
  }
  const parts = text.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) {
    return { ok: false, error: 'Use 90, 1:30 or 01:02:03.' };
  }

  let seconds = 0;
  if (parts.length === 1) {
    seconds = parts[0];
  } else if (parts.length === 2) {
    // MM:SS - the seconds slot must stay under 60, otherwise it is ambiguous.
    if (parts[1] >= 60) return { ok: false, error: 'Seconds must be below 60.' };
    seconds = parts[0] * 60 + parts[1];
  } else {
    // HH:MM:SS
    if (parts[1] >= 60) return { ok: false, error: 'Minutes must be below 60.' };
    if (parts[2] >= 60) return { ok: false, error: 'Seconds must be below 60.' };
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return { ok: true, seconds: Math.floor(seconds) };
}

/**
 * Format seconds as a clock string.
 * Under an hour we print MM:SS, above it HH:MM:SS.
 *
 * @param {number} totalSeconds
 * @returns {string} e.g. "00:42" or "1:02:03"
 */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/**
 * Validate a seek target against the real episode length.
 * Discord users can only seek inside the episode, and we refuse to seek to the
 * exact end because that would instantly finish the stream.
 *
 * @param {number} seconds requested position
 * @param {number} durationSeconds episode length (0/unknown disables the check)
 */
export function clampSeek(seconds, durationSeconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, error: 'Seek position must be 0 or more.' };
  }
  const dur = Number(durationSeconds);
  if (Number.isFinite(dur) && dur > 0) {
    if (seconds >= dur) {
      return {
        ok: false,
        error: `That is past the end of the episode (${formatDuration(dur)}).`,
      };
    }
  }
  return { ok: true, seconds: Math.floor(seconds) };
}
