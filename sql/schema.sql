-- habit-chain 스키마
-- DoltHub SQL 콘솔에 붙여넣고 실행한 뒤 커밋하거나,
-- dolt CLI에서 `dolt sql < sql/schema.sql` 로 적용한다.

CREATE TABLE IF NOT EXISTS habits (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  color VARCHAR(16) NOT NULL DEFAULT '#f97316',
  created_at VARCHAR(32) NOT NULL,
  archived BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS checks (
  habit_id VARCHAR(36) NOT NULL,
  check_date DATE NOT NULL,
  note VARCHAR(500) NOT NULL DEFAULT '',
  PRIMARY KEY (habit_id, check_date)
);

-- 이미 habits 테이블이 있는 DB라면 위의 CREATE는 아무것도 하지 않는다.
-- IF NOT EXISTS는 테이블이 있으면 컬럼을 맞춰 주지 않는다. 그런 DB에는
-- 아래 한 줄을 한 번 실행하고 커밋해야 description이 생긴다.
--
--   ALTER TABLE habits ADD COLUMN description VARCHAR(2000) NOT NULL DEFAULT '';
--
-- (DoltHub 웹에서는 테이블 옆 연필 → SQL Query 로 들어가야 DDL이 실행된다.
--  일반 SQL 콘솔은 ALTER를 "Unsupported SQL statement"로 거부한다.
--  AFTER 절도 파서가 받지 않으니 컬럼 위치는 지정하지 않는다.)
