"""Copy-scoped authority, legacy vault reads and private calls to the actual application crypto."""
import hashlib
import hmac
import json
import os
import shutil
import subprocess
from pathlib import Path

from boundary import DeploymentError, require
from build_environment import system_environment
from configuration import configuration, inventory, isolated, preview_configuration
from deployment_secrets import deployment_secrets


def preview_material(source, target, environment=None):
    source, target = configuration(source), preview_configuration(target)
    identity = lambda row: (row['accountId'], row['kind'], row['remoteId'])
    require(isolated(target) and target['routing'] is None
            and not set(map(identity, inventory(source))).intersection(map(identity, inventory(target))), 'EASYEMAIL_PREVIEW_TARGET_INVALID')
    environment = dict(os.environ if environment is None else environment)
    original = deployment_secrets(source, environment)
    copied = deployment_secrets(target, {**environment, 'EE_PROVIDER_SECRETS': '{}'})
    old = json.loads(original.workers['platform']['MAILBOX_KEYRING'])
    new = json.loads(copied.workers['platform']['MAILBOX_KEYRING'])
    require('preview1' not in old['keys'], 'EASYEMAIL_PREVIEW_TARGET_INVALID')
    # Old encrypted credentials and keyed idempotency receipts remain readable; all new writes use a distinct key.
    copied.workers['platform']['MAILBOX_KEYRING'] = json.dumps({'active': 'preview1', 'keys': {**old['keys'], 'preview1': new['keys'][new['active']]}}, separators=(',', ':'))
    copied.invitation = hmac.new(bytes.fromhex(copied.archive_key), b'easyemail-preview-registration-v1', hashlib.sha256).hexdigest()
    copied.workers['platform']['REGISTRATION_TOKEN'] = copied.invitation
    return original, copied


def rewrite_self(rows, providers, source, target, original, copied, *, application_root=None):
    value = {'configuration': {'sourceEmail': source['email']['origin'], 'sourcePlatform': source['platform']['origin'],
                             'targetEmail': target['email']['origin'], 'targetPlatform': target['platform']['origin'], 'mailDomain': target['mailDomain']},
             'sourceEnv': {'MAILBOX_KEYRING': original.workers['platform']['MAILBOX_KEYRING']},
             'targetEnv': {'MAILBOX_KEYRING': copied.workers['platform']['MAILBOX_KEYRING']},
             'sourceJwt': original.workers['email']['JWT_SECRET'], 'targetJwt': copied.workers['email']['JWT_SECRET'],
             'mailboxes': rows, 'providers': providers}
    payload = json.dumps(value, ensure_ascii=False).encode('utf8')
    require(len(payload) <= 67108864, 'EASYEMAIL_PREVIEW_DATA_TOO_LARGE')
    environment = system_environment(); node = shutil.which('node', path=environment.get('PATH', environment.get('Path', '')))
    require(node, 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
    runtime = (Path(application_root) if application_root is not None else Path(__file__).resolve().parents[1]) / '.sba/preview-vault.mjs'
    try:
        result = subprocess.run([node, str(runtime)], env=environment,
                                cwd=runtime.parent, input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=180)
        require(result.returncode == 0 and len(result.stdout) <= 67108864, 'EASYEMAIL_PREVIEW_CREDENTIAL_FAILED')
        return json.loads(result.stdout.decode('utf8'))
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        raise DeploymentError('EASYEMAIL_PREVIEW_CREDENTIAL_FAILED') from None
