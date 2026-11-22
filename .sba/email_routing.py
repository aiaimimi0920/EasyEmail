"""A single acknowledged catch-all binding, without enabling or modifying shared DNS/MX."""
import re

from boundary import digest, matches, require


def rule(value):
    require(isinstance(value, dict) and matches(r'[a-f0-9]{32}', value.get('id'))
            and value.get('source') == 'api' and type(value.get('enabled')) is bool
            and isinstance(value.get('name'), str) and len(value['name']) <= 256
            and not re.search(r'[\x00-\x1f\x7f]', value['name'])
            and value.get('matchers') == [{'type': 'all'}], 'EASYEMAIL_EMAIL_RULE_UNSUPPORTED')
    actions = value.get('actions')
    require(isinstance(actions, list) and len(actions) == 1 and isinstance(actions[0], dict), 'EASYEMAIL_EMAIL_RULE_UNSUPPORTED')
    action = actions[0]; kind = action.get('type')
    require(kind in ('drop', 'forward', 'worker') and set(action) <= {'type', 'value'}, 'EASYEMAIL_EMAIL_RULE_UNSUPPORTED')
    if kind == 'drop':
        require(action.get('value', []) == [], 'EASYEMAIL_EMAIL_RULE_UNSUPPORTED'); action = {'type': 'drop'}
    else:
        require(isinstance(action.get('value'), list) and len(action['value']) == 1 and isinstance(action['value'][0], str)
                and 1 <= len(action['value'][0]) <= 256, 'EASYEMAIL_EMAIL_RULE_UNSUPPORTED')
        action = {'type': kind, 'value': list(action['value'])}
    return {**{key: value[key] for key in ('id', 'source', 'name', 'enabled')}, 'matchers': [{'type': 'all'}], 'actions': [action]}


def read_routing(config, api):
    target = config['routing']; zone_id = target['zoneId']
    zone = api.get('', zone=zone_id)
    require(isinstance(zone, dict) and zone.get('id') == zone_id and zone.get('name') == target['domain']
            and zone.get('status') == 'active' and isinstance(zone.get('account'), dict)
            and zone['account'].get('id') == config['accountId'], 'EASYEMAIL_EMAIL_ZONE_MISMATCH')
    settings = api.get('/email/routing', zone=zone_id)
    require(isinstance(settings, dict) and matches(r'[a-f0-9]{32}', settings.get('id')) and settings.get('name') == target['domain']
            and settings.get('enabled') is True and settings.get('status') == 'ready', 'EASYEMAIL_EMAIL_ROUTING_NOT_READY')
    return rule(api.get('/email/routing/rules/catch_all', zone=zone_id))


def prepare_routing(config, api):
    if config['routing'] is None:
        return None
    current = read_routing(config, api)
    require(current['enabled'] is False and current['actions'] == [{'type': 'drop'}], 'EASYEMAIL_EMAIL_ROUTE_ALREADY_USED')
    return current


def bind_routing(config, api, before):
    if before is None:
        require(config['routing'] is None, 'EASYEMAIL_EMAIL_ROUTE_CHANGED')
        return
    current = prepare_routing(config, api)
    require(digest(current) == digest(before), 'EASYEMAIL_EMAIL_ROUTE_CHANGED')
    desired = {**{key: before[key] for key in ('name', 'source', 'matchers')}, 'enabled': True,
               'actions': [{'type': 'worker', 'value': [config['email']['name']]}]}
    result = api.request('PUT', '/email/routing/rules/catch_all', desired, write='email-routing-bound', zone=config['routing']['zoneId'])
    expected = {'id': before['id'], **desired}
    require(rule(result['result']) == expected, 'EASYEMAIL_EMAIL_BINDING_UNCONFIRMED')
    require(read_routing(config, api) == expected, 'EASYEMAIL_EMAIL_BINDING_UNCONFIRMED')
