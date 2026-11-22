"""Native D1 SQL export and offline, typed multiset preservation witnesses."""
import hashlib
import os
import re
import sqlite3
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse

from boundary import DeploymentError, digest, require


MAX_SQL = 67108864
INTERNAL_FILTER = "name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'"


def sql_name(value):
    require(isinstance(value, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', value), 'EASYEMAIL_SNAPSHOT_SCHEMA_UNSUPPORTED')
    return '"' + value + '"'


def open_snapshot(path):
    raw = Path(path).read_bytes()
    require(0 < len(raw) <= MAX_SQL and not raw.startswith(b'\xef\xbb\xbf'), 'EASYEMAIL_SNAPSHOT_SQL_INVALID')
    database = sqlite3.connect(':memory:')
    database.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_SQL)
    def authorize(operation, first, second, *_):
        if operation in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH): return sqlite3.SQLITE_DENY
        if operation == sqlite3.SQLITE_FUNCTION and second in ('load_extension', 'readfile', 'writefile'): return sqlite3.SQLITE_DENY
        if operation == sqlite3.SQLITE_PRAGMA and first not in ('foreign_keys', 'defer_foreign_keys', 'foreign_key_check', 'quick_check', 'table_info'):
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    database.set_authorizer(authorize)
    steps = 0
    def bounded():
        nonlocal steps
        steps += 1
        return int(steps > 100000)
    database.set_progress_handler(bounded, 1000)
    try:
        database.executescript(raw.decode('utf8'))
        require(database.execute('PRAGMA foreign_key_check').fetchall() == []
                and database.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'EASYEMAIL_SNAPSHOT_INTEGRITY_FAILED')
        return database
    except Exception as error:
        database.close()
        if isinstance(error, DeploymentError): raise
        raise DeploymentError('EASYEMAIL_SNAPSHOT_SQL_INVALID') from None


def row_hashes(database, table, columns, where='', parameters=()):
    # The predicate is application-owned SQL, never supplied by a deployment request or archive.
    cursor = database.execute('SELECT ' + ','.join(map(sql_name, columns)) + ' FROM ' + sql_name(table) + where, parameters)
    rows = Counter(); count = 0
    for row in cursor:
        count += 1; require(count <= 100000, 'EASYEMAIL_SNAPSHOT_TOO_LARGE')
        # CAST(real AS TEXT) rounds distinct stored doubles to the same display value.
        typed = []
        for value in row:
            if value is None: typed.append(['null', None])
            elif isinstance(value, bytes): typed.append(['blob', value.hex()])
            elif isinstance(value, float): typed.append(['real', value.hex()])
            elif isinstance(value, int): typed.append(['integer', str(value)])
            else: typed.append(['text', value])
        rows[digest(typed)] += 1
    return dict(sorted(rows.items()))


def witness_database(database):
    schema = [tuple(row) for row in database.execute(f'SELECT type,name,tbl_name,sql FROM sqlite_master WHERE {INTERNAL_FILTER} ORDER BY type,name')]
    tables = [row[1] for row in schema if row[0] == 'table']
    require(len(tables) <= 256, 'EASYEMAIL_SNAPSHOT_TOO_LARGE')
    value = {}
    for table in tables:
        columns = [row[1] for row in database.execute('PRAGMA table_info(' + sql_name(table) + ')')]
        require(columns, 'EASYEMAIL_SNAPSHOT_SCHEMA_UNSUPPORTED')
        value[table] = {'columns': columns, 'rows': row_hashes(database, table, columns)}
    return {'schemaDigest': digest(schema), 'tables': value, 'sequences': sequences(database)}


def witness(path):
    database = open_snapshot(path)
    try:
        return witness_database(database)
    except sqlite3.Error:
        raise DeploymentError('EASYEMAIL_SNAPSHOT_SQL_INVALID') from None
    finally:
        database.close()


def prove_preserved(before, path, exact=False):
    database = open_snapshot(path)
    try:
        if exact:
            require(witness(path) == before, 'EASYEMAIL_SOURCE_DATABASE_CHANGED')
            return
        current_sequences = sequences(database)
        require(all(name in current_sequences and current_sequences[name] >= value for name, value in before['sequences'].items()),
                'EASYEMAIL_DATABASE_ALLOCATOR_NOT_PRESERVED')
        tables = {row[0] for row in database.execute(f"SELECT name FROM sqlite_master WHERE type='table' AND {INTERNAL_FILTER}")}
        for table, entry in before['tables'].items():
            require(table in tables, 'EASYEMAIL_DATABASE_ROWS_NOT_PRESERVED')
            columns = {row[1] for row in database.execute('PRAGMA table_info(' + sql_name(table) + ')')}
            require(set(entry['columns']) <= columns, 'EASYEMAIL_DATABASE_ROWS_NOT_PRESERVED')
            after = row_hashes(database, table, entry['columns'])
            require(not Counter(entry['rows']) - Counter(after), 'EASYEMAIL_DATABASE_ROWS_NOT_PRESERVED')
    except sqlite3.Error:
        raise DeploymentError('EASYEMAIL_SNAPSHOT_SQL_INVALID') from None
    finally:
        database.close()


def sequences(database):
    if database.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").fetchone() is None: return {}
    rows = database.execute("SELECT name,seq FROM sqlite_sequence WHERE name NOT GLOB '_cf_*' ORDER BY name").fetchall()
    require(len(rows) <= 256 and len({row[0] for row in rows}) == len(rows)
            and all(isinstance(name, str) and type(value) is int and 0 <= value <= 9223372036854775807 for name, value in rows),
            'EASYEMAIL_SNAPSHOT_ALLOCATOR_INVALID')
    return dict(rows)


def live_sequences(api, database):
    exists = api.query(database, "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
    if exists == []: return {}
    require(exists == [{'present': 1}], 'EASYEMAIL_SNAPSHOT_ALLOCATOR_INVALID')
    rows = api.query(database, "SELECT name,seq FROM sqlite_sequence WHERE name NOT GLOB '_cf_*' ORDER BY name")
    require(len(rows) <= 256 and all(isinstance(row, dict) and set(row) == {'name', 'seq'}
            and isinstance(row['name'], str) and type(row['seq']) is int and 0 <= row['seq'] <= 9223372036854775807 for row in rows)
            and len({row['name'] for row in rows}) == len(rows), 'EASYEMAIL_SNAPSHOT_ALLOCATOR_INVALID')
    return {row['name']: row['seq'] for row in rows}


def export_database(api, database, role, directory, pause=time.sleep, *, phase='backup'):
    require(phase in ('backup', 'postupdate', 'sourcecheck', 'sourcefinal', 'repaircheck', 'repairready') and role in ('email', 'platform')
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', database),
            'EASYEMAIL_SNAPSHOT_SOURCE_INVALID')
    deadline = time.monotonic() + 180; bookmark = None
    allocators = live_sequences(api, database)
    for attempt in range(120):
        require(time.monotonic() < deadline, 'EASYEMAIL_SNAPSHOT_EXPORT_TIMEOUT')
        payload = {'output_format': 'polling', 'dump_options': {'compatibility': 'd1', 'no_schema': False, 'no_data': False, 'tables': []}}
        if bookmark is not None: payload['current_bookmark'] = bookmark
        value = api.request('POST', '/d1/database/' + database + '/export', payload, write=f'{phase}-{role}-export-{attempt}')['result']
        require(isinstance(value, dict) and value.get('success') is True and value.get('type') == 'export', 'EASYEMAIL_SNAPSHOT_EXPORT_INVALID')
        if value.get('status') == 'complete':
            require(bookmark is None or value.get('at_bookmark', bookmark) == bookmark, 'EASYEMAIL_SNAPSHOT_EXPORT_INVALID')
            result = value.get('result'); require(isinstance(result, dict), 'EASYEMAIL_SNAPSHOT_EXPORT_INVALID')
            url = result.get('signed_url'); require(isinstance(url, str), 'EASYEMAIL_SNAPSHOT_EXPORT_INVALID')
            path = Path(directory) / (role + '.sql')
            try:
                parsed = urlparse(url)
                require(parsed.scheme == 'https' and parsed.hostname and parsed.hostname.endswith('.cloudflarestorage.com')
                        and not parsed.username and not parsed.password and parsed.port in (None, 443) and not parsed.fragment,
                        'EASYEMAIL_SNAPSHOT_DOWNLOAD_INVALID')
                # No cloud Authorization header is forwarded to this short-lived, API-issued download URL.
                with api.transport.opener.open(urllib.request.Request(url, method='GET'), timeout=60) as response:
                    require(response.status == 200, 'EASYEMAIL_SNAPSHOT_DOWNLOAD_INVALID')
                    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
                        size = 0; hashed = hashlib.sha256()
                        while True:
                            require(time.monotonic() < deadline, 'EASYEMAIL_SNAPSHOT_EXPORT_TIMEOUT')
                            block = response.read(65536)
                            if not block: break
                            size += len(block); require(size <= MAX_SQL, 'EASYEMAIL_SNAPSHOT_TOO_LARGE')
                            hashed.update(block); output.write(block)
                        output.flush(); os.fsync(output.fileno())
                measured = witness(path)
                require(measured['sequences'] == allocators == live_sequences(api, database), 'EASYEMAIL_SNAPSHOT_ALLOCATOR_NOT_EXPORTED')
                return {'path': path, 'sha256': hashed.hexdigest(), 'bytes': size, 'witness': measured,
                        'bookmark': value.get('at_bookmark', bookmark)}
            except DeploymentError:
                raise
            except (OSError, ValueError, UnicodeError, urllib.error.URLError):
                raise DeploymentError('EASYEMAIL_SNAPSHOT_DOWNLOAD_INVALID') from None
        require(value.get('status') == 'active' and isinstance(value.get('at_bookmark'), str) and 1 <= len(value['at_bookmark']) <= 256
                and (bookmark is None or value['at_bookmark'] == bookmark), 'EASYEMAIL_SNAPSHOT_EXPORT_INVALID')
        bookmark = value['at_bookmark']; pause(1)
    raise DeploymentError('EASYEMAIL_SNAPSHOT_EXPORT_TIMEOUT')
