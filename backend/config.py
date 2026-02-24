"""
Application configuration with dependency injection support.
Prepared for future cloud migration.
"""

import os
from pathlib import Path
from dataclasses import dataclass, field


@dataclass
class AppConfig:
    """Central application configuration."""

    # Database
    db_path: str = field(default_factory=lambda: os.getenv(
        "AI_STUDIO_DB_PATH",
        str(Path(__file__).parent / "data" / "ai_studio.db")
    ))

    # Output directories
    output_dir: str = field(default_factory=lambda: os.getenv(
        "AI_STUDIO_OUTPUT_DIR",
        str(Path(__file__).parent / "data" / "output")
    ))

    # Image generation
    image_width: int = 768
    image_height: int = 512
    max_concurrent_jobs: int = 3

    # Server
    host: str = "127.0.0.1"
    port: int = 8001
    cors_origins: list[str] = field(default_factory=lambda: ["*"])

    # External AI API (placeholder for future integration)
    ai_api_key: str = field(default_factory=lambda: os.getenv("AI_API_KEY", ""))
    ai_api_url: str = field(default_factory=lambda: os.getenv(
        "AI_API_URL", "https://api.openai.com/v1"
    ))

    def __post_init__(self):
        """Ensure required directories exist."""
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        Path(self.output_dir).mkdir(parents=True, exist_ok=True)


# Singleton instance
_config: AppConfig | None = None


def get_config() -> AppConfig:
    """Dependency injection: retrieve the global config."""
    global _config
    if _config is None:
        _config = AppConfig()
    return _config
