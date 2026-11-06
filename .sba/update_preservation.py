"""Upgrade preservation policy: all old business cells, plus independently checked version metadata."""
import copy
from pathlib import Path

from boundary import digest, require
from d1_snapshot import export_database, open_snapshot, prove_preserved, row_hashes
from object_snapshot import business_inventory
from snapshot_bundle import private_directory


def prove_update_preserved(backup, api, store, config, directory, *, exporter=export_database):
    directory = private_directory(directory)
    manifest, original = backup['manifest'], Path(backup['directory'])
    for role in ('email', 'platform'):
        before = copy.deepcopy(manifest['databases'][role]['witness'])
        if role == 'email':
            database = open_snapshot(original / 'email.sql')
            try:
                require('settings' in before['tables'] and 'key' in before['tables']['settings']['columns'], 'EASYEMAIL_EMAIL_VERSION_MISMATCH')
                entry = before['tables']['settings']
                # Only db_version is migration metadata; all other settings and their full old cells remain protected.
                entry['rows'] = row_hashes(database, 'settings', entry['columns'], ' WHERE key IS NOT ?', ('db_version',))
            finally: database.close()
        current = exporter(api, config[role]['database']['id'], role, directory, phase='postupdate')
        prove_preserved(before, current['path'])
    inventory = {bucket: sorted([row['source'] for row in manifest['objects'] if row['bucket'] == bucket], key=lambda row: row['key'])
                 for bucket in ('INBOX', 'OUTBOX')}
    require(digest(business_inventory(store)) == digest(inventory), 'EASYEMAIL_UPDATE_OBJECTS_NOT_PRESERVED')
    for row in manifest['objects']:
        require(store.get(row['bucket'], row['source']) == row['sha256'], 'EASYEMAIL_UPDATE_OBJECTS_NOT_PRESERVED')
    require(digest(business_inventory(store)) == digest(inventory), 'EASYEMAIL_UPDATE_OBJECTS_NOT_PRESERVED')
