import json
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from boundary import DeploymentError
from configuration import configuration, preview_configuration
from contract import validate_context
from d1_snapshot import open_snapshot, witness
from preview_credentials import preview_material
from preview_data import prepare_preview_database
from snapshot_fixtures import exported_sql
import test_contract
from test_deploy_secrets import secret_environment


class PreviewDataTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='pdata-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        request = test_contract.ContractTests().preview()
        self.source = request['context']['source']['configuration']; self.target = request['configuration']
        self.material = preview_material(self.source, self.target, secret_environment())
        self.sql = '''CREATE TABLE users(id TEXT PRIMARY KEY,password_hash TEXT); INSERT INTO users VALUES('u','keep-password');
CREATE TABLE sessions(token_hash TEXT,user_id TEXT,revoked_at INTEGER); INSERT INTO sessions VALUES('old-session','u',NULL),('revoked','u',17);
CREATE TABLE api_keys(id TEXT,revoked_at INTEGER); INSERT INTO api_keys VALUES('old-key',NULL);
CREATE TABLE mailboxes(id TEXT,user_id TEXT,provider_id TEXT,remote_id TEXT,address TEXT,credential_cipher TEXT);
INSERT INTO mailboxes VALUES('self-box','u','self','1','old@example.com','source-self'),('other','u','remote','2','other@example.com','source-other');
CREATE TABLE provider_overrides(id TEXT,config_json TEXT,secret_source TEXT,secret_cipher TEXT,revision INTEGER);
INSERT INTO provider_overrides VALUES('self','source-self-config','stored','old-self-secret',2),('remote','source-other-config','stored','old-remote-secret',7);
CREATE TABLE original(id INTEGER PRIMARY KEY AUTOINCREMENT,bytes BLOB); INSERT INTO original(bytes) VALUES(X'00FF');
UPDATE sqlite_sequence SET seq=51 WHERE name='original';'''
        self.path = exported_sql(self.root / 'source.sql', self.sql)['path']

    def rewrite(self, rows, overrides, source, target, source_material, target_material):
        self.assertEqual([row['id'] for row in rows], ['self-box'])
        return {'mailboxes': [{'id': 'self-box', 'cipher': 'target-self'}],
                'providers': [{'id': row['id'], 'config_json': 'target-' + row['id']} for row in overrides]}

    def prepare(self, **kwargs):
        output = self.root / 'preview.sql'
        result = prepare_preview_database(self.path, self.source, self.target, *self.material, output, now=123, rewriter=self.rewrite, **kwargs)
        return result, open_snapshot(output)

    def test_only_copy_authentication_and_provider_configuration_change_and_source_file_stays_untouched(self):
        before = self.path.read_bytes(); result, database = self.prepare()
        try:
            self.assertEqual(database.execute('SELECT * FROM users').fetchall(), [('u', 'keep-password')])
            self.assertEqual(database.execute('SELECT token_hash,revoked_at FROM sessions ORDER BY token_hash').fetchall(), [('old-session', 123), ('revoked', 17)])
            self.assertEqual(database.execute('SELECT revoked_at FROM api_keys').fetchall(), [(123,)])
            self.assertEqual(database.execute('SELECT credential_cipher FROM mailboxes ORDER BY id').fetchall(), [('source-other',), ('target-self',)])
            self.assertEqual(database.execute('SELECT secret_source,secret_cipher FROM provider_overrides ORDER BY id').fetchall(), [('none', None), ('environment', None)])
            self.assertEqual(database.execute('SELECT * FROM original').fetchall(), [(1, b'\x00\xff')])
            self.assertEqual(result['witness']['sequences'], {'original': 51})
            self.assertEqual(result['witness'], witness(self.root / 'preview.sql'))
        finally: database.close()
        self.assertEqual(self.path.read_bytes(), before)

    def test_preview_material_keeps_legacy_decryption_but_not_source_signing_admin_or_registration_authority(self):
        source, target = self.material
        old = json.loads(source.workers['platform']['MAILBOX_KEYRING']); new = json.loads(target.workers['platform']['MAILBOX_KEYRING'])
        self.assertNotEqual(new['active'], old['active']); self.assertNotEqual(new['keys'][new['active']], old['keys'][old['active']])
        self.assertEqual(new['keys'][old['active']], old['keys'][old['active']])
        for key in ('JWT_SECRET', 'PASSWORDS', 'ADMIN_PASSWORDS'): self.assertNotEqual(source.workers['email'][key], target.workers['email'][key])
        self.assertNotEqual(source.workers['platform']['REGISTRATION_TOKEN'], target.workers['platform']['REGISTRATION_TOKEN'])
        self.assertEqual(set(json.loads(target.workers['platform']['PROVIDER_SECRETS'])), {'self'})
        self.assertNotEqual(source.archive_key, target.archive_key)

    def test_external_environment_secrets_are_not_deployed_to_the_copy(self):
        self.source['settings']['providers'] = [{'id':'external','type':'temporam'}]
        env = {**secret_environment(), 'EE_PROVIDER_SECRETS':'{"external":{"apiKey":"synthetic-source-secret"}}'}
        source, target = preview_material(self.source, self.target, env)
        self.assertIn('synthetic-source-secret', source.workers['platform']['PROVIDER_SECRETS'])
        self.assertNotIn('synthetic-source-secret', json.dumps(target.workers))

    def test_identical_database_identity_or_unexpected_rewriter_output_is_rejected_before_dump(self):
        with self.assertRaises(DeploymentError): preview_material(self.source, self.source, secret_environment())
        def wrong(*args): return {'mailboxes':[{'id':'other','cipher':'changed'}], 'providers':[]}
        with self.assertRaisesRegex(DeploymentError, 'EASYEMAIL_PREVIEW_DATA_INVALID'):
            prepare_preview_database(self.path, self.source, self.target, *self.material, self.root / 'bad.sql', now=123, rewriter=wrong)
        self.assertFalse((self.root / 'bad.sql').exists())

    def test_springbok_inherited_public_settings_are_recorded_but_not_enabled_in_copy_runtime(self):
        selected = test_contract.ContractTests().preview()
        settings = selected['context']['source']['configuration']['settings']
        settings['providers'] = [{'id': 'external', 'type': 'temporam'}]
        settings['providerOrigins'] = ['https://external.example.com']; settings['sendRecipients'] = ['receiver@example.com']
        selected['configuration']['settings'] = copy.deepcopy(settings)
        validate_context(selected)
        before = copy.deepcopy(selected['configuration'])
        with self.assertRaises(DeploymentError): configuration(before)
        projected = preview_configuration(before)
        self.assertEqual(selected['configuration'], before)
        for field in ('providers', 'sendRecipients', 'providerOrigins', 'imapEndpoints', 'smtpEndpoints'):
            self.assertEqual(projected['settings'][field], [])
        env = {**secret_environment(), 'EE_PROVIDER_SECRETS': '{"external":{"apiKey":"synthetic-source-secret"}}'}
        original, copied = preview_material(selected['context']['source']['configuration'], before, env)
        self.assertNotIn('synthetic-source-secret', json.dumps(copied.workers))
        selected['configuration']['settings']['providers'] = []
        with self.assertRaises(DeploymentError): validate_context(selected)


if __name__ == '__main__': unittest.main()
