"""
Async SQLite database layer.
Uses aiosqlite for non-blocking database operations.
"""

import aiosqlite
from config import get_config

_db: aiosqlite.Connection | None = None


async def get_db() -> aiosqlite.Connection:
    """Get or create database connection (singleton per process)."""
    global _db
    if _db is None:
        cfg = get_config()
        print(f"[DB] Database path: {cfg.db_path}")
        _db = await aiosqlite.connect(cfg.db_path)
        _db.row_factory = aiosqlite.Row
        await _db.execute("PRAGMA journal_mode=WAL")
        await _db.execute("PRAGMA foreign_keys=ON")
    return _db


async def close_db():
    """Close the database connection."""
    global _db
    if _db is not None:
        await _db.close()
        _db = None


async def init_db():
    """Create tables if they don't exist."""
    db = await get_db()

    await db.executescript("""
        CREATE TABLE IF NOT EXISTS projects (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT    NOT NULL DEFAULT 'Untitled Project',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS scripts (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id  INTEGER NOT NULL,
            title       TEXT    NOT NULL DEFAULT 'Untitled Script',
            content     TEXT    NOT NULL DEFAULT '',
            word_count  INTEGER NOT NULL DEFAULT 0,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS scenes (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            script_id   INTEGER NOT NULL,
            scene_number INTEGER NOT NULL,
            timestamp_start TEXT NOT NULL DEFAULT '00:00',
            timestamp_end   TEXT NOT NULL DEFAULT '00:15',
            raw_text    TEXT    NOT NULL DEFAULT '',
            prompt      TEXT    NOT NULL DEFAULT '',
            status      TEXT    NOT NULL DEFAULT 'pending',
            error_message TEXT  NOT NULL DEFAULT '',
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (script_id) REFERENCES scripts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS generated_images (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            scene_id    INTEGER NOT NULL,
            file_path   TEXT    NOT NULL,
            file_name   TEXT    NOT NULL,
            width       INTEGER NOT NULL DEFAULT 768,
            height      INTEGER NOT NULL DEFAULT 512,
            created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
        );

        -- Seed a default project if none exists
        INSERT OR IGNORE INTO projects (id, name) VALUES (1, 'Sci-Fi Story');
        INSERT OR IGNORE INTO scripts (id, project_id, title) VALUES (1, 1, 'Untitled Script');
        -- Seed script_id=2 reserved for Auto Prompter
        INSERT OR IGNORE INTO scripts (id, project_id, title) VALUES (2, 1, 'Auto Prompter');
    """)

    await db.commit()

    # --- Migrations: add columns that may be missing in older databases ---
    try:
        await db.execute("ALTER TABLE scenes ADD COLUMN error_message TEXT NOT NULL DEFAULT ''")
        await db.commit()
        print("[DB] Migration: added 'error_message' column to scenes table")
    except Exception:
        # Column already exists — ignore
        pass

    # --- Ensure script_id=2 (Auto Prompter) exists ---
    try:
        await db.execute(
            "INSERT OR IGNORE INTO scripts (id, project_id, title) VALUES (2, 1, 'Auto Prompter')"
        )
        await db.commit()
    except Exception:
        pass


# ----- Repository helpers (thin data-access layer) -----

async def get_project(project_id: int) -> dict | None:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM projects WHERE id = ?", (project_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def list_projects() -> list[dict]:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM projects ORDER BY updated_at DESC")
    return [dict(r) for r in await cursor.fetchall()]


async def save_script(script_id: int, content: str, word_count: int):
    db = await get_db()
    await db.execute(
        "UPDATE scripts SET content = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?",
        (content, word_count, script_id),
    )
    await db.commit()


async def get_script(script_id: int) -> dict | None:
    db = await get_db()
    cursor = await db.execute("SELECT * FROM scripts WHERE id = ?", (script_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def delete_scenes_for_script(script_id: int):
    db = await get_db()
    await db.execute("DELETE FROM scenes WHERE script_id = ?", (script_id,))
    await db.commit()


async def insert_scene(script_id: int, scene_number: int,
                        ts_start: str, ts_end: str,
                        raw_text: str, prompt: str) -> int:
    db = await get_db()
    cursor = await db.execute(
        """INSERT INTO scenes (script_id, scene_number, timestamp_start, timestamp_end, raw_text, prompt, status)
           VALUES (?, ?, ?, ?, ?, ?, 'pending')""",
        (script_id, scene_number, ts_start, ts_end, raw_text, prompt),
    )
    await db.commit()
    return cursor.lastrowid


async def get_scenes_for_script(script_id: int) -> list[dict]:
    db = await get_db()
    cursor = await db.execute(
        "SELECT * FROM scenes WHERE script_id = ? ORDER BY scene_number", (script_id,)
    )
    return [dict(r) for r in await cursor.fetchall()]


async def update_scene_prompt(scene_id: int, prompt: str):
    db = await get_db()
    await db.execute("UPDATE scenes SET prompt = ? WHERE id = ?", (prompt, scene_id))
    await db.commit()


async def update_scene_status(scene_id: int, status: str):
    db = await get_db()
    await db.execute("UPDATE scenes SET status = ? WHERE id = ?", (status, scene_id))
    await db.commit()


async def insert_generated_image(scene_id: int, file_path: str, file_name: str,
                                  width: int, height: int) -> int:
    db = await get_db()
    cursor = await db.execute(
        """INSERT INTO generated_images (scene_id, file_path, file_name, width, height)
           VALUES (?, ?, ?, ?, ?)""",
        (scene_id, file_path, file_name, width, height),
    )
    await db.commit()
    return cursor.lastrowid


async def get_images_for_script(script_id: int) -> list[dict]:
    db = await get_db()
    cursor = await db.execute(
        """SELECT gi.*, s.scene_number
           FROM generated_images gi
           JOIN scenes s ON gi.scene_id = s.id
           WHERE s.script_id = ?
           ORDER BY s.scene_number""",
        (script_id,),
    )
    return [dict(r) for r in await cursor.fetchall()]


async def get_all_images() -> list[dict]:
    db = await get_db()
    cursor = await db.execute(
        """SELECT gi.*, s.scene_number
           FROM generated_images gi
           JOIN scenes s ON gi.scene_id = s.id
           ORDER BY s.scene_number"""
    )
    return [dict(r) for r in await cursor.fetchall()]


async def delete_images_for_scene(scene_id: int) -> list[str]:
    """Delete all generated images for a scene. Returns list of file_paths for cleanup."""
    db = await get_db()
    cursor = await db.execute(
        "SELECT file_path FROM generated_images WHERE scene_id = ?", (scene_id,)
    )
    rows = await cursor.fetchall()
    file_paths = [r["file_path"] for r in rows]
    await db.execute("DELETE FROM generated_images WHERE scene_id = ?", (scene_id,))
    await db.commit()
    return file_paths


async def delete_scene(scene_id: int) -> list[str]:
    """Delete a scene and its images. Returns list of file_paths for cleanup."""
    file_paths = await delete_images_for_scene(scene_id)
    db = await get_db()
    await db.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
    await db.commit()
    return file_paths


async def update_scene_error(scene_id: int, error_message: str):
    """Store error message for a scene."""
    db = await get_db()
    await db.execute(
        "UPDATE scenes SET status = 'error', error_message = ? WHERE id = ?",
        (error_message, scene_id),
    )
    await db.commit()
