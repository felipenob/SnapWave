"""
package_zip.py
Packages the application cleanly into transcript_review_app.zip,
excluding git metadata, pycache, temporary backups, and autosaves.
"""

import os
import zipfile

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
ZIP_OUTPUT = os.path.join(PROJECT_DIR, "transcript_review_app.zip")

EXCLUDE_DIRS = {
    ".git",
    ".venv",
    "__pycache__",
    ".autosave",
    ".backups",
    ".pytest_cache",
    ".idea",
    ".vscode"
}

EXCLUDE_EXTENSIONS = {
    ".pyc",
    ".pyo",
    ".pyd",
    ".bak",
    ".zip"
}

EXCLUDE_FILES = {
    "package_zip.py",
    "reviewed_test.eaf",
    "P1_custom_export.srt"
}

def create_zip():
    count = 0
    total_bytes = 0
    with zipfile.ZipFile(ZIP_OUTPUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(PROJECT_DIR):
            # Prune excluded directories
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            for file in files:
                if file in EXCLUDE_FILES:
                    continue
                ext = os.path.splitext(file)[1].lower()
                if ext in EXCLUDE_EXTENSIONS:
                    continue

                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, PROJECT_DIR)
                
                # Double-check relative path doesn't contain excluded directory names
                parts = rel_path.split(os.sep)
                if any(p in EXCLUDE_DIRS for p in parts):
                    continue

                zf.write(abs_path, rel_path)
                count += 1
                total_bytes += os.path.getsize(abs_path)

    zip_size = os.path.getsize(ZIP_OUTPUT)
    print(f"[SUCCESS] Packaged {count} files ({total_bytes / (1024*1024):.2f} MB uncompressed) into:")
    print(f" -> {ZIP_OUTPUT} ({zip_size / (1024*1024):.2f} MB compressed)")

if __name__ == "__main__":
    create_zip()
