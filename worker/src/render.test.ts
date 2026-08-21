/**
 * render.ts fragments, checked as strings.
 *
 * One thing matters most here: the browser script lives inside a template
 * literal, so one misplaced escape breaks the entire script. The page still
 * renders while settings, the progress bar and today's date all go dead — and
 * no server test would notice. So shell()'s script is really parsed below.
 */

import { describe, expect, it } from "vitest";
import { renderHabits, renderSetup, shell } from "./render";
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
});
