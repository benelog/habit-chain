# Habit Chain ⛓

> "Don't break the chain."

매일 칸을 하나씩 채우고, 그 사슬을 끊지 않는 것. 그것만 하는 앱입니다.
TypeScript로 짠 Cloudflare Worker가 화면을 그리고, 브라우저는 [htmx](https://htmx.org)가 조각을 갈아끼웁니다.
데이터는 [DoltHub](https://www.dolthub.com)에 버전 관리된 채로 쌓입니다.

- **앱**: https://chain.benelog.net
- **데이터**: https://www.dolthub.com/repositories/benelog/habit-chain

## 왜 이런 구조인가

핵심 제약을 먼저 조사했습니다. **DoltHub는 브라우저에서 읽을 수는 있지만 쓸 수는 없습니다.**
(지금은 읽기도 Worker가 하므로 이 표는 "왜 서버가 필요한가"의 근거로만 남습니다.)

| 경로 | 브라우저에서 | 확인한 내용 |
|---|---|---|
| 읽기 `GET /api/v1alpha1/{owner}/{db}/{branch}?q=` | 가능 | 응답에 `Access-Control-Allow-Origin`이 요청 Origin으로 반영됩니다. 공개 DB는 인증도 필요 없습니다. |
| 쓰기 `POST .../write/{from}/{to}` | 불가 | 토큰을 `authorization` 헤더로만 받는데, preflight 응답이 `Access-Control-Allow-Methods: GET` 하나뿐이고 `Allow-Headers`가 없습니다. |
| v2 API `/api/v2/...` | 불가 | `OPTIONS`에 405로 답하고, 성공 응답에도 CORS 헤더가 없습니다. |

그래서 **하나의 Cloudflare Worker**가 전부 합니다 — DoltHub 읽기·쓰기, 그리고 HTML 렌더링까지.

```
  ┌───────────┐   HTML 조각      ┌──────────────────┐   읽기 + 쓰기   ┌──────────┐
  │  브라우저   │ ◀────────────── │ Cloudflare Worker │ ──────────────▶ │ DoltHub  │
  │   htmx    │ ──────────────▶ │  (DOLTHUB_TOKEN)  │                 │   API    │
  └───────────┘   hx-post 등     └──────────────────┘                 └──────────┘
        │
        ▼
  LocalStorage
  (쓰기 키 하나뿐)
```

브라우저에 도메인 로직이 없습니다. 사슬 계산도, 그리드 배치도 Worker가 하고
브라우저는 받은 조각을 `#habits`에 끼워 넣기만 합니다.

**단 하나, 오늘이 며칠인지는 브라우저가 알려줍니다.** 서버에는 사용자의 시간대가 없어서,
UTC로 정하면 KST 사용자는 오전 9시 전까지 체크가 어제 칸에 들어갑니다.
그래서 htmx가 요청마다 `X-Local-Date` 헤더에 로컬 날짜를 실어 보냅니다.

**기록의 원본은 DoltHub 하나뿐입니다.** 앱은 켤 때마다 거기서 읽어 메모리에 두고, 브라우저의 LocalStorage에는
DB 이름·브랜치·쓰기 키 같은 **사용자 설정만** 남깁니다. 그래서 다른 기기에서 지운 습관이 여기서도 사라집니다.

체크는 누를 때마다 곧바로 쓰기 서버로 갑니다. 미루지 않는 이유는 미룰 곳이 없기 때문입니다 —
쌓아 둘 큐가 없습니다. 왕복이 1.5~2초라 그동안 상단에 가는 진행 막대가 지나가고, 누른 칸은 깜빡이고,
그 카드는 잠깁니다. **실패하면 화면은 그대로 두고 아래에 토스트만 뜹니다** — 오류 문구가 기록을 덮지 않도록
서버가 `HX-Retarget`으로 목적지를 토스트로 돌립니다.

## 사용자별 데이터 격리

읽기까지 Worker로 옮기면서 **DB는 Worker가 `ALLOWED_DB`로 못박습니다.** 화면에서 다른 DB를 지정하는 설정은 없앴습니다 —
서버가 그리는데 클라이언트가 원본을 고른다는 게 앞뒤가 맞지 않기 때문입니다.

자기 데이터를 쓰려면 이 저장소를 포크해 **자기 DoltHub DB와 자기 Worker**를 두면 됩니다.
어차피 `DOLTHUB_TOKEN`은 그 토큰 주인의 DB에만 쓸 수 있어서, 예전에도 남의 Worker로는 쓰기가 안 됐습니다.

## 구조

```
worker/src/
  index.ts               라우팅
  model.ts               도메인 타입과 사슬 계산 (순수 함수, 네트워크 없음)
  dolt.ts                DoltHub 읽기·쓰기와 SQL 만들기
  render.ts              HTML 조각과 페이지 껍데기
  model.test.ts          테스트 17개 — vitest로 0.1초에 돈다
web/                     정적 자산 (app.css, htmx.min.js, PWA)
sql/schema.sql           DoltHub 초기 스키마
```

| 경로 | 하는 일 |
|---|---|
| `GET /` | 데이터 없는 껍데기. 목록은 `hx-trigger="load"`가 따로 불러옵니다 |
| `GET /habits` | 습관 목록 조각 |
| `POST /habits` | 습관 추가 → 목록 조각 |
| `POST /habits/:id/toggle?date=` | 체크 토글 → **카드 하나** + 오늘 요약(`hx-swap-oob`) |
| `DELETE /habits/:id` | 습관 삭제 → 목록 조각 |
| `GET /export` | 전체 JSON 내려받기 |

첫 요청이 껍데기뿐인 데는 이유가 있습니다. `GET /`는 htmx 요청이 아니라서 `hx-headers`가 붙지 않고,
그러면 서버가 사용자의 로컬 날짜도 쓰기 키도 모릅니다. 데이터는 전부 htmx 요청에 태웁니다.

## 로컬에서 돌리기

```bash
cd worker
npm install
cat > .dev.vars <<'VARS'
DOLTHUB_TOKEN=<DoltHub 토큰>
WRITE_KEY=<아무 문자열>
VARS
npm run dev        # http://localhost:8788

npm test           # vitest
npm run check      # tsc --noEmit
npm run build      # dist/ 만 다시 만든다
```

`npm run dev`는 매번 `npm run build`를 먼저 돌립니다. 빌드라고 해봐야 `web/`을 `dist/`로
복사하고 esbuild가 `src/index.ts`를 `dist/_worker.js` 하나로 묶는 게 전부입니다(수십 밀리초).
자산이나 코드를 고쳤으면 `npm run dev`를 다시 띄우세요.

로컬에서 실제 DoltHub를 건드리기 싫다면 `.dev.vars`에 한 줄 더하면 됩니다 —
`.dev.vars`가 `wrangler.jsonc`의 `vars`를 덮습니다.

```
ALLOWED_DB=<owner>/<dev용 DB>
```

`localhost`에서는 서비스 워커를 등록하지 않습니다. 캐시가 옛 자산을 붙잡는 일을 막기 위해서입니다.

서비스 워커는 **정적 자산만** 캐시합니다. `/habits` 같은 조각은 DoltHub의 현재 내용이라
캐시에 들어가는 순간 옛 기록이 굳어 버립니다. 오프라인이면 껍데기는 뜨지만 목록은 비어 있습니다.

## 배포

```bash
cd worker
npx wrangler pages secret put DOLTHUB_TOKEN   # DoltHub → Settings → Tokens
npx wrangler pages secret put WRITE_KEY       # 앱 설정에 넣을 공유 비밀
npm run deploy                                # 빌드 후 wrangler pages deploy
```

**Worker가 아니라 Pages인 이유는 도메인 하나 때문입니다.** `benelog.net`의 DNS는 Netlify에 있는데,
Workers 커스텀 도메인은 그 도메인이 Cloudflare 존일 것을 요구하고 서브도메인만 따로 존으로 떼는 것은
Enterprise 전용입니다. Pages는 서브도메인이면 외부 DNS에 CNAME 한 줄(`chain` → `habit-chain.pages.dev`)로 붙습니다.
코드는 그대로입니다 — Pages advanced mode는 빌드 산출물의 `_worker.js` 하나에 모든 요청을 먼저 주고,
`env.ASSETS`로 정적 자산을 넘기는 방식이 Worker + Static Assets 때와 같습니다.
덕분에 `run_worker_first` 같은 설정이 필요 없어졌습니다.

이후 push마다 `.github/workflows/worker.yml`이 타입 검사와 테스트를 돌리고 자동 배포합니다.
저장소 시크릿에 `CLOUDFLARE_API_TOKEN`과 `CLOUDFLARE_ACCOUNT_ID`가 필요하고,
없으면 배포 단계는 알림만 남기고 넘어갑니다. 시크릿은 배포가 건드리지 않습니다.

**새 DB를 쓴다면** 스키마부터 넣어야 합니다. 새 DoltHub DB는 커밋이 없어 브랜치조차 없고, 그 상태로는 읽기도 실패합니다.
`sql/schema.sql`을 DoltHub의 SQL 콘솔에 붙여넣고 커밋하거나, 앱 설정의 `스키마 SQL 보기`(`/schema.sql`)에서 받아 쓰세요.

`WRITE_KEY`는 선택이지만 권합니다. 설정하지 않으면 입력란 자체가 사라져 설정할 것이 아무것도 없어지지만,
앱 주소를 아는 누구나 `ALLOWED_DB`에 임의 SQL을 실행할 수 있습니다.
Dolt가 버전 관리를 하니 되돌릴 수는 있어도 손이 갑니다.

## 화면의 규칙

**껍데기는 무채색이고, 색은 사슬만 갖습니다.** 습관 색은 사용자가 고른 값이라, UI가 색을 쓰면 둘이 서로 싸웁니다.
유일한 예외가 빨강 하나 — 사슬이 마지막으로 끊긴 칸에 눈금으로 남습니다. 새 습관의 색은 여덟 개 중에서만 고릅니다.
아무 색이나 고를 수 있으면 화면이 금방 안 어울리는 색으로 찹니다.

붙어 있는 날은 사이를 이어 하나의 사슬로 그립니다. 줄이 바뀌는 자리(토→일)에도 짧은 꼬리를 답니다 —
거기서 끊긴 것처럼 보이면 앱이 하는 말과 화면이 어긋나기 때문입니다. 같은 이유로 **오늘 표시는 이미 채운 칸에는
붙이지 않습니다.** 칸 둘레에 테를 두르면 그 테가 연결부를 가로질러 사슬을 끊어 놓습니다.

주가 세로로 흐르므로 달 이름은 그리드 왼쪽 여백에 붙습니다.

카드 하나에 칸이 35개입니다. 전부 탭 순서에 넣으면 키보드로는 지나갈 수가 없어서, 칸 하나만 탭으로 들어가고
안에서는 방향키로 움직입니다.

## 사슬 규칙

오늘 아직 체크하지 않았어도, 어제까지 이어져 있으면 사슬은 살아 있습니다.
**하루를 통째로 건너뛰어야 끊어집니다.** 오늘 밤에 하면 되니까요.
