# AI Studio — Desktop AI Image Automation Tool

Electron + FastAPI desktop application for AI-powered script analysis and image generation.

## Prerequisites

- **Node.js** 18+
- **Python** 3.11+
- **pip** (Python package manager)

## Setup

### 1. Install Python dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Install Node.js dependencies

```bash
npm install
```

## Running

### Option A: Run both together

```bash
npm run dev
```

### Option B: Run separately

**Terminal 1 — Backend:**
```bash
cd backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

**Terminal 2 — Frontend:**
```bash
npm start
```

### Option C: Backend only (for API testing)

```bash
cd backend
python main.py
```

Then open http://127.0.0.1:8000/docs for the interactive API docs.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/analyze-script` | Split script into scenes |
| POST | `/generate-images` | Queue all scenes for generation |
| POST | `/regenerate` | Regenerate a single scene |
| POST | `/update-prompt` | Update scene prompt text |
| GET | `/scenes/{id}` | Get scenes for a script |
| GET | `/status/{id}` | Get generation progress |
| GET | `/export-zip` | Download all images as ZIP |
| GET | `/projects` | List projects |

## Project Structure

```
├── main.js              # Electron main process
├── preload.js           # Context bridge
├── renderer.js          # Frontend logic
├── index.html           # UI layout
├── styles.css           # Dark theme
├── package.json
└── backend/
    ├── main.py           # FastAPI endpoints
    ├── config.py         # Configuration
    ├── database.py       # SQLite layer
    ├── models.py         # Pydantic schemas
    ├── scene_analyzer.py # Script parsing
    ├── image_generator.py# Async generation queue
    └── requirements.txt
```
