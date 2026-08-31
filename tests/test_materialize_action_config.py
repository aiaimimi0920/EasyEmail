from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "materialize-action-config.py"


def load_module():
    spec = importlib.util.spec_from_file_location("materialize_action_config", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MATERIALIZE = load_module()
SECRET_NAME = "EASYEMAIL_TEST_LIST_SECRET"


class MaterializeActionConfigTests(unittest.TestCase):
    def parse(self, value: str):
        with mock.patch.dict(os.environ, {SECRET_NAME: value}, clear=False):
            return MATERIALIZE.parse_list_secret(SECRET_NAME)

    def test_newline_delimited_secrets_preserve_each_item(self) -> None:
        for value in ("alpha\nbeta", "alpha\r\nbeta", "alpha\n\nbeta"):
            with self.subTest(value=repr(value)):
                self.assertEqual(self.parse(value), ["alpha", "beta"])

    def test_structured_comma_and_scalar_formats_remain_supported(self) -> None:
        cases = {
            '["alpha", "beta"]': ["alpha", "beta"],
            "- alpha\n- beta": ["alpha", "beta"],
            "alpha,beta": ["alpha", "beta"],
            "alpha": ["alpha"],
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(self.parse(value), expected)


if __name__ == "__main__":
    unittest.main()
