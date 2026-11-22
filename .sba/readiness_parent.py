"""Verify a reconstructed, byte-authenticated parent without claiming edge HTML is origin HTML."""
import hashlib
import json

from boundary import require
from public_verify import RELEASE_PATH, ReleaseReader, json_body, marker


def verify_parent_assets(request, release, read=None):
    read = read or ReleaseReader().read
    proof = json.loads((release / 'sba-release.json').read_text(encoding='utf8'))
    for role in ('email', 'platform'):
        base = request['configuration'][role]['origin']
        value = json_body(read(base + RELEASE_PATH, limit=16384))
        assets = marker(value, request, role)
        require(value == proof['markers'][role], 'EASYEMAIL_PARENT_RELEASE_UNVERIFIED')
        for asset in assets:
            # Both executable Workers were independently authenticated before this call.
            # Only the original entry is read from the rebuilt seal: its public HTML is edge-transformed.
            body = ((release / 'publish/platform/web/index.html').read_bytes() if asset['path'] == '/'
                    else read(base + asset['path'], limit=asset['bytes']))
            require(len(body) == asset['bytes'] and hashlib.sha256(body).hexdigest() == asset['sha256'],
                    'EASYEMAIL_PARENT_RELEASE_UNVERIFIED')
