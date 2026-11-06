"""Public application configuration, declared resource identities and release inputs."""
import copy
import json
import re
from urllib.parse import urlparse

from boundary import exact, matches, name, origin, require


PROVIDER_FIELDS = {'id', 'type', 'baseUrl', 'domains', 'sendTransport', 'sendRecipients', 'enabled', 'authentication'}
IMAP_FIELDS = {'id', 'label', 'hostname', 'port', 'security', 'authentication'}
SMTP_FIELDS = IMAP_FIELDS | {'recipients'}


def isolated(value):
    return any(urlparse(value[role]['origin']).hostname.endswith('.workers.dev') for role in ('email', 'platform'))


def configuration(value, *, preview=False):
    exact(value, ['accountId', 'email', 'platform', 'mailDomain', 'routing', 'settings'])
    require(matches(r'[a-f0-9]{32}', value['accountId']) and value['accountId'] != '0' * 32)
    for role in ('email', 'platform'):
        exact(value[role], ['name', 'origin', 'database'] + (['inboxBucket', 'outboxBucket'] if role == 'platform' else []))
        component = value[role]
        name(component['name']); origin(component['origin'])
        exact(component['database'], ['id', 'name'])
        name(component['database']['name'])
        require(matches(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', component['database']['id'])
                and component['database']['id'] != '00000000-0000-0000-0000-000000000000')
    require(value['email']['name'] != value['platform']['name'] and value['email']['origin'] != value['platform']['origin'])
    require(value['email']['database']['id'] != value['platform']['database']['id']
            and value['email']['database']['name'] != value['platform']['database']['name'])
    for field in ('inboxBucket', 'outboxBucket'):
        name(value['platform'][field])
    require(value['platform']['inboxBucket'] != value['platform']['outboxBucket'])
    require(isinstance(value['mailDomain'], str)); origin('https://' + value['mailDomain'])
    if value['routing'] is not None:
        exact(value['routing'], ['zoneId', 'domain'])
        require(matches(r'[a-f0-9]{32}', value['routing']['zoneId']) and value['routing']['zoneId'] != '0' * 32)
        require(value['routing']['domain'] == value['mailDomain'])
    settings = value['settings']
    exact(settings, ['adminUsername', 'sendRecipients', 'providers', 'providerOrigins', 'imapEndpoints', 'smtpEndpoints'])
    require(matches(r'[a-z0-9][a-z0-9._-]{2,63}', settings['adminUsername']))
    for field in ('sendRecipients', 'providers', 'providerOrigins', 'imapEndpoints', 'smtpEndpoints'):
        require(isinstance(settings[field], list) and len(settings[field]) <= (19 if field in ('providers', 'providerOrigins') else 20))
    require(all(matches(r'[^\s@,;<>]+@[^\s@,;<>]+\.[a-z]{2,63}', item) and item == item.lower()
                for item in settings['sendRecipients']))
    require(len(set(settings['sendRecipients'])) == len(settings['sendRecipients']))
    for item in settings['providerOrigins']:
        origin(item)
    # Detailed provider/endpoint semantics are owned by the existing production validators in prepare.mjs.
    for field, allowed in [('providers', PROVIDER_FIELDS), ('imapEndpoints', IMAP_FIELDS), ('smtpEndpoints', SMTP_FIELDS)]:
        require(all(isinstance(item, dict) and set(item) <= allowed for item in settings[field]))
    if isolated(value):
        prefixes = []
        account_hosts = []
        for role in ('email', 'platform'):
            component = value[role]; labels = origin(component['origin']).split('.')
            require(len(labels) == 4 and labels[0] == component['name'] and labels[2:] == ['workers', 'dev'])
            account_hosts.append(labels[1])
            match = re.match(r'(test-[a-f0-9]{12}-|easyemail-migration-)', component['name'])
            require(match is not None); prefixes.append(match.group(0))
        require(account_hosts[0] == account_hosts[1] and prefixes[0] == prefixes[1])
        names = [value[role]['database']['name'] for role in ('email', 'platform')]
        names += [value['platform'][field] for field in ('inboxBucket', 'outboxBucket')]
        require(all(item.startswith(prefixes[0]) for item in names))
        require(value['routing'] is None and value['mailDomain'].endswith('.test'))
        if not preview:
            require(all(not settings[field] for field in ('providers', 'sendRecipients', 'providerOrigins', 'imapEndpoints', 'smtpEndpoints')))
    require(len(json.dumps(value, ensure_ascii=False).encode()) <= 32768)
    return copy.deepcopy(value)


def preview_configuration(value):
    """SpringBok inherits the source's public settings; none of its external effects enter the copy runtime."""
    value = configuration(value, preview=True)
    require(isolated(value) and value['routing'] is None, 'EASYEMAIL_PREVIEW_TARGET_INVALID')
    for field in ('providers', 'sendRecipients', 'providerOrigins', 'imapEndpoints', 'smtpEndpoints'):
        value['settings'][field] = []
    return value


def descriptor(value):
    result = {'version': 1, 'accountId': value['accountId'],
              'email': {**value['email'], 'domains': [value['mailDomain']], 'sendRecipients': value['settings']['sendRecipients']},
              'platform': {**value['platform'], 'providerEndpointOrigins': value['settings']['providerOrigins'],
                           'imapEndpoints': value['settings']['imapEndpoints'], 'smtpEndpoints': value['settings']['smtpEndpoints']}}
    if isolated(value):
        result['acceptance'] = {'workersDev': True}
    return result


def inventory(value):
    account, platform = value['accountId'], value['platform']
    rows = [('resource-emailDb', 'd1', value['email']['database']['id'], value['email']['database']['name']),
            ('resource-platformDb', 'd1', platform['database']['id'], platform['database']['name']),
            ('resource-inbox', 'r2', platform['inboxBucket'], platform['inboxBucket']),
            ('resource-outbox', 'r2', platform['outboxBucket'], platform['outboxBucket'])]
    for index, (role, field) in enumerate([('email', 'name'), ('email', 'origin'), ('platform', 'name'), ('platform', 'origin')]):
        rows.append((f'target-{index}', 'worker' if field == 'name' else 'domain', value[role][field], value[role][field]))
    if value['routing'] is not None:
        identity = 'email-routing:' + value['routing']['zoneId']
        rows.append(('target-4', 'email-routing', identity, identity))
    return [dict(key=key, kind=kind, accountId=account, remoteId=remote, name=label) for key, kind, remote, label in rows]
