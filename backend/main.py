import os
import json
import asyncio
import base64
import uuid
import hashlib
import secrets
import httpx
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, Any

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from llm_utils import (
    generate_title_from_transcript,
    generate_insights_from_transcript,
    summarize_user_interest_theme,
    generate_artifact_search_query,
    answer_transcript_question,
)
from tts_service import synthesize_speech, TTSServiceError

load_dotenv()

app = FastAPI(title="Listening Buddy Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Grok Voice Config
GROK_API_KEY = os.getenv("XAI_API_KEY", "xai-U3SgU6NpZaSL7FBx79GgiFsKPMIldSCjPGEFrR2OHve5EbubS4HJpHHI96sqeMSWa5O2l7IPPY8kkZEy")
BASE_URL = os.getenv("BASE_URL", "https://api.x.ai/v1")
WS_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/realtime/audio/transcriptions"
STORAGE_ROOT = Path(os.getenv("STORAGE_ROOT", "storage"))
# Target ~20–30 seconds per chunk for long-form; adjust via env if needed
CHUNK_CHAR_TARGET = int(os.getenv("CHUNK_CHAR_TARGET", "20"))
CHUNK_FLUSH_SECONDS = int(os.getenv("CHUNK_FLUSH_SECONDS", "20"))
INSIGHTS_INTERVAL_SECONDS = int(os.getenv("INSIGHTS_INTERVAL_SECONDS", "5"))
INTEGRATIONS_DIR = STORAGE_ROOT / "integrations"
INTEGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
USER_INTERESTS_FILE = STORAGE_ROOT / "user_interests.json"
X_CLIENT_ID = os.getenv("X_CLIENT_ID", "V3JiQ2tGZU9OaWhkeFZCWjU4UjA6MTpjaQ")
X_CLIENT_SECRET = os.getenv("X_CLIENT_SECRET", "bS-gBbRZfF58DwQeBPJpZO3FQRxjFUfuS_EGv8a21I1U2yHa_Q")
X_REDIRECT_URI = os.getenv("X_REDIRECT_URI", "http://localhost:8000/integrations/x/oauth/callback")
X_OAUTH_SCOPES = os.getenv("X_OAUTH_SCOPES", "tweet.read users.read follows.read like.read offline.access")
X_AUTH_URL = "https://twitter.com/i/oauth2/authorize"
X_TOKEN_URL = "https://api.twitter.com/2/oauth2/token"
X_BEARER_TOKEN = os.getenv("X_BEARER_TOKEN", "AAAAAAAAAAAAAAAAAAAAAAl25wEAAAAAZmG8VeUkzc69eSkI7Y%2FL2cUh58I%3DVmeNqXMh5yX5Xp3bZDKdLoixbLcTIZdFW8ASJZTjAGb7QvGvg0")
TTS_VOICE = os.getenv("TTS_VOICE", "Ara")
TTS_FORMAT = os.getenv("TTS_FORMAT", "mp3")


class XIntegrationConfig(BaseModel):
    bearer_token: Optional[str] = Field(default=None, description="X API Bearer Token")
    api_key: Optional[str] = Field(default=None, description="Consumer API Key")
    api_secret: Optional[str] = Field(default=None, description="Consumer API Secret")
    access_token: Optional[str] = Field(default=None, description="Access Token")
    access_token_secret: Optional[str] = Field(default=None, description="Access Token Secret")
    connected: bool = False
    updated_at: Optional[str] = None


class SessionQuestion(BaseModel):
    question: str = Field(..., min_length=1)


def integration_path(name: str) -> Path:
    return INTEGRATIONS_DIR / f"{name}.json"


def load_integration(name: str) -> Dict[str, Any]:
    path = integration_path(name)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def save_integration(name: str, data: Dict[str, Any]) -> None:
    path = integration_path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def parse_iso8601(dt_str: Optional[str]) -> Optional[datetime]:
    if not dt_str:
        return None
    try:
        value = dt_str
        if value.endswith("Z"):
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(value)
    except Exception:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def format_utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_user_interests() -> Dict[str, Any]:
    if not USER_INTERESTS_FILE.exists():
        return {}
    try:
        return json.loads(USER_INTERESTS_FILE.read_text())
    except Exception:
        return {}


def save_user_interests(data: Dict[str, Any]) -> None:
    USER_INTERESTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    USER_INTERESTS_FILE.write_text(json.dumps(data, indent=2))


def get_user_interests_text() -> str:
    data = load_user_interests()
    return data.get("interests_text", "")


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("utf-8")


def build_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64url_encode(digest)


async def fetch_x_liked_tweets(user_id: str, access_token: str, max_results: int = 10) -> list:
    """Fetch recent liked tweets for personalization."""
    url = f"https://api.x.com/2/users/{user_id}/liked_tweets"
    params = {"max_results": max(10, min(max_results, 100))}
    headers = {"Authorization": f"Bearer {access_token}"}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params, headers=headers)
            if resp.status_code != 200:
                return []
            data = resp.json()
            return data.get("data", []) or []
    except Exception:
        return []


async def search_x_tweets(query: str, start_time: Optional[str], end_time: Optional[str], max_results: int = 10) -> list:
    if not X_BEARER_TOKEN:
        raise HTTPException(status_code=500, detail="X_BEARER_TOKEN not configured")
    params = {
        "query": query,
        "max_results": max(10, min(max_results, 100)),
    }
    if start_time:
        params["start_time"] = start_time
    if end_time:
        params["end_time"] = end_time
    headers = {"Authorization": f"Bearer {X_BEARER_TOKEN}"}
    url = "https://api.x.com/2/tweets/search/all"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=params, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data.get("data", []) or []
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Artifact search failed: {e}")


def summarize_likes_text(likes: list, max_items: int = 5, max_len: int = 200) -> str:
    """Return a brief summary string of liked tweet texts."""
    if not likes:
        return ""
    snippets = []
    for item in likes[:max_items]:
        text = (item.get("text") or "").replace("\n", " ").strip()
        if text:
            snippets.append(text[:max_len])
    if not snippets:
        return ""
    return " | ".join(snippets)


def insights_path(session_id: str) -> Path:
    return STORAGE_ROOT / session_id / "insights.jsonl"


def append_insights(session_id: str, payload: Dict[str, Any], dedupe: bool = True) -> bool:
    if dedupe:
        cached = load_insights(session_id)
        if cached:
            last = cached[-1]
            if (last.get("notes") or []) == (payload.get("notes") or []) and (last.get("artifacts") or []) == (payload.get("artifacts") or []):
                return False
    path = insights_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")
    return True


def load_insights(session_id: str) -> list:
    path = insights_path(session_id)
    if not path.exists():
        return []
    items = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    items.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        return []
    return items





def session_meta_path(session_id: str) -> Path:
    return STORAGE_ROOT / session_id / "session.json"


def write_session_meta(session_id: str, data: Dict[str, Any]) -> None:
    path = session_meta_path(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def read_session_text(session_id: str, max_chars: int = 6000) -> str:
    """
    Load transcript text for a session up to max_chars.
    Prefers the consolidated transcript.txt, falls back to chunk_*.txt if present.
    """
    session_dir = STORAGE_ROOT / session_id
    if not session_dir.exists():
        return ""

    transcript_file = session_dir / "transcript.txt"
    texts: list[str] = []
    total = 0

    if transcript_file.exists():
        try:
            content = transcript_file.read_text(encoding="utf-8")
            texts.append(content[:max_chars])
        except Exception:
            pass
    else:
        chunks = sorted(session_dir.glob("chunk_*.txt"))
        for chunk in chunks:
            try:
                content = chunk.read_text(encoding="utf-8")
            except Exception:
                continue
            if not content:
                continue
            if total + len(content) > max_chars:
                content = content[: max_chars - total]
            texts.append(content)
            total += len(content)
            if total >= max_chars:
                break

    return "\n".join(texts)


@app.get("/")
async def health_check():
    return {"status": "ok", "service": "Listening Buddy Intelligence Layer"}


@app.get("/integrations")
async def list_integrations():
    x_data = load_integration("x")
    return {
        "integrations": [
            {
                "name": "x",
                "connected": bool(x_data.get("connected")),
                "updated_at": x_data.get("updated_at"),
            }
        ]
    }


@app.get("/integrations/x")
async def get_x_integration():
    data = load_integration("x")
    # Do not leak secrets; only report connection status and key presence.
    return {
        "connected": bool(data.get("connected")),
        "updated_at": data.get("updated_at"),
        "has_keys": any(
            data.get(k)
            for k in ["bearer_token", "api_key", "api_secret", "access_token", "access_token_secret"]
        ),
        "user": data.get("user"),
    }


@app.post("/integrations/x")
async def set_x_integration(config: XIntegrationConfig):
    # Mark connected if any token is provided
    payload = config.model_dump()
    payload["connected"] = any(
        payload.get(k)
        for k in ["bearer_token", "api_key", "api_secret", "access_token", "access_token_secret"]
    )
    payload["updated_at"] = datetime.utcnow().isoformat()
    save_integration("x", payload)
    return {"status": "ok", "connected": payload["connected"], "updated_at": payload["updated_at"]}


@app.post("/user-interests/generate")
async def generate_user_interests(force: bool = Query(default=False)):
    existing = load_user_interests()
    if existing and not force:
        return {**existing, "cached": True}

    x_data = load_integration("x")
    access_token = x_data.get("access_token")
    user_id = x_data.get("user", {}).get("data", {}).get("id")
    if not access_token or not user_id:
        raise HTTPException(status_code=400, detail="X integration not connected")

    likes = await fetch_x_liked_tweets(user_id, access_token, max_results=20)
    print(f"Got {len(likes)} liked posts")
    summary = summarize_likes_text(likes, max_items=20)
    interest_theme = summary
    if likes:
        try:
            interest_theme = await summarize_user_interest_theme(likes)
        except Exception as e:
            print(f"Failed to summarize interests via Grok: {e}")
    enriched_sample = []
    for item in likes:
        enriched = dict(item)
        tweet_id = item.get("id")
        if tweet_id:
            enriched["url"] = f"https://x.com/i/web/status/{tweet_id}"
        enriched_sample.append(enriched)
    payload = {
        "interests_text": interest_theme,
        "raw_likes_summary": summary,
        "likes_sample": enriched_sample,
        "generated_at": datetime.utcnow().isoformat(),
    }
    save_user_interests(payload)
    return {**payload, "cached": False}


@app.get("/sessions")
async def list_sessions():
    sessions = []
    if not STORAGE_ROOT.exists():
        return {"sessions": []}

    for item in STORAGE_ROOT.iterdir():
        if not item.is_dir():
            continue
        if item.name == "integrations":
            continue
        meta_file = item / "session.json"
        if not meta_file.exists():
            continue
        try:
            data = json.loads(meta_file.read_text())
            sessions.append(
                {
                    "session_id": data.get("session_id", item.name),
                    "start_time": data.get("start_time"),
                    "end_time": data.get("end_time"),
                    "duration_seconds": data.get("duration_seconds"),
                    "chunks": data.get("chunks", 0),
                    "title": data.get("title"),
                }
            )
        except Exception:
            continue
    # Sort newest first by start_time
    sessions.sort(key=lambda s: s.get("start_time") or "", reverse=True)
    return {"sessions": sessions}


@app.post("/sessions/{session_id}/title")
async def generate_session_title(session_id: str):
    meta_file = session_meta_path(session_id)
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    # Load session metadata
    try:
        meta = json.loads(meta_file.read_text())
    except Exception:
        meta = {}

    # If already titled with a real value (not placeholder), return cached
    if meta.get("title"):
        return {"title": meta["title"], "cached": True}

    transcript = read_session_text(session_id)
    if not transcript:
        raise HTTPException(status_code=400, detail="No transcript chunks found for this session")

    try:
        title, _raw = await generate_title_from_transcript(transcript)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Title generation failed: {e}")

    meta["title"] = title
    meta["title_generated_at"] = datetime.utcnow().isoformat()
    write_session_meta(session_id, meta)

    return {"title": title, "cached": False}


@app.get("/sessions/{session_id}/insights")
async def get_session_insights(session_id: str):
    meta_file = session_meta_path(session_id)
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    transcript = read_session_text(session_id)
    if not transcript:
        raise HTTPException(status_code=400, detail="No transcript found for this session")

    # Return cached insights if present
    cached = load_insights(session_id)
    if cached:
        return {"insights": cached}

    # Otherwise generate once on demand
    user_interests_text = get_user_interests_text()

    try:
        insights = await generate_insights_from_transcript(transcript, user_interests=user_interests_text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Insights generation failed: {e}")

    try:
        artifacts_payload = await build_session_artifacts_response(
            session_id,
            transcript=transcript,
            user_interests_text=user_interests_text,
            force_generate=True,
            store_result=False,
        )
    except Exception:
        artifacts_payload = {"artifacts": [], "query": None}

    payload = {
        "timestamp": datetime.utcnow().isoformat(),
        "notes": insights.get("notes", []),
        "artifacts": artifacts_payload.get("artifacts", []),
        "artifact_query": artifacts_payload.get("query"),
    }
    append_insights(session_id, payload)
    return {"insights": [payload]}


async def build_session_artifacts_response(
    session_id: str,
    *,
    transcript: Optional[str] = None,
    user_interests_text: Optional[str] = None,
    force_generate: bool = False,
    store_result: bool = False,
) -> Dict[str, Any]:
    meta_file = session_meta_path(session_id)
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    cached_entries = load_insights(session_id)
    if cached_entries and not force_generate:
        for entry in reversed(cached_entries):
            artifacts = entry.get("artifacts") or []
            if artifacts:
                return {
                    "timestamp": entry.get("timestamp"),
                    "query": entry.get("artifact_query"),
                    "artifacts": artifacts,
                }

    try:
        meta = json.loads(meta_file.read_text())
    except Exception:
        meta = {}

    if transcript is None:
        transcript = read_session_text(session_id, max_chars=4000)
    if not transcript:
        raise HTTPException(status_code=400, detail="No transcript found for this session")

    excerpt = transcript[-1000:] if len(transcript) > 1000 else transcript
    user_interests_text = user_interests_text if user_interests_text is not None else get_user_interests_text()

    try:
        query = await generate_artifact_search_query(excerpt, user_interests=user_interests_text)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate artifact query: {e}")

    now_utc = datetime.now(timezone.utc)
    end_date = now_utc.date()
    start_date = (now_utc - timedelta(days=2)).date()

    start_iso = str(start_date) + "T00:00:00Z"
    end_iso = str(end_date) + "T00:00:00Z"

    tweets = await search_x_tweets(query, start_iso, end_iso, max_results=10)
    artifacts = []
    for item in tweets:
        tweet_id = item.get("id")
        text = (item.get("text") or "").strip()
        if not tweet_id or not text:
            continue
        artifacts.append(
            {
                "title": text[:140],
                "url": f"https://x.com/i/web/status/{tweet_id}",
                "tweet": item,
            }
        )

    payload = {
        "timestamp": datetime.utcnow().isoformat(),
        "query": query,
        "artifacts": artifacts,
    }

    if store_result:
        entry = {
            "timestamp": payload["timestamp"],
            "notes": [],
            "artifacts": artifacts,
            "artifact_query": query,
        }
        append_insights(session_id, entry)

    return payload


@app.get("/sessions/{session_id}/artifacts")
async def get_session_artifacts(session_id: str):
    return await build_session_artifacts_response(session_id, force_generate=False, store_result=True)


@app.post("/sessions/{session_id}/ask")
async def ask_session_question(session_id: str, payload: SessionQuestion):
    meta_file = session_meta_path(session_id)
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    transcript = read_session_text(session_id, max_chars=8000)
    if not transcript:
        raise HTTPException(status_code=400, detail="No transcript found for this session")

    user_interests_text = get_user_interests_text()

    try:
        answer = await answer_transcript_question(
            question=payload.question,
            transcript=transcript,
            user_interests=user_interests_text,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Question answering failed: {e}")

    return {"answer": answer}


@app.post("/sessions/{session_id}/questions")
async def ask_realtime_question(session_id: str, payload: SessionQuestion):
    meta_file = session_meta_path(session_id)
    if not meta_file.exists():
        raise HTTPException(status_code=404, detail="Session not found")

    transcript = read_session_text(session_id, max_chars=8000)
    if not transcript:
        raise HTTPException(status_code=400, detail="No transcript found for this session")

    user_interests_text = get_user_interests_text()

    try:
        answer = await answer_transcript_question(
            question=payload.question,
            transcript=transcript,
            user_interests=user_interests_text,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Question answering failed: {exc}")

    try:
        audio_bytes, mime_type = await synthesize_speech(answer, voice=TTS_VOICE, response_format=TTS_FORMAT)
    except TTSServiceError as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    return {
        "answer": answer,
        "audio_base64": audio_base64,
        "audio_mime_type": mime_type,
        "voice": TTS_VOICE,
    }


@app.websocket("/ws/insights/{session_id}")
async def insights_websocket(ws: WebSocket, session_id: str):
    await ws.accept()
    print(f"Insights subscriber connected for session {session_id}")

    meta_file = session_meta_path(session_id)
    if not meta_file.exists():
        await ws.send_text(json.dumps({"error": "Session not found"}))
        await ws.close()
        return

    # Send cached insights immediately
    cached = load_insights(session_id)
    await ws.send_text(json.dumps({"type": "insights_init", "insights": cached}))

    last_len = 0
    try:
        while True:
            await asyncio.sleep(INSIGHTS_INTERVAL_SECONDS)
            transcript = read_session_text(session_id, max_chars=4000)
            if not transcript:
                continue
            if len(transcript) == last_len:
                continue
            last_len = len(transcript)

            user_interests_text = get_user_interests_text()

            try:
                insights = await generate_insights_from_transcript(transcript, user_interests=user_interests_text)
            except Exception as e:
                await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
                continue

            try:
                artifacts_payload = await build_session_artifacts_response(
                    session_id,
                    transcript=transcript,
                    user_interests_text=user_interests_text,
                    force_generate=True,
                    store_result=False,
                )
            except Exception:
                artifacts_payload = {"query": None, "artifacts": [], "timestamp": datetime.utcnow().isoformat()}

            combined_payload = {
                "timestamp": datetime.utcnow().isoformat(),
                "notes": insights.get("notes", []),
                "artifacts": artifacts_payload.get("artifacts", []),
                "artifact_query": artifacts_payload.get("query"),
            }
            appended = append_insights(session_id, combined_payload)
            if appended:
                await ws.send_text(json.dumps({"type": "insights", "data": combined_payload}))
    except WebSocketDisconnect:
        print(f"Insights subscriber disconnected for session {session_id}")
    except Exception as e:
        print(f"Insights WS error for session {session_id}: {e}")
    finally:
        await ws.close()

@app.get("/integrations/x/oauth/start")
async def start_x_oauth():
    if not X_CLIENT_ID:
        raise HTTPException(status_code=400, detail="X_CLIENT_ID not configured")

    state = secrets.token_urlsafe(16)
    code_verifier = secrets.token_urlsafe(64)[:128]
    code_challenge = build_code_challenge(code_verifier)

    auth_url = (
        f"{X_AUTH_URL}"
        f"?response_type=code"
        f"&client_id={X_CLIENT_ID}"
        f"&redirect_uri={X_REDIRECT_URI}"
        f"&scope={X_OAUTH_SCOPES.replace(' ', '%20')}"
        f"&state={state}"
        f"&code_challenge={code_challenge}"
        f"&code_challenge_method=S256"
    )

    pending = {
        "state": state,
        "code_verifier": code_verifier,
        "created_at": datetime.utcnow().isoformat(),
    }
    save_integration("x_pending", pending)
    return {"auth_url": auth_url, "state": state}


@app.get("/integrations/x/oauth/callback", response_class=HTMLResponse)
async def x_oauth_callback(code: str = Query(...), state: str = Query(...)):
    pending = load_integration("x_pending")
    if not pending or pending.get("state") != state:
        raise HTTPException(status_code=400, detail="Invalid or missing state")
    if not X_CLIENT_ID:
        raise HTTPException(status_code=400, detail="X_CLIENT_ID not configured")

    code_verifier = pending.get("code_verifier")
    if not code_verifier:
        raise HTTPException(status_code=400, detail="Missing code_verifier")

    token_payload = {
        "grant_type": "authorization_code",
        "client_id": X_CLIENT_ID,
        "redirect_uri": X_REDIRECT_URI,
        "code": code,
        "code_verifier": code_verifier,
    }

    token_data = {}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                X_TOKEN_URL,
                data=token_payload,
                auth=(X_CLIENT_ID, X_CLIENT_SECRET) if X_CLIENT_SECRET else None,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp.raise_for_status()
            token_data = resp.json()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Token exchange failed: {e}")

    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token")
    expires_in = token_data.get("expires_in")
    expires_at = None
    if expires_in:
        expires_at = (datetime.utcnow() + timedelta(seconds=expires_in)).isoformat()

    user_info = None
    if access_token:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                user_resp = await client.get(
                    "https://api.twitter.com/2/users/me",
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                if user_resp.status_code == 200:
                    user_info = user_resp.json()
        except Exception:
            user_info = None

    saved = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": expires_at,
        "connected": bool(access_token),
        "updated_at": datetime.utcnow().isoformat(),
        "user": user_info,
    }
    save_integration("x", saved)
    # clear pending
    try:
        integration_path("x_pending").unlink(missing_ok=True)
    except Exception:
        pass

    return """
    <html>
      <body>
        <h2>X integration connected</h2>
        <p>You can close this window and return to Listening Buddy.</p>
      </body>
    </html>
    """

@app.websocket("/ws/audio")
async def audio_websocket(client_ws: WebSocket):
    await client_ws.accept()
    session_id = uuid.uuid4().hex
    session_dir = STORAGE_ROOT / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    print(f"Extension connected. Session: {session_id}")
    session_start = datetime.utcnow()
    session_meta = {
        "session_id": session_id,
        "start_time": session_start.isoformat(),
        "end_time": None,
        "duration_seconds": None,
        "status": "active",
        "chunks": 0,
        "title": None,
    }
    write_session_meta(session_id, session_meta)
    # Initialize transcript file
    transcript_path = session_dir / "transcript.txt"
    transcript_path.write_text("", encoding="utf-8")

    try:
        await client_ws.send_text(json.dumps({"type": "session_started", "session_id": session_id}))
    except WebSocketDisconnect:
        print("Client disconnected before session start ack")
        return
    except Exception as exc:
        print(f"Failed to notify client about session start: {exc}")

    if not GROK_API_KEY:
        print("Error: XAI_API_KEY not found")
        await client_ws.close(code=1000, reason="Server missing API Key")
        return

    # Connect to Grok Voice
    headers = {"Authorization": f"Bearer {GROK_API_KEY}"}
    
    try:
        async with websockets.connect(WS_URL, additional_headers=headers) as grok_ws:
            print("Connected to Grok Voice API")

            # 1. Send Config
            config_message = {
                "type": "config",
                "data": {
                    "encoding": "linear16",
                    "sample_rate_hertz": 16000,
                    "enable_interim_results": True,
                },
            }
            await grok_ws.send(json.dumps(config_message))

            # 2. Parallel Tasks:
            # Task A: Client Audio -> Grok
            async def upstream():
                try:
                    while True:
                        # Receive raw bytes from extension (Int16 PCM)
                        data = await client_ws.receive_bytes()
                        
                        # Encode to Base64
                        audio_b64 = base64.b64encode(data).decode("utf-8")
                        
                        # Send to Grok
                        audio_message = {
                            "type": "audio",
                            "data": {"audio": audio_b64},
                        }
                        await grok_ws.send(json.dumps(audio_message))
                
                except WebSocketDisconnect:
                    print("Client disconnected")
                except Exception as e:
                    print(f"Upstream error: {e}")

            transcript_path = session_dir / "transcript.txt"
            transcript_path.write_text("", encoding="utf-8")
            chunk_counter = 0

            # Task B: Grok Transcripts -> Client (or Log for now)
            async def downstream():
                nonlocal chunk_counter, session_meta
                try:
                    async for message in grok_ws:
                        response = json.loads(message)
                        if response.get("data", {}).get("type") == "speech_recognized":
                            transcript_data = response["data"]["data"]
                            transcript = transcript_data.get("transcript", "")
                            is_final = transcript_data.get("is_final", False)
                            
                            if transcript:
                                if is_final:
                                    print(f"✅ Final: {transcript}")
                                    normalized_transcript = transcript.strip()
                                    # Append final text to single transcript file
                                    if normalized_transcript:
                                        with transcript_path.open("a", encoding="utf-8") as f:
                                            f.write(normalized_transcript + "\n")
                                        try:
                                            await client_ws.send_text(
                                                json.dumps(
                                                    {
                                                        "type": "transcript_final",
                                                        "session_id": session_id,
                                                        "text": normalized_transcript,
                                                    }
                                                )
                                            )
                                        except WebSocketDisconnect:
                                            print("Client disconnected while sending transcript")
                                        except Exception as exc:
                                            print(f"Failed to forward transcript to client: {exc}")
                                    chunk_counter += 1
                                    session_meta["chunks"] = chunk_counter
                                    # update duration/end_time on each final so UI sees progress
                                    now = datetime.utcnow()
                                    session_meta["end_time"] = now.isoformat()
                                    session_meta["duration_seconds"] = max((now - session_start).total_seconds(), 0)
                                    write_session_meta(session_id, session_meta)
                                # else:
                                #     print(f"💭 Interim: {transcript}")
                                
                                # Optional: Echo back to client if we implemented a receiver there
                                # await client_ws.send_text(json.dumps({"transcript": transcript, "is_final": is_final}))
                except Exception as e:
                    print(f"Downstream error: {e}")

            # Run both
            await asyncio.gather(upstream(), downstream())

    except Exception as e:
        print(f"Error in session: {e}")
    finally:
        if session_start:
            end_time = datetime.utcnow()
            duration = max((end_time - session_start).total_seconds(), 0)
            session_meta["end_time"] = end_time.isoformat()
            session_meta["duration_seconds"] = duration
            session_meta["status"] = "completed"
            write_session_meta(session_id, session_meta)
        print(f"Session closed: {session_id}")
