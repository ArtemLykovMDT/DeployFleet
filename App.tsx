import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import DropZone from './components/DropZone';
import UnitList from './components/UnitList';
import DeploymentConsole from './components/DeploymentConsole';
import { Unit, UnitStatus, UnitSource, DeploymentConfig, LogEntry } from './types';
import { processImage } from './services/ocrService';
import { deployUnit, deployBatch, generateMockLog, runScriptAction } from './services/mockDeploymentService';
import { Play, Octagon, Settings, Monitor, Laptop } from 'lucide-react';

const App: React.FC = () => {
  // State
  const [units, setUnits] = useState<Unit[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isRunningScript, setIsRunningScript] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [envEntries, setEnvEntries] = useState<Array<{ key: string; value: string }>>([]);
  const [isEnvLoading, setIsEnvLoading] = useState(false);
  const [isEnvSaving, setIsEnvSaving] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const [hasPat, setHasPat] = useState(false);
  const [unitOverrides, setUnitOverrides] = useState<Record<string, Unit['ipOverrides']>>({});
  const [unitConfigDefaults, setUnitConfigDefaults] = useState<Record<string, Record<string, Record<string, unknown>>>>({});
  const [templateDefaults, setTemplateDefaults] = useState<Record<string, { updatedAt: string; sourceUnitId: string; configOverrides: Record<string, Record<string, unknown>> }>>({});
  const [unitConfigFiles, setUnitConfigFiles] = useState<Record<string, Array<{ path: string; relativePath: string; content: string }>>>({});
  const [unitConfigErrors, setUnitConfigErrors] = useState<Record<string, string | null>>({});
  const [unitConfigLoading, setUnitConfigLoading] = useState<Record<string, boolean>>({});
  const [unitFileLists, setUnitFileLists] = useState<Record<string, Array<{ path: string; relativePath: string }>>>({});
  const [unitFileSelections, setUnitFileSelections] = useState<Record<string, string>>({});
  const [unitFileContents, setUnitFileContents] = useState<Record<string, string>>({});
  const [unitFileErrors, setUnitFileErrors] = useState<Record<string, string | null>>({});
  const [unitFileLoading, setUnitFileLoading] = useState<Record<string, boolean>>({});
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'env' | 'ai'>('env');
  const [unitSteps, setUnitSteps] = useState<Record<string, string>>({});
  const [unitErrors, setUnitErrors] = useState<Record<string, string>>({});
  const [unitHistory, setUnitHistory] = useState<Record<string, { lastStatus: UnitStatus; lastRun: string }>>({});
  const [presetName, setPresetName] = useState('');
  const [presets, setPresets] = useState<Array<{ name: string; ids: string[] }>>([]);
  const [groupPresetName, setGroupPresetName] = useState('');
  const [reviewMode, setReviewMode] = useState(false);
  const [verifiedIds, setVerifiedIds] = useState<string[]>([]);
  const cancelRef = useRef(false);
  const prevStatusRef = useRef<Record<string, UnitStatus>>({});
  
  // Config State
  const [config, setConfig] = useState<DeploymentConfig>({
    scriptPath: './Scripts/Deploy-UpdatedUnits.ps1',
    sequential: true,
    continueOnFailure: true,
    batchMode: false
  });

  const parseUnitOverrides = useCallback((entries: Array<{ key: string; value: string }>) => {
    const overrides: Record<string, Unit['ipOverrides']> = {};
    entries.forEach((entry) => {
      const match = entry.key.match(/^UNIT_(.+?)_(MPC_DataVanHMIIp|MPC_LocalHMIIp|MPC_MPCSecondaryIp)$/i);
      if (!match) return;
      const unitId = match[1];
      const field = match[2];
      if (!overrides[unitId]) overrides[unitId] = {};
      if (field.toLowerCase() === 'mpc_datavanhmiip') {
        overrides[unitId].dataVanHmiIp = entry.value;
      } else if (field.toLowerCase() === 'mpc_localhmiip') {
        overrides[unitId].localHmiIp = entry.value;
      } else if (field.toLowerCase() === 'mpc_mpcsecondaryip') {
        overrides[unitId].mpcSecondaryIp = entry.value;
      }
    });
    return overrides;
  }, []);

  const parseUnitConfigOverrides = useCallback((entries: Array<{ key: string; value: string }>) => {
    const overrides: Record<string, Record<string, Record<string, unknown>>> = {};
    entries.forEach((entry) => {
      const match = entry.key.match(/^UNIT_(.+?)_CONFIG_OVERRIDES$/i);
      if (!match) return;
      const unitId = match[1];
      try {
        overrides[unitId] = JSON.parse(entry.value);
      } catch (error) {
        console.error(error);
      }
    });
    return overrides;
  }, []);

  const buildConfigOverridesFromFiles = useCallback((files: Array<{ relativePath: string; content: string }>) => {
    const overrides: Record<string, Record<string, unknown>> = {};
    files.forEach((file) => {
      try {
        const parsed = JSON.parse(file.content);
        if (parsed && typeof parsed === 'object') {
          overrides[file.relativePath] = parsed as Record<string, unknown>;
        }
      } catch (error) {
        console.error(error);
      }
    });
    return overrides;
  }, []);

  const requiredEnvKeys = ['PAT', 'LinuxHost', 'LinuxUser', 'LinuxPassword', 'MPC_DataVanHMIIp', 'MPC_LocalHMIIp'];
  const aiModelSuggestions = [
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash',
    'gemini-3-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite-preview',
    'gemini-2.0-pro',
    'gemini-2.0-flash-exp',
    'gemini-2.0-flash-thinking-exp',
    'gemini-2.0-pro-exp',
    'gemini-2.0-flash-001',
    'gemini-2.0-pro-001',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro-001',
    'gemini-1.5-flash-001',
    'gemini-1.0-pro'
  ];
  const openAiModelSuggestions = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'o1',
    'o1-mini',
    'o1-preview',
    'o3-mini'
  ];
  const missingEnvKeys = useMemo(() => {
    if (!isDesktop) return [];
    const available = new Set(envEntries.map(entry => entry.key));
    return requiredEnvKeys.filter(key => {
      if (key === 'PAT') return !hasPat;
      return !available.has(key);
    });
  }, [envEntries, hasPat, isDesktop]);

  const defaultIps = useMemo(() => {
    const lookup = (key: string) => envEntries.find(entry => entry.key === key)?.value;
    return {
      dataVanHmiIp: lookup('MPC_DataVanHMIIp') || '',
      localHmiIp: lookup('MPC_LocalHMIIp') || '',
      mpcSecondaryIp: lookup('MPC_MPCSecondaryIp') || ''
    };
  }, [envEntries]);

  const aiProvider = useMemo(() => {
    const value = envEntries.find(entry => entry.key === 'AI_PROVIDER')?.value?.trim().toLowerCase();
    return value === 'openai' ? 'openai' : 'gemini';
  }, [envEntries]);

  const aiModel = useMemo(() => {
    const value =
      envEntries.find(entry => entry.key === 'GEMINI_MODEL')?.value ||
      envEntries.find(entry => entry.key === 'AI_MODEL')?.value ||
      '';
    return value || 'gemini-3-flash-preview';
  }, [envEntries]);

  const openAiModel = useMemo(() => {
    const value =
      envEntries.find(entry => entry.key === 'OPENAI_MODEL')?.value ||
      envEntries.find(entry => entry.key === 'AI_MODEL')?.value ||
      '';
    return value || 'gpt-4o-mini';
  }, [envEntries]);

  const openAiApiKey = useMemo(() => {
    return envEntries.find(entry => entry.key === 'OPENAI_API_KEY')?.value || '';
  }, [envEntries]);

  const openAiBaseUrl = useMemo(() => {
    return envEntries.find(entry => entry.key === 'OPENAI_BASE_URL')?.value || 'https://api.openai.com/v1';
  }, [envEntries]);

  const scriptActions = [
    {
      id: 'deploy',
      label: 'Deploy Selected',
      path: './scripts/Deploy-UpdatedUnits.ps1',
      requiresUnits: true,
      unitParam: '-UnitNumber',
      unitArgStyle: 'comma' as const
    },
    {
      id: 'download',
      label: 'Download Unit Files',
      path: './scripts/Download-AdoUnit.ps1',
      requiresUnits: true,
      unitParam: '-UnitNumber',
      unitArgStyle: 'repeat' as const
    },
    {
      id: 'update-config',
      label: 'Update Unit Configs',
      path: './scripts/Update-MPC-UnitConfig.ps1',
      requiresUnits: true,
      unitParam: '-UnitNumber',
      unitArgStyle: 'repeat' as const
    },
    {
      id: 'upload',
      label: 'Upload Unit Files',
      path: './scripts/Upload-AdoUnit.ps1',
      requiresUnits: true,
      unitParam: '-UnitNumber',
      unitArgStyle: 'repeat' as const
    },
    {
      id: 'get-etc',
      label: 'Get Etc Files',
      path: './scripts/Get-AdoEtcFiles.ps1',
      requiresUnits: true,
      unitParam: '-UnitNumbers',
      unitArgStyle: 'repeat' as const
    },
    {
      id: 'build',
      label: 'Build Staging Units',
      path: './scripts/Build-AdoUnits.ps1',
      requiresUnits: false
    },
    {
      id: 'inject-compose',
      label: 'Inject Docker Compose',
      path: './scripts/Inject-DockerCompose.ps1',
      requiresUnits: false
    },
    {
      id: 'generate-compose',
      label: 'Generate Docker Compose',
      path: './scripts/Generate-DockerCompose.ps1',
      requiresUnits: false
    },
    {
      id: 'fetch',
      label: 'Fetch (ADO Scan)',
      path: './scripts/Fetch.ps1',
      requiresUnits: false
    }
  ];
  const [selectedScriptId, setSelectedScriptId] = useState(scriptActions[0].id);
  const groupOptions = useMemo(() => {
    const groups = new Set<string>();
    units.forEach(unit => groups.add(unit.group || 'Unassigned'));
    return Array.from(groups).sort();
  }, [units]);

  // Check environment
  useEffect(() => {
    if (window.electron) {
      setIsDesktop(true);
      // Hook up global log listener from backend
      window.electron.onLog((entry: LogEntry) => {
        appendLog(entry);
      });
      setIsEnvLoading(true);
      Promise.all([window.electron.readEnv(), window.electron.readEnvMeta()])
        .then(([entries, meta]) => {
          const settingsEntries = entries.filter(entry => !entry.key.startsWith('UNIT_'));
          setEnvEntries(settingsEntries);
          setUnitOverrides(parseUnitOverrides(entries));
          setUnitConfigDefaults(parseUnitConfigOverrides(entries));
          setHasPat(meta.hasPat);
          setEnvError(null);
        })
        .catch((error) => {
          console.error(error);
          setEnvError('Failed to load environment settings.');
        })
        .finally(() => setIsEnvLoading(false));
      return () => {
        window.electron?.offLog();
      };
    }
  }, []);

  useEffect(() => {
    setUnits(prev => prev.map(unit => {
      const overrides = unitOverrides[unit.id];
      if (!overrides && !unit.ipOverrides) return unit;
      if (!overrides) {
        return unit.ipOverrides ? { ...unit, ipOverrides: undefined } : unit;
      }
      const same = JSON.stringify(overrides) === JSON.stringify(unit.ipOverrides || {});
      return same ? unit : { ...unit, ipOverrides: overrides };
    }));
  }, [unitOverrides]);

  useEffect(() => {
    const storedPresets = localStorage.getItem('fleetDeployPresets');
    if (storedPresets) {
      try {
        setPresets(JSON.parse(storedPresets));
      } catch (error) {
        console.error(error);
      }
    }
    const storedHistory = localStorage.getItem('fleetDeployHistory');
    if (storedHistory) {
      try {
        setUnitHistory(JSON.parse(storedHistory));
      } catch (error) {
        console.error(error);
      }
    }
    const storedUnits = localStorage.getItem('fleetDeployUnits');
    if (storedUnits) {
      try {
        setUnits(JSON.parse(storedUnits));
      } catch (error) {
        console.error(error);
      }
    }
    const storedSelected = localStorage.getItem('fleetDeploySelected');
    if (storedSelected) {
      try {
        setSelectedIds(JSON.parse(storedSelected));
      } catch (error) {
        console.error(error);
      }
    }
    const storedLogs = localStorage.getItem('fleetDeployLogs');
    if (storedLogs) {
      try {
        setLogs(JSON.parse(storedLogs));
      } catch (error) {
        console.error(error);
      }
    }
    const storedVerified = localStorage.getItem('fleetDeployVerified');
    if (storedVerified) {
      try {
        setVerifiedIds(JSON.parse(storedVerified));
      } catch (error) {
        console.error(error);
      }
    }
    const storedTemplates = localStorage.getItem('fleetDeployTemplateDefaults');
    if (storedTemplates) {
      try {
        setTemplateDefaults(JSON.parse(storedTemplates));
      } catch (error) {
        console.error(error);
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('fleetDeployPresets', JSON.stringify(presets));
  }, [presets]);

  useEffect(() => {
    localStorage.setItem('fleetDeployHistory', JSON.stringify(unitHistory));
  }, [unitHistory]);

  useEffect(() => {
    localStorage.setItem('fleetDeployUnits', JSON.stringify(units));
  }, [units]);

  useEffect(() => {
    localStorage.setItem('fleetDeploySelected', JSON.stringify(selectedIds));
  }, [selectedIds]);

  useEffect(() => {
    const trimmedLogs = logs.slice(-500);
    localStorage.setItem('fleetDeployLogs', JSON.stringify(trimmedLogs));
  }, [logs]);

  useEffect(() => {
    localStorage.setItem('fleetDeployVerified', JSON.stringify(verifiedIds));
  }, [verifiedIds]);

  useEffect(() => {
    localStorage.setItem('fleetDeployTemplateDefaults', JSON.stringify(templateDefaults));
  }, [templateDefaults]);

  const updateStepFromLog = useCallback((entry: LogEntry) => {
    const match = entry.message.match(/^\[(.+?)\]\s*(.*)$/);
    if (!match) return;
    const unitId = match[1];
    const text = match[2];
    const normalized = text.toLowerCase();

    if (normalized.includes('downloading')) {
      setUnitSteps(prev => ({ ...prev, [unitId]: 'Downloading' }));
      return;
    }
    if (normalized.includes('updating unit config') || normalized.includes('config updated') || normalized.includes('patching unit.config')) {
      setUnitSteps(prev => ({ ...prev, [unitId]: 'Updating Config' }));
      return;
    }
    if (normalized.includes('docker compose') || normalized.includes('starting docker') || normalized.includes('compose')) {
      setUnitSteps(prev => ({ ...prev, [unitId]: 'Composing Services' }));
      return;
    }
    if (normalized.includes('deployment sequence completed') || normalized.includes('process exited successfully')) {
      setUnitSteps(prev => ({ ...prev, [unitId]: 'Completed' }));
      return;
    }
    if (entry.type === 'ERROR') {
      setUnitSteps(prev => ({ ...prev, [unitId]: 'Failed' }));
      setUnitErrors(prev => ({ ...prev, [unitId]: entry.message }));
    }
  }, []);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs(prev => [...prev, entry]);
    updateStepFromLog(entry);
  }, [updateStepFromLog]);

  // Handlers
  const handleImageLoaded = async (file: File) => {
    setIsProcessing(true);
    try {
      const extractedUnits = await processImage(file, {
        provider: aiProvider,
        model: aiProvider === 'openai' ? openAiModel : aiModel,
        openAiApiKey,
        openAiBaseUrl
      });
      // Deduplicate against existing
      const newUnits = extractedUnits.filter(
        newU => !units.some(existing => existing.id === newU.id)
      );
      
      const mergedUnits = newUnits.map(unit => ({
        ...unit,
        ipOverrides: unitOverrides[unit.id]
      }));
      setUnits(prev => [...prev, ...mergedUnits]);
      
      // Do not auto-select OCR results; user chooses explicitly.

      if (extractedUnits.length === 0) {
        alert("No valid units found in image. Please try again or add manually.");
      } else if (extractedUnits.length < 2) {
        // Warning per requirements
      appendLog({
        timestamp: new Date().toISOString().split('T')[1].slice(0, 8),
        message: "Warning: Fewer than 2 units detected. Please verify OCR results.",
        type: "WARNING"
      });
      }

    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : 'Unknown error.';
      appendLog(generateMockLog('SYSTEM', `OCR failed: ${message}`, 'ERROR'));
      alert(`Error processing image. ${message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAddUnit = (id: string, group?: string) => {
    if (units.some(u => u.id === id)) return;
    const newUnit: Unit = {
      id,
      registrationName: id,
      source: UnitSource.MANUAL,
      status: UnitStatus.PENDING,
      group,
      ipOverrides: unitOverrides[id]
    };
    setUnits(prev => [...prev, newUnit]);
    setSelectedIds(prev => [...prev, id]);
  };

  const handleRemoveUnits = (ids: string[]) => {
    setUnits(prev => prev.filter(u => !ids.includes(u.id)));
    setSelectedIds(prev => prev.filter(id => !ids.includes(id)));
  };

  const handleSelectionChange = (ids: string[]) => {
    setSelectedIds(ids);
  };

  const handleUpdateGroup = (ids: string[], group: string) => {
    const normalizedGroup = group && group.trim() ? group : undefined;
    setUnits(prev => prev.map(unit => (
      ids.includes(unit.id) ? { ...unit, group: normalizedGroup } : unit
    )));
  };

  const handleRetry = (unitId: string) => {
    if (!selectedIds.includes(unitId)) {
        setSelectedIds(prev => [...prev, unitId]);
    }
    setUnits(prev => prev.map(u => u.id === unitId ? { ...u, status: UnitStatus.PENDING } : u));
    appendLog(generateMockLog(unitId, `Reset for retry.`, 'INFO'));
  };

  const handleDeploy = async () => {
    if (selectedIds.length === 0) return;

    setIsDeploying(true);
    cancelRef.current = false;
    if (isDesktop && missingEnvKeys.length > 0) {
      alert(`Missing required env keys: ${missingEnvKeys.join(', ')}`);
      setIsDeploying(false);
      return;
    }

    setLogs([]);
    
    // Reset status of selected units
    setUnits(prev => prev.map(u => 
      selectedIds.includes(u.id) ? { ...u, status: UnitStatus.QUEUED } : u
    ));
    setUnitSteps(prev => {
      const next = { ...prev };
      selectedIds.forEach(id => { next[id] = 'Queued'; });
      return next;
    });

    const unitsToDeploy = units.filter(u => selectedIds.includes(u.id));
    const idsToDeploy = unitsToDeploy.map(u => u.id);
    
    appendLog(generateMockLog('SYSTEM', `Starting deployment for ${unitsToDeploy.length} units...`));
    appendLog(generateMockLog('SYSTEM', `Script: ${config.scriptPath}`));
    
    if (config.batchMode) {
      // --- BATCH MODE ---
      setUnits(prev => prev.map(u => idsToDeploy.includes(u.id) ? { ...u, status: UnitStatus.RUNNING } : u));
      
      const result = await deployBatch(idsToDeploy, config.scriptPath, (log) => {
        setLogs(prev => [...prev, log]);
      }, () => cancelRef.current);

      setUnits(prev => prev.map(u => {
        if (!idsToDeploy.includes(u.id)) return u;
        if (result.success.includes(u.id)) return { ...u, status: UnitStatus.SUCCESS };
        if (result.failed.includes(u.id)) return { ...u, status: UnitStatus.FAILED };
        return u;
      }));

    } else {
      // --- SEQUENTIAL MODE ---
      for (const unit of unitsToDeploy) {
        if (cancelRef.current) {
          appendLog(generateMockLog('SYSTEM', `Cancellation requested. Stopping sequence...`, 'WARNING'));
          setUnits(prev => prev.map(u => u.status === UnitStatus.QUEUED ? { ...u, status: UnitStatus.SKIPPED } : u));
          break;
        }
        setUnits(prev => prev.map(u => u.id === unit.id ? { ...u, status: UnitStatus.RUNNING } : u));
        setUnitSteps(prev => ({ ...prev, [unit.id]: 'Deploying' }));
        
        const success = await deployUnit(unit.id, config.scriptPath, (log) => {
          appendLog(log);
        }, () => cancelRef.current);

        if (success) {
          setUnits(prev => prev.map(u => u.id === unit.id ? { ...u, status: UnitStatus.SUCCESS } : u));
          setUnitSteps(prev => ({ ...prev, [unit.id]: 'Completed' }));
        } else {
          setUnits(prev => prev.map(u => u.id === unit.id ? { ...u, status: UnitStatus.FAILED } : u));
          setUnitSteps(prev => ({ ...prev, [unit.id]: 'Failed' }));
          
          if (cancelRef.current) {
            appendLog(generateMockLog('SYSTEM', `Execution canceled by user.`, 'WARNING'));
            setUnits(prev => prev.map(u => u.status === UnitStatus.QUEUED ? { ...u, status: UnitStatus.SKIPPED } : u));
            break;
          }
          if (!config.continueOnFailure) {
            appendLog(generateMockLog('SYSTEM', `Aborting sequence due to failure in unit ${unit.id}`, 'ERROR'));
            setUnits(prev => prev.map(u => u.status === UnitStatus.QUEUED ? { ...u, status: UnitStatus.SKIPPED } : u));
            break;
          }
        }
      }
    }

    setIsDeploying(false);
    appendLog(generateMockLog('SYSTEM', `Execution finished.`));
  };

  const handleCancel = () => {
    setIsDeploying(false);
    cancelRef.current = true;
    if (window.electron) {
      window.electron.stopScript().then((result) => {
        if (result.success) {
          appendLog(generateMockLog('SYSTEM', `Active process stopped.`, 'WARNING'));
        } else {
          appendLog(generateMockLog('SYSTEM', result.message || `No active process to stop.`, 'WARNING'));
        }
      }).catch((error) => {
        appendLog(generateMockLog('SYSTEM', `Stop failed: ${String(error)}`, 'ERROR'));
      });
    }
    setUnits(prev => prev.map(u => {
      if (u.status === UnitStatus.QUEUED) return { ...u, status: UnitStatus.SKIPPED };
      if (u.status === UnitStatus.RUNNING) return { ...u, status: UnitStatus.FAILED };
      return u;
    }));
    appendLog(generateMockLog('SYSTEM', `User requested cancellation. Stopping future tasks...`, 'WARNING'));
  };

  const handleRunScript = async () => {
    const selectedScript = scriptActions.find(script => script.id === selectedScriptId);
    if (!selectedScript) return;
    if (selectedScript.requiresUnits && selectedIds.length === 0) {
      alert('Select at least one unit to run this script.');
      return;
    }

    setIsRunningScript(true);
    const unitIds = selectedScript.requiresUnits ? selectedIds : [];
    const args =
      selectedScript.unitArgStyle === 'comma'
        ? [selectedScript.unitParam, unitIds.join(',')]
        : selectedScript.unitArgStyle === 'repeat'
          ? [selectedScript.unitParam, ...unitIds]
          : [];

    appendLog(generateMockLog('SYSTEM', `Running script: ${selectedScript.label}`));
    await runScriptAction(selectedScript.path, args, (log) => {
      appendLog(log);
    });
    setIsRunningScript(false);
  };

  const handleAddEnvEntry = () => {
    setEnvEntries(prev => [...prev, { key: '', value: '' }]);
  };

  const upsertEnvEntry = (key: string, value: string) => {
    setEnvEntries(prev => {
      const trimmedKey = key.trim();
      if (!trimmedKey || trimmedKey === 'PAT') return prev;
      const trimmedValue = value.trim();
      const existingIndex = prev.findIndex(entry => entry.key === trimmedKey);
      if (!trimmedValue) {
        if (existingIndex === -1) return prev;
        return prev.filter(entry => entry.key !== trimmedKey);
      }
      if (existingIndex === -1) {
        return [...prev, { key: trimmedKey, value: trimmedValue }];
      }
      return prev.map((entry, index) =>
        index === existingIndex ? { ...entry, value: trimmedValue } : entry
      );
    });
  };

  const handleUpdateEnvEntry = (index: number, field: 'key' | 'value', value: string) => {
    setEnvEntries(prev => prev.map((entry, idx) => (
      idx === index ? { ...entry, [field]: value } : entry
    )));
  };

  const handleRemoveEnvEntry = (index: number) => {
    setEnvEntries(prev => prev.filter((_, idx) => idx !== index));
  };

  const handleSaveEnv = async () => {
    if (!window.electron) return;
    setIsEnvSaving(true);
    const cleaned = envEntries
      .map(entry => ({ key: entry.key.trim(), value: entry.value }))
      .filter(entry => entry.key && entry.key !== 'PAT');

    try {
      await window.electron.writeEnv(cleaned);
      setEnvError(null);
    } catch (error) {
      console.error(error);
      setEnvError('Failed to save environment settings.');
    } finally {
      setIsEnvSaving(false);
    }
  };

  const handleLoadUnitFiles = useCallback(async (unitId: string) => {
    if (!window.electron || isDeploying || isRunningScript) return;
    setUnitFileLoading(prev => ({ ...prev, [unitId]: true }));
    setUnitFileErrors(prev => ({ ...prev, [unitId]: null }));
    try {
      const result = await window.electron.listUnitFiles(unitId);
      const files = (result.files || []).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      setUnitFileLists(prev => ({ ...prev, [unitId]: files }));
      if (files.length > 0 && !unitFileSelections[unitId]) {
        setUnitFileSelections(prev => ({ ...prev, [unitId]: files[0].path }));
      }
    } catch (error) {
      console.error(error);
      setUnitFileErrors(prev => ({ ...prev, [unitId]: 'Failed to load file list.' }));
    } finally {
      setUnitFileLoading(prev => ({ ...prev, [unitId]: false }));
    }
  }, [isDeploying, isRunningScript, unitFileSelections]);

  const handleOpenUnitFile = useCallback(async (unitId: string, filePath?: string) => {
    if (!window.electron || isDeploying || isRunningScript) return;
    const targetPath = filePath || unitFileSelections[unitId];
    if (!targetPath) return;
    setUnitFileLoading(prev => ({ ...prev, [unitId]: true }));
    setUnitFileErrors(prev => ({ ...prev, [unitId]: null }));
    try {
      const result = await window.electron.readUnitFile(targetPath);
      if (!result.success) {
        setUnitFileErrors(prev => ({ ...prev, [unitId]: 'Unable to read file.' }));
        return;
      }
      setUnitFileSelections(prev => ({ ...prev, [unitId]: targetPath }));
      setUnitFileContents(prev => ({ ...prev, [unitId]: result.content }));
    } catch (error) {
      console.error(error);
      setUnitFileErrors(prev => ({ ...prev, [unitId]: 'Unable to read file.' }));
    } finally {
      setUnitFileLoading(prev => ({ ...prev, [unitId]: false }));
    }
  }, [isDeploying, isRunningScript, unitFileSelections]);

  const handleUpdateUnitFileContent = (unitId: string, content: string) => {
    setUnitFileContents(prev => ({ ...prev, [unitId]: content }));
  };

  const handleSaveUnitFile = useCallback(async (unitId: string) => {
    if (!window.electron || isDeploying || isRunningScript) return;
    const filePath = unitFileSelections[unitId];
    if (!filePath) return;
    setUnitFileLoading(prev => ({ ...prev, [unitId]: true }));
    setUnitFileErrors(prev => ({ ...prev, [unitId]: null }));
    try {
      await window.electron.writeUnitFile({ path: filePath, content: unitFileContents[unitId] || '' });
    } catch (error) {
      console.error(error);
      setUnitFileErrors(prev => ({ ...prev, [unitId]: 'Unable to save file.' }));
    } finally {
      setUnitFileLoading(prev => ({ ...prev, [unitId]: false }));
    }
  }, [isDeploying, isRunningScript, unitFileContents, unitFileSelections]);

  const handleSavePreset = () => {
    if (!presetName.trim()) {
      alert('Preset name is required.');
      return;
    }
    if (selectedIds.length === 0) {
      alert('Select at least one unit for the preset.');
      return;
    }
    const next = presets.filter(preset => preset.name !== presetName.trim());
    next.push({ name: presetName.trim(), ids: [...selectedIds] });
    setPresets(next);
    setPresetName('');
  };

  const handleApplyPreset = (preset: { name: string; ids: string[] }) => {
    const validIds = preset.ids.filter(id => units.some(unit => unit.id === id));
    setSelectedIds(validIds);
  };

  const handleRemovePreset = (name: string) => {
    setPresets(prev => prev.filter(preset => preset.name !== name));
  };

  const handleSaveGroupPreset = () => {
    if (!groupPresetName) {
      alert('Select a group to save.');
      return;
    }
    const ids = units.filter(unit => (unit.group || 'Unassigned') === groupPresetName).map(unit => unit.id);
    if (ids.length === 0) {
      alert('No units found in that group.');
      return;
    }
    const name = `${groupPresetName} Group`;
    const next = presets.filter(preset => preset.name !== name);
    next.push({ name, ids });
    setPresets(next);
    setGroupPresetName('');
  };

  const handleClearSession = () => {
    if (!confirm('Clear current session data (units, selections, logs)?')) return;
    setUnits([]);
    setSelectedIds([]);
    setLogs([]);
    setUnitSteps({});
    setUnitErrors({});
    setVerifiedIds([]);
    localStorage.removeItem('fleetDeployUnits');
    localStorage.removeItem('fleetDeploySelected');
    localStorage.removeItem('fleetDeployLogs');
    localStorage.removeItem('fleetDeployVerified');
  };

  const handleToggleVerified = (unitId: string) => {
    setVerifiedIds(prev => (
      prev.includes(unitId) ? prev.filter(id => id !== unitId) : [...prev, unitId]
    ));
  };

  const handleRunUnitStep = async (actionId: string, unitId: string) => {
    const script = scriptActions.find(scriptAction => scriptAction.id === actionId);
    if (!script) return;
    const args =
      script.unitArgStyle === 'comma'
        ? [script.unitParam, unitId]
        : script.unitArgStyle === 'repeat'
          ? [script.unitParam, unitId]
          : [];
    appendLog(generateMockLog('SYSTEM', `Running ${script.label} for ${unitId}`));
    await runScriptAction(script.path, args, (log) => {
      appendLog(log);
    });
  };

  const handleUpdateIpOverrides = async (unitId: string, overrides?: Unit['ipOverrides']) => {
    setUnits(prev => prev.map(unit => (
      unit.id === unitId ? { ...unit, ipOverrides: overrides } : unit
    )));
    setUnitOverrides(prev => {
      const next = { ...prev };
      if (overrides && Object.keys(overrides).length > 0) {
        next[unitId] = overrides;
      } else {
        delete next[unitId];
      }
      return next;
    });
    if (window.electron) {
      await window.electron.writeUnitOverrides({ unitId, overrides });
    }
  };

  const handleLoadUnitConfigs = async (unitId: string) => {
    if (!window.electron) return;
    setUnitConfigErrors(prev => ({ ...prev, [unitId]: null }));
    setUnitConfigLoading(prev => ({ ...prev, [unitId]: true }));
    try {
      const result = await window.electron.readUnitConfigs(unitId);
      const defaults = unitConfigDefaults[unitId] || {};
      const mergedFiles = (result.files || []).map((file) => {
        const override = defaults[file.relativePath];
        if (!override) return file;
        try {
          const parsed = JSON.parse(file.content);
          const merged = { ...parsed, ...override };
          return {
            ...file,
            content: JSON.stringify(merged, null, 2)
          };
        } catch (error) {
          console.error(error);
          return file;
        }
      });
      setUnitConfigFiles(prev => ({ ...prev, [unitId]: mergedFiles }));
      if ((result.files || []).length === 0) {
        setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'No unit.config files found. Run the Download step first.' }));
      }
    } catch (error) {
      console.error(error);
      setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Failed to load unit.config files.' }));
    } finally {
      setUnitConfigLoading(prev => ({ ...prev, [unitId]: false }));
    }
  };

  const handleUpdateUnitConfigContent = (unitId: string, filePath: string, content: string) => {
    setUnitConfigFiles(prev => ({
      ...prev,
      [unitId]: (prev[unitId] || []).map(file => (
        file.path === filePath ? { ...file, content } : file
      ))
    }));
  };

  const handleSaveUnitConfig = async (unitId: string, filePath: string) => {
    if (!window.electron) return;
    const file = (unitConfigFiles[unitId] || []).find(item => item.path === filePath);
    if (!file) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(file.content);
    } catch (error) {
      setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Invalid JSON in unit.config. Fix before saving.' }));
      return;
    }
    try {
      const writeResult = await window.electron.writeUnitConfig({ path: filePath, content: file.content });
      if (!writeResult?.success) {
        setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Unable to save unit.config. Check logs.' }));
        return;
      }

      // Persist overrides for this specific file so deploy uses the saved edits.
      const overrides = {
        ...(unitConfigDefaults[unitId] || {}),
        [file.relativePath]: parsed
      };
      const overrideResult = await window.electron.writeUnitConfigOverrides({ unitId, overrides });
      if (!overrideResult?.success) {
        setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Saved file, but failed to persist overrides.' }));
        return;
      }
      setUnitConfigDefaults(prev => ({ ...prev, [unitId]: overrides }));
    } catch (error) {
      console.error(error);
      setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Unexpected error while saving unit.config.' }));
    }
  };

  const handleSaveUnitConfigOverrides = async (unitId: string) => {
    if (!window.electron) return;
    const files = unitConfigFiles[unitId] || [];
    if (files.length === 0) {
      setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Load unit.config files before saving defaults.' }));
      return;
    }
    const overrides: Record<string, Record<string, unknown>> = {};
    for (const file of files) {
      try {
        overrides[file.relativePath] = JSON.parse(file.content);
      } catch (error) {
        setUnitConfigErrors(prev => ({ ...prev, [unitId]: `Invalid JSON in ${file.relativePath}.` }));
        return;
      }
    }
    await window.electron.writeUnitConfigOverrides({ unitId, overrides });
    setUnitConfigDefaults(prev => ({ ...prev, [unitId]: overrides }));
  };

  const handleApplyTemplateDefaults = useCallback((unitId: string) => {
    const unit = units.find(candidate => candidate.id === unitId);
    if (!unit) return;
    const group = (unit.group || '').trim() || 'Unassigned';
    const template = templateDefaults[group];
    if (!template) return;

    const files = unitConfigFiles[unitId] || [];
    if (files.length === 0) {
      setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Load unit.config files before applying template defaults.' }));
      return;
    }

    const mergedFiles = files.map((file) => {
      const override = template.configOverrides[file.relativePath];
      if (!override) return file;
      try {
        const parsed = JSON.parse(file.content);
        const merged = { ...parsed, ...override };
        return { ...file, content: JSON.stringify(merged, null, 2) };
      } catch (error) {
        console.error(error);
        return file;
      }
    });

    setUnitConfigFiles(prev => ({ ...prev, [unitId]: mergedFiles }));
    setUnitConfigErrors(prev => ({ ...prev, [unitId]: null }));
  }, [templateDefaults, unitConfigFiles, units]);

  const autoFetchUnitConfigs = useCallback(async (unitId: string) => {
    if (!window.electron || isDeploying || isRunningScript) return;
    setUnitConfigLoading(prev => ({ ...prev, [unitId]: true }));
    setUnitConfigErrors(prev => ({ ...prev, [unitId]: null }));
    try {
      const initial = await window.electron.readUnitConfigs(unitId);
      if ((initial.files || []).length > 0) {
        await handleLoadUnitConfigs(unitId);
        return;
      }
      appendLog(generateMockLog(unitId, 'Fetching unit files for config preview...'));
      await runScriptAction('./scripts/Download-AdoUnit.ps1', ['-UnitNumber', unitId], (log) => {
        appendLog(log);
      });
      await handleLoadUnitConfigs(unitId);
    } catch (error) {
      console.error(error);
      setUnitConfigErrors(prev => ({ ...prev, [unitId]: 'Auto-fetch failed. Run Download manually.' }));
    } finally {
      setUnitConfigLoading(prev => ({ ...prev, [unitId]: false }));
    }
  }, [appendLog, handleLoadUnitConfigs, isDeploying, isRunningScript]);

  const prevSelectedRef = React.useRef<string[]>([]);
  useEffect(() => {
    const prev = prevSelectedRef.current;
    const added = selectedIds.filter(id => !prev.includes(id));
    prevSelectedRef.current = selectedIds;
    if (!window.electron || added.length === 0) return;
    added.forEach((unitId) => {
      autoFetchUnitConfigs(unitId);
      handleLoadUnitFiles(unitId);
    });
  }, [autoFetchUnitConfigs, selectedIds]);

  const handleExportLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deploy_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
  };

  const handleOpenLogs = async () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n');
    if (window.electron) {
      await window.electron.openExportLog({
        content: text,
        filename: `deploy_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
      });
      return;
    }
    handleExportLogs();
  };

  // Stats
  const stats = {
    total: units.length,
    selected: selectedIds.length,
    queued: units.filter(u => u.status === UnitStatus.QUEUED).length,
    running: units.filter(u => u.status === UnitStatus.RUNNING).length,
    success: units.filter(u => u.status === UnitStatus.SUCCESS).length,
    failed: units.filter(u => u.status === UnitStatus.FAILED).length
  };

  useEffect(() => {
    setUnitHistory(prev => {
      let changed = false;
      const next = { ...prev };
      const now = new Date().toISOString();
      for (const unit of units) {
        if (![UnitStatus.SUCCESS, UnitStatus.FAILED, UnitStatus.SKIPPED].includes(unit.status)) {
          continue;
        }
        const current = next[unit.id];
        if (!current || current.lastStatus !== unit.status) {
          next[unit.id] = { lastStatus: unit.status, lastRun: now };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [units]);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const now = new Date().toISOString();
    const updates: Record<string, { updatedAt: string; sourceUnitId: string; configOverrides: Record<string, Record<string, unknown>> }> = {};

    units.forEach((unit) => {
      const previous = prev[unit.id];
      prev[unit.id] = unit.status;
      if (unit.status !== UnitStatus.SUCCESS || previous === UnitStatus.SUCCESS) {
        return;
      }
      const group = (unit.group || '').trim() || 'Unassigned';
      const existingOverrides = unitConfigDefaults[unit.id];
      const overrides =
        existingOverrides && Object.keys(existingOverrides).length > 0
          ? existingOverrides
          : buildConfigOverridesFromFiles(unitConfigFiles[unit.id] || []);

      if (Object.keys(overrides).length === 0) {
        return;
      }
      updates[group] = { updatedAt: now, sourceUnitId: unit.id, configOverrides: overrides };
    });
    prevStatusRef.current = { ...prev };

    if (Object.keys(updates).length === 0) return;
    setTemplateDefaults(prevTemplates => {
      let changed = false;
      const next = { ...prevTemplates };
      Object.entries(updates).forEach(([group, template]) => {
        const existing = prevTemplates[group];
        if (existing && JSON.stringify(existing.configOverrides) === JSON.stringify(template.configOverrides)) {
          return;
        }
        next[group] = template;
        changed = true;
      });
      return changed ? next : prevTemplates;
    });
  }, [buildConfigOverridesFromFiles, unitConfigDefaults, unitConfigFiles, units]);

  useEffect(() => {
    if (!window.Notification || Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const latest = units.find(unit => unit.status === UnitStatus.SUCCESS || unit.status === UnitStatus.FAILED);
    if (!latest || !window.Notification || Notification.permission !== 'granted') return;
    const title = latest.status === UnitStatus.SUCCESS ? 'Unit Deployed' : 'Deployment Failed';
    const body = `${latest.id} - ${latest.status}`;
    new Notification(title, { body });
  }, [units]);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-transparent text-slate-100">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-10 h-72 w-72 rounded-full bg-blue-600/20 blur-3xl" />
        <div className="absolute top-10 right-20 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-56 w-80 rounded-full bg-indigo-500/10 blur-[120px]" />
      </div>
      {/* Top Navigation / Title Bar */}
      <header className="titlebar border-b border-slate-800/80 bg-slate-950/70 backdrop-blur h-14 flex items-center px-6 justify-between shrink-0 select-none">
        <div className="flex items-center space-x-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-600 to-cyan-400 flex items-center justify-center font-bold text-white text-sm shadow-lg shadow-blue-900/40">
            F
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-slate-100">Fleet Deploy Ops</h1>
            <p className="text-[11px] text-slate-400">Capture. Verify. Deploy. Repeat.</p>
          </div>

          {/* Environment Badge */}
          {isDesktop ? (
            <span className="no-drag flex items-center px-2.5 py-1 rounded-full bg-blue-900/30 border border-blue-800 text-blue-300 text-[10px] font-semibold tracking-wider">
              <Monitor className="w-3 h-3 mr-1" />
              LIVE MODE
            </span>
          ) : (
            <span className="no-drag flex items-center px-2.5 py-1 rounded-full bg-amber-900/30 border border-amber-800 text-amber-300 text-[10px] font-semibold tracking-wider">
              <Laptop className="w-3 h-3 mr-1" />
              SIMULATION
            </span>
          )}
        </div>

        <div className="flex items-center space-x-3 text-xs text-slate-300 no-drag">
          <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1">
            <span className="text-slate-400">Total</span>
            <span className="font-semibold text-slate-100">{stats.total}</span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1">
            <span className="text-slate-400">Selected</span>
            <span className="font-semibold text-blue-300">{stats.selected}</span>
          </div>
          <div className="hidden xl:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1">
            <span className="text-slate-400">Queued</span>
            <span className="font-semibold text-amber-300">{stats.queued}</span>
          </div>
          <div className="hidden xl:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1">
            <span className="text-slate-400">Running</span>
            <span className="font-semibold text-cyan-300">{stats.running}</span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1">
            <span className="text-slate-400">Success</span>
            <span className="font-semibold text-green-400">{stats.success}</span>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1">
            <span className="text-slate-400">Failed</span>
            <span className="font-semibold text-red-400">{stats.failed}</span>
          </div>
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="ml-2 flex items-center space-x-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1 text-slate-200 hover:text-white hover:border-slate-700"
            title="Settings"
          >
            <Settings className="w-4 h-4" />
            <span>Settings</span>
          </button>
        </div>
      </header>

      {/* Main Content Grid */}
      <main className="relative z-10 flex-1 overflow-hidden p-6 grid grid-cols-12 gap-6">

        {/* LEFT COLUMN: Intake & Actions (4 cols) */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-6 overflow-y-auto scrollbar-thin pr-1">

          {/* Drop Zone */}
          <div className="app-panel rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-100 flex items-center">
                <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold">1</span>
                Capture Input
              </h3>
              <span className="text-[11px] text-slate-500">Screenshot/OCR</span>
            </div>
            <DropZone onImageLoaded={handleImageLoaded} isProcessing={isProcessing} />
          </div>

          {/* Configuration */}
          <div className="app-panel rounded-2xl p-5 flex-1">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-100 flex items-center">
                <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold">2</span>
                Configure Run
              </h3>
              <Settings className="w-4 h-4 text-slate-500" />
            </div>

            <div className="space-y-4">
              <div className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Ready to Deploy</p>
                    <p className="text-sm text-slate-300">{selectedIds.length} selected</p>
                  </div>
                  <div className="flex space-x-2">
                    <button
                      onClick={handleDeploy}
                      disabled={isDeploying || selectedIds.length === 0}
                      className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold py-2 px-4 rounded-lg flex items-center justify-center space-x-2 transition-all shadow-lg shadow-blue-900/20"
                    >
                      <Play className="w-4 h-4" />
                      <span>{isDeploying ? 'Deploying...' : 'Deploy'}</span>
                    </button>

                    {isDeploying && (
                      <button
                        onClick={handleCancel}
                        className="bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/50 font-semibold py-2 px-3 rounded-lg flex items-center justify-center"
                        title="Stop Execution"
                      >
                        <Octagon className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Environment Health</p>
                    {missingEnvKeys.length > 0 ? (
                      <p className="text-xs text-amber-300">Missing: {missingEnvKeys.join(', ')}</p>
                    ) : (
                      <p className="text-xs text-green-400">All required keys set.</p>
                    )}
                  </div>
                  <span className="text-[11px] text-slate-500">{isDesktop ? 'Desktop' : 'Browser'}</span>
                </div>
                {isDesktop && (
                  <p className="text-[11px] text-slate-500 mt-2">
                    PAT: {hasPat ? 'Configured' : 'Missing'}
                  </p>
                )}
              </div>

              <div className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Pipeline Status</p>
                    <p className="text-[11px] text-slate-500">Active steps by unit</p>
                  </div>
                </div>
                {selectedIds.length === 0 ? (
                  <p className="text-xs text-slate-500">Select units to see pipeline steps.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedIds.map((id) => (
                      <div key={`step-${id}`} className="flex items-center justify-between text-xs">
                        <span className="text-slate-300">{id}</span>
                        <span className="text-slate-400">{unitSteps[id] || 'Pending'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-slate-800/70 bg-slate-950/70 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-slate-500">Presets</p>
                    <p className="text-[11px] text-slate-500">Save reusable selections</p>
                  </div>
                </div>
                <div className="flex items-center space-x-2 mb-3">
                  <input
                    type="text"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="Preset name"
                    className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                  />
                  <button
                    onClick={handleSavePreset}
                    className="px-3 py-1.5 text-xs font-semibold text-blue-200 bg-blue-500/20 hover:bg-blue-500/30 rounded"
                  >
                    Save
                  </button>
                </div>
                <div className="flex items-center space-x-2 mb-3">
                  <select
                    value={groupPresetName}
                    onChange={(e) => setGroupPresetName(e.target.value)}
                    className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                  >
                    <option value="">Save group preset...</option>
                    {groupOptions.map(group => (
                      <option key={`preset-${group}`} value={group}>{group}</option>
                    ))}
                  </select>
                  <button
                    onClick={handleSaveGroupPreset}
                    className="px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded"
                  >
                    Save Group
                  </button>
                </div>
                {presets.length === 0 ? (
                  <p className="text-xs text-slate-500">No presets yet.</p>
                ) : (
                  <div className="space-y-2">
                    {presets.map((preset) => (
                      <div key={preset.name} className="flex items-center justify-between text-xs">
                        <button
                          onClick={() => handleApplyPreset(preset)}
                          className="text-blue-300 hover:text-blue-200"
                        >
                          {preset.name}
                        </button>
                        <button
                          onClick={() => handleRemovePreset(preset.name)}
                          className="text-red-300 hover:text-red-200"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="pt-3 border-t border-slate-800/70 mt-3">
                  <button
                    onClick={handleClearSession}
                    className="text-xs text-red-300 hover:text-red-200"
                  >
                    Clear Session
                  </button>
                </div>
              </div>


            </div>
          </div>
        </div>

        {/* CENTER COLUMN: Unit List (4 cols) */}
        <div className="col-span-12 lg:col-span-4 h-full overflow-hidden">
          <UnitList 
            units={units}
            selectedIds={selectedIds}
            onAddUnit={handleAddUnit}
            onRemoveUnits={handleRemoveUnits}
            onSelectionChange={handleSelectionChange}
            onRetry={handleRetry}
            onUpdateGroup={handleUpdateGroup}
            isDeploying={isDeploying}
            unitSteps={unitSteps}
            unitErrors={unitErrors}
            unitHistory={unitHistory}
            reviewMode={reviewMode}
            onToggleReviewMode={() => setReviewMode(prev => !prev)}
            verifiedIds={verifiedIds}
            onToggleVerified={handleToggleVerified}
            onRunUnitStep={handleRunUnitStep}
            defaultIps={defaultIps}
            onUpdateIpOverrides={handleUpdateIpOverrides}
          unitConfigFiles={unitConfigFiles}
          unitConfigErrors={unitConfigErrors}
          unitConfigLoading={unitConfigLoading}
          templateDefaults={templateDefaults}
          onApplyTemplateDefaults={handleApplyTemplateDefaults}
          onLoadUnitConfigs={handleLoadUnitConfigs}
            onUpdateUnitConfigContent={handleUpdateUnitConfigContent}
            onSaveUnitConfig={handleSaveUnitConfig}
            onSaveUnitConfigOverrides={handleSaveUnitConfigOverrides}
            unitFileLists={unitFileLists}
            unitFileSelections={unitFileSelections}
            unitFileContents={unitFileContents}
            unitFileErrors={unitFileErrors}
            unitFileLoading={unitFileLoading}
            onLoadUnitFiles={handleLoadUnitFiles}
            onOpenUnitFile={handleOpenUnitFile}
            onUpdateUnitFileContent={handleUpdateUnitFileContent}
            onSaveUnitFile={handleSaveUnitFile}
          />
        </div>

        {/* RIGHT COLUMN: Logs (4 cols) */}
        <div className="col-span-12 lg:col-span-4 h-full overflow-hidden">
          <DeploymentConsole logs={logs} onExportLogs={handleExportLogs} onOpenLogs={handleOpenLogs} />
        </div>

      </main>

      {isSettingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="app-panel w-full max-w-2xl rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">Settings</h2>
                <p className="text-xs text-slate-500">Manage environment variables used by scripts.</p>
              </div>
              <button
                onClick={() => setIsSettingsOpen(false)}
                className="text-slate-400 hover:text-slate-100"
              >
                Close
              </button>
            </div>
            <div className="flex items-center space-x-2 mb-4">
              <button
                onClick={() => setSettingsTab('env')}
                className={`px-3 py-1.5 text-xs font-semibold rounded border ${
                  settingsTab === 'env'
                    ? 'text-blue-200 bg-blue-500/20 border-blue-500/40'
                    : 'text-slate-300 bg-slate-800 border-slate-700'
                }`}
              >
                Environment
              </button>
              <button
                onClick={() => setSettingsTab('ai')}
                className={`px-3 py-1.5 text-xs font-semibold rounded border ${
                  settingsTab === 'ai'
                    ? 'text-blue-200 bg-blue-500/20 border-blue-500/40'
                    : 'text-slate-300 bg-slate-800 border-slate-700'
                }`}
              >
                AI Model
              </button>
            </div>
            {settingsTab === 'env' && (
            <div className="rounded-xl border border-slate-800/70 bg-slate-900/60 p-4">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Environment</h4>
              {envError && (
                <p className="text-xs text-red-400 mb-2">{envError}</p>
              )}
              {isEnvLoading ? (
                <p className="text-xs text-slate-500">Loading environment settings...</p>
              ) : (
                <div className="space-y-2">
                  {envEntries.length === 0 && (
                    <p className="text-xs text-slate-500">No configurable entries yet.</p>
                  )}
                  {envEntries.map((entry, index) => (
                    <div key={`${entry.key}-${index}`} className="flex items-center space-x-2">
                      <input
                        type="text"
                        placeholder="KEY"
                        value={entry.key}
                        onChange={(e) => handleUpdateEnvEntry(index, 'key', e.target.value)}
                        className="w-2/5 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                        disabled={isEnvSaving}
                      />
                      <input
                        type="text"
                        placeholder="Value"
                        value={entry.value}
                        onChange={(e) => handleUpdateEnvEntry(index, 'value', e.target.value)}
                        className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                        disabled={isEnvSaving}
                      />
                      <button
                        onClick={() => handleRemoveEnvEntry(index)}
                        className="text-xs text-red-300 hover:text-red-200"
                        disabled={isEnvSaving}
                        title="Remove"
                      >
                        x
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center space-x-2 pt-1">
                    <button
                      onClick={handleAddEnvEntry}
                      disabled={isEnvSaving}
                      className="px-3 py-1.5 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded"
                    >
                      Add Entry
                    </button>
                    <button
                      onClick={handleSaveEnv}
                      disabled={isEnvSaving || !window.electron}
                      className="px-3 py-1.5 text-xs font-semibold text-blue-200 bg-blue-500/20 hover:bg-blue-500/30 rounded"
                    >
                      {isEnvSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-500">PAT is managed outside the UI.</p>
                </div>
              )}
            </div>
            )}
            {settingsTab === 'ai' && (
              <div className="rounded-xl border border-slate-800/70 bg-slate-900/60 p-4">
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">AI Model</h4>
                {!isDesktop && (
                  <p className="text-xs text-amber-300 mb-3">
                    Browser mode uses build-time environment variables. Desktop mode reads `.env.local`.
                  </p>
                )}
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] text-slate-500 uppercase tracking-wide">Provider</label>
                    <select
                      value={aiProvider}
                      onChange={(e) => upsertEnvEntry('AI_PROVIDER', e.target.value)}
                      className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                      disabled={isEnvSaving || !window.electron}
                    >
                      <option value="gemini">Gemini</option>
                      <option value="openai">OpenAI</option>
                    </select>
                  </div>
                  {aiProvider === 'gemini' && (
                    <div>
                      <label className="text-[11px] text-slate-500 uppercase tracking-wide">Gemini Model</label>
                      <select
                        value={aiModelSuggestions.includes(aiModel) ? aiModel : ''}
                        onChange={(e) => upsertEnvEntry('GEMINI_MODEL', e.target.value)}
                        className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                        disabled={isEnvSaving || !window.electron}
                      >
                        <option value="" disabled>
                          Select a model...
                        </option>
                        {aiModelSuggestions.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={aiModel}
                        onChange={(e) => upsertEnvEntry('GEMINI_MODEL', e.target.value)}
                        className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                        disabled={isEnvSaving || !window.electron}
                        placeholder="Or type a custom model id"
                      />
                      <p className="text-[11px] text-slate-500 mt-2">
                        Default: gemini-3-flash-preview. You can type any supported model ID.
                      </p>
                    </div>
                  )}
                  {aiProvider === 'openai' && (
                    <>
                      <div>
                        <label className="text-[11px] text-slate-500 uppercase tracking-wide">OpenAI API Key</label>
                        <input
                          type="password"
                          value={openAiApiKey}
                          onChange={(e) => upsertEnvEntry('OPENAI_API_KEY', e.target.value)}
                          className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          disabled={isEnvSaving || !window.electron}
                          placeholder="sk-..."
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500 uppercase tracking-wide">OpenAI Base URL</label>
                        <input
                          type="text"
                          value={openAiBaseUrl}
                          onChange={(e) => upsertEnvEntry('OPENAI_BASE_URL', e.target.value)}
                          className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          disabled={isEnvSaving || !window.electron}
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-slate-500 uppercase tracking-wide">OpenAI Model</label>
                        <select
                          value={openAiModelSuggestions.includes(openAiModel) ? openAiModel : ''}
                          onChange={(e) => upsertEnvEntry('OPENAI_MODEL', e.target.value)}
                          className="mt-1 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          disabled={isEnvSaving || !window.electron}
                        >
                          <option value="" disabled>
                            Select a model...
                          </option>
                          {openAiModelSuggestions.map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={openAiModel}
                          onChange={(e) => upsertEnvEntry('OPENAI_MODEL', e.target.value)}
                          className="mt-2 w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          disabled={isEnvSaving || !window.electron}
                          placeholder="Or type a custom model id"
                        />
                        <p className="text-[11px] text-slate-500 mt-2">
                          Default: gpt-4o-mini. You can type any supported model ID.
                        </p>
                      </div>
                    </>
                  )}
                  <div className="flex items-center space-x-2 pt-1">
                    <button
                      onClick={handleSaveEnv}
                      disabled={isEnvSaving || !window.electron}
                      className="px-3 py-1.5 text-xs font-semibold text-blue-200 bg-blue-500/20 hover:bg-blue-500/30 rounded"
                    >
                      {isEnvSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
