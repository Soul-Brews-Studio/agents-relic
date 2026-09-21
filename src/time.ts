/**
 * One clock for everything a human reads.
 *
 * Transcripts store `timestamp` as ISO-8601 in UTC. relic stores that string verbatim —
 * which is right, because a stored local time is a stored lie the moment it crosses a
 * machine. But DISPLAY was slicing the ISO string directly in some commands and
 * converting to local in others, so `relic session` said the session began 10:06 while
 * `relic dig` said 17:06. Same session, same index, 7 hours apart, no label on either.
 *
 * The fleet has this exact bug on record elsewhere: an index whose beats are Bangkok
 * local but labelled Z, which invites a "correction" that doubles the error.
 *
 * The rule here:
 *   - human-facing output  -> LOCAL time, and the zone is named in the header
 *   - --json / --jsonl / --plain -> untouched ISO, because that is what machines diff
 *
 * Never store what these return, and never re-parse it.
 */

const p2 = (n: number) => String(n).padStart(2, "0");

/** The IANA zone the output is rendered in, e.g. "Asia/Bangkok". */
export function zoneName(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local"; }
  catch { return "local"; }
}

/** Short offset label, e.g. "+07". Cheap to print next to a time. */
export function zoneOffset(d = new Date()): string {
  const mins = -d.getTimezoneOffset();
  const sign = mins < 0 ? "-" : "+";
  const a = Math.abs(mins);
  const h = p2(Math.floor(a / 60)), m = a % 60;
  return m ? `${sign}${h}:${p2(m)}` : `${sign}${h}`;
}

function toDate(v: string | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

/** "2026-09-16 17:06" in local time. Falls back to the raw value if unparseable. */
export function localDateTime(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return typeof v === "string" ? v : "";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "17:06" in local time. */
export function localTime(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "";
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** "2026-09-16" in local time — used to decide whether a span crosses a day. */
export function localDate(v: string | number | null | undefined): string {
  const d = toDate(v);
  if (!d) return "";
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * "30.0h", "6m", "45s" — a duration a human reads at a glance, not a unit-converted
 * number. One decimal on hours only, because 30h and 30.4h are the same fact and
 * 45s and 45.3s are not worth the character.
 */
export function dur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * The shape of a run of turns: when it started, when it ended, and how the turns were
 * spaced. This is the arithmetic `relic tail --handoff` does so the NEXT session does
 * not have to — pacing is the intention signal, and a fresh model should be handed it,
 * not a column of timestamps to infer it from.
 *
 * MEDIAN and MAX, never mean. One overnight gap drags a mean far enough that a
 * hard-focused hour and a day of supervised parallel work report the same number. The
 * median survives that outlier; the max is the outlier, named.
 *
 * Returns null below two usable timestamps — a span needs two points, and inventing
 * one from a single turn would be a fabricated fact in a header meant to be trusted.
 */
export function handoffStats(stamps: (string | number | null | undefined)[]):
  { firstMs: number; lastMs: number; spanMs: number; medianGapMs: number; maxGapMs: number } | null {
  const ms = stamps
    .map(v => (typeof v === "number" ? v : v ? Date.parse(v) : NaN))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (ms.length < 2) return null;
  const gaps = ms.slice(1).map((t, i) => t - ms[i]).sort((a, b) => a - b);
  return {
    firstMs: ms[0], lastMs: ms[ms.length - 1], spanMs: ms[ms.length - 1] - ms[0],
    medianGapMs: gaps[Math.floor(gaps.length / 2)], maxGapMs: gaps[gaps.length - 1],
  };
}
