/**
 * DoltHub API access.
 *
 * Reads are a plain GET. Writes queue an operation and must be polled until it
 * finishes. Both live here, so nothing depends on DoltHub's CORS behaviour.
 */

import type { Check, Habit, Meta, State } from "./model";
import { emptyMeta, sqlEscape } from "./model";

const API = "https://www.dolthub.com/api/v1alpha1";
// v2 is used only where v1alpha1 has no documented equivalent (token check).
// The SQL read/write paths stay on v1alpha1: the DB-prepare flow leans on its
// verified-but-undocumented write behaviour, and v1alpha1 is not deprecated.
const API_V2 = "https://www.dolthub.com/api/v2";
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
);

CREATE TABLE IF NOT EXISTS meta (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v VARCHAR(2000) NOT NULL DEFAULT ''
);`;

/** What the DB looks like right now. Reads only — no token needed. */
export interface Shape {
  /** A DoltHub DB with zero commits has no main branch at all. */
  branch: boolean;
  habits: boolean;
  checks: boolean;
  description: boolean;
  meta: boolean;
}

interface QueryResponse {
  query_execution_status?: string;
  query_execution_message?: string;
  rows?: Array<Record<string, unknown>>;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Runs a read query. db is "owner/name". The token rides along when present so
 * private DBs are readable; DoltHub rejects a bad token even on public reads,
 * so a stale token surfaces here rather than at the first write.
 */
async function query(db: string, branch: string, token: string, q: string): Promise<QueryResponse> {
  const [owner, name] = db.split("/");
  if (!owner || !name) {
    throw new Error(`DB 이름은 owner/name 형식이어야 합니다: ${db}`);
  }

  const url =
    `${API}/${encodeURIComponent(owner)}/${encodeURIComponent(name)}` +
    `/${encodeURIComponent(branch || "main")}?q=${encodeURIComponent(q)}`;

  const res = await fetch(url, {
    headers: token === "" ? {} : { authorization: `token ${token}` },
  });
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

/** Reads habits, checks and meta. Queried in parallel — each takes ~0.9s. */
export async function pull(db: string, branch: string, token: string): Promise<State> {
  const [habitRes, checkRes, metaRes] = await Promise.all([
    query(db, branch, token, "SELECT id, name, description, color, created_at, archived FROM habits ORDER BY created_at"),
    query(db, branch, token, "SELECT habit_id, check_date, note FROM checks ORDER BY check_date"),
    // The meta table arrived in a later migration. A DB without it is still
    // fully usable, so its absence is tolerated here — failing would drag
    // every existing DB (and every public visitor) through the prepare screen.
    query(db, branch, token, "SELECT k, v FROM meta").catch((err) => {
      if (isTableMissing(err)) return { rows: [] } as QueryResponse;
      throw err;
    }),
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

  return { habits, checks, meta: metaOf(metaRes.rows ?? []) };
}

function metaOf(rows: Array<Record<string, unknown>>): Meta {
  const kv = new Map(rows.map((r) => [str(r["k"]), str(r["v"])]));
  return { title: kv.get("title") ?? "", description: kv.get("description") ?? "" };
}

/**
 * Meta alone, for the public page's <head>. Any failure — missing table,
 * private DB, DoltHub down — yields empty meta: the shell must still render,
 * and the list fragment surfaces the real error afterwards.
 */
export async function readMeta(db: string, branch: string): Promise<Meta> {
  try {
    const res = await query(db, branch, "", "SELECT k, v FROM meta");
    return metaOf(res.rows ?? []);
  } catch {
    return emptyMeta();
  }
}

// ── Writes ────────────────────────────────────────────

/**
 * SHOW TABLES keys its rows `Tables_in_<db>`, which differs per DB, so take the
 * value rather than look up a key. SHOW COLUMNS throws when the table is absent.
 */
export async function inspect(db: string, branch: string, token: string): Promise<Shape> {
  let res: QueryResponse;
  try {
    res = await query(db, branch, token, "SHOW TABLES");
  } catch (err) {
    // A brand-new DB: no commits, so no branch and nothing to read. That is a
    // starting point, not a fault — the caller shows setup, not an error.
    if (!isBranchMissing(err)) throw err;
    return { branch: false, habits: false, checks: false, description: false, meta: false };
  }

  const tables = new Set(
    (res.rows ?? []).map((r) => str(Object.values(r)[0]).toLowerCase()),
  );

  const shape: Shape = {
    branch: true,
    habits: tables.has("habits"),
    checks: tables.has("checks"),
    description: false,
    meta: tables.has("meta"),
  };
  if (!shape.habits) return shape;

  const cols = await query(db, branch, token, "SHOW COLUMNS FROM habits");
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
 * DoltHub's two ways of saying the auth header is no good — malformed, and
 * well-formed but unknown (revoked, mistyped). Both observed 2026-08 on the
 * v1alpha1 read endpoint. Same caveat as isBranchMissing: message matching is
 * brittle, and a miss just shows the raw error instead of the friendly one.
 */
/**
 * "table not found: meta" — how Dolt reports a query against a table that a
 * later migration adds. Same message-matching caveat as isBranchMissing.
 */
export function isTableMissing(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /table not found/i.test(msg);
}

export function isTokenRejected(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid authorization header|no token found for given api token/i.test(msg);
}

/**
 * What DoltHub said about a token, kept as three states on purpose: a DoltHub
 * outage or network failure must not read as "your token is wrong".
 */
export type TokenCheck =
  | { state: "valid" }
  | { state: "invalid"; detail: string }
  | { state: "unknown"; detail: string };

/**
 * Asks DoltHub whether the token identifies anyone, via the documented v2
 * /user endpoint (v1alpha1 has no documented equivalent). Any 2xx counts as
 * valid — the body is not parsed, so a shape change cannot fail a good token.
 */
export async function verifyToken(token: string): Promise<TokenCheck> {
  let res: Response;
  try {
    res = await fetch(`${API_V2}/user`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (err) {
    return {
      state: "unknown",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.ok) return { state: "valid" };

  // Errors follow RFC 9457: the human-readable part sits in `detail`.
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    detail = String((JSON.parse(text) as { detail?: unknown }).detail ?? "");
  } catch {
    // Not JSON; fall through to the raw text.
  }
  detail = detail || text.slice(0, 200);

  if (res.status === 401 || res.status === 403) {
    return { state: "invalid", detail };
  }
  return { state: "unknown", detail: `DoltHub ${res.status}: ${detail}` };
}

/**
 * Ordered migrations, golang-migrate style: the list only grows, and ids give
 * the dependency order. Two departures, both forced by this setup:
 *
 * - No version table. The user can edit the schema on the DoltHub site, and
 *   the write endpoint has no transactions, so a recorded version could drift
 *   from the real schema. Each migration instead checks the inspected shape —
 *   the real schema is the only record.
 * - CREATE statements are snapshots of the current schema, so a fresh DB does
 *   not replay old ALTERs. Every statement is one write, one commit, ~2s.
 */
export interface Migration {
  /** Sequence number. The array stays sorted by it; ids are never reused. */
  id: number;
  name: string;
  /** One statement — the write endpoint takes one per request. */
  statement: string;
  /** Whether the inspected schema already holds this migration's result. */
  applied: (shape: Shape) => boolean;
}

/**
 * Unapplied statements, in list order. ALTER ADD COLUMN errors if the column
 * exists, so idempotence comes from inspecting again right before running,
 * never from client-reported state.
 */
export function migrations(shape: Shape): string[] {
  return MIGRATIONS.filter((m) => !m.applied(shape)).map((m) => m.statement);
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

/** Exported: the meta save creates this table on demand for older DBs. */
export const CREATE_META = `CREATE TABLE meta (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v VARCHAR(2000) NOT NULL DEFAULT ''
);`;

export const MIGRATIONS: Migration[] = [
  { id: 1, name: "create-habits", statement: CREATE_HABITS, applied: (s) => s.habits },
  { id: 2, name: "create-checks", statement: CREATE_CHECKS, applied: (s) => s.checks },
  {
    id: 3,
    name: "habits-description",
    statement: ADD_DESCRIPTION,
    // Covered by create-habits on a fresh DB: the snapshot already has it.
    applied: (s) => !s.habits || s.description,
  },
  { id: 4, name: "create-meta", statement: CREATE_META, applied: (s) => s.meta },
];

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

/** Both keys in one statement — the write endpoint commits per request. */
export function upsertMeta(meta: Meta): string {
  return (
    `INSERT INTO meta (k, v) VALUES ` +
    `('title', ${sqlEscape(meta.title)}), ('description', ${sqlEscape(meta.description)}) ` +
    `ON DUPLICATE KEY UPDATE v = VALUES(v);`
  );
}

export function insertCheck(habitID: string, date: string): string {
  return `INSERT IGNORE INTO checks (habit_id, check_date, note) VALUES (${sqlEscape(habitID)}, ${sqlEscape(date)}, '');`;
}

export function deleteCheck(habitID: string, date: string): string {
  return `DELETE FROM checks WHERE habit_id = ${sqlEscape(habitID)} AND check_date = ${sqlEscape(date)};`;
}
