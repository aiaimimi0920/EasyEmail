"""应用拥有的 SBA 输入边界；不把公开配置当成凭据通道。"""
import copy
import json
import re
import subprocess
from urllib.parse import urlparse
from boundary import DeploymentError, digest, exact, matches, name, require, version
from configuration import configuration, inventory, isolated
from build_environment import local_git_environment


def validate_repair(request, manifest):
    context = request['context']
    exact(context, ['repairId', 'parentTaskId', 'parentRunId', 'requestDigest', 'resultDigest', 'errorCode'])
    require(isinstance(context['parentTaskId'], str) and re.fullmatch(r'dc-[a-f0-9]{32}', context['parentTaskId'])
            and context['parentTaskId'] != request['taskId'])
    require(type(context['parentRunId']) is int and context['parentRunId'] > 0)
    require(all(isinstance(context[key], str) and re.fullmatch(r'[a-f0-9]{64}', context[key])
                for key in ('requestDigest', 'resultDigest')))
    repairs = [row for row in manifest['repairs'] if row['id'] == context['repairId']]
    require(len(repairs) == 1 and context['errorCode'] in repairs[0]['fromErrorCodes'])


def validate_context(request):
    context, target = request['context'], request['configuration']
    require(re.fullmatch(r'test-[a-f0-9]{12}', request['environment']))
    require(context['resources'] == inventory(target) and target['routing'] is None and isolated(target))
    require(all(row['name'].startswith(request['environment']) for row in context['resources'] if row['kind'] != 'domain'))
    require(all(urlparse(target[role]['origin']).hostname.startswith(target[role]['name'] + '.') for role in ('email', 'platform')))
    if request['action'] == 'preview':
        exact(context, ['source', 'resources', 'urls'])
        source = context['source']
        exact(source, ['instanceId', 'taskId', 'sourceSha', 'applicationVersion', 'environment', 'configuration', 'resources', 'resultDigest'])
        configuration(source['configuration'])
        require(source['resources'] == inventory(source['configuration']))
        require(source['environment'] != request['environment'] and source['configuration']['accountId'] == target['accountId'])
        require({k: source[k] for k in ('sourceSha', 'applicationVersion')} == request['previous'])
        require(target['settings'] == source['configuration']['settings'])
        require(set(context['urls']) == {target[role]['origin'] for role in ('email', 'platform')} and len(context['urls']) == 2)
        identity = lambda row: (row['accountId'], row['kind'], row['remoteId'])
        require(not set(map(identity, source['resources'])).intersection(map(identity, context['resources'])))
    else:
        exact(context, ['instanceId', 'previewTaskId', 'resultDigest', 'resources'])
    require(re.fullmatch(r'[a-f0-9]{64}', context.get('resultDigest', context.get('source', {}).get('resultDigest', ''))))
    identities = context.get('source', context)
    for key in ('instanceId', 'taskId') if request['action'] == 'preview' else ('instanceId', 'previewTaskId'):
        require(re.fullmatch(r'dc-[a-f0-9]{32}', identities[key]))


def validated_request(value, root):
    manifest = json.loads((root / '.sba/manifest.json').read_text(encoding='utf8'))
    fields = ['schemaVersion', 'taskId', 'action', 'repository', 'sourceSha', 'applicationId', 'applicationVersion', 'environment', 'configuration', 'previous']
    if value.get('action') in ('preview', 'destroy-preview', 'repair'):
        fields.append('context')
    exact(value, fields)
    require(value['schemaVersion'] == 3 and value['action'] in manifest['actions'])
    require(value['repository'] == 'aiaimimi0920/EasyEmail' and value['applicationId'] == manifest['id'] and value['applicationVersion'] == manifest['version'])
    require(re.fullmatch(r'dc-[a-f0-9]{32}', value['taskId']) and re.fullmatch(r'[a-f0-9]{40}', value['sourceSha']))
    name(value['environment'])
    current = version(value['applicationVersion'])
    if value['action'] == 'deploy':
        require(value['previous'] is None)
    else:
        exact(value['previous'], ['sourceSha', 'applicationVersion'])
        require(re.fullmatch(r'[a-f0-9]{40}', value['previous']['sourceSha']))
        previous = version(value['previous']['applicationVersion'])
        if value['action'] in ('update', 'preview', 'repair'):
            require(current > previous and value['sourceSha'] != value['previous']['sourceSha'])
        else:
            require(current == previous and value['sourceSha'] == value['previous']['sourceSha'])
    configuration(value['configuration'], preview=value['action'] in ('preview', 'destroy-preview'))
    if value['action'] in ('preview', 'destroy-preview'):
        validate_context(value)
    if value['action'] == 'repair':
        validate_repair(value, manifest)
    def git(*args):
        return subprocess.check_output(['git', '-c', 'core.fsmonitor=false', *args], cwd=root, text=True, encoding='utf8',
                                       stderr=subprocess.DEVNULL, env=local_git_environment(), timeout=30).strip()
    require(git('rev-parse', 'HEAD') == value['sourceSha'], 'EASYEMAIL_SOURCE_MISMATCH')
    require(git('remote', 'get-url', 'origin') == 'https://github.com/aiaimimi0920/EasyEmail.git', 'EASYEMAIL_SOURCE_MISMATCH')
    require(not git('status', '--porcelain=v1', '--untracked-files=all', '--ignored'), 'EASYEMAIL_SOURCE_DIRTY')
    require(not any(line[:1] in ('S', 's') or line[:1].islower() for line in git('ls-files', '-v').splitlines()), 'EASYEMAIL_SOURCE_DIRTY')
    return copy.deepcopy(value)
