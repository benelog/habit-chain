// Package relay는 브라우저에서 직접 할 수 없는 DoltHub 쓰기를
// Cloudflare Worker 프록시에 대신 시키는 통로다.
//
// DoltHub의 쓰기 엔드포인트는 Authorization 헤더를 요구하는데
// preflight(OPTIONS)가 GET만 허용해서 브라우저 요청이 차단된다.
// Worker는 서버에서 도니 그 제약이 없고, DoltHub 토큰도 브라우저가 아니라
// Worker 시크릿에 남는다.
package relay

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// batchLimit은 한 번에 보낼 문장 수다.
// Worker가 문장마다 DoltHub 작업이 끝나기를 기다리므로,
// 한 요청이 지나치게 길어지지 않도록 나눠 보낸다.
const batchLimit = 25

type request struct {
	DB      string   `json:"db"`
	Branch  string   `json:"branch"`
	SQL     []string `json:"sql"`
	Message string   `json:"message"`
}

type response struct {
	Applied int    `json:"applied"`
	Error   string `json:"error"`
}

// Push는 SQL 문장들을 쓰기 프록시로 보내고, 실제로 반영된 문장 수를 돌려준다.
// 중간에 실패해도 그때까지 반영된 개수를 함께 돌려주므로,
// 호출자는 나머지만 다시 보내면 된다.
func Push(endpoint, key, db, branch string, stmts []string, message string) (int, error) {
	if endpoint == "" {
		return 0, fmt.Errorf("쓰기 서버 주소가 없습니다")
	}
	if len(stmts) == 0 {
		return 0, nil
	}

	batch := stmts
	if len(batch) > batchLimit {
		batch = batch[:batchLimit]
	}

	body, err := json.Marshal(request{DB: db, Branch: branch, SQL: batch, Message: message})
	if err != nil {
		return 0, err
	}

	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return 0, fmt.Errorf("주소가 올바르지 않습니다: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("X-Write-Key", key)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("쓰기 서버에 닿지 못했습니다: %w", err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)

	var out response
	if err := json.Unmarshal(raw, &out); err != nil {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 160 {
			snippet = snippet[:160] + "..."
		}
		if resp.StatusCode == http.StatusNotFound {
			return 0, fmt.Errorf("쓰기 서버가 없습니다 (%s). 설정에서 주소를 확인하세요", resp.Status)
		}
		return 0, fmt.Errorf("쓰기 서버 응답을 해석하지 못했습니다 (%s): %s", resp.Status, snippet)
	}

	if out.Error != "" {
		return out.Applied, fmt.Errorf("%s", out.Error)
	}
	if resp.StatusCode != http.StatusOK {
		return out.Applied, fmt.Errorf("쓰기 서버가 %s를 반환했습니다", resp.Status)
	}
	return out.Applied, nil
}
