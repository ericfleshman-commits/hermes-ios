import importlib.util
import unittest
from pathlib import Path
from datetime import datetime, timedelta, timezone

class ReleaseTests(unittest.TestCase):
    def test_expiry_gate(self):
        spec = importlib.util.spec_from_file_location('release_check', Path(__file__).parents[1] / 'scripts/release_check.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        now = datetime.now(timezone.utc)
        for hours in [-1, 12]:
            with self.assertRaises(ValueError):
                module.check_expiry({'ExpirationDate': now + timedelta(hours=hours)}, now, 24)
        module.check_expiry({'ExpirationDate': now + timedelta(days=7)}, now, 24)
        with self.assertRaises(ValueError):
            module.check_expiry({}, now, 24)

if __name__ == '__main__':
    unittest.main()
