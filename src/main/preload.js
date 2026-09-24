const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload = {}) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('remoteCare', {
  getSetupState: () => invoke('setup-state'),
  setupAdmin: (payload) => invoke('setup-admin', payload),
  login: (payload) => invoke('login', payload),
  logout: (token) => invoke('logout', { token }),
  getDashboard: (token) => invoke('dashboard', { token }),
  getCheckHistory: (token, filters) => invoke('history-list', { token, filters }),
  exportMonthlyReport: (token, month) => invoke('history-export-monthly-report', { token, month }),
  testNotification: (token) => invoke('notification-test', { token }),
  getNetworkAdapters: (token) => invoke('network-adapters', { token }),
  saveTarget: (token, target) => invoke('target-save', { token, target }),
  deleteTarget: (token, targetId) => invoke('target-delete', { token, targetId }),
  runTarget: (token, targetId) => invoke('target-run', { token, targetId }),
  acknowledgeIncident: (token, incidentId) => invoke('incident-acknowledge', { token, incidentId }),
  listUsers: (token) => invoke('users-list', { token }),
  createViewer: (token, user) => invoke('viewer-create', { token, user }),
  setViewerActive: (token, userId, active) => invoke('viewer-set-active', { token, userId, active }),
  resetViewerPassword: (token, userId, password) => invoke('viewer-reset-password', { token, userId, password }),
  changePassword: (token, currentPassword, newPassword) => invoke('user-change-password', { token, currentPassword, newPassword }),
  updateProfile: (token, profile) => invoke('user-update-profile', { token, profile }),
  updateViewer: (token, userId, updates) => invoke('viewer-update', { token, userId, updates }),
  getAppSettings: (token) => invoke('app-settings', { token }),
  saveAppSettings: (token, settings) => invoke('app-settings-save', { token, settings }),
  getAppControlState: (token) => invoke('app-control-state', { token }),
  quitWithPassword: (token, password, source) => invoke('quit-with-password', { token, password, source }),
  cancelProtectedQuit: (token) => invoke('cancel-protected-quit', { token }),
  getAppInfo: (token) => invoke('app-info', { token }),
  onUpdate: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('monitor-update', wrapped);
    return () => ipcRenderer.removeListener('monitor-update', wrapped);
  },
  onAppControl: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('app-control', wrapped);
    return () => ipcRenderer.removeListener('app-control', wrapped);
  }
});
