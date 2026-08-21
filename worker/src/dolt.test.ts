/**
 * dolt.ts가 만드는 SQL 문장을 확인한다.
 *
 * 여기 있는 함수만 네트워크가 없다. 값이 그대로 문장에 박히므로,
 * 따옴표와 줄바꿈이 든 설명이 문장을 깨뜨리지 않는지가 요점이다.
 */

import { describe, expect, it } from "vitest";
import { updateHabit, upsertHabit } from "./dolt";
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
