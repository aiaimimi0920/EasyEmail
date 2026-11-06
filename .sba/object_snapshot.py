"""Bounded authenticated object snapshots; keys never become local filesystem paths."""
import base64
import hashlib
import json
import os
import urllib.error
import urllib.request
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import urlencode

from boundary import DeploymentError, require
from cloud_transport import JsonTransport


PRIVATE_PREFIX = '_easyemail-sba/'
MAX_OBJECT = 268435456


def metadata(value):
    fields = {'key', 'size', 'etag', 'version', 'uploaded', 'httpMetadata', 'customMetadata', 'storageClass'}
    require(isinstance(value, dict) and set(value) == fields, 'EASYEMAIL_OBJECT_METADATA_INVALID')
    require(isinstance(value['key'], str) and 1 <= len(value['key'].encode('utf8')) <= 1024
            and type(value['size']) is int and 0 <= value['size'] <= MAX_OBJECT, 'EASYEMAIL_OBJECT_METADATA_INVALID')
    for field in ('etag', 'version', 'uploaded'):
        require(isinstance(value[field], str) and 1 <= len(value[field]) <= 256, 'EASYEMAIL_OBJECT_METADATA_INVALID')
    for field in ('httpMetadata', 'customMetadata'):
        require(isinstance(value[field], dict) and all(isinstance(key, str) and isinstance(item, str)
                for key, item in value[field].items()), 'EASYEMAIL_OBJECT_METADATA_INVALID')
    require(value['storageClass'] in ('Standard', 'InfrequentAccess'), 'EASYEMAIL_OBJECT_METADATA_INVALID')
    return value


class ObjectStore:
    def __init__(self, config, secret, state, opener=None):
        self.origin, self.secret, self.state = config['platform']['origin'], secret, state
        self.transport = JsonTransport(state, opener)

    def _request(self, operation, bucket, key=None, cursor=None, **kwargs):
        require(bucket in ('INBOX', 'OUTBOX'), 'EASYEMAIL_OBJECT_BINDING_INVALID')
        query = {'bucket': bucket}
        if key is not None: query['key'] = key
        if cursor is not None: query['cursor'] = cursor
        return urllib.request.Request(self.origin + '/__easyemail_sba/v1/' + operation + '?' + urlencode(query),
                                      headers={'Authorization': 'Bearer ' + self.secret, **kwargs.pop('headers', {})}, **kwargs)

    def list(self, bucket):
        rows, cursors, cursor = [], set(), None
        for _ in range(201):
            request = self._request('objects', bucket, cursor=cursor)
            value, _ = self.transport.request(request.full_url, headers=dict(request.header_items()))
            require(isinstance(value, dict) and set(value) == {'objects', 'truncated', 'cursor'}
                    and isinstance(value['objects'], list) and len(value['objects']) <= 50
                    and type(value['truncated']) is bool, 'EASYEMAIL_OBJECT_LIST_INCOMPLETE')
            rows.extend(metadata(row) for row in value['objects'])
            require(len(rows) <= 10000 and len({row['key'] for row in rows}) == len(rows), 'EASYEMAIL_OBJECT_LIST_INCOMPLETE')
            if not value['truncated']:
                require(value['cursor'] is None, 'EASYEMAIL_OBJECT_LIST_INCOMPLETE')
                return sorted(rows, key=lambda row: row['key'])
            cursor = value['cursor']
            require(isinstance(cursor, str) and 1 <= len(cursor) <= 4096 and cursor not in cursors,
                    'EASYEMAIL_OBJECT_LIST_INCOMPLETE')
            cursors.add(cursor)
        raise DeploymentError('EASYEMAIL_OBJECT_LIST_INCOMPLETE')

    def get(self, bucket, expected, path=None):
        metadata(expected)
        request = self._request('object', bucket, key=expected['key'])
        output = None
        try:
            with self.transport.opener.open(request, timeout=60) as response:
                require(response.status == 200 and response.headers.get('Content-Length') == str(expected['size']), 'EASYEMAIL_OBJECT_READ_UNCONFIRMED')
                raw = base64.b64decode(response.headers.get('x-easyemail-r2-metadata', ''), validate=True)
                require(len(raw) <= 12288 and metadata(json.loads(raw.decode('utf8'))) == expected, 'EASYEMAIL_OBJECT_CHANGED')
                if path is not None:
                    output = os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb')
                with output if output is not None else nullcontext():
                    hashed, size = hashlib.sha256(), 0
                    while True:
                        block = response.read(min(65536, expected['size'] + 1 - size))
                        if not block: break
                        size += len(block); require(size <= expected['size'], 'EASYEMAIL_OBJECT_READ_UNCONFIRMED')
                        hashed.update(block)
                        if output is not None: output.write(block)
                    require(size == expected['size'], 'EASYEMAIL_OBJECT_READ_UNCONFIRMED')
                    if output is not None:
                        output.flush(); os.fsync(output.fileno())
                return hashed.hexdigest()
        except DeploymentError:
            raise
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            raise DeploymentError('EASYEMAIL_OBJECT_READ_UNCONFIRMED') from None

    def put(self, bucket, key, path, source, checksum, label):
        metadata(source)
        return self.upload(bucket, key, path, {field: source[field] for field in ('size', 'httpMetadata', 'customMetadata', 'storageClass')}, checksum, label)

    def upload(self, bucket, key, path, source, checksum, label):
        require(isinstance(source, dict) and set(source) == {'size', 'httpMetadata', 'customMetadata', 'storageClass'}
                and type(source['size']) is int and 0 <= source['size'] <= MAX_OBJECT
                and isinstance(source['httpMetadata'], dict) and isinstance(source['customMetadata'], dict)
                and source['storageClass'] in ('Standard', 'InfrequentAccess'), 'EASYEMAIL_OBJECT_METADATA_INVALID')
        path = Path(path)
        require(path.stat().st_size == source['size'] and path.stat().st_size <= MAX_OBJECT, 'EASYEMAIL_OBJECT_CONTENT_CHANGED')
        hashed = hashlib.sha256()
        with path.open('rb') as file:
            for block in iter(lambda: file.read(65536), b''): hashed.update(block)
        require(hashed.hexdigest() == checksum, 'EASYEMAIL_OBJECT_CONTENT_CHANGED')
        value = {field: source[field] for field in ('size', 'httpMetadata', 'customMetadata', 'storageClass')}
        value['sha256'] = checksum
        headers = {'Content-Type': 'application/octet-stream', 'Content-Length': str(source['size']),
                   'x-easyemail-r2-metadata': base64.b64encode(json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()).decode()}
        try:
            with path.open('rb') as file:
                request = self._request('object', bucket, key=key, method='PUT', data=file, headers=headers)
                self.state.before_write(label)
                with self.transport.opener.open(request, timeout=60) as response:
                    require(response.status == 201, 'EASYEMAIL_OBJECT_WRITE_UNCONFIRMED')
                    raw = response.read(1048577); require(len(raw) <= 1048576, 'EASYEMAIL_OBJECT_WRITE_UNCONFIRMED')
                    actual = metadata(json.loads(raw.decode('utf8')))
            require(actual['key'] == key and all(actual[field] == source[field] for field in ('size', 'httpMetadata', 'customMetadata', 'storageClass')),
                    'EASYEMAIL_OBJECT_WRITE_UNCONFIRMED')
            require(self.get(bucket, actual) == checksum, 'EASYEMAIL_OBJECT_WRITE_UNCONFIRMED')
            return actual
        except DeploymentError:
            raise
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            raise DeploymentError('EASYEMAIL_OBJECT_WRITE_UNCONFIRMED') from None


def business_inventory(store):
    return {bucket: [row for row in store.list(bucket) if bucket != 'OUTBOX' or not row['key'].startswith(PRIVATE_PREFIX)]
            for bucket in ('INBOX', 'OUTBOX')}
