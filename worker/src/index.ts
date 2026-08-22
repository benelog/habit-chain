/**
 * habit-chain Worker — all HTMX. Reading, writing and rendering happen here;
 * the browser only swaps fragments.
 *
 * The DB and token belong to the user, not the server. Settings values ride
 * along on every request:
 *   X-Dolt-DB     — owner/name. Without it there is nothing to read.
 *   X-Dolt-Token  — DoltHub → Settings → Tokens. Needed for writes; also
 *                   attached to reads so a private DB is readable.
 *
 * The server holds no token and no default DB, so there is no shared secret to
 * guard: you write to your own DB with your own token, and cannot touch anyone
 * else's. An unset DB shows setup instead of a chain.
 *
 * Vars: DOLT_BRANCH (defaults to main).
 */

import * as dolt from "./dolt";
import { compute, datesOf, isDateStr, isDbName, isToken } from "./model";
import type { Habit, Meta, State } from "./model";
import {
  publicShell,
  renderDay,
  renderError,
  renderHabits,
  renderLive,
  renderMetaForm,
  renderOneCard,
  renderPrepare,
  renderSetup,
  renderToast,
  shell,
} from "./render";

interface Env {
  ASSETS: Fetcher;
  DOLT_BRANCH?: string;
}

/** Which DB this request touches, and with what credentials. From headers. */
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
    // The onboarding guide (/help) is a static asset: Pages maps the pretty
    // path to help.html by itself, so it simply falls through to env.ASSETS.

    // The public share page: /@owner/name, read with no token, so it works
    // exactly for public DBs. The visitor's own settings never ride along.
    const pub = /^\/@([A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64})(\/habits)?$/.exec(path);
    if (pub && request.method === "GET") {
      const db = pub[1]!;
      const branch = env.DOLT_BRANCH || "main";
      if (pub[2]) {
        return await handlePublicList(request, db, branch);
      }
      return new Response(publicShell(db, await dolt.readMeta(db, branch), url.origin), {
        headers: HTML,
      });
    }

    const isList = path === "/habits" && request.method === "GET";
    const ctx = ctxOf(request, env);

    try {
      if (path === "/api/token/check" && request.method === "GET") {
        return await handleTokenCheck(ctx);
      }
      if (isList) {
        return await handleList(request, ctx);
      }
      if (path === "/habits" && request.method === "POST") {
        return await handleAdd(request, ctx);
      }
      if (path === "/meta" && request.method === "PUT") {
        return await handleMetaSave(request, ctx, url.origin);
      }
      if (path === "/schema" && request.method === "POST") {
        return await handlePrepare(request, ctx);
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
      // A rejected token reads as raw JSON otherwise; point at the fix.
      const msg = dolt.isTokenRejected(err)
        ? "DoltHub가 저장된 토큰을 거부했습니다. 설정에서 토큰을 다시 넣어 주세요."
        : message(err);
      // A failed list leaves nothing to show, so the error takes the screen.
      // A failed write is different: what is on screen is still valid.
      return isList
        ? new Response(renderError(msg), { status: 502, headers: HTML })
        : toast(msg, 502);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleList(request: Request, ctx: Ctx): Promise<Response> {
  // Empty settings is a starting point, not a failure — 200 with guidance.
  if (ctx.db === "") {
    return new Response(renderSetup(), { headers: HTML });
  }

  // Nothing to show, so speak through the whole screen rather than a toast.
  const problem = dbProblem(ctx);
  if (problem) {
    return new Response(renderError(problem), { status: 400, headers: HTML });
  }

  // pull first, so a healthy DB never pays for an extra round trip. The schema
  // is only inspected once that has failed.
  let state: State;
  try {
    state = await dolt.pull(ctx.db, ctx.branch, ctx.token);
  } catch (err) {
    const shape = await dolt.inspect(ctx.db, ctx.branch, ctx.token);
    if (!shape.branch || dolt.migrations(shape).length > 0) {
      return new Response(renderPrepare(shape, ctx.token !== ""), { headers: HTML });
    }
    throw err;
  }
  // The meta form rides out-of-band into the settings dialog, so its fields
  // hold what the DB holds.
  const origin = new URL(request.url).origin;
  return new Response(
    renderHabits(state, todayOf(request)) + renderMetaForm(state.meta, ctx.db, origin, true),
    { headers: HTML },
  );
}

/** The public page's list fragment. Same shape as handleList, minus writes. */
async function handlePublicList(request: Request, db: string, branch: string): Promise<Response> {
  const retry = `/@${db}/habits`;
  let state: State;
  try {
    state = await dolt.pull(db, branch, "");
  } catch (err) {
    return new Response(renderError(publicProblem(err), retry), { status: 502, headers: HTML });
  }
  return new Response(renderHabits(state, todayOf(request), true), { headers: HTML });
}

/** Turns raw DoltHub errors into something a visitor can act on. */
function publicProblem(err: unknown): string {
  if (dolt.isBranchMissing(err) || dolt.isTableMissing(err)) {
    return "이 DB에는 아직 습관 기록이 없습니다.";
  }
  const msg = message(err);
  // "no such repository" is what the read API actually says (observed 2026-08);
  // the 404 spellings are kept in case other paths phrase it differently.
  return /no such repository|repository not found|DoltHub 404/i.test(msg)
    ? "이 DB를 읽을 수 없습니다. 비공개 DB이거나 존재하지 않는 DB일 수 있습니다."
    : msg;
}

/**
 * Saves the public page's title and description into the user's DB. Every
 * answer — success or failure — is the form itself: this form lives in the
 * modal settings dialog, where a toast would sit invisible behind the backdrop.
 */
async function handleMetaSave(request: Request, ctx: Ctx, origin: string): Promise<Response> {
  const form = await request.formData();
  const meta: Meta = {
    // The title lands in an og:title and a heading; one line only.
    title: String(form.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
    description: normalizeDesc(String(form.get("description") ?? "")),
  };
  const answer = (status: number, note: string, bad: boolean) =>
    new Response(renderMetaForm(meta, ctx.db, origin, false, note, bad), { status, headers: HTML });

  const problem = dbProblem(ctx);
  if (problem) return answer(400, problem, true);
  if (ctx.token === "") return answer(401, "설정에 토큰을 저장해야 기록할 수 있습니다.", true);
  if (!isToken(ctx.token)) return answer(400, "토큰에 쓸 수 없는 글자가 들어 있습니다.", true);

  try {
    try {
      await dolt.write(ctx.token, ctx.db, ctx.branch, [dolt.upsertMeta(meta)]);
    } catch (err) {
      // The meta table arrived in a later migration; create it on first save.
      if (!dolt.isTableMissing(err)) throw err;
      await dolt.write(ctx.token, ctx.db, ctx.branch, [dolt.CREATE_META, dolt.upsertMeta(meta)]);
    }
  } catch (err) {
    return answer(502, `저장하지 못했습니다: ${message(err)}`, true);
  }

  return answer(200, "저장했습니다. 공개 페이지에 바로 반영됩니다.", false);
}

/**
 * Brings the DB up to the current schema. Client-reported state is not trusted:
 * inspect again here so pressing twice is harmless.
 *
 * This rides the ordinary write endpoint. DoltHub's web query console rejects
 * DDL, but that is the read side — the write endpoint runs DDL and even creates
 * a branch for a DB with zero commits (verified 2026-08, undocumented). Because
 * it is observed rather than documented, the failure path stays.
 */
async function handlePrepare(request: Request, ctx: Ctx): Promise<Response> {
  const guard = requireWrite(ctx);
  if (guard) return guard;

  const stmts = dolt.migrations(await dolt.inspect(ctx.db, ctx.branch, ctx.token));
  if (stmts.length === 0) {
    return new Response(renderHabits(await dolt.pull(ctx.db, ctx.branch, ctx.token), todayOf(request)), {
      headers: HTML,
    });
  }

  try {
    await dolt.write(ctx.token, ctx.db, ctx.branch, stmts);
  } catch (err) {
    // Either no branch to write to, or DDL refused. The human fix is the same.
    return toast(
      `DB를 준비하지 못했습니다: ${message(err)} — DoltHub에서 이 DB를 열고 ` +
        `SQL Query로 스키마 SQL을 한 번 실행해 커밋해 주세요. 그다음에는 앱이 이어받습니다.`,
      502,
    );
  }

  const state = await dolt.pull(ctx.db, ctx.branch, ctx.token);
  return new Response(
    renderHabits(state, todayOf(request)) + renderLive("DB를 준비했습니다."),
    { headers: HTML },
  );
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
  const state = await dolt.pull(ctx.db, ctx.branch, ctx.token);
  return new Response(renderHabits(state, today) + renderLive(`${habit.name} 추가됨.`), {
    headers: HTML,
  });
}

/**
 * Returns one card. Redrawing the whole list on every tick flashed the screen
 * and dropped focus; the day summary follows along via hx-swap-oob.
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

  const state = await dolt.pull(ctx.db, ctx.branch, ctx.token);

  // Deleted on another device. A whole list cannot go in a card slot, so
  // retarget to the list and redraw.
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
 * Edits name and description. Answers in handleToggle's shape — one card, the
 * day summary out-of-band, one announcement. The summary is redrawn because the
 * habit name also appears in its tick titles.
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
  let state = await dolt.pull(ctx.db, ctx.branch, ctx.token);

  // Deleted elsewhere; answering in the card slot would leave a ghost card.
  if (!state.habits.some((h) => h.id === habitID)) {
    return new Response(renderHabits(state, today), {
      headers: { ...HTML, "HX-Retarget": "#habits", "HX-Reswap": "innerHTML" },
    });
  }

  await dolt.write(ctx.token, ctx.db, ctx.branch, [
    dolt.updateHabit(habitID, name.slice(0, 60), description),
  ]);

  state = await dolt.pull(ctx.db, ctx.branch, ctx.token);
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

  const state = await dolt.pull(ctx.db, ctx.branch, ctx.token);
  return new Response(renderHabits(state, todayOf(request)) + renderLive("습관을 삭제했습니다."), {
    headers: HTML,
  });
}

/**
 * Answers the settings dialog's "is this token any good?" before it is saved.
 * Three verdicts, not two: only a definitive rejection from DoltHub blocks the
 * save — an outage or a network failure must not read as a bad token.
 */
async function handleTokenCheck(ctx: Ctx): Promise<Response> {
  if (ctx.token === "") {
    return json({ state: "invalid", error: "토큰이 비어 있습니다." }, 400);
  }
  if (!isToken(ctx.token)) {
    return json(
      { state: "invalid", error: "토큰에 쓸 수 없는 글자가 들어 있습니다. 다시 붙여 넣어 주세요." },
      400,
    );
  }

  const check = await dolt.verifyToken(ctx.token);
  if (check.state === "valid") {
    return json({ state: "valid" });
  }
  if (check.state === "invalid") {
    return json({ state: "invalid", error: `DoltHub가 이 토큰을 거부했습니다: ${check.detail}` }, 400);
  }
  return json({ state: "unknown", error: check.detail }, 200);
}

/**
 * Opened as a link, so no hx-headers are attached and the DB comes from the
 * query string. The token is deliberately left off — a secret must not ride in
 * a URL — so exporting works for public DBs only.
 */
async function handleExport(url: URL, ctx: Ctx): Promise<Response> {
  const asked = (url.searchParams.get("db") || "").trim();
  const target: Ctx = asked === "" ? ctx : { ...ctx, db: asked };

  const problem = dbProblem(target);
  if (problem) {
    return json({ error: problem }, 400);
  }

  const state = await dolt.pull(target.db, target.branch, target.token);
  const day = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(state, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="habit-chain-${day}.json"`,
    },
  });
}

/** One line for screen readers; on screen colour and shape say this. */
function announce(state: State, habitID: string, date: string, wasOn: boolean, today: string): string {
  const name = state.habits.find((h) => h.id === habitID)?.name ?? "습관";
  const days = compute(datesOf(state, habitID), today).current;
  return `${name} ${date} ${wasOn ? "체크 해제" : "체크"}. 현재 ${days}일째.`;
}

/** No fallbacks. An empty DB or token is caught by handleList/requireWrite. */
function ctxOf(request: Request, env: Env): Ctx {
  return {
    db: (request.headers.get("X-Dolt-DB") || "").trim(),
    token: (request.headers.get("X-Dolt-Token") || "").trim(),
    branch: env.DOLT_BRANCH || "main",
  };
}

/** A human-readable problem with the DB name, or null if it is fine. */
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
 * The server has no user timezone. On UTC, a KST user checking before 09:00
 * would mark yesterday — which reads as a broken chain. So use the local date
 * the browser sends, falling back to UTC only when it is absent.
 */
function todayOf(request: Request): string {
  const sent = request.headers.get("X-Local-Date");
  return isDateStr(sent) ? sent : new Date().toISOString().slice(0, 10);
}

/** Guards a write request; null means it may proceed. */
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
 * Reports a failed write. HX-Retarget sends it to #toast — otherwise the error
 * lands in the card or list slot and wipes the records shown there.
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
 * Keeps newlines but normalizes CRLF to LF: browsers may send textarea values
 * with CRLF, making the same text look changed on every save. Trimmed to the
 * column size, VARCHAR(2000).
 */
function normalizeDesc(s: string): string {
  return s.replace(/\r\n/g, "\n").trim().slice(0, 2000);
}

/** The colour goes into a style attribute; #rrggbb only. */
function normalizeColor(c: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : "#e2542f";
}
