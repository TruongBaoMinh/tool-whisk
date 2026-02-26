# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Setup & common commands

### Install dependencies
- Node dependencies (repo root):
  - `npm install`
- Python dependencies (backend):
  - `pip install -r backend/requirements.txt`

### Run in development
- Start Electron app (it auto-spawns backend on `127.0.0.1:8001`):
  - `npm start`
- Start backend only (from repo root):
  - `npm run backend`
- Start backend directly (from `backend/`):
  - `python -m uvicorn main:app --host 127.0.0.1 --port 8001 --reload`

### Build
- Build Python backend executable with PyInstaller:
  - `npm run build:backend`
- Build Electron Windows package:
  - `npm run build:electron`
- Build both:
  - `npm run build`

### Tests / lint
- There is currently no test runner or lint script configured in `package.json` and no repository test suite.

## Important repo-specific notes

- `README.md` mentions `npm run dev`, but this script is not present in `package.json`.
- Backend API port used by the app is `8001` (not `8000`).

## High-level architecture

## 1) Desktop app orchestration (Electron)
- `main.js` is the runtime orchestrator:
  - Creates the BrowserWindow.
  - Spawns backend process.
  - In dev: runs `python -m uvicorn main:app ... --port 8001` in `backend/`.
  - In packaged builds: runs `backend.exe` from Electron `resources`.
  - Injects runtime paths via env vars:
    - `AI_STUDIO_DB_PATH`
    - `AI_STUDIO_OUTPUT_DIR`
- Data location differs by mode:
  - Dev: `backend/data/...`
  - Packaged: `%APPDATA%/.../data/...` via `app.getPath('userData')`.

## 2) Renderer ↔ Backend boundary
- `preload.js` exposes a strict `window.api` bridge using `contextBridge`.
- `renderer.js` contains all UI state and user flows; it never accesses Node APIs directly.
- All frontend actions are API-driven (analyze, generate, status polling, align audio, compose video, export).

## 3) Backend service (FastAPI)
- `backend/main.py` wires app lifecycle:
  - Startup: `init_db()` + start async image queue workers.
  - Shutdown: stop queue + close DB.
- Endpoint groups:
  - Script analysis (`/analyze-script`, `/analyze-script-regex`)
  - Scene/prompt/image generation (`/scenes/*`, `/update-prompt`, `/generate-images`, `/regenerate`, `/status/*`, `/export-zip`)
  - Audio/video pipeline (`/align-audio`, `/export-srt`, `/compose-video`)
  - JSON pipeline (`/pipeline/export-alignment-json`, `/pipeline/import-alignment-generate-prompts`, `/pipeline/compose-video-from-json`)

## 4) Persistence model (SQLite via aiosqlite)
- `backend/database.py` is the data-access layer and schema owner.
- Core tables:
  - `projects`, `scripts`, `scenes`, `generated_images`, `audio_files`
- `scenes` tracks both generation state and alignment state:
  - `status`, `error_message`, `audio_start_ms`, `audio_end_ms`
- Schema migration is handled inline in `init_db()` with additive `ALTER TABLE` attempts.

## 5) Generation and media pipeline
- Image generation (`backend/image_generator.py`):
  - Singleton async queue.
  - Token-aware worker pool (`3 workers per token`).
  - Scene lifecycle: `pending -> generating -> success|error`.
  - Writes generated image metadata to DB and files to output dir.
- Alignment (`backend/whisper_aligner.py`):
  - Uses WhisperX to produce per-scene `audio_start_ms` / `audio_end_ms`.
  - Alignment mapping is positional by scene order.
- Video composition (`backend/video_composer.py`):
  - Builds FFmpeg concat timeline from image durations derived from aligned timestamps.
  - Muxes with audio; optional burned subtitles from generated SRT.

## 6) Configuration
- `backend/config.py` centralizes runtime config (DB path, output dir, server settings, worker count).
- `get_config()` is a singleton used across backend modules.
- FastAPI serves generated assets from `cfg.output_dir` at `/static`.
