//go:build js && wasm

package app

import (
	"fmt"
	"html"
	"strings"

	"github.com/benelog/habit-chain/internal/model"
)

// gridWeeks는 카드마다 보여주는 사슬 그리드의 주 수다.
const gridWeeks = 5

var dowNames = [7]string{"일", "월", "화", "수", "목", "금", "토"}

// renderHabits는 습관 목록 전체의 HTML을 만든다.
func (a *App) renderHabits() string {
	if len(a.state.Habits) == 0 {
		return `<div class="empty">
			<h2>아직 사슬이 없습니다</h2>
			<p>이어갈 습관을 하나 추가하세요.<br>매일 칸을 채우고, 끊지 마세요.</p>
		</div>`
	}

	var sb strings.Builder
	idx := a.state.Index()
	for _, h := range a.state.Habits {
		a.renderCard(&sb, h, idx)
	}
	return sb.String()
}

func (a *App) renderCard(sb *strings.Builder, h model.Habit, idx model.CheckSet) {
	stats := model.Compute(a.state.DatesOf(h.ID), a.today)
	todayStr := a.today.Format(model.DateLayout)
	doneToday := idx.Has(h.ID, todayStr)

	color := h.Color
	if color == "" {
		color = "#f97316"
	}

	streakClass := "streak"
	if stats.Current == 0 {
		streakClass += " dead"
	}

	fmt.Fprintf(sb, `<article class="card" style="--habit:%s">
  <div class="card-head">
    <div>
      <h2 class="card-title">%s</h2>
      <p class="%s"><b>%d</b> 일째 %s</p>
    </div>
    <div class="card-menu">
      <button class="today-btn%s" data-act="toggle" data-id="%s" data-date="%s">%s</button>
      <button class="icon-btn" data-act="delete" data-id="%s" aria-label="삭제" title="삭제">🗑</button>
    </div>
  </div>`,
		html.EscapeString(color),
		html.EscapeString(h.Name),
		streakClass, stats.Current, chainWord(stats.Current),
		pick(doneToday, " done", ""),
		html.EscapeString(h.ID), todayStr,
		pick(doneToday, "오늘 완료", "오늘 체크"),
		html.EscapeString(h.ID))

	sb.WriteString(`<div class="card-body">`)
	a.renderGrid(sb, h, idx)
	fmt.Fprintf(sb, `<dl class="card-stats">
    <div><dt>최장</dt><dd>%d<small>일</small></dd></div>
    <div><dt>누적</dt><dd>%d<small>회</small></dd></div>
    <div><dt>최근 30일</dt><dd>%d<small>%%</small></dd></div>
  </dl></div>
</article>`, stats.Longest, stats.Total, stats.Rate30)
}

// renderGrid는 최근 gridWeeks 주를 요일 정렬 그리드로 그린다.
// 가로로 인접한 두 칸이 모두 채워져 있으면 사이를 이어 사슬처럼 보이게 한다.
func (a *App) renderGrid(sb *strings.Builder, h model.Habit, idx model.CheckSet) {
	sb.WriteString(`<div class="grid">`)
	for i, n := range dowNames {
		cls := "dow"
		if i == 0 {
			cls += " sun"
		}
		fmt.Fprintf(sb, `<div class="%s">%s</div>`, cls, n)
	}

	// 이번 주 토요일에서 거꾸로 gridWeeks 주만큼 거슬러 올라간 일요일이 시작점이다.
	end := a.today.AddDate(0, 0, 6-int(a.today.Weekday()))
	start := end.AddDate(0, 0, -(gridWeeks*7 - 1))

	days := gridWeeks * 7
	done := make([]bool, days)
	dates := make([]string, days)
	for i := 0; i < days; i++ {
		d := start.AddDate(0, 0, i)
		dates[i] = d.Format(model.DateLayout)
		done[i] = idx.Has(h.ID, dates[i])
	}

	todayStr := a.today.Format(model.DateLayout)
	for i := 0; i < days; i++ {
		d := start.AddDate(0, 0, i)
		cls := "cell"
		label := ""

		switch {
		case dates[i] > todayStr:
			cls += " future"
		case done[i]:
			cls += " done"
			// 같은 행 안에서만 잇는다. 행이 바뀌면 시각적으로 이어붙일 자리가 없다.
			if i%7 != 0 && done[i-1] {
				cls += " link-l"
			}
			if i%7 != 6 && i+1 < days && done[i+1] && dates[i+1] <= todayStr {
				cls += " link-r"
			}
		}
		if dates[i] == todayStr {
			cls += " today"
		}
		if d.Day() == 1 {
			cls += " first"
			label = fmt.Sprintf("%d", int(d.Month()))
		}

		fmt.Fprintf(sb,
			`<button class="%s" data-act="toggle" data-id="%s" data-date="%s" title="%s" aria-label="%s">%s</button>`,
			cls, html.EscapeString(h.ID), dates[i], dates[i], dates[i], label)
	}
	sb.WriteString(`</div>`)
}

func chainWord(n int) string {
	if n == 0 {
		return "— 오늘 다시 시작하세요"
	}
	return "이어가는 중"
}

// pick은 조건에 따라 두 문자열 중 하나를 고른다.
func pick(cond bool, yes, no string) string {
	if cond {
		return yes
	}
	return no
}
