/**
 * HTML fragments.
 *
 * One rule holds the screen together: the shell is greyscale and only chains
 * carry colour. Habit colours are the user's, so UI colour would fight them.
 *
 * Fragments come in two sizes — the whole list (#habits) and one card (.card).
 * Toggling swaps only the card, with the day summary following out-of-band.
 *
 * Pages come in two kinds sharing one shell: home (/) routes between setup,
 * a calendar picker and a redirect, and a calendar page (/@owner/name) shows
 * one DB — editable when this browser holds that DB's token, read-only for
 * everyone else.
 */

import type { DateStr, Habit, Meta, State, Stats } from "./model";
import { addDays, checkSet, compute, datesOf, dayOfWeek } from "./model";

/** Weeks shown in each card's chain grid. */
const GRID_WEEKS = 5;

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * Colours a new habit may take. This replaced the native colour picker: free
 * choice fills the screen with clashing colours. All are mid-lightness so they
 * read on light and dark backgrounds alike.
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

/** Every user-supplied value passes through here before reaching HTML. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Formats a date for display: "2026-08-21" becomes "8월 21일". */
function md(d: DateStr): string {
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
}

/**
 * Shared htmx attributes for toggle buttons.
 *
 * Without hx-disabled-elt the 2s round trip invites double taps. INSERT IGNORE
 * and DELETE keep the data sound, but commits pile up.
 *
 * hx-indicator sits on the card so it dims and stops taking pointer events —
 * overlapping taps on the same card would interleave responses. (`this` cannot
 * go in the indicator list: htmx reads it as a CSS type selector and matches
 * nothing. The pressed cell gets disabled instead, and CSS pulses off that.)
 */
function toggleAttrs(habitID: string, date: DateStr): string {
  return (
    `hx-post="/habits/${encodeURIComponent(habitID)}/toggle?date=${date}" ` +
    `hx-target="closest .card" hx-swap="outerHTML" ` +
    `hx-indicator="closest .card" hx-disabled-elt="this"`
  );
}

/**
 * The whole fragment that goes inside #habits. readonly is the visitor's view:
 * no toggling, no editing. The calendar's title is not here — the page shell
 * owns it, and the editable load corrects it out-of-band (renderCalHead).
 */
export function renderHabits(state: State, today: DateStr, readonly = false): string {
  if (state.habits.length === 0) {
    return renderEmpty(readonly);
  }
  const idx = checkSet(state);
  return (
    renderDay(state, today, false) +
    state.habits.map((h) => renderCard(h, state, idx, today, readonly)).join("")
  );
}

/** One card — the body of a toggle response. Callers check it exists first. */
export function renderOneCard(state: State, habitID: string, today: DateStr): string {
  const h = state.habits.find((x) => x.id === habitID);
  return h ? renderCard(h, state, checkSet(state), today) : "";
}

function renderEmpty(readonly = false): string {
  if (readonly) {
    return `<div class="empty">
    <h2>아직 습관이 없습니다</h2>
    <p>이 달력의 주인이 첫 습관을 추가하면 여기에 사슬이 자랍니다.</p>
  </div>`;
  }
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
 * Shown when no calendar is saved yet. This is onboarding, not an error, so it
 * is not renderError — that screen's "reload" fixes nothing here. Settings is
 * the only place to go, so that is the only button.
 */
export function renderSetup(): string {
  return `<div class="empty setup">
    <h2>DoltHub DB를 연결하세요</h2>
    <p>이 앱은 <a href="https://www.dolthub.com" target="_blank" rel="noopener">DoltHub</a>에 데이터를 저장합니다.</p>
    <ol class="setup-steps">
      <li>DoltHub에 <b>빈 DB</b>를 하나 만듭니다. 표는 앱이 만듭니다.</li>
      <li>DoltHub의 <code>Settings → Tokens</code>에서 토큰을 발급합니다.</li>
      <li>설정에 <code>owner/name</code>과 토큰을 넣고 <b>저장</b>합니다.</li>
    </ol>
    <p class="setup-note">DB 이름만 넣어도 공개 DB는 읽힙니다. 기록하거나 비공개 DB를 읽으려면 토큰까지 있어야 합니다.</p>
    <div class="chips">
      <button class="primary" type="button" onclick="document.getElementById('settings').showModal()">설정 열기</button>
      <a class="ghost" href="/help">처음이신가요? 안내 보기</a>
      <a class="ghost" href="/schema.sql" target="_blank" rel="noopener">스키마 SQL 보기</a>
    </div>
  </div>`;
}

/**
 * The DB exists but its shape is wrong — no branch, no tables, or a missing
 * column. All take the same action from the user: one button. The manual
 * schema SQL stays as a link, for when that path is refused.
 */
export function renderPrepare(
  shape: { branch: boolean; habits: boolean; description: boolean; meta: boolean },
  hasToken: boolean,
): string {
  // Four states, one screen.
  let what = "이 DB는 지난 버전의 표를 쓰고 있습니다. 설명(description) 칸이 없습니다.";
  if (!shape.branch) {
    what = "이 DB에는 아직 커밋이 하나도 없습니다. 그래서 읽을 브랜치조차 없습니다.";
  } else if (!shape.habits) {
    what = "이 DB에는 아직 표가 없습니다.";
  } else if (shape.description && !shape.meta) {
    what = "이 DB에는 공개 페이지 제목을 담을 meta 표가 없습니다.";
  }
  const does = shape.branch && shape.habits ? "빠진 칸을 더합니다" : "표를 만듭니다";

  return `<div class="empty setup">
    <h2>DB를 준비해야 합니다</h2>
    <p>${what}</p>
    <p class="setup-note">누르면 이 앱이 당신의 토큰으로 ${does}. 있는 기록은 건드리지 않습니다.</p>
    <div class="chips">
      ${
        hasToken
          ? `<button class="primary" hx-post="/schema" hx-target="#habits" hx-swap="innerHTML"
        hx-disabled-elt="this">DB 준비하기</button>`
          : `<button class="primary" type="button"
        onclick="document.getElementById('settings').showModal()">토큰 넣기</button>`
      }
      <a class="ghost" href="/schema.sql" target="_blank" rel="noopener">스키마 SQL 보기</a>
    </div>
    ${hasToken ? "" : `<p class="setup-note">표를 만들려면 쓰기가 필요합니다. 설정에 토큰을 넣어 주세요.</p>`}
  </div>`;
}

/**
 * The day summary. People open this app to answer one question — am I done
 * today? — so that answer sits alone at the top.
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

/** Screen-reader-only result. aria-live on the list would reread everything. */
export function renderLive(text: string): string {
  return `<span id="live" class="sr-only" role="status" hx-swap-oob="true">${esc(text)}</span>`;
}

/** A failed load. Must not look like an empty list. */
export function renderError(msg: string, retry = "/habits"): string {
  return `<div class="empty">
    <h2>목록을 불러오지 못했습니다</h2>
    <p>${esc(msg)}</p>
    <div class="chips"><button class="ghost" hx-get="${esc(retry)}" hx-target="#habits" hx-swap="innerHTML">다시 불러오기</button></div>
  </div>`;
}

/**
 * A failed write. The list stays; overwriting it with an error would erase what
 * the user was just looking at.
 */
export function renderToast(msg: string): string {
  return `<div class="toast" role="alert">
    <p><b>반영하지 못했습니다</b>${esc(msg)}</p>
    <button type="button" aria-label="닫기" onclick="habitChain.clearToast()">✕</button>
  </div>`;
}

/**
 * The calendar-title form, living inside the settings dialog. It answers with
 * itself — its status line included — because a toast would sit invisible
 * behind the modal's backdrop. Sent out-of-band with the list so the fields
 * hold what the DB holds, not what the shell guessed.
 */
export function renderMetaForm(meta: Meta, oob: boolean, status = "", bad = false): string {
  return `<form id="meta-form"${oob ? ` hx-swap-oob="true"` : ""} hx-put="/meta" hx-swap="outerHTML"
    hx-on::after-request="habitChain.afterMetaSave(event)">
    <label for="meta-title">제목
      <input id="meta-title" name="title" type="text" value="${esc(meta.title)}" maxlength="100"
        placeholder="예: 정상혁의 습관 달력" autocomplete="off">
    </label>
    <label for="meta-desc">설명
      <textarea id="meta-desc" name="description" rows="2" maxlength="2000"
        placeholder="예: 제가 실천하고 있는 습관의 목록입니다">${esc(meta.description)}</textarea>
    </label>
    <div class="row">
      <button type="submit" class="primary">저장</button>
    </div>
    <p class="set-status${bad ? " bad" : ""}" role="status">${esc(status)}</p>
  </form>`;
}

/**
 * Out-of-band update for the calendar page's header. The shell reads meta
 * without a token, so a private DB's title never survives that first read;
 * the owner's list fragment carries the real value and corrects it here.
 */
export function renderCalHead(meta: Meta, db: string): string {
  return (
    `<h1 class="public-title" id="cal-title" hx-swap-oob="true">${esc(meta.title || `${db}의 습관 달력`)}</h1>` +
    `<p class="public-desc" id="cal-desc" hx-swap-oob="true">${esc(meta.description)}</p>`
  );
}

function renderCard(h: Habit, state: State, idx: Set<string>, today: DateStr, readonly = false): string {
  const stats = compute(datesOf(state, h.id), today);
  const doneToday = idx.has(`${h.id}|${today}`);
  const color = h.color || SWATCHES[0]!;
  const id = esc(h.id);

  // Zero days means two different things: not started, or broken.
  let word = "일째 이어가는 중";
  if (stats.current === 0) {
    word = stats.total === 0 ? "일째 · 오늘 첫 칸을 채우세요" : "일째 · 오늘 다시 시작하세요";
  }
  // A visitor cannot fill the owner's cells, so the coaching words go too.
  if (readonly && stats.current === 0) {
    word = stats.total === 0 ? "일 · 아직 시작 전" : "일 · 지금은 끊긴 상태";
  }

  const actions = readonly
    ? ""
    : `
    <div class="card-actions">
      <button id="t-${id}" class="today-btn${doneToday ? " done" : ""}"
        aria-pressed="${doneToday}" ${toggleAttrs(h.id, today)}>${doneToday ? "오늘 완료" : "오늘 체크"}</button>
      <button type="button" class="icon-btn edit-btn" aria-label="'${esc(h.name)}' 수정" title="수정"
        onclick="habitChain.edit(this)">${PENCIL}</button>
      <button class="icon-btn del-btn" aria-label="'${esc(h.name)}' 삭제" title="삭제"
        hx-delete="/habits/${encodeURIComponent(h.id)}"
        hx-target="#habits" hx-swap="innerHTML" hx-indicator="closest .card"
        hx-confirm="'${esc(h.name)}'의 기록 ${stats.total}회가 함께 지워집니다. 되돌릴 수 없습니다.">${TRASH}</button>
    </div>`;

  return `<article class="card" style="--habit:${esc(color)}">
  <div class="card-head">
    <div>
      <h2 class="card-title">${esc(h.name)}</h2>
      <p class="streak${stats.current === 0 ? " dead" : ""}"><b>${stats.current}</b><span>${word}</span></p>
    </div>${actions}
  </div>
${renderDesc(h)}${readonly ? "" : renderEdit(h)}  <div class="card-body">${renderGrid(h, idx, today, readonly)}${renderStats(stats)}</div>
</article>`;
}

/**
 * Multiline plain text. CSS (white-space: pre-wrap) keeps the newlines; turning
 * them into <br> would mix markup into what the user typed. Empty descriptions
 * emit nothing rather than a gap in every card.
 */
function renderDesc(h: Habit): string {
  return h.description === "" ? "" : `  <p class="card-desc">${esc(h.description)}</p>\n`;
}

/**
 * The edit form ships folded inside every card. Fetching it on demand would
 * cost a round trip — a read here takes nearly a second — so both the edit and
 * cancel buttons would stall. Folded in, opening is one class and only saving
 * reaches the server.
 *
 * Cancel works through form.reset() because these values are the form's
 * defaults. A successful save replaces the card, which clears the edit state.
 */
function renderEdit(h: Habit): string {
  const id = esc(h.id);
  return `  <form class="card-edit" hx-put="/habits/${encodeURIComponent(h.id)}"
    hx-target="closest .card" hx-swap="outerHTML" hx-indicator="closest .card"
    onkeydown="habitChain.escCancels(event)">
    <label for="e-name-${id}">이름</label>
    <input id="e-name-${id}" name="name" type="text" value="${esc(h.name)}" maxlength="60" required autocomplete="off">
    <label for="e-desc-${id}">설명</label>
    <textarea id="e-desc-${id}" name="description" rows="4" maxlength="2000"
      placeholder="여러 줄로 적어도 됩니다.">${esc(h.description)}</textarea>
    <div class="edit-row">
      <button type="button" class="ghost" onclick="habitChain.cancelEdit(this)">취소</button>
      <button type="submit" class="primary">저장</button>
    </div>
  </form>
`;
}

function renderStats(s: Stats): string {
  return `<dl class="card-stats">
    <div><dt>최장</dt><dd>${s.longest}<small>일</small></dd></div>
    <div><dt>누적</dt><dd>${s.total}<small>회</small></dd></div>
    <div><dt>최근 30일</dt><dd>${s.rate30}<small>%</small></dd></div>
  </dl>`;
}

/**
 * The last GRID_WEEKS weeks, aligned by weekday.
 *
 * Adjacent days are joined so they read as one chain, including a short tail
 * across the Saturday-to-Sunday wrap — a break there would contradict what the
 * app says. Weeks run down the page, so month labels sit in the left gutter.
 *
 * Cells carry their date: chain shape alone cannot answer "which day was that?"
 * Links are drawn in the gaps, so the numbers leave the chain intact.
 */
function renderGrid(h: Habit, idx: Set<string>, today: DateStr, readonly = false): string {
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

  // Where the chain last broke. Today is excluded — there is still tonight.
  let broke = -1;
  for (let i = days - 1; i >= 1; i--) {
    if (dates[i]! >= today) continue;
    if (!done[i] && done[i - 1]) {
      broke = i;
      break;
    }
  }

  const parts: string[] = [
    `<div class="grid${readonly ? " ro" : ""}" role="group" aria-label="${esc(h.name)} 최근 ${GRID_WEEKS}주">`,
  ];
  parts.push(`<div class="mon" aria-hidden="true"></div>`);
  DOW.forEach((n, i) => {
    parts.push(`<div class="dow${i === 0 ? " sun" : ""}" aria-hidden="true">${n}</div>`);
  });

  for (let i = 0; i < days; i++) {
    const d = dates[i]!;

    if (i % 7 === 0) {
      // Label the month of the row's first cell, and only when it changes.
      // Labelling the row that contains the 1st instead put "August" on a row
      // that is mostly July. The "8/1" cell already marks the boundary.
      const prev = i === 0 ? "" : dates[i - 7]!.slice(0, 7);
      const label = d.slice(0, 7) === prev ? "" : `${Number(d.slice(5, 7))}월`;
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

    // Only the 1st reads "8/1" — that cell is the month boundary in the grid.
    const dayNum = Number(d.slice(8, 10));
    const shown = dayNum === 1 ? `${Number(d.slice(5, 7))}/1` : String(dayNum);
    if (dayNum === 1) cls += " first";

    const state = future ? "" : done[i] ? " 완료" : i === broke ? " 미완료, 여기서 사슬이 끊겼습니다" : " 미완료";
    const label = `${md(d)} ${DOW[dayOfWeek(d)]}요일${state}`;

    // The visitor's view shows the chain but cannot pull on it: plain elements,
    // no htmx, and none of the 35 cells lands in the tab order.
    if (readonly) {
      parts.push(
        `<div class="${cls}" role="img" aria-label="${label}" title="${label}">` +
          `<span aria-hidden="true">${shown}</span></div>`,
      );
      continue;
    }

    const attrs = future
      ? `disabled tabindex="-1"`
      : `id="c-${esc(h.id)}-${d}" aria-pressed="${done[i]}" tabindex="${d === today ? 0 : -1}" ${toggleAttrs(h.id, d)}`;

    parts.push(
      `<button type="button" class="${cls}" ${attrs} aria-label="${label}" title="${label}">` +
        `<span aria-hidden="true">${shown}</span></button>`,
    );
  }

  parts.push("</div>");
  return parts.join("");
}

const TRASH =
  `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.6 5.5l.7 10a1 1 0 0 0 1 .9h5.4a1 1 0 0 0 1-.9l.7-10"/></svg>`;

const PENCIL =
  `<svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M13.6 3.4a1.6 1.6 0 0 1 2.3 2.3L7.4 14.1l-3 .7.7-3z"/></svg>`;

const GEAR =
  `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="2.7"/>` +
  `<path d="M10 2.4v1.9M10 15.7v1.9M17.6 10h-1.9M4.3 10H2.4M15.4 4.6l-1.4 1.4M6 14l-1.4 1.4M15.4 15.4 14 14M6 6 4.6 4.6"/></svg>`;

/** Two interlocking links — the app's name, drawn. */
const MARK =
  `<svg viewBox="0 0 30 16" width="28" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">` +
  `<rect x="1" y="3" width="15" height="10" rx="5"/><rect x="14" y="3" width="15" height="10" rx="5"/></svg>`;

export interface ShellOpts {
  /** The calendar page /@owner/name; home when absent. */
  db?: string;
  /** Read without a token before rendering — og tags must be server-side. */
  meta?: Meta;
  origin?: string;
}

/**
 * The page returned on first load. It carries no data: the first GET is not an
 * htmx request, so no hx-headers are attached and the server knows neither the
 * user's local date nor which token the browser holds. The list fills itself
 * with a second request via hx-trigger="load", which does carry the headers.
 *
 * Home and calendar pages share this shell. On a calendar page the DB comes
 * from the URL and the token from the browser's matching profile; visitors
 * without one get the read-only view and never send their other tokens here.
 */
export function shell(opts: ShellOpts = {}): string {
  const db = opts.db ?? "";
  const isCal = db !== "";
  const meta = opts.meta ?? { title: "", description: "" };
  const origin = opts.origin ?? "";
  const title = meta.title || `${db}의 습관 달력`;
  const desc = meta.description || "Don't break the chain. 매일 이어붙인 사슬을 눈으로 확인합니다.";

  const head = isCal
    ? `<title>${esc(title)} — Habit Chain</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin)}/@${esc(db)}">
<meta property="og:image" content="${esc(origin)}/icons/icon-512.png">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta name="twitter:card" content="summary">`
    : `<title>Habit Chain — 끊지 말 것</title>
<meta name="description" content="Don't break the chain. 매일 이어붙인 사슬을 눈으로 확인하는 습관 추적기.">`;

  // Always both elements, even empty — afterMetaSave and renderCalHead
  // update them in place, and :empty CSS keeps a blank one invisible.
  const calHead = isCal
    ? `
  <div class="public-head">
    <h1 class="public-title" id="cal-title">${esc(title)}</h1>
    <p class="public-desc" id="cal-desc">${esc(meta.description)}</p>
    <p class="public-db"><a href="https://www.dolthub.com/repositories/${esc(db)}"
      target="_blank" rel="noopener">${esc(db)}</a></p>
  </div>
`
    : "";

  const calFoot = isCal
    ? `
  <footer class="public-foot">
    <p>이 페이지는 <a href="/">Habit Chain</a>으로 만들었습니다 — "Don't break the chain."</p>
  </footer>
`
    : "";

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
${head}
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
<body hx-headers='js:{"X-Local-Date": habitChain.today(), "X-Dolt-DB": habitChain.db(), "X-Dolt-Token": habitChain.token()}'>

<div id="progress" aria-hidden="true"></div>
<span id="live" class="sr-only" role="status"></span>

<div id="app">
  <header class="topbar">
    <${isCal ? "p" : "h1"} class="wordmark">${MARK} Habit Chain</${isCal ? "p" : "h1"}>
    <button class="icon-btn" aria-label="설정" title="설정"
      onclick="document.getElementById('settings').showModal()">${GEAR}</button>
  </header>
${calHead}
  <main>
    <section id="habits" class="habits" hx-get="${isCal ? `/@${esc(db)}/habits` : "/habits"}" hx-trigger="load" hx-swap="innerHTML">
      <p class="sr-only">불러오는 중</p>
      <div class="sk" aria-hidden="true"><div></div><div></div></div>
    </section>

    <form class="add-form" autocomplete="off"
      hx-post="/habits" hx-target="#habits" hx-swap="innerHTML" hx-indicator="this"
      hx-on::after-request="habitChain.afterAdd(event, this)">
      <input id="new-name" name="name" type="text" placeholder="새 습관 (예: 아침 30분 달리기)" maxlength="60" required>
      <textarea id="new-desc" name="description" rows="2" maxlength="2000"
        placeholder="설명(선택. 여러 줄로 적어도 됩니다.)"></textarea>
      <div class="add-row">
        <div class="swatches" role="radiogroup" aria-label="사슬 색">${swatches}</div>
        <button type="submit" class="primary">추가</button>
      </div>
    </form>
  </main>
${calFoot}
  <div id="toast" aria-live="assertive"></div>

  <dialog id="settings">
    <div class="settings-head">
      <h2>설정</h2>
      <button class="icon-btn" aria-label="닫기"
        onclick="document.getElementById('settings').close()">✕</button>
    </div>

    <div class="settings-body">
      <fieldset>
        <legend>내 달력</legend>
        <p class="hint">
          이 앱은 <a href="https://www.dolthub.com" target="_blank" rel="noopener">DoltHub</a>에 데이터를 저장합니다.
          달력(DB)을 여러 개 저장해 두고 골라 쓸 수 있습니다 — 공개용과 비공개용을 나누고 싶다면 두 개를 저장하세요.
          처음이라면 <a href="/help">시작 안내</a>를 따라오세요.
        </p>
        <div id="profile-list" class="profile-list"></div>
        <div class="row">
          <button type="button" class="ghost" id="profile-add"
            onclick="habitChain.openForm()">＋ 달력 추가</button>
        </div>
        <div id="profile-form" class="profile-form" hidden>
          <p class="profile-form-title" id="profile-form-title">새 달력</p>
          <label for="set-db">DB 이름
            <input id="set-db" type="text" placeholder="owner/name" spellcheck="false"
              autocapitalize="none" autocorrect="off" autocomplete="off"
              onkeydown="habitChain.enterSaves(event)">
          </label>
          <label for="set-token">토큰
            <input id="set-token" type="password" placeholder="DoltHub → Settings → Tokens (읽기만 하면 비워 두세요)"
              spellcheck="false" autocapitalize="none" autocorrect="off" autocomplete="new-password"
              onkeydown="habitChain.enterSaves(event)">
          </label>
          <p class="hint">
            토큰이 있어야 기록되고, 비공개 DB는 읽을 때도 필요합니다. 저장을 누를 때 DoltHub에 물어
            바로 확인합니다. 토큰은 서버가 아닌 이 브라우저에만 저장됩니다.
            <b>공용 컴퓨터에서는 쓰고 난 뒤 목록에서 지워 주세요.</b>
          </p>
          <div class="row">
            <button type="button" class="primary" onclick="habitChain.save()">저장</button>
            <button type="button" class="ghost" onclick="habitChain.closeForm()">닫기</button>
          </div>
          <p id="set-status" class="set-status" role="status"></p>
        </div>
      </fieldset>
${
  isCal
    ? `
      <fieldset>
        <legend>달력 제목과 설명</legend>
        <p class="hint">
          달력 상단에 보이는 제목과 설명입니다. DB에 저장되므로 어느 브라우저로 열어도 함께 보입니다.
        </p>
        <form id="meta-form">
          <p class="hint">달력을 읽어 온 뒤에 적을 수 있습니다. 기록은 달력 주인만 됩니다.</p>
        </form>
      </fieldset>

      <fieldset>
        <legend>공유</legend>
        <p class="hint">
          공개 DB라면 누구나 이 주소로 달력을 볼 수 있습니다. 제목과 설명은 링크 미리보기에도 함께 실립니다.
          기록은 토큰을 가진 브라우저에서만 됩니다.
        </p>
        <div class="share-row">
          <code id="share-url">${esc(origin)}/@${esc(db)}</code>
          <button type="button" class="ghost" onclick="habitChain.copyShare(this)">복사</button>
        </div>
      </fieldset>
`
    : ""
}
      <fieldset>
        <legend>데이터</legend>
        <p class="hint">
          표는 앱이 만듭니다. 빈 DB와 토큰만 넣으면 목록 자리에 <b>DB 준비하기</b> 버튼이 뜹니다.
          그 길이 막혔을 때를 위해 스키마 SQL도 그대로 둡니다 — DoltHub 콘솔에 붙여넣고 커밋하면 됩니다.
        </p>
        <div class="row">
          <a class="ghost" id="export-link" href="/export" download>JSON 내보내기</a>
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
  KEY: "habit-chain.profiles",
  today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  },
  /**
   * Saved calendars: [{db, token}]. Earlier versions kept a single pair under
   * two keys; that pair folds in as a profile on first read. The old keys are
   * removed only once the new list is safely stored — persist can fail, and
   * failing must not delete the only copy of a token.
   */
  profiles() {
    let list = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(this.KEY) || "[]");
      if (Array.isArray(parsed)) {
        list = parsed
          .filter((p) => p && typeof p.db === "string" && p.db !== "")
          .map((p) => ({ db: p.db, token: typeof p.token === "string" ? p.token : "" }));
      }
    } catch {}
    try {
      const oldDb = localStorage.getItem("habit-chain.db");
      if (oldDb !== null) {
        if (oldDb !== "" && !list.some((p) => p.db === oldDb)) {
          list.push({ db: oldDb, token: localStorage.getItem("habit-chain.token") || "" });
        }
        if (this.persist(list)) {
          localStorage.removeItem("habit-chain.db");
          localStorage.removeItem("habit-chain.token");
        }
      }
    } catch {}
    return list;
  },
  persist(list) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  },
  // Which calendar this page shows. The URL is the whole answer.
  // The slash is written [/]: this script sits inside a template literal, so
  // an escaped slash loses a layer and shatters the regex.
  pathDb() {
    const m = /^[/]@([A-Za-z0-9_-]+[/][A-Za-z0-9_-]+)$/.exec(location.pathname);
    return m ? m[1] : "";
  },
  db() {
    return this.pathDb();
  },
  // The token rides only on the calendar it was saved for. Visiting someone
  // else's calendar must never leak the tokens saved for other DBs.
  token() {
    const mine = this.profiles().find((p) => p.db === this.db());
    return mine ? mine.token : "";
  },
  /**
   * Adds or updates one calendar profile. Settings save only on the button —
   * onchange autosave once stored half-pasted tokens.
   *
   * A non-empty token is asked about at DoltHub before it is stored. Only a
   * definitive rejection blocks the save: an unreachable DoltHub is not
   * evidence the token is bad, so that case saves anyway, says the check did
   * not happen, and stays on this page so the note is actually seen.
   *
   * A verified save moves to the calendar's own URL, or reloads in place.
   */
  async save() {
    if (this._saving) return;
    const db = document.getElementById("set-db").value.trim();
    const token = document.getElementById("set-token").value.trim();
    if (db === "") {
      this.status("DB 이름을 넣어 주세요. owner/name 형식입니다.", true);
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}[/][A-Za-z0-9_-]{1,64}$/.test(db)) {
      this.status("DB 이름은 owner/name 형식이어야 합니다.", true);
      return;
    }
    // Mirrors the server's isToken; [!-~] is printable ASCII. Checked here
    // because fetch() refuses a header holding anything else, which would
    // otherwise pass as "could not check" and get saved.
    if (token !== "" && !/^[!-~]{8,256}$/.test(token)) {
      this.status("토큰에 쓸 수 없는 글자가 들어 있습니다. 다시 붙여 넣어 주세요.", true);
      return;
    }

    let unchecked = "";
    if (token !== "") {
      this._saving = true;
      this.status("토큰을 확인하는 중…", false);
      let verdict;
      try {
        const res = await fetch("/api/token/check", {
          headers: { "X-Dolt-Token": token },
          cache: "no-store",
        });
        verdict = await res.json();
      } catch {
        verdict = { state: "unknown" };
      }
      this._saving = false;
      if (verdict.state === "invalid") {
        this.status(verdict.error || "DoltHub가 이 토큰을 거부했습니다.", true);
        return;
      }
      if (verdict.state !== "valid") {
        unchecked = "다만 DoltHub가 응답하지 않아 토큰은 확인하지 못했습니다.";
      }
    }

    const list = this.profiles();
    const at = list.findIndex((p) => p.db === db);
    if (at >= 0) list[at] = { db: db, token: token };
    else list.push({ db: db, token: token });
    if (!this.persist(list)) {
      this.status("이 브라우저에 저장할 수 없습니다.", true);
      return;
    }
    this.renderProfiles();

    // Saved but unverified. Stay here so the note is actually seen.
    if (unchecked !== "") {
      this.status("저장했습니다. " + unchecked, true);
      if (this.pathDb() === db) this.reload();
      return;
    }

    if (this.pathDb() === db) {
      if (token !== "") document.body.classList.remove("viewer");
      else document.body.classList.add("viewer");
      this.closeForm();
      document.getElementById("settings").close();
      this.say("저장했습니다. 사슬을 다시 읽습니다.");
      this.reload();
      return;
    }
    // Each calendar lives at its own URL now; go there.
    location.href = "/@" + db;
  },
  /* 설정 안의 저장된 달력 목록. DB 이름은 저장소에서 온 값이라 DOM API로만 넣는다. */
  renderProfiles() {
    const box = document.getElementById("profile-list");
    if (!box) return;
    box.textContent = "";
    const list = this.profiles();
    if (list.length === 0) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "저장된 달력이 아직 없습니다. 아래에서 첫 달력을 추가하세요.";
      box.appendChild(p);
      this.openForm();
      return;
    }
    const here = this.pathDb();
    for (const prof of list) {
      const row = document.createElement("div");
      row.className = "profile-row" + (prof.db === here ? " here" : "");
      const a = document.createElement("a");
      a.className = "profile-open";
      a.href = "/@" + prof.db;
      const name = document.createElement("code");
      name.textContent = prof.db;
      const state = document.createElement("small");
      state.textContent = prof.token === "" ? "읽기 전용" : "기록 가능";
      a.appendChild(name);
      a.appendChild(state);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ghost";
      edit.textContent = "수정";
      edit.onclick = () => this.openForm(prof.db);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "ghost";
      del.textContent = "지우기";
      del.onclick = () => this.removeProfile(prof.db, del);
      row.appendChild(a);
      row.appendChild(edit);
      row.appendChild(del);
      box.appendChild(row);
    }
  },
  /* 하나의 폼이 추가와 수정을 겸한다. 제목이 지금 어느 쪽인지 말해 준다. */
  openForm(db) {
    const mine = db ? this.profiles().find((p) => p.db === db) : null;
    document.getElementById("set-db").value = mine ? mine.db : "";
    document.getElementById("set-token").value = mine ? mine.token : "";
    document.getElementById("profile-form-title").textContent = mine ? "달력 수정 — " + mine.db : "새 달력";
    document.getElementById("profile-form").hidden = false;
    const focus = document.getElementById(mine ? "set-token" : "set-db");
    if (focus) focus.focus();
  },
  closeForm() {
    document.getElementById("profile-form").hidden = true;
  },
  /* 공유 주소 복사. 결과는 버튼 위에서 바로 말한다. */
  copyShare(btn) {
    const code = document.getElementById("share-url");
    if (!code || !navigator.clipboard) return;
    navigator.clipboard.writeText(code.textContent.trim()).then(
      () => { btn.textContent = "복사됨"; },
      () => { btn.textContent = "복사 실패"; },
    );
    setTimeout(() => { btn.textContent = "복사"; }, 2000);
  },
  /* 지우기는 같은 버튼을 두 번. 모달 위에 모달을 얹지 않기 위한 최소한의 확인. */
  removeProfile(db, btn) {
    if (btn.dataset.armed !== "1") {
      btn.dataset.armed = "1";
      btn.textContent = "정말 지울까요?";
      setTimeout(() => {
        btn.dataset.armed = "";
        btn.textContent = "지우기";
      }, 2500);
      return;
    }
    this.persist(this.profiles().filter((p) => p.db !== db));
    this.renderProfiles();
    this.status("이 브라우저에서 지웠습니다. DoltHub의 데이터와 토큰은 그대로 있습니다.", false);
  },
  /* 저장된 달력이 여럿일 때 홈은 목록 대신 갈림길이 된다. htmx는 defer라 이
     코드가 먼저 돈다 — hx-get을 떼면 목록 요청 자체가 나가지 않는다. */
  renderPicker(list) {
    const el = document.getElementById("habits");
    if (!el) return;
    el.removeAttribute("hx-get");
    el.removeAttribute("hx-trigger");
    el.textContent = "";
    const box = document.createElement("div");
    box.className = "empty picker";
    const h = document.createElement("h2");
    h.textContent = "어느 달력을 열까요?";
    const wrap = document.createElement("div");
    wrap.className = "picker-list";
    for (const prof of list) {
      const a = document.createElement("a");
      a.className = "picker-item";
      a.href = "/@" + prof.db;
      const name = document.createElement("code");
      name.textContent = prof.db;
      const state = document.createElement("small");
      state.textContent = prof.token === "" ? "읽기 전용" : "기록 가능";
      a.appendChild(name);
      a.appendChild(state);
      wrap.appendChild(a);
    }
    const hint = document.createElement("p");
    hint.textContent = "설정에서 달력을 더하거나 지울 수 있습니다.";
    box.appendChild(h);
    box.appendChild(wrap);
    box.appendChild(hint);
    el.appendChild(box);
  },
  /**
   * Reloads the list.
   *
   * htmx.trigger("#habits", "load") does nothing: htmx attaches no listener for
   * a load trigger, firing it once at init instead (addTriggerHandler). Saving
   * left the screen unchanged until a refresh, so issue the request directly.
   *
   * Passing source matters — hx-headers is inherited, and the walk up to body
   * is what puts the DB and token on the request.
   */
  reload() {
    const el = document.getElementById("habits");
    if (!el) return;
    el.innerHTML = '<p class="sr-only">불러오는 중</p><div class="sk" aria-hidden="true"><div></div><div></div></div>';
    const path = this.pathDb() === "" ? "/habits" : "/@" + this.pathDb() + "/habits";
    htmx.ajax("GET", path, { source: el, target: el, swap: "innerHTML" });
  },
  // Tells screen readers why the screen changed. Same slot as renderLive.
  say(msg) {
    const el = document.getElementById("live");
    if (el) el.textContent = msg;
  },
  // Enter saves too. Settings live in a dialog, not a form, so wire it up.
  enterSaves(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    this.save();
  },
  // One line of result, so pressing the button never looks like a no-op.
  status(msg, bad) {
    const el = document.getElementById("set-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("bad", !!bad);
    clearTimeout(this._statusTimer);
    this._statusTimer = setTimeout(() => {
      el.textContent = "";
      el.classList.remove("bad");
    }, 5000);
  },
  // Export is a link, so no headers are attached — the DB goes in the URL.
  syncExport() {
    const a = document.getElementById("export-link");
    const db = this.db();
    if (a) a.href = db ? "/export?db=" + encodeURIComponent(db) : "/export";
  },
  clearToast() {
    document.getElementById("toast").innerHTML = "";
  },
  /**
   * Editing happens inside the card. The form already shipped with it, so
   * opening is one class and only saving reaches the server — no waiting on
   * either the edit or the cancel button.
   */
  edit(btn) {
    const card = btn.closest(".card");
    if (!card) return;
    card.classList.add("editing");
    const el = card.querySelector(".card-edit input[name=name]");
    if (el) {
      el.focus();
      el.select();
    }
  },
  // Cancel undoes edits: the form's defaults are what the server sent.
  cancelEdit(el) {
    const card = el.closest(".card");
    if (!card) return;
    const form = card.querySelector(".card-edit");
    if (form) form.reset();
    card.classList.remove("editing");
  },
  // Esc cancels. This is not a dialog, so the browser will not do it for us.
  escCancels(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.cancelEdit(event.target);
  },
  // Tapping an example on the empty screen fills the field.
  suggest(name) {
    const el = document.getElementById("new-name");
    el.value = name;
    el.focus();
  },
  // The title also crowns this page; update it in place after a save.
  afterMetaSave(event) {
    if (!event.detail.successful || event.detail.xhr.status >= 400) return;
    const t = document.getElementById("meta-title");
    const d = document.getElementById("meta-desc");
    const ht = document.getElementById("cal-title");
    const hd = document.getElementById("cal-desc");
    if (ht && t) ht.textContent = t.value.trim() || this.pathDb() + "의 습관 달력";
    if (hd && d) hd.textContent = d.value.trim();
  },
  // Advance the colour after a successful add, or everything ends up alike.
  afterAdd(event, form) {
    if (!event.detail.successful || event.detail.xhr.status >= 400) return;
    const dots = [...form.querySelectorAll(".swatches input")];
    const at = dots.findIndex((d) => d.checked);
    form.reset();
    dots[(at + 1) % dots.length].checked = true;
    document.getElementById("new-name").focus();
  },
};

/* 홈과 달력 페이지의 갈림길. 프로필이 하나면 그 달력으로 바로 가고, 여럿이면
   고르게 한다. 달력 페이지에서는 토큰 없는 브라우저를 구경꾼으로 표시한다. */
(function () {
  const here = window.habitChain.pathDb();
  if (here !== "") {
    const mine = window.habitChain.profiles().find((p) => p.db === here);
    if (!mine || mine.token === "") document.body.classList.add("viewer");
    return;
  }
  if (location.pathname !== "/") return;
  const list = window.habitChain.profiles();
  if (list.length === 1) {
    location.replace("/@" + list[0].db);
    return;
  }
  if (list.length >= 2) window.habitChain.renderPicker(list);
})();

document.addEventListener("DOMContentLoaded", () => {
  window.habitChain.renderProfiles();
  window.habitChain.syncExport();
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
