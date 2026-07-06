"""PyInstaller entry point for the frozen sidecar executable.

The backend packages (packages/video, packages/core) are NOT frozen — they
ship as plain .py data files next to the exe and are located at runtime via
NOEY_BACKEND_DIR (set by the Electron main process). This keeps PyInstaller
from tracing packages.llm → litellm, which the sidecar never uses.
"""

import sys

from sidecar.cli import main

if __name__ == "__main__":
    sys.exit(main())
