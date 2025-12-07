import { useEffect, useRef, useState } from 'react';
import './style.css';

const WS_URL = 'ws://localhost:8000/ws/audio';
const API_URL = 'http://localhost:8000';
const TARGET_SAMPLE_RATE = 16000;

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

      <div className="debug-section">
        <p>Backend WS: {WS_URL}</p>
      </div>
    </div>
  );
}

export default App;
