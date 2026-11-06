"""Exercise encrypted persistence and native R2 restore; D1 export uses explicit local SQL fixtures."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cloud_transport import OperationState
from object_snapshot import ObjectStore, business_inventory
from snapshot_lifecycle import capture_backup, restore_objects
from build_environment import system_environment
from private_files import protect_directory
from runtime_bridge import Bridge
from snapshot_fixtures import source_record, exporter_fixture


root = Path(sys.argv[2]); root.mkdir()
protect_directory(root, system_environment())
state = OperationState(root, 'dc-' + '1' * 32)
bridge = Bridge(sys.argv[1])
source = ObjectStore({'platform': {'origin': 'https://source.example.com'}}, 'a1' * 32, state, bridge)
target = ObjectStore({'platform': {'origin': 'https://target.example.com'}}, 'b2' * 32, state, bridge)
before = business_inventory(source)
backup = capture_backup(None, source, source_record(), 'c3' * 32, root / 'backup', exporter=exporter_fixture(source))
restored = restore_objects(target, backup['manifest'], backup['directory'])
receipts = restored['copies']
assert before == business_inventory(source)
assert sum(map(len, before.values())) == len(receipts)
(root / 'copy-receipts.json').write_text(json.dumps(receipts, ensure_ascii=False), encoding='utf8')
(root / 'platform-rebound.sql').write_bytes(restored['platformSql'].read_bytes())
print(json.dumps({'status': 'passed', 'copied': len(receipts), 'sourceUnchanged': True, 'persistedRestoreProof': True}))
