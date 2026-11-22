"""Check D1/R2 reference coherence and rebind only the identities changed by an R2 copy."""
import sqlite3
from pathlib import Path

from boundary import DeploymentError, require
from d1_snapshot import open_snapshot, row_hashes, sql_name, INTERNAL_FILTER
from d1_restore import write_restore_sql


ERROR = 'EASYEMAIL_SNAPSHOT_OBJECT_REFERENCE_INVALID'


def verify_links(path, objects):
    lookup = {(row['bucket'], row['source']['key']): row for row in objects}
    require(len(lookup) == len(objects), ERROR)
    database = open_snapshot(path)
    database.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        require({'outbox_assets', 'normal_inbox_messages', 'agent_incoming_messages'} <= tables, ERROR)
        def check(bucket, key, size, checksum):
            value = lookup.get((bucket, key))
            require(value is not None and value['source']['size'] == size and value['sha256'] == checksum, ERROR)
            return value['source']
        for row in database.execute("SELECT * FROM outbox_assets WHERE state='ready'"):
            source = check('OUTBOX', row['object_key'], row['size'], row['sha256'])
            require((row['object_version'] is None or row['object_version'] == source['version'])
                    and (row['object_etag'] is None or row['object_etag'] == source['etag']), ERROR)
        for table in ('normal_inbox_messages', 'agent_incoming_messages'):
            for row in database.execute('SELECT * FROM ' + sql_name(table) + ' WHERE purged_at IS NULL'):
                for prefix in ('raw', 'content'):
                    check('INBOX', row[prefix + '_key'], row[prefix + '_bytes'], row[prefix + '_sha256'])
    except sqlite3.Error:
        raise DeploymentError(ERROR) from None
    finally:
        database.close()


def rebind_outbox(path, copies, output):
    """Prepare a new SQL restore file; never modify the source export or an existing database."""
    verify_links(path, copies)
    database = open_snapshot(path)
    try:
        schema = database.execute(f'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE {INTERNAL_FILTER} ORDER BY type,name').fetchall()
        unchanged = {}
        for kind, table, _, _ in schema:
            if kind != 'table': continue
            columns = [row[1] for row in database.execute('PRAGMA table_info(' + sql_name(table) + ')')]
            if table == 'outbox_assets': columns = [column for column in columns if column not in ('object_version', 'object_etag')]
            unchanged[table] = (columns, row_hashes(database, table, columns))
        for row in copies:
            if row['bucket'] != 'OUTBOX': continue
            source, target = row['source'], row['target']
            require(source['key'] == target['key'] and source['size'] == target['size'], ERROR)
            database.execute('UPDATE outbox_assets SET object_version=?,object_etag=? WHERE object_key=?',
                             (target['version'], target['etag'], source['key']))
        for table, (columns, rows) in unchanged.items():
            require(rows == row_hashes(database, table, columns), 'EASYEMAIL_SNAPSHOT_REBIND_CHANGED_DATA')
        require(database.execute(f'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE {INTERNAL_FILTER} ORDER BY type,name').fetchall() == schema,
                'EASYEMAIL_SNAPSHOT_REBIND_CHANGED_DATA')
        write_restore_sql(database, output)
    except sqlite3.Error:
        raise DeploymentError('EASYEMAIL_SNAPSHOT_REBIND_FAILED') from None
    finally:
        database.close()
    verify_links(Path(output), [{**row, 'source': row['target']} for row in copies])
