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
