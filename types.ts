export enum UnitStatus {
  PENDING = 'PENDING',
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  SKIPPED = 'SKIPPED'
}

export enum UnitSource {
  OCR = 'OCR',
  MANUAL = 'MANUAL'
}

export interface Unit {
  id: string;
  registrationName: string;
  confidence?: number;
  source: UnitSource;
  status: UnitStatus;
  group?: string;
  logOutput?: string[];
  ipOverrides?: {
    dataVanHmiIp?: string;
    localHmiIp?: string;
    mpcSecondaryIp?: string;
  };
}

export interface DeploymentConfig {
  scriptPath: string;
  sequential: boolean;
  continueOnFailure: boolean;
  batchMode: boolean; // Advanced: Sends all units as comma-separated array to script
}

export interface LogEntry {
  timestamp: string;
  message: string;
  type: 'INFO' | 'ERROR' | 'SUCCESS' | 'WARNING';
}

export interface ElectronAPI {
  runScript: (scriptPath: string, args: string[]) => Promise<{ success: boolean }>;
  stopScript: () => Promise<{ success: boolean; message?: string }>;
  onLog: (callback: (entry: LogEntry) => void) => void;
  offLog: () => void;
  platform: string;
  readEnv: () => Promise<Array<{ key: string; value: string }>>;
  readEnvMeta: () => Promise<{ hasPat: boolean }>;
  writeEnv: (entries: Array<{ key: string; value: string }>) => Promise<{ success: boolean }>;
  writeUnitOverrides: (payload: { unitId: string; overrides?: Unit['ipOverrides'] }) => Promise<{ success: boolean }>;
  readUnitConfigs: (unitId: string) => Promise<{ files: Array<{ path: string; relativePath: string; content: string }> }>;
  writeUnitConfig: (payload: { path: string; content: string }) => Promise<{ success: boolean }>;
  writeUnitConfigOverrides: (payload: { unitId: string; overrides?: Record<string, Record<string, unknown>> }) => Promise<{ success: boolean }>;
  openExportLog: (payload: { content: string; filename?: string }) => Promise<{ success: boolean; path: string }>;
  listUnitFiles: (unitId: string) => Promise<{ files: Array<{ path: string; relativePath: string }> }>;
  readUnitFile: (path: string) => Promise<{ success: boolean; content: string }>;
  writeUnitFile: (payload: { path: string; content: string }) => Promise<{ success: boolean }>;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}
