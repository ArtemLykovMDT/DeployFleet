const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');

const DEFAULT_VITE_URL = 'http://localhost:3000';
let activeChild = null;

const listUnitConfigFiles = (unitId) => {
  const cwd = process.cwd();
  const root = path.join(cwd, 'scripts', 'staging', unitId);
  const results = [];
  if (!fs.existsSync(root)) return results;

  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'unit.config') {
        results.push({
          path: fullPath,
          relativePath: path.relative(root, fullPath)
        });
      }
    }
  };

  walk(root);
  return results;
};

const listUnitFiles = (unitId) => {
  const cwd = process.cwd();
  const root = path.join(cwd, 'scripts', 'staging', unitId);
  const results = [];
  if (!fs.existsSync(root)) return results;

  const allowedExt = new Set(['.config', '.json', '.txt', '.ini', '.yml', '.yaml']);

  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!allowedExt.has(ext)) continue;
        results.push({
          path: fullPath,
          relativePath: path.relative(root, fullPath)
        });
      }
    }
  };

  walk(root);
  return results;
};

const readEnvFile = (filePath) => {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const env = {};

  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const match = line.match(/^\s*([^=]+?)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const key = match[1].trim();
    const rawValue = match[2].trim();
    const unquoted = rawValue.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    env[key] = unquoted;
  }

  return env;
};

const loadEnv = () => {
  const cwd = process.cwd();
  return {
    ...readEnvFile(path.join(cwd, '.env')),
    ...readEnvFile(path.join(cwd, '.env.local'))
  };
};

const readEnvEntries = () => {
  const cwd = process.cwd();
  const localPath = path.join(cwd, '.env.local');
  const basePath = path.join(cwd, '.env');
  const localEnv = readEnvFile(localPath);
  const baseEnv = readEnvFile(basePath);

  const merged = { ...baseEnv, ...localEnv };
  return Object.entries(merged)
    .filter(([key]) => key !== 'PAT')
    .map(([key, value]) => ({ key, value }));
};

const readEnvMeta = () => {
  const cwd = process.cwd();
  const localPath = path.join(cwd, '.env.local');
  const basePath = path.join(cwd, '.env');
  const localEnv = readEnvFile(localPath);
  const baseEnv = readEnvFile(basePath);
  const merged = { ...baseEnv, ...localEnv };
  return { hasPat: Boolean(merged.PAT) };
};

const getUnitOverrideInfo = (filePath) => {
  if (!filePath) return null;
  const cwd = process.cwd();
  const stagingRoot = path.join(cwd, 'scripts', 'staging');
  const normalized = path.normalize(filePath);
  const rootPrefix = stagingRoot.toLowerCase() + path.sep;
  if (!normalized.toLowerCase().startsWith(rootPrefix)) return null;

  const relativeToStaging = path.relative(stagingRoot, normalized);
  const parts = relativeToStaging.split(path.sep);
  if (parts.length < 2) return null;
  const unitId = parts[0];
  if (!unitId || unitId === '.unit-config-overrides') return null;
  const relativePath = parts.slice(1).join(path.sep);
  const overridePath = path.join(stagingRoot, '.unit-config-overrides', unitId, relativePath);
  return { unitId, relativePath, overridePath };
};

const writeEnvEntries = (entries) => {
  const cwd = process.cwd();
  const localPath = path.join(cwd, '.env.local');
  const existingLocal = readEnvFile(localPath);
  const preservedPat = existingLocal.PAT;
  const preservedUnitOverrides = Object.entries(existingLocal)
    .filter(([key]) => key.startsWith('UNIT_'))
    .reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});

  const safeEntries = (entries || [])
    .filter((entry) => entry && entry.key && entry.key !== 'PAT')
    .map((entry) => ({ key: entry.key.trim(), value: String(entry.value ?? '') }));

  const nextEnv = {};
  for (const entry of safeEntries) {
    if (!entry.key) continue;
    nextEnv[entry.key] = entry.value;
  }

  const merged = { ...nextEnv, ...preservedUnitOverrides };
  const lines = Object.keys(merged).map((key) => `${key}=${merged[key]}`);
  if (preservedPat) {
    lines.push(`PAT=${preservedPat}`);
  }

  fs.writeFileSync(localPath, lines.join('\n'), 'utf8');
};

const writeUnitOverrides = (payload) => {
  const { unitId, overrides } = payload || {};
  if (!unitId) return;

  const cwd = process.cwd();
  const localPath = path.join(cwd, '.env.local');
  const existingLocal = readEnvFile(localPath);
  const prefix = `UNIT_${unitId}_`;

  Object.keys(existingLocal).forEach((key) => {
    if (key.startsWith(prefix)) delete existingLocal[key];
  });

  if (overrides) {
    if (overrides.dataVanHmiIp) {
      existingLocal[`${prefix}MPC_DataVanHMIIp`] = overrides.dataVanHmiIp;
    }
    if (overrides.localHmiIp) {
      existingLocal[`${prefix}MPC_LocalHMIIp`] = overrides.localHmiIp;
    }
    if (overrides.mpcSecondaryIp) {
      existingLocal[`${prefix}MPC_MPCSecondaryIp`] = overrides.mpcSecondaryIp;
    }
  }

  const lines = Object.keys(existingLocal).map((key) => `${key}=${existingLocal[key]}`);
  fs.writeFileSync(localPath, lines.join('\n'), 'utf8');
};

const writeUnitConfigOverrides = (payload) => {
  const { unitId, overrides } = payload || {};
  if (!unitId) return;
  const cwd = process.cwd();
  const localPath = path.join(cwd, '.env.local');
  const existingLocal = readEnvFile(localPath);

  const key = `UNIT_${unitId}_CONFIG_OVERRIDES`;
  if (overrides && Object.keys(overrides).length > 0) {
    existingLocal[key] = JSON.stringify(overrides);
  } else {
    delete existingLocal[key];
  }

  const lines = Object.keys(existingLocal).map((envKey) => `${envKey}=${existingLocal[envKey]}`);
  fs.writeFileSync(localPath, lines.join('\n'), 'utf8');
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0b1220',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const url = process.env.ELECTRON_START_URL || DEFAULT_VITE_URL;
  win.loadURL(url);
};

const runPowerShell = (scriptPath, args) => {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...loadEnv()
    };
    const resolvedPath = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.join(process.cwd(), scriptPath);

    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', resolvedPath,
      ...args
    ];

    const child = spawn('powershell.exe', psArgs, { env });
    activeChild = child;
    resolve(child);
  });
};

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('run-script', async (event, payload) => {
    const { scriptPath, args } = payload;
    const win = BrowserWindow.fromWebContents(event.sender);
    const child = await runPowerShell(scriptPath, args || []);

    child.stdout.on('data', (data) => {
      const message = data.toString().trim();
      if (!message) return;
      win?.webContents.send('log', {
        timestamp: new Date().toISOString(),
        message,
        type: 'INFO'
      });
    });

    child.stderr.on('data', (data) => {
      const message = data.toString().trim();
      if (!message) return;
      win?.webContents.send('log', {
        timestamp: new Date().toISOString(),
        message,
        type: 'ERROR'
      });
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', resolve);
    });
    if (activeChild === child) {
      activeChild = null;
    }

    return { success: exitCode === 0 };
  });

  ipcMain.handle('stop-script', async () => {
    if (!activeChild || activeChild.killed) {
      return { success: false, message: 'No active process.' };
    }

    const pid = activeChild.pid;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        activeChild.kill('SIGTERM');
      }
      return { success: true };
    } catch (error) {
      return { success: false, message: String(error) };
    }
  });

  ipcMain.handle('read-env', async () => {
    return readEnvEntries();
  });

  ipcMain.handle('read-env-meta', async () => {
    return readEnvMeta();
  });

  ipcMain.handle('write-env', async (event, payload) => {
    writeEnvEntries(payload?.entries || []);
    return { success: true };
  });

  ipcMain.handle('write-unit-overrides', async (event, payload) => {
    writeUnitOverrides(payload);
    return { success: true };
  });

  ipcMain.handle('read-unit-configs', async (event, payload) => {
    const unitId = payload?.unitId;
    if (!unitId) return { files: [] };
    const files = listUnitConfigFiles(unitId).map((file) => {
      const raw = fs.readFileSync(file.path, 'utf8');
      return {
        path: file.path,
        relativePath: file.relativePath,
        content: raw
      };
    });
    return { files };
  });

  ipcMain.handle('write-unit-config', async (event, payload) => {
    const { path: filePath, content } = payload || {};
    if (!filePath) return { success: false };
    try {
      const normalized = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : '';
      fs.writeFileSync(filePath, normalized, { encoding: 'utf8' });
      const overrideInfo = getUnitOverrideInfo(filePath);
      if (overrideInfo && overrideInfo.relativePath.toLowerCase().endsWith('unit.config')) {
        fs.mkdirSync(path.dirname(overrideInfo.overridePath), { recursive: true });
        fs.writeFileSync(overrideInfo.overridePath, normalized, { encoding: 'utf8' });
      }
      return { success: true };
    } catch (error) {
      console.error('write-unit-config failed', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('write-unit-config-overrides', async (event, payload) => {
    try {
      writeUnitConfigOverrides(payload);
      return { success: true };
    } catch (error) {
      console.error('write-unit-config-overrides failed', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('open-export-log', async (event, payload) => {
    const content = payload?.content || '';
    const filename = payload?.filename || `deploy_log_${Date.now()}.txt`;
    const targetPath = path.join(os.tmpdir(), filename);
    const normalized = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : '';
    fs.writeFileSync(targetPath, normalized, { encoding: 'utf8' });
    await shell.openPath(targetPath);
    return { success: true, path: targetPath };
  });

  ipcMain.handle('list-unit-files', async (event, payload) => {
    const unitId = payload?.unitId;
    if (!unitId) return { files: [] };
    return { files: listUnitFiles(unitId) };
  });

  ipcMain.handle('read-unit-file', async (event, payload) => {
    const filePath = payload?.path;
    if (!filePath) return { success: false, content: '' };
    if (!fs.existsSync(filePath)) return { success: false, content: '' };
    const raw = fs.readFileSync(filePath, 'utf8');
    return { success: true, content: raw };
  });

  ipcMain.handle('write-unit-file', async (event, payload) => {
    const { path: filePath, content } = payload || {};
    if (!filePath) return { success: false };
    const normalized = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : '';
    fs.writeFileSync(filePath, normalized, { encoding: 'utf8' });
    return { success: true };
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
