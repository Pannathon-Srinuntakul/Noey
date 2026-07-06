# PyInstaller spec — freeze the sidecar CLI (onedir).
#
# Build (from desktop/sidecar):  python -m PyInstaller sidecar.spec --noconfirm
# Output: dist/sidecar/sidecar(.exe)
#
# backend packages are intentionally excluded (shipped as data by
# desktop/app/scripts/prepare-resources.mjs; located via NOEY_BACKEND_DIR).

a = Analysis(
    ["pyinstaller_entry.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=[
        "ffmpeg",
        "pydantic",
        "pydantic_settings",
        "structlog",
    ],
    excludes=[
        # never trace the LLM stack — sidecar must work fully offline
        "litellm",
        "packages",
        "tkinter",
        "numpy",
        "PIL",
    ],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="sidecar",
)
