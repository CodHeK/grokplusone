// Preload stays minimal for now. If you need IPC, expose APIs here.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('env', {
  ELECTRON: true,
});
