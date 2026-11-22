import math
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from d1_restore import write_restore_sql
from d1_snapshot import open_snapshot, witness, witness_database
from boundary import DeploymentError


def autocommit_restore(path):
    database = sqlite3.connect(':memory:', isolation_level=None)
    database.execute('PRAGMA foreign_keys=ON')
    pending = ''
    try:
        for line in path.read_text(encoding='utf8').splitlines(keepends=True):
            pending += line
            if sqlite3.complete_statement(pending):
                database.execute(pending); pending = ''
        assert not pending.strip()
        assert database.execute('PRAGMA foreign_key_check').fetchall() == []
        return witness_database(database)
    finally: database.close()


class RestoreSqlTests(unittest.TestCase):
    def test_tables_precede_foreign_key_inserts_without_losing_nul_unicode_real_blob_or_allocators(self):
        root = Path(tempfile.mkdtemp(prefix='d1-restore-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        database = sqlite3.connect(':memory:')
        try:
            database.executescript('''CREATE TABLE z_parent(id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE a_child(parent INTEGER REFERENCES z_parent(id),text TEXT,bytes BLOB,value REAL);
CREATE UNIQUE INDEX parent_key ON z_parent(id);
INSERT INTO z_parent VALUES(1); UPDATE sqlite_sequence SET seq=71 WHERE name='z_parent';
CREATE TABLE changes(n INTEGER); INSERT INTO changes VALUES(0);
CREATE TRIGGER changed AFTER INSERT ON a_child BEGIN UPDATE changes SET n=n+1; END;''')
            for value in [1.0, math.nextafter(1.0, 2.0), float('inf'), float('-inf')]:
                database.execute('INSERT INTO a_child VALUES(1,?,?,?)', ('邮件\0after-nul', b'\x00\xff', value))
            before = witness_database(database); output = root / 'restore.sql'
            write_restore_sql(database, output)
            self.assertEqual(witness(output), before)
            self.assertEqual(autocommit_restore(output), before)
            sql = output.read_text(encoding='utf8')
            self.assertLess(sql.index('CREATE TABLE z_parent'), sql.index('INSERT INTO "a_child"'))
            self.assertLess(sql.index('CREATE UNIQUE INDEX parent_key'), sql.index('INSERT INTO "a_child"'))
            self.assertGreater(sql.index('CREATE TRIGGER changed'), sql.index('INSERT INTO "a_child"'))
            self.assertNotIn('BEGIN TRANSACTION;', sql); self.assertNotIn('COMMIT;', sql)
            restored = open_snapshot(output)
            try:
                self.assertEqual(restored.execute('SELECT text,bytes FROM a_child LIMIT 1').fetchone(), ('邮件\0after-nul', b'\x00\xff'))
                self.assertEqual(restored.execute('SELECT n FROM changes').fetchone(), (4,))
            finally: restored.close()
        finally: database.close()

    def test_self_references_and_cross_table_dependencies_do_not_depend_on_export_row_order(self):
        root = Path(tempfile.mkdtemp(prefix='d1-restore-order-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        database = sqlite3.connect(':memory:')
        try:
            database.executescript('''CREATE TABLE folders(id TEXT PRIMARY KEY,parent TEXT REFERENCES folders(id));
CREATE TABLE a_child(id TEXT PRIMARY KEY,parent TEXT REFERENCES z_parent(id));
CREATE TABLE z_parent(id TEXT PRIMARY KEY,parent TEXT REFERENCES a_child(id));
INSERT INTO folders VALUES('child','parent'),('parent',NULL),('self','self');
INSERT INTO a_child VALUES('child','parent'); INSERT INTO z_parent VALUES('parent',NULL);''')
            output = root / 'restore.sql'; write_restore_sql(database, output)
            self.assertEqual(autocommit_restore(output), witness_database(database))
            sql = output.read_text(encoding='utf8').lower()
            self.assertNotIn('defer_foreign_keys', sql); self.assertNotIn('foreign_keys=off', sql)
        finally: database.close()

    def test_data_dependency_cycle_is_rejected_without_disabling_constraints(self):
        root = Path(tempfile.mkdtemp(prefix='d1-restore-cycle-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        database = sqlite3.connect(':memory:')
        try:
            database.executescript('''CREATE TABLE a(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES b(id));
CREATE TABLE b(id INTEGER PRIMARY KEY,parent INTEGER REFERENCES a(id));
INSERT INTO a VALUES(1,1); INSERT INTO b VALUES(1,1);''')
            with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_RESTORE_DEPENDENCY_CYCLE'):
                write_restore_sql(database, root / 'restore.sql')
        finally: database.close()

    def test_existing_output_is_never_replaced(self):
        root = Path(tempfile.mkdtemp(prefix='d1-restore-existing-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        output = root / 'restore.sql'; output.write_text('keep', encoding='utf8')
        database = sqlite3.connect(':memory:'); database.execute('CREATE TABLE data(value)')
        try:
            with self.assertRaises(FileExistsError): write_restore_sql(database, output)
            self.assertEqual(output.read_text(encoding='utf8'), 'keep')
        finally: database.close()


if __name__ == '__main__': unittest.main()
