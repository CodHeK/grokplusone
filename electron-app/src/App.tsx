import { useEffect, useRef, useState } from 'react';
import './style.css';

const WS_URL = 'ws://localhost:8000/ws/audio';
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
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // On macOS the main process already asked for mic access, but we still handle renderer errors.
    return () => stopCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <div className="debug-section">
        <p>Backend WS: {WS_URL}</p>
      </div>
    </div>
  );
}

export default App;
