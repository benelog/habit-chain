/**
 * habit-chain Worker — 전면 HTMX.
 *
 * 예전에는 브라우저의 wasm이 화면을 그리고 DoltHub를 직접 읽었다.
 * 이제 읽기·쓰기·렌더링이 전부 여기 있고, 브라우저는 htmx가 조각을 갈아끼우기만 한다.
 * 그 덕에 DoltHub의 CORS 동작에 기대는 부분이 사라졌고 DB 이름도 밖으로 나가지 않는다.
 *
 * DB와 토큰은 서버가 아니라 사용자가 가진다. 설정에 넣은 값이 요청마다 헤더로 온다:
 *   X-Dolt-DB     — owner/name. 없으면 읽을 곳이 없다. 목록 자리에 설정 안내가 대신 온다.
 *   X-Dolt-Token  — DoltHub → Settings → Tokens 에서 발급. 쓰기에만 쓴다.
 *
 * 서버에는 토큰이 없다. 그래서 공유 비밀(예전의 WRITE_KEY)로 쓰기를 막을 일도 없다 —
 * 자기 토큰을 넣은 사람이 자기 DB에 쓸 뿐이고, 남의 DB에는 애초에 쓸 수가 없다.
 *
 * 서버에는 기본 DB도 없다. 예전에는 설정이 빈 사람에게 남의 DB를 읽어 보여 줬는데,
 * 그러면 화면에 뜬 사슬이 누구 것인지가 불분명하고 체크는 또 안 된다.
 * 이제 DB가 없으면 사슬 대신 설정 안내가 뜬다.
 *
 * 변수:
 *   DOLT_BRANCH   — 기본 main
 */

import * as dolt from "./dolt";
import { compute, datesOf, isDateStr, isDbName, isToken } from "./model";
import type { Habit, State } from "./model";
import {
  renderDay,
  renderError,
  renderHabits,
  renderLive,
  renderOneCard,
  renderSetup,
  renderToast,
  shell,
} from "./render";

interface Env {
  ASSETS: Fetcher;
  DOLT_BRANCH?: string;
}

/** 이번 요청이 어느 DB를 어떤 자격으로 건드리는지. 헤더에서 만들어진다. */
interface Ctx {
  db: string;
  token: string;
  branch: string;
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
      return json({ ok: true, branch: env.DOLT_BRANCH || "main" });
    }
    if (path === "/schema.sql") {
      return new Response(dolt.SCHEMA_SQL, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const isList = path === "/habits" && request.method === "GET";
    const ctx = ctxOf(request, env);

    try {
      if (isList) {
        return await handleList(request, ctx);
      }
      if (path === "/habits" && request.method === "POST") {
        return await handleAdd(request, ctx);
      }
      if (path === "/export" && request.method === "GET") {
        return await handleExport(url, ctx);
      }

      const toggle = /^\/habits\/([^/]+)\/toggle$/.exec(path);
      if (toggle && request.method === "POST") {
        return await handleToggle(request, ctx, decodeURIComponent(toggle[1]!), url);
      }

      const habit = /^\/habits\/([^/]+)$/.exec(path);
      if (habit && request.method === "PUT") {
        return await handleEdit(request, ctx, decodeURIComponent(habit[1]!));
      }
      if (habit && request.method === "DELETE") {
        return await handleDelete(request, ctx, decodeURIComponent(habit[1]!));
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

async function handleList(request: Request, ctx: Ctx): Promise<Response> {
  // 설정이 비었다. 실패가 아니라 아직 시작하지 않은 것이라, 200에 안내를 담아 보낸다.
  if (ctx.db === "") {
    return new Response(renderSetup(), { headers: HTML });
  }

  // 목록이 실패하면 보여 줄 게 없다. 토스트가 아니라 화면 전체로 말한다.
  const problem = dbProblem(ctx);
  if (problem) {
    return new Response(renderError(problem), { status: 400, headers: HTML });
  }

  const state = await dolt.pull(ctx.db, ctx.branch);
  return new Response(renderHabits(state, todayOf(request)), { headers: HTML });
}

async function handleAdd(request: Request, ctx: Ctx): Promise<Response> {
  const guard = requireWrite(ctx);
  if (guard) return guard;

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (name === "") {
    return toast("습관 이름을 넣으세요.", 400);
  }

  const habit: Habit = {
    id: crypto.randomUUID(),
    name: name.slice(0, 60),
    description: normalizeDesc(String(form.get("description") ?? "")),
    color: normalizeColor(String(form.get("color") ?? "")),
    created_at: new Date().toISOString(),
    archived: false,
  };

  await dolt.write(ctx.token, ctx.db, ctx.branch, [dolt.upsertHabit(habit)]);

  const today = todayOf(request);
  const state = await dolt.pull(ctx.db, ctx.branch);
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
  ctx: Ctx,
  habitID: string,
  url: URL,
): Promise<Response> {
  const guard = requireWrite(ctx);
  if (guard) return guard;

  const date = url.searchParams.get("date");
  if (!isDateStr(date)) {
    return toast(`날짜 형식이 올바르지 않습니다: ${date}`, 400);
  }
  const today = todayOf(request);
  if (date > today) {
    return toast("아직 오지 않은 날은 체크할 수 없습니다.", 400);
  }

  const state = await dolt.pull(ctx.db, ctx.branch);

  // 다른 기기에서 지운 습관을 여기서 눌렀을 때. 카드 자리에 목록 전체를 끼워
  // 넣을 수는 없으니, 목적지를 목록으로 돌려 통째로 다시 그린다.
  if (!state.habits.some((h) => h.id === habitID)) {
    return new Response(renderHabits(state, today), {
      headers: { ...HTML, "HX-Retarget": "#habits", "HX-Reswap": "innerHTML" },
    });
  }

  const on = state.checks.some((c) => c.habit_id === habitID && c.date === date);
  const stmt = on ? dolt.deleteCheck(habitID, date) : dolt.insertCheck(habitID, date);

  await dolt.write(ctx.token, ctx.db, ctx.branch, [stmt]);

  state.checks = on
    ? state.checks.filter((c) => !(c.habit_id === habitID && c.date === date))
    : [...state.checks, { habit_id: habitID, date, note: "" }];

  const body =
    renderOneCard(state, habitID, today) +
    renderDay(state, today, true) +
    renderLive(announce(state, habitID, date, on, today));

  return new Response(body, { headers: HTML });
}

/**
 * handleEdit은 이름과 설명을 고친다.
 *
 * handleToggle과 같은 모양으로 답한다 — 카드 하나, 오늘 요약(OOB), 알림 한 줄.
 * 요약까지 다시 그리는 이유는 이름이 거기 눈금의 title에도 들어가기 때문이다.
 */
async function handleEdit(request: Request, ctx: Ctx, habitID: string): Promise<Response> {
  const guard = requireWrite(ctx);
  if (guard) return guard;

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (name === "") {
    return toast("습관 이름을 넣으세요.", 400);
  }
  const description = normalizeDesc(String(form.get("description") ?? ""));

  const today = todayOf(request);
  let state = await dolt.pull(ctx.db, ctx.branch);

  // 다른 곳에서 지워진 습관이다. 카드 자리에 답해 봐야 유령 카드가 남는다.
  if (!state.habits.some((h) => h.id === habitID)) {
    return new Response(renderHabits(state, today), {
      headers: { ...HTML, "HX-Retarget": "#habits", "HX-Reswap": "innerHTML" },
    });
  }

  await dolt.write(ctx.token, ctx.db, ctx.branch, [
    dolt.updateHabit(habitID, name.slice(0, 60), description),
  ]);

  state = await dolt.pull(ctx.db, ctx.branch);
  const body =
    renderOneCard(state, habitID, today) +
    renderDay(state, today, true) +
    renderLive(`${name} 수정됨.`);
  return new Response(body, { headers: HTML });
}

async function handleDelete(request: Request, ctx: Ctx, habitID: string): Promise<Response> {
  const guard = requireWrite(ctx);
  if (guard) return guard;

  await dolt.write(ctx.token, ctx.db, ctx.branch, dolt.deleteHabit(habitID));

  const state = await dolt.pull(ctx.db, ctx.branch);
  return new Response(renderHabits(state, todayOf(request)) + renderLive("습관을 삭제했습니다."), {
    headers: HTML,
  });
}

/**
 * handleExport는 링크로 열린다.
 *
 * 링크는 htmx 요청이 아니라서 hx-headers가 붙지 않는다. 그래서 DB만은 쿼리로 받는다.
 * 읽기에는 토큰이 필요 없으니 주소에 실릴 비밀도 없다.
 */
async function handleExport(url: URL, ctx: Ctx): Promise<Response> {
  const asked = (url.searchParams.get("db") || "").trim();
  const target: Ctx = asked === "" ? ctx : { ...ctx, db: asked };

  const problem = dbProblem(target);
  if (problem) {
    return json({ error: problem }, 400);
  }

  const state = await dolt.pull(target.db, target.branch);
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

/**
 * ctxOf는 이번 요청의 대상을 정한다.
 *
 * 떨어질 기본값이 없다. DB가 비면 읽기는 handleList가 설정 안내로 받고,
 * 쓰기는 requireWrite가 토스트로 막는다. 토큰도 마찬가지다 — 안 넣었으면 쓰기가 막힌다.
 */
function ctxOf(request: Request, env: Env): Ctx {
  return {
    db: (request.headers.get("X-Dolt-DB") || "").trim(),
    token: (request.headers.get("X-Dolt-Token") || "").trim(),
    branch: env.DOLT_BRANCH || "main",
  };
}

/** DB 이름에 문제가 있으면 사람이 읽을 문장으로 돌려준다. 성하면 null이다. */
function dbProblem(ctx: Ctx): string | null {
  if (ctx.db === "") {
    return "설정에서 DoltHub DB를 넣어 주세요. owner/name 형식입니다.";
  }
  if (!isDbName(ctx.db)) {
    return `DB 이름은 owner/name 형식이어야 합니다: ${ctx.db}`;
  }
  return null;
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
function requireWrite(ctx: Ctx): Response | null {
  const problem = dbProblem(ctx);
  if (problem) {
    return toast(problem, 400);
  }
  if (ctx.token === "") {
    return toast("설정에서 DoltHub 토큰을 넣어야 기록할 수 있습니다.", 401);
  }
  if (!isToken(ctx.token)) {
    return toast("토큰에 쓸 수 없는 글자가 들어 있습니다. 다시 붙여 넣어 주세요.", 400);
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

/**
 * 설명은 여러 줄 평문이다.
 *
 * 줄바꿈은 그대로 두되 CRLF를 LF로 맞춘다 — 브라우저가 textarea 값을 CRLF로
 * 보내는 경우가 있고, 그대로 저장하면 같은 글이 저장할 때마다 달라 보인다.
 * 길이는 컬럼 크기(VARCHAR(2000))에 맞춰 자른다.
 */
function normalizeDesc(s: string): string {
  return s.replace(/\r\n/g, "\n").trim().slice(0, 2000);
}

/** 색은 화면에 style로 들어간다. #rrggbb 말고는 받지 않는다. */
function normalizeColor(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#e2542f";
}
