"""Restore into empty copy resources, rebind object identities, and prepare copy-only authority."""
import copy
import json
from functools import partial
from pathlib import Path

from boundary import require
from d1_restore import write_restore_sql
from d1_snapshot import open_snapshot
from preview_data import prepare_preview_database
from preview_credentials import rewrite_self
from snapshot_lifecycle import restore_objects


def verify_preview_policy(release, config):
    proof = json.loads((Path(release) / 'sba-release.json').read_text(encoding='utf8'))
    require(proof.get('previewPolicy') == {'emailOrigin': config['email']['origin'], 'fetchRedirects': 'manual-reject',
            'sockets': False, 'websockets': False, 'inboundEmail': False, 'scheduled': False}, 'EASYEMAIL_PREVIEW_POLICY_MISMATCH')


def prepare_copy(backup, store, source, target, original, copied, *, application_root):
    restored = restore_objects(store, backup['manifest'], Path(backup['directory']))
    return prepare_restored_copy(backup, restored, source, target, original, copied, application_root=application_root)


def prepare_restored_copy(backup, restored, source, target, original, copied, *, application_root):
    directory = Path(backup['directory'])
    email_sql = directory / 'email-restore.sql'
    database = open_snapshot(restored['emailSql'])
    try: write_restore_sql(database, email_sql)
    finally: database.close()
    prepared = prepare_preview_database(restored['platformSql'], source, target, original, copied, directory / 'platform-preview.sql',
                                       rewriter=partial(rewrite_self, application_root=application_root))
    manifest = copy.deepcopy(backup['manifest'])
    manifest['databases']['platform']['witness'] = prepared['witness']
    manifest['objects'] = [{**row, 'source': row['target']} for row in restored['copies']]
    return {'emailSql': email_sql, 'platformSql': prepared['path'], 'backup': {**backup, 'manifest': manifest}}
