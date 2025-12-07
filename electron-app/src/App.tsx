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
  title?: string;
};

type InsightPayload = {
  timestamp?: string;
  notes: string[];
  artifacts?: { title: string; url: string }[];
  artifact_query?: string;
};

type ArtifactItem = {
  title: string;
  url: string;
  tweet?: any;
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
  const [insights, setInsights] = useState<InsightPayload[] | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const insightsWsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchIntegrationStatus();
    fetchSessions();
    ensureUserInterests();
  }, []);

  useEffect(() => {
    if (selectedSession) {
      setInsights([]);
      setArtifacts([]);
      fetchInsights(selectedSession.session_id);
      fetchArtifacts(selectedSession.session_id);
      connectInsightsWs(selectedSession.session_id);
    }
    return () => {
      if (insightsWsRef.current) {
        insightsWsRef.current.close();
        insightsWsRef.current = null;
      }
    };
  }, [selectedSession]);

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
      // Optimistically fetch sessions so the new session appears
      setTimeout(fetchSessions, 500);
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

  const stopCapture = async () => {
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
    const latest = await fetchSessions();
    if (latest.length > 0 && !latest[0].title) {
      await generateTitle(latest[0].session_id);
      await fetchSessions();
    }
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

  const ensureUserInterests = async () => {
    try {
      await fetch(`${API_URL}/user-interests/generate`, { method: 'POST' });
    } catch (err) {
      console.warn('Failed to generate user interests', err);
    }
  };

  const startOAuth = async () => {
    try {
      const res = await fetch(`${API_URL}/integrations/x/oauth/start`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.auth_url) {
        window.open(data.auth_url, '_blank');
        setTimeout(fetchIntegrationStatus, 3000);
        setTimeout(fetchIntegrationStatus, 8000);
      }
    } catch (err) {
      setSaveMessage(`OAuth start failed: ${(err as any)?.message || 'unknown error'}`);
    }
  };

  const fetchSessions = async (): Promise<SessionSummary[]> => {
    try {
      const res = await fetch(`${API_URL}/sessions`);
      const data = await res.json();
      const normalized = (data.sessions || []).map((s: SessionSummary) => ({
        ...s,
        duration_seconds: s.duration_seconds !== undefined ? Number(s.duration_seconds) : undefined,
      }));
      setSessions(normalized);
      return normalized;
    } catch (err) {
      console.warn('Failed to fetch sessions', err);
      return [];
    }
  };

  const generateTitle = async (sessionId: string) => {
    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/title`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.warn('Failed to generate title', err);
      return null;
    }
  };

  const connectInsightsWs = (sessionId: string) => {
    if (!sessionId) return;
    const wsUrl = `${API_URL.replace('http', 'ws')}/ws/insights/${sessionId}`;
    try {
      const ws = new WebSocket(wsUrl);
      insightsWsRef.current = ws;

          ws.onmessage = (event) => {
            try {
              const payload = JSON.parse(event.data);
              if (payload.type === 'insights_init' && payload.insights) {
                setInsights(payload.insights);
                setArtifacts(payload.insights.flatMap((entry: InsightPayload) => entry.artifacts || []));
              } else if (payload.type === 'insights' && payload.data) {
                setInsights((prev) => {
                  const next = prev ? [...prev, payload.data] : [payload.data];
                  return next;
                });
                setArtifacts(payload.data.artifacts || []);
              }
            } catch (e) {
              console.warn('Failed to parse insights ws message', e);
            }
          };

      ws.onclose = () => {
        insightsWsRef.current = null;
      };

      ws.onerror = (err) => {
        console.warn('Insights WS error', err);
      };
    } catch (err) {
      console.warn('Failed to open insights websocket', err);
    }
  };
  const fetchInsights = async (sessionId: string) => {
    setInsightsLoading(true);
    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/insights`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data.insights || [];
      setInsights(list);
    } catch (err) {
      console.warn('Failed to fetch insights', err);
      setInsights([]);
    } finally {
      setInsightsLoading(false);
    }
  };

  const fetchArtifacts = async (sessionId: string) => {
    setArtifactsLoading(true);
    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/artifacts`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setArtifacts(data.artifacts || []);
    } catch (err) {
      console.warn('Failed to fetch artifacts', err);
      setArtifacts([]);
    } finally {
      setArtifactsLoading(false);
    }
  };

  const runSearch = async () => {
    setSearching(true);
    setSearchAnswer(null);
    try {
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

  const combinedNotes = (insights ? [...insights].reverse() : []).flatMap((item) => (item.notes ? [...item.notes].reverse() : []));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-6 py-6 flex flex-col gap-6">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center font-bold text-slate-900 shadow-glow">
              LB
            </div>
            <div>
              <p className="text-lg font-semibold">Listening Buddy</p>
              <p className="text-sm text-slate-400">Voice-first infinite context</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={integrationStatus.connected ? 'pill-on' : 'pill-off'}>
              {integrationStatus.connected ? 'X Connected' : 'X Not Connected'}
            </span>
            <button
              onClick={startOAuth}
              className="rounded-full border border-blue-400/50 px-4 py-2 text-sm font-semibold text-blue-200 hover:bg-blue-500/10 transition"
            >
              Connect X
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 glass rounded-3xl p-6 relative overflow-hidden">
            <div className="absolute inset-0 pointer-events-none opacity-40 blur-3xl" style={{ background: 'radial-gradient(circle at 30% 30%, rgba(59,130,246,0.15), transparent 40%), radial-gradient(circle at 80% 20%, rgba(56,189,248,0.18), transparent 35%)' }} />
            <div className="relative flex flex-col gap-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Voice Agent</p>
                  <p className="text-2xl font-semibold">Speak and listen with infinite memory</p>
                </div>
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${isConnected ? 'bg-emerald-500/15 text-emerald-200' : 'bg-slate-800 text-slate-300'}`}>
                  {isConnected ? 'Live' : 'Idle'}
                </span>
              </div>

              <div className="flex flex-col items-center gap-4 py-6">
                <div className="relative h-48 w-48 flex items-center justify-center rounded-full voice-orb glow border border-blue-400/20">
                  <div className={`h-32 w-32 rounded-full bg-slate-900/70 border border-blue-400/40 flex items-center justify-center ${isConnected ? 'animate-pulse' : ''}`}>
                    <span className="text-lg font-semibold">{isConnected ? 'Listening…' : 'Tap to speak'}</span>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-slate-300">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                  <p className="text-sm">{status}</p>
                </div>
                <div className="flex gap-3">
                  {!isConnected ? (
                    <button
                      onClick={startMicCapture}
                      className="rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 px-6 py-3 text-slate-950 font-semibold shadow-glow transition hover:scale-105"
                    >
                      Start Recording
                    </button>
                  ) : (
                    <button
                      onClick={stopCapture}
                      className="rounded-full bg-red-500/90 px-6 py-3 text-slate-50 font-semibold shadow-lg shadow-red-500/30 transition hover:scale-105"
                    >
                      Stop Recording
                    </button>
                  )}
                </div>
              </div>

              <div className="glass rounded-2xl p-4">
                <div className="flex items-center justify-between text-sm text-slate-300">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    <span>{isConnected ? 'Streaming to backend' : 'Not streaming'}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span>WS: {WS_URL}</span>
                    {integrationStatus.updated_at && <span>Last X sync: {new Date(integrationStatus.updated_at).toLocaleString()}</span>}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="glass rounded-2xl p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">Integrations</p>
                  <p className="text-lg font-semibold">X (Twitter)</p>
                </div>
                <span className={integrationStatus.connected ? 'pill-on' : 'pill-off'}>
                  {integrationStatus.connected ? 'Connected' : 'Not Connected'}
                </span>
              </div>
              {saveMessage && <p className="text-sm text-slate-300 mt-2">{saveMessage}</p>}
              {integrationStatus.user && (
                <p className="text-sm text-slate-400 mt-2">
                  Connected as {integrationStatus.user?.data?.username || integrationStatus.user?.data?.name || 'Unknown'}
                </p>
              )}
              <p className="text-xs text-slate-500 mt-2">Redirect URI: http://localhost:8000/integrations/x/oauth/callback</p>
            </div>

            <div className="glass rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm text-slate-400">Recordings</p>
                  <p className="text-lg font-semibold">Recent sessions</p>
                </div>
                <span className="pill-off">{sessions.length} total</span>
              </div>
              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1">
                {sessions.length === 0 && <p className="text-sm text-slate-400">No recordings yet.</p>}
                {sessions.map((session, idx) => (
                  <button
                    key={session.session_id}
                    className="w-full rounded-xl border border-white/5 bg-white/5 px-3 py-2 text-left hover:border-blue-400/30 transition"
                    onClick={() => setSelectedSession(session)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-semibold">
                        {session.title ? session.title : `Processing ...`}
                      </span>
                      <span className="text-xs text-slate-400">{formatDuration(session.duration_seconds)}</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {session.start_time ? new Date(session.start_time).toLocaleString() : 'Unknown start'}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {selectedSession && (
          <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 px-4" onClick={() => setSelectedSession(null)}>
            <div
              className="w-full max-w-4xl rounded-3xl bg-slate-900 border border-white/10 p-6 shadow-2xl shadow-blue-500/10"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">Recording</p>
                  <p className="text-xl font-semibold">
                    {selectedSession.title ? selectedSession.title : `Session ${selectedSession.session_id.slice(0, 6)}…`}
                  </p>
                  <p className="text-xs text-slate-500">
                    {selectedSession.start_time ? new Date(selectedSession.start_time).toLocaleString() : 'Unknown start'} • {formatDuration(selectedSession.duration_seconds)} • {selectedSession.chunks ?? 0} chunks
                  </p>
                </div>
                <button
                  className="rounded-full bg-red-500/90 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => setSelectedSession(null)}
                >
                  Close
                </button>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-4">
                <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm uppercase tracking-[0.15em] text-slate-400">Live notes & artifacts</p>
                    <span className="pill-on">Auto-updating</span>
                  </div>
                  {insightsLoading && <p className="text-sm text-slate-400">Loading insights…</p>}
                  {!insightsLoading && insights && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
                      <div className="flex flex-col gap-2">
                        {insights.length === 0 ? (
                          <p className="text-sm text-slate-400">No insights yet.</p>
                        ) : (
                          <div className="rounded-xl border border-white/10 bg-slate-900/70 p-3 flex flex-col gap-2">
                            <p className="text-xs text-slate-500">Notes</p>
                            {combinedNotes.length > 0 ? (
                              <div className="flex flex-col gap-1 text-sm text-slate-200">
                                {combinedNotes.map((note, idx) => (
                                  <p key={idx} className="note-fade">
                                    {note}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm text-slate-500">No notes yet.</p>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2">
                        {artifactsLoading && <p className="text-sm text-slate-400">Loading artifacts…</p>}
                        {!artifactsLoading &&
                          artifacts.map((art, idx) => (
                            <a
                              key={idx}
                              className="rounded-xl border border-white/10 bg-slate-900/70 p-3 flex flex-col gap-1 hover:border-blue-400/40 transition"
                              href={art.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <p className="text-sm font-semibold text-slate-100">{art.title}</p>
                              <p className="text-xs text-slate-500 break-all">{art.url}</p>
                            </a>
                          ))}
                        {!artifactsLoading && artifacts.length === 0 && <p className="text-sm text-slate-400">No artifacts yet.</p>}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
