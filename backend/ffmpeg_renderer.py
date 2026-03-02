"""
FFmpeg Batch Renderer — Converts images to 8-second static videos.

Scans an image folder and renders each image as a 1920×1080 video (8s)
using FFmpeg with letterboxing to preserve aspect ratio.

Uses ThreadPoolExecutor for parallel rendering.
"""

import subprocess
import shutil
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from dataclasses import dataclass, field
from typing import Callable, Optional

# Supported image extensions
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

# Default render settings
DEFAULT_WIDTH = 1920
DEFAULT_HEIGHT = 1080
DEFAULT_DURATION = 8
DEFAULT_MAX_WORKERS = 4


@dataclass
class RenderJob:
    """Represents a single image → video render job."""
    image_path: Path
    output_path: Path
    status: str = "pending"          # pending | rendering | success | error
    error_message: str = ""
    progress_pct: float = 0.0


@dataclass
class RenderResult:
    """Result summary for one render job."""
    image_name: str
    video_name: str
    status: str
    error_message: str = ""
    duration_sec: float = 0.0


class FfmpegBatchRenderer:
    """
    Batch renderer that converts images to static videos using FFmpeg.

    Usage:
        renderer = FfmpegBatchRenderer(width=1920, height=1080, duration=8)
        results = renderer.process_folder(input_dir, output_dir, max_workers=4)
    """

    def __init__(
        self,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
        duration: int = DEFAULT_DURATION,
        ffmpeg_path: str = "ffmpeg",
    ):
        self.width = width
        self.height = height
        self.duration = duration
        self.ffmpeg_path = ffmpeg_path
        self._jobs: dict[str, RenderJob] = {}
        self._validate_ffmpeg()

    def _validate_ffmpeg(self):
        """Check that ffmpeg is available on the system PATH."""
        path = shutil.which(self.ffmpeg_path)
        if path is None:
            raise RuntimeError(
                f"FFmpeg not found at '{self.ffmpeg_path}'. "
                "Please install FFmpeg and ensure it is on your PATH."
            )
        self.ffmpeg_path = path

    def _build_ffmpeg_command(self, image_path: Path, output_path: Path) -> list[str]:
        """
        Build the FFmpeg command for a single image → video conversion.

        Uses scale + pad filters to:
        - Scale image to fit within target resolution while preserving aspect ratio
        - Add black letterbox/pillarbox bars to fill the frame
        """
        # Filter chain:
        # 1. scale to fit within WxH keeping aspect ratio
        # 2. pad to exactly WxH centered
        vf = (
            f"scale={self.width}:{self.height}:force_original_aspect_ratio=decrease,"
            f"pad={self.width}:{self.height}:(ow-iw)/2:(oh-ih)/2:color=black"
        )

        return [
            self.ffmpeg_path,
            "-y",                          # Overwrite output
            "-loop", "1",                  # Loop the single image
            "-i", str(image_path),         # Input image
            "-t", str(self.duration),      # Duration in seconds
            "-vf", vf,                     # Video filters
            "-c:v", "libx264",             # H.264 codec
            "-tune", "stillimage",         # Optimize for still image
            "-pix_fmt", "yuv420p",         # Pixel format for compatibility
            "-r", "30",                    # Frame rate
            "-movflags", "+faststart",     # Web-friendly MP4
            str(output_path),              # Output file
        ]

    def render_single(
        self,
        image_path: Path,
        output_path: Path,
        on_progress: Optional[Callable[[str, str], None]] = None,
    ) -> RenderResult:
        """
        Render a single image to an 8-second video.

        Args:
            image_path: Path to the source image
            output_path: Path for the output .mp4 file
            on_progress: Optional callback(image_name, status)

        Returns:
            RenderResult with status and details
        """
        image_name = image_path.name
        video_name = output_path.name

        # Update job tracking
        job_key = image_name
        if job_key in self._jobs:
            self._jobs[job_key].status = "rendering"
        if on_progress:
            on_progress(image_name, "rendering")

        cmd = self._build_ffmpeg_command(image_path, output_path)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120,     # 2 min timeout per video
            )

            if result.returncode != 0:
                err = result.stderr[-500:] if result.stderr else "Unknown FFmpeg error"
                if job_key in self._jobs:
                    self._jobs[job_key].status = "error"
                    self._jobs[job_key].error_message = err
                if on_progress:
                    on_progress(image_name, "error")
                return RenderResult(
                    image_name=image_name,
                    video_name=video_name,
                    status="error",
                    error_message=err,
                )

            # Success
            if job_key in self._jobs:
                self._jobs[job_key].status = "success"
            if on_progress:
                on_progress(image_name, "success")

            return RenderResult(
                image_name=image_name,
                video_name=video_name,
                status="success",
            )

        except subprocess.TimeoutExpired:
            err_msg = "FFmpeg timed out after 120 seconds"
            if job_key in self._jobs:
                self._jobs[job_key].status = "error"
                self._jobs[job_key].error_message = err_msg
            if on_progress:
                on_progress(image_name, "error")
            return RenderResult(
                image_name=image_name,
                video_name=video_name,
                status="error",
                error_message=err_msg,
            )
        except Exception as e:
            err_msg = str(e)[:500]
            if job_key in self._jobs:
                self._jobs[job_key].status = "error"
                self._jobs[job_key].error_message = err_msg
            if on_progress:
                on_progress(image_name, "error")
            return RenderResult(
                image_name=image_name,
                video_name=video_name,
                status="error",
                error_message=err_msg,
            )

    def scan_images(self, input_dir: Path) -> list[Path]:
        """Scan a directory for supported image files, sorted by name."""
        if not input_dir.is_dir():
            raise FileNotFoundError(f"Input directory not found: {input_dir}")

        images = sorted(
            p for p in input_dir.iterdir()
            if p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
        )
        return images

    def process_folder(
        self,
        input_dir: str | Path,
        output_dir: str | Path,
        max_workers: int = DEFAULT_MAX_WORKERS,
        on_progress: Optional[Callable[[str, str], None]] = None,
    ) -> list[RenderResult]:
        """
        Process all images in input_dir and render videos to output_dir.

        Args:
            input_dir: Directory containing source images
            output_dir: Directory for output .mp4 files
            max_workers: Number of parallel FFmpeg processes
            on_progress: Optional callback(image_name, status) for each job

        Returns:
            List of RenderResult for each processed image
        """
        input_path = Path(input_dir)
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)

        images = self.scan_images(input_path)
        if not images:
            return []

        # Build job list
        self._jobs.clear()
        jobs: list[tuple[Path, Path]] = []
        for img in images:
            video_name = img.stem + ".mp4"
            video_path = output_path / video_name
            self._jobs[img.name] = RenderJob(
                image_path=img,
                output_path=video_path,
                status="pending",
            )
            jobs.append((img, video_path))

        # Process in parallel
        results: list[RenderResult] = []

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_map = {
                executor.submit(self.render_single, img, vid, on_progress): img.name
                for img, vid in jobs
            }

            for future in as_completed(future_map):
                image_name = future_map[future]
                try:
                    result = future.result()
                    results.append(result)
                except Exception as e:
                    results.append(RenderResult(
                        image_name=image_name,
                        video_name=image_name.rsplit(".", 1)[0] + ".mp4",
                        status="error",
                        error_message=str(e)[:500],
                    ))

        # Sort results by image name to maintain order
        results.sort(key=lambda r: r.image_name)
        return results

    def get_jobs_status(self) -> dict:
        """Get current status of all render jobs."""
        total = len(self._jobs)
        if total == 0:
            return {"total": 0, "pending": 0, "rendering": 0, "success": 0, "error": 0, "jobs": []}

        statuses = [j.status for j in self._jobs.values()]
        return {
            "total": total,
            "pending": statuses.count("pending"),
            "rendering": statuses.count("rendering"),
            "success": statuses.count("success"),
            "error": statuses.count("error"),
            "jobs": [
                {
                    "image_name": j.image_path.name,
                    "video_name": j.output_path.name,
                    "status": j.status,
                    "error_message": j.error_message,
                }
                for j in self._jobs.values()
            ],
        }


# ---------- Singleton ----------
_renderer: FfmpegBatchRenderer | None = None


def get_renderer() -> FfmpegBatchRenderer:
    """Get or create the global FfmpegBatchRenderer instance."""
    global _renderer
    if _renderer is None:
        _renderer = FfmpegBatchRenderer()
    return _renderer
