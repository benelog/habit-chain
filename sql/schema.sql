-- habit-chain 스키마
-- DoltHub SQL 콘솔에 붙여넣고 실행한 뒤 커밋하거나,
-- dolt CLI에서 `dolt sql < sql/schema.sql` 로 적용한다.

CREATE TABLE IF NOT EXISTS habits (
  id VARCHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
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
