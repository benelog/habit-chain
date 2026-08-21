/**
 * HTML 조각을 만든다.
 *
 * 화면의 규칙 하나만 기억하면 된다 — 껍데기는 무채색이고, 색은 사슬만 갖는다.
 * 습관 색은 사용자가 고른 값이라 UI가 색을 쓰면 둘이 서로 싸운다.
 *
 * 조각은 두 가지 크기로 나간다. 목록 전체(#habits)와 카드 하나(.card)다.
 * 체크 한 번에 목록 전체를 갈아끼우면 화면이 통째로 깜빡이고 포커스도 날아가므로,
 * 토글은 카드 하나만 바꾸고 상단의 오늘 요약은 OOB로 따라 바꾼다.
 */

import type { DateStr, Habit, State, Stats } from "./model";
import { addDays, checkSet, compute, datesOf, dayOfWeek } from "./model";

/** 카드마다 보여주는 사슬 그리드의 주 수. */
const GRID_WEEKS = 5;

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 새 습관에 고를 수 있는 색.
 *
 * 네이티브 색 선택기를 없앤 자리다. 아무 색이나 고를 수 있으면 화면이 금방
 * 안 어울리는 색으로 채워진다. 밝은 배경과 어두운 배경 양쪽에서 읽히는
 * 중간 명도만 골라 뒀다.
 */
export const SWATCHES = [
  "#e2542f",
  "#c9932a",
  "#3fa34d",
  "#1fa0a0",
  "#3a6fd8",
  "#7b5cd6",
  "#d6427f",
  "#7d7a75",
];

/** HTML에 넣기 전에 반드시 통과시킨다. 습관 이름은 사용자가 넣는 값이다. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "2026-08-21" → "8월 21일" */
function md(d: DateStr): string {
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
}

/**
 * 토글 버튼이 공통으로 다는 htmx 속성.
 *
 * hx-disabled-elt이 없으면 왕복 2초 동안 연타가 되고 같은 요청이 여러 번 나간다.
 * INSERT IGNORE / DELETE라 데이터가 깨지지는 않지만 커밋이 그만큼 쌓인다.
 *
 * hx-indicator를 카드에 거는 이유: 요청 중에는 카드가 흐려지면서 pointer-events가
 * 꺼진다. 같은 카드의 다른 칸을 겹쳐 누르면 응답이 뒤섞인다.
 * (indicator 목록에 `this`는 못 쓴다 — htmx가 CSS 타입 선택자로 읽어 아무것도 못 찾는다.
 * 누른 칸은 hx-disabled-elt으로 disabled가 되므로 CSS가 그걸 보고 깜빡인다.)
 */
function toggleAttrs(habitID: string, date: DateStr): string {
  return (
    `hx-post="/habits/${encodeURIComponent(habitID)}/toggle?date=${date}" ` +
    `hx-target="closest .card" hx-swap="outerHTML" ` +
    `hx-indicator="closest .card" hx-disabled-elt="this"`
  );
}

/** renderHabits는 #habits 안에 들어갈 조각 전체를 만든다. */
export function renderHabits(state: State, today: DateStr): string {
  if (state.habits.length === 0) {
    return renderEmpty();
  }
  const idx = checkSet(state);
  return (
    renderDay(state, today, false) +
    state.habits.map((h) => renderCard(h, state, idx, today)).join("")
  );
}

/** 카드 하나만. 토글 응답의 본체다. 습관이 있는지는 부르는 쪽이 먼저 본다. */
export function renderOneCard(state: State, habitID: string, today: DateStr): string {
  const h = state.habits.find((x) => x.id === habitID);
  return h ? renderCard(h, state, checkSet(state), today) : "";
}

function renderEmpty(): string {
  const seeds = ["아침 30분 달리기", "책 10쪽", "물 2L", "저녁 산책"];
  return `<div class="empty">
    <h2>첫 칸을 채우는 것부터</h2>
    <p>이어갈 습관을 하나 추가하세요. 하루를 통째로 건너뛰어야 사슬이 끊깁니다.</p>
    <div class="chips">${seeds
      .map((s) => `<button class="chip" type="button" onclick="habitChain.suggest('${esc(s)}')">${esc(s)}</button>`)
      .join("")}</div>
  </div>`;
}

/**
 * 오늘 요약. 이 앱을 열어서 답을 얻고 싶은 질문은 하나다 — 오늘 다 했나?
 * 그래서 목록 맨 위에 그 답만 둔다.
 */
export function renderDay(state: State, today: DateStr, oob: boolean): string {
  const idx = checkSet(state);
  const done = state.habits.filter((h) => idx.has(`${h.id}|${today}`)).length;
  const all = state.habits.length;
  const links = state.habits
    .map((h) => {
      const on = idx.has(`${h.id}|${today}`);
      return `<i class="${on ? "on" : ""}" style="--habit:${esc(h.color || SWATCHES[0]!)}" title="${esc(h.name)} ${
        on ? "완료" : "미완료"
      }"></i>`;
    })
    .join("");

  return `<header class="day${done === all ? " all-done" : ""}" id="day"${oob ? ` hx-swap-oob="true"` : ""}>
  <div class="day-date">${md(today)}<small>${DOW[dayOfWeek(today)]}요일</small></div>
  <div class="day-tally">
    <div class="day-links" aria-hidden="true">${links}</div>
    <p class="day-count">오늘 <b>${done}</b>${done === all ? "개 모두 이어감" : ` / ${all} 이어감`}</p>
  </div>
</header>`;
}

/** 스크린 리더에만 읽히는 결과 알림. 목록 전체에 aria-live를 걸면 매번 다 읽는다. */
export function renderLive(text: string): string {
  return `<span id="live" class="sr-only" role="status" hx-swap-oob="true">${esc(text)}</span>`;
}

/** 불러오기에 실패했을 때. 빈 목록과 구별되어야 한다. */
export function renderError(msg: string): string {
  return `<div class="empty">
    <h2>목록을 불러오지 못했습니다</h2>
    <p>${esc(msg)}</p>
    <div class="chips"><button class="ghost" hx-get="/habits" hx-target="#habits" hx-swap="innerHTML">다시 불러오기</button></div>
  </div>`;
}

/**
 * 쓰기가 실패했을 때. 목록은 그대로 두고 이것만 띄운다.
 * 화면에 있던 기록을 오류 문구로 덮어 버리면 방금까지 보던 것이 사라진다.
 */
export function renderToast(msg: string): string {
  return `<div class="toast" role="alert">
    <p><b>반영하지 못했습니다</b>${esc(msg)}</p>
    <button type="button" aria-label="닫기" onclick="habitChain.clearToast()">✕</button>
  </div>`;
}

function renderCard(h: Habit, state: State, idx: Set<string>, today: DateStr): string {
  const stats = compute(datesOf(state, h.id), today);
  const doneToday = idx.has(`${h.id}|${today}`);
  const color = h.color || SWATCHES[0]!;
  const id = esc(h.id);

  // 0일째가 두 가지 뜻을 갖는다. 아직 시작 전인 것과, 이어오다 끊긴 것.
  let word = "일째 이어가는 중";
  if (stats.current === 0) {
    word = stats.total === 0 ? "일째 · 오늘 첫 칸을 채우세요" : "일째 · 오늘 다시 시작하세요";
  }

  return `<article class="card" style="--habit:${esc(color)}">
  <div class="card-head">
    <div>
      <h2 class="card-title">${esc(h.name)}</h2>
      <p class="streak${stats.current === 0 ? " dead" : ""}"><b>${stats.current}</b><span>${word}</span></p>
    </div>
    <div class="card-actions">
      <button id="t-${id}" class="today-btn${doneToday ? " done" : ""}"
        aria-pressed="${doneToday}" ${toggleAttrs(h.id, today)}>${doneToday ? "오늘 완료" : "오늘 체크"}</button>
      <button class="icon-btn del-btn" aria-label="'${esc(h.name)}' 삭제" title="삭제"
        hx-delete="/habits/${encodeURIComponent(h.id)}"
        hx-target="#habits" hx-swap="innerHTML" hx-indicator="closest .card"
        hx-confirm="'${esc(h.name)}'의 기록 ${stats.total}회가 함께 지워집니다. 되돌릴 수 없습니다.">${TRASH}</button>
    </div>
  </div>
  <div class="card-body">${renderGrid(h, idx, today)}${renderStats(stats)}</div>
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
 *
 * 붙어 있는 날들은 사이를 이어 하나의 사슬로 보이게 한다. 줄이 바뀌는 자리
 * (토→일)에도 짧은 꼬리를 달아 둔다 — 거기서 끊긴 것처럼 보이면 앱이 하는
 * 말과 화면이 어긋난다.
 *
 * 주가 세로로 흐르므로 달 이름은 맨 왼쪽 칸에 붙는다.
 */
function renderGrid(h: Habit, idx: Set<string>, today: DateStr): string {
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

  // 사슬이 마지막으로 끊긴 자리. 오늘은 제외한다 — 오늘 밤에 하면 되니까.
  let broke = -1;
  for (let i = days - 1; i >= 1; i--) {
    if (dates[i]! >= today) continue;
    if (!done[i] && done[i - 1]) {
      broke = i;
      break;
    }
  }

  const parts: string[] = [`<div class="grid" role="group" aria-label="${esc(h.name)} 최근 ${GRID_WEEKS}주">`];
  parts.push(`<div class="mon" aria-hidden="true"></div>`);
  DOW.forEach((n, i) => {
    parts.push(`<div class="dow${i === 0 ? " sun" : ""}" aria-hidden="true">${n}</div>`);
  });

  for (let i = 0; i < days; i++) {
    const d = dates[i]!;

    if (i % 7 === 0) {
      const week = dates.slice(i, i + 7);
      const starts = i === 0 || week.some((x) => x.endsWith("-01"));
      const label = starts ? `${Number((week.find((x) => x.endsWith("-01")) ?? d).slice(5, 7))}월` : "";
      parts.push(`<div class="mon" aria-hidden="true">${label}</div>`);
    }

    const future = d > today;
    let cls = "cell";
    if (future) {
      cls += " future";
    } else if (done[i]) {
      cls += " done";
      if (i % 7 !== 0 && done[i - 1]) cls += " link-l";
      if (i % 7 !== 6 && done[i + 1] && dates[i + 1]! <= today) cls += " link-r";
      if (i % 7 === 0 && i > 0 && done[i - 1]) cls += " wrap-l";
      if (i % 7 === 6 && i + 1 < days && done[i + 1] && dates[i + 1]! <= today) cls += " wrap-r";
    } else if (i === broke) {
      cls += " broke";
    }
    if (d === today) cls += " today";

    const state = future ? "" : done[i] ? " 완료" : i === broke ? " 미완료, 여기서 사슬이 끊겼습니다" : " 미완료";
    const label = `${md(d)} ${DOW[dayOfWeek(d)]}요일${state}`;
    const attrs = future
      ? `disabled tabindex="-1"`
      : `id="c-${esc(h.id)}-${d}" aria-pressed="${done[i]}" tabindex="${d === today ? 0 : -1}" ${toggleAttrs(h.id, d)}`;

    parts.push(`<button type="button" class="${cls}" ${attrs} aria-label="${label}"></button>`);
  }

  parts.push("</div>");
  return parts.join("");
}

const TRASH =
  `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.6 5.5l.7 10a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.7-10"/></svg>`;

const GEAR =
  `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="2.7"/>` +
  `<path d="M10 2.4v1.9M10 15.7v1.9M17.6 10h-1.9M4.3 10H2.4M15.4 4.6l-1.4 1.4M6 14l-1.4 1.4M15.4 15.4 14 14M6 6 4.6 4.6"/></svg>`;

/** 맞물린 고리 두 개. 앱 이름을 그대로 그린 것이다. */
const MARK =
  `<svg viewBox="0 0 30 16" width="28" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">` +
  `<rect x="1" y="3" width="15" height="10" rx="5"/><rect x="14" y="3" width="15" height="10" rx="5"/></svg>`;

/**
 * shell은 첫 요청에 돌려주는 페이지다.
 *
 * 데이터를 담지 않는다. 첫 GET은 htmx 요청이 아니라서 hx-headers가 붙지 않고,
 * 그러면 서버가 사용자의 로컬 날짜도 쓰기 키도 모른다. 그래서 목록은
 * hx-trigger="load"로 한 번 더 요청해서 채운다 — 그 요청부터는 헤더가 붙는다.
 */
export function shell(): string {
  const swatches = SWATCHES.map(
    (c, i) =>
      `<label style="--sw:${c}"><input type="radio" name="color" value="${c}"${
        i === 0 ? " checked" : ""
      } aria-label="색 ${i + 1}"><span></span></label>`,
  ).join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Habit Chain — 끊지 말 것</title>
<meta name="description" content="Don't break the chain. 매일 이어붙인 사슬을 눈으로 확인하는 습관 추적기.">
<meta name="theme-color" content="#131211" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f1f1ef" media="(prefers-color-scheme: light)">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..700&display=swap">
<link rel="stylesheet" href="/app.css">
<script src="/htmx.min.js" defer></script>
</head>
<body hx-headers='js:{"X-Local-Date": habitChain.today(), "X-Write-Key": habitChain.writeKey()}'>

<div id="progress" aria-hidden="true"></div>
<span id="live" class="sr-only" role="status"></span>

<div id="app">
  <header class="topbar">
    <h1 class="wordmark">${MARK} Habit Chain</h1>
    <button class="icon-btn" aria-label="설정" title="설정"
      onclick="document.getElementById('settings').showModal()">${GEAR}</button>
  </header>

  <main>
    <section id="habits" class="habits" hx-get="/habits" hx-trigger="load" hx-swap="innerHTML">
      <p class="sr-only">불러오는 중</p>
      <div class="sk" aria-hidden="true"><div></div><div></div></div>
    </section>

    <form class="add-form" autocomplete="off"
      hx-post="/habits" hx-target="#habits" hx-swap="innerHTML" hx-indicator="this"
      hx-on::after-request="habitChain.afterAdd(event, this)">
      <input id="new-name" name="name" type="text" placeholder="새 습관 (예: 아침 30분 달리기)" maxlength="60" required>
      <div class="add-row">
        <div class="swatches" role="radiogroup" aria-label="사슬 색">${swatches}</div>
        <button type="submit" class="primary">추가</button>
      </div>
    </form>
  </main>

  <div id="toast" aria-live="assertive"></div>

  <dialog id="settings">
    <div class="settings-head">
      <h2>설정</h2>
      <button class="icon-btn" aria-label="닫기"
        onclick="document.getElementById('settings').close()">✕</button>
    </div>

    <div class="settings-body">
      <fieldset id="write-key-row" hidden>
        <legend>쓰기 키</legend>
        <p class="hint">
          이 서버가 <code>WRITE_KEY</code>를 요구합니다. 키는 이 브라우저에만 저장되고,
          요청마다 헤더로 실려 갑니다.
        </p>
        <label for="set-write-key">키
          <input id="set-write-key" type="password" placeholder="서버의 WRITE_KEY" spellcheck="false"
            oninput="habitChain.saveWriteKey(this.value)">
        </label>
      </fieldset>

      <fieldset>
        <legend>데이터</legend>
        <p class="hint">
          기록의 원본은 이 서버가 물고 있는 DoltHub DB(<code id="db-name">…</code>)입니다.
          브라우저에는 쓰기 키만 남습니다.
        </p>
        <div class="row">
          <a class="ghost" href="/export" download>JSON 내보내기</a>
          <a class="ghost" href="/schema.sql" target="_blank" rel="noopener">스키마 SQL 보기</a>
        </div>
      </fieldset>

      <fieldset>
        <legend>사슬 규칙</legend>
        <p class="hint">
          오늘 아직 체크하지 않았어도, 어제까지 이어져 있으면 사슬은 살아 있습니다.
          하루를 통째로 건너뛰어야 끊어집니다. 끊긴 자리에는 빨간 눈금이 남습니다.
        </p>
      </fieldset>
    </div>
  </dialog>

  <dialog id="confirm" class="confirm">
    <h2>삭제할까요?</h2>
    <p id="confirm-msg"></p>
    <div class="confirm-row">
      <button type="button" data-confirm="no">취소</button>
      <button type="button" class="danger" data-confirm="yes">삭제</button>
    </div>
  </dialog>
</div>

<script>
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
  clearToast() {
    document.getElementById("toast").innerHTML = "";
  },
  // 빈 화면의 예시를 누르면 입력란이 채워진다. 첫 습관을 만드는 데 드는 손을 줄인다.
  suggest(name) {
    const el = document.getElementById("new-name");
    el.value = name;
    el.focus();
  },
  // 추가에 성공하면 색을 다음 것으로 넘긴다. 안 그러면 전부 같은 색이 된다.
  afterAdd(event, form) {
    if (!event.detail.successful || event.detail.xhr.status >= 400) return;
    const dots = [...form.querySelectorAll(".swatches input")];
    const at = dots.findIndex((d) => d.checked);
    form.reset();
    dots[(at + 1) % dots.length].checked = true;
    document.getElementById("new-name").focus();
  },
};

document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("set-write-key");
  if (input) input.value = window.habitChain.writeKey();

  fetch("/api/health").then((r) => r.json()).then((cfg) => {
    if (cfg.requiresKey) document.getElementById("write-key-row").hidden = false;
    if (cfg.db) document.getElementById("db-name").textContent = cfg.db;
  }).catch(() => {});
});

/* 쓰기 왕복이 1.5~2초다. 그동안 아무 표시가 없으면 눌린 건지 알 수 없다. */
let inFlight = 0;
const bar = document.getElementById("progress");
document.addEventListener("htmx:beforeRequest", () => {
  inFlight++;
  bar.classList.add("on");
});
document.addEventListener("htmx:afterRequest", () => {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) bar.classList.remove("on");
});

/* 오류 응답도 갈아끼워야 한다. 서버가 HX-Retarget으로 목적지를 토스트로 돌린다. */
document.addEventListener("htmx:beforeSwap", (e) => {
  if (e.detail.xhr.status >= 400) e.detail.shouldSwap = true;
});

/* 눌린 칸으로 포커스를 되돌린다. hx-disabled-elt이 버튼을 비활성화하는 순간
   포커스가 body로 넘어가서, htmx의 기본 복원만으로는 돌아오지 않는다. */
let refocus = null;
document.addEventListener("htmx:beforeRequest", (e) => {
  const id = e.detail.elt && e.detail.elt.id;
  refocus = id && /^[ct]-/.test(id) ? id : null;
});
document.addEventListener("htmx:afterSettle", (e) => {
  if (e.detail.target && e.detail.target.id !== "toast") window.habitChain.clearToast();
  if (!refocus) return;
  const el = document.getElementById(refocus);
  refocus = null;
  if (el) el.focus({ preventScroll: true });
});

/* 그리드는 카드마다 35칸이다. 전부 탭 순서에 넣으면 키보드로는 지나갈 수가 없어서,
   칸 하나만 탭으로 들어가고 안에서는 방향키로 움직인다.
   문서에 위임한다 — 카드는 통째로 갈아끼워지므로 카드에 건 리스너는 죽는다. */
const STEP = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
document.addEventListener("keydown", (e) => {
  const cell = e.target.closest && e.target.closest(".cell");
  if (!cell || !STEP[e.key]) return;
  const cells = [...cell.closest(".grid").querySelectorAll(".cell:not(.future)")];
  const next = cells[cells.indexOf(cell) + STEP[e.key]];
  if (!next) return;
  e.preventDefault();
  cells.forEach((c) => c.setAttribute("tabindex", "-1"));
  next.setAttribute("tabindex", "0");
  next.focus();
});

/* 삭제 확인. 네이티브 confirm()은 렌더링을 막고 화면과 따로 논다. */
const confirmBox = document.getElementById("confirm");
let pending = null;
document.addEventListener("htmx:confirm", (e) => {
  if (!e.detail.question) return;
  e.preventDefault();
  pending = e.detail;
  document.getElementById("confirm-msg").textContent = e.detail.question;
  confirmBox.showModal();
});
confirmBox.addEventListener("click", (e) => {
  const answer = e.target.closest("[data-confirm]");
  if (!answer) return;
  confirmBox.close();
  if (answer.dataset.confirm === "yes" && pending) pending.issueRequest(true);
  pending = null;
});
confirmBox.addEventListener("close", () => { pending = null; });

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
