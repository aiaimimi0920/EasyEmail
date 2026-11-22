"""D1 import SQL verified under statement autocommit, with constraints enabled and triggers installed last."""
import math
import os
import sqlite3

from boundary import DeploymentError, require
from d1_snapshot import INTERNAL_FILTER, MAX_SQL, sequences, sql_name, witness, witness_database


def literal(value):
    if value is None: return 'NULL'
    if isinstance(value, bytes): return "X'" + value.hex() + "'"
    if isinstance(value, str): return "CAST(X'" + value.encode('utf8').hex() + "' AS TEXT)"
    if isinstance(value, int): return str(value)
    require(isinstance(value, float), 'EASYEMAIL_RESTORE_VALUE_INVALID')
    return repr(value) if math.isfinite(value) else ('-9.0e999' if value < 0 else '9.0e999')


def write_restore_sql(database, output):
    before = witness_database(database)
    schema = database.execute(f'SELECT type,name,sql FROM sqlite_master WHERE {INTERNAL_FILTER} AND sql IS NOT NULL ORDER BY type,name').fetchall()
    tables = [row for row in schema if row[0] == 'table']
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as file:
        total = 0
        def write(sql):
            nonlocal total
            body = (sql + ';\n').encode('utf8'); total += len(body)
            require(total <= MAX_SQL, 'EASYEMAIL_RESTORE_SQL_TOO_LARGE'); file.write(body)
        # /import does not provide the single transaction used by /query or a local D1 batch.
        staging = sqlite3.connect(':memory:', isolation_level=None)
        staging.execute('PRAGMA foreign_keys=ON')
        def checked(sql):
            staging.execute(sql); write(sql)
        def insert(sql):
            try: staging.execute(sql)
            except sqlite3.IntegrityError as error:
                if error.sqlite_errorcode == sqlite3.SQLITE_CONSTRAINT_FOREIGNKEY: return False
                raise
            write(sql); return True
        try:
            for _, _, sql in tables: checked(sql)
            # Referenced composite keys may depend on explicit UNIQUE indexes.
            for kind, _, sql in schema:
                if kind == 'index': checked(sql)
            pending = []; pending_bytes = 0
            for _, table, _ in tables:
                columns = [row[1] for row in database.execute('PRAGMA table_info(' + sql_name(table) + ')')]
                names = ','.join(map(sql_name, columns))
                for row in database.execute('SELECT ' + names + ' FROM ' + sql_name(table)):
                    sql = 'INSERT INTO ' + sql_name(table) + '(' + names + ') VALUES(' + ','.join(map(literal, row)) + ')'
                    if not insert(sql):
                        pending.append(sql); pending_bytes += len(sql.encode('utf8')) + 2
                        require(total + pending_bytes <= MAX_SQL, 'EASYEMAIL_RESTORE_SQL_TOO_LARGE')
            # Only FK-blocked inserts are deferred locally. Each pass must make progress; no cloud retries.
            while pending:
                remaining = [sql for sql in pending if not insert(sql)]
                require(len(remaining) < len(pending), 'EASYEMAIL_RESTORE_DEPENDENCY_CYCLE')
                pending = remaining
            allocators = sequences(database)
            if database.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() is not None:
                checked("DELETE FROM sqlite_sequence WHERE name NOT GLOB '_cf_*'")
                for name, seq in allocators.items(): checked('INSERT INTO sqlite_sequence(name,seq) VALUES(' + literal(name) + ',' + str(seq) + ')')
            for kind, _, sql in schema:
                if kind not in ('table', 'index'): checked(sql)
            require(staging.execute('PRAGMA foreign_key_check').fetchall() == []
                    and witness_database(staging) == before, 'EASYEMAIL_RESTORE_CONTENT_CHANGED')
        except sqlite3.Error:
            raise DeploymentError('EASYEMAIL_RESTORE_SQL_INVALID') from None
        finally: staging.close()
        file.flush(); os.fsync(file.fileno())
    require(witness(output) == before == witness_database(database), 'EASYEMAIL_RESTORE_CONTENT_CHANGED')
