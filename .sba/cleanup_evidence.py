"""Read consumed cleanup evidence through the management API without reopening a Worker."""
import urllib.error
import urllib.request
from urllib.parse import quote

from boundary import DeploymentError, exact, require
from object_snapshot import PRIVATE_PREFIX
from preview_provenance import cleanup_key, signed_payload, validate_provenance


ERROR = 'EASYEMAIL_CLEANUP_RESUME_EVIDENCE_INVALID'


def object_body(api, bucket, metadata):
    require(0 < metadata['size'] <= 131072, ERROR)
    # Object key slashes are part of this API's path; percent-encoding them changes the key.
    path = '/r2/buckets/' + bucket + '/objects/' + quote(metadata['key'], safe='/')
    request = urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/' + api.account + path,
        headers={'Authorization': 'Bearer ' + api.token, 'User-Agent': 'EasyEmail-SBA/1.0'})
    try:
        with api.transport.opener.open(request, timeout=30) as response:
            require(response.status == 200, ERROR)
            content = response.read(131073)
            etag = response.headers.get('ETag', '')
            if etag.startswith('W/'): etag = etag[2:]
            require(len(content) == metadata['size'] and etag.strip('"') == metadata['etag'], ERROR)
            return content
    except (OSError, urllib.error.URLError):
        raise DeploymentError(ERROR) from None


def validate_evidence(original, proof, consumed, progress):
    validate_provenance(original, proof)
    exact(consumed, ['format', 'previewTaskId', 'destroyTaskId', 'resultDigest', 'configurationDigest', 'resources'])
    require(consumed == {'format': 'easyemail-preview-cleanup-v1', 'previewTaskId': proof['previewTaskId'],
        'destroyTaskId': progress['consumedTaskId'], 'resultDigest': proof['resultDigest'],
        'configurationDigest': proof['configurationDigest'], 'resources': proof['resources']}, ERROR)


def load_evidence(original, progress, api, key, buckets):
    bucket = original['configuration']['platform']['outboxBucket']
    rows = buckets['outboxBucket']['objects']
    names = [PRIVATE_PREFIX + 'previews/' + original['context']['previewTaskId'] + '.json', cleanup_key(original)]
    values = []
    for name in names:
        selected = [row for row in rows if row['key'] == name]
        require(len(selected) == 1, ERROR)
        values.append(signed_payload(object_body(api, bucket, selected[0]), key))
    validate_evidence(original, *values, progress)
    return values
