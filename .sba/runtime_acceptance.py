"""Existing-identity HTTP acceptance; never register/reset users during an upgrade."""
import json
import re

from boundary import require
from initial_bootstrap import session_cookie


def email_headers(material):
    return {'x-custom-auth': json.loads(material.workers['email']['PASSWORDS'])[0],
            'x-admin-auth': json.loads(material.workers['email']['ADMIN_PASSWORDS'])[0]}


def email_version(material, runtime):
    body, _ = runtime.request('email', '/admin/db_version', headers=email_headers(material))
    require(isinstance(body, dict) and body.get('need_initialization') is False and body.get('need_migration') is False
            and isinstance(body.get('code_db_version'), str) and body['code_db_version']
            and body.get('current_db_version') == body['code_db_version'], 'EASYEMAIL_EMAIL_VERSION_MISMATCH')


def migrate_email(material, runtime):
    body, _ = runtime.request('email', '/admin/db_migration', method='POST', headers=email_headers(material), write='update-email-migrated')
    require(isinstance(body, dict) and body.get('success') is True, 'EASYEMAIL_EMAIL_MIGRATION_FAILED')
    email_version(material, runtime)


def verify_administrator(config, material, runtime):
    body, headers = runtime.request('platform', '/api/v1/auth/login', method='POST',
                                   payload={'username': config['settings']['adminUsername'], 'password': material.password}, write='update-admin-login')
    cookie = session_cookie(headers)
    try:
        user = body.get('user') if isinstance(body, dict) else None
        require(isinstance(user, dict) and set(user) == {'id', 'username'} and isinstance(user['id'], str)
                and re.fullmatch(r'[a-f0-9-]{36}', user['id']) and user['username'] == config['settings']['adminUsername'],
                'EASYEMAIL_ADMIN_ACCEPTANCE_FAILED')
        body, _ = runtime.request('platform', '/api/v1/admin/providers', headers={'Cookie': cookie})
        require(isinstance(body, dict) and isinstance(body.get('items'), list), 'EASYEMAIL_ADMIN_ACCEPTANCE_FAILED')
        own = [row for row in body['items'] if row.get('config', {}).get('id') == 'self']
        require(len(own) == 1 and own[0]['config']['baseUrl'] == config['email']['origin']
                and own[0].get('secret', {}).get('configured') is True, 'EASYEMAIL_ADMIN_ACCEPTANCE_FAILED')
        body, _ = runtime.request('platform', '/api/v1/admin/providers/self/probe', method='POST', payload={},
                                  headers={'Cookie': cookie}, write='update-self-provider-probed')
        require(isinstance(body, dict) and body.get('health', {}).get('state') == 'ok'
                and body['health'].get('error') is None, 'EASYEMAIL_SELF_PROVIDER_FAILED')
    finally:
        runtime.request('platform', '/api/v1/auth/logout', method='POST', headers={'Cookie': cookie}, write='update-admin-session-closed')
