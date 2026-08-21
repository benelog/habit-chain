package model

import (
	"testing"
	"time"
)

func day(s string) time.Time {
	t, err := time.Parse(DateLayout, s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestCompute(t *testing.T) {
	tests := []struct {
		name    string
		dates   []string
		today   string
		current int
		longest int
		total   int
	}{
		{"기록 없음", nil, "2026-08-21", 0, 0, 0},
		{
			"오늘까지 3일 연속",
			[]string{"2026-08-19", "2026-08-20", "2026-08-21"},
			"2026-08-21", 3, 3, 3,
		},
		{
			// 오늘 아직 안 했어도 어제까지 이어졌으면 사슬은 살아 있다
			"어제까지 이어짐",
			[]string{"2026-08-19", "2026-08-20"},
			"2026-08-21", 2, 2, 2,
		},
		{
			"이틀 전에 끊김",
			[]string{"2026-08-17", "2026-08-18"},
			"2026-08-21", 0, 2, 2,
		},
		{
			"과거에 더 긴 사슬이 있음",
			[]string{
				"2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05",
				"2026-08-20", "2026-08-21",
			},
			"2026-08-21", 2, 5, 7,
		},
		{
			"중복 날짜는 한 번만 센다",
			[]string{"2026-08-21", "2026-08-21", "2026-08-20"},
			"2026-08-21", 2, 2, 2,
		},
		{
			"정렬되지 않은 입력",
			[]string{"2026-08-21", "2026-08-19", "2026-08-20"},
			"2026-08-21", 3, 3, 3,
		},
		{
			"월 경계를 넘는 연속",
			[]string{"2026-07-30", "2026-07-31", "2026-08-01"},
			"2026-08-01", 3, 3, 3,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Compute(tc.dates, day(tc.today))
			if got.Current != tc.current {
				t.Errorf("Current = %d, want %d", got.Current, tc.current)
			}
			if got.Longest != tc.longest {
				t.Errorf("Longest = %d, want %d", got.Longest, tc.longest)
			}
			if got.Total != tc.total {
				t.Errorf("Total = %d, want %d", got.Total, tc.total)
			}
		})
	}
}

func TestRate30(t *testing.T) {
	var dates []string
	base := day("2026-08-21")
	for i := 0; i < 15; i++ {
		dates = append(dates, base.AddDate(0, 0, -i).Format(DateLayout))
	}
	if got := Compute(dates, base).Rate30; got != 50 {
		t.Errorf("Rate30 = %d, want 50", got)
	}
}

func TestToggle(t *testing.T) {
	s := &State{}
	if on := s.Toggle("h1", "2026-08-21"); !on {
		t.Fatal("첫 토글은 켜져야 한다")
	}
	if len(s.Checks) != 1 {
		t.Fatalf("체크 %d개, 1개여야 한다", len(s.Checks))
	}
	if on := s.Toggle("h1", "2026-08-21"); on {
		t.Fatal("두 번째 토글은 꺼져야 한다")
	}
	if len(s.Checks) != 0 {
		t.Fatalf("체크 %d개, 0개여야 한다", len(s.Checks))
	}
}

func TestRemoveHabit(t *testing.T) {
	s := &State{
		Habits: []Habit{{ID: "a"}, {ID: "b"}},
		Checks: []Check{
			{HabitID: "a", Date: "2026-08-20"},
			{HabitID: "b", Date: "2026-08-20"},
			{HabitID: "a", Date: "2026-08-21"},
		},
	}
	s.RemoveHabit("a")

	if len(s.Habits) != 1 || s.Habits[0].ID != "b" {
		t.Errorf("습관이 %v, b만 남아야 한다", s.Habits)
	}
	if len(s.Checks) != 1 || s.Checks[0].HabitID != "b" {
		t.Errorf("체크가 %v, b 것만 남아야 한다", s.Checks)
	}
}

func TestSQLEscape(t *testing.T) {
	tests := map[string]string{
		"hello":      "'hello'",
		"it's":       `'it\'s'`,
		`back\slash`: `'back\\slash'`,
	}
	for in, want := range tests {
		if got := SQLEscape(in); got != want {
			t.Errorf("SQLEscape(%q) = %s, want %s", in, got, want)
		}
	}
}
