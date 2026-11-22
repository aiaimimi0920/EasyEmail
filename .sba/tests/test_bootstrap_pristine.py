import json
import sqlite3
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bootstrap_pristine import ERROR, INITIAL_ROWS, database_witness, pristine
from boundary import DeploymentError
from fixtures import configuration


class PristineTests(unittest.TestCase):
    def setUp(self):
        self.config = configuration(); self.connections = {}
        for role in ('email', 'platform'):
            connection = sqlite3.connect(':memory:'); connection.row_factory = sqlite3.Row
            connection.executescript('CREATE TABLE users(id TEXT); CREATE TABLE address(id INTEGER PRIMARY KEY AUTOINCREMENT); CREATE TABLE settings(key TEXT,value TEXT);')
            if role == 'platform':
                connection.executescript("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT); INSERT INTO d1_migrations(name) VALUES('synthetic.sql');")
                for table, rows in INITIAL_ROWS.items():
                    columns = list(rows[0])
                    connection.execute('CREATE TABLE "' + table + '"(' + ','.join(columns) + ')')
                    connection.execute('INSERT INTO "' + table + '" VALUES(' + ','.join('?' for _ in columns) + ')', list(rows[0].values()))
            self.connections[self.config[role]['database']['id']] = connection
            self.addCleanup(connection.close)
        self.api = SimpleNamespace(query=lambda database, sql: [dict(row) for row in self.connections[database].execute(sql).fetchall()])
        self.version = {'need_initialization': True, 'current_db_version': None, 'code_db_version': 'v0.0.9'}
        self.runtime = SimpleNamespace(request=lambda *args, **kwargs: (self.version, {}))
        self.store = SimpleNamespace(list=lambda bucket: [])
        self.material = SimpleNamespace(workers={'email': {'PASSWORDS': json.dumps(['site']), 'ADMIN_PASSWORDS': json.dumps(['admin'])}})

    def check(self):
        return pristine(self.config, self.material, self.api, self.runtime, self.store)

    def test_empty_schema_with_only_migration_history_has_a_stable_witness(self):
        self.assertEqual(self.check(), database_witness(self.config, self.api))

    def test_all_tables_are_checked_without_compound_select_terms(self):
        for database in self.connections.values():
            database.execute('CREATE TABLE additional_business(id TEXT)')
            for index in range(40): database.execute('CREATE TABLE business_' + str(index) + '(id TEXT)')
            database.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 3)
            database.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 32)
        self.check()
        self.connections[self.config['platform']['database']['id']].execute("INSERT INTO additional_business VALUES('existing')")
        with self.assertRaisesRegex(DeploymentError, ERROR): self.check()

    def test_any_existing_business_row_in_either_database_refuses_recovery(self):
        for role in ('email', 'platform'):
            database = self.connections[self.config[role]['database']['id']]
            database.execute("INSERT INTO users VALUES('existing-user')")
            with self.assertRaisesRegex(DeploymentError, ERROR): self.check()
            database.execute('DELETE FROM users')

    def test_only_exact_d1_protected_tables_are_excluded_not_custom_cf_named_tables(self):
        database = self.connections[self.config['email']['database']['id']]
        database.executescript("CREATE TABLE _cf_METADATA(value TEXT); INSERT INTO _cf_METADATA VALUES('internal');")
        self.check()
        database.executescript("CREATE TABLE _cf_business(value TEXT); INSERT INTO _cf_business VALUES('user-data');")
        with self.assertRaisesRegex(DeploymentError, ERROR): self.check()

    def test_deleted_address_high_watermark_still_refuses_a_previously_used_instance(self):
        database = self.connections[self.config['email']['database']['id']]
        database.executescript('INSERT INTO address DEFAULT VALUES; DELETE FROM address;')
        with self.assertRaisesRegex(DeploymentError, ERROR): self.check()

    def test_initialized_or_uncertain_email_version_is_not_replayed(self):
        for version in ({}, {'need_initialization': False}, {**self.version, 'current_db_version': 'v0.0.9'}):
            self.version = version
            with self.assertRaisesRegex(DeploymentError, ERROR): self.check()

    def test_objects_in_either_bucket_are_not_ignored_even_in_private_namespace(self):
        for selected in ('INBOX', 'OUTBOX'):
            self.store.list = lambda bucket: [{'key': '_easyemail-sba/retained'}] if bucket == selected else []
            with self.assertRaisesRegex(DeploymentError, ERROR): self.check()

    def test_schema_and_migration_metadata_are_part_of_the_preservation_witness(self):
        before = self.check()
        database = self.connections[self.config['platform']['database']['id']]
        database.execute("UPDATE d1_migrations SET name='changed.sql'")
        self.assertNotEqual(before, database_witness(self.config, self.api))

    def test_migration_seed_rows_must_remain_exact_not_just_have_the_same_count(self):
        database = self.connections[self.config['platform']['database']['id']]
        for table, column in [('agent_inbox_cleanup_state', 'cursor'), ('normal_inbox_cleanup_state', 'cursor'),
                              ('outbox_cleanup_state', 'cursor'), ('retention_policy', 'revision')]:
            database.execute('SAVEPOINT seed')
            database.execute('UPDATE "' + table + '" SET ' + column + '=?', ['changed'])
            with self.assertRaisesRegex(DeploymentError, ERROR): self.check()
            database.execute('ROLLBACK TO seed'); database.execute('RELEASE seed')
        database.execute('DELETE FROM outbox_cleanup_state')
        with self.assertRaisesRegex(DeploymentError, ERROR): self.check()


if __name__ == '__main__':
    unittest.main()
