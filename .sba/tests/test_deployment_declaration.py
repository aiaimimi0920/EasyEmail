"""The ordinary SpringBok form must support isolated and real mail identities."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from configuration import configuration
from fixtures import configuration as fixture


class DeploymentDeclarationTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1]
        self.declaration = json.loads((root / 'deployment.json').read_text(encoding='utf8'))
        self.mail_field = next(field for field in self.declaration['fields'] if field['path'] == ['mailDomain'])

    def test_mail_domain_is_required_and_editable_in_the_ordinary_form(self):
        self.assertEqual(self.mail_field['type'], 'text')
        self.assertTrue(self.mail_field['required'])
        self.assertIsNone(self.mail_field['template'])

    def test_default_mail_domain_remains_isolated(self):
        value = fixture()
        value['mailDomain'] = self.declaration['defaults']['mailDomain']
        self.assertTrue(value['mailDomain'].endswith('.test'))
        self.assertIsNone(configuration(value)['routing'])

    def test_real_mail_domain_can_be_submitted_without_a_template_override(self):
        self.assertIsNone(self.mail_field['template'])
        value = fixture()
        value['mailDomain'] = 'example.com'
        value['routing'] = {'zoneId': 'c' * 32, 'domain': value['mailDomain']}
        value['email']['origin'] = 'https://email-api.example.com'
        value['platform']['origin'] = 'https://mail.example.com'
        self.assertEqual(configuration(value)['mailDomain'], 'example.com')


if __name__ == '__main__':
    unittest.main()
