"""Test-only loopback adapter; preserve the production client's HTTPS URL and headers."""
import base64
import io
import json
import urllib.request
from email.message import Message


class Response(io.BytesIO):
    def __init__(self, value):
        super().__init__(base64.b64decode(value['body']))
        self.status, self.headers = value['status'], Message()
        for key, item in value['headers'].items(): self.headers[key] = item


class Bridge:
    def __init__(self, port):
        self.port = int(port)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def open(self, request, timeout):
        body = request.data.read() if hasattr(request.data, 'read') else request.data
        value = {'url': request.full_url, 'method': request.get_method(), 'headers': dict(request.header_items()),
                 'body': None if body is None else base64.b64encode(body).decode()}
        forwarded = urllib.request.Request(f'http://127.0.0.1:{self.port}', data=json.dumps(value).encode(),
                                           headers={'Content-Type': 'application/json'})
        with self.opener.open(forwarded, timeout=timeout) as response:
            return Response(json.loads(response.read()))
