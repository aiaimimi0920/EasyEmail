"""Read-back gates for platform-provisioned empty data resources and initial Worker names."""
from boundary import require
from configuration import isolated
from data_resources import data_identity
from production_domains import verify_workers_dev


def fresh_resources(config, api):
    if isolated(config):
        require(config['routing'] is None, 'EASYEMAIL_RESOURCE_MISMATCH')
        verify_workers_dev(config, api)
    workers = api.get('/workers/scripts')
    require(isinstance(workers, list) and len(workers) <= 1000 and all(isinstance(row, dict) and isinstance(row.get('id'), str)
                                                                               for row in workers), 'EASYEMAIL_RESOURCE_MISMATCH')
    require(not {config[role]['name'] for role in ('email', 'platform')} & {row['id'] for row in workers}, 'EASYEMAIL_RESOURCE_ALREADY_USED')
    return data_identity(config, api, require_empty=True)


def verify_database_initialization(config, api, release):
    directory = release / 'publish/platform/migrations'
    names = sorted(path.name for path in directory.glob('*.sql'))
    require(len(names) == 59 and names[-1] == '0059_mailbox_access_recoveries.sql', 'EASYEMAIL_MIGRATION_SET_INVALID')
    platform = config['platform']['database']['id']; email = config['email']['database']['id']
    applied = api.query(platform, 'SELECT name FROM d1_migrations ORDER BY name')
    require(applied == [{'name': name} for name in names], 'EASYEMAIL_MIGRATION_SET_INVALID')
    for database in (email, platform):
        require(api.query(database, 'PRAGMA foreign_key_check') == [], 'EASYEMAIL_DATABASE_INTEGRITY_FAILED')
        require(api.query(database, 'PRAGMA quick_check') == [{'quick_check': 'ok'}], 'EASYEMAIL_DATABASE_INTEGRITY_FAILED')
    expected = {'raw_mail_resources', 'mail_delete_operations', 'address_delete_operations',
                'raw_mail_resource_insert', 'raw_mail_resource_update', 'raw_mail_resource_delete'}
    objects = api.query(email, "SELECT name FROM sqlite_master WHERE type IN ('table','trigger')")
    require(expected <= {row['name'] for row in objects}, 'EASYEMAIL_DATABASE_INTEGRITY_FAILED')
