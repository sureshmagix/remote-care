const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload = {}) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('remoteCare', {
  getSetupState: () => invoke('setup-state'),
  setupAdmin: (payload) => invoke('setup-admin', payload),
  login: (payload) => invoke('login', payload),
  logout: (token) => invoke('logout', { token }),
  getDashboard: (token) => invoke('dashboard', { token }),
  getNetworkAdapters: (token) => invoke('network-adapters', { token }),
  saveTarget: (token, target) => invoke('target-save', { token, target }),
  deleteTarget: (token, targetId) => invoke('target-delete', { token, targetId }),
  runTarget: (token, targetId) => invoke('target-run', { token, targetId }),
  acknowledgeIncident: (token, incidentId) => invoke('incident-acknowledge', { token, incidentId }),
  listUsers: (token) => invoke('users-list', { token }),
  createViewer: (token, user) => invoke('viewer-create', { token, user }),
  setViewerActive: (token, userId, active) => invoke('viewer-set-active', { token, userId, active }),
  resetViewerPassword: (token, userId, password) => invoke('viewer-reset-password', { token, userId, password }),
  getAppInfo: (token) => invoke('app-info', { token }),
  onUpdate: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('monitor-update', wrapped);
    return () => ipcRenderer.removeListener('monitor-update', wrapped);
  }
});
