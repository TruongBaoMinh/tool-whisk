import sys
import asyncio
from backend.prompt import generate_single_audio_prompt

async def main():
    try:
        res = await generate_single_audio_prompt(
            script_text="Hello world",
            prompt_index=1,
            total_prompts=1,
            visual_style="",
            api_key="junk"
        )
        print("Success:", res)
    except Exception as e:
        print("Error:", e)
        import traceback
        traceback.print_exc()

asyncio.run(main())
