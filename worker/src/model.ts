/**
 * habit-chain의 도메인 타입과 사슬 계산.
 *
 * 이 파일에는 네트워크도 DOM도 없다. 순수 함수뿐이라 vitest로 그냥 돈다.
 */

/** 앱 전체가 쓰는 날짜 표기. 사용자의 로컬 날짜를 이 형식으로 담는다. */
export type DateStr = string; // YYYY-MM-DD

export interface Habit {
  id: string;
  name: string;
  color: string;
  created_at: string; // RFC3339
  archived: boolean;
}

export interface Check {
  habit_id: string;
  date: DateStr;
  note: string;
}

export interface State {
  habits: Habit[];
  checks: Check[];
}

/** 하나의 습관에 대한 사슬 지표. */
export interface Stats {
  current: number; // 오늘(또는 어제)까지 이어진 연속 일수
  longest: number; // 역대 최장 연속 일수
  total: number; // 전체 체크 수
  rate30: number; // 최근 30일 달성률(%)
}

// ── 날짜 계산 ──────────────────────────────────────────
//
// 전부 UTC 자정으로 환산해서 센다. 서버에는 사용자의 시간대가 없고,
// UTC에는 서머타임이 없어 "하루 더하기"가 언제나 정확히 86400초다.
// 로컬 시간으로 계산하면 서머타임이 있는 지역에서 하루가 사라지거나 겹친다.

const DAY_MS = 86_400_000;

/** "YYYY-MM-DD"를 UTC 자정의 epoch 밀리초로 바꾼다. */
export function toEpoch(d: DateStr): number {
  return Date.parse(`${d}T00:00:00Z`);
}

/** epoch 밀리초를 "YYYY-MM-DD"로 되돌린다. */
export function toDateStr(ms: number): DateStr {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 날짜에 n일을 더한다. n이 음수면 뺀다. */
export function addDays(d: DateStr, n: number): DateStr {
  return toDateStr(toEpoch(d) + n * DAY_MS);
}

/** 날짜의 요일. 0이 일요일이다. */
export function dayOfWeek(d: DateStr): number {
  return new Date(toEpoch(d)).getUTCDay();
}

/** "YYYY-MM-DD" 형식인지 본다. 클라이언트가 보낸 날짜를 그대로 믿지 않기 위해서다. */
export function isDateStr(s: unknown): s is DateStr {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toEpoch(s));
}

// ── 사슬 계산 ──────────────────────────────────────────

/**
 * compute는 today를 기준으로 사슬 지표를 낸다.
 *
 * 오늘 아직 체크하지 않았어도 어제까지 이어져 있으면 사슬은 살아 있는 것으로 본다.
 * 하루를 통째로 놓쳐야 끊어진다 — 이게 don't break the chain의 규칙이다.
 */
export function compute(dates: DateStr[], today: DateStr): Stats {
  if (dates.length === 0) {
    return { current: 0, longest: 0, total: 0, rate30: 0 };
  }

  const set = new Set(dates);
  const sorted = [...set].sort();

  // 최장 연속: 정렬된 날짜를 훑으며 하루 간격이 유지되는 구간을 잰다.
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

  // 현재 연속: 오늘부터 거꾸로 센다. 오늘이 비었으면 어제부터 시작.
  let cursor = set.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (set.has(cursor)) {
    current++;
    cursor = addDays(cursor, -1);
  }

  // 최근 30일 달성률.
  let hit = 0;
  for (let i = 0; i < 30; i++) {
    if (set.has(addDays(today, -i))) hit++;
  }

  return { current, longest, total: set.size, rate30: Math.floor((hit * 100) / 30) };
}

/** 한 습관의 체크 날짜만 뽑는다. */
export function datesOf(state: State, habitID: string): DateStr[] {
  return state.checks.filter((c) => c.habit_id === habitID).map((c) => c.date);
}

/** (habit_id, date) 조회를 위한 집합을 만든다. */
export function checkSet(state: State): Set<string> {
  return new Set(state.checks.map((c) => `${c.habit_id}|${c.date}`));
}

// ── SQL ────────────────────────────────────────────────

/** 문자열 리터럴을 SQL에 넣을 수 있게 감싼다. */
export function sqlEscape(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
