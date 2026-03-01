"""
Pydantic models for request/response validation.
"""

from pydantic import BaseModel, Field


# ---------- Requests ----------

class ScriptAnalyzeRequest(BaseModel):
    script_text: str = Field(..., min_length=1, description="Raw script / story text")
    script_id: int = Field(default=1, description="Script DB id to attach scenes to")
    gemini_api_key: str = Field(default="", description="Gemini API key for AI-powered scene analysis")


class GenerateAudioPromptRequest(BaseModel):
    script_text: str = Field(..., min_length=1, description="Raw script text")
    prompt_index: int = Field(..., ge=1, description="Index of prompt to generate")
    total_prompts: int = Field(..., ge=1, description="Total number of prompts in sequence")
    visual_style: str = Field(default="", description="Optional custom visual style")
    gemini_api_key: str = Field(..., min_length=1, description="Gemini API key")


class GenerateImagesRequest(BaseModel):
    script_id: int = Field(default=1, description="Script whose scenes to generate")
    access_token: list[str] = Field(default=[], description="List of Google access tokens for Whisk API")


class RegenerateRequest(BaseModel):
    scene_id: int = Field(..., description="Scene to regenerate image for")
    access_token: list[str] = Field(default=[], description="List of Google access tokens for Whisk API")


class UpdatePromptRequest(BaseModel):
    scene_id: int = Field(..., description="Scene to update")
    prompt: str = Field(..., min_length=1, description="New prompt text")


# ---------- Responses ----------

class SceneData(BaseModel):
    id: int
    scene_number: int
    timestamp_start: str
    timestamp_end: str
    raw_text: str
    prompt: str
    status: str  # pending | generating | success | error
    error_message: str = ""


class ScriptAnalyzeResponse(BaseModel):
    script_id: int
    total_scenes: int
    scenes: list[SceneData]


class GenerateAudioPromptResponse(BaseModel):
    prompt: str


class ImageData(BaseModel):
    id: int
    scene_id: int
    scene_number: int
    file_name: str
    url: str
    width: int
    height: int


class GenerationStatus(BaseModel):
    script_id: int
    total: int
    completed: int
    generating: int
    pending: int
    errors: int
    images: list[ImageData]


class ExportResponse(BaseModel):
    file_path: str
    file_name: str
    total_images: int
