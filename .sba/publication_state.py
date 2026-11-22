"""Read-only admission of the exact email-uploaded/platform-absent fresh deployment state."""
import json

from bootstrap_pristine import uninitialized_databases
from boundary import digest, require
from data_resources import data_identity
from initial_resources import verify_database_initialization
from production_domains import listed_domains


ERROR = 'EASYEMAIL_PUBLICATION_STATE_MISMATCH'


def partial_state(config, api, release, workers):
    rows = api.get('/workers/scripts')
    require(isinstance(rows, list) and len(rows) <= 1000
            and all(isinstance(row, dict) and isinstance(row.get('id'), str) for row in rows)
            and len({row['id'] for row in rows}) == len(rows), ERROR)
    selected = [row for row in rows if row['id'] == config['email']['name']]
    require(len(selected) == 1 and not any(row['id'] == config['platform']['name'] for row in rows), ERROR)
    row = selected[0]
    require(isinstance(row.get('created_on'), str) and row['created_on'], ERROR)
    path = '/workers/scripts/' + config['email']['name']
    settings = api.get(path + '/settings')
    expected = json.loads((release / 'publish/email/wrangler.json').read_text(encoding='utf8'))
    from published_settings import verify_bindings
    verify_bindings(config, 'email', settings, expected, workers)
    require(api.get(path + '/subdomain') == {'enabled': False, 'previews_enabled': False}
            and api.get(path + '/schedules') == {'schedules': []}
            and listed_domains(api, {'service': config['email']['name']}) == [], ERROR)
    verify_database_initialization(config, api, release)
    witness = uninitialized_databases(config, api)
    identity = data_identity(config, api, require_empty=False)
    for field in ('inboxBucket', 'outboxBucket'):
        objects = api.request('GET', '/r2/buckets/' + config['platform'][field] + '/objects?per_page=1')
        info = objects.get('result_info', {})
        require(objects['result'] == [] and isinstance(info, dict) and not info.get('is_truncated') and not info.get('cursor'), ERROR)
    return {'identity': identity, 'createdOn': row['created_on'], 'settingsDigest': digest(settings), 'databases': witness}
