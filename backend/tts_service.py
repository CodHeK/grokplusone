import os
from typing import Tuple

import httpx
from dotenv import load_dotenv

load_dotenv()

XAI_API_KEY = os.getenv("XAI_API_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api.x.ai/v1")
TTS_URL = f"{BASE_URL}/audio/speech"


class TTSServiceError(Exception):
    ...


async def synthesize_speech(text: str, voice: str = "Ara", response_format: str = "mp3") -> Tuple[bytes, str]:
    """
    Convert plain text into speech audio bytes using the X.AI API.
    Returns a tuple of (audio_bytes, mime_type).
    """
    if not text:
        raise TTSServiceError("Text is required for speech synthesis")

    if not XAI_API_KEY:
        raise TTSServiceError("XAI_API_KEY is not configured")

    headers = {
        "Authorization": f"Bearer {XAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "input": text,
        "voice": voice,
        "response_format": response_format,
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(TTS_URL, headers=headers, json=payload)
            response.raise_for_status()
            content_type = response.headers.get("content-type", "audio/mpeg")
            return response.content, content_type
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text if exc.response is not None else str(exc)
        raise TTSServiceError(f"TTS request failed: {detail}") from exc
    except Exception as exc:
        raise TTSServiceError(f"TTS request failed: {exc}") from exc
