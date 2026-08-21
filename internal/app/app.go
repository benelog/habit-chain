//go:build js && wasm

// Package app은 habit-chain의 화면과 동작을 묶는다.
package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"syscall/js"
	"time"

	"github.com/benelog/habit-chain/internal/dolt"
	"github.com/benelog/habit-chain/internal/model"
	"github.com/benelog/habit-chain/internal/relay"
	"github.com/benelog/habit-chain/internal/store"
)

// SchemaSQL은 새 DoltHub DB를 초기화하는 스키마다.
const SchemaSQL = `CREATE TABLE IF NOT EXISTS habits (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  color VARCHAR(16) NOT NULL DEFAULT '#f97316',
  created_at VARCHAR(32) NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS checks (
  habit_id VARCHAR(36) NOT NULL,
  check_date DATE NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (habit_id, check_date)
);`

// App은 앱의 전체 상태다.
type App struct {
	state    model.State
	settings store.Settings
	queue    []string
	today    time.Time

	pendingDelete string // 삭제 확인을 기다리는 습관 id
	pushing       bool   // push가 도는 중인지. 큐를 두 곳에서 자르지 않기 위해 필요하다
	serverWrites  bool   // 서버가 DoltHub 쓰기를 할 수 있는 상태인지
	loadErr       string // 마지막 불러오기 실패 메시지. 비어 있으면 정상이다
	doc           js.Value
}

// New는 이 브라우저에 저장된 설정만 읽어 앱을 만든다.
// 습관과 기록은 DoltHub에서 받아 메모리에만 둔다.
func New() *App {
	return &App{
		settings: store.LoadSettings(),
		today:    time.Now(),
		doc:      js.Global().Get("document"),
	}
}

func (a *App) el(id string) js.Value { return a.doc.Call("getElementById", id) }

// Run은 화면을 띄우고 이벤트를 연결한다. 반환하지 않는다.
func (a *App) Run() {
	a.el("boot").Get("style").Set("display", "none")
	a.el("app").Set("hidden", false)

	a.bind()
	a.fillSettings()
	a.el("habits").Set("innerHTML", `<div class="empty"><p>불러오는 중…</p></div>`)
	a.updateBadge()

	// 원본이 DoltHub에 있으므로 화면을 띄운 뒤 곧바로 읽어 온다.
	go a.boot()

	select {} // wasm 모듈이 종료되지 않도록 붙잡아 둔다
}

// boot는 서버가 알려준 기본값을 받아 첫 데이터를 읽어 온다.
//
// 로컬에 남는 데이터가 없으므로 여기서 실패하면 화면이 비는 것과 같다.
// 그래서 실패도 반드시 화면에 남긴다.
func (a *App) boot() {
	a.adoptServerConfig()

	if a.settings.DoltDB == "" {
		a.loadErr = "DoltHub DB 이름이 설정되지 않았습니다. 설정에서 넣어 주세요."
		a.render()
		return
	}
	a.pull()
}

func (a *App) bind() {
	// 습관 목록의 클릭은 한 곳에서 위임 처리한다. 다시 그려도 핸들러가 살아 있다.
	a.on(a.el("habits"), "click", func(ev js.Value) {
		target := ev.Get("target").Call("closest", "[data-act]")
		if target.IsNull() {
			return
		}
		switch target.Get("dataset").Get("act").String() {
		case "toggle":
			a.toggle(target.Get("dataset").Get("id").String(),
				target.Get("dataset").Get("date").String())
		case "delete":
			a.confirmDelete(target.Get("dataset").Get("id").String())
		}
	})

	a.on(a.el("add-form"), "submit", func(ev js.Value) {
		ev.Call("preventDefault")
		name := strings.TrimSpace(a.el("add-name").Get("value").String())
		if name == "" {
			return
		}
		a.addHabit(name, a.el("add-color").Get("value").String())
		a.el("add-name").Set("value", "")
	})

	a.on(a.el("btn-settings"), "click", func(js.Value) {
		a.fillSettings()
		a.el("settings").Call("showModal")
	})

	// 설정 입력은 바뀔 때마다 곧바로 저장한다.
	for _, id := range []string{"set-db", "set-branch", "set-write-key"} {
		a.on(a.el(id), "change", func(js.Value) { a.saveSettings() })
	}

	a.on(a.el("btn-pull"), "click", func(js.Value) { go a.pull() })
	a.on(a.el("btn-push"), "click", func(js.Value) { go a.push(true) })
	a.on(a.el("btn-schema"), "click", func(js.Value) {
		a.copy(SchemaSQL, "스키마 SQL을 복사했습니다. DoltHub의 SQL 콘솔에 붙여넣고 커밋하세요.")
	})
	a.on(a.el("btn-copy-sql"), "click", func(js.Value) {
		if len(a.queue) == 0 {
			a.status("대기 중인 변경이 없습니다.", "")
			return
		}
		a.copy(strings.Join(a.queue, "\n"),
			fmt.Sprintf("SQL %d줄을 복사했습니다. DoltHub SQL 콘솔에 붙여넣고 커밋하세요.", len(a.queue)))
	})
	a.on(a.el("btn-export"), "click", func(js.Value) { a.export() })
}

func (a *App) on(target js.Value, event string, fn func(js.Value)) {
	if target.IsNull() || target.IsUndefined() {
		return
	}
	cb := js.FuncOf(func(_ js.Value, args []js.Value) any {
		var ev js.Value
		if len(args) > 0 {
			ev = args[0]
		}
		fn(ev)
		return nil
	})
	target.Call("addEventListener", event, cb)
}

// ── 렌더링 ────────────────────────────────────────────

func (a *App) render() {
	a.el("habits").Set("innerHTML", a.renderHabits())
	a.el("queue-count").Set("textContent", fmt.Sprintf("%d", len(a.queue)))
	a.updateBadge()
}

func (a *App) updateBadge() {
	badge := a.el("sync-badge")
	switch {
	case a.settings.DoltDB == "":
		badge.Set("textContent", "DB 없음")
		badge.Set("className", "badge err")
	case len(a.queue) > 0:
		badge.Set("textContent", fmt.Sprintf("미반영 %d", len(a.queue)))
		badge.Set("className", "badge err")
	default:
		badge.Set("textContent", "동기화됨")
		badge.Set("className", "badge ok")
	}
}

func (a *App) status(msg, kind string) {
	s := a.el("status")
	s.Set("textContent", msg)
	s.Set("className", strings.TrimSpace("status "+kind))
}

func (a *App) busy(msg string) {
	badge := a.el("sync-badge")
	badge.Set("textContent", msg)
	badge.Set("className", "badge busy")
	a.status(msg, "")
}

// ── 데이터 변경 ───────────────────────────────────────

// enqueue는 DoltHub에 반영할 SQL을 쌓고 곧바로 보낸다.
//
// 큐는 메모리에만 있다. 보내기 전에 새로고침하면 그 변경은 사라지므로 미루지 않는다.
func (a *App) enqueue(stmt string) {
	// 불러오기에 실패한 화면에서도 추가는 된다. 그 뒤로는 실패 화면 대신
	// 실제 목록을 보여줘야 방금 만든 습관이 보인다.
	a.loadErr = ""
	a.queue = append(a.queue, stmt)
	go a.push(false)
}

func (a *App) toggle(habitID, date string) {
	if habitID == "" || date == "" {
		return
	}
	if on := a.state.Toggle(habitID, date); on {
		a.enqueue(dolt.InsertCheck(habitID, date))
	} else {
		a.enqueue(dolt.DeleteCheck(habitID, date))
	}
	a.pendingDelete = ""
	a.render()
}

func (a *App) addHabit(name, color string) {
	h := model.Habit{
		ID:        newID(),
		Name:      name,
		Color:     color,
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	a.state.Habits = append(a.state.Habits, h)
	a.enqueue(dolt.UpsertHabit(h))
	a.render()
}

// confirmDelete는 첫 클릭에 확인을 요구하고, 두 번째 클릭에 지운다.
// 브라우저 모달(confirm)은 wasm 실행을 멈추게 하므로 쓰지 않는다.
func (a *App) confirmDelete(id string) {
	if a.pendingDelete != id {
		a.pendingDelete = id
		a.render()
		btn := a.doc.Call("querySelector",
			fmt.Sprintf(`[data-act="delete"][data-id="%s"]`, id))
		if !btn.IsNull() {
			btn.Set("textContent", "정말?")
			btn.Set("title", "한 번 더 누르면 삭제됩니다")
		}
		return
	}
	a.state.RemoveHabit(id)
	a.enqueue(dolt.DeleteHabit(id))
	a.pendingDelete = ""
	a.render()
}

// ── 설정 ─────────────────────────────────────────────

func (a *App) fillSettings() {
	a.el("set-db").Set("value", a.settings.DoltDB)
	a.el("set-branch").Set("value", a.settings.DoltBranch)
	a.el("set-write-key").Set("value", a.settings.WriteKey)
	a.el("queue-count").Set("textContent", fmt.Sprintf("%d", len(a.queue)))
}

func (a *App) saveSettings() {
	a.settings.DoltDB = strings.TrimSpace(a.el("set-db").Get("value").String())
	a.settings.DoltBranch = strings.TrimSpace(a.el("set-branch").Get("value").String())
	a.settings.WriteKey = strings.TrimSpace(a.el("set-write-key").Get("value").String())
	if a.settings.DoltBranch == "" {
		a.settings.DoltBranch = "main"
	}
	store.SaveSettings(a.settings)
	a.updateBadge()
}

// ── 동기화 ───────────────────────────────────────────

// pull은 DoltHub의 내용을 그대로 가져와 화면의 원본으로 삼는다.
//
// 예전에는 로컬과 합쳤지만, 이제 원본이 저쪽 하나뿐이므로 통째로 갈아끼운다.
// 그래야 다른 기기에서 지운 습관이 여기서도 사라진다.
func (a *App) pull() {
	if a.settings.DoltDB == "" {
		a.status("먼저 DoltHub DB 이름을 넣으세요.", "err")
		return
	}
	// 아직 못 보낸 변경은 메모리에만 있다. 갈아끼우면 그대로 사라진다.
	if len(a.queue) > 0 {
		a.status(fmt.Sprintf("미반영 %d개를 먼저 보내세요. 지금 불러오면 그 변경이 사라집니다.",
			len(a.queue)), "err")
		return
	}
	a.busy("불러오는 중…")

	remote, err := dolt.Pull(a.settings.DoltDB, a.settings.DoltBranch)
	if err != nil {
		a.loadErr = err.Error()
		a.render()
		a.status("불러오기 실패: "+err.Error(), "err")
		a.updateBadge()
		return
	}

	a.state = remote
	a.loadErr = ""
	a.render()
	a.status(fmt.Sprintf("불러왔습니다 — 습관 %d개, 기록 %d개.",
		len(a.state.Habits), len(a.state.Checks)), "ok")

	a.reapLegacy()
}

// reapLegacy는 이전 버전이 LocalStorage에 남긴 기록을 정리한다.
//
// DoltHub에 다 들어 있으면 조용히 지우고, 거기 없는 기록이 하나라도 있으면
// 그대로 두고 알린다. 못 올린 기록을 말없이 날리지 않기 위해서다.
func (a *App) reapLegacy() {
	old, ok := store.LegacyState()
	if !ok {
		return
	}

	// 체크뿐 아니라 습관도 봐야 한다. 기록이 하나도 없는 습관은
	// 체크만 비교하면 "다 올라가 있음"으로 보여 그대로 지워진다.
	known := make(map[string]bool, len(a.state.Habits))
	for _, h := range a.state.Habits {
		known[h.ID] = true
	}
	missing := 0
	for _, h := range old.Habits {
		if !known[h.ID] {
			missing++
		}
	}

	idx := a.state.Index()
	for _, c := range old.Checks {
		if !idx.Has(c.HabitID, c.Date) {
			missing++
		}
	}

	if missing == 0 {
		store.DropLegacy()
		return
	}
	a.status(fmt.Sprintf(
		"이 브라우저에 예전 버전이 남긴 항목 %d개가 있는데 DoltHub에는 없습니다. "+
			"지우지 않고 두었습니다 — 필요하면 개발자 도구에서 habit-chain.state 값을 꺼내세요.",
		missing), "err")
}

// push는 큐에 쌓인 SQL을 쓰기 프록시로 보낸다.
//
// 한 번에 하나만 돌아야 한다. 전송 중에 체크가 하나 더 들어오면
// 자동 동기화가 두 번째 push를 띄우는데, 둘이 같은 큐를 각자 잘라내면
// 슬라이스 범위를 넘기거나 아직 못 보낸 문장을 잃는다.
func (a *App) push(verbose bool) {
	if a.pushing {
		if verbose {
			a.status("이미 반영 중입니다. 잠시 뒤에 다시 눌러 주세요.", "")
		}
		return
	}
	if len(a.queue) == 0 {
		if verbose {
			a.status("보낼 변경이 없습니다.", "")
		}
		return
	}
	if a.settings.DoltDB == "" {
		if verbose {
			a.status("먼저 DoltHub DB 이름을 넣으세요.", "err")
		}
		return
	}

	a.pushing = true
	drain := false
	defer func() {
		a.pushing = false
		if drain {
			go a.push(false)
		}
	}()

	a.busy("보내는 중…")
	msg := fmt.Sprintf("habit-chain: %d개 변경 반영", len(a.queue))
	sent, err := relay.Push(a.origin()+"/api/write", a.settings.WriteKey,
		a.settings.DoltDB, a.settings.DoltBranch, a.queue, msg)

	// 실패해도 반영된 만큼은 큐에서 덜어낸다. 같은 문장을 두 번 보내지 않기 위해서다.
	if sent > len(a.queue) {
		sent = len(a.queue)
	}
	if sent > 0 {
		a.queue = a.queue[sent:]
		a.settings.LastSynced = time.Now().Format(time.RFC3339)
		store.SaveSettings(a.settings)
	}
	a.render()

	if err != nil {
		a.status("보내기 실패: "+err.Error(), "err")
		a.updateBadge()
		return
	}

	a.status(fmt.Sprintf("%d개를 DoltHub에 반영했습니다.", sent), "ok")

	// 보내는 동안 들어온 변경이 남아 있으면 이어서 보낸다.
	// 성공했을 때만 건다 — 실패에도 걸면 무한히 재시도한다.
	drain = len(a.queue) > 0
}

// origin은 앱이 서빙되고 있는 곳이다. 쓰기 서버는 언제나 여기 붙어 있다.
func (a *App) origin() string {
	return js.Global().Get("location").Get("origin").String()
}

// serverConfig는 앱을 서빙하는 서버가 알려주는 기본값이다.
type serverConfig struct {
	OK              bool   `json:"ok"`
	DB              string `json:"db"`
	Branch          string `json:"branch"`
	WriteConfigured bool   `json:"writeConfigured"`
	RequiresKey     bool   `json:"requiresKey"`
}

// adoptServerConfig는 서버가 알려준 기본값을 받아들인다.
//
// 덕분에 처음 여는 사람도 설정 화면을 열 필요가 없다.
// 다만 사용자가 직접 넣은 DB 이름은 절대 덮어쓰지 않는다 —
// 사용자별 데이터 격리가 바로 그 값에 걸려 있기 때문이다.
func (a *App) adoptServerConfig() {
	resp, err := http.Get(a.origin() + "/api/health")
	if err != nil {
		return // 정적 파일만 서빙되는 곳. 로컬 전용으로 동작한다.
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return
	}
	var cfg serverConfig
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil || !cfg.OK {
		return
	}

	changed := false
	if a.settings.DoltDB == "" && cfg.DB != "" {
		a.settings.DoltDB = cfg.DB
		changed = true
	}
	if a.settings.DoltBranch == "" && cfg.Branch != "" {
		a.settings.DoltBranch = cfg.Branch
		changed = true
	}
	if changed {
		store.SaveSettings(a.settings)
	}

	a.serverWrites = cfg.WriteConfigured
	a.el("write-key-row").Set("hidden", !cfg.RequiresKey)
	if !cfg.WriteConfigured {
		a.el("write-hint").Set("textContent",
			"이 서버에는 DoltHub 토큰이 설정되어 있지 않습니다. 지금 한 기록은 이 탭에만 있고 새로고침하면 사라집니다 — 아래에서 SQL을 복사해 직접 반영하세요.")
	}

	a.fillSettings()
	a.updateBadge()
}

// ── 브라우저 부수 기능 ────────────────────────────────

func (a *App) copy(text, okMsg string) {
	nav := js.Global().Get("navigator")
	clip := nav.Get("clipboard")
	if clip.IsUndefined() {
		a.status("이 브라우저에서는 복사를 지원하지 않습니다.", "err")
		return
	}
	clip.Call("writeText", text)
	a.status(okMsg, "ok")
}

func (a *App) export() {
	b, err := json.MarshalIndent(a.state, "", "  ")
	if err != nil {
		a.status("내보내기 실패: "+err.Error(), "err")
		return
	}

	blob := js.Global().Get("Blob").New(
		[]any{string(b)},
		map[string]any{"type": "application/json"},
	)
	url := js.Global().Get("URL").Call("createObjectURL", blob)

	link := a.doc.Call("createElement", "a")
	link.Set("href", url)
	link.Set("download", "habit-chain-"+a.today.Format(model.DateLayout)+".json")
	link.Call("click")
	js.Global().Get("URL").Call("revokeObjectURL", url)

	a.status("JSON을 내려받았습니다.", "ok")
}

// newID는 crypto.randomUUID로 습관 id를 만든다.
func newID() string {
	c := js.Global().Get("crypto")
	if !c.IsUndefined() && !c.Get("randomUUID").IsUndefined() {
		return c.Call("randomUUID").String()
	}
	return fmt.Sprintf("h%d", time.Now().UnixNano())
}
