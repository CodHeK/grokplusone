import os
import json
from typing import Tuple, Dict, Any, List

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
    model: str = "grok-3-mini",
    user_interests: str = "",
) -> Dict[str, Any]:
    """
    Generate high-quality reference notes from a transcript and optional user interests.
    Returns a dict with notes plus an (unused) artifacts list for compatibility.
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
    excerpt = transcript[-1000:] if transcript and len(transcript) > 1000 else transcript
    prompt = (
        "You are a meticulous live note taker and X discovery assistant.\n"
        "Given transcript excerpts and user interest signals, highlight the most important discussion topics and pointers the user will want to reference in the future.\n"
        "Write 1-2 exceptionally high-quality bullet notes that capture context, decisions, or insights tailored to their interests. Keep each bullet succinct (no more than ~10 words).\n"
        "Do not directly mention or describe the stated user interests; use them only to decide which transcript details matter.\n"
        "Return JSON: {\"notes\": [..]}.\n"
        f"User interests: {user_interests or 'not provided'}\n"
        f"Transcript excerpt (last 1000 chars):\n{excerpt}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Return only valid JSON with a notes array."},
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
        if not isinstance(notes, list):
            raise ValueError("Malformed insights response")
        return {"notes": notes, "artifacts": [], "raw": data}


async def summarize_user_interest_theme(likes: List[Dict[str, Any]], model: str = "grok-3-mini") -> str:
    api_key = os.getenv("XAI_API_KEY")
    base_url = os.getenv("BASE_URL", "https://api.x.ai/v1")
    if not api_key:
        raise ValueError("Missing XAI_API_KEY")

    excerpts = []
    for idx, item in enumerate(likes[:20], start=1):
        text = (item.get("text") or "").replace("\n", " ").strip()
        if text:
            excerpts.append(f"{idx}. {text[:400]}")
    context = "\n".join(excerpts) if excerpts else "No recent likes available."

    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    prompt = (
        "You analyze a user's recent liked tweets on X. "
        "Write 2-3 sentences that capture the themes, topics, or people they are most interested in lately. "
        "Stay high-level (e.g., 'They follow AI founders and product strategy threads'). "
        "Return JSON with a single field: {\"summary\": \"...\"}.\n"
        f"Content from the recently liked posts:\n{context}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Return only valid JSON with a summary field."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.3,
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
        summary = parsed.get("summary", "").strip()
        if not summary:
            raise ValueError("Summary missing in response")
        return summary
