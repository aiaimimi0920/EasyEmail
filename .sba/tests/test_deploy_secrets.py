import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deployment_secrets import deployment_secrets
from boundary import DeploymentError
from fixtures import configuration


def secret_environment():
    return {'CLOUDFLARE_API_TOKEN': 'synthetic-cloud-token-for-local-tests', 'EE_MASTER_KEY': 'a3' * 32,
            'EE_REGISTRATION_TOKEN': 'synthetic-invitation-32-bytes-minimum',
            'EE_ADMIN_PASSWORD': 'Synthetic-admin-password-735296', 'EE_PROVIDER_SECRETS': '{}'}


class DeploymentSecretsTests(unittest.TestCase):
    def test_stable_instance_scoped_secrets_and_self_provider_wiring(self):
        config, env = configuration(), secret_environment()
        material = deployment_secrets(config, env)
        self.assertEqual(material, deployment_secrets(config, env))
        ring = json.loads(material.workers['platform']['MAILBOX_KEYRING'])
        self.assertRegex(ring['keys'][ring['active']], r'^[a-f0-9]{64}$')
        control = material.workers['platform']['EASYEMAIL_SBA_CONTROL_SECRET']
        self.assertRegex(control, r'^[a-f0-9]{64}$')
        self.assertNotEqual(control, ring['keys'][ring['active']])
        self.assertRegex(material.archive_key, r'^[a-f0-9]{64}$')
        self.assertNotIn(material.archive_key, repr(material))
        self.assertNotIn(material.archive_key, repr(material.workers))
        self.assertNotIn(material.archive_key, (control, ring['keys'][ring['active']]))
        provider = json.loads(material.workers['platform']['PROVIDER_SECRETS'])['self']
        self.assertEqual(provider['apiKey'], json.loads(material.workers['email']['ADMIN_PASSWORDS'])[0])
        self.assertEqual(provider['sitePassword'], json.loads(material.workers['email']['PASSWORDS'])[0])
        self.assertNotEqual(provider['apiKey'], provider['sitePassword'])
        self.assertNotIn(env['EE_ADMIN_PASSWORD'], repr(material.workers))
        config['settings']['adminUsername'] = 'other-admin'
        self.assertEqual(material.workers, deployment_secrets(config, env).workers)
        self.assertEqual(material.archive_key, deployment_secrets(config, env).archive_key)
        config['platform']['database']['id'] = '33333333-3333-3333-3333-333333333333'
        self.assertNotEqual(material.workers, deployment_secrets(config, env).workers)
        self.assertNotEqual(material.archive_key, deployment_secrets(config, env).archive_key)

    def test_invalid_or_placeholder_values_do_not_enter_deployment(self):
        for key, value in [('EE_MASTER_KEY', 'bad'), ('EE_ADMIN_PASSWORD', 'too-short'),
                           ('EE_REGISTRATION_TOKEN', 'short'), ('CLOUDFLARE_API_TOKEN', 'verification-not-applicable'),
                           ('EE_PROVIDER_SECRETS', '{"self":{"apiKey":"synthetic"}}')]:
            with self.subTest(key=key), self.assertRaises(DeploymentError):
                deployment_secrets(configuration(), {**secret_environment(), key: value})

    def test_external_secrets_match_declared_non_anonymous_providers(self):
        config, env = configuration(), secret_environment()
        config['settings']['providers'] = [{'id': 'other', 'type': 'temporam'}]
        with self.assertRaises(DeploymentError):
            deployment_secrets(config, env)
        env['EE_PROVIDER_SECRETS'] = '{"other":{"apiKey":"synthetic-external-api-key"}}'
        self.assertIn('other', json.loads(deployment_secrets(config, env).workers['platform']['PROVIDER_SECRETS']))
        env['EE_PROVIDER_SECRETS'] = '{"other":{"apiKey":"one","apiKey":"two"}}'
        with self.assertRaises(DeploymentError):
            deployment_secrets(config, env)


if __name__ == '__main__':
    unittest.main()
