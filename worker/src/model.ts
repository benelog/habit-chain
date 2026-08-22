/**
 * Domain types and chain math. No network, no DOM — pure functions only.
 */

/** The app's date format, holding the user's local date. */
export type DateStr = string; // YYYY-MM-DD

export interface Habit {
  id: string;
  name: string;
  /** Multiline plain text. */
  description: string;
  color: string;
  created_at: string; // RFC3339
  archived: boolean;
}

export interface Check {
  habit_id: string;
  date: DateStr;
  note: string;
}

/**
 * The public page's heading, stored in the user's own DB — the only place a
 * token-less public read can reach.
 */
export interface Meta {
  /** e.g. "정상혁의 습관 달력". Empty falls back to the DB name. */
  title: string;
  description: string;
}

export function emptyMeta(): Meta {
  return { title: "", description: "" };
}

export interface State {
  habits: Habit[];
  checks: Check[];
  meta: Meta;
}

/** Chain metrics for one habit. */
export interface Stats {
  current: number; // days running up to today (or yesterday)
  longest: number; // longest run ever
  total: number; // total checks
  rate30: number; // last-30-day completion (%)
}

// ── Dates ─────────────────────────────────────────────
//
// Everything is counted at UTC midnight. The server has no user timezone, and
// UTC has no DST, so "add a day" is always exactly 86400s. Local-time math
// loses or repeats a day wherever DST applies.

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD" → epoch ms at UTC midnight. */
export function toEpoch(d: DateStr): number {
  return Date.parse(`${d}T00:00:00Z`);
}

/** epoch ms → "YYYY-MM-DD". */
export function toDateStr(ms: number): DateStr {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Adds n days; negative subtracts. */
export function addDays(d: DateStr, n: number): DateStr {
  return toDateStr(toEpoch(d) + n * DAY_MS);
}

/** Day of week, 0 = Sunday. */
export function dayOfWeek(d: DateStr): number {
  return new Date(toEpoch(d)).getUTCDay();
}

/** Client-sent dates are not trusted. */
export function isDateStr(s: unknown): s is DateStr {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toEpoch(s));
}

// ── User-supplied values ──────────────────────────────
//
// DB name and token come from browser settings via headers. Neither is trusted.

/** "owner/name", restricted to characters DoltHub names use. */
export function isDbName(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/.test(s);
}

/**
 * Checks the token is header-safe, not that it is valid — only DoltHub knows
 * that. A newline slipping in would forge the request.
 */
export function isToken(s: unknown): s is string {
  return typeof s === "string" && /^[\x21-\x7e]{8,256}$/.test(s);
}

/** A colour lands in a style attribute; #rrggbb only. */
export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

// ── Chain math ────────────────────────────────────────

/**
 * The chain survives an unchecked today as long as yesterday is filled; only a
 * whole missed day breaks it. That is the don't-break-the-chain rule.
 */
export function computeStats(dates: DateStr[], today: DateStr): Stats {
  if (dates.length === 0) {
    return { current: 0, longest: 0, total: 0, rate30: 0 };
  }

  const set = new Set(dates);
  const sorted = [...set].sort();

  // Longest run: walk sorted dates, measuring day-apart stretches.
  let longest = 0;
  let run = 0;
  let prev = 0;
  for (const d of sorted) {
    const t = toEpoch(d);
    if (Number.isNaN(t)) continue;
    run = run > 0 && t === prev + DAY_MS ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = t;
  }

  // Current run: count backwards, starting at yesterday if today is empty.
  let cursor = set.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  let hit = 0;
  for (let i = 0; i < 30; i++) {
    if (set.has(addDays(today, -i))) hit++;
  }

  return { current, longest, total: set.size, rate30: Math.floor((hit * 100) / 30) };
}

/** Check dates for one habit. */
export function datesOf(state: State, habitID: string): DateStr[] {
  return state.checks.filter((c) => c.habit_id === habitID).map((c) => c.date);
}

/** Set for (habit_id, date) lookups. */
export function checkSet(state: State): Set<string> {
  return new Set(state.checks.map((c) => `${c.habit_id}|${c.date}`));
}

// ── Errors ────────────────────────────────────────────

/** Readable text out of a caught value — `catch` hands over `unknown`. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── SQL ───────────────────────────────────────────────

/** Quotes a string literal for SQL. */
export function sqlEscape(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
