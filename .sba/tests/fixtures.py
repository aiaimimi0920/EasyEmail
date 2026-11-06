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
        'applicationId': 'easyemail', 'applicationVersion': '1.0.7',
        'environment': 'test-123456abcdef', 'configuration': configuration(),
        'previous': None if action == 'deploy' else {'sourceSha': 'b' * 40, 'applicationVersion': '1.0.7'},
    })


def repair_request():
    value = request('repair')
    value['previous'] = {'sourceSha': 'd' * 40, 'applicationVersion': '1.0.0'}
    value['context'] = {'repairId': 'complete-empty-bootstrap', 'parentTaskId': 'dc-' + '2' * 32,
                        'parentRunId': 123, 'requestDigest': 'e' * 64, 'resultDigest': 'f' * 64,
                        'errorCode': 'EASYEMAIL_CLOUD_REQUEST_FAILED'}
    return value


def preview_repair_request():
    from configuration import inventory
    value = repair_request(); source = configuration()
    prefix = 'test-aaaabbbbcccc'
    source['email'].update(name=prefix + '-email', origin='https://' + prefix + '-email.synthetic.workers.dev',
                           database={'id': '33333333-3333-3333-3333-333333333333', 'name': prefix + '-email-db'})
    source['platform'].update(name=prefix + '-platform', origin='https://' + prefix + '-platform.synthetic.workers.dev',
                              database={'id': '44444444-4444-4444-4444-444444444444', 'name': prefix + '-platform-db'},
                              inboxBucket=prefix + '-inbox', outboxBucket=prefix + '-outbox')
    source['mailDomain'] = prefix + '.test'
    value['previous'] = {'sourceSha': 'd' * 40, 'applicationVersion': '1.0.2'}
    value['context'].update(repairId='complete-preview-credentials', errorCode='EASYEMAIL_PREVIEW_CREDENTIAL_FAILED', preview={
        'source': {'sourceSha': 'a' * 40, 'applicationVersion': '1.0.0', 'instanceId': 'dc-' + '3' * 32,
                   'taskId': 'dc-' + '4' * 32, 'environment': 'source', 'configuration': source,
                   'resources': inventory(source), 'resultDigest': 'a' * 64},
        'resources': inventory(value['configuration']), 'urls': [value['configuration'][role]['origin'] for role in ('email', 'platform')]})
    return value
