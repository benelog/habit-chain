/**
 * render.ts의 조각을 문자열로 확인한다.
 *
 * 여기서 꼭 지켜야 할 것이 하나 있다. 브라우저에서 도는 스크립트가 통째로
 * 템플릿 리터럴 안에 들어 있어서, 이스케이프가 한 겹 어긋나면 그 스크립트가
 * 통째로 파싱에 실패한다. 화면은 멀쩡히 뜨는데 설정도 진행 막대도 오늘 날짜도
 * 아무것도 안 도는 상태가 되고, 서버 테스트로는 하나도 안 잡힌다.
 * 그래서 shell()이 뱉은 스크립트를 여기서 실제로 파싱해 본다.
 */

import { describe, expect, it } from "vitest";
import { renderHabits, renderSetup, shell } from "./render";
import type { State } from "./model";

/** shell()이 심어 둔 인라인 스크립트만 꺼낸다. */
function inlineScript(html: string): string {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  expect(m, "shell()에 인라인 스크립트가 있어야 한다").not.toBeNull();
  return m![1]!;
}

describe("shell", () => {
  it("인라인 스크립트가 문법적으로 성립한다", () => {
    const src = inlineScript(shell());
    // new Function은 파싱만 하고 실행하지 않는다. document도 htmx도 필요 없다.
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
    // onchange 자동 저장으로 돌아가면 반쯤 붙여 넣은 토큰이 그대로 저장된다.
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
    habits: [{ id: "a", name: "달리기", color: "#e2542f", created_at: "", archived: false }],
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
    // 7월 26일~8월 1일 줄에 8월이 붙으면 그 줄 전체를 8월로 읽게 된다.
    const html = renderHabits(state, today);
    const months = [...html.matchAll(/<div class="mon" aria-hidden="true">([^<]*)<\/div>/g)].map(
      (m) => m[1],
    );
    // 머리글 한 칸 + 5주. 7월로 시작해 8월 2일 줄에서 한 번만 바뀐다.
    expect(months).toEqual(["", "7월", "", "8월", "", ""]);
  });

  it("칸의 title에 날짜가 들어간다", () => {
    expect(renderHabits(state, today)).toContain('title="8월 22일 토요일 완료"');
  });
});
