"""Read-only, credential-free verification of the selected public release."""
import hashlib
import json
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

from boundary import DeploymentError, digest, exact, matches, origin, require


RELEASE_PATH = '/.well-known/easyemail-release.json'
VERIFY_ERROR = 'EASYEMAIL_PUBLIC_VERIFICATION_FAILED'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ReleaseReader:
    def __init__(self, opener=None):
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def read(self, url, status=200, limit=8 * 1024 * 1024):
        parsed = urlparse(url)
        origin('https://' + parsed.netloc)
        require(parsed.scheme == 'https' and not parsed.query and not parsed.fragment, VERIFY_ERROR)
        request = urllib.request.Request(url, method='GET', headers={'Accept': '*/*', 'Cache-Control': 'no-cache'})
        try:
            try:
                response = self.opener.open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                require(response.status == status and not response.headers.get('set-cookie'), VERIFY_ERROR)
                body = response.read(limit + 1)
                require(len(body) <= limit, VERIFY_ERROR)
                return body
        except (OSError, urllib.error.URLError, ValueError):
            raise DeploymentError(VERIFY_ERROR) from None


def marker(value, request, component):
    exact(value, ['schemaVersion', 'applicationId', 'applicationVersion', 'sourceSha', 'configurationDigest', 'component', 'assets'])
    require(value['schemaVersion'] == 1 and value['component'] == component, VERIFY_ERROR)
    require(all(value[key] == request[key] for key in ('applicationId', 'applicationVersion', 'sourceSha')), VERIFY_ERROR)
    require(value['configurationDigest'] == digest(request['configuration']), VERIFY_ERROR)
    assets = value['assets']
    require(isinstance(assets, list) and len(assets) <= 4, VERIFY_ERROR)
    for row in assets:
        exact(row, ['path', 'bytes', 'sha256'])
        require(isinstance(row['path'], str) and (row['path'] == '/' or re.fullmatch(r'/assets/[a-zA-Z0-9_-]+\.(?:js|css)', row['path'])), VERIFY_ERROR)
        require(type(row['bytes']) is int and 0 < row['bytes'] <= 8 * 1024 * 1024 and matches(r'[a-f0-9]{64}', row['sha256']), VERIFY_ERROR)
    require(len({row['path'] for row in assets}) == len(assets), VERIFY_ERROR)
    require((not assets) if component == 'email' else {'/', '/assets/app.js'} <= {row['path'] for row in assets}, VERIFY_ERROR)
    return assets


def json_body(body):
    try:
        return json.loads(body.decode('utf8'))
    except (ValueError, UnicodeError):
        raise DeploymentError(VERIFY_ERROR) from None


def verify_public(request, read=None):
    read = read or ReleaseReader().read
    config, checks = request['configuration'], []
    for component in ('email', 'platform'):
        base = config[component]['origin']
        assets = marker(json_body(read(base + RELEASE_PATH, limit=16384)), request, component)
        checks.append({'id': component + '-release-matched', 'passed': True})
        for asset in assets:
            body = read(base + asset['path'], limit=asset['bytes'])
            require(len(body) == asset['bytes'] and hashlib.sha256(body).hexdigest() == asset['sha256'], VERIFY_ERROR)
    require(read(config['email']['origin'] + '/health_check', limit=4096) == b'OK', VERIFY_ERROR)
    require(json_body(read(config['platform']['origin'] + '/healthz', limit=4096)) ==
            {'service': 'easyemail-cloudflare', 'status': 'alive'}, VERIFY_ERROR)
    boundary = json_body(read(config['platform']['origin'] + '/api/v1/me', status=401, limit=4096))
    require(isinstance(boundary, dict) and isinstance(boundary.get('error'), dict)
            and boundary['error'].get('code') == 'unauthorized', VERIFY_ERROR)
    checks += [{'id': item, 'passed': True} for item in ('web-assets-matched', 'public-health-ready', 'anonymous-api-denied')]
    return checks
