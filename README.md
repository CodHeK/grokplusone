# Grok+1

Grok+1 is a voice-first companion that captures live audio, streams it to the backend for Grok Voice transcription, and layers in proactive insights so you can converse with podcasts, videos, or meetings in real time. It keeps infinite context, answers spoken questions (with optional spoken replies), and surfaces artifacts (tweets, links, summaries) based on the user's interests derived from X.

## ✨ Capabilities
- **Voice Agent Orbit**: Start or stop a capture session and watch the orb pulse while Grok+1 streams to the backend.
- **Voice Question Mode**: Arm Grok, ask verbally, and hear synthesized answers alongside the text response.
- **Session Timeline**: Browse past recordings, reopen them in a modal, and review live notes plus external artifacts.
- **Ask Grok Search**: Query any recording for recap items or context using natural language.
- **X Integration**: Connect Twitter to pull social context and artifacts into the insights panel.


## 🚀 Getting Started

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

### Electron App
```bash
cd electron-app
npm install
npm run dev
# Electron launches after Vite serves http://localhost:5173
```
