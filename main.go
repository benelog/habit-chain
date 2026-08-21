//go:build js && wasm

// Command habit-chain은 브라우저에서 도는 습관 추적기다.
//
// 데이터는 LocalStorage에 먼저 쌓이고, 설정한 DoltHub DB로 동기화된다.
// 읽기는 DoltHub API를 직접 호출하고, 쓰기는 GitHub Actions 릴레이를 거친다.
package main

import "github.com/benelog/habit-chain/internal/app"

func main() {
	app.New().Run()
}
