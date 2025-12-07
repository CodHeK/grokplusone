import { useState, useRef } from 'react';
import './App.css';
import { convertFloat32ToInt16, downsampleBuffer } from './utils/audioUtils';

// Config
const WS_URL = 'ws://localhost:8000/ws/audio';
const TARGET_SAMPLE_RATE = 16000;
type CaptureMode = 'tab' | 'mic';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [status, setStatus] = useState('Ready to listen');
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  const isRestrictedUrl = (url?: string) => {
    if (!url) return true;
    const blockedPrefixes = ['chrome://', 'edge://', 'about:', 'chrome-extension://'];
    const blockedHosts = ['https://chrome.google.com'];
    return blockedPrefixes.some((prefix) => url.startsWith(prefix)) || blockedHosts.some((host) => url.startsWith(host));
  };

  const requestTabCapturePermission = () =>
    new Promise<boolean>((resolve, reject) => {
      chrome.permissions.request({ permissions: ['tabCapture'] }, (granted) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(Boolean(granted));
      });
    });

  const startTabCapture = async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const currentTab = tabs[0];
      if (!currentTab?.id) {
        return setStatus('Error: No active tab found.');
      }

      if (isRestrictedUrl(currentTab.url)) {
        return setStatus('Error: Cannot capture chrome/system pages. Open a regular site and retry.');
      }

      const granted = await requestTabCapturePermission();
      if (!granted) {
        return setStatus('Permission denied for tab capture.');
      }

      setStatus(`Requesting tab audio from: ${currentTab.title ?? 'current tab'}`);

      const stream = await new Promise<MediaStream>((resolve, reject) => {
        // Capture the currently active tab (requires the extension to be invoked on that tab)
        chrome.tabCapture.capture({ audio: true, video: false }, (capturedStream: MediaStream | null) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          if (!capturedStream) {
            return reject(new Error('No stream captured.'));
          }
          resolve(capturedStream);
        });
      });

      connectStream(stream, 'tab', currentTab.title ?? 'tab');
    } catch (err: any) {
      console.error(err);
      const msg = err?.message || 'Unknown error';
      if (msg.includes('activeTab')) {
        setStatus('Error: Chrome needs the extension invoked on this tab. Click the Listening Buddy icon on the target tab (not chrome:// pages) and retry.');
      } else if (msg.includes('Unexpected property')) {
        setStatus('Error: tabCapture options not supported in this Chrome version. Please update Chrome and retry.');
      } else {
        setStatus(`Error: ${msg}`);
      }
    }
  };

  const startMicCapture = async () => {
    try {
      setStatus('Requesting microphone...');

      // Attempt to request mic permission via the injected iframe/content script with a user gesture.
      const grantedViaIframe = await requestMicPermissionViaContentScript();
      if (!grantedViaIframe) {
        setStatus('Mic permission denied or dismissed. Please allow microphone access.');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });

      connectStream(stream, 'mic', 'microphone');
    } catch (err: any) {
      console.error(err);
      const friendly =
        err?.name === 'NotAllowedError'
          ? 'Mic blocked. Please allow microphone access in Chrome and try again.'
          : err?.name === 'NotFoundError'
            ? 'No microphone found. Plug one in and retry.'
            : err?.message || 'Unknown error';
      setStatus(`Mic error: ${friendly}`);
    }
  };

  const requestMicPermissionViaContentScript = async (): Promise<boolean> => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return false;
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'REQUEST_MIC_PERMISSION' });
      if (response?.status === 'granted') return true;
      return false;
    } catch (err) {
      console.warn('Mic permission via content script failed', err);
      return false;
    }
  };

  const connectStream = (stream: MediaStream, captureMode: CaptureMode, sourceLabel: string) => {
    streamRef.current = stream;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setMode(captureMode);
      setStatus(`Streaming ${sourceLabel} audio to backend...`);
      setIsConnected(true);
      processAudio(stream);
    };

    ws.onclose = () => {
      setIsConnected(false);
      setStatus('Disconnected');
      stopCapture();
    };

    ws.onerror = (err) => {
      console.error("WS Error", err);
      setStatus('Connection Error');
    };
  };

  const processAudio = (stream: MediaStream) => {
    // 3. Audio Processing Pipeline
    const audioContext = new AudioContext(); // Browser default (usually 44.1 or 48kHz)
    audioContextRef.current = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Downsample to 16kHz
      const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, TARGET_SAMPLE_RATE);

      // Convert to Int16 PCM
      const pcm16 = convertFloat32ToInt16(downsampled);

      // Send to backend
      wsRef.current.send(pcm16.buffer);
    };
  };

  const stopCapture = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
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
      <h1>🎧 Listening Buddy</h1>
      <div className="status-box">
        <p className="status-text">{status}</p>
      </div>

      <div className="controls">
        {!isConnected ? (
          <>
            <button className="btn-primary" onClick={startTabCapture}>
              Start Tab Audio
            </button>
            <button className="btn-primary" onClick={startMicCapture}>
              Start Microphone
            </button>
          </>
        ) : (
          <button className="btn-danger" onClick={stopCapture}>
            Stop Listening
          </button>
        )}
      </div>

      <div className="debug-section">
        <p>Debug Log:</p>
        <pre className="log-output">
          Run on a real URL (Youtube, etc).
          {mode ? `\nMode: ${mode === 'tab' ? 'Tab audio' : 'Microphone audio'}` : ''}
        </pre>
      </div>
    </div>
  );
}

export default App;
