/**
 * HTML 조각을 만든다.
 *
 * 예전에는 wasm이 브라우저 안에서 같은 문자열을 만들어 innerHTML에 넣었다.
 * 마크업과 CSS 클래스는 그대로 두고, 만드는 자리만 여기로 옮겼다.
 * 달라진 건 버튼에 data-act 대신 htmx 속성이 붙는다는 것뿐이다.
 */

import type { DateStr, Habit, State, Stats } from "./model";
import { addDays, checkSet, compute, datesOf, dayOfWeek } from "./model";

/** 카드마다 보여주는 사슬 그리드의 주 수. */
const GRID_WEEKS = 5;

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

/** HTML에 넣기 전에 반드시 통과시킨다. 습관 이름은 사용자가 넣는 값이다. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 토글 버튼이 공통으로 다는 htmx 속성.
 *
 * hx-disabled-elt이 없으면 왕복 2초 동안 연타가 되고 같은 요청이 여러 번 나간다.
 * INSERT IGNORE / DELETE라 데이터가 깨지지는 않지만 커밋이 그만큼 쌓인다.
 */
function toggleAttrs(habitID: string, date: DateStr): string {
  return (
    `hx-post="/habits/${encodeURIComponent(habitID)}/toggle?date=${date}" ` +
    `hx-target="#habits" hx-swap="innerHTML" hx-disabled-elt="this"`
  );
}

// ── 습관 목록 ──────────────────────────────────────────

/** renderHabits는 #habits 안에 들어갈 조각 전체를 만든다. */
export function renderHabits(state: State, today: DateStr): string {
  if (state.habits.length === 0) {
    return `<div class="empty">
      <h2>아직 사슬이 없습니다</h2>
      <p>이어갈 습관을 하나 추가하세요.<br>매일 칸을 채우고, 끊지 마세요.</p>
    </div>`;
  }
  const idx = checkSet(state);
  return state.habits.map((h) => renderCard(h, state, idx, today)).join("");
}

/** 불러오기에 실패했을 때. 빈 목록과 구별되어야 한다. */
export function renderError(msg: string): string {
  return `<div class="empty">
    <h2>불러오지 못했습니다</h2>
    <p>${esc(msg)}</p>
    <p><button class="secondary" hx-get="/habits" hx-target="#habits" hx-swap="innerHTML">다시 시도</button></p>
  </div>`;
}

function renderCard(h: Habit, state: State, idx: Set<string>, today: DateStr): string {
  const stats = compute(datesOf(state, h.id), today);
  const doneToday = idx.has(`${h.id}|${today}`);
  const color = h.color || "#f97316";
  const streakClass = stats.current === 0 ? "streak dead" : "streak";
  const word = stats.current === 0 ? "— 오늘 다시 시작하세요" : "이어가는 중";

  return `<article class="card" style="--habit:${esc(color)}">
  <div class="card-head">
    <div>
      <h2 class="card-title">${esc(h.name)}</h2>
      <p class="${streakClass}"><b>${stats.current}</b> 일째 ${word}</p>
    </div>
    <div class="card-menu">
      <button class="today-btn${doneToday ? " done" : ""}" ${toggleAttrs(h.id, today)}>${
        doneToday ? "오늘 완료" : "오늘 체크"
      }</button>
      <button class="icon-btn" aria-label="삭제" title="삭제"
        hx-delete="/habits/${encodeURIComponent(h.id)}"
        hx-target="#habits" hx-swap="innerHTML"
        hx-confirm="'${esc(h.name)}' 습관과 그 기록을 모두 지웁니다. 되돌릴 수 없습니다.">🗑</button>
    </div>
  </div><div class="card-body">${renderGrid(h, idx, today)}${renderStats(stats)}</div>
</article>`;
}

function renderStats(s: Stats): string {
  return `<dl class="card-stats">
    <div><dt>최장</dt><dd>${s.longest}<small>일</small></dd></div>
    <div><dt>누적</dt><dd>${s.total}<small>회</small></dd></div>
    <div><dt>최근 30일</dt><dd>${s.rate30}<small>%</small></dd></div>
  </dl>`;
}

/**
 * renderGrid는 최근 GRID_WEEKS 주를 요일 정렬 그리드로 그린다.
 * 가로로 인접한 두 칸이 모두 채워져 있으면 사이를 이어 사슬처럼 보이게 한다.
 */
function renderGrid(h: Habit, idx: Set<string>, today: DateStr): string {
  const parts: string[] = ['<div class="grid">'];
  DOW.forEach((n, i) => {
    parts.push(`<div class="dow${i === 0 ? " sun" : ""}">${n}</div>`);
  });

  // 이번 주 토요일에서 거꾸로 GRID_WEEKS 주만큼 거슬러 올라간 일요일이 시작점이다.
  const end = addDays(today, 6 - dayOfWeek(today));
  const start = addDays(end, -(GRID_WEEKS * 7 - 1));

  const days = GRID_WEEKS * 7;
  const dates: DateStr[] = [];
  const done: boolean[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    dates.push(d);
    done.push(idx.has(`${h.id}|${d}`));
  }

  for (let i = 0; i < days; i++) {
    const d = dates[i]!;
    let cls = "cell";
    let label = "";

    if (d > today) {
      cls += " future";
    } else if (done[i]) {
      cls += " done";
      // 같은 행 안에서만 잇는다. 행이 바뀌면 시각적으로 이어붙일 자리가 없다.
      if (i % 7 !== 0 && done[i - 1]) cls += " link-l";
      if (i % 7 !== 6 && i + 1 < days && done[i + 1] && dates[i + 1]! <= today) cls += " link-r";
    }
    if (d === today) cls += " today";
    if (d.endsWith("-01")) {
      cls += " first";
      label = String(Number(d.slice(5, 7)));
    }

    // 미래 칸은 누를 수 없다. 서버도 막지만 여기서도 막아 요청을 아낀다.
    const attrs = d > today ? "disabled" : toggleAttrs(h.id, d);
    parts.push(`<button class="${cls}" ${attrs} title="${d}" aria-label="${d}">${label}</button>`);
  }

  parts.push("</div>");
  return parts.join("");
}

// ── 껍데기 ─────────────────────────────────────────────

/**
 * shell은 첫 요청에 돌려주는 페이지다.
 *
 * 데이터를 담지 않는다. 첫 GET은 htmx 요청이 아니라서 hx-headers가 붙지 않고,
 * 그러면 서버가 사용자의 로컬 날짜도 쓰기 키도 모른다. 그래서 목록은
 * hx-trigger="load"로 한 번 더 요청해서 채운다 — 그 요청부터는 헤더가 붙는다.
 */
export function shell(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Habit Chain — 끊지 말 것</title>
<meta name="description" content="Don't break the chain. 매일 이어붙인 사슬을 눈으로 확인하는 습관 추적기.">
<meta name="theme-color" content="#0e0f13">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/app.css">
<script src="/htmx.min.js" defer></script>
</head>
<body hx-headers='js:{"X-Local-Date": habitChain.today(), "X-Write-Key": habitChain.writeKey()}'>

<div id="app">
  <header class="topbar">
    <h1><span class="logo">⛓</span> Habit&nbsp;Chain</h1>
    <div class="topbar-actions">
      <span id="sync-badge" class="badge htmx-indicator" title="반영 중">보내는 중…</span>
      <button class="icon-btn" aria-label="설정" title="설정"
        onclick="document.getElementById('settings').showModal()">⚙</button>
    </div>
  </header>

  <main>
    <section id="habits" class="habits" aria-live="polite"
      hx-get="/habits" hx-trigger="load" hx-swap="innerHTML">
      <div class="empty"><p>불러오는 중…</p></div>
    </section>

    <form class="add-form" autocomplete="off"
      hx-post="/habits" hx-target="#habits" hx-swap="innerHTML"
      hx-disabled-elt="find button" hx-on::after-request="this.reset()">
      <input name="name" type="text" placeholder="새 습관 (예: 아침 30분 달리기)" maxlength="60" required>
      <input name="color" type="color" value="#f97316" aria-label="색상">
      <button type="submit">추가</button>
    </form>
  </main>

  <dialog id="settings">
    <form method="dialog" class="settings-head">
      <h2>설정</h2>
      <button value="close" class="icon-btn" aria-label="닫기">✕</button>
    </form>

    <div class="settings-body">
      <fieldset id="write-key-row" hidden>
        <legend>쓰기 키</legend>
        <p class="hint">
          이 서버가 <code>WRITE_KEY</code>를 요구합니다. 이 브라우저에만 저장되고,
          요청마다 헤더로 실려 갑니다.
        </p>
        <label>키
          <input id="set-write-key" type="password" placeholder="서버의 WRITE_KEY" spellcheck="false"
            oninput="habitChain.saveWriteKey(this.value)">
        </label>
      </fieldset>

      <fieldset>
        <legend>데이터</legend>
        <p class="hint">
          기록의 원본은 이 앱을 서빙하는 서버가 물고 있는 DoltHub DB입니다.
          브라우저에는 쓰기 키만 남습니다.
        </p>
        <div class="row">
          <a class="ghost" href="/export" download>JSON 내보내기</a>
          <a class="ghost" href="/schema.sql" target="_blank" rel="noopener">스키마 SQL 보기</a>
        </div>
      </fieldset>
    </div>
  </dialog>
</div>

<script>
// htmx가 요청마다 실어 보내는 값들.
//
// 오늘 날짜는 반드시 브라우저에서 와야 한다. 서버에는 사용자의 시간대가 없고,
// UTC로 계산하면 KST 사용자는 오전 9시 전까지 어제 칸에 체크가 들어간다.
window.habitChain = {
  today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  },
  writeKey() {
    try { return localStorage.getItem("habit-chain.write_key") || ""; } catch { return ""; }
  },
  saveWriteKey(v) {
    try { localStorage.setItem("habit-chain.write_key", v.trim()); } catch {}
  },
};

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("set-write-key");
  if (input) input.value = window.habitChain.writeKey();

  fetch("/api/health").then((r) => r.json()).then((cfg) => {
    if (cfg.requiresKey) document.getElementById("write-key-row").hidden = false;
  }).catch(() => {});
});

// 서버가 4xx/5xx를 주면 htmx는 기본적으로 스왑하지 않는다.
// 그러면 화면이 말없이 그대로라 실패한 줄 모른다. 조각을 그대로 넣게 한다.
document.addEventListener("htmx:beforeSwap", (e) => {
  if (e.detail.xhr.status >= 400) e.detail.shouldSwap = true;
});

const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
if ("serviceWorker" in navigator && !isLocal) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
} else if (isLocal && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
  if (window.caches) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
}
</script>
</body>
</html>`;
}
