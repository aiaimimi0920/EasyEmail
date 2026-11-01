import assert from "node:assert/strict";
import { test } from "node:test";
import { migrationStatements } from "./migration-sql.mjs";

test("migration fixture preserves complete SQLite trigger bodies while splitting ordinary statements", () => {
  const sql = `-- Expand only; keep this comment.
CREATE TABLE example(id TEXT, value TEXT);
CREATE TRIGGER example_lifecycle AFTER UPDATE ON example
WHEN NEW.value IS NULL BEGIN
  UPDATE example SET value=CASE WHEN NEW.id='a;b' THEN 'x'';y' ELSE NULL END WHERE id=NEW.id;
END;
/* comment with ; BEGIN END */ CREATE INDEX example_id ON example(id);`;
  const statements = migrationStatements(sql);
  assert.equal(statements.length, 3); assert.match(statements[1], /^CREATE TRIGGER/);
  assert.match(statements[1], /END WHERE id=NEW.id;\s*END;$/);
  assert.match(statements[2], /CREATE INDEX/);
});

test("migration fixture treats quoted identifiers, strings and comments as opaque, never empty SQL", () => {
  const statements = migrationStatements(`-- only ;\n; /* empty; */;
CREATE TABLE [semi;colon]("BEGIN;END" TEXT, \`back;tick\` TEXT);
INSERT INTO [semi;colon] VALUES('a;--b', 'c/*d;*/'); -- trailing comment;`);
  assert.equal(statements.length, 2); assert.match(statements[0], /CREATE TABLE/); assert.match(statements[1], /INSERT INTO/);
  assert.deepEqual(migrationStatements("-- only a comment;"), []);
  for (const sql of ["SELECT 'unterminated", "/* unterminated", "CREATE TRIGGER x AFTER UPDATE ON t BEGIN SELECT 1;"])
    assert.throws(() => migrationStatements(sql), /Incomplete migration SQL/);
});
