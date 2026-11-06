"""Synthetic SBA requests; no real accounts or credentials."""
import copy


def configuration():
    return {
        'accountId': 'a' * 32,
        'email': {'name': 'test-123456abcdef-email',
                  'origin': 'https://test-123456abcdef-email.synthetic.workers.dev',
                  'database': {'id': '11111111-1111-1111-1111-111111111111', 'name': 'test-123456abcdef-email-db'}},
        'platform': {'name': 'test-123456abcdef-platform',
                     'origin': 'https://test-123456abcdef-platform.synthetic.workers.dev',
                     'database': {'id': '22222222-2222-2222-2222-222222222222', 'name': 'test-123456abcdef-platform-db'},
                     'inboxBucket': 'test-123456abcdef-inbox', 'outboxBucket': 'test-123456abcdef-outbox'},
        'mailDomain': 'test-123456abcdef.test', 'routing': None,
        'settings': {'adminUsername': 'admin', 'sendRecipients': [], 'providers': [],
                     'providerOrigins': [], 'imapEndpoints': [], 'smtpEndpoints': []},
    }


def request(action='deploy'):
    return copy.deepcopy({
        'schemaVersion': 3, 'taskId': 'dc-' + '1' * 32, 'action': action,
        'repository': 'aiaimimi0920/EasyEmail', 'sourceSha': 'b' * 40,
        'applicationId': 'easyemail', 'applicationVersion': '1.0.0',
        'environment': 'test-123456abcdef', 'configuration': configuration(),
        'previous': None if action == 'deploy' else {'sourceSha': 'b' * 40, 'applicationVersion': '1.0.0'},
    })
