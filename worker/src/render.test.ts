/**
 * render.ts fragments, checked as strings.
 *
 * One thing matters most here: the browser script lives inside a template
 * literal, so one misplaced escape breaks the entire script. The page still
 * renders while settings, the progress bar and today's date all go dead — and
 * no server test would notice. So shell()'s script is really parsed below.
 */

import { describe, expect, it } from "vitest";
import { publicShell, renderHabits, renderMetaForm, renderSetup, shell } from "./render";
import type { State } from "./model";

/** Pulls out just the inline script shell() embeds. */
function inlineScript(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  expect(m, "shell()에 인라인 스크립트가 있어야 한다").not.toBeNull();
  return m![1]!;
}

describe("shell", () => {
  it("인라인 스크립트가 문법적으로 성립한다", () => {
    const src = inlineScript(shell());
    // new Function parses without running: no document or htmx needed.
    expect(() => new Function(src)).not.toThrow();
  });

  it("DB 이름 검사는 owner/name만 통과시킨다", () => {
    const src = inlineScript(shell());
    const m = /!(\/\^\[A-Za-z0-9_-\][\s\S]*?\/)\.test\(db\)/.exec(src);
    expect(m, "save()에 DB 이름 정규식이 있어야 한다").not.toBeNull();
    const re = new Function(`return ${m![1]}`)() as RegExp;
    expect(re.test("benelog/habit-chain")).toBe(true);
    expect(re.test("habit chain")).toBe(false);
    expect(re.test("habit-chain")).toBe(false);
    expect(re.test("a/b/c")).toBe(false);
  });

  it("설정은 버튼으로만 저장된다", () => {
    const html = shell();
    expect(html).toContain("habitChain.save()");
    expect(html).toContain("habitChain.forget()");
    // Going back to onchange autosave would store half-pasted tokens.
    expect(html).not.toContain("habitChain.saveDb");
    expect(html).not.toContain("habitChain.saveToken");
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

  it("설명에 든 태그는 화면으로 새지 않는다", () => {
    const nasty: State = {
      ...state,
      habits: [{ ...state.habits[0]!, description: "</textarea><script>alert(1)</script>" }],
    };
    const html = renderHabits(nasty, today);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/textarea&gt;");
  });

  it("제목을 정하면 자기 화면 위에도 보인다", () => {
    const titled: State = { ...state, meta: { title: "정상혁의 습관 달력", description: "제가 실천하는 습관들" } };
    const html = renderHabits(titled, today);
    expect(html).toContain('<p class="page-title">정상혁의 습관 달력</p>');
    expect(html).toContain('<p class="page-desc">제가 실천하는 습관들</p>');
    // Nothing set, nothing shown — no empty band above the list.
    expect(renderHabits(state, today)).not.toContain("page-head");
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

  it("제목은 조각이 아니라 공개 껍데기가 갖는다 — 두 번 보이지 않도록", () => {
    expect(renderHabits(state, today, true)).not.toContain("page-head");
  });
});

describe("publicShell", () => {
  it("제목과 설명이 og 태그까지 올라간다", () => {
    const html = publicShell(
      "benelog/habit-chain",
      { title: "정상혁의 습관 달력", description: "제가 실천하는 습관들" },
      "https://chain.benelog.net",
    );
    expect(html).toContain("<title>정상혁의 습관 달력 — Habit Chain</title>");
    expect(html).toContain('property="og:title" content="정상혁의 습관 달력"');
    expect(html).toContain('property="og:description" content="제가 실천하는 습관들"');
    expect(html).toContain('property="og:url" content="https://chain.benelog.net/@benelog/habit-chain"');
    expect(html).toContain('hx-get="/@benelog/habit-chain/habits"');
  });

  it("제목이 비면 DB 이름으로 대신한다", () => {
    const html = publicShell("benelog/habit-chain", { title: "", description: "" }, "https://x.test");
    expect(html).toContain("<title>benelog/habit-chain의 습관 달력 — Habit Chain</title>");
  });

  it("남의 공개 DB에 든 태그가 head로 새지 않는다", () => {
    const html = publicShell(
      "a/b",
      { title: '"><script>alert(1)</script>', description: "" },
      "https://x.test",
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("방문자의 설정을 읽지 않는다 — 로컬 날짜만 헤더로 보낸다", () => {
    const html = publicShell("a/b", { title: "", description: "" }, "https://x.test");
    expect(html).not.toContain("X-Dolt-Token");
    expect(html).not.toContain("localStorage");
    expect(html).toContain("X-Local-Date");
  });
});

describe("renderMetaForm", () => {
  it("공유 주소를 보여주고, 저장은 /meta로 간다", () => {
    const html = renderMetaForm(
      { title: "정상혁의 습관 달력", description: "" },
      "benelog/habit-chain",
      "https://chain.benelog.net",
      true,
    );
    expect(html).toContain('hx-put="/meta"');
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain("https://chain.benelog.net/@benelog/habit-chain");
    expect(html).toContain('value="정상혁의 습관 달력"');
  });
});
