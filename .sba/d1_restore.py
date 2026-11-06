"""D1 restore SQL: create tables/constraint indexes first, preserve typed cells, install triggers last."""
import math
import os

from boundary import require
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
        write('PRAGMA defer_foreign_keys=ON')
        for _, _, sql in tables: write(sql)
        # D1 checks FK definitions during INSERT; a referenced composite key may live in an explicit UNIQUE index.
        for kind, _, sql in schema:
            if kind == 'index': write(sql)
        for _, table, _ in tables:
            columns = [row[1] for row in database.execute('PRAGMA table_info(' + sql_name(table) + ')')]
            names = ','.join(map(sql_name, columns))
            for row in database.execute('SELECT ' + names + ' FROM ' + sql_name(table)):
                write('INSERT INTO ' + sql_name(table) + '(' + names + ') VALUES(' + ','.join(map(literal, row)) + ')')
        allocators = sequences(database)
        if database.execute("SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'").fetchone() is not None:
            write("DELETE FROM sqlite_sequence WHERE name NOT GLOB '_cf_*'")
            for name, seq in allocators.items(): write('INSERT INTO sqlite_sequence(name,seq) VALUES(' + literal(name) + ',' + str(seq) + ')')
        for kind, _, sql in schema:
            if kind not in ('table', 'index'): write(sql)
        file.flush(); os.fsync(file.fileno())
    require(witness(output) == before == witness_database(database), 'EASYEMAIL_RESTORE_CONTENT_CHANGED')
