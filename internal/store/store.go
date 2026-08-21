//go:build js && wasm

// Package store는 브라우저 LocalStorage에 설정과 데이터를 보관한다.
package store

import (
	"encoding/json"
	"syscall/js"

	"github.com/benelog/habit-chain/internal/model"
)

const (
	keyState    = "habit-chain.state"
	keySettings = "habit-chain.settings"
	keyQueue    = "habit-chain.queue"
)

// Settings는 사용자별 설정이다. 데이터 격리는 여기 적힌 DoltHub DB로 이뤄진다.
type Settings struct {
	DoltDB     string `json:"dolt_db"`     // "benelog/habit-chain" 형식
	DoltBranch string `json:"dolt_branch"` // 기본 main
	WriteURL   string `json:"write_url"`   // 쓰기 프록시 주소. 비면 같은 출처의 /api/write
	WriteKey   string `json:"write_key"`   // 프록시가 요구하는 공유 비밀
	AutoSync   bool   `json:"auto_sync"`   // 체크할 때마다 곧바로 밀어넣기
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

// LoadSettings는 저장된 설정을 읽는다. 없으면 기본값을 준다.
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

// SaveSettings는 설정을 LocalStorage에 쓴다.
func SaveSettings(s Settings) {
	b, err := json.Marshal(s)
	if err != nil {
		return
	}
	set(keySettings, string(b))
}

// LoadState는 습관과 체크 기록을 읽는다.
func LoadState() model.State {
	var st model.State
	if raw := get(keyState); raw != "" {
		_ = json.Unmarshal([]byte(raw), &st)
	}
	return st
}

// SaveState는 습관과 체크 기록을 쓴다.
func SaveState(st model.State) {
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	set(keyState, string(b))
}

// LoadQueue는 아직 DoltHub에 반영하지 못한 SQL 문들을 읽는다.
func LoadQueue() []string {
	var q []string
	if raw := get(keyQueue); raw != "" {
		_ = json.Unmarshal([]byte(raw), &q)
	}
	return q
}

// SaveQueue는 미반영 SQL 큐를 쓴다.
func SaveQueue(q []string) {
	b, err := json.Marshal(q)
	if err != nil {
		return
	}
	set(keyQueue, string(b))
}
