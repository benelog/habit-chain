/**
 * DoltHub API 접근.
 *
 * 읽기와 쓰기가 서로 다른 엔드포인트를 쓴다. 읽기는 그냥 GET이고,
 * 쓰기는 작업을 걸어 두고 끝날 때까지 폴링해야 한다.
 *
 * 예전에는 읽기를 브라우저가 직접 했다. 전면 HTMX로 옮기면서 둘 다 이리로 왔고,
 * 그래서 DoltHub의 CORS 동작에 기대는 부분이 아예 사라졌다.
 */

import type { Check, Habit, State } from "./model";
import { sqlEscape } from "./model";

const API = "https://www.dolthub.com/api/v1alpha1";
const POLL_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 25_000;

/** 새 DoltHub DB를 초기화하는 스키마. */
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS habits (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#f97316',
  created_at VARCHAR(32) NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS checks (
  habit_id VARCHAR(36) NOT NULL,
  check_date DATE NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (habit_id, check_date)
);`;

interface QueryResponse {
  query_execution_status?: string;
  query_execution_message?: string;
  rows?: Array<Record<string, unknown>>;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/** 읽기 SQL을 던진다. db는 "owner/name" 형식이다. */
async function query(db: string, branch: string, q: string): Promise<QueryResponse> {
  const [owner, name] = db.split("/");
  if (!owner || !name) {
    throw new Error(`DB 이름은 owner/name 형식이어야 합니다: ${db}`);
  }

  const url =
    `${API}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/${encodeURIComponent(branch || "main")}?q=${encodeURIComponent(q)}`;

  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DoltHub ${res.status}: ${text.slice(0, 200)}`);
  }

  let body: QueryResponse;
  try {
    body = JSON.parse(text) as QueryResponse;
  } catch {
    throw new Error(`DoltHub 응답을 해석하지 못했습니다: ${text.slice(0, 200)}`);
  }
  if (body.query_execution_status && body.query_execution_status !== "Success") {
    throw new Error(body.query_execution_message || body.query_execution_status);
  }
  return body;
}

/**
 * pull은 습관과 기록을 통째로 읽어 온다.
 *
 * 두 질의를 나란히 던진다. 하나에 ~0.9초가 걸리므로 줄세우면 그대로 두 배가 된다.
 */
export async function pull(db: string, branch: string): Promise<State> {
  const [habitRes, checkRes] = await Promise.all([
    query(db, branch, "SELECT id, name, color, created_at, archived FROM habits ORDER BY created_at"),
    query(db, branch, "SELECT habit_id, check_date, note FROM checks ORDER BY check_date"),
  ]);

  const habits: Habit[] = (habitRes.rows ?? [])
    .map((r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      color: str(r["color"]) || "#f97316",
      created_at: str(r["created_at"]),
      // DoltHub는 BOOLEAN을 0/1이나 "0"/"1"로 돌려준다.
      archived: r["archived"] === true || r["archived"] === 1 || r["archived"] === "1",
    }))
    .filter((h) => h.id !== "" && !h.archived);

  const checks: Check[] = (checkRes.rows ?? [])
    .map((r) => ({
      habit_id: str(r["habit_id"]),
      // DATE 컬럼이 "2026-08-21 00:00:00" 같은 형태로 올 수 있다.
      date: str(r["check_date"]).slice(0, 10),
      note: str(r["note"]),
    }))
    .filter((c) => c.habit_id !== "" && c.date !== "");

  return { habits, checks };
}

// ── 쓰기 ───────────────────────────────────────────────

async function doltFetch(url: string, token: string, method: "GET" | "POST"): Promise<any> {
  const res = await fetch(url, { method, headers: { authorization: `token ${token}` } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DoltHub ${res.status}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`DoltHub 응답을 해석하지 못했습니다: ${text.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * runStatement는 문장 하나를 반영한다.
 *
 * 쓰기 엔드포인트는 비동기다. 작업을 걸고 끝날 때까지 기다린다.
 * 실제 왕복은 대략 1.5~2초이고, POLL_TIMEOUT_MS는 그게 아니라 병리적 상황의 상한이다.
 *
 * 주의: DoltHub는 0건에 영향을 준 문장에도 커밋을 만든다. 조건에 맞는 행이
 * 없더라도 히스토리에는 빈 커밋이 남는다.
 */
async function runStatement(
  token: string,
  db: string,
  branch: string,
  stmt: string,
): Promise<void> {
  const [owner, name] = db.split("/");
  const b = encodeURIComponent(branch || "main");
  const base = `${API}/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;

  const start = await doltFetch(`${base}/write/${b}/${b}?q=${encodeURIComponent(stmt)}`, token, "POST");
  const op = start.operation_name;
  if (!op) {
    throw new Error(start.query_execution_message || JSON.stringify(start).slice(0, 200));
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await doltFetch(`${base}/write?operationName=${encodeURIComponent(op)}`, token, "GET");
    if (res.done) {
      const details = res.res_details ?? {};
      const status = details.query_execution_status;
      if (status && status !== "Success") {
        throw new Error(details.query_execution_message || status);
      }
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`작업이 ${POLL_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다`);
}

/** 문장들을 차례로 반영한다. 하나라도 실패하면 거기서 멈추고 던진다. */
export async function write(
  token: string,
  db: string,
  branch: string,
  stmts: string[],
): Promise<void> {
  for (const stmt of stmts) {
    await runStatement(token, db, branch, stmt);
  }
}

// ── SQL 만들기 ─────────────────────────────────────────

export function upsertHabit(h: Habit): string {
  return (
    `INSERT INTO habits (id, name, color, created_at, archived) VALUES (` +
    `${sqlEscape(h.id)}, ${sqlEscape(h.name)}, ${sqlEscape(h.color)}, ` +
    `${sqlEscape(h.created_at)}, false) ` +
    `ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color);`
  );
}

/**
 * deleteHabit은 습관과 그 기록을 지우는 문장들을 만든다.
 *
 * 반드시 문장을 나눠서 돌려준다. DoltHub 쓰기 엔드포인트는 한 요청에
 * 문장 하나만 받는다 — 두 개를 세미콜론으로 이어 보내면
 * "Error parsing SQL: syntax error" 로 통째로 거부당한다.
 */
export function deleteHabit(id: string): string[] {
  return [
    `DELETE FROM checks WHERE habit_id = ${sqlEscape(id)};`,
    `DELETE FROM habits WHERE id = ${sqlEscape(id)};`,
  ];
}

export function insertCheck(habitID: string, date: string): string {
  return `INSERT IGNORE INTO checks (habit_id, check_date, note) VALUES (${sqlEscape(habitID)}, ${sqlEscape(date)}, '');`;
}

export function deleteCheck(habitID: string, date: string): string {
  return `DELETE FROM checks WHERE habit_id = ${sqlEscape(habitID)} AND check_date = ${sqlEscape(date)};`;
}
