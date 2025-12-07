import os
import json
import asyncio
import base64
import uuid
import hashlib
import secrets
from pathlib import Path
from datetime import datetime, timedelta
from typing import Optional, Dict, Any

import httpx
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

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
GROK_API_KEY = os.getenv("XAI_API_KEY")
BASE_URL = os.getenv("BASE_URL", "https://api.x.ai/v1")
WS_URL = BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + "/realtime/audio/transcriptions"
STORAGE_ROOT = Path(os.getenv("STORAGE_ROOT", "storage"))
# Target ~20–30 seconds per chunk for long-form; adjust via env if needed
CHUNK_CHAR_TARGET = int(os.getenv("CHUNK_CHAR_TARGET", "1200"))
INTEGRATIONS_DIR = STORAGE_ROOT / "integrations"
INTEGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
X_CLIENT_ID = os.getenv("X_CLIENT_ID", "V3JiQ2tGZU9OaWhkeFZCWjU4UjA6MTpjaQ")
X_CLIENT_SECRET = os.getenv("X_CLIENT_SECRET", "bS-gBbRZfF58DwQeBPJpZO3FQRxjFUfuS_EGv8a21I1U2yHa_Q")
X_REDIRECT_URI = os.getenv("X_REDIRECT_URI", "http://localhost:8000/integrations/x/oauth/callback")
X_OAUTH_SCOPES = os.getenv("X_OAUTH_SCOPES", "tweet.read users.read follows.read like.read offline.access")
X_AUTH_URL = "https://twitter.com/i/oauth2/authorize"
X_TOKEN_URL = "https://api.twitter.com/2/oauth2/token"


class XIntegrationConfig(BaseModel):
    bearer_token: Optional[str] = Field(default=None, description="X API Bearer Token")
    api_key: Optional[str] = Field(default=None, description="Consumer API Key")
    api_secret: Optional[str] = Field(default=None, description="Consumer API Secret")
    access_token: Optional[str] = Field(default=None, description="Access Token")
    access_token_secret: Optional[str] = Field(default=None, description="Access Token Secret")
    connected: bool = False
    updated_at: Optional[str] = None


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


def base64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("utf-8")


def build_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64url_encode(digest)

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
                    chunk_count = 0
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
                        
                        chunk_count += 1
                        if chunk_count % 50 == 0:
                            print(f".", end="", flush=True)  # Alive indicator
                except WebSocketDisconnect:
                    print("Client disconnected")
                except Exception as e:
                    print(f"Upstream error: {e}")

            # Buffer for chunked transcript storage
            chunk_buffer = []
            buffer_chars = 0

            def flush_chunk():
                nonlocal chunk_buffer, buffer_chars
                if not chunk_buffer:
                    return
                chunk_text = " ".join(chunk_buffer).strip()
                chunk_id = uuid.uuid4().hex
                chunk_path = session_dir / f"chunk_{chunk_id}.txt"
                chunk_path.write_text(chunk_text, encoding="utf-8")
                print(f"💾 Saved chunk {chunk_id} ({len(chunk_text)} chars) to {chunk_path}")
                chunk_buffer = []
                buffer_chars = 0

            # Task B: Grok Transcripts -> Client (or Log for now)
            async def downstream():
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
                                    # Accumulate into chunk buffer
                                    chunk_buffer.append(transcript)
                                    buffer_chars += len(transcript)
                                    if buffer_chars >= CHUNK_CHAR_TARGET:
                                        flush_chunk()
                                # else:
                                #     print(f"💭 Interim: {transcript}")
                                
                                # Optional: Echo back to client if we implemented a receiver there
                                # await client_ws.send_text(json.dumps({"transcript": transcript, "is_final": is_final}))
                except Exception as e:
                    print(f"Downstream error: {e}")

            # Run both
            await asyncio.gather(upstream(), downstream())
            # Flush remaining buffered transcript on shutdown
            flush_chunk()

    except Exception as e:
        print(f"Error in session: {e}")
    finally:
        print(f"Session closed: {session_id}")
