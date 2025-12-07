Listening Buddy (MVP) - Implementation Plan
Goal Description
Build a "Listening Buddy" Chrome Extension for a hackathon. The extension listens to browser audio (podcasts, videos), maintains "infinite context" of the conversation, and allows the user to ask questions via voice. It also proactively fetches relevant insights from X (Twitter) and takes personalized notes.

User Review Required
IMPORTANT

Architecture Decision: accessing "System Audio" typically requires a Desktop App (Electron). accessing "Tab Audio" is easy with a Chrome Extension. Recommendation: Go with a Chrome Extension for the Hackathon. It's lighter, faster to build UI for (using web tech), and "listening to content" usually happens in the browser nowadays. We will proceed with this assumption.

NOTE

API dependencies:

Transcription: Grok Voice (xAI) (Streaming STT).
LLM: Grok API (User provided access).
Vector DB: ChromaDB (local/easy) or Pinecone.
X API: User provided keys.
Proposed Architecture
Core Components
Frontend (Chrome Extension)

Side Panel: Main UI for chat, notes, and dynamic insights.
Background Service Worker: Handles chrome.tabCapture and WebSocket management.
Content Script: Handles Mic capture (user voice) and overlays if needed.
Tech: React, Tailwind CSS, Vite.
Backend (Python FastAPI)

WebSocket Server: Receives audio streams (System/Tab audio + User Mic).
Transcription Service: Real-time STT via Grok Voice.
Context Manager: Stores transcripts in a Vector DB (ChromaDB) for retrieval.
Agentic Worker: Background process that analyzes transcript chunks to query X API.
Orchestrator: Handles user questions -> RAG lookup -> Grok LLM Answer.
Data Flow
Listening: Video Audio -> Extension -> WS -> Backend -> Transcribed (Grok Voice) -> Vector DB.
User Query: User speaks -> Mic Audio -> Extension -> WS -> Backend -> Transcribed (Query) -> Vector DB Search (Context) -> LLM -> TTS Audio -> Extension plays sound.
Passive Insights: Transcript Chunk -> LLM (Extraction) -> "Identify topics/people" -> X API Search -> Push specific "Insight Cards" to Frontend via WS.
Features Breakdown
[Frontend] Chrome Extension
[NEW] manifest.json
Permissions: tabCapture, sidePanel, microphone, storage.
[NEW] Side Panel UI
Live Transcript View: Rolling text of what's being heard (optional, good for debug).
Insight Deck: A card stream showing relevant tweets/profiles found on X.
Chat Interface: Button to "Hold to Speak" (or VAD).
Session Library: A dashboard to browse past recordings.
Smart Search: Search bar to find specific topics or keywords across all past voice notes/transcripts.
[Data Persistence]
Session Metadata: Store start/end time, source URL (if applicable).
Time-Stamped Insights: Link every "X Insight Card" to a specific timestamp in the audio.
Transcript Storage: Save full JSON transcripts to allow text search.
[Backend] Python Server
[NEW] Data Model & Storage
Session: Represents one recording session (Movie, Podcast).
session_id: UUID.
start_time, end_time.
title: Auto-generated or User-defined.
TranscriptChunk: The atomic unit of "Infinite Context".
chunk_id: UUID.
session_id: FK to Session.
text: Transcribed text (e.g., 30s window or natural sentence break).
embedding: Vector representation (Float array).
timestamp_start, timestamp_end: Relative to session start.
metadata: JSON (found entities, sentiment).
[NEW] Audio Ingestion pipeline
WebSocket endpoint handling raw PCM stream.
Micro-Batching: Buffer audio for ~5-10s -> Transcribe (Grok Voice).
Vector commitment: Store transcript in Vector DB (Chroma) with session_id metadata immediately. This enables "Infinite" memory by retrieving top-k chunks for any query, regardless of video length.
[NEW] Intelligence Layer
ingest_audio: Stream to Grok Voice API.
store_memory: Embedding text chunks into Vector DB.
query_buddy: Retrieve context + System Prompt + User Query -> Grok LLM.
[NEW] X Integration Agent
Async task running every ~30-60 seconds of context.
Extracts keywords: "Elon Musk", "React 19", "Physics".
Queries X API.
If high relevance/engagement, push to UI.
[UX] Deep X Integration
Post-Session Review: viewing a past recording shows a timeline.
Contextual Artifacts: As you scrub through the audio/transcript, relevant X profiles and posts that were "discovered" at that moment appear in the sidebar.
"Who was that?": Auto-generated "Cast List" of people mentioned in the pod, linked to their X profiles.
Verification Plan
Manual Verification
Audio Capture: Open YouTube video, verifying backend receives stream.
Q&A: Pause video, ask "What did he just say about X?", verify accurate answer.
X Insights: Mention a topic (e.g. "SpaceX"), verify relevant tweets appear in Side Panel.