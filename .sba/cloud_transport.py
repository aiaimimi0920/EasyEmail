"""Bounded, non-retrying cloud I/O and a private before-write journal."""
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

from boundary import DeploymentError, require
from public_verify import NoRedirect


class OperationState:
    def __init__(self, directory, task_id):
        self.path = Path(directory) / 'operation.json'
        self.value = {'taskId': task_id, 'writes': []}
        self.attempted = False
        require(not self.path.exists(), 'EASYEMAIL_WRITE_REPLAY_REFUSED')
        self._save()

    def _save(self):
        temporary = self.path.with_suffix('.pending')
        with temporary.open('x', encoding='utf8', newline='\n') as output:
            json.dump(self.value, output); output.write('\n'); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, self.path)

    def before_write(self, label):
        require(re.fullmatch(r'[a-z][a-z0-9-]{1,62}', label) and label not in self.value['writes'], 'EASYEMAIL_WRITE_REPLAY_REFUSED')
        self.value['writes'].append(label)
        # Mark memory first as a journal persistence failure must also stop this operation.
        self.attempted = True
        self._save()


class JsonTransport:
    def __init__(self, state, opener=None):
        self.state = state
        # Never forward a cloud token or administrator credential through an inherited proxy.
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def response(self, url, method='GET', payload=None, headers=None, status=200, write=None, allow_empty=False):
        body = None if payload is None else json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf8')
        request = urllib.request.Request(url, method=method, data=body,
                                         headers={'Accept': 'application/json', 'Content-Type': 'application/json',
                                                  'User-Agent': 'EasyEmail-SBA/1.0', **(headers or {})})
        if write:
            self.state.before_write(write)
        try:
            try: response = self.opener.open(request, timeout=30)
            except urllib.error.HTTPError as error: response = error
            with response:
                require(response.status in status if isinstance(status, tuple) else response.status == status, 'EASYEMAIL_CLOUD_REQUEST_FAILED')
                content = response.read(1024 * 1024 + 1)
                require(len(content) <= 1024 * 1024, 'EASYEMAIL_CLOUD_RESPONSE_INVALID')
                return None if allow_empty and not content else json.loads(content.decode('utf8')), response.headers, response.status
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            # Raw response/error bodies may echo SQL parameters or credentials. Do not retain them.
            raise DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED') from None

    def request(self, *args, **kwargs):
        body, headers, _ = self.response(*args, **kwargs)
        return body, headers


class CloudApi:
    def __init__(self, account, token, state, opener=None):
        self.account, self.token = account, token
        self.transport = JsonTransport(state, opener)

    def _request(self, path, method='GET', payload=None, write=None, status=200):
        body, headers = self.transport.request('https://api.cloudflare.com/client/v4' + path,
                                              method, payload, {'Authorization': 'Bearer ' + self.token}, status=status, write=write)
        # The live Worker custom-domain GET returns errors:null, unlike the other observed envelopes.
        domain_read = method == 'GET' and path.split('?', 1)[0] == '/accounts/' + self.account + '/workers/domains'
        require(isinstance(body, dict) and body.get('success') is True
                and (body.get('errors') == [] or domain_read and 'errors' in body and body['errors'] is None)
                and 'result' in body, 'EASYEMAIL_CLOUD_RESPONSE_INVALID')
        return body

    def request(self, method, suffix, payload=None, write=None, zone=None):
        require((suffix.startswith('/') or suffix == '' and zone is not None)
                and not any(part in suffix for part in ('..', '#', '://')), 'EASYEMAIL_CLOUD_PATH_INVALID')
        require(method == 'GET' or write is not None or method == 'POST' and re.fullmatch(r'/d1/database/[a-f0-9-]{36}/query', suffix),
                'EASYEMAIL_WRITE_JOURNAL_REQUIRED')
        if zone is not None:
            require(re.fullmatch(r'[a-f0-9]{32}', zone), 'EASYEMAIL_CLOUD_PATH_INVALID')
        prefix = '/accounts/' + self.account if zone is None else '/zones/' + zone
        status = (200, 202) if method == 'POST' and re.fullmatch(r'/d1/database/[a-f0-9-]{36}/export', suffix) else 200
        return self._request(prefix + suffix, method, payload, write, status)

    def get(self, suffix, zone=None):
        return self.request('GET', suffix, zone=zone)['result']

    def read_response(self, suffix, *, statuses=(200,)):
        require(suffix.startswith('/') and not any(part in suffix for part in ('..', '#', '://')), 'EASYEMAIL_CLOUD_PATH_INVALID')
        body, _, status = self.transport.response('https://api.cloudflare.com/client/v4/accounts/' + self.account + suffix,
                                                  headers={'Authorization': 'Bearer ' + self.token}, status=statuses)
        return body, status

    def delete(self, suffix, *, write):
        require(suffix.startswith('/') and not any(part in suffix for part in ('..', '#', '://')) and write,
                'EASYEMAIL_WRITE_JOURNAL_REQUIRED')
        body, _, _ = self.transport.response('https://api.cloudflare.com/client/v4/accounts/' + self.account + suffix,
            method='DELETE', headers={'Authorization': 'Bearer ' + self.token}, status=(200, 202, 204), write=write, allow_empty=True)
        require(body is None or isinstance(body, dict) and body.get('success') is True and body.get('errors') == [],
                'EASYEMAIL_CLOUD_RESPONSE_INVALID')

    def account_zones(self):
        rows, totals = [], None
        for page in range(1, 21):
            body = self._request(f'/zones?account.id={self.account}&status=active&per_page=50&page={page}')
            info, current = body.get('result_info'), body['result']
            require(isinstance(info, dict) and isinstance(current, list) and len(current) <= 50
                    and info.get('page') == page and info.get('per_page') == 50
                    and type(info.get('total_count')) is int and 0 <= info['total_count'] <= 1000
                    and type(info.get('total_pages')) is int
                    and (info['total_pages'] in (0, 1) if info['total_count'] == 0 else info['total_pages'] == (info['total_count'] + 49) // 50)
                    and info.get('count') == len(current), 'EASYEMAIL_ZONE_LIST_INCOMPLETE')
            values = (info['total_count'], info['total_pages'])
            require(totals is None or totals == values, 'EASYEMAIL_ZONE_LIST_INCOMPLETE'); totals = values
            rows.extend(current)
            if page == max(1, totals[1]):
                require(len(rows) == totals[0] and all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in rows)
                        and len({row['id'] for row in rows}) == len(rows), 'EASYEMAIL_ZONE_LIST_INCOMPLETE')
                return rows
        raise DeploymentError('EASYEMAIL_ZONE_LIST_INCOMPLETE')

    def query(self, database, sql, params=None, write=None):
        require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', database), 'EASYEMAIL_CLOUD_PATH_INVALID')
        value = self.request('POST', '/d1/database/' + database + '/query', {'sql': sql, 'params': params or []}, write)['result']
        require(isinstance(value, list) and len(value) == 1 and isinstance(value[0], dict) and value[0].get('success') is True
                and isinstance(value[0].get('results'), list), 'EASYEMAIL_CLOUD_RESPONSE_INVALID')
        return value[0]['results']


class RuntimeClient:
    def __init__(self, configuration, state, opener=None):
        self.origins = {role: configuration[role]['origin'] for role in ('email', 'platform')}
        self.transport = JsonTransport(state, opener)

    def request(self, role, path, *, method='GET', payload=None, headers=None, status=200, write=None):
        require(path.startswith('/') and not path.startswith('//') and not any(c in path for c in ('#', '://')), 'EASYEMAIL_CLOUD_PATH_INVALID')
        require(method == 'GET' or write is not None, 'EASYEMAIL_WRITE_JOURNAL_REQUIRED')
        origin = self.origins[role]
        return self.transport.request(origin + path, method, payload, {'Origin': origin, **(headers or {})}, status, write)
