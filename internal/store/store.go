// Package store는 이 브라우저에만 남는 사용자 설정을 읽고 쓴다.
//
// LocalStorage에는 설정만 넣는다. 습관과 기록의 원본은 DoltHub이고,
// 앱은 켤 때마다 거기서 읽어 메모리에만 들고 있는다.
package store

import (
	"encoding/json"
	"syscall/js"

	"github.com/benelog/habit-chain/internal/model"
)

const keySettings = "habit-chain.settings"

type Settings struct {
	DoltDB     string `json:"dolt_db"`     // "benelog/habit-chain" 형식
	DoltBranch string `json:"dolt_branch"` // 기본 main
	WriteKey   string `json:"write_key"`   // 쓰기 서버가 요구하는 공유 비밀
	LastSynced string `json:"last_synced"` // RFC3339
}

func local() js.Value { return js.Global().Get("localStorage") }

func get(key string) string {
	v := local().Call("getItem", key)
	if v.IsNull() || v.IsUndefined() {
		return ""
	}
	return v.String()
}

func set(key, val string) { local().Call("setItem", key, val) }

func LoadSettings() Settings {
	s := Settings{DoltBranch: "main"}
	if raw := get(keySettings); raw != "" {
		_ = json.Unmarshal([]byte(raw), &s)
	}
	if s.DoltBranch == "" {
		s.DoltBranch = "main"
	}
	return s
}

func SaveSettings(s Settings) {
	b, err := json.Marshal(s)
	if err != nil {
		return
	}
	set(keySettings, string(b))
}

// ── 이전 버전이 남긴 데이터 ────────────────────────────
//
// 예전에는 습관과 기록도 LocalStorage에 넣었다. 그 키들은 이제 읽지 않지만,
// 아직 DoltHub에 못 올린 기록이 거기 남아 있을 수 있으므로 함부로 지우지 않는다.

const (
	legacyKeyState = "habit-chain.state"
	legacyKeyQueue = "habit-chain.queue"
)

// LegacyState는 이전 버전이 남긴 기록을 읽는다. 없으면 ok가 false다.
func LegacyState() (model.State, bool) {
	raw := get(legacyKeyState)
	if raw == "" {
		return model.State{}, false
	}
	var st model.State
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return model.State{}, false
	}
	return st, true
}

// DropLegacy는 이전 버전이 남긴 키를 지운다.
// 그 내용이 DoltHub에 모두 들어 있다고 확인한 다음에만 부를 것.
func DropLegacy() {
	local().Call("removeItem", legacyKeyState)
	local().Call("removeItem", legacyKeyQueue)
}
