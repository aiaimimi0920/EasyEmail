"""SBA entrypoint with atomic, safe results and explicitly bounded lifecycle support."""
import argparse
import json
import os
from pathlib import Path

from boundary import DeploymentError, require
from contract import validated_request
from public_verify import verify_public
from initial_deploy import deploy
from update_deploy import update
from preview_deploy import preview
from preview_cleanup import destroy_preview
from bootstrap_repair import repair
from preview_repair import repair_preview


ROOT = Path(__file__).resolve().parents[1]


def run(request, directory=None):
    if request['action'] == 'verify':
        return {'status': 'succeeded', 'checks': verify_public(request)}
    if request['action'] == 'deploy':
        require(directory is not None, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED')
        return deploy(request, directory)
    if request['action'] == 'update':
        require(directory is not None, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED')
        return update(request, directory)
    if request['action'] == 'preview':
        require(directory is not None, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED')
        return preview(request, directory)
    if request['action'] == 'destroy-preview':
        require(directory is not None, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED')
        return destroy_preview(request, directory)
    if request['action'] == 'repair':
        require(directory is not None, 'EASYEMAIL_DEPLOYMENT_DIRECTORY_REQUIRED')
        if request['context']['repairId'] == 'complete-preview-credentials': return repair_preview(request, directory)
        return repair(request, directory)
    raise DeploymentError('EASYEMAIL_REQUEST_INVALID')


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value)
        value[key] = item
    return value


def read_request(path):
    body = Path(path).read_bytes()
    require(len(body) <= 49152 and not body.startswith(b'\xef\xbb\xbf'))
    try:
        value = json.loads(body.decode('utf8'), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise DeploymentError('EASYEMAIL_REQUEST_INVALID') from None
    require(isinstance(value, dict))
    return value


def execute(request_path, result_path):
    result_path = Path(result_path).resolve()
    require(not result_path.is_relative_to(ROOT) and not result_path.exists(), 'EASYEMAIL_RESULT_PATH_INVALID')
    request = read_request(request_path)
    result = {key: request.get(key) for key in ('schemaVersion', 'taskId', 'action', 'sourceSha', 'applicationVersion')}
    try:
        selected = validated_request(request, ROOT)
        result.update(run(selected, result_path.parent / ('easyemail-' + selected['taskId'])))
    except DeploymentError as error:
        result.update(status='failed', checks=[], errorCode=error.code)
    except Exception:
        # No raw exception, request contents or environment values enter public receipts/logs.
        result.update(status='failed', checks=[], errorCode='EASYEMAIL_UNEXPECTED_FAILURE')
    temporary = result_path.with_name(result_path.name + '.pending')
    with temporary.open('x', encoding='utf8', newline='\n') as output:
        json.dump(result, output, ensure_ascii=False); output.write('\n')
        output.flush(); os.fsync(output.fileno())
    os.replace(temporary, result_path)
    return 0 if result['status'] in ('succeeded', 'deployed-unverified') else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request', required=True)
    parser.add_argument('--result', required=True)
    args = parser.parse_args()
    try:
        raise SystemExit(execute(args.request, args.result))
    except DeploymentError as error:
        print(error.code)
        raise SystemExit(1) from None
