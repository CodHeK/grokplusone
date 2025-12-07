// Inject a hidden iframe that can request microphone permission in the extension origin.
(function injectMicFrame() {
  const existing = document.getElementById('listening-buddy-mic-frame');
  if (existing) return;

  const iframe = document.createElement('iframe');
  iframe.id = 'listening-buddy-mic-frame';
  iframe.src = chrome.runtime.getURL('mic-frame.html');
  iframe.style.position = 'fixed';
  iframe.style.width = '1px';
  iframe.style.height = '1px';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';
  iframe.style.border = '0';
  iframe.allow = 'microphone';

  document.documentElement.appendChild(iframe);
})();

// Bridge messages from the extension to the iframe so we can request mic permission with a user gesture.
const pending = new Map();
window.addEventListener('message', (event) => {
  if (event.source !== document.getElementById('listening-buddy-mic-frame')?.contentWindow) return;
  const data = event.data || {};
  if (!data.reqId || !pending.has(data.reqId)) return;
  const respond = pending.get(data.reqId);
  pending.delete(data.reqId);
  respond(data);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'REQUEST_MIC_PERMISSION') {
    const iframe = document.getElementById('listening-buddy-mic-frame');
    if (!iframe || !iframe.contentWindow) {
      sendResponse({ status: 'no_iframe' });
      return;
    }
    const reqId = crypto.randomUUID();
    pending.set(reqId, (data) => sendResponse(data));
    iframe.contentWindow.postMessage({ type: 'REQUEST_MIC_PERMISSION', reqId }, '*');
    return true; // async response
  }
  return undefined;
});
