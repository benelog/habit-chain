/**
 * HTML fragments.
 *
 * One rule holds the screen together: the shell is greyscale and only chains
 * carry colour. Habit colours are the user's, so UI colour would fight them.
 *
 * Fragments come in two sizes — the whole list (#habits) and one card (.card).
 * Toggling swaps only the card, with the day summary following out-of-band.
 *
 * The page these land in is shell.ts.
 */

import type { DateStr, Habit, Meta, State, Stats } from "./model";
import { addDays, checkSet, computeStats, datesOf, dayOfWeek } from "./model";

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
function formatMonthDay(d: DateStr): string {
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
}

/**
 * The eight swatches as radio inputs. A colour outside the set — a legacy
 * default, say — checks nothing; the server then leaves the colour alone.
 */
export function swatchInputs(checked: string): string {
  return SWATCHES.map(
    (c, i) =>
      `<label style="--sw:${c}"><input type="radio" name="color" value="${c}"${
        c === checked ? " checked" : ""
      } aria-label="색 ${i + 1}"><span></span></label>`,
  ).join("");
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
      <li>DoltHub에 <b>빈 DB</b>를 하나 만듭니다. DB의 스키마는 앱이 만듭니다.</li>
      <li>DoltHub의 <code>Settings → Tokens</code>에서 토큰을 발급합니다.</li>
      <li>설정에 <code>owner/name</code>과 토큰을 넣고 <b>저장</b>합니다.</li>
    </ol>
    <p class="setup-note">DB 이름만 넣어도 공개 DB는 읽힙니다. 기록하거나 비공개 DB를 읽으려면 토큰까지 있어야 합니다.</p>
    <div class="chips">
      <button class="primary" type="button" onclick="document.getElementById('settings').showModal()">설정 열기</button>
      <a class="ghost" href="/help">처음이신가요? 안내 보기</a>
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
  <div class="day-date">${formatMonthDay(today)}<small>${DOW[dayOfWeek(today)]}요일</small></div>
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
  const stats = computeStats(datesOf(state, h.id), today);
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
      <div class="swatches" role="radiogroup" aria-label="사슬 색">${swatchInputs(h.color)}</div>
      <div class="edit-btns">
        <button type="button" class="ghost" onclick="habitChain.cancelEdit(this)">취소</button>
        <button type="submit" class="primary">저장</button>
      </div>
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
    const label = `${formatMonthDay(d)} ${DOW[dayOfWeek(d)]}요일${state}`;

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
