import os
import json
import asyncio
import base64
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
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

@app.get("/")
async def health_check():
    return {"status": "ok", "service": "Listening Buddy Intelligence Layer"}

@app.websocket("/ws/audio")
async def audio_websocket(client_ws: WebSocket):
    await client_ws.accept()
    print("Extension connected")

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
                                else:
                                    print(f"💭 Interim: {transcript}")
                                
                                # Optional: Echo back to client if we implemented a receiver there
                                # await client_ws.send_text(json.dumps({"transcript": transcript, "is_final": is_final}))
                except Exception as e:
                    print(f"Downstream error: {e}")

            # Run both
            await asyncio.gather(upstream(), downstream())

    except Exception as e:
        print(f"Error in session: {e}")
    finally:
        print("Session closed")
