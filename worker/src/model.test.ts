import { describe, expect, it } from "vitest";
import { addDays, compute, dayOfWeek, isDateStr, isDbName, isToken, sqlEscape } from "./model";

describe("compute", () => {
  const cases: Array<{
    name: string;
    dates: string[];
    today: string;
    current: number;
    longest: number;
    total: number;
  }> = [
    { name: "기록 없음", dates: [], today: "2026-08-21", current: 0, longest: 0, total: 0 },
    {
      name: "오늘까지 3일 연속",
      dates: ["2026-08-19", "2026-08-20", "2026-08-21"],
      today: "2026-08-21",
      current: 3,
      longest: 3,
      total: 3,
    },
    {
      // An unchecked today is fine as long as yesterday is filled.
      name: "어제까지 이어짐",
      dates: ["2026-08-19", "2026-08-20"],
      today: "2026-08-21",
      current: 2,
      longest: 2,
      total: 2,
    },
    {
      name: "이틀 전에 끊김",
      dates: ["2026-08-17", "2026-08-18"],
      today: "2026-08-21",
      current: 0,
      longest: 2,
      total: 2,
    },
    {
      name: "과거에 더 긴 사슬이 있음",
      dates: [
        "2026-08-01",
        "2026-08-02",
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-20",
        "2026-08-21",
      ],
      today: "2026-08-21",
      current: 2,
      longest: 5,
      total: 7,
    },
    {
      name: "중복 날짜는 한 번만 센다",
      dates: ["2026-08-21", "2026-08-21", "2026-08-20"],
      today: "2026-08-21",
      current: 2,
      longest: 2,
      total: 2,
    },
    {
      name: "정렬되지 않은 입력",
      dates: ["2026-08-21", "2026-08-19", "2026-08-20"],
      today: "2026-08-21",
      current: 3,
      longest: 3,
      total: 3,
    },
    {
      name: "월 경계를 넘는 연속",
      dates: ["2026-07-30", "2026-07-31", "2026-08-01"],
      today: "2026-08-01",
      current: 3,
      longest: 3,
      total: 3,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const got = compute(tc.dates, tc.today);
      expect(got.current).toBe(tc.current);
      expect(got.longest).toBe(tc.longest);
      expect(got.total).toBe(tc.total);
    });
  }

  it("최근 30일 달성률", () => {
    const base = "2026-08-21";
    const dates = Array.from({ length: 15 }, (_, i) => addDays(base, -i));
    expect(compute(dates, base).rate30).toBe(50);
  });
});

describe("날짜 계산", () => {
  it("하루 더하고 빼기", () => {
    expect(addDays("2026-08-21", 1)).toBe("2026-08-22");
    expect(addDays("2026-08-01", -1)).toBe("2026-07-31");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  // A DST transition: local-time math loses or repeats a day here.
  it("서머타임 전환일을 넘어가도 하루씩 간다", () => {
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09"); // 미국 DST 시작
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02"); // 미국 DST 종료
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30"); // 유럽 DST 시작
  });

  it("요일은 일요일이 0", () => {
    expect(dayOfWeek("2026-08-23")).toBe(0); // 일
    expect(dayOfWeek("2026-08-21")).toBe(5); // 금
  });

  it("형식이 틀린 날짜는 받지 않는다", () => {
    expect(isDateStr("2026-08-21")).toBe(true);
    expect(isDateStr("2026-8-21")).toBe(false);
    expect(isDateStr("2026-13-01")).toBe(false);
    expect(isDateStr("")).toBe(false);
    expect(isDateStr(null)).toBe(false);
  });
});

describe("sqlEscape", () => {
  it("따옴표와 역슬래시를 막는다", () => {
    expect(sqlEscape("hello")).toBe("'hello'");
    expect(sqlEscape("it's")).toBe("'it\\'s'");
    expect(sqlEscape("back\\slash")).toBe("'back\\\\slash'");
  });

  it("SQL 주입 시도를 문자열로 가둔다", () => {
    expect(sqlEscape("x'; DROP TABLE habits; --")).toBe("'x\\'; DROP TABLE habits; --'");
  });
});

describe("SQL 만들기", () => {
  it("습관 삭제는 문장을 나눠서 낸다", async () => {
    const { deleteHabit } = await import("./dolt");
    const stmts = deleteHabit("h1");
    // The write endpoint takes one statement per request; joining them
    // with a semicolon is rejected as a parse error.
    expect(stmts).toHaveLength(2);
    for (const s of stmts) {
      expect(s.replace(/;$/, "")).not.toContain(";");
    }
    expect(stmts[0]).toContain("FROM checks");
    expect(stmts[1]).toContain("FROM habits");
  });

  it("체크 문장은 하나짜리다", async () => {
    const { insertCheck, deleteCheck } = await import("./dolt");
    for (const s of [insertCheck("h1", "2026-08-21"), deleteCheck("h1", "2026-08-21")]) {
      expect(s.replace(/;$/, "")).not.toContain(";");
    }
  });
});

describe("isDbName", () => {
  it("owner/name만 받는다", () => {
    expect(isDbName("benelog/habit-chain")).toBe(true);
    expect(isDbName("a_b/c-d")).toBe(true);
  });

  it("두 토막이 아니거나 이상한 글자가 섞이면 거른다", () => {
    for (const bad of ["", "habit-chain", "a/b/c", "a/", "/b", "a b/c", "a/b?q=1", "../etc", 42, null]) {
      expect(isDbName(bad)).toBe(false);
    }
  });
});

describe("isToken", () => {
  it("헤더에 실을 수 있는 글자만 받는다", () => {
    expect(isToken("dhat.v1.abcdefghijklmnop")).toBe(true);
  });

  it("공백과 줄바꿈은 거른다 — 헤더가 조작될 수 있다", () => {
    for (const bad of ["", "short", "tok en1234", "tok\r\nX-Evil: 1", "토큰토큰토큰토큰", null]) {
      expect(isToken(bad)).toBe(false);
    }
  });
});
