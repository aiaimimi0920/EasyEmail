"""SBA trust-boundary errors and primitive input parsing."""
import hashlib
import json
import re
from urllib.parse import urlparse


class DeploymentError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require(value, code='EASYEMAIL_REQUEST_INVALID'):
    if not value:
        raise DeploymentError(code)


def exact(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys))


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def origin(value):
    require(isinstance(value, str))
    parsed = urlparse(value)
    require(parsed.scheme == 'https' and parsed.netloc == parsed.hostname and value == 'https://' + parsed.netloc
            and matches(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', parsed.hostname))
    require(not re.search(r'(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|onion|invalid)$|\.home\.arpa$', parsed.hostname))
    return parsed.hostname


def name(value):
    require(matches(r'[a-z][a-z0-9-]{1,62}', value))


def version(value):
    require(matches(r'(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})', value))
    return tuple(map(int, value.split('.')))
