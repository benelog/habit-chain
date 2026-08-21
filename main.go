//go:build js && wasm

// Command habit-chain은 브라우저에서 도는 습관 추적기다.
//
// 기록의 원본은 설정한 DoltHub DB다. 앱은 켤 때마다 거기서 읽어 메모리에 두고,
// 브라우저의 LocalStorage에는 사용자 설정만 남긴다.
// 읽기는 DoltHub API를 직접 호출하고, 쓰기는 이 앱을 서빙하는 Worker가 대신한다.
package main

import "github.com/benelog/habit-chain/internal/app"

func main() {
	app.New().Run()
}
