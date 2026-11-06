"""Synthetic account metadata for destructive-lifecycle tests; no cloud access or real credentials."""
import copy
from urllib.parse import parse_qs, urlparse

from boundary import require
from fixtures import configuration


class CleanupApi:
    def __init__(self, config=None):
        self.config = copy.deepcopy(config or configuration()); self.writes = []; self.calls = []
        self.workers = {self.config[role]['name']: {'bindings': [{'name': 'DB', 'type': 'd1', 'id': self.config[role]['database']['id']}]}
                        for role in ('email', 'platform')}
        self.workers[self.config['platform']['name']]['bindings'] += [
            {'name': name, 'type': 'r2_bucket', 'bucket_name': self.config['platform'][field]}
            for name, field in [('INBOX', 'inboxBucket'), ('OUTBOX', 'outboxBucket')]]
        self.workers['other-service'] = {'bindings': []}
        self.projects = []; self.deployments = {}; self.email = []; self.zones = []; self.routes = []; self.domains = []
        self.exposures = {name: {'enabled': True, 'previews_enabled': False} for name in self.workers}
        self.databases = {self.config[role]['database']['id']: {'uuid': self.config[role]['database']['id'],
                          'name': self.config[role]['database']['name'], 'created_at': '2026-11-06T00:00:00Z'} for role in ('email', 'platform')}
        self.buckets = {self.config['platform'][field]: {'name': self.config['platform'][field], 'creation_date': '2026-11-06T00:00:00Z'}
                        for field in ('inboxBucket', 'outboxBucket')}
        self.objects = {name: [] for name in self.buckets}; self.notifications = None; self.locks = []
        self.managed = {'enabled': False}; self.custom = {'domains': []}

    def account_zones(self): return self.zones

    def request(self, method, suffix, payload=None, write=None, zone=None):
        self.calls.append((method, suffix, zone))
        if write: self.writes.append(write)
        path, query = urlparse(suffix).path, parse_qs(urlparse(suffix).query)
        result = None; info = None
        if path == '/workers/scripts': result = [{'id': name, 'modified_on': '2026-11-06T00:00:00Z'} for name in self.workers]
        elif path == '/pages/projects': result = self.projects
        elif path.startswith('/pages/projects/'): result = self.deployments[path.split('/')[3]]
        elif path == '/email/routing/rules':
            page = int(query['page'][0]); result = self.email[(page - 1) * 50:page * 50]
            info = {'page': page, 'count': len(result), 'total_count': len(self.email)}
        elif path == '/workers/domains':
            result = [row for row in self.domains if row['service'] == query['service'][0]]
            info = {'page': 1, 'count': len(result), 'total_count': len(result)}
        elif path == '/workers/routes': result = self.routes
        elif path == '/d1/database': result = list(self.databases.values())
        elif path.startswith('/d1/database/'):
            identity = path.split('/')[3]
            if method == 'DELETE': self.databases.pop(identity)
            else: result = self.databases[identity]
        elif path.startswith('/workers/scripts/'):
            name, resource = path.split('/')[3:5]
            if resource == 'settings': result = self.workers[name]
            elif resource == 'subdomain':
                if method == 'POST': self.exposures[name] = payload
                result = self.exposures[name]
        elif path == '/r2/buckets':
            result = {'buckets': [row for name, row in self.buckets.items() if query.get('name_contains', [''])[0] in name]}
        elif path.startswith('/r2/buckets/'):
            name = path.split('/')[3]; resource = path.split('/')[4:]
            if resource == []: result = self.buckets[name]
            elif resource == ['objects']:
                if method == 'DELETE':
                    result = [{'key': key} for key in payload]; self.objects[name] = [row for row in self.objects[name] if row['key'] not in payload]
                else:
                    result = sorted([row for row in self.objects[name] if row['key'] > query.get('start_after', [''])[0]], key=lambda row: row['key'])[:int(query.get('per_page', ['1000'])[0])]
            elif resource == ['lock']: result = {'rules': self.locks}
            elif resource == ['domains', 'managed']: result = self.managed
            elif resource == ['domains', 'custom']: result = self.custom
        require(result is not None or method == 'DELETE', 'EASYEMAIL_SYNTHETIC_PATH_INVALID')
        return {'success': True, 'errors': [], 'result': copy.deepcopy(result), **({'result_info': info} if info else {})}

    def get(self, suffix, zone=None): return self.request('GET', suffix, zone=zone)['result']

    def read_response(self, suffix, *, statuses):
        self.calls.append(('GET', suffix, None))
        if self.notifications is None: return {'success': False, 'errors': [{'code': 11015}], 'result': None}, 404
        return self.notifications

    def delete(self, suffix, *, write):
        self.writes.append(write); parts = suffix.split('/')
        if parts[1:3] == ['workers', 'scripts']: self.workers.pop(parts[3])
        elif parts[1:3] == ['d1', 'database']: self.databases.pop(parts[3])
        elif parts[1:3] == ['r2', 'buckets']: self.buckets.pop(parts[3])
        else: raise AssertionError(suffix)
