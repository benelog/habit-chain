/**
 * DoltHub API access.
 *
 * Reads are a plain GET. Writes queue an operation and must be polled until it
 * finishes. Both live here, so nothing depends on DoltHub's CORS behaviour.
 */

import type { Check, Habit, State } from "./model";
import { sqlEscape } from "./model";

const API = "https://www.dolthub.com/api/v1alpha1";
const POLL_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 25_000;

/** Schema for a fresh DoltHub DB. */
export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS habits (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
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

/** What the DB looks like right now. Reads only — no token needed. */
export interface Shape {
  /** A DoltHub DB with zero commits has no main branch at all. */
  branch: boolean;
  habits: boolean;
  checks: boolean;
  description: boolean;
}

interface QueryResponse {
  query_execution_status?: string;
  query_execution_message?: string;
  rows?: Array<Record<string, unknown>>;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Runs a read query. db is "owner/name". */
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

/** Reads habits and checks. Queried in parallel — each takes ~0.9s. */
export async function pull(db: string, branch: string): Promise<State> {
  const [habitRes, checkRes] = await Promise.all([
    query(db, branch, "SELECT id, name, description, color, created_at, archived FROM habits ORDER BY created_at"),
    query(db, branch, "SELECT habit_id, check_date, note FROM checks ORDER BY check_date"),
  ]);

  const habits: Habit[] = (habitRes.rows ?? [])
    .map((r) => ({
      id: str(r["id"]),
      name: str(r["name"]),
      description: str(r["description"]),
      color: str(r["color"]) || "#f97316",
      created_at: str(r["created_at"]),
      // DoltHub returns BOOLEAN as 0/1 or "0"/"1".
      archived: r["archived"] === true || r["archived"] === 1 || r["archived"] === "1",
    }))
    .filter((h) => h.id !== "" && !h.archived);

  const checks: Check[] = (checkRes.rows ?? [])
    .map((r) => ({
      habit_id: str(r["habit_id"]),
      // A DATE column may arrive as "2026-08-21 00:00:00".
      date: str(r["check_date"]).slice(0, 10),
      note: str(r["note"]),
    }))
    .filter((c) => c.habit_id !== "" && c.date !== "");

  return { habits, checks };
}

// ── Writes ────────────────────────────────────────────

/**
 * SHOW TABLES keys its rows `Tables_in_<db>`, which differs per DB, so take the
 * value rather than look up a key. SHOW COLUMNS throws when the table is absent.
 */
export async function inspect(db: string, branch: string): Promise<Shape> {
  let res: QueryResponse;
  try {
    res = await query(db, branch, "SHOW TABLES");
  } catch (err) {
    // A brand-new DB: no commits, so no branch and nothing to read. That is a
    // starting point, not a fault — the caller shows setup, not an error.
    if (!isBranchMissing(err)) throw err;
    return { branch: false, habits: false, checks: false, description: false };
  }

  const tables = new Set(
    (res.rows ?? []).map((r) => str(Object.values(r)[0]).toLowerCase()),
  );

  const shape: Shape = {
    branch: true,
    habits: tables.has("habits"),
    checks: tables.has("checks"),
    description: false,
  };
  if (!shape.habits) return shape;

  const cols = await query(db, branch, "SHOW COLUMNS FROM habits");
  shape.description = (cols.rows ?? []).some(
    (r) => str(r["Field"]).toLowerCase() === "description",
  );
  return shape;
}

/**
 * Matching on the message is brittle, but the API offers no other way to tell
 * this state apart. A miss just falls through to the error screen.
 */
export function isBranchMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /branch not found/i.test(msg);
}

/**
 * Statements that bring this shape up to the current schema — only what is
 * missing. ALTER ADD COLUMN errors if the column exists, so idempotence comes
 * from inspecting again right before running, never from client-reported state.
 */
export function migrations(shape: Shape): string[] {
  const out: string[] = [];
  if (!shape.habits) {
    out.push(CREATE_HABITS);
  } else if (!shape.description) {
    out.push(ADD_DESCRIPTION);
  }
  if (!shape.checks) {
    out.push(CREATE_CHECKS);
  }
  return out;
}

const CREATE_HABITS = `CREATE TABLE habits (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  color VARCHAR(16) NOT NULL DEFAULT '#f97316',
  created_at VARCHAR(32) NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false
);`;

const CREATE_CHECKS = `CREATE TABLE checks (
  habit_id VARCHAR(36) NOT NULL,
  check_date DATE NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (habit_id, check_date)
);`;

// Dolt's parser rejects an AFTER clause, so column position is left unset.
const ADD_DESCRIPTION = `ALTER TABLE habits ADD COLUMN description VARCHAR(2000) NOT NULL DEFAULT '';`;

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
 * Applies one statement. The write endpoint is async: queue, then poll. A real
 * round trip is ~1.5-2s; POLL_TIMEOUT_MS is the pathological ceiling.
 *
 * Note: DoltHub commits even when a statement affects zero rows.
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

/** Applies statements in order, stopping at the first failure. */
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

// ── SQL builders ──────────────────────────────────────

export function upsertHabit(h: Habit): string {
  return (
    `INSERT INTO habits (id, name, description, color, created_at, archived) VALUES (` +
    `${sqlEscape(h.id)}, ${sqlEscape(h.name)}, ${sqlEscape(h.description)}, ${sqlEscape(h.color)}, ` +
    `${sqlEscape(h.created_at)}, false) ` +
    `ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), color = VALUES(color);`
  );
}

/**
 * Name and description only. upsertHabit would work but needs created_at, and a
 * stale value there silently rewrites when the habit was made.
 */
export function updateHabit(id: string, name: string, description: string): string {
  return (
    `UPDATE habits SET name = ${sqlEscape(name)}, description = ${sqlEscape(description)} ` +
    `WHERE id = ${sqlEscape(id)};`
  );
}

/**
 * Split into separate statements on purpose: the write endpoint takes one per
 * request, and two joined by a semicolon are rejected as a syntax error.
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
