"""
FastAPI application — AI Studio backend.
Provides REST endpoints for script analysis, image generation, and export.
"""

import os
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from config import get_config
from database import (
    init_db, close_db,
    save_script, get_scenes_for_script, delete_scenes_for_script,
    insert_scene, update_scene_prompt, update_scene_status,
    get_images_for_script, list_projects, get_all_images,
    delete_scene, delete_images_for_scene,
)
from models import (
    ScriptAnalyzeRequest, ScriptAnalyzeResponse, SceneData,
    GenerateImagesRequest, RegenerateRequest, UpdatePromptRequest,
    GenerationStatus, ImageData, ExportResponse,
)
from image_generator import get_queue


# ---------- Lifespan ----------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown hooks."""
    await init_db()
    queue = get_queue()
    cfg = get_config()
    await queue.start(num_workers=cfg.max_concurrent_jobs)
    yield
    await queue.stop()
    await close_db()


# ---------- App ----------

app = FastAPI(
    title="AI Studio API",
    version="1.0.0",
    lifespan=lifespan,
)

cfg = get_config()

app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve generated images as static files
os.makedirs(cfg.output_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=cfg.output_dir), name="static")


# ---------- Endpoints ----------

@app.get("/")
async def root():
    return {"status": "ok", "service": "AI Studio API", "version": "1.0.0"}


@app.get("/projects")
async def api_list_projects():
    """List all projects."""
    projects = await list_projects()
    return {"projects": projects}


@app.post("/analyze-script", response_model=ScriptAnalyzeResponse)
async def api_analyze_script(req: ScriptAnalyzeRequest):
    """Analyze script text using Gemini AI and split into scenes with generated prompts."""
    import logging
    logger = logging.getLogger(__name__)

    script_id = req.script_id
    word_count = len(req.script_text.split())

    # Save script content
    await save_script(script_id, req.script_text, word_count)

    # Clear existing scenes
    await delete_scenes_for_script(script_id)

    # Call Gemini API for scene analysis
    from prompt import analyze_script_with_gemini

    try:
        parsed_dicts = await analyze_script_with_gemini(req.script_text, req.gemini_api_key)
    except ValueError as e:
        logger.error(f"Gemini API key error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        logger.error(f"Gemini API error: {e}")
        raise HTTPException(status_code=400, detail=str(e))

    if not parsed_dicts:
        raise HTTPException(status_code=400, detail="No scenes could be parsed from the script.")

    # Persist scenes
    scene_list: list[SceneData] = []
    for ps in parsed_dicts:
        sid = await insert_scene(
            script_id=script_id,
            scene_number=ps["scene_number"],
            ts_start=ps["timestamp_start"],
            ts_end=ps["timestamp_end"],
            raw_text=ps["raw_text"],
            prompt=ps["prompt"],
        )
        scene_list.append(SceneData(
            id=sid,
            scene_number=ps["scene_number"],
            timestamp_start=ps["timestamp_start"],
            timestamp_end=ps["timestamp_end"],
            raw_text=ps["raw_text"],
            prompt=ps["prompt"],
            status="pending",
        ))

    return ScriptAnalyzeResponse(
        script_id=script_id,
        total_scenes=len(scene_list),
        scenes=scene_list,
    )


@app.get("/scenes/{script_id}")
async def api_get_scenes(script_id: int):
    """Get all scenes for a script."""
    scenes = await get_scenes_for_script(script_id)
    return {"script_id": script_id, "scenes": scenes}


@app.post("/update-prompt")
async def api_update_prompt(req: UpdatePromptRequest):
    """Update a scene's image prompt."""
    await update_scene_prompt(req.scene_id, req.prompt)
    return {"status": "ok", "scene_id": req.scene_id}


@app.post("/generate-images")
async def api_generate_images(req: GenerateImagesRequest):
    """Queue all pending scenes for image generation."""
    scenes = await get_scenes_for_script(req.script_id)
    if not scenes:
        raise HTTPException(status_code=404, detail="No scenes found for this script.")

    queue = get_queue()

    # Restart workers with the provided token list
    if req.access_token:
        await queue.restart_with_tokens(req.access_token)

    queued = 0

    for scene in scenes:
        if scene["status"] in ("pending", "error"):
            prompt = scene["prompt"] or ""
            if not prompt.strip():
                await update_scene_status(scene["id"], "pending")
                from scene_analyzer import _generate_prompt
                prompt = _generate_prompt(scene.get("raw_text", "") or "")
                if prompt:
                    await update_scene_prompt(scene["id"], prompt)
            await update_scene_status(scene["id"], "pending")
            await queue.enqueue(
                scene_id=scene["id"],
                prompt=prompt,
                scene_number=scene["scene_number"],
            )
            queued += 1

    return {"status": "ok", "queued": queued, "total_scenes": len(scenes)}


@app.post("/regenerate")
async def api_regenerate(req: RegenerateRequest):
    """Regenerate image for a single scene."""
    from database import get_db
    db_conn = await get_db()
    cursor = await db_conn.execute("SELECT * FROM scenes WHERE id = ?", (req.scene_id,))
    scene = await cursor.fetchone()

    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found.")

    scene = dict(scene)
    await update_scene_status(req.scene_id, "pending")

    queue = get_queue()

    # Restart workers with the provided token list (if changed)
    if req.access_token:
        await queue.restart_with_tokens(req.access_token)

    prompt = scene["prompt"] or ""
    if not prompt.strip():
        from scene_analyzer import _generate_prompt
        prompt = _generate_prompt(scene.get("raw_text", "") or "")
        if prompt:
            await update_scene_prompt(req.scene_id, prompt)

    await queue.enqueue(
        scene_id=req.scene_id,
        prompt=prompt,
        scene_number=scene["scene_number"],
    )

    return {"status": "ok", "scene_id": req.scene_id}


@app.delete("/scenes/{scene_id}")
async def api_delete_scene(scene_id: int):
    """Delete a scene and its generated images."""
    from database import get_db
    db_conn = await get_db()
    cursor = await db_conn.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,))
    scene = await cursor.fetchone()

    if not scene:
        raise HTTPException(status_code=404, detail="Scene not found.")

    file_paths = await delete_scene(scene_id)

    # Clean up image files from disk
    for fp in file_paths:
        try:
            Path(fp).unlink(missing_ok=True)
        except Exception:
            pass

    return {"status": "ok", "scene_id": scene_id}


@app.get("/status/{script_id}", response_model=GenerationStatus)
async def api_get_status(script_id: int):
    """Get generation progress for a script."""
    scenes = await get_scenes_for_script(script_id)
    images = await get_images_for_script(script_id)

    total = len(scenes)
    completed = sum(1 for s in scenes if s["status"] == "success")
    generating = sum(1 for s in scenes if s["status"] == "generating")
    pending = sum(1 for s in scenes if s["status"] == "pending")
    errors = sum(1 for s in scenes if s["status"] == "error")

    image_list = [
        ImageData(
            id=img["id"],
            scene_id=img["scene_id"],
            scene_number=img["scene_number"],
            file_name=img["file_name"],
            url=f"/static/{img['file_name']}",
            width=img["width"],
            height=img["height"],
        )
        for img in images
    ]

    return GenerationStatus(
        script_id=script_id,
        total=total,
        completed=completed,
        generating=generating,
        pending=pending,
        errors=errors,
        images=image_list,
    )


@app.get("/export-zip")
async def api_export_zip(script_id: int = 1):
    """Export all generated images as a ZIP file."""
    images = await get_images_for_script(script_id)
    if not images:
        raise HTTPException(status_code=404, detail="No images to export.")

    zip_name = f"ai_studio_export_{script_id}.zip"
    zip_path = str(Path(cfg.output_dir) / zip_name)

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for img in images:
            img_path = img["file_path"]
            if os.path.exists(img_path):
                zf.write(img_path, img["file_name"])

    return FileResponse(
        path=zip_path,
        filename=zip_name,
        media_type="application/zip",
    )


# ---------- Run directly ----------

if __name__ == "__main__":
    import sys
    import uvicorn

    # When run as PyInstaller exe, reload is not supported
    is_frozen = getattr(sys, 'frozen', False)
    uvicorn.run(
        app,  # Use app object directly (required for PyInstaller)
        host=cfg.host,
        port=cfg.port,
        reload=not is_frozen,
        log_level="info" if is_frozen else "debug",
    )
