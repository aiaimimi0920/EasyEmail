"""Compare a downloaded Worker module with the exact pinned parent's Wrangler dry-run bytes."""
import email.parser
import email.policy
import hashlib
import urllib.error
import urllib.request

from boundary import DeploymentError, require


def verify_uploaded_worker(config, api, release, role='email'):
    require(role in ('email', 'platform'), 'EASYEMAIL_PARENT_WORKER_UNVERIFIED')
    expected = release.parent / (role + '-dry-run/sba-entry.mjs')
    raw_expected = expected.read_bytes()
    url = 'https://api.cloudflare.com/client/v4/accounts/' + api.account + '/workers/scripts/' + config[role]['name']
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + api.token, 'User-Agent': 'EasyEmail-SBA/1.0'})
    try:
        with api.transport.opener.open(request, timeout=30) as response:
            require(response.status == 200, 'EASYEMAIL_PARENT_WORKER_UNVERIFIED')
            kind = response.headers.get('Content-Type', '')
            body = response.read(16 * 1024 * 1024 + 1)
    except (OSError, urllib.error.URLError):
        raise DeploymentError('EASYEMAIL_PARENT_WORKER_UNVERIFIED') from None
    require(len(body) <= 16 * 1024 * 1024 and kind.startswith('multipart/form-data;'), 'EASYEMAIL_PARENT_WORKER_UNVERIFIED')
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(('Content-Type: ' + kind + '\r\n\r\n').encode() + body)
    parts = [part for part in message.walk() if not part.is_multipart()]
    names = [part.get_param('name', header='content-disposition') for part in parts]
    require(names in (['sba-entry.mjs'], ['sba-entry.mjs', 'sba-entry.mjs.map'])
            and parts[0].get_payload(decode=True) == raw_expected, 'EASYEMAIL_PARENT_WORKER_UNVERIFIED')
    return hashlib.sha256(raw_expected).hexdigest()


verify_uploaded_email = verify_uploaded_worker
