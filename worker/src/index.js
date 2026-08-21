/**
 * habit-chain Worker
 *
 * 두 가지 일을 한다.
 *  1. web/ 아래 정적 자산(PWA + wasm) 서빙 — ASSETS 바인딩이 처리한다.
 *  2. POST /api/write — 브라우저가 할 수 없는 DoltHub 쓰기를 대신 수행.
 *
 * 브라우저에서 DoltHub 쓰기 API를 직접 부를 수 없는 이유:
 * 쓰기 엔드포인트는 Authorization 헤더를 요구하는데 DoltHub의 CORS preflight가
 * GET만 허용한다. 그래서 토큰은 여기 시크릿에만 두고, 앱은 이 Worker에 요청한다.
 *
 * 시크릿:
 *   DOLTHUB_TOKEN — DoltHub → Settings → Tokens 에서 발급
 *   WRITE_KEY     — 앱 설정에 넣는 공유 비밀. 아무나 쓰지 못하게 막는다.
 * 변수:
 *   ALLOWED_DB    — 쉼표로 구분한 허용 DB 목록. 비면 제한 없음.
 */

const API = "https://www.dolthub.com/api/v1alpha1";
const POLL_INTERVAL_MS = 600;
const POLL_TIMEOUT_MS = 25_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/write") {
      return withCORS(request, handleWrite(request, env));
    }
    if (url.pathname === "/api/health") {
      return withCORS(request, Promise.resolve(json({
        ok: true,
        writeConfigured: Boolean(env.DOLTHUB_TOKEN),
        allowedDb: env.ALLOWED_DB || null,
      })));
    }

    return env.ASSETS.fetch(request);
  },
};

/** 앱이 GitHub Pages 등 다른 출처에서 열려도 쓸 수 있게 CORS를 붙인다. */
async function withCORS(request, promise) {
  const headers = {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Write-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const res = await promise;
  const merged = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(res.body, { status: res.status, headers: merged });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleWrite(request, env) {
  if (request.method !== "POST") {
    return json({ error: "POST만 받습니다." }, 405);
  }
  if (!env.DOLTHUB_TOKEN) {
    return json({ error: "이 Worker에 DOLTHUB_TOKEN 시크릿이 설정되지 않았습니다." }, 501);
  }
  if (env.WRITE_KEY && request.headers.get("X-Write-Key") !== env.WRITE_KEY) {
    return json({ error: "쓰기 키가 맞지 않습니다." }, 401);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "본문이 JSON이 아닙니다." }, 400);
  }

  const db = String(payload.db || "").trim();
  const branch = String(payload.branch || "main").trim() || "main";
  const statements = (Array.isArray(payload.sql) ? payload.sql : String(payload.sql || "").split("\n"))
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"));

  if (db.split("/").filter(Boolean).length !== 2) {
    return json({ error: `DB 이름은 owner/name 형식이어야 합니다: ${db}` }, 400);
  }
  const allowed = (env.ALLOWED_DB || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(db)) {
    return json({ error: `${db} 에는 쓸 수 없습니다. 허용된 DB: ${allowed.join(", ")}` }, 403);
  }
  if (!statements.length) {
    return json({ applied: 0, message: "반영할 문장이 없습니다." });
  }

  const [owner, name] = db.split("/");
  const applied = [];

  for (const stmt of statements) {
    try {
      await runStatement(env.DOLTHUB_TOKEN, owner, name, branch, stmt);
      applied.push(stmt);
    } catch (err) {
      // 앞의 문장들은 이미 반영됐다. 앱이 남은 것만 다시 보낼 수 있도록 개수를 돌려준다.
      return json({
        applied: applied.length,
        error: `${applied.length + 1}번째 문장에서 실패: ${err.message}`,
      }, 502);
    }
  }

  return json({ applied: applied.length, db, branch });
}

/** write 엔드포인트는 비동기다. 작업을 걸고 끝날 때까지 기다린다. */
async function runStatement(token, owner, name, branch, stmt) {
  const b = encodeURIComponent(branch);
  const start = await doltFetch(
    `${API}/${owner}/${name}/write/${b}/${b}?q=${encodeURIComponent(stmt)}`,
    token,
    "POST",
  );

  const op = start.operation_name;
  if (!op) {
    throw new Error(start.query_execution_message || JSON.stringify(start).slice(0, 200));
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await doltFetch(
      `${API}/${owner}/${name}/write?operationName=${encodeURIComponent(op)}`,
      token,
      "GET",
    );
    if (res.done) {
      const details = res.res_details || {};
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

async function doltFetch(url, token, method) {
  const res = await fetch(url, {
    method,
    headers: { authorization: `token ${token}` },
  });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
