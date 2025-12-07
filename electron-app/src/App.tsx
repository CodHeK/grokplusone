import { useEffect, useRef, useState } from 'react';
import './style.css';

const WS_URL = 'ws://localhost:8000/ws/audio';
const API_URL = 'http://localhost:8000';
const TARGET_SAMPLE_RATE = 16000;

type SessionSummary = {
  session_id: string;
  start_time?: string;
  end_time?: string;
  duration_seconds?: number;
  chunks?: number;
};

// Convert Float32 audio to 16-bit PCM
function convertFloat32ToInt16(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16Array;
}

function downsampleBuffer(buffer: Float32Array, sampleRate: number, outSampleRate: number): Float32Array {
  if (outSampleRate === sampleRate) return buffer;
  if (outSampleRate > sampleRate) throw new Error('Downsampling rate should be smaller than original sample rate');

  const sampleRateRatio = sampleRate / outSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / count;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function App() {
  const [status, setStatus] = useState('Ready to listen');
  const [isConnected, setIsConnected] = useState(false);
  const [integrationStatus, setIntegrationStatus] = useState<{ connected: boolean; updated_at?: string; has_keys?: boolean; user?: any }>({ connected: false });
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchAnswer, setSearchAnswer] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // On macOS the main process already asked for mic access, but we still handle renderer errors.
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchIntegrationStatus();
    fetchSessions();
  }, []);

  const startMicCapture = async () => {
    try {
      setStatus('Requesting microphone...');

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });

      connectStream(stream);
    } catch (err: any) {
      console.error(err);
      const friendly =
        err?.name === 'NotAllowedError'
          ? 'Mic blocked. Allow microphone access in System Settings > Privacy & Security > Microphone.'
          : err?.name === 'NotFoundError'
            ? 'No microphone found. Plug one in and retry.'
            : err?.message || 'Unknown error';
      setStatus(`Mic error: ${friendly}`);
    }
  };

  const connectStream = (stream: MediaStream) => {
    streamRef.current = stream;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setStatus('Streaming microphone audio to backend...');
      processAudio(stream);
    };

    ws.onclose = () => {
      setIsConnected(false);
      setStatus('Disconnected');
      stopCapture();
    };

    ws.onerror = (err) => {
      console.error('WS Error', err);
      setStatus('Connection Error');
    };
  };

  const processAudio = (stream: MediaStream) => {
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, TARGET_SAMPLE_RATE);
      const pcm16 = convertFloat32ToInt16(downsampled);
      wsRef.current.send(pcm16.buffer);
    };
  };

  const stopCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setIsConnected(false);
    setStatus('Stopped');
    fetchSessions();
  };

  const fetchIntegrationStatus = async () => {
    try {
      const res = await fetch(`${API_URL}/integrations/x`);
      const data = await res.json();
      setIntegrationStatus(data);
      setSaveMessage(null);
    } catch (err) {
      console.warn('Failed to fetch integration status', err);
    }
  };

  const startOAuth = async () => {
    try {
      const res = await fetch(`${API_URL}/integrations/x/oauth/start`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.auth_url) {
        window.open(data.auth_url, '_blank');
        // Poll status for a short period
        setTimeout(fetchIntegrationStatus, 3000);
        setTimeout(fetchIntegrationStatus, 8000);
      }
    } catch (err) {
      setSaveMessage(`OAuth start failed: ${(err as any)?.message || 'unknown error'}`);
    }
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_URL}/sessions`);
      const data = await res.json();
      const normalized = (data.sessions || []).map((s: SessionSummary) => ({
        ...s,
        duration_seconds: s.duration_seconds !== undefined ? Number(s.duration_seconds) : undefined,
      }));
      setSessions(normalized);
    } catch (err) {
      console.warn('Failed to fetch sessions', err);
    }
  };

  const dummyArtifacts = [
    {
      type: 'post',
      title: 'AI agent autonomy is shifting product timelines',
      author: '@ai_researcher',
      link: 'https://x.com/ai_researcher/status/123',
    },
    {
      type: 'post',
      title: 'React 19 + Suspense for data fetching lessons',
      author: '@frontenddev',
      link: 'https://x.com/frontenddev/status/456',
    },
    {
      type: 'user',
      title: 'Jane Doe — product + ML',
      author: '@janedoe',
      link: 'https://x.com/janedoe',
    },
  ];

  const runSearch = async () => {
    setSearching(true);
    setSearchAnswer(null);
    try {
      // Placeholder: in real flow call Grok API with transcript context + query
      await new Promise((res) => setTimeout(res, 800));
      setSearchAnswer(`(Stub) Answer about "${searchQuery}" based on your recording context would appear here.`);
    } catch (err: any) {
      setSearchAnswer(`Search failed: ${err?.message || 'unknown error'}`);
    } finally {
      setSearching(false);
    }
  };

  const formatDuration = (seconds?: number) => {
    const val = typeof seconds === 'string' ? parseFloat(seconds) : seconds;
    if (val === undefined || val === null || Number.isNaN(val)) return '—';
    const mins = Math.floor(val / 60);
    const secs = Math.floor(val % 60)
      .toString()
      .padStart(2, '0');
    return `${mins}:${secs}`;
  };

  return (
    <div className="container">
      <h1>🎧 Listening Buddy (Desktop)</h1>
      <div className="status-box">
        <p className="status-text">{status}</p>
      </div>

      <div className="controls">
        {!isConnected ? (
          <button className="btn-primary" onClick={startMicCapture}>
            Start Microphone
          </button>
        ) : (
          <button className="btn-danger" onClick={stopCapture}>
            Stop Listening
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <p className="card-title">Integrations</p>
            <p className="card-subtitle">Connect X (Twitter) API keys for insights.</p>
          </div>
          <span className={`pill ${integrationStatus.connected ? 'pill-on' : 'pill-off'}`}>
            {integrationStatus.connected ? 'Connected' : 'Not connected'}
          </span>
        </div>

        {integrationStatus.user && (
          <div className="card-subtitle">
            Connected as: {integrationStatus.user?.data?.username || integrationStatus.user?.data?.name || 'Unknown'}
          </div>
        )}

        <div className="actions">
          <button className="link-button" onClick={startOAuth}>Connect with X OAuth</button>
          {integrationStatus.updated_at && <span className="meta">Updated: {new Date(integrationStatus.updated_at).toLocaleString()}</span>}
        </div>
        <div className="debug-section">
          <p>Redirect URI: http://localhost:8000/integrations/x/oauth/callback</p>
        </div>
        {saveMessage && <p className="status-text">{saveMessage}</p>}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <p className="card-title">Recordings</p>
            <p className="card-subtitle">Completed sessions</p>
          </div>
          <span className="pill pill-off">{sessions.length} total</span>
        </div>
        <div className="recordings-list">
          {sessions.length === 0 && <p className="status-text">No recordings yet.</p>}
          {sessions.map((session, idx) => (
            <button
              key={session.session_id}
              className="recording-row"
              onClick={() => setSelectedSession(session)}
            >
              <div className="recording-main">
                <span className="recording-title">Recording {idx + 1} ({session.session_id})</span>
                <span className="recording-meta">
                  {session.start_time ? new Date(session.start_time).toLocaleString() : 'Unknown start'}
                </span>
              </div>
              <div className="recording-meta">
                Duration: {formatDuration(session.duration_seconds)} | Chunks: {session.chunks ?? 0}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="debug-section">
        <p>Backend WS: {WS_URL}</p>
      </div>

      {selectedSession && (
        <div className="modal-backdrop" onClick={() => setSelectedSession(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="card-title">Recording Details</p>
                <p className="card-subtitle">
                  Recording ID: {selectedSession.session_id.slice(0, 8)}… • {selectedSession.start_time ? new Date(selectedSession.start_time).toLocaleString() : 'Unknown start'}
                </p>
              </div>
              <button className="btn-danger" onClick={() => setSelectedSession(null)}>Close</button>
            </div>

            <div className="modal-section">
              <p className="section-title">X Artifacts</p>
              <div className="artifact-grid">
                {dummyArtifacts.map((item, i) => (
                  <div key={i} className="artifact-card">
                    <p className="artifact-type">{item.type === 'post' ? 'Post' : 'User'}</p>
                    <p className="artifact-title">{item.title}</p>
                    <p className="artifact-meta">by {item.author}</p>
                    <a className="artifact-link" href={item.link} target="_blank" rel="noreferrer">View</a>
                  </div>
                ))}
              </div>
            </div>

            <div className="modal-section">
              <p className="section-title">Ask Grok about this recording</p>
              <div className="search-row">
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Ask a question about what you heard..."
                />
                <button className="btn-primary" onClick={runSearch} disabled={searching || !searchQuery.trim()}>
                  {searching ? 'Thinking...' : 'Ask'}
                </button>
              </div>
              <div className="search-answer">
                {searchAnswer ? <p>{searchAnswer}</p> : <p className="status-text">Responses will appear here.</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
