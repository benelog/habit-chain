/**
 * dolt.ts가 만드는 SQL 문장을 확인한다.
 *
 * 여기 있는 함수만 네트워크가 없다. 값이 그대로 문장에 박히므로,
 * 따옴표와 줄바꿈이 든 설명이 문장을 깨뜨리지 않는지가 요점이다.
 */

import { describe, expect, it } from "vitest";
import { isBranchMissing, migrations, updateHabit, upsertHabit } from "./dolt";
import type { Habit } from "./model";

const base: Habit = {
  id: "a-1",
  name: "달리기",
  description: "아침에 30분.\n비 오면 실내에서.",
  color: "#e2542f",
  created_at: "2026-08-22T00:00:00.000Z",
  archived: false,
};

describe("upsertHabit", () => {
  it("설명을 함께 넣고, 부딪히면 설명까지 갱신한다", () => {
    const sql = upsertHabit(base);
    expect(sql).toContain("INSERT INTO habits (id, name, description, color, created_at, archived)");
    expect(sql).toContain("'아침에 30분.\n비 오면 실내에서.'");
    expect(sql).toContain("description = VALUES(description)");
  });
});

describe("updateHabit", () => {
  it("이름과 설명만 고친다. created_at은 건드리지 않는다", () => {
    const sql = updateHabit("a-1", "달리기", "매일 아침");
    expect(sql).toBe("UPDATE habits SET name = '달리기', description = '매일 아침' WHERE id = 'a-1';");
    expect(sql).not.toContain("created_at");
  });

  it("작은따옴표가 든 설명이 문장을 깨뜨리지 않는다", () => {
    const sql = updateHabit("a-1", "달리기", "don't break the chain");
    expect(sql).toContain("'don\\'t break the chain'");
  });
});

describe("migrations", () => {
  it("빈 DB에는 표를 둘 다 만든다. 새 표에는 description이 처음부터 있다", () => {
    const out = migrations({ branch: true, habits: false, checks: false, description: false });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CREATE TABLE habits");
    expect(out[0]).toContain("description VARCHAR(2000)");
    expect(out[1]).toContain("CREATE TABLE checks");
  });

  it("옛 스키마에는 빠진 칸만 더한다", () => {
    const out = migrations({ branch: true, habits: true, checks: true, description: false });
    expect(out).toEqual([
      "ALTER TABLE habits ADD COLUMN description VARCHAR(2000) NOT NULL DEFAULT '';",
    ]);
  });

  it("맞춰진 DB에는 아무것도 하지 않는다", () => {
    expect(migrations({ branch: true, habits: true, checks: true, description: true })).toEqual([]);
  });

  it("habits를 새로 만들 때 ALTER를 겹쳐 내지 않는다", () => {
    const out = migrations({ branch: true, habits: false, checks: true, description: false });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("CREATE TABLE habits");
  });
});

describe("isBranchMissing", () => {
  it("브랜치가 없다는 대답만 알아본다", () => {
    expect(isBranchMissing(new Error("query error: branch not found"))).toBe(true);
    expect(isBranchMissing(new Error("Branch Not Found"))).toBe(true);
  });

  it("다른 오류는 그대로 오류다. 준비 안내로 덮으면 진짜 고장을 감춘다", () => {
    expect(isBranchMissing(new Error("DoltHub 404: repository not found"))).toBe(false);
    expect(isBranchMissing(new Error("table not found: habits"))).toBe(false);
  });
});

describe("migrations · 커밋이 없는 DB", () => {
  it("브랜치가 없어도 낼 문장은 빈 DB와 같다", () => {
    const out = migrations({ branch: false, habits: false, checks: false, description: false });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CREATE TABLE habits");
  });
});
