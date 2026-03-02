"""
Build script: bundle the Python backend into a standalone executable using PyInstaller.

Usage:
    python build_backend.py

Output:
    dist/backend/backend.exe   (+ supporting files in dist/backend/_internal/)
"""

import subprocess
import sys


def main():
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--name", "backend",
        "--distpath", "dist",
        # Add backend directory to Python path so modules are importable
        "--paths", "backend",
        # Hidden imports that PyInstaller might miss
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "uvicorn.lifespan.off",
        "--hidden-import", "aiosqlite",
        "--hidden-import", "httpx",
        "--hidden-import", "httpx._transports",
        "--hidden-import", "httpx._transports.default",
        "--hidden-import", "PIL",
        "--hidden-import", "multipart",
        "--hidden-import", "python_multipart",
        "--hidden-import", "config",
        "--hidden-import", "database",
        "--hidden-import", "models",
        "--hidden-import", "scene_analyzer",
        "--hidden-import", "image_generator",
        "--hidden-import", "prompt",
        # Show console window for debugging (change to --noconsole for release)
        "--console",
        # Confirm overwrite
        "--noconfirm",
        # Entry point
        "backend/main.py",
    ]

    print("=" * 60)
    print("Building backend.exe with PyInstaller...")
    print("=" * 60)

    result = subprocess.run(cmd, cwd=".")
    if result.returncode == 0:
        print("\nBuild successful. Output: dist/backend/backend.exe")
        return

    print(f"\nBuild failed with exit code {result.returncode}")
    if result.returncode != 0:
        print("PyInstaller may be missing. Install it with: pip install pyinstaller")
    sys.exit(1)


if __name__ == "__main__":
    main()
