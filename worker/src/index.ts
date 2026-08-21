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
import { compute, datesOf, isDateStr } from "./model";
import type { Habit, State } from "./model";
import { renderDay, renderError, renderHabits, renderLive, renderOneCard, renderToast, shell } from "./render";

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

    const isList = path === "/habits" && request.method === "GET";

    try {
      if (isList) {
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
      // 목록을 못 불러왔으면 보여줄 게 없으니 화면 전체가 오류다.
      // 쓰기가 실패한 경우는 다르다 — 화면에 있던 기록은 여전히 유효하다.
      return isList
        ? new Response(renderError(message(err)), { status: 502, headers: HTML })
        : toast(message(err), 502);
    }

    return env.ASSETS.fetch(request);
  },
};

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
    return toast("습관 이름을 넣으세요.", 400);
  }

  const habit: Habit = {
    id: crypto.randomUUID(),
    name: name.slice(0, 60),
    color: normalizeColor(String(form.get("color") ?? "")),
    created_at: new Date().toISOString(),
    archived: false,
  };

  await dolt.write(env.DOLTHUB_TOKEN!, dbOf(env), branchOf(env), [dolt.upsertHabit(habit)]);

  const today = todayOf(request);
  const state = await dolt.pull(dbOf(env), branchOf(env));
  return new Response(renderHabits(state, today) + renderLive(`${habit.name} 추가됨.`), {
    headers: HTML,
  });
}

/**
 * handleToggle은 카드 하나만 돌려준다.
 *
 * 예전에는 목록 전체를 다시 그렸다. 칸 하나 누를 때마다 화면이 통째로 갈리고
 * 포커스도 날아갔다. 이제 바뀐 카드만 바꾸고, 상단의 오늘 요약은
 * hx-swap-oob으로 따라 바뀐다.
 */
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
    return toast(`날짜 형식이 올바르지 않습니다: ${date}`, 400);
  }
  const today = todayOf(request);
  if (date > today) {
    return toast("아직 오지 않은 날은 체크할 수 없습니다.", 400);
  }

  const state = await dolt.pull(dbOf(env), branchOf(env));

  // 다른 기기에서 지운 습관을 여기서 눌렀을 때. 카드 자리에 목록 전체를 끼워
  // 넣을 수는 없으니, 목적지를 목록으로 돌려 통째로 다시 그린다.
  if (!state.habits.some((h) => h.id === habitID)) {
    return new Response(renderHabits(state, today), {
      headers: { ...HTML, "HX-Retarget": "#habits", "HX-Reswap": "innerHTML" },
    });
  }

  const on = state.checks.some((c) => c.habit_id === habitID && c.date === date);
  const stmt = on ? dolt.deleteCheck(habitID, date) : dolt.insertCheck(habitID, date);

  await dolt.write(env.DOLTHUB_TOKEN!, dbOf(env), branchOf(env), [stmt]);

  state.checks = on
    ? state.checks.filter((c) => !(c.habit_id === habitID && c.date === date))
    : [...state.checks, { habit_id: habitID, date, note: "" }];

  const body =
    renderOneCard(state, habitID, today) +
    renderDay(state, today, true) +
    renderLive(announce(state, habitID, date, on, today));

  return new Response(body, { headers: HTML });
}

async function handleDelete(request: Request, env: Env, habitID: string): Promise<Response> {
  const guard = requireWrite(request, env);
  if (guard) return guard;

  await dolt.write(env.DOLTHUB_TOKEN!, dbOf(env), branchOf(env), dolt.deleteHabit(habitID));

  const state = await dolt.pull(dbOf(env), branchOf(env));
  return new Response(renderHabits(state, todayOf(request)) + renderLive("습관을 삭제했습니다."), {
    headers: HTML,
  });
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

/** 스크린 리더에 읽어 줄 한 줄. 화면에서는 색과 모양이 하는 말이다. */
function announce(state: State, habitID: string, date: string, wasOn: boolean, today: string): string {
  const name = state.habits.find((h) => h.id === habitID)?.name ?? "습관";
  const days = compute(datesOf(state, habitID), today).current;
  return `${name} ${date} ${wasOn ? "체크 해제" : "체크"}. 현재 ${days}일째.`;
}

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
    return toast("이 서버에 ALLOWED_DB가 설정되지 않았습니다.", 501);
  }
  if (!env.DOLTHUB_TOKEN) {
    return toast("이 서버에 DOLTHUB_TOKEN 시크릿이 설정되지 않았습니다.", 501);
  }
  if (env.WRITE_KEY && request.headers.get("X-Write-Key") !== env.WRITE_KEY) {
    return toast("쓰기 키가 맞지 않습니다. 설정에서 넣어 주세요.", 401);
  }
  return null;
}

/**
 * toast는 쓰기 실패를 알린다.
 *
 * HX-Retarget으로 목적지를 #toast로 돌린다. 그러지 않으면 오류 문구가
 * 원래 목표였던 카드나 목록 자리에 들어가 앉아, 화면에 있던 기록을 지워 버린다.
 */
function toast(msg: string, status: number): Response {
  return new Response(renderToast(msg), {
    status,
    headers: { ...HTML, "HX-Retarget": "#toast", "HX-Reswap": "innerHTML" },
  });
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
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#e2542f";
}
