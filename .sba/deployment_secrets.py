"""Map a stable per-instance master key to distinct Worker secrets; never log values."""
import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass, field

from boundary import DeploymentError, require


@dataclass(repr=False)
class DeploymentSecrets:
    token: str = field(repr=False)
    password: str = field(repr=False)
    invitation: str = field(repr=False)
    workers: dict = field(repr=False)
    archive_key: str = field(repr=False)


def deployment_secrets(config, environment=None):
    environment = os.environ if environment is None else environment
    values = {}
    for key in ('CLOUDFLARE_API_TOKEN', 'EE_MASTER_KEY', 'EE_REGISTRATION_TOKEN', 'EE_ADMIN_PASSWORD', 'EE_PROVIDER_SECRETS'):
        value = environment.get(key)
        require(isinstance(value, str) and 1 <= len(value.encode('utf8')) <= 512
                and not re.search(r'[\x00-\x1f\x7f]', value) and value != 'verification-not-applicable', 'EASYEMAIL_SECRET_INPUT_INVALID')
        values[key] = value
    master = values['EE_MASTER_KEY']
    require(re.fullmatch(r'[a-f0-9]{64}', master), 'EASYEMAIL_MASTER_KEY_INVALID')
    require(15 <= len(values['EE_ADMIN_PASSWORD']) <= 128 and 32 <= len(values['EE_REGISTRATION_TOKEN']) <= 256,
            'EASYEMAIL_SECRET_INPUT_INVALID')
    require(re.fullmatch(r'[A-Za-z0-9_-]{20,512}', values['CLOUDFLARE_API_TOKEN']), 'EASYEMAIL_SECRET_INPUT_INVALID')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'EASYEMAIL_PROVIDER_SECRETS_INVALID'); result[key] = value
        return result

    try:
        external = json.loads(values['EE_PROVIDER_SECRETS'], object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise DeploymentError('EASYEMAIL_PROVIDER_SECRETS_INVALID') from None
    providers = config['settings']['providers']
    expected = {row['id'] for row in providers if row.get('authentication') != 'anonymous'}
    require(isinstance(external, dict) and set(external) == expected and 'self' not in external, 'EASYEMAIL_PROVIDER_SECRETS_INVALID')
    for row in external.values():
        require(isinstance(row, dict) and {'apiKey'} <= set(row) <= {'apiKey', 'sitePassword'}, 'EASYEMAIL_PROVIDER_SECRETS_INVALID')
        require(all(isinstance(value, str) and len(value) <= 8192 and not re.search(r'[\x00-\x1f\x7f]', value)
                    for value in row.values()) and row['apiKey'], 'EASYEMAIL_PROVIDER_SECRETS_INVALID')
    # OAuth client secrets are not declared by this adapter yet; never deploy a silently broken endpoint.
    endpoints = config['settings']['imapEndpoints'] + config['settings']['smtpEndpoints']
    require(all(row.get('authentication') != 'google-oauth2' for row in endpoints), 'EASYEMAIL_OAUTH_DEPLOYMENT_NOT_READY')
    identity = config['accountId'] + '/' + config['platform']['database']['id'] + '/' + config['email']['database']['id']

    def derive(purpose):
        return hmac.new(bytes.fromhex(master), ('easyemail-sba-v1/' + identity + '/' + purpose).encode(), hashlib.sha256).hexdigest()

    encode = lambda value: json.dumps(value, separators=(',', ':'))
    email = {'JWT_SECRET': derive('email-jwt'), 'PASSWORDS': encode([derive('email-site')]), 'ADMIN_PASSWORDS': encode([derive('email-admin')])}
    platform = {'MAILBOX_KEYRING': encode({'active': 'sba1', 'keys': {'sba1': derive('mailbox-vault')}}),
                'EASYEMAIL_SBA_CONTROL_SECRET': derive('sba-object-control'),
                'REGISTRATION_TOKEN': values['EE_REGISTRATION_TOKEN'],
                'PROVIDER_SECRETS': encode({**external, 'self': {'apiKey': derive('email-admin'), 'sitePassword': derive('email-site')}})}
    return DeploymentSecrets(values['CLOUDFLARE_API_TOKEN'], values['EE_ADMIN_PASSWORD'], values['EE_REGISTRATION_TOKEN'],
                             {'email': email, 'platform': platform}, derive('snapshot-archive'))
