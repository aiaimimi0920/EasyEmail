"""Private, bounded full-data archives with authenticated encryption and offline restore proof."""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import time
import zipfile
from pathlib import Path

from boundary import DeploymentError, digest, require
from build_environment import system_environment
from configuration import configuration
from d1_snapshot import MAX_SQL, witness
from object_snapshot import metadata
from private_files import protect_directory
from snapshot_links import verify_links


MAX_ARCHIVE = 268435456
MAX_MANIFEST = 8388608


def file_digest(path):
    hashed = hashlib.sha256()
    with Path(path).open('rb') as file:
        for block in iter(lambda: file.read(65536), b''): hashed.update(block)
    return hashed.hexdigest()


def private_directory(path):
    path = Path(path); path.mkdir(mode=0o700)
    protect_directory(path, system_environment())
    return path


def crypto_file(mode, source, output, key, identity):
    environment = system_environment()
    node = shutil.which('node', path=environment.get('PATH', environment.get('Path', '')))
    require(node, 'EASYEMAIL_TOOLCHAIN_UNAVAILABLE')
    try:
        result = subprocess.run([node, str(Path(__file__).with_name('archive-crypto.mjs')), mode, str(source), str(output)],
                                cwd=Path(output).parent, env=environment, input=json.dumps({'key': key, 'context': identity}).encode(),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        raise DeploymentError('EASYEMAIL_ARCHIVE_CRYPTO_FAILED') from None
    require(result.returncode == 0, 'EASYEMAIL_ARCHIVE_CRYPTO_FAILED')


def validate_manifest(value):
    error = 'EASYEMAIL_SNAPSHOT_MANIFEST_INVALID'
    require(isinstance(value, dict) and set(value) == {'format', 'createdAt', 'source', 'databases', 'objects'}, error)
    require(value['format'] == 'easyemail-snapshot-v1' and type(value['createdAt']) is int
            and 0 < value['createdAt'] <= 9007199254740991, error)
    source = value['source']
    require(isinstance(source, dict) and set(source) == {'configuration', 'sourceSha', 'applicationVersion', 'taskId'}, error)
    require(isinstance(source['sourceSha'], str) and re.fullmatch(r'[a-f0-9]{40}', source['sourceSha'])
            and isinstance(source['taskId'], str) and re.fullmatch(r'dc-[a-f0-9]{32}', source['taskId'])
            and isinstance(source['applicationVersion'], str) and re.fullmatch(r'\d+\.\d+\.\d+', source['applicationVersion']), error)
    configuration(source['configuration'])
    databases, objects = value['databases'], value['objects']
    require(isinstance(databases, dict) and set(databases) == {'email', 'platform'}
            and isinstance(objects, list) and len(objects) <= 10000, error)
    files, keys, object_bytes = {}, set(), 0
    for role, row in databases.items():
        require(isinstance(row, dict) and set(row) == {'file', 'bytes', 'sha256', 'witness', 'bookmark'}
                and row['file'] == role + '.sql' and type(row['bytes']) is int and 0 < row['bytes'] <= MAX_SQL
                and isinstance(row['witness'], dict) and (row['bookmark'] is None or isinstance(row['bookmark'], str) and len(row['bookmark']) <= 256), error)
        files[row['file']] = row
    for index, row in enumerate(objects):
        require(isinstance(row, dict) and set(row) == {'file', 'bucket', 'source', 'sha256'}
                and row['file'] == f'objects/{index}.object' and row['bucket'] in ('INBOX', 'OUTBOX'), error)
        source = metadata(row['source']); identity = (row['bucket'], source['key'])
        require(identity not in keys and not (identity[0] == 'OUTBOX' and identity[1].startswith('_easyemail-sba/')), error)
        keys.add(identity); object_bytes += source['size']
        files[row['file']] = {'bytes': source['size'], 'sha256': row['sha256']}
    require(object_bytes <= 134217728 and sum(row['bytes'] for row in files.values()) <= MAX_ARCHIVE - MAX_MANIFEST - 4194304, error)
    for row in files.values():
        require(isinstance(row['sha256'], str) and re.fullmatch(r'[a-f0-9]{64}', row['sha256']), error)
    return files


def seal_backup(source, databases, objects, directory, key, *, created_at=None):
    directory = Path(directory)
    manifest = {'format': 'easyemail-snapshot-v1', 'createdAt': int(time.time() * 1000) if created_at is None else created_at,
                'source': source, 'databases': {}, 'objects': []}
    paths = {}
    for role, row in databases.items():
        name = role + '.sql'; paths[name] = Path(row['path'])
        manifest['databases'][role] = {**{field: row[field] for field in ('bytes', 'sha256', 'witness', 'bookmark')}, 'file': name}
    for index, row in enumerate(objects):
        name = f'objects/{index}.object'; paths[name] = Path(row['path'])
        manifest['objects'].append({**{field: row[field] for field in ('bucket', 'source', 'sha256')}, 'file': name})
    files = validate_manifest(manifest)
    verify_links(paths['platform.sql'], manifest['objects'])
    raw = json.dumps(manifest, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    require(len(raw) <= MAX_MANIFEST, 'EASYEMAIL_SNAPSHOT_TOO_LARGE')
    identity = digest(manifest); archive = directory / 'snapshot.zip'; encrypted = directory / 'snapshot.eesba'
    with os.fdopen(os.open(archive, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600), 'w+b') as file:
        with zipfile.ZipFile(file, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as output:
            output.writestr('manifest.json', raw)
            for name, row in files.items():
                require(paths[name].stat().st_size == row['bytes'] and file_digest(paths[name]) == row['sha256'], 'EASYEMAIL_SNAPSHOT_CONTENT_CHANGED')
                output.write(paths[name], name)
        file.flush(); os.fsync(file.fileno())
    crypto_file('encrypt', archive, encrypted, key, identity)
    return {'id': identity, 'createdAt': manifest['createdAt'], 'path': encrypted,
            'bytes': encrypted.stat().st_size, 'sha256': file_digest(encrypted), 'manifest': manifest}


def open_backup(archive, key, identity, directory, expected_source):
    directory = private_directory(directory)
    zipped = directory / 'snapshot.zip'
    crypto_file('decrypt', archive, zipped, key, identity)
    try:
        with zipfile.ZipFile(zipped, 'r') as source:
            info = source.infolist(); names = [item.filename for item in info]
            require(len(names) <= 10003 and len(set(names)) == len(names) and names.count('manifest.json') == 1,
                    'EASYEMAIL_SNAPSHOT_ARCHIVE_INVALID')
            require(all(item.compress_type == zipfile.ZIP_STORED and item.compress_size == item.file_size
                        and not item.flag_bits & 1 and stat.S_IFMT(item.external_attr >> 16) in (0, stat.S_IFREG) for item in info)
                    and sum(item.file_size for item in info) <= MAX_ARCHIVE, 'EASYEMAIL_SNAPSHOT_ARCHIVE_INVALID')
            require(source.getinfo('manifest.json').file_size <= MAX_MANIFEST, 'EASYEMAIL_SNAPSHOT_TOO_LARGE')
            manifest = json.loads(source.read('manifest.json').decode('utf8'))
            files = validate_manifest(manifest)
            require(digest(manifest) == identity and manifest['source'] == expected_source, 'EASYEMAIL_SNAPSHOT_SOURCE_MISMATCH')
            require(set(names) == {'manifest.json', *files}, 'EASYEMAIL_SNAPSHOT_ARCHIVE_INVALID')
            (directory / 'objects').mkdir(mode=0o700)
            for name, row in files.items():
                require(source.getinfo(name).file_size == row['bytes'], 'EASYEMAIL_SNAPSHOT_CONTENT_CHANGED')
                with source.open(name) as input_file, os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
                    shutil.copyfileobj(input_file, output, 65536)
                    output.flush(); os.fsync(output.fileno())
                require(file_digest(directory / name) == row['sha256'], 'EASYEMAIL_SNAPSHOT_CONTENT_CHANGED')
        for role, row in manifest['databases'].items():
            require(witness(directory / row['file']) == row['witness'], 'EASYEMAIL_SNAPSHOT_CONTENT_CHANGED')
        verify_links(directory / 'platform.sql', manifest['objects'])
        return manifest
    except DeploymentError:
        raise
    except (OSError, ValueError, UnicodeError, zipfile.BadZipFile, RuntimeError):
        raise DeploymentError('EASYEMAIL_SNAPSHOT_ARCHIVE_INVALID') from None
