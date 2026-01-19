import { LogEntry } from '../types';

// --- SHARED HELPERS ---

const TIMESTAMP = () => new Date().toISOString().split('T')[1].slice(0, 8);

export const generateMockLog = (unitId: string, message: string, type: 'INFO' | 'ERROR' | 'SUCCESS' | 'WARNING' = 'INFO'): LogEntry => ({
  timestamp: TIMESTAMP(),
  message: `[${unitId}] ${message}`,
  type
});

// --- REAL DEPLOYMENT LOGIC (VIA ELECTRON IPC) ---

const runLiveUnitDeployment = async (
  unitId: string,
  scriptPath: string,
  onLog: (log: LogEntry) => void,
  shouldCancel?: () => boolean
): Promise<boolean> => {
  if (!window.electron) return false;

  try {
    if (shouldCancel?.()) {
      onLog(generateMockLog(unitId, `Cancellation requested before start.`, 'WARNING'));
      return false;
    }
    onLog(generateMockLog(unitId, `Initiating Live Deployment via Electron Host...`));
    
    // We assume window.electron.onLog is set up globally in App.tsx or similar, 
    // but for unit-specific confirmation we can trust the promise result 
    // or filtering global logs in the UI component.
    
    const result = await window.electron.runScript(scriptPath, ['-UnitNumber', unitId]);
    
    if (result.success) {
      onLog(generateMockLog(unitId, `Process exited successfully.`, 'SUCCESS'));
      return true;
    } else {
      onLog(generateMockLog(unitId, `Process exited with error code.`, 'ERROR'));
      return false;
    }
  } catch (err: any) {
    onLog(generateMockLog(unitId, `IPC Bridge Error: ${err.message}`, 'ERROR'));
    return false;
  }
};

const runLiveBatchDeployment = async (
  unitIds: string[],
  scriptPath: string,
  onLog: (log: LogEntry) => void,
  shouldCancel?: () => boolean
): Promise<{ success: string[], failed: string[] }> => {
  if (!window.electron) return { success: [], failed: unitIds };

  const joinedIds = unitIds.join(',');
  const systemId = 'BATCH';

  try {
    if (shouldCancel?.()) {
      onLog(generateMockLog(systemId, `Cancellation requested before start.`, 'WARNING'));
      return { success: [], failed: unitIds };
    }
    onLog(generateMockLog(systemId, `Initiating Batch Deployment for: [${joinedIds}]`));
    const result = await window.electron.runScript(scriptPath, ['-UnitNumber', joinedIds]);
    
    if (result.success) {
      onLog(generateMockLog(systemId, `Batch process completed successfully.`, 'SUCCESS'));
      // In a real batch script, we'd parse stdout to know exactly which failed, 
      // but here we assume all succeeded if exit code 0 for the orchestrator.
      return { success: unitIds, failed: [] };
    } else {
      onLog(generateMockLog(systemId, `Batch process failed.`, 'ERROR'));
      return { success: [], failed: unitIds };
    }
  } catch (err: any) {
    onLog(generateMockLog(systemId, `IPC Error: ${err.message}`, 'ERROR'));
    return { success: [], failed: unitIds };
  }
};


// --- SIMULATION LOGIC (BROWSER FALLBACK) ---

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const delayWithCancel = async (ms: number, shouldCancel?: () => boolean) => {
  const step = 100;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldCancel?.()) return false;
    await delay(Math.min(step, ms - elapsed));
    elapsed += step;
  }
  return true;
};

const simulateUnitDeployment = async (
  unitId: string,
  scriptPath: string,
  onLog: (log: LogEntry) => void,
  shouldCancel?: () => boolean
): Promise<boolean> => {
  onLog(generateMockLog(unitId, `[SIMULATION] Starting deployment process...`));
  if (!(await delayWithCancel(800, shouldCancel))) return false;

  onLog(generateMockLog(unitId, `[SIMULATION] Executing Download-AdoUnit.ps1 -UnitNumber ${unitId}`));
  if (!(await delayWithCancel(1200, shouldCancel))) return false;
  onLog(generateMockLog(unitId, `> Downloading artifacts from ADO...`));
  if (!(await delayWithCancel(1000, shouldCancel))) return false;
  onLog(generateMockLog(unitId, `> Artifacts downloaded to ./staging/${unitId}`));

  onLog(generateMockLog(unitId, `[SIMULATION] Executing Update-MPC-UnitConfig.ps1 -UnitNumber ${unitId}`));
  if (!(await delayWithCancel(800, shouldCancel))) return false;
  onLog(generateMockLog(unitId, `> Patching unit.config with environment variables...`));
  
  if (Math.random() < 0.1) {
    onLog(generateMockLog(unitId, `ERROR: Failed to connect to remote host (Simulated).`, 'ERROR'));
    return false;
  }

  onLog(generateMockLog(unitId, `> Config updated successfully.`));
  onLog(generateMockLog(unitId, `[SIMULATION] Starting Docker services...`));
  onLog(generateMockLog(unitId, `> docker compose -f ./staging/${unitId}/docker-compose.yml up -d --build`));
  if (!(await delayWithCancel(2000, shouldCancel))) return false;
  
  onLog(generateMockLog(unitId, `> Container [${unitId}_mpc_core] Created`));
  onLog(generateMockLog(unitId, `Deployment sequence completed successfully.`, 'SUCCESS'));
  return true;
};

const simulateBatchDeployment = async (
  unitIds: string[],
  scriptPath: string,
  onLog: (log: LogEntry) => void,
  shouldCancel?: () => boolean
): Promise<{ success: string[], failed: string[] }> => {
  const joinedIds = unitIds.join(',');
  const systemId = 'BATCH';
  const successUnits: string[] = [];
  const failedUnits: string[] = [];

  onLog(generateMockLog(systemId, `[SIMULATION] Starting Multi-Unit Batch Deployment...`));
  onLog(generateMockLog(systemId, `Executing: ${scriptPath} -UnitNumber "${joinedIds}"`));
  if (!(await delayWithCancel(1000, shouldCancel))) {
    return { success: [], failed: unitIds };
  }
  
  for (const id of unitIds) {
    if (shouldCancel?.()) {
      onLog(generateMockLog(systemId, `Cancellation requested.`, 'WARNING'));
      failedUnits.push(id, ...unitIds.slice(unitIds.indexOf(id) + 1));
      break;
    }
    onLog(generateMockLog(systemId, `> Processing unit inside batch: ${id}`));
    onLog(generateMockLog(id, `>> Downloading artifacts...`));
    if (!(await delayWithCancel(500, shouldCancel))) {
      failedUnits.push(id);
      continue;
    }
    
    if (Math.random() < 0.05) {
      onLog(generateMockLog(id, `>> ERROR: Failed to download artifacts inside batch run.`, 'ERROR'));
      failedUnits.push(id);
      continue; 
    }
    onLog(generateMockLog(id, `>> Unit ready.`));
    successUnits.push(id);
  }

  onLog(generateMockLog(systemId, `Batch execution completed. Success: ${successUnits.length}, Failed: ${failedUnits.length}`, 'SUCCESS'));
  return { success: successUnits, failed: failedUnits };
};


// --- EXPORTED PUBLIC API ---

export const deployUnit = async (
  unitId: string,
  scriptPath: string,
  onLog: (log: LogEntry) => void,
  shouldCancel?: () => boolean
): Promise<boolean> => {
  if (window.electron) {
    return runLiveUnitDeployment(unitId, scriptPath, onLog, shouldCancel);
  } else {
    onLog(generateMockLog(unitId, "Browser detected: Running in SIMULATION mode.", "WARNING"));
    return simulateUnitDeployment(unitId, scriptPath, onLog, shouldCancel);
  }
};

export const deployBatch = async (
  unitIds: string[],
  scriptPath: string,
  onLog: (log: LogEntry) => void,
  shouldCancel?: () => boolean
): Promise<{ success: string[], failed: string[] }> => {
  if (window.electron) {
    return runLiveBatchDeployment(unitIds, scriptPath, onLog, shouldCancel);
  } else {
    onLog(generateMockLog("BATCH", "Browser detected: Running in SIMULATION mode.", "WARNING"));
    return simulateBatchDeployment(unitIds, scriptPath, onLog, shouldCancel);
  }
};

export const runScriptAction = async (
  scriptPath: string,
  args: string[],
  onLog: (log: LogEntry) => void
): Promise<boolean> => {
  const actionId = 'SCRIPT';
  if (window.electron) {
    try {
    onLog(generateMockLog(actionId, `Running ${scriptPath} ${args.join(' ')}`));
    const result = await window.electron.runScript(scriptPath, args);
      if (result.success) {
        onLog(generateMockLog(actionId, `Script completed successfully.`, 'SUCCESS'));
        return true;
      }
      onLog(generateMockLog(actionId, `Script failed.`, 'ERROR'));
      return false;
    } catch (err: any) {
      onLog(generateMockLog(actionId, `IPC Error: ${err.message}`, 'ERROR'));
      return false;
    }
  }

  onLog(generateMockLog(actionId, `[SIMULATION] Running ${scriptPath} ${args.join(' ')}`, 'WARNING'));
  await delay(800);
  onLog(generateMockLog(actionId, `Simulation complete.`, 'SUCCESS'));
  return true;
};
