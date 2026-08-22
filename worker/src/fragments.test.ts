/**
 * Fragments and the page shell, checked as strings.
 *
 * The browser script is a file of its own now, but the shell still depends on
 * what it defines — hx-headers calls habitChain before anything else runs — so
 * the assertions that watch that script read web/app.js directly.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderCalHead, renderHabits, renderMetaForm, renderSetup } from "./fragments";
import { shell } from "./shell";
import type { State } from "./model";

/** The browser script, as text. npm test always runs from worker/. */
const appSrc = readFileSync("../web/app.js", "utf8");

describe("shell", () => {
  it("브라우저 스크립트가 문법적으로 성립한다", () => {
    // new Function parses without running: no document or htmx needed.
    expect(() => new Function(appSrc)).not.toThrow();
  });

  it("스크립트는 htmx 뒤에 실린다 — 순서가 곧 초기화 순서다", () => {
    const html = shell();
    expect(html.indexOf("/htmx.min.js")).toBeLessThan(html.indexOf("/app.js"));
    expect(html).toContain('<script src="/app.js" defer></script>');
  });

  it("DB 이름 검사는 owner/name만 통과시킨다", () => {
    const m = /!(\/\^\[A-Za-z0-9_-\][\s\S]*?\/)\.test\(db\)/.exec(appSrc);
    expect(m, "save()에 DB 이름 정규식이 있어야 한다").not.toBeNull();
    const re = new Function(`return ${m![1]}`)() as RegExp;
    expect(re.test("benelog/habit-chain")).toBe(true);
    expect(re.test("habit chain")).toBe(false);
    expect(re.test("habit-chain")).toBe(false);
    expect(re.test("a/b/c")).toBe(false);
  });

  it("설정은 버튼으로만 저장된다", () => {
    expect(shell()).toContain("habitChain.save()");
    expect(appSrc).toContain("removeProfile");
    // Going back to onchange autosave would store half-pasted tokens.
    expect(appSrc).not.toContain("saveDb");
    expect(appSrc).not.toContain("saveToken");
  });

  it("홈은 /habits 조각을 부르고, 갈림길 코드를 품는다", () => {
    const html = shell();
    expect(html).toContain('hx-get="/habits"');
    expect(html).not.toContain("og:title");
    expect(appSrc).toContain("renderPicker");
  });

  it("처음 온 브라우저는 안내로 한 번만 보낸다", () => {
    // 표식 저장이 실패하면 그대로 머문다 — /help와 / 사이 무한 이동을 막는다.
    expect(appSrc).toContain('localStorage.setItem("habit-chain.seen", "1")');
    expect(appSrc).toContain('location.replace("/help")');
  });

  it("사슬 규칙은 설정이 아니라 /help가 설명한다", () => {
    expect(shell()).not.toContain("사슬 규칙");
  });

  it("토큰은 페이지의 달력과 이름이 같은 프로필에서만 나온다", () => {
    expect(appSrc).toContain("p.db === this.db()");
    expect(appSrc).toContain("pathDb");
  });

  it("옛 저장 키는 새 목록이 저장된 뒤에만 지운다", () => {
    // persist가 실패하면 토큰의 유일한 사본이 사라지면 안 된다.
    expect(appSrc).toMatch(/if \(this\.persist\(list\)\) \{\s*localStorage\.removeItem\("habit-chain\.db"\)/);
  });
});

describe("shell · 달력 페이지(/@owner/name)", () => {
  const meta = { title: "정상혁의 습관 달력", description: "제가 실천하는 습관들" };

  it("제목과 설명이 og 태그까지 올라간다", () => {
    const html = shell({ db: "benelog/habit-chain", meta, origin: "https://chain.benelog.net" });
    expect(html).toContain("<title>정상혁의 습관 달력 — Habit Chain</title>");
    expect(html).toContain('property="og:title" content="정상혁의 습관 달력"');
    expect(html).toContain('property="og:description" content="제가 실천하는 습관들"');
    expect(html).toContain('property="og:url" content="https://chain.benelog.net/@benelog/habit-chain"');
    expect(html).toContain('property="og:image" content="https://chain.benelog.net/icons/icon-512.png"');
    expect(html).toContain('hx-get="/@benelog/habit-chain/habits"');
  });

  it("제목이 비면 DB 이름으로 대신한다", () => {
    const html = shell({ db: "benelog/habit-chain", meta: { title: "", description: "" }, origin: "https://x.test" });
    expect(html).toContain("<title>benelog/habit-chain의 습관 달력 — Habit Chain</title>");
  });

  it("남의 공개 DB에 든 태그가 head로 새지 않는다", () => {
    const html = shell({
      db: "a/b",
      meta: { title: '"><script>alert(1)</script>', description: "" },
      origin: "https://x.test",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("주인 화면과 방문자 화면이 같은 페이지다 — 설정과 추가 폼이 실려 온다", () => {
    const html = shell({ db: "a/b", meta: { title: "", description: "" }, origin: "https://x.test" });
    expect(html).toContain('id="settings"');
    expect(html).toContain('class="add-form"');
    expect(html).toContain('id="cal-title"');
    expect(html).toContain('id="cal-desc"');
  });

  it("제목·설명과 공유 주소는 달력 페이지의 설정에만 있다", () => {
    const cal = shell({ db: "a/b", meta: { title: "", description: "" }, origin: "https://x.test" });
    expect(cal).toContain('id="meta-form"');
    expect(cal).toContain('id="share-url"');
    expect(cal).toContain("https://x.test/@a/b");
    // 홈 설정은 달력 목록 관리만 한다. 제목은 특정 달력의 것이라 여기 없다.
    const home = shell();
    expect(home).not.toContain('id="meta-form"');
    expect(home).not.toContain('id="share-url"');
  });

  it("달력 전환 지름길은 달력 페이지에만 있고, 채우기 전에는 숨어 있다", () => {
    const cal = shell({ db: "a/b", meta: { title: "", description: "" }, origin: "https://x.test" });
    expect(cal).toContain('id="cal-switch" class="cal-switch" aria-label="내 달력" hidden');
    expect(appSrc).toContain("renderCalSwitch");
    expect(shell()).not.toContain('id="cal-switch"');
  });

  it("달력 폼은 접혀 있고, 추가와 수정을 겸한다", () => {
    const html = shell();
    expect(html).toContain('id="profile-form" class="profile-form" hidden');
    expect(html).toContain("habitChain.openForm()");
    expect(html).toContain("habitChain.closeForm()");
  });
});

describe("renderCalHead", () => {
  it("비공개 DB의 제목을 주인의 조각이 oob로 바로잡는다", () => {
    const html = renderCalHead({ title: "내 달력", description: "설명" }, "a/b");
    expect(html).toContain('id="cal-title" hx-swap-oob="true"');
    expect(html).toContain("내 달력");
    expect(html).toContain('id="cal-desc" hx-swap-oob="true"');
  });

  it("제목이 비면 DB 이름으로 대신한다", () => {
    expect(renderCalHead({ title: "", description: "" }, "a/b")).toContain("a/b의 습관 달력");
  });
});

describe("renderSetup", () => {
  it("설정으로 가는 길을 준다", () => {
    const html = renderSetup();
    expect(html).toContain("class=\"empty setup\"");
    expect(html).toContain("showModal()");
    expect(html).toContain("/schema.sql");
  });
});

describe("renderHabits", () => {
  const today = "2026-08-22";
  const state: State = {
    habits: [
      {
        id: "a",
        name: "달리기",
        description: "아침에 30분.\n비 오면 실내에서.",
        color: "#e2542f",
        created_at: "",
        archived: false,
      },
    ],
    checks: [
      { habit_id: "a", date: "2026-08-22", note: "" },
      { habit_id: "a", date: "2026-08-21", note: "" },
    ],
    meta: { title: "", description: "" },
  };

  it("칸마다 날짜가 적힌다", () => {
    const html = renderHabits(state, today);
    expect(html).toContain(">22</span>");
    expect(html).toContain(">21</span>");
  });

  it("달이 바뀌는 칸에는 달까지 적는다", () => {
    const html = renderHabits(state, today);
    expect(html).toContain(">8/1</span>");
    expect(html).not.toContain(">1</span>");
  });

  it("달 이름은 줄의 첫 칸이 속한 달을 따른다", () => {
    // Labelling the Jul 26 - Aug 1 row "August" misreads the whole row.
    const html = renderHabits(state, today);
    const months = [...html.matchAll(/<div class="mon" aria-hidden="true">([^<]*)<\/div>/g)].map(
      (m) => m[1],
    );
    // One header cell plus five weeks, changing once at the Aug 2 row.
    expect(months).toEqual(["", "7월", "", "8월", "", ""]);
  });

  it("칸의 title에 날짜가 들어간다", () => {
    expect(renderHabits(state, today)).toContain('title="8월 22일 토요일 완료"');
  });

  it("설명은 줄바꿈을 그대로 담는다", () => {
    const html = renderHabits(state, today);
    expect(html).toContain('<p class="card-desc">아침에 30분.\n비 오면 실내에서.</p>');
  });

  it("설명이 비면 그 자리를 만들지 않는다", () => {
    const bare: State = { ...state, habits: [{ ...state.habits[0]!, description: "" }] };
    expect(renderHabits(bare, today)).not.toContain("card-desc");
  });

  it("편집 폼이 카드마다 함께 나온다", () => {
    const html = renderHabits(state, today);
    expect(html).toContain('hx-put="/habits/a"');
    expect(html).toContain('name="name" type="text" value="달리기"');
    // The textarea's content is the form default that cancel resets to.
    expect(html).toContain("아침에 30분.\n비 오면 실내에서.</textarea>");
  });

  it("편집 폼에서 색을 고칠 수 있고, 지금 색이 선택돼 있다", () => {
    const html = renderHabits(state, today);
    expect(html).toContain('value="#e2542f" checked');
    // 목록에 없는 옛 색이면 아무것도 선택하지 않는다 — 서버가 색을 지킨다.
    const legacy: State = { ...state, habits: [{ ...state.habits[0]!, color: "#f97316" }] };
    const form = /<form class="card-edit"[\s\S]*?<\/form>/.exec(renderHabits(legacy, today))![0];
    expect(form).toContain('name="color"');
    expect(form).not.toContain("checked");
  });

  it("설명에 든 태그는 화면으로 새지 않는다", () => {
    const nasty: State = {
      ...state,
      habits: [{ ...state.habits[0]!, description: "</textarea><script>alert(1)</script>" }],
    };
    const html = renderHabits(nasty, today);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/textarea&gt;");
  });

});

describe("renderHabits · 공개(읽기 전용)", () => {
  const today = "2026-08-22";
  const state: State = {
    habits: [
      { id: "a", name: "달리기", description: "", color: "#e2542f", created_at: "", archived: false },
    ],
    checks: [{ habit_id: "a", date: "2026-08-22", note: "" }],
    meta: { title: "정상혁의 습관 달력", description: "" },
  };

  it("사슬은 보이지만 당길 수는 없다 — 쓰기로 가는 속성이 하나도 없다", () => {
    const html = renderHabits(state, today, true);
    expect(html).not.toContain("hx-post");
    expect(html).not.toContain("hx-put");
    expect(html).not.toContain("hx-delete");
    expect(html).not.toContain("오늘 체크");
    expect(html).toContain('class="grid ro"');
  });

});

describe("renderMetaForm", () => {
  it("DB의 값을 담고, 저장은 /meta로 간다", () => {
    const html = renderMetaForm({ title: "정상혁의 습관 달력", description: "" }, true);
    expect(html).toContain('hx-put="/meta"');
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain('value="정상혁의 습관 달력"');
  });
});
