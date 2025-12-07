// Background Service Worker

// Open Side Panel on Action Click
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

chrome.runtime.onInstalled.addListener(() => {
    console.log("Listening Buddy installed");
});

// We will handle tabCapture here later
// Usually requires an offscreen document for stream processing in MV3 if not just piping to WebAudio
