import importlib.util
import json
from pathlib import Path

root = Path(__file__).parent
spec = importlib.util.spec_from_file_location("candidate", root / "max_sublist_sum.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for arguments, expected in json.loads((root / "testcases.json").read_text()):
    actual = module.max_sublist_sum(*arguments)
    assert actual == expected, (arguments, actual, expected)
