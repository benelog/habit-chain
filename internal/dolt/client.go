// Package dolt는 DoltHub의 v1alpha1 SQL API를 다룬다.
//
// 읽기(GET)는 브라우저에서 그대로 호출된다 — 공개 DB는 인증이 필요 없고
// 응답에 CORS 허용 헤더가 붙는다. 쓰기는 Authorization 헤더가 필요한데
// DoltHub의 preflight가 GET만 허용하므로 브라우저에서 직접 호출할 수 없다.
// 그래서 이 패키지는 읽기와 "SQL 문장 만들기"까지만 담당하고,
// 실제 반영은 relay 패키지가 쓰기 프록시(worker/src/index.js)를 통해 처리한다.
package dolt

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/benelog/habit-chain/internal/model"
)

// Endpoint는 DoltHub API의 기본 주소다.
const Endpoint = "https://www.dolthub.com/api/v1alpha1"

// Response는 SQL API의 응답 형식이다.
type Response struct {
	QueryExecutionStatus  string           `json:"query_execution_status"`
	QueryExecutionMessage string           `json:"query_execution_message"`
	Rows                  []map[string]any `json:"rows"`
}

// Query는 DB에 읽기 SQL을 던진다. db는 "owner/name" 형식이다.
func Query(db, branch, q string) (*Response, error) {
	owner, name, ok := strings.Cut(db, "/")
	if !ok || owner == "" || name == "" {
		return nil, fmt.Errorf("DB 이름은 owner/name 형식이어야 합니다: %q", db)
	}
	if branch == "" {
		branch = "main"
	}

	u := fmt.Sprintf("%s/%s/%s/%s?q=%s", Endpoint,
		url.PathEscape(owner), url.PathEscape(name), url.PathEscape(branch),
		url.QueryEscape(q))

	resp, err := http.Get(u)
	if err != nil {
		return nil, fmt.Errorf("DoltHub 요청 실패: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("응답을 읽지 못했습니다: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("DoltHub가 %s를 반환했습니다: %s", resp.Status, truncate(string(body)))
	}

	var out Response
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("응답 형식이 예상과 다릅니다: %w", err)
	}
	if out.QueryExecutionStatus == "Error" {
		return nil, fmt.Errorf("%s", out.QueryExecutionMessage)
	}
	return &out, nil
}

func truncate(s string) string {
	if len(s) > 200 {
		return s[:200] + "..."
	}
	return s
}

func str(row map[string]any, k string) string {
	if v, ok := row[k]; ok && v != nil {
		if s, ok := v.(string); ok {
			return s
		}
		return fmt.Sprint(v)
	}
	return ""
}

func boolOf(row map[string]any, k string) bool {
	switch v := row[k].(type) {
	case bool:
		return v
	case string:
		return v == "1" || strings.EqualFold(v, "true")
	case float64:
		return v != 0
	}
	return false
}

// Pull은 DoltHub에서 습관과 체크 기록 전체를 읽어온다.
func Pull(db, branch string) (model.State, error) {
	var st model.State

	hr, err := Query(db, branch, "SELECT id, name, color, created_at, archived FROM habits ORDER BY created_at")
	if err != nil {
		return st, err
	}
	for _, row := range hr.Rows {
		st.Habits = append(st.Habits, model.Habit{
			ID:        str(row, "id"),
			Name:      str(row, "name"),
			Color:     str(row, "color"),
			CreatedAt: str(row, "created_at"),
			Archived:  boolOf(row, "archived"),
		})
	}

	cr, err := Query(db, branch, "SELECT habit_id, check_date, note FROM checks ORDER BY check_date")
	if err != nil {
		return st, err
	}
	for _, row := range cr.Rows {
		date := str(row, "check_date")
		if len(date) > 10 { // DATETIME으로 돌아오는 경우 날짜만 남긴다
			date = date[:10]
		}
		st.Checks = append(st.Checks, model.Check{
			HabitID: str(row, "habit_id"),
			Date:    date,
			Note:    str(row, "note"),
		})
	}
	return st, nil
}

// UpsertHabit은 습관 저장 SQL을 만든다.
func UpsertHabit(h model.Habit) string {
	return fmt.Sprintf(
		"INSERT INTO habits (id, name, color, created_at, archived) VALUES (%s, %s, %s, %s, %t) "+
			"ON DUPLICATE KEY UPDATE name=VALUES(name), color=VALUES(color), archived=VALUES(archived);",
		model.SQLEscape(h.ID), model.SQLEscape(h.Name), model.SQLEscape(h.Color),
		model.SQLEscape(h.CreatedAt), h.Archived)
}

// DeleteHabit은 습관과 그 체크 기록을 지우는 SQL을 만든다.
func DeleteHabit(id string) string {
	e := model.SQLEscape(id)
	return fmt.Sprintf("DELETE FROM checks WHERE habit_id = %s; DELETE FROM habits WHERE id = %s;", e, e)
}

// InsertCheck는 체크 기록 SQL을 만든다.
func InsertCheck(habitID, date string) string {
	return fmt.Sprintf(
		"INSERT IGNORE INTO checks (habit_id, check_date, note) VALUES (%s, %s, '');",
		model.SQLEscape(habitID), model.SQLEscape(date))
}

// DeleteCheck는 체크 해제 SQL을 만든다.
func DeleteCheck(habitID, date string) string {
	return fmt.Sprintf("DELETE FROM checks WHERE habit_id = %s AND check_date = %s;",
		model.SQLEscape(habitID), model.SQLEscape(date))
}

// Snapshot은 로컬 상태 전체를 DoltHub에 그대로 덮어쓰는 SQL을 만든다.
// 큐가 꼬였을 때 로컬을 정본으로 삼아 되돌리는 용도다.
func Snapshot(st model.State) []string {
	stmts := []string{"DELETE FROM checks;", "DELETE FROM habits;"}
	for _, h := range st.Habits {
		stmts = append(stmts, UpsertHabit(h))
	}
	for _, c := range st.Checks {
		stmts = append(stmts, InsertCheck(c.HabitID, c.Date))
	}
	return stmts
}
