const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  runScript: (scriptPath, args) => ipcRenderer.invoke('run-script', { scriptPath, args }),
  stopScript: () => ipcRenderer.invoke('stop-script'),
  readEnv: () => ipcRenderer.invoke('read-env'),
  readEnvMeta: () => ipcRenderer.invoke('read-env-meta'),
  writeEnv: (entries) => ipcRenderer.invoke('write-env', { entries }),
  writeUnitOverrides: (payload) => ipcRenderer.invoke('write-unit-overrides', payload),
  readUnitConfigs: (unitId) => ipcRenderer.invoke('read-unit-configs', { unitId }),
  writeUnitConfig: (payload) => ipcRenderer.invoke('write-unit-config', payload),
  writeUnitConfigOverrides: (payload) => ipcRenderer.invoke('write-unit-config-overrides', payload),
  openExportLog: (payload) => ipcRenderer.invoke('open-export-log', payload),
  listUnitFiles: (unitId) => ipcRenderer.invoke('list-unit-files', { unitId }),
  readUnitFile: (path) => ipcRenderer.invoke('read-unit-file', { path }),
  writeUnitFile: (payload) => ipcRenderer.invoke('write-unit-file', payload),
  onLog: (callback) => {
    ipcRenderer.removeAllListeners('log');
    ipcRenderer.on('log', (_event, entry) => callback(entry));
  },
  offLog: () => {
    ipcRenderer.removeAllListeners('log');
  },
  platform: process.platform
});
