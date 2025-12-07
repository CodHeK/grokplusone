import os
import json
from typing import Tuple, Dict, Any

import httpx


async def generate_title_from_transcript(transcript: str, model: str = "grok-4-1-fast-reasoning") -> Tuple[str, Dict[str, Any]]:
    """
    Generate a succinct title from a transcript using Grok via REST (OpenAI-compatible).
    Returns the title and raw response.
    """
    api_key = os.getenv("XAI_API_KEY")
    base_url = os.getenv("BASE_URL", "https://api.x.ai/v1")
    if not api_key:
        raise ValueError("Missing XAI_API_KEY")

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    prompt = (
        "You generate short, punchy titles (3-8 words) for recorded conversations. "
        "No emojis or quotes. Return JSON with a single field: {\"title\": \"<title>\"}."
        f"\nTranscript excerpt:\n{transcript[:6000]}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Return only valid JSON with the title field."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
    }

    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        try:
            parsed = json.loads(content)
        except Exception:
            start = content.find("{")
            end = content.rfind("}")
            if start != -1 and end != -1:
                parsed = json.loads(content[start : end + 1])
            else:
                raise
        title = parsed.get("title")
        if not title:
            raise ValueError("Title missing in response")
        return title.strip(), data


async def generate_insights_from_transcript(
    transcript: str,
    model: str = "grok-4-1-fast-reasoning",
    user_interests: str = "",
) -> Dict[str, Any]:
    """
    Generate notes, queries, and entities from a transcript and optional user interests.
    Returns a dict with notes, queries, entities.
    """
    api_key = os.getenv("XAI_API_KEY")
    base_url = os.getenv("BASE_URL", "https://api.x.ai/v1")
    if not api_key:
        raise ValueError("Missing XAI_API_KEY")

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    prompt = (
        "You act as a live note taker and X discovery assistant.\n"
        "Given transcript excerpts and user interest signals, produce:\n"
        "- notes: 3-5 concise bullet phrases of key points.\n"
        "- queries: 2-3 short search strings for X (no hashtags, no quotes).\n"
        "- entities: up to 3 user handles or names relevant to the content.\n"
        "Return JSON: {\"notes\": [..], \"queries\": [..], \"entities\": [..]}.\n"
        f"User interests: {user_interests or 'not provided'}\n"
        f"Transcript excerpt:\n{transcript[:6000]}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Return only valid JSON with fields notes, queries, entities."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(url, headers=headers, json=payload)
        resp.raise_for_status()
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        parsed = {}
        try:
            parsed = json.loads(content)
        except Exception:
            start = content.find("{")
            end = content.rfind("}")
            if start != -1 and end != -1:
                parsed = json.loads(content[start : end + 1])
            else:
                raise
        notes = parsed.get("notes") or []
        queries = parsed.get("queries") or []
        entities = parsed.get("entities") or []
        if not isinstance(notes, list) or not isinstance(queries, list) or not isinstance(entities, list):
            raise ValueError("Malformed insights response")
        return {"notes": notes, "queries": queries, "entities": entities, "raw": data}
