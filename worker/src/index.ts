/**
 * habit-chain Worker — 전면 HTMX.
 *
 * 예전에는 브라우저의 wasm이 화면을 그리고 DoltHub를 직접 읽었다.
 * 이제 읽기·쓰기·렌더링이 전부 여기 있고, 브라우저는 htmx가 조각을 갈아끼우기만 한다.
 * 그 덕에 DoltHub의 CORS 동작에 기대는 부분이 사라졌고 DB 이름도 밖으로 나가지 않는다.
 *
 * 시크릿:
 *   DOLTHUB_TOKEN — DoltHub → Settings → Tokens 에서 발급
 *   WRITE_KEY     — 설정에 넣는 공유 비밀. 없으면 쓰기를 아무나 할 수 있다.
 * 변수:
 *   ALLOWED_DB    — 읽고 쓸 DB. 첫 항목을 쓴다.
 *   DOLT_BRANCH   — 기본 main
 */

import * as dolt from "./dolt";
import { isDateStr } from "./model";
import type { Habit } from "./model";
import { renderError, renderHabits, shell } from "./render";

interface Env {
  ASSETS: Fetcher;
  DOLTHUB_TOKEN?: string;
  WRITE_KEY?: string;
  ALLOWED_DB?: string;
  DOLT_BRANCH?: string;
}

const HTML = { "Content-Type": "text/html; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
      return new Response(shell(), { headers: HTML });
    }
    if (path === "/api/health") {
      return json({
        ok: true,
        db: dbOf(env),
        branch: env.DOLT_BRANCH || "main",
        writeConfigured: Boolean(env.DOLTHUB_TOKEN),
        requiresKey: Boolean(env.WRITE_KEY),
      });
    }
    if (path === "/schema.sql") {
      return new Response(dolt.SCHEMA_SQL, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    try {
      if (path === "/habits" && request.method === "GET") {
        return await handleList(request, env);
      }
      if (path === "/habits" && request.method === "POST") {
        return await handleAdd(request, env);
      }
      if (path === "/export" && request.method === "GET") {
        return await handleExport(env);
      }

      const toggle = /^\/habits\/([^/]+)\/toggle$/.exec(path);
      if (toggle && request.method === "POST") {
        return await handleToggle(request, env, decodeURIComponent(toggle[1]!), url);
      }

      const habit = /^\/habits\/([^/]+)$/.exec(path);
      if (habit && request.method === "DELETE") {
        return await handleDelete(request, env, decodeURIComponent(habit[1]!));
      }
    } catch (err) {
      // 조각을 요청한 것이니 오류도 조각으로 돌려준다. 그래야 화면에 보인다.
      return new Response(renderError(message(err)), { status: 502, headers: HTML });
    }

    return env.ASSETS.fetch(request);
  },
};

// ── 핸들러 ─────────────────────────────────────────────

async function handleList(request: Request, env: Env): Promise<Response> {
  const state = await dolt.pull(dbOf(env), branchOf(env));
  return new Response(renderHabits(state, todayOf(request)), { headers: HTML });
}

async function handleAdd(request: Request, env: Env): Promise<Response> {
  const guard = requireWrite(request, env);
  if (guard) return guard;

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (name === "") {
    return fragment(renderError("습관 이름을 넣으세요."), 400);
  }

  const habit: Habit = {
    id: crypto.randomUUID(),
    name: name.slice(0, 60),
    color: normalizeColor(String(form.get("color") ?? "")),
    created_at: new Date().toISOString(),
    archived: false,
  };

  await dolt.write(env.DOLTHUB_TOKEN!, dbOf(env), branchOf(env), [dolt.upsertHabit(habit)]);
  return await handleList(request, env);
}

async function handleToggle(
  request: Request,
  env: Env,
  habitID: string,
  url: URL,
): Promise<Response> {
  const guard = requireWrite(request, env);
  if (guard) return guard;

  const date = url.searchParams.get("date");
  if (!isDateStr(date)) {
    return fragment(renderError(`날짜 형식이 올바르지 않습니다: ${date}`), 400);
  }
  const today = todayOf(request);
  if (date > today) {
    return fragment(renderError("아직 오지 않은 날은 체크할 수 없습니다."), 400);
  }

  // 지금 켜져 있는지는 원본을 보고 정한다. 화면이 오래됐을 수 있기 때문이다.
  const state = await dolt.pull(dbOf(env), branchOf(env));
  const on = state.checks.some((c) => c.habit_id === habitID && c.date === date);
  const stmt = on ? dolt.deleteCheck(habitID, date) : dolt.insertCheck(habitID, date);

  await dolt.write(env.DOLTHUB_TOKEN!, dbOf(env), branchOf(env), [stmt]);

  // 방금 쓴 것을 다시 읽지 않고 손에 든 상태를 고쳐서 그린다. 왕복 하나를 아낀다.
  state.checks = on
    ? state.checks.filter((c) => !(c.habit_id === habitID && c.date === date))
    : [...state.checks, { habit_id: habitID, date, note: "" }];

  return new Response(renderHabits(state, today), { headers: HTML });
}

async function handleDelete(request: Request, env: Env, habitID: string): Promise<Response> {
  const guard = requireWrite(request, env);
  if (guard) return guard;

  await dolt.write(env.DOLTHUB_TOKEN!, dbOf(env), branchOf(env), dolt.deleteHabit(habitID));
  return await handleList(request, env);
}

async function handleExport(env: Env): Promise<Response> {
  const state = await dolt.pull(dbOf(env), branchOf(env));
  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(state, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="habit-chain-${day}.json"`,
    },
  });
}

// ── 거들기 ─────────────────────────────────────────────

function dbOf(env: Env): string {
  return (env.ALLOWED_DB || "").split(",")[0]?.trim() || "";
}

function branchOf(env: Env): string {
  return env.DOLT_BRANCH || "main";
}

/**
 * todayOf는 사용자의 오늘이 언제인지 정한다.
 *
 * 서버에는 사용자의 시간대가 없다. UTC로 정하면 KST 사용자는 오전 9시 전까지
 * 어제 칸에 체크가 들어간다 — 습관 추적기에서 그건 사슬이 끊긴 것으로 보인다.
 * 그래서 브라우저가 헤더로 보내 준 로컬 날짜를 쓰고, 없을 때만 UTC로 떨어진다.
 */
function todayOf(request: Request): string {
  const sent = request.headers.get("X-Local-Date");
  return isDateStr(sent) ? sent : new Date().toISOString().slice(0, 10);
}

/** 쓰기 요청이 통과해도 되는지 본다. 통과하면 null을 돌려준다. */
function requireWrite(request: Request, env: Env): Response | null {
  if (!dbOf(env)) {
    return fragment(renderError("이 서버에 ALLOWED_DB가 설정되지 않았습니다."), 501);
  }
  if (!env.DOLTHUB_TOKEN) {
    return fragment(renderError("이 서버에 DOLTHUB_TOKEN 시크릿이 설정되지 않았습니다."), 501);
  }
  if (env.WRITE_KEY && request.headers.get("X-Write-Key") !== env.WRITE_KEY) {
    return fragment(renderError("쓰기 키가 맞지 않습니다. 설정에서 넣어 주세요."), 401);
  }
  return null;
}

function fragment(html: string, status: number): Response {
  return new Response(html, { status, headers: HTML });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 색은 화면에 style로 들어간다. #rrggbb 말고는 받지 않는다. */
function normalizeColor(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#f97316";
}
