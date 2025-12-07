const { app, BrowserWindow, systemPreferences } = require('electron');
const path = require('path');

const isDev = process.env.ELECTRON_START_URL;

async function createWindow() {
  // On macOS request mic access up front to avoid NotAllowedError in renderer
  try {
    if (process.platform === 'darwin') {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status !== 'granted') {
        await systemPreferences.askForMediaAccess('microphone');
      }
    }
  } catch (err) {
    console.warn('Mic permission check failed:', err);
  }

  const win = new BrowserWindow({
    width: 380,
    height: 520,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL(process.env.ELECTRON_START_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
