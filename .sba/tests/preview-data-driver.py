"""Native local clone fixture; source SQL is explicit local export, never a cloud export claim."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from configuration import descriptor
from preview_credentials import preview_material
from preview_data import prepare_preview_database
from test_deploy_secrets import secret_environment


values = json.loads(Path(sys.argv[2]).read_text(encoding='utf8'))
source, target = values['source'], values['target']
environment = {**secret_environment(), 'EE_ADMIN_PASSWORD': 'Synthetic-release-password-735296'}
original, copied = preview_material(source, target, environment)
if sys.argv[1] == 'material':
    print(json.dumps({'source': {'descriptor': descriptor(source), 'workers': original.workers},
                      'target': {'descriptor': descriptor(target), 'workers': copied.workers}}))
elif sys.argv[1] == 'prepare':
    prepared = prepare_preview_database(Path(sys.argv[3]), source, target, original, copied, Path(sys.argv[4]))
    print(json.dumps({key: prepared[key] for key in ('selfCredentials', 'providerOverrides')}))
else:
    raise ValueError('unsupported test driver mode')
