-- habit-chain schema.
-- Paste into the DoltHub SQL console and commit, or apply with the dolt CLI:
-- `dolt sql < sql/schema.sql`. The app can also do this itself — see the
-- "DB 준비하기" button, which runs these statements with the user's token.

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

-- On a DB that already has habits, the CREATE above does nothing: IF NOT
-- EXISTS will not reconcile columns. Such a DB needs this line once.
--
--   ALTER TABLE habits ADD COLUMN description VARCHAR(2000) NOT NULL DEFAULT '';
--
-- (On the DoltHub site, DDL runs only via the pencil next to the table ->
--  SQL Query. The plain console rejects ALTER as "Unsupported SQL statement".
--  The parser also rejects an AFTER clause, so column position is left unset.)
