"""
Scene analysis engine.
Splits raw script text into discrete scenes and generates image prompts.
"""

import re
from dataclasses import dataclass


@dataclass
class ParsedScene:
    scene_number: int
    timestamp_start: str
    timestamp_end: str
    raw_text: str
    prompt: str


# Average seconds per scene for timestamp estimation
_SECONDS_PER_SCENE = 15


def _estimate_timestamp(scene_index: int) -> tuple[str, str]:
    """Generate estimated timestamp range for a scene."""
    start_sec = scene_index * _SECONDS_PER_SCENE
    end_sec = start_sec + _SECONDS_PER_SCENE
    start = f"{start_sec // 60:02d}:{start_sec % 60:02d}"
    end = f"{end_sec // 60:02d}:{end_sec % 60:02d}"
    return start, end


def _generate_prompt(raw_text: str) -> str:
    """
    Generate an image prompt from raw scene text.
    In production, this would call an LLM. Currently uses heuristic extraction.
    """
    # Clean up the text
    text = raw_text.strip()
    if not text:
        return ""

    # Remove scene heading markers
    text = re.sub(r"^Scene\s*\d+[:\.\-]\s*", "", text, flags=re.IGNORECASE)

    # Build a cinematographic prompt
    keywords = []

    # Detect setting descriptors
    if re.search(r"\b(interior|int\.)\b", text, re.IGNORECASE):
        keywords.append("interior shot")
    if re.search(r"\b(exterior|ext\.)\b", text, re.IGNORECASE):
        keywords.append("exterior shot")

    # Detect mood / lighting keywords
    mood_words = ["dark", "neon", "bright", "dim", "shadow", "glow", "light", "fog",
                  "rain", "night", "sunset", "sunrise", "fire", "cold", "warm"]
    for w in mood_words:
        if re.search(rf"\b{w}\b", text, re.IGNORECASE):
            keywords.append(f"{w} lighting")
            break

    # Compose prompt
    base = text[:200].strip()
    style_suffix = "photorealistic, 8k, volumetric lighting, digital art style."
    if keywords:
        prompt = f"Cinematic {', '.join(keywords)} of {base}, {style_suffix}"
    else:
        prompt = f"Cinematic wide shot of {base}, {style_suffix}"

    return prompt


def analyze_script(script_text: str, api_key: str = "") -> list[ParsedScene]:
    """
    Parse script text into a list of scenes using Gemini AI.

    Requires a valid Gemini API key. Raises an error if no key is provided
    or if the API call fails.

    Args:
        script_text: Raw script/story text.
        api_key: Gemini API key.

    Returns:
        List of ParsedScene objects.

    Raises:
        ValueError: If API key is missing or invalid.
        RuntimeError: If the API call fails.
    """
    import asyncio
    from prompt import analyze_script_with_gemini

    if not api_key or not api_key.strip():
        raise ValueError(
            "Gemini API key is required to analyze scripts. "
            "Please enter your Gemini API key in the settings."
        )

    # Run the async Gemini call synchronously
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # We're already in an async context — create a task
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            result = pool.submit(
                asyncio.run,
                analyze_script_with_gemini(script_text, api_key)
            ).result()
    else:
        result = asyncio.run(analyze_script_with_gemini(script_text, api_key))

    # Convert dicts to ParsedScene objects
    scenes = []
    for item in result:
        scenes.append(ParsedScene(
            scene_number=item["scene_number"],
            timestamp_start=item["timestamp_start"],
            timestamp_end=item["timestamp_end"],
            raw_text=item["raw_text"],
            prompt=item["prompt"],
        ))

    return scenes

