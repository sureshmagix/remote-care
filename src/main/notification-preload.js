const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopNotification', {
  onNotification: (listener) => {
    ipcRenderer.on('desktop-notification', (_event, payload) => listener(payload));
    ipcRenderer.send('desktop-notification-ready');
  },
  visible: (id, height) => ipcRenderer.send('desktop-notification-visible', id, height),
  dismiss: (id) => ipcRenderer.send('desktop-notification-dismiss', id),
  openDashboard: (id) => ipcRenderer.send('desktop-notification-open', id)
});
