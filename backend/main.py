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
    GenerateAudioPromptRequest, GenerateAudioPromptResponse,
    SaveApPromptsRequest,
    VideoRenderRequest, VideoRenderSingleRequest,
)
from scene_analyzer import analyze_script, analyze_script_by_regex
from prompt import generate_single_audio_prompt
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
    """Analyze script text and split into scenes with generated prompts."""
    script_id = req.script_id
    word_count = len(req.script_text.split())

    # Save script content
    await save_script(script_id, req.script_text, word_count)

    # Clear existing scenes
    await delete_scenes_for_script(script_id)

    # Parse scenes
    try:
        parsed = analyze_script(req.script_text, api_key=req.gemini_api_key)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))

    if not parsed:
        raise HTTPException(status_code=400, detail="No scenes could be parsed from the script.")

    # Persist scenes
    scene_list: list[SceneData] = []
    for ps in parsed:
        sid = await insert_scene(
            script_id=script_id,
            scene_number=ps.scene_number,
            ts_start=ps.timestamp_start,
            ts_end=ps.timestamp_end,
            raw_text=ps.raw_text,
            prompt=ps.prompt,
        )
        scene_list.append(SceneData(
            id=sid,
            scene_number=ps.scene_number,
            timestamp_start=ps.timestamp_start,
            timestamp_end=ps.timestamp_end,
            raw_text=ps.raw_text,
            prompt=ps.prompt,
            status="pending",
        ))

    return ScriptAnalyzeResponse(
        script_id=script_id,
        total_scenes=len(scene_list),
        scenes=scene_list,
    )


@app.post("/analyze-script-regex", response_model=ScriptAnalyzeResponse)
async def api_analyze_script_regex(req: ScriptAnalyzeRequest):
    """Analyze script text and split into scenes with regex-based rules."""
    script_id = req.script_id
    word_count = len(req.script_text.split())

    await save_script(script_id, req.script_text, word_count)
    await delete_scenes_for_script(script_id)

    try:
        parsed = analyze_script_by_regex(req.script_text)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))

    if not parsed:
        raise HTTPException(status_code=400, detail="No scenes could be parsed from the script.")

    scene_list: list[SceneData] = []
    for ps in parsed:
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


@app.post("/generate-audio-prompt", response_model=GenerateAudioPromptResponse)
async def api_generate_audio_prompt(req: GenerateAudioPromptRequest):
    """Generate a single image prompt for an audio-synced sequence."""
    try:
        prompt_text = await generate_single_audio_prompt(
            script_text=req.script_text,
            prompt_index=req.prompt_index,
            total_prompts=req.total_prompts,
            visual_style=req.visual_style,
            api_key=req.gemini_api_key
        )
        return GenerateAudioPromptResponse(prompt=prompt_text)
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))


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


# AP_SCRIPT_ID is a reserved script_id dedicated for Auto Prompter scenes
AP_SCRIPT_ID = 2

@app.post("/ap/save-prompts")
async def api_save_ap_prompts(req: SaveApPromptsRequest):
    """Save Auto Prompter generated prompts as scenes in script_id=2 for image generation."""
    await delete_scenes_for_script(AP_SCRIPT_ID)
    await save_script(AP_SCRIPT_ID, "auto_prompter", len(req.prompts))

    scene_list = []
    for i, prompt_text in enumerate(req.prompts):
        scene_number = i + 1
        ts_start_sec = int(i * req.pacing)
        ts_end_sec = int((i + 1) * req.pacing)
        def fmt(s): return f"{s // 60:02d}:{s % 60:02d}"
        sid = await insert_scene(
            script_id=AP_SCRIPT_ID,
            scene_number=scene_number,
            ts_start=fmt(ts_start_sec),
            ts_end=fmt(ts_end_sec),
            raw_text=prompt_text,
            prompt=prompt_text,
        )
        scene_list.append({"id": sid, "scene_number": scene_number, "prompt": prompt_text})

    return {"status": "ok", "total": len(scene_list), "script_id": AP_SCRIPT_ID, "scenes": scene_list}


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
    scenes: list[dict] = await get_scenes_for_script(script_id)
    images: list[dict] = await get_images_for_script(script_id)

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


# ---------- Video Render Endpoints ----------

# Background task state for video rendering
_video_render_state = {
    "running": False,
    "results": [],
    "total": 0,
    "completed": 0,
    "errors": 0,
    "rendering": 0,
}


@app.post("/video/scan")
async def api_video_scan(req: VideoRenderRequest):
    """Scan input directory for images and return file list."""
    from ffmpeg_renderer import get_renderer
    renderer = get_renderer()
    input_path = Path(req.input_dir)

    if not input_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {req.input_dir}")

    try:
        images = renderer.scan_images(input_path)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    return {
        "status": "ok",
        "input_dir": str(input_path),
        "total": len(images),
        "images": [
            {
                "name": img.name,
                "path": str(img),
                "size_kb": round(img.stat().st_size / 1024, 1),
            }
            for img in images
        ],
    }


@app.post("/video/render")
async def api_video_render(req: VideoRenderRequest):
    """
    Start batch rendering all images in input_dir to videos.
    Runs in background thread pool.
    """
    import asyncio
    from ffmpeg_renderer import FfmpegBatchRenderer

    input_path = Path(req.input_dir)
    output_path = Path(req.output_dir) if req.output_dir else input_path / "clips"

    if not input_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {req.input_dir}")

    if _video_render_state["running"]:
        raise HTTPException(status_code=409, detail="A render job is already running.")

    renderer = FfmpegBatchRenderer(
        duration=req.duration,
    )
    images = renderer.scan_images(input_path)
    if not images:
        raise HTTPException(status_code=400, detail="No images found in the directory.")

    # Reset state
    _video_render_state["running"] = True
    _video_render_state["results"] = []
    _video_render_state["total"] = len(images)
    _video_render_state["completed"] = 0
    _video_render_state["errors"] = 0
    _video_render_state["rendering"] = 0

    def on_progress(image_name, status):
        if status == "rendering":
            _video_render_state["rendering"] += 1
        elif status == "success":
            _video_render_state["completed"] += 1
            _video_render_state["rendering"] = max(0, _video_render_state["rendering"] - 1)
        elif status == "error":
            _video_render_state["errors"] += 1
            _video_render_state["rendering"] = max(0, _video_render_state["rendering"] - 1)

    def run_render():
        try:
            results = renderer.process_folder(
                input_dir=str(input_path),
                output_dir=str(output_path),
                max_workers=req.max_workers,
                on_progress=on_progress,
            )
            _video_render_state["results"] = [
                {
                    "image_name": r.image_name,
                    "video_name": r.video_name,
                    "status": r.status,
                    "error_message": r.error_message,
                }
                for r in results
            ]
        except Exception as e:
            print(f"[VideoRender] Fatal error: {e}")
        finally:
            _video_render_state["running"] = False

    # Run in background thread to not block the event loop
    import threading
    t = threading.Thread(target=run_render, daemon=True)
    t.start()

    return {
        "status": "ok",
        "message": f"Started rendering {len(images)} videos",
        "total": len(images),
        "output_dir": str(output_path),
    }


@app.get("/video/status")
async def api_video_status():
    """Get current video render progress."""
    return {
        "running": _video_render_state["running"],
        "total": _video_render_state["total"],
        "completed": _video_render_state["completed"],
        "errors": _video_render_state["errors"],
        "rendering": _video_render_state["rendering"],
        "results": _video_render_state["results"],
    }


@app.post("/video/render-single")
async def api_video_render_single(req: VideoRenderSingleRequest):
    """Render a single image to video (synchronous)."""
    from ffmpeg_renderer import FfmpegBatchRenderer

    image_path = Path(req.image_path)
    if not image_path.is_file():
        raise HTTPException(status_code=400, detail=f"Image not found: {req.image_path}")

    output_dir = Path(req.output_dir) if req.output_dir else image_path.parent / "clips"
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / (image_path.stem + ".mp4")

    renderer = FfmpegBatchRenderer(duration=req.duration)
    result = renderer.render_single(image_path, output_path)

    return {
        "status": result.status,
        "image_name": result.image_name,
        "video_name": result.video_name,
        "error_message": result.error_message,
    }


# ---------- Run directly ----------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=cfg.host, port=cfg.port, reload=False)
