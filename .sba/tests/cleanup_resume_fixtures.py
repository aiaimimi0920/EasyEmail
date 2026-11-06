"""Consumed preview with one missing Worker, real SQLite claims and signed R2 evidence; no cloud writes."""
import copy
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import cleanup_resume
from boundary import DeploymentError, digest
from cleanup_fixtures import CleanupApi
from cleanup_repair import repair_cleanup
from data_resources import data_identity
from deployment_secrets import deployment_secrets
from fixtures import preview_repair_request
from preview_provenance import persist_provenance, consume_provenance, RESULT_IDENTITY
from test_deploy_secrets import secret_environment


class ResumeApi(CleanupApi):
    def __init__(self, config):
        super().__init__(config); self.account = config['accountId']; self.state = None
        self.connection = sqlite3.connect(':memory:'); self.connection.row_factory = sqlite3.Row
        self.fail = None; self.late = None; self.body = {}
        self.created = {name: '2026-11-06T00:00:00Z' for name in self.workers}
        self.workers[config['email']['name']]['bindings'].append({'name': 'DOMAINS', 'type': 'json', 'json': ['synthetic.test']})

    def before(self, label):
        if label: self.state.before_write(label)

    def after(self, label):
        if label and label == self.fail: raise DeploymentError('EASYEMAIL_CLOUD_REQUEST_FAILED')
        if self.late: self.late(self, label)

    def query(self, database, sql, params=None, write=None):
        self.before(write)
        if write: self.writes.append(write)
        rows = self.connection.execute(sql, params or []).fetchall(); self.connection.commit()
        self.after(write)
        return [dict(row) for row in rows]

    def request(self, method, suffix, payload=None, write=None, zone=None):
        self.before(write)
        value = super().request(method, suffix, payload, write, zone)
        if suffix == '/workers/scripts':
            for row in value['result']: row['created_on'] = self.created[row['id']]
        self.after(write)
        return value

    def get(self, suffix, zone=None):
        if suffix.endswith('/schedules'): return {'schedules': []}
        return super().get(suffix, zone)

    def delete(self, suffix, *, write):
        self.before(write); super().delete(suffix, write=write); self.after(write)


class ResumeFixture:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix='cleanup-resume-', dir=os.environ['EASYEMAIL_TEST_ROOT']))
        preview = preview_repair_request(); preview.update(sourceSha='d' * 40, applicationVersion='1.0.6')
        config = preview['configuration']; self.api = ResumeApi(config); self.material = deployment_secrets(config, secret_environment())
        api = self.api
        class Store:
            def list(self, bucket): return [{'key': name} for name in api.body]
            def get(self, bucket, row, path=None): return hashlib.sha256(api.body[row['key']]).hexdigest()
            def upload(self, bucket, name, path, metadata, checksum, label):
                content = Path(path).read_bytes(); api.body[name] = content
                api.objects[config['platform']['outboxBucket']].append({'key': name, 'size': len(content),
                    'etag': hashlib.md5(content).hexdigest(), 'last_modified': '2026-11-06T00:00:00Z'})
                return {'key': name}
        result = {'status': 'succeeded', 'checks': [{'id': name, 'passed': True} for name in
            ('snapshot-copied', 'migration-verified', 'source-unchanged', 'side-effects-isolated', 'repair-completed',
             'data-preserved', 'unchanged-resources-verified', 'service-ready')], 'lifecycle': {
                'resources': [{'key': row['key'], 'status': 'created'} for row in preview['context']['preview']['resources']],
                'urls': preview['context']['preview']['urls'], 'snapshot': {'id': 'a' * 64, 'createdAt': 7}}}
        state = {'managed': {'resources': data_identity(config, api, require_empty=False), 'domains': {}, 'routing': None}, 'settingsDigest': 'a' * 64}
        persist_provenance(preview, result, state, Store(), self.material.archive_key, self.root)
        original = {**preview, 'action': 'destroy-preview', 'taskId': 'dc-' + '5' * 32,
            'context': {'instanceId': preview['context']['parentTaskId'], 'previewTaskId': preview['taskId'],
                        'resultDigest': digest({**{field: preview[field] for field in RESULT_IDENTITY}, **result}), 'resources': preview['context']['preview']['resources']}}
        proof = json.loads(next(iter(api.body.values())).decode())['payload']
        consume_provenance(original, proof, Store(), self.material.archive_key, self.root)
        api.objects[config['platform']['outboxBucket']].sort(key=lambda row: row['key'])
        self.request = {**original, 'action': 'repair', 'taskId': 'dc-' + '6' * 32, 'sourceSha': 'c' * 40, 'applicationVersion': '1.0.9',
            'previous': {'sourceSha': 'e' * 40, 'applicationVersion': '1.0.7'}, 'context': {
                'repairId': 'complete-preview-cleanup', 'parentTaskId': original['taskId'], 'parentRunId': 123,
                'requestDigest': 'e' * 64, 'errorCode': 'EASYEMAIL_PREVIEW_RESOURCE_CLEANUP_UNCONFIRMED',
                'cleanup': {'sourceSha': preview['sourceSha'], 'applicationVersion': preview['applicationVersion'], 'context': original['context']}}}
        parent = {**{field: original[field] for field in RESULT_IDENTITY}, 'sourceSha': 'e' * 40, 'applicationVersion': '1.0.7',
            'action': 'repair', 'status': 'unknown', 'errorCode': self.request['context']['errorCode'],
            'checks': [{'id': name, 'passed': True} for name in ('preview-authority-verified', 'preview-ingress-stopped')],
            'lifecycle': {'resources': [{'key': row['key'], 'status': 'removed' if row['kind'] == 'domain' else 'unknown'} for row in original['context']['resources']]}}
        self.request['context']['cleanupProgress'] = {'consumedTaskId': original['taskId'], 'permitAt': 1793926800000, 'journalTaskId': None, 'parentResult': parent}
        self.request['context']['resultDigest'] = digest(parent)
        api.workers.pop(config['platform']['name'])
        for value in api.exposures.values(): value.update(enabled=False, previews_enabled=False)

    def run(self, request=None):
        request = request or self.request
        def cloud(account, token, state): self.api.state = state; return self.api
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, secret_environment()))
            stack.enter_context(patch.object(cleanup_resume, 'CloudApi', side_effect=cloud))
            stack.enter_context(patch('cleanup_evidence.object_body', side_effect=lambda api, bucket, row: api.body[row['key']]))
            return repair_cleanup(request, self.root / request['taskId'])

    def successor(self, result, parent=None):
        parent = parent or self.request; value = copy.deepcopy(parent)
        value.update(taskId='dc-' + '7' * 32, sourceSha='f' * 40, applicationVersion='1.0.10',
                     previous={key: parent[key] for key in ('sourceSha', 'applicationVersion')})
        context = value['context']; context.update(parentTaskId=parent['taskId'], requestDigest=digest(parent), errorCode=result['errorCode'])
        full = {**{key: parent[key] for key in RESULT_IDENTITY}, **result}; context['resultDigest'] = digest(full)
        context['cleanupProgress']['parentResult'] = full
        if any(row['id'] == 'cleanup-resume-claim-persisted' and row['passed'] for row in result['checks']): context['cleanupProgress']['journalTaskId'] = parent['taskId']
        return value
