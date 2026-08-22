// habit-chain browser script. Saved calendars (DB + token) live in this
// browser only; the rest wires htmx — progress, focus, keys, confirm, SW.
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
  pathDb() {
    const m = /^\/@([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)$/.exec(location.pathname);
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
    if (!/^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}$/.test(db)) {
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
          headers: { "X-Dolt-Token": token, "X-Dolt-DB": db },
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
  /* 달력 하나로 가는 링크. 설정 목록과 갈림길이 같은 모양을 쓴다. */
  profileLink(prof, cls) {
    const a = document.createElement("a");
    a.className = cls;
    a.href = "/@" + prof.db;
    const name = document.createElement("code");
    name.textContent = prof.db;
    const state = document.createElement("small");
    state.textContent = prof.token === "" ? "읽기 전용" : "기록 가능";
    a.appendChild(name);
    a.appendChild(state);
    return a;
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
      // Already-open form keeps what was half-typed; only unfold a closed one.
      if (document.getElementById("profile-form").hidden) this.openForm();
      return;
    }
    const here = this.pathDb();
    for (const prof of list) {
      const row = document.createElement("div");
      row.className = "profile-row" + (prof.db === here ? " here" : "");
      const a = this.profileLink(prof, "profile-open");
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
    // The shortcut row above the calendar mirrors this list; keep it in step.
    this.renderCalSwitch();
  },
  /* 내 다른 달력으로 건너가는 지름길. 어느 달력이 저장돼 있는지는 이
     브라우저만 알므로 서버가 아니라 여기서 그린다. 갈 곳이 없으면 숨는다. */
  renderCalSwitch() {
    const nav = document.getElementById("cal-switch");
    if (!nav) return;
    nav.textContent = "";
    nav.hidden = true;
    const here = this.pathDb();
    const list = this.profiles();
    if (!list.some((p) => p.db !== here)) return;
    // 이름만으로 겹치면 owner까지 붙인다. 겹치지 않으면 짧은 쪽이 읽기 쉽다.
    const names = list.map((p) => p.db.split("/")[1]);
    for (const prof of list) {
      const short = prof.db.split("/")[1];
      const label = names.filter((n) => n === short).length > 1 ? prof.db : short;
      let chip;
      if (prof.db === here) {
        chip = document.createElement("span");
        chip.setAttribute("aria-current", "page");
      } else {
        chip = document.createElement("a");
        chip.href = "/@" + prof.db;
      }
      chip.className = "cal-chip" + (prof.db === here ? " now" : "");
      chip.textContent = label;
      chip.title = prof.db;
      nav.appendChild(chip);
    }
    nav.hidden = false;
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
      wrap.appendChild(this.profileLink(prof, "picker-item"));
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
    window.habitChain.renderCalSwitch();
    return;
  }
  if (location.pathname !== "/") return;
  const list = window.habitChain.profiles();
  if (list.length === 0) {
    // A brand-new browser goes to the guide — once. From the second visit the
    // setup screen takes over, so coming back from /help never bounces. The
    // mark must stick before we leave: if storage refuses it, stay here.
    try {
      if (localStorage.getItem("habit-chain.seen") === null) {
        localStorage.setItem("habit-chain.seen", "1");
        location.replace("/help");
      }
    } catch {}
    return;
  }
  if (list.length === 1) {
    location.replace("/@" + list[0].db);
    return;
  }
  window.habitChain.renderPicker(list);
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
