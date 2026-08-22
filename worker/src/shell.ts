/**
 * The page shell — the frame the fragments arrive in, shared by home (/) and
 * calendar pages (/@owner/name).
 *
 * The browser script is web/app.js, deferred after htmx. That order is what
 * habitChain owes htmx: body's hx-headers calls it on the first request, and
 * renderPicker strips hx-get before htmx reads the DOM.
 */

import type { Meta } from "./model";
import { SWATCHES, esc, swatchInputs } from "./fragments";

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
  <nav id="cal-switch" class="cal-switch" aria-label="내 달력" hidden></nav>
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

  const swatches = swatchInputs(SWATCHES[0]!);

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
<script src="/app.js" defer></script>
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
</body>
</html>`;
}
