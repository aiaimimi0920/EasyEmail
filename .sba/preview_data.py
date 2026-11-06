"""Prepare a separate restore SQL file with explicit copy-only authentication/configuration changes."""
import sqlite3
import time

from boundary import DeploymentError, require
from d1_snapshot import INTERNAL_FILTER, open_snapshot, row_hashes, sequences, sql_name, witness
from d1_restore import write_restore_sql
from preview_credentials import rewrite_self


ERROR = 'EASYEMAIL_PREVIEW_DATA_INVALID'
CHANGED_COLUMNS = {'mailboxes': {'credential_cipher'}, 'provider_overrides': {'config_json', 'secret_source', 'secret_cipher'},
                   'sessions': {'revoked_at'}, 'api_keys': {'revoked_at'}}


def prepare_preview_database(path, source, target, original, copied, output, *, now=None, rewriter=rewrite_self):
    now = int(time.time()) if now is None else now
    require(type(now) is int and 0 < now <= 9007199254740991, ERROR)
    database = open_snapshot(path); database.row_factory = sqlite3.Row
    try:
        schema_query = f'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE {INTERNAL_FILTER} ORDER BY type,name'
        schema = [tuple(row) for row in database.execute(schema_query)]
        tables = {row[1] for row in schema if row[0] == 'table'}
        require(set(CHANGED_COLUMNS) <= tables, ERROR)
        protected = {}
        for table in tables:
            columns = [row[1] for row in database.execute('PRAGMA table_info(' + sql_name(table) + ')')
                       if row[1] not in CHANGED_COLUMNS.get(table, set())]
            protected[table] = (columns, row_hashes(database, table, columns))
        allocators = sequences(database)
        other_ciphers = row_hashes(database, 'mailboxes', ['id', 'credential_cipher'], " WHERE provider_id IS NOT 'self'")
        rows = [dict(row) for row in database.execute("SELECT id,user_id,provider_id,remote_id,address,credential_cipher FROM mailboxes WHERE provider_id='self' AND credential_cipher IS NOT NULL ORDER BY id")]
        providers = [dict(row) for row in database.execute('SELECT id,config_json FROM provider_overrides ORDER BY id')]
        rewritten = rewriter(rows, providers, source, target, original, copied)
        require(isinstance(rewritten, dict) and set(rewritten) == {'mailboxes', 'providers'}, ERROR)
        for key, before, fields in [('mailboxes', rows, {'id', 'cipher'}), ('providers', providers, {'id', 'config_json'})]:
            items = rewritten[key]
            require(isinstance(items, list) and len(items) == len(before)
                    and all(isinstance(row, dict) and set(row) == fields and all(isinstance(value, str) and value for value in row.values()) for row in items)
                    and {row['id'] for row in items} == {row['id'] for row in before}, ERROR)
        for row in rewritten['mailboxes']:
            database.execute("UPDATE mailboxes SET credential_cipher=? WHERE id=? AND provider_id='self'", (row['cipher'], row['id']))
        for row in rewritten['providers']:
            database.execute('UPDATE provider_overrides SET config_json=?,secret_source=?,secret_cipher=NULL WHERE id=?',
                             (row['config_json'], 'environment' if row['id'] == 'self' else 'none', row['id']))
        for table in ('sessions', 'api_keys'):
            database.execute('UPDATE ' + sql_name(table) + ' SET revoked_at=? WHERE revoked_at IS NULL', (now,))
        for table, (columns, before) in protected.items():
            require(row_hashes(database, table, columns) == before, ERROR)
        require(other_ciphers == row_hashes(database, 'mailboxes', ['id', 'credential_cipher'], " WHERE provider_id IS NOT 'self'")
                and sequences(database) == allocators and [tuple(row) for row in database.execute(schema_query)] == schema, ERROR)
        write_restore_sql(database, output)
    except sqlite3.Error:
        raise DeploymentError(ERROR) from None
    finally: database.close()
    return {'path': output, 'witness': witness(output), 'selfCredentials': len(rows), 'providerOverrides': len(providers)}
