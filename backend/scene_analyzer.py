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


def _normalize_scene_text(text: str) -> str:
    """Normalize scene text while preserving readable structure."""
    lines = [line.strip() for line in text.splitlines()]
    compact = "\n".join(line for line in lines if line)
    return compact.strip()


def _split_by_heading(script_text: str) -> list[str]:
    """Split script by common scene heading patterns."""
    heading_re = re.compile(
        r"^(?:scene\s*\d+\s*[:\.-]?|(?:int|ext)\.|interior\b|exterior\b)",
        flags=re.IGNORECASE,
    )

    blocks: list[str] = []
    current: list[str] = []

    for raw_line in script_text.splitlines():
        line = raw_line.strip()
        if not line:
            if current and current[-1] != "":
                current.append("")
            continue

        if heading_re.match(line):
            if current:
                block = _normalize_scene_text("\n".join(current))
                if block:
                    blocks.append(block)
            current = [line]
        else:
            if not current:
                current = [line]
            else:
                current.append(line)

    if current:
        block = _normalize_scene_text("\n".join(current))
        if block:
            blocks.append(block)

    return blocks


def _split_by_paragraph(script_text: str) -> list[str]:
    """Split script by paragraph blocks (blank-line separated)."""
    parts = re.split(r"\n\s*\n+", script_text.strip())
    blocks = [_normalize_scene_text(part) for part in parts]
    return [b for b in blocks if b]


def _split_by_sentence_window(script_text: str, max_words: int = 90) -> list[str]:
    """Split long scripts into sentence windows as final fallback."""
    clean_text = re.sub(r"\s+", " ", script_text).strip()
    if not clean_text:
        return []

    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean_text) if s.strip()]
    if not sentences:
        return []

    # If no sentence punctuation exists, split by fixed word windows.
    if len(sentences) == 1:
        words = clean_text.split()
        if len(words) <= max_words:
            return [clean_text]
        return [" ".join(words[i:i + max_words]).strip() for i in range(0, len(words), max_words)]

    blocks: list[str] = []
    current: list[str] = []
    current_words = 0

    for sentence in sentences:
        word_count = len(sentence.split())
        if current and current_words + word_count > max_words:
            blocks.append(" ".join(current).strip())
            current = [sentence]
            current_words = word_count
        else:
            current.append(sentence)
            current_words += word_count

    if current:
        blocks.append(" ".join(current).strip())

    return [b for b in blocks if b]


def analyze_script_by_regex(script_text: str) -> list[dict]:
    """Parse script into scenes using deterministic regex/fallback rules."""
    script_text = script_text.strip()
    if not script_text:
        return []

    blocks = _split_by_heading(script_text)

    if len(blocks) < 2:
        paragraph_blocks = _split_by_paragraph(script_text)
        if len(paragraph_blocks) > len(blocks):
            blocks = paragraph_blocks

    if len(blocks) <= 1:
        sentence_blocks = _split_by_sentence_window(script_text)
        if len(sentence_blocks) > len(blocks):
            blocks = sentence_blocks

    scenes: list[dict] = []
    for idx, block in enumerate(blocks):
        normalized = _normalize_scene_text(block)
        if not normalized:
            continue

        ts_start, ts_end = _estimate_timestamp(idx)
        prompt = _generate_prompt(normalized)
        if not prompt:
            prompt = (
                f"Cinematic wide shot of {normalized[:200]}, "
                "photorealistic, 8k, volumetric lighting, digital art style."
            )

        scenes.append({
            "scene_number": len(scenes) + 1,
            "timestamp_start": ts_start,
            "timestamp_end": ts_end,
            "raw_text": normalized,
            "prompt": prompt,
        })

    return scenes


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

