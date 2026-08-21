# Habit Chain ⛓

> "Don't break the chain."

매일 칸을 하나씩 채우고, 그 사슬을 끊지 않는 것. 그것만 하는 앱입니다.
Go로 짜서 WebAssembly로 돌리고, 데이터는 [DoltHub](https://www.dolthub.com)에 버전 관리된 채로 쌓입니다.

- **앱**: https://habit-chain.habit-chain-worker.workers.dev
- **데이터**: https://www.dolthub.com/repositories/benelog/habit-chain

## 왜 이런 구조인가

핵심 제약을 먼저 조사했습니다. **DoltHub는 브라우저에서 읽을 수는 있지만 쓸 수는 없습니다.**

| 경로 | 브라우저에서 | 확인한 내용 |
|---|---|---|
| 읽기 `GET /api/v1alpha1/{owner}/{db}/{branch}?q=` | 가능 | 응답에 `Access-Control-Allow-Origin`이 요청 Origin으로 반영됩니다. 공개 DB는 인증도 필요 없습니다. |
| 쓰기 `POST .../write/{from}/{to}` | 불가 | 토큰을 `authorization` 헤더로만 받는데, preflight 응답이 `Access-Control-Allow-Methods: GET` 하나뿐이고 `Allow-Headers`가 없습니다. |
| v2 API `/api/v2/...` | 불가 | `OPTIONS`에 405로 답하고, 성공 응답에도 CORS 헤더가 없습니다. |

그래서 쓰기만 서버가 대신합니다. 화면과 API를 **하나의 Cloudflare Worker**가 서빙합니다.

```
                    읽기 (인증 없음, CORS 통과)
  ┌───────────┐  ──────────────────────────────────▶  ┌──────────┐
  │  브라우저   │                                       │ DoltHub  │
  │ Go + wasm │  ──▶ ┌──────────────────┐  ──────────▶ │   API    │
  └───────────┘      │ Cloudflare Worker │   쓰기       └──────────┘
        │            │ (DOLTHUB_TOKEN)   │
        ▼            └──────────────────┘
  LocalStorage         화면도 여기서 나온다
  (사용자 설정만)
```

앱은 자기가 놓인 곳의 `/api/health`를 읽어 DB 이름과 브랜치를 스스로 채웁니다.
처음 여는 사람도 설정 화면을 열 필요가 없습니다.

**기록의 원본은 DoltHub 하나뿐입니다.** 앱은 켤 때마다 거기서 읽어 메모리에 두고, 브라우저의 LocalStorage에는
DB 이름·브랜치·쓰기 키 같은 **사용자 설정만** 남깁니다. 그래서 다른 기기에서 지운 습관이 여기서도 사라집니다.

체크는 누를 때마다 곧바로 쓰기 서버로 갑니다. 미루지 않는 이유는 미룰 곳이 없기 때문입니다 —
아직 못 보낸 변경은 메모리의 SQL 큐에만 있고 상단 배지에 개수로 뜨지만, **그 상태로 새로고침하면 사라집니다.**
쓰기 서버가 죽어 있다면 설정의 `대기 중인 SQL 복사`로 꺼내 직접 반영하세요.

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
  store/                 LocalStorage에 담는 사용자 설정
  dolt/                  DoltHub 읽기 + 반영할 SQL 만들기
  relay/                 쓰기 프록시 호출
  app/                   화면 렌더링과 이벤트
web/                     정적 자산 (PWA: manifest, service worker, 아이콘)
worker/                  Cloudflare Worker — 정적 자산 서빙 + /api/write
sql/schema.sql           DoltHub 초기 스키마
```

## 로컬에서 돌리기

```bash
# wasm 빌드
GOOS=js GOARCH=wasm go build -ldflags="-s -w" -o web/app.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" web/wasm_exec.js

# Worker와 화면을 함께 띄운다
cd worker
npm install
cat > .dev.vars <<'EOF'
DOLTHUB_TOKEN=<DoltHub 토큰>
WRITE_KEY=<아무 문자열>
EOF
npm run dev                       # http://localhost:8788

# 테스트
go test ./internal/model/
```

`localhost`에서는 서비스 워커를 등록하지 않습니다. 캐시가 옛 자산을 붙잡는 일을 막기 위해서입니다.

## 배포

```bash
cd worker
npx wrangler secret put DOLTHUB_TOKEN   # DoltHub → Settings → Tokens
npx wrangler secret put WRITE_KEY       # 앱 설정에 넣을 공유 비밀
npx wrangler deploy
```

이후 push마다 `.github/workflows/worker.yml`이 자동 배포합니다.
저장소 시크릿에 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID`가 필요하고,
없으면 배포 단계는 알림만 남기고 넘어갑니다. 시크릿은 배포가 건드리지 않습니다.

**새 DB를 쓴다면** 스키마부터 넣어야 합니다. 새 DoltHub DB는 커밋이 없어 브랜치조차 없고, 그 상태로는 읽기도 실패합니다.
`sql/schema.sql`을 DoltHub의 SQL 콘솔에 붙여넣고 커밋하거나, 앱 설정의 `스키마 SQL 복사` 버튼을 쓰세요.

`WRITE_KEY`는 선택이지만 권합니다. 설정하지 않으면 입력란 자체가 사라져 설정할 것이 아무것도 없어지지만,
Worker 주소를 아는 누구나 `ALLOWED_DB`에 임의 SQL을 실행할 수 있습니다.
Dolt가 버전 관리를 하니 되돌릴 수는 있어도 손이 갑니다.

## 사슬 규칙

오늘 아직 체크하지 않았어도, 어제까지 이어져 있으면 사슬은 살아 있습니다.
**하루를 통째로 건너뛰어야 끊어집니다.** 오늘 밤에 하면 되니까요.
