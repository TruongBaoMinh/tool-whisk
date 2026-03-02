import sqlite3
import os

db_path = os.path.join(os.path.dirname(__file__), "backend", "data", "ai_studio.db")
print(f"DB path: {db_path}")

conn = sqlite3.connect(db_path)
conn.execute("INSERT OR IGNORE INTO scripts (id, project_id, title) VALUES (2, 1, 'Auto Prompter')")
conn.commit()

row = conn.execute("SELECT * FROM scripts WHERE id=2").fetchone()
print(f"script_id=2 row: {row}")

all_scripts = conn.execute("SELECT id, project_id, title FROM scripts").fetchall()
print(f"All scripts: {all_scripts}")

conn.close()
print("Done!")
