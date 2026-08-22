/**
 * The SQL dolt.ts builds. These are the only functions without network access.
 * Values are inlined into the statement, so the point is that quotes and
 * newlines in a description do not break it.
 */

import { describe, expect, it } from "vitest";
import {
  isBranchMissing,
  isTableMissing,
  isTokenRejected,
  MIGRATIONS,
  migrations,
  updateHabit,
  upsertHabit,
  upsertMeta,
} from "./dolt";
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

  it("색은 준 경우에만 바꾼다 — 안 주면 color에 손대지 않는다", () => {
    expect(updateHabit("a-1", "달리기", "", "#3fa34d")).toContain("color = '#3fa34d'");
    expect(updateHabit("a-1", "달리기", "")).not.toContain("color");
  });
});

describe("migrations", () => {
  it("빈 DB에는 표를 셋 다 만든다. 새 표에는 description이 처음부터 있다", () => {
    const out = migrations({ branch: true, habits: false, checks: false, description: false, meta: false });
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("CREATE TABLE habits");
    expect(out[0]).toContain("description VARCHAR(2000)");
    expect(out[1]).toContain("CREATE TABLE checks");
    expect(out[2]).toContain("CREATE TABLE meta");
  });

  it("옛 스키마에는 빠진 것만 더한다", () => {
    const out = migrations({ branch: true, habits: true, checks: true, description: false, meta: false });
    expect(out).toEqual([
      "ALTER TABLE habits ADD COLUMN description VARCHAR(2000) NOT NULL DEFAULT '';",
      "CREATE TABLE meta (\n  k VARCHAR(64) NOT NULL PRIMARY KEY,\n  v VARCHAR(2000) NOT NULL DEFAULT ''\n);",
    ]);
  });

  it("맞춰진 DB에는 아무것도 하지 않는다", () => {
    expect(
      migrations({ branch: true, habits: true, checks: true, description: true, meta: true }),
    ).toEqual([]);
  });

  it("habits를 새로 만들 때 ALTER를 겹쳐 내지 않는다", () => {
    const out = migrations({ branch: true, habits: false, checks: true, description: false, meta: true });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("CREATE TABLE habits");
  });

  it("적용 안 된 것만 목록의 순번 순서로 낸다", () => {
    const out = migrations({ branch: true, habits: true, checks: false, description: false, meta: true });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("CREATE TABLE checks");
    expect(out[1]).toContain("ALTER TABLE habits");
  });

  it("순번은 겹치지 않고 늘어나기만 한다", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
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

describe("isTokenRejected", () => {
  it("DoltHub가 토큰을 거부한 두 가지 말투를 알아본다", () => {
    // 2026-08 v1alpha1 읽기 엔드포인트에서 관찰한 실제 메시지 그대로.
    expect(isTokenRejected(new Error('DoltHub 400: {"query_execution_message":"invalid authorization header"}'))).toBe(true);
    expect(isTokenRejected(new Error("no token found for given API token"))).toBe(true);
  });

  it("다른 오류를 토큰 문제로 오진하지 않는다", () => {
    expect(isTokenRejected(new Error("query error: branch not found"))).toBe(false);
    expect(isTokenRejected(new Error("DoltHub 404: repository not found"))).toBe(false);
  });
});

describe("migrations · 커밋이 없는 DB", () => {
  it("브랜치가 없어도 낼 문장은 빈 DB와 같다", () => {
    const out = migrations({ branch: false, habits: false, checks: false, description: false, meta: false });
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("CREATE TABLE habits");
  });
});

describe("upsertMeta", () => {
  it("제목과 설명을 한 문장에 담는다 — 쓰기 요청 하나가 커밋 하나다", () => {
    const sql = upsertMeta({ title: "정상혁의 습관 달력", description: "제가 실천하는 습관들" });
    expect(sql).toContain("INSERT INTO meta (k, v) VALUES");
    expect(sql).toContain("('title', '정상혁의 습관 달력')");
    expect(sql).toContain("('description', '제가 실천하는 습관들')");
    expect(sql).toContain("ON DUPLICATE KEY UPDATE v = VALUES(v)");
  });

  it("작은따옴표가 든 제목이 문장을 깨뜨리지 않는다", () => {
    expect(upsertMeta({ title: "don't stop", description: "" })).toContain("'don\\'t stop'");
  });
});

describe("isTableMissing", () => {
  it("표가 없다는 대답만 알아본다", () => {
    expect(isTableMissing(new Error("table not found: meta"))).toBe(true);
    expect(isTableMissing(new Error("query error: branch not found"))).toBe(false);
    expect(isTableMissing(new Error("DoltHub 404: repository not found"))).toBe(false);
  });
});
