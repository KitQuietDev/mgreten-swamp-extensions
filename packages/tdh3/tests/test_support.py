"""Disposable local Swamp workspace; never uses the monorepo datastore."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

TESTS = Path(__file__).resolve().parent
PACKAGE = TESTS.parent
RUNTIME = PACKAGE / "extensions/models/tdh3/runtime"
sys.path.insert(0, str(RUNTIME))
PYTHON = Path(sys.executable)
TEMP = tempfile.TemporaryDirectory(prefix="tdh3-package-offline-")
BASE = Path(TEMP.name).resolve()
(BASE / "private").mkdir(mode=0o700)
ENV = {k: v for k, v in os.environ.items() if not k.startswith("SWAMP_")}
result = subprocess.run(["swamp", "init", "--tool", "none", "--no-vault",
                         "--json", "--no-telemetry"], cwd=BASE, env=ENV,
                        capture_output=True, text=True, timeout=60)
assert result.returncode == 0, result.stderr
shutil.copytree(PACKAGE / "extensions", BASE / "extensions", dirs_exist_ok=True)
