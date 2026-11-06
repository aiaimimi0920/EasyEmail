"""Use production HTTP authentication and bootstrap handlers, not a second password KDF."""
import json
import re
from http.cookies import SimpleCookie

from boundary import require


def session_cookie(headers):
    value = headers.get('set-cookie', '')
    cookie = SimpleCookie(); cookie.load(value)
    require(set(cookie) == {'__Host-ee_session'}, 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    selected = cookie['__Host-ee_session']
    require(re.fullmatch(r'es_[a-f0-9]{64}', selected.value) and selected['secure'] and selected['httponly']
            and selected['samesite'] == 'Strict' and selected['path'] == '/' and not selected['domain'], 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    return '__Host-ee_session=' + selected.value


def bootstrap(config, material, api, runtime):
    email = material.workers['email']
    headers = {'x-custom-auth': json.loads(email['PASSWORDS'])[0], 'x-admin-auth': json.loads(email['ADMIN_PASSWORDS'])[0]}
    body, _ = runtime.request('email', '/admin/db_initialize', method='POST', headers=headers, write='email-version-initialized')
    require(body == {'message': 'Database initialized'}, 'EASYEMAIL_EMAIL_INITIALIZATION_FAILED')
    body, _ = runtime.request('email', '/admin/db_version', headers=headers)
    require(isinstance(body, dict) and body.get('need_initialization') is False and body.get('need_migration') is False
            and isinstance(body.get('code_db_version'), str) and body['code_db_version']
            and body.get('current_db_version') == body['code_db_version'], 'EASYEMAIL_EMAIL_INITIALIZATION_FAILED')
    database = config['platform']['database']['id']
    require(api.query(database, 'SELECT COUNT(*) AS n FROM users') == [{'n': 0}], 'EASYEMAIL_RESOURCE_NOT_EMPTY')
    username = config['settings']['adminUsername']
    credentials = {'username': username, 'password': material.password}
    body, headers = runtime.request('platform', '/api/v1/auth/register', method='POST',
                                   payload={**credentials, 'invite': material.invitation}, status=201, write='administrator-registered')
    cookie = session_cookie(headers)
    require(isinstance(body, dict) and isinstance(body.get('user'), dict) and body['user'].get('username') == username
            and re.fullmatch(r'[a-f0-9-]{36}', body['user'].get('id', '')), 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    user_id = body['user']['id']
    api.query(database, "INSERT INTO platform_admins(user_id,created_at) SELECT id,unixepoch() FROM users WHERE id=? AND username=? AND status='active'",
              [user_id, username], write='administrator-granted')
    require(api.query(database, 'SELECT user_id FROM platform_admins') == [{'user_id': user_id}], 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    runtime.request('platform', '/api/v1/auth/logout', method='POST', headers={'Cookie': cookie}, write='registration-session-closed')
    body, headers = runtime.request('platform', '/api/v1/auth/login', method='POST', payload=credentials, write='administrator-login-verified')
    cookie = session_cookie(headers)
    require(isinstance(body, dict) and body.get('user') == {'id': user_id, 'username': username}, 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    body, _ = runtime.request('platform', '/api/v1/admin/providers', headers={'Cookie': cookie})
    require(isinstance(body, dict) and isinstance(body.get('items'), list), 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    own = [row for row in body['items'] if row.get('config', {}).get('id') == 'self']
    require(len(own) == 1 and own[0]['config']['baseUrl'] == config['email']['origin']
            and own[0].get('secret', {}).get('configured') is True, 'EASYEMAIL_ADMIN_BOOTSTRAP_FAILED')
    body, _ = runtime.request('platform', '/api/v1/admin/providers/self/probe', method='POST', payload={},
                              headers={'Cookie': cookie}, write='self-provider-probed')
    require(isinstance(body, dict) and body.get('health', {}).get('state') == 'ok'
            and body['health'].get('error') is None, 'EASYEMAIL_SELF_PROVIDER_FAILED')
    runtime.request('platform', '/api/v1/auth/logout', method='POST', headers={'Cookie': cookie}, write='administrator-session-closed')
