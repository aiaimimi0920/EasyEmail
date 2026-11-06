"""Read-only proof for a published, schema-ready instance that has never held business data."""
import re

from boundary import require
from configuration import isolated
from runtime_acceptance import email_headers


ERROR = 'EASYEMAIL_BOOTSTRAP_REPAIR_NOT_PRISTINE'
INITIAL_ROWS = {
    'agent_inbox_cleanup_state': [{'id': 1, 'cursor': None}],
    'normal_inbox_cleanup_state': [{'id': 1, 'cursor': None}],
    'outbox_cleanup_state': [{'id': 'inventory', 'cursor': None}],
    'retention_policy': [{'id': 1, 'enabled': 0, 'mailbox_days': 0, 'cache_days': 0, 'trash_days': 0,
                          'outgoing_days': 0, 'audit_days': 0, 'revision': 0, 'change_token': None,
                          'updated_at': None, 'actor_id': None}],
}


def database_witness(config, api):
    result = {}
    for role in ('email', 'platform'):
        database = config[role]['database']['id']
        # D1 owns these two protected metadata tables; do not treat arbitrary _cf_* names as internal.
        schema = api.query(database, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT IN ('_cf_KV','_cf_METADATA') ORDER BY type,name")
        require(schema and all(isinstance(row.get('name'), str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', row['name'])
                               for row in schema), ERROR)
        migrations = api.query(database, 'SELECT * FROM d1_migrations ORDER BY name') if role == 'platform' else None
        seeds = {table: api.query(database, 'SELECT * FROM "' + table + '"') for table in INITIAL_ROWS} if role == 'platform' else None
        result[role] = {'schema': schema, 'migrations': migrations, 'seeds': seeds}
    return result


def empty_objects(store):
    require(all(store.list(bucket) == [] for bucket in ('INBOX', 'OUTBOX')), ERROR)


def pristine(config, material, api, runtime, store):
    require(isolated(config) and config['routing'] is None, ERROR)
    version, _ = runtime.request('email', '/admin/db_version', headers=email_headers(material))
    require(isinstance(version, dict) and version.get('need_initialization') is True
            and version.get('current_db_version') is None and isinstance(version.get('code_db_version'), str), ERROR)
    witness = database_witness(config, api)
    for role, selected in witness.items():
        database = config[role]['database']['id']
        require(selected['seeds'] == (INITIAL_ROWS if role == 'platform' else None), ERROR)
        tables = [row['name'] for row in selected['schema'] if row['type'] == 'table' and not row['name'].startswith('sqlite_')
                  and not (role == 'platform' and row['name'] in {'d1_migrations', *INITIAL_ROWS})]
        require(tables, ERROR)
        # Bound result columns as well as compound terms under D1's stricter SQLite limits.
        for offset in range(0, len(tables), 32):
            batch = tables[offset:offset + 32]
            counts = 'SELECT ' + ','.join('(SELECT COUNT(*) FROM "' + table + '") AS "' + table + '"' for table in batch)
            require(api.query(database, counts) == [{table: 0 for table in batch}], ERROR)
        if any(row['name'] == 'sqlite_sequence' for row in selected['schema']):
            require(api.query(database, "SELECT name,seq FROM sqlite_sequence WHERE name!='d1_migrations' AND seq!=0") == [], ERROR)
    empty_objects(store)
    return witness
