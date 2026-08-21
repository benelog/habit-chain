# Habit Chain ⛓

> "Don't break the chain."

매일 칸을 하나씩 채우고, 그 사슬을 끊지 않는 것. 그것만 하는 앱입니다.
Go로 짜서 WebAssembly로 돌리고, 데이터는 [DoltHub](https://www.dolthub.com)에 버전 관리된 채로 쌓입니다.

- **앱**: https://habit-chain.\<계정\>.workers.dev (Cloudflare Workers)
- **미러**: https://benelog.github.io/habit-chain/ (GitHub Pages, 읽기 전용)
- **데이터**: https://www.dolthub.com/repositories/benelog/habit-chain

## 왜 이런 구조인가

핵심 제약을 먼저 조사했습니다. **DoltHub는 브라우저에서 읽을 수는 있지만 쓸 수는 없습니다.**

| 경로 | 브라우저에서 | 확인한 내용 |
|---|---|---|
| 읽기 `GET /api/v1alpha1/{owner}/{db}/{branch}?q=` | 가능 | 응답에 `Access-Control-Allow-Origin`이 요청 Origin으로 반영됩니다. 공개 DB는 인증도 필요 없습니다. |
| 쓰기 `POST .../write/{from}/{to}` | 불가 | 토큰을 `authorization` 헤더로만 받는데, preflight 응답이 `Access-Control-Allow-Methods: GET` 하나뿐이고 `Allow-Headers`가 없습니다. |
| v2 API `/api/v2/...` | 불가 | `OPTIONS`에 405로 답하고, 성공 응답에도 CORS 헤더가 없습니다. |

그래서 이렇게 나눴습니다.

```
                    읽기 (인증 없음, CORS 통과)
  ┌───────────┐  ──────────────────────────────────▶  ┌──────────┐
  │  브라우저   │                                       │ DoltHub  │
  │ Go + wasm │  ──▶ ┌──────────────────┐  ──────────▶ │   API    │
  └───────────┘      │ Cloudflare Worker │   쓰기       └──────────┘
        │            │ (DOLTHUB_TOKEN)   │
        ▼            └──────────────────┘
  LocalStorage
  (항상 여기 먼저 쓴다)
```

기록은 **언제나 LocalStorage에 먼저** 들어갑니다. 네트워크가 없어도, 쓰기 서버가 없어도 앱은 그대로 동작합니다.
DoltHub 반영은 그 위에 얹힌 동기화일 뿐이고, 아직 못 보낸 변경은 SQL 큐에 남아 상단 배지에 개수로 표시됩니다.

## 사용자별 데이터 격리

설정에서 각자 자기 **DoltHub DB 이름**(`owner/name`)을 넣습니다. 읽기는 그것만으로 끝 — 공개 DB면 누구든 자기 것을 봅니다.

쓰기는 사정이 다릅니다. Worker의 `DOLTHUB_TOKEN`은 그 토큰 주인의 DB에만 쓸 수 있으므로,
**남의 Worker를 통해 자기 DB에 쓸 수는 없습니다.** 다른 사람이 쓰기까지 하려면 이 저장소를 포크해
자기 DoltHub DB와 자기 Worker를 두면 됩니다. `ALLOWED_DB` 변수로 쓰기 대상 DB를 못박아 둘 수 있습니다.

## 구조

```
main.go                  wasm 진입점
internal/
  model/                 도메인 타입과 사슬 계산 (순수 Go, 테스트 있음)
  store/                 LocalStorage 읽고 쓰기
  dolt/                  DoltHub 읽기 + 반영할 SQL 만들기
  relay/                 쓰기 프록시 호출
  app/                   화면 렌더링과 이벤트
web/                     정적 자산 (PWA: manifest, service worker, 아이콘)
worker/                  Cloudflare Worker — 정적 자산 서빙 + /api/write
scripts/
  serve.py               로컬 확인용 정적 서버
  dolt_apply.py          손으로 SQL을 반영할 때 쓰는 스크립트
sql/schema.sql           DoltHub 초기 스키마
```

## 로컬에서 돌리기

```bash
# 1. wasm 빌드
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/app.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/wasm_exec.js

# 2a. 정적 파일만 보기
python3 scripts/serve.py          # http://127.0.0.1:8787

# 2b. 쓰기 프록시까지 함께 보기
cd worker
cat > .dev.vars <<'EOF'
DOLTHUB_TOKEN=<DoltHub 토큰>
WRITE_KEY=<아무 문자열>
EOF
npx wrangler dev --port 8788      # http://localhost:8788

# 테스트
go test ./internal/model/
```

`localhost`에서는 서비스 워커를 등록하지 않습니다. 캐시가 옛 자산을 붙잡는 일을 막기 위해서입니다.

## 처음 설정하기

**1. DoltHub 스키마 만들기** — 새 DB는 브랜치조차 없어서 읽기부터 실패합니다.
`sql/schema.sql`을 DoltHub의 SQL 콘솔에 붙여넣고 커밋하거나, 토큰이 있다면 Actions의
`DoltHub SQL 수동 실행` 워크플로우로 넣습니다.

**2. Worker 배포**

```bash
cd worker
npx wrangler secret put DOLTHUB_TOKEN   # DoltHub → Settings → Tokens
npx wrangler secret put WRITE_KEY       # 앱 설정에 넣을 공유 비밀
npx wrangler deploy
```

이후 push마다 `.github/workflows/worker.yml`이 자동 배포합니다.
저장소 시크릿에 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID`가 필요합니다.

**3. 앱 설정** — DB 이름과 쓰기 키를 넣습니다. 앱이 Worker에서 서빙되면 쓰기 서버 주소는 비워두세요.
같은 출처의 `/api/write`를 자동으로 씁니다. GitHub Pages 미러에서 쓰려면 Worker 주소를 적어 넣습니다.

## 사슬 규칙

오늘 아직 체크하지 않았어도, 어제까지 이어져 있으면 사슬은 살아 있습니다.
**하루를 통째로 건너뛰어야 끊어집니다.** 오늘 밤에 하면 되니까요.
