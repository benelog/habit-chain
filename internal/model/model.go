// Package model은 habit-chain의 도메인 타입과 체인 계산 로직을 담는다.
package model

import (
	"sort"
	"strings"
	"time"
)

// DateLayout은 앱 전체에서 쓰는 날짜 표기(로컬 시간 기준)다.
const DateLayout = "2006-01-02"

// Habit은 매일 이어가려는 하나의 습관이다.
type Habit struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	CreatedAt string `json:"created_at"` // RFC3339
	Archived  bool   `json:"archived"`
}

// Check는 특정 습관을 특정 날짜에 수행했다는 기록이다.
type Check struct {
	HabitID string `json:"habit_id"`
	Date    string `json:"date"` // DateLayout
	Note    string `json:"note"`
}

// State는 앱이 다루는 데이터 전체다. LocalStorage에 통째로 직렬화된다.
type State struct {
	Habits []Habit `json:"habits"`
	Checks []Check `json:"checks"`
}

// CheckSet은 (habitID, date) 조회를 위한 인덱스다.
type CheckSet map[string]struct{}

func key(habitID, date string) string { return habitID + "|" + date }

// Index는 체크 기록을 조회용 집합으로 만든다.
func (s *State) Index() CheckSet {
	set := make(CheckSet, len(s.Checks))
	for _, c := range s.Checks {
		set[key(c.HabitID, c.Date)] = struct{}{}
	}
	return set
}

// Has는 해당 날짜에 체크가 있는지 본다.
func (cs CheckSet) Has(habitID, date string) bool {
	_, ok := cs[key(habitID, date)]
	return ok
}

// Toggle은 체크를 켜고 끈다. 켜졌으면 true를 돌려준다.
func (s *State) Toggle(habitID, date string) bool {
	for i, c := range s.Checks {
		if c.HabitID == habitID && c.Date == date {
			s.Checks = append(s.Checks[:i], s.Checks[i+1:]...)
			return false
		}
	}
	s.Checks = append(s.Checks, Check{HabitID: habitID, Date: date})
	return true
}

// Habit은 id로 습관을 찾는다.
func (s *State) Habit(id string) *Habit {
	for i := range s.Habits {
		if s.Habits[i].ID == id {
			return &s.Habits[i]
		}
	}
	return nil
}

// RemoveHabit은 습관과 그에 딸린 모든 체크를 지운다.
func (s *State) RemoveHabit(id string) {
	habits := s.Habits[:0]
	for _, h := range s.Habits {
		if h.ID != id {
			habits = append(habits, h)
		}
	}
	s.Habits = habits

	checks := s.Checks[:0]
	for _, c := range s.Checks {
		if c.HabitID != id {
			checks = append(checks, c)
		}
	}
	s.Checks = checks
}

// Stats는 하나의 습관에 대한 체인 지표다.
type Stats struct {
	Current int // 오늘(또는 어제)까지 이어진 연속 일수
	Longest int // 역대 최장 연속 일수
	Total   int // 전체 체크 수
	Rate30  int // 최근 30일 달성률(%)
}

// Compute는 today를 기준으로 체인 지표를 계산한다.
//
// 오늘 아직 체크하지 않았어도 어제까지 이어져 있으면 체인은 살아 있는 것으로 본다.
// 하루를 통째로 놓쳐야 끊어진다 — 이게 don't break the chain의 규칙이다.
func Compute(dates []string, today time.Time) Stats {
	if len(dates) == 0 {
		return Stats{}
	}
	sorted := append([]string(nil), dates...)
	sort.Strings(sorted)

	set := make(map[string]struct{}, len(sorted))
	for _, d := range sorted {
		set[d] = struct{}{}
	}

	st := Stats{Total: len(set)}

	// 최장 연속: 정렬된 날짜를 훑으며 하루 간격이 유지되는 구간을 잰다.
	run := 0
	var prev time.Time
	for _, d := range sorted {
		t, err := time.Parse(DateLayout, d)
		if err != nil {
			continue
		}
		if run > 0 && t.Equal(prev.AddDate(0, 0, 1)) {
			run++
		} else {
			run = 1
		}
		if run > st.Longest {
			st.Longest = run
		}
		prev = t
	}

	// 현재 연속: 오늘부터 거꾸로 센다. 오늘이 비었으면 어제부터 시작.
	cursor := today
	if _, ok := set[cursor.Format(DateLayout)]; !ok {
		cursor = cursor.AddDate(0, 0, -1)
	}
	for {
		if _, ok := set[cursor.Format(DateLayout)]; !ok {
			break
		}
		st.Current++
		cursor = cursor.AddDate(0, 0, -1)
	}

	// 최근 30일 달성률.
	hit := 0
	for i := 0; i < 30; i++ {
		if _, ok := set[today.AddDate(0, 0, -i).Format(DateLayout)]; ok {
			hit++
		}
	}
	st.Rate30 = hit * 100 / 30

	return st
}

// DatesOf는 한 습관의 체크 날짜만 뽑는다.
func (s *State) DatesOf(habitID string) []string {
	var out []string
	for _, c := range s.Checks {
		if c.HabitID == habitID {
			out = append(out, c.Date)
		}
	}
	return out
}

// SQLEscape는 문자열 리터럴을 SQL에 넣을 수 있게 감싼다.
func SQLEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `'`, `\'`)
	return "'" + r.Replace(s) + "'"
}
