# Listening Buddy

A "Listening Buddy" Chrome Extension that provides infinite context and proactive insights for your browsing sessions.

## 🔑 Required APIs
To run this project, you will need keys for the following services:

1.  **Grok Voice (xAI)**: For real-time transcription.
    - [xAI API](https://x.ai/api)
    - Required for: `backend/ingress_service`.
2.  **Grok API (xAI)**: For the intelligence layer.
    - Required for: `backend/rag_service`.
3.  **X (Twitter) API**: For social context and proactive insights.
    - Bearer Token is required.
    - Required for: `backend/x_agent`.

## 🏗 Project Structure
- `/extension`: Chrome Extension (React + Tailwind + Vite).
- `/backend`: Python FastAPI server + WebSocket handler.
- `/vector_db`: Local ChromaDB data persistence.

## 🚀 Getting Started

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

### Extension
```bash
cd extension
npm install
npm run build
# Load 'dist' folder in chrome://extensions
```
