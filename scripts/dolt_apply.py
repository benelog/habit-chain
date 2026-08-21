#!/usr/bin/env python3
"""릴레이로 넘어온 SQL을 DoltHub write API로 반영한다.

브라우저에서는 CORS 때문에 이 호출을 할 수 없다. 여기(GitHub Actions)에서는
그냥 된다. write API는 비동기라 문장마다 완료될 때까지 폴링한다 —
DoltHub는 연속 호출을 몰아치면 일부가 조용히 누락되는 알려진 문제가 있다.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.dolthub.com/api/v1alpha1"
POLL_INTERVAL = 2
POLL_TIMEOUT = 180


def fail(msg):
    print(f"::error::{msg}", file=sys.stderr)
    sys.exit(1)


def request(url, token):
    req = urllib.request.Request(url, method="POST" if "/write/" in url else "GET")
    req.add_header("authorization", f"token {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:400]
        fail(f"DoltHub가 {e.code}를 반환했습니다: {body}")
    except urllib.error.URLError as e:
        fail(f"DoltHub에 닿지 못했습니다: {e.reason}")


def poll(owner, name, op_name, token):
    url = f"{API}/{owner}/{name}/write?" + urllib.parse.urlencode({"operationName": op_name})
    waited = 0
    while waited < POLL_TIMEOUT:
        res = request(url, token)
        if res.get("done"):
            details = res.get("res_details") or {}
            status = details.get("query_execution_status", "")
            if status and status != "Success":
                fail(f"쿼리 실패: {details.get('query_execution_message', status)}")
            return res
        time.sleep(POLL_INTERVAL)
        waited += POLL_INTERVAL
    fail(f"작업이 {POLL_TIMEOUT}초 안에 끝나지 않았습니다: {op_name}")


def main():
    token = os.environ.get("DOLTHUB_TOKEN", "").strip()
    db = os.environ.get("DOLT_DB", "").strip()
    branch = os.environ.get("DOLT_BRANCH", "").strip() or "main"
    sql = os.environ.get("DOLT_SQL", "")
    message = os.environ.get("DOLT_MESSAGE", "").strip()

    if not token:
        fail("DOLTHUB_TOKEN 시크릿이 없습니다. DoltHub → Settings → Tokens 에서 발급해 등록하세요.")
    if db.count("/") != 1 or not all(db.split("/")):
        fail(f"DB 이름은 owner/name 형식이어야 합니다: {db!r}")
    owner, name = db.split("/")

    # 한 줄에 한 문장씩 온다. 빈 줄과 주석은 버린다.
    statements = [s.strip() for s in sql.splitlines()]
    statements = [s for s in statements if s and not s.startswith("--")]
    if not statements:
        print("반영할 문장이 없습니다.")
        return

    print(f"{db}@{branch} 에 {len(statements)}개 문장을 반영합니다. {message}")

    for i, stmt in enumerate(statements, 1):
        url = (f"{API}/{owner}/{name}/write/{urllib.parse.quote(branch)}/"
               f"{urllib.parse.quote(branch)}?" + urllib.parse.urlencode({"q": stmt}))
        res = request(url, token)

        op = res.get("operation_name")
        if not op:
            status = res.get("query_execution_status", "")
            msg = res.get("query_execution_message", json.dumps(res)[:300])
            fail(f"[{i}/{len(statements)}] 작업이 시작되지 않았습니다 ({status}): {msg}")

        poll(owner, name, op, token)
        print(f"[{i}/{len(statements)}] OK  {stmt[:110]}")

    print(f"완료 — {len(statements)}개 문장을 {db}@{branch} 에 반영했습니다.")


if __name__ == "__main__":
    main()
