"""
Google Generative Language API integration for script analysis.
Calls gemma-3-1b-it to split a script into scenes and generate image prompts.
"""

import json
import logging
import httpx

logger = logging.getLogger(__name__)

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemma-3-1b-it:generateContent"

SYSTEM_PROMPT = """You are a professional video director and cinematographer.
Your task is to analyze a script/story and break it down into discrete visual scenes for video production.

For each scene, provide:
1. scene_number: Sequential number starting from 1
2. timestamp_start: Estimated start time in MM:SS format (assume ~15 seconds per scene)
3. timestamp_end: Estimated end time in MM:SS format
4. raw_text: The original text segment for this scene
5. prompt: A detailed, cinematic image generation prompt that describes the visual for this scene. 
   The prompt should be in English, highly descriptive, include camera angles, lighting, mood, 
   color palette, and artistic style. Format: "Cinematic [shot type] of [description], [lighting], 
   [mood], [style details], photorealistic, 8k, volumetric lighting."

IMPORTANT RULES:
- Split the script logically by visual changes, location changes, or significant action changes
- Each scene should represent ONE distinct visual moment
- Image prompts must be vivid and specific enough for AI image generation
- Always respond in valid JSON format only, no markdown, no explanation
- Response must be a JSON array of scene objects

Example response format:
[
  {
    "scene_number": 1,
    "timestamp_start": "00:00",
    "timestamp_end": "00:15",
    "raw_text": "The scientist walks into the dark laboratory...",
    "prompt": "Cinematic wide shot of a scientist entering a dark laboratory, neon blue lighting from monitors, mysterious atmosphere, cold color palette, photorealistic, 8k, volumetric lighting."
  }
]"""


async def analyze_script_with_gemini(script_text: str, api_key: str) -> list[dict]:
    """
    Call Gemini API to analyze script text and return parsed scenes.

    Args:
        script_text: The raw script/story text to analyze.
        api_key: Google Gemini API key.

    Returns:
        List of scene dicts with keys: scene_number, timestamp_start, timestamp_end, raw_text, prompt.

    Raises:
        ValueError: If API key is empty or API returns an error.
        RuntimeError: If the response cannot be parsed.
    """
    if not api_key or not api_key.strip():
        raise ValueError("Gemini API key is required. Please enter your API key.")

    url = f"{GEMINI_API_URL}?key={api_key}"

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": f"{SYSTEM_PROMPT}\n\n--- SCRIPT TO ANALYZE ---\n\n{script_text}"}
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.95,
            "topK": 40,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
        }
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(url, json=payload)
        except httpx.TimeoutException:
            raise RuntimeError("Gemini API request timed out. Please try again.")
        except httpx.RequestError as e:
            raise RuntimeError(f"Network error when calling Gemini API: {e}")

    # Handle HTTP errors
    if response.status_code != 200:
        detail = ""
        try:
            err_body = response.json()
            detail = err_body.get("error", {}).get("message", response.text[:200])
        except Exception:
            detail = response.text[:200]
            
        if response.status_code == 400:
            raise ValueError(f"Invalid request to Gemini API: {detail}")
        elif response.status_code in (401, 403):
            raise ValueError(f"Gemini API key is invalid or unauthorized: {detail}")
        elif response.status_code == 429:
            raise ValueError("Gemini API rate limit exceeded (quota exhausted).")
        else:
            raise RuntimeError(f"Gemini API error (HTTP {response.status_code}): {detail}")

    # Parse response
    try:
        data = response.json()
    except Exception:
        raise RuntimeError("Failed to parse Gemini API response as JSON.")

    # Extract text content from Gemini response
    try:
        candidates = data.get("candidates", [])
        if not candidates:
            # Check for prompt feedback (blocked)
            block_reason = data.get("promptFeedback", {}).get("blockReason", "")
            if block_reason:
                raise ValueError(f"Gemini blocked the request: {block_reason}")
            raise RuntimeError("Gemini API returned no candidates.")

        content = candidates[0].get("content", {})
        parts = content.get("parts", [])
        if not parts:
            raise RuntimeError("Gemini API returned empty content.")

        raw_text = parts[0].get("text", "")
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini API response structure: {e}")

    # Parse the JSON array from the response text
    try:
        # Clean up potential markdown code blocks
        clean_text = raw_text.strip()
        if clean_text.startswith("```"):
            # Remove markdown code block markers
            lines = clean_text.split("\n")
            clean_text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
            clean_text = clean_text.strip()

        scenes = json.loads(clean_text)
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse Gemini response as JSON: {raw_text[:500]}")
        raise RuntimeError(f"Gemini returned invalid JSON. Please try again. Error: {e}")

    if not isinstance(scenes, list):
        raise RuntimeError("Gemini response is not a JSON array of scenes.")

    # Validate and normalize scenes
    validated = []
    for i, scene in enumerate(scenes):
        if not isinstance(scene, dict):
            continue
        validated.append({
            "scene_number": scene.get("scene_number", i + 1),
            "timestamp_start": scene.get("timestamp_start", f"{(i * 15) // 60:02d}:{(i * 15) % 60:02d}"),
            "timestamp_end": scene.get("timestamp_end", f"{((i + 1) * 15) // 60:02d}:{((i + 1) * 15) % 60:02d}"),
            "raw_text": scene.get("raw_text", ""),
            "prompt": scene.get("prompt", ""),
        })

    if not validated:
        raise RuntimeError("Gemini returned no valid scenes. Please try again with a different script.")

    logger.info(f"Gemini successfully parsed {len(validated)} scenes from script.")
    return validated


async def generate_single_audio_prompt(script_text: str, prompt_index: int, total_prompts: int, visual_style: str, api_key: str) -> str:
    """
    Call Gemini API to generate a single image prompt for a specific index in an audio-synced sequence.
    """
    if not api_key or not api_key.strip():
        raise ValueError("Gemini API key is required. Please enter your API key.")

    url = f"{GEMINI_API_URL}?key={api_key}"

    style_instruction = f"Use the following visual style for the prompt: {visual_style}" if visual_style else ""

    system_prompt = f"""You are a professional video director and cinematographer.
Your task is to generate ONE specific image generation prompt out of a sequence of {total_prompts} images for a video script.
This is prompt number {prompt_index} out of {total_prompts}.

{style_instruction}

Read the provided script carefully. Identify the visual moment or scene that corresponds to the {prompt_index}/{total_prompts} fraction of the story's progression.
Generate ONLY a detailed, cinematic image generation prompt describing that specific moment.
The prompt should be in English, highly descriptive, include camera angles, lighting, mood, color palette, and artistic style.
Format: "Cinematic [shot type] of [description], [lighting], [mood], [style details], photorealistic, 8k, volumetric lighting."

IMPORTANT RULES:
- Do not provide any introduction, explanation, or markdown formatting.
- The entire response should be JUST the raw text of the image prompt.
- Ensure the prompt flows logically as part of the overall sequence.
"""

    payload = {
        "contents": [
            {
                "parts": [
                    {"text": f"{system_prompt}\n\n--- SCRIPT START ---\n{script_text}\n--- SCRIPT END ---"}
                ]
            }
        ],
        "generationConfig": {
            "temperature": 0.7,
            "topP": 0.95,
            "topK": 40,
            "maxOutputTokens": 1024,
            "responseMimeType": "text/plain",
        }
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(url, json=payload)
        except httpx.TimeoutException:
            raise RuntimeError("Gemini API request timed out. Please try again.")
        except httpx.RequestError as e:
            raise RuntimeError(f"Network error when calling Gemini API: {e}")

    # Handle HTTP errors
    if response.status_code != 200:
        detail = ""
        try:
            err_body = response.json()
            detail = err_body.get("error", {}).get("message", response.text[:200])
        except Exception:
            detail = response.text[:200]
            
        if response.status_code == 400:
            raise ValueError(f"Invalid request to Gemini API: {detail}")
        elif response.status_code in (401, 403):
            raise ValueError(f"Gemini API key is invalid or unauthorized: {detail}")
        elif response.status_code == 429:
            raise ValueError("Gemini API rate limit exceeded (quota exhausted).")
        else:
            raise RuntimeError(f"Gemini API error (HTTP {response.status_code}): {detail}")

    # Parse response
    try:
        data = response.json()
    except Exception:
        raise RuntimeError("Failed to parse Gemini API response as JSON.")

    try:
        candidates = data.get("candidates", [])
        if not candidates:
            # Check for prompt feedback (blocked)
            block_reason = data.get("promptFeedback", {}).get("blockReason", "")
            if block_reason:
                raise ValueError(f"Gemini blocked the request: {block_reason}")
            raise RuntimeError("Gemini API returned no candidates.")

        content = candidates[0].get("content", {})
        parts = content.get("parts", [])
        if not parts:
            raise RuntimeError("Gemini API returned empty content.")

        raw_text = parts[0].get("text", "")
    except (KeyError, IndexError) as e:
        raise RuntimeError(f"Unexpected Gemini API response structure: {e}")

    return raw_text.strip()
