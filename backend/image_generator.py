"""
Async image generation queue.
Uses httpx to call the Google Whisk API for real image generation.
Falls back to placeholder images when no access token is configured.

Supports multiple access tokens — each token spawns 3 dedicated workers
for higher parallelism.
"""

import asyncio
import base64
import json
import random
import uuid
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFont

from config import get_config
import database as db

# Number of workers to spawn per access token
WORKERS_PER_TOKEN = 3


class ImageGenerationQueue:
    """Async background queue for image generation jobs."""

    # URL for the Whisk API
    WHISK_API_URL = "https://aisandbox-pa.googleapis.com/v1/whisk:generateImage"

    def __init__(self):
        self._queue: asyncio.Queue = asyncio.Queue()
        self._workers: list[asyncio.Task] = []
        self._running = False
        self._tokens: list[str] = []
        self._token_index = 0  # Round-robin index for regeneration

    async def start(self, num_workers: int = 3):
        """Start background worker tasks (placeholder/fallback mode)."""
        if self._running:
            return
        self._running = True
        for i in range(num_workers):
            task = asyncio.create_task(self._worker(f"worker-{i}", token=""))
            self._workers.append(task)
        print(f"[Queue] Started {num_workers} fallback workers (no tokens)")

    async def stop(self):
        """Gracefully stop all workers."""
        self._running = False
        # Drain the queue
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
                self._queue.task_done()
            except asyncio.QueueEmpty:
                break
        # Cancel workers
        for w in self._workers:
            w.cancel()
        self._workers.clear()

    async def restart_with_tokens(self, tokens: list[str]):
        """
        Stop existing workers, update token list, and spawn new workers.
        Each token gets WORKERS_PER_TOKEN (3) dedicated workers.
        If tokens list is empty, spawn 3 fallback workers.
        """
        # Only restart if the token set has actually changed
        if set(tokens) == set(self._tokens) and self._workers:
            return

        await self.stop()
        self._tokens = list(tokens)
        self._token_index = 0
        self._running = True

        if tokens:
            for t_idx, token in enumerate(tokens):
                for w_idx in range(WORKERS_PER_TOKEN):
                    name = f"token-{t_idx}-worker-{w_idx}"
                    task = asyncio.create_task(self._worker(name, token=token))
                    self._workers.append(task)
            total = len(tokens) * WORKERS_PER_TOKEN
            print(f"[Queue] Started {total} workers ({len(tokens)} tokens × {WORKERS_PER_TOKEN} workers each)")
        else:
            for i in range(WORKERS_PER_TOKEN):
                task = asyncio.create_task(self._worker(f"worker-{i}", token=""))
                self._workers.append(task)
            print(f"[Queue] Started {WORKERS_PER_TOKEN} fallback workers (no tokens)")

    def get_next_token(self) -> str:
        """Get the next token via round-robin (used for single regeneration)."""
        if not self._tokens:
            return ""
        token = self._tokens[self._token_index % len(self._tokens)]
        self._token_index += 1
        return token

    async def enqueue(self, scene_id: int, prompt: str, scene_number: int):
        """Add an image generation job to the queue."""
        await self._queue.put({
            "scene_id": scene_id,
            "prompt": prompt,
            "scene_number": scene_number,
        })

    @property
    def pending_count(self) -> int:
        return self._queue.qsize()

    @property
    def worker_count(self) -> int:
        return len(self._workers)

    @property
    def token_count(self) -> int:
        return len(self._tokens)

    async def _worker(self, name: str, token: str):
        """Process jobs from the queue using the assigned token."""
        while self._running:
            try:
                job = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            scene_id = job["scene_id"]
            prompt = job["prompt"] if isinstance(job["prompt"], str) else ""
            scene_number = job["scene_number"]

            if not prompt.strip():
                print(f"[{name}] ✗ Scene {scene_id} has empty prompt, skipping")
                await db.update_scene_error(scene_id, "Prompt is empty. Please edit the prompt and regenerate.")
                self._queue.task_done()
                continue

            try:
                print(f"[{name}] Processing scene {scene_id} (scene #{scene_number})")
                await db.update_scene_status(scene_id, "generating")

                # Delete old images for this scene (so regenerate replaces)
                old_paths = await db.delete_images_for_scene(scene_id)
                for old_path in old_paths:
                    try:
                        Path(old_path).unlink(missing_ok=True)
                    except Exception:
                        pass

                if token:
                    # Call real Whisk API with the assigned token
                    file_path, file_name, width, height = await self._generate_with_whisk(
                        prompt, scene_number, token
                    )
                else:
                    # Fallback to placeholder
                    file_path, file_name = await self._generate_placeholder(
                        prompt, scene_number
                    )
                    cfg = get_config()
                    width, height = cfg.image_width, cfg.image_height

                # Save to database
                await db.insert_generated_image(
                    scene_id=scene_id,
                    file_path=file_path,
                    file_name=file_name,
                    width=width,
                    height=height,
                )
                await db.update_scene_status(scene_id, "success")
                print(f"[{name}] ✓ Scene {scene_id} completed")

            except Exception as e:
                err_msg = str(e)[:500]
                print(f"[{name}] ✗ Error generating image for scene {scene_id}: {e}")
                await db.update_scene_error(scene_id, err_msg)
            finally:
                self._queue.task_done()
    async def _generate_with_whisk(self, prompt: str, scene_number: int, token: str) -> tuple[str, str, int, int]:
        """
        Call the Google Whisk API to generate an image.
        Returns (file_path, file_name, width, height).
        """
        cfg = get_config()

        token_str = token if isinstance(token, str) else ""
        print(
            f"[Whisk] Scene {scene_number}: preparing request | prompt_len={len(str(prompt).strip())} | "
            f"token_present={'yes' if bool(token_str) else 'no'} | token_len={len(token_str)}"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Referer": "https://labs.google/",
            "User-Agent": "Mozilla/5.0",
            "Content-Type": "text/plain;charset=UTF-8",
        }

        # Ensure prompt is a valid non-empty string
        if not isinstance(prompt, str) or not prompt.strip():
            raise Exception("Prompt must be a valid non-empty string")

        payload = {
            "clientContext": {
                "workflowId": str(uuid.uuid4()),
                "tool": "BACKBONE",
                "sessionId": f";{uuid.uuid4().int % 10**13}"
            },
            "imageModelSettings": {
                "imageModel": "IMAGEN_3_5",
                "aspectRatio": "IMAGE_ASPECT_RATIO_LANDSCAPE"
            },
            "seed": random.randint(100000, 999999),
            "prompt": str(prompt).strip(),
            "mediaCategory": "MEDIA_CATEGORY_BOARD"
        }

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    self.WHISK_API_URL,
                    headers=headers,
                    data=json.dumps(payload),
                )
        except Exception as e:
            print(f"[Whisk] Scene {scene_number}: request exception: {type(e).__name__}: {e}")
            raise

        print(
            f"[Whisk] Scene {scene_number}: response status={response.status_code} | "
            f"content_type={response.headers.get('content-type', '')}"
        )

        if response.status_code != 200:
            body_preview = response.text[:500]
            print(f"[Whisk] Scene {scene_number}: error body: {body_preview}")
            raise Exception(f"Whisk API failed ({response.status_code}): {body_preview}")

        data = response.json()
        response_keys = list(data.keys())
        print(f"[Whisk] Scene {scene_number}: response key count={len(response_keys)}")

        # Parse the response: extract the first generated image
        image_panels = data.get("imagePanels", [])
        if not image_panels:
            raise Exception("Whisk API returned no imagePanels")

        generated_images = image_panels[0].get("generatedImages", [])
        if not generated_images:
            raise Exception("Whisk API returned no generatedImages")

        encoded_image = generated_images[0].get("encodedImage")
        if not encoded_image:
            raise Exception("Whisk API returned no encodedImage data")

        # Decode base64 image and save to disk
        image_bytes = base64.b64decode(encoded_image)

        file_name = f"scene_{scene_number:02d}_{uuid.uuid4().hex[:8]}.jpg"
        file_path = str(Path(cfg.output_dir) / file_name)

        with open(file_path, "wb") as f:
            f.write(image_bytes)

        # Get image dimensions
        img = Image.open(file_path)
        width, height = img.size
        img.close()

        return file_path, file_name, width, height

    async def _generate_placeholder(self, prompt: str, scene_number: int) -> tuple[str, str]:
        """
        Generate a placeholder image with gradient + text.
        Used as fallback when no access token is provided.
        """
        cfg = get_config()
        w, h = cfg.image_width, cfg.image_height

        # Simulate processing delay (1-3 seconds)
        await asyncio.sleep(random.uniform(1.0, 3.0))

        # Create gradient image
        img = Image.new("RGB", (w, h))
        draw = ImageDraw.Draw(img)

        # Random dark cinematic colors
        palettes = [
            ((20, 10, 40), (80, 30, 10)),    # purple-orange
            ((10, 25, 40), (10, 60, 60)),     # deep blue-teal
            ((30, 10, 10), (100, 40, 10)),    # dark red-amber
            ((10, 10, 30), (40, 20, 60)),     # navy-violet
            ((15, 20, 10), (50, 70, 20)),     # dark green
        ]
        c1, c2 = random.choice(palettes)

        for y in range(h):
            r = int(c1[0] + (c2[0] - c1[0]) * y / h)
            g = int(c1[1] + (c2[1] - c1[1]) * y / h)
            b = int(c1[2] + (c2[2] - c1[2]) * y / h)
            draw.line([(0, y), (w, y)], fill=(r, g, b))

        # Add scene label
        try:
            font = ImageFont.truetype("arial.ttf", 28)
            small_font = ImageFont.truetype("arial.ttf", 14)
        except OSError:
            font = ImageFont.load_default()
            small_font = font

        label = f"Scene {scene_number:02d}"
        draw.text((20, 20), label, fill=(255, 255, 255), font=font)

        # Add truncated prompt text
        prompt_short = prompt[:80] + "..." if len(prompt) > 80 else prompt
        draw.text((20, h - 40), prompt_short, fill=(180, 180, 180), font=small_font)

        # Save
        file_name = f"scene_{scene_number:02d}_{uuid.uuid4().hex[:8]}.png"
        file_path = str(Path(cfg.output_dir) / file_name)
        img.save(file_path, "PNG")

        return file_path, file_name


# Singleton
_queue: ImageGenerationQueue | None = None


def get_queue() -> ImageGenerationQueue:
    """Dependency injection: retrieve the global queue instance."""
    global _queue
    if _queue is None:
        _queue = ImageGenerationQueue()
    return _queue
