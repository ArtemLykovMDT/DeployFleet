import React, { useState } from 'react';
import { Unit, UnitStatus, UnitSource } from '../types';
import { Trash2, Plus, CheckCircle2, AlertCircle, Clock, CheckSquare, Square, RotateCw } from 'lucide-react';

interface UnitListProps {
  units: Unit[];
  onAddUnit: (unitId: string, group?: string) => void;
  onRemoveUnits: (ids: string[]) => void;
  onSelectionChange: (ids: string[]) => void;
  onRetry: (id: string) => void;
  onUpdateGroup: (ids: string[], group: string) => void;
  selectedIds: string[];
  isDeploying: boolean;
  unitSteps: Record<string, string>;
  unitErrors: Record<string, string>;
  unitHistory: Record<string, { lastStatus: UnitStatus; lastRun: string }>;
  reviewMode: boolean;
  onToggleReviewMode: () => void;
  verifiedIds: string[];
  onToggleVerified: (id: string) => void;
  onRunUnitStep: (actionId: string, unitId: string) => void;
  defaultIps: {
    dataVanHmiIp?: string;
    localHmiIp?: string;
    mpcSecondaryIp?: string;
  };
  onUpdateIpOverrides: (unitId: string, overrides: Unit['ipOverrides']) => void;
  unitConfigFiles: Record<string, Array<{ path: string; relativePath: string; content: string }>>;
  unitConfigErrors: Record<string, string | null>;
  unitConfigLoading: Record<string, boolean>;
  templateDefaults: Record<string, { updatedAt: string; sourceUnitId: string; configOverrides: Record<string, Record<string, unknown>> }>;
  onApplyTemplateDefaults: (unitId: string) => void;
  onLoadUnitConfigs: (unitId: string) => void;
  onUpdateUnitConfigContent: (unitId: string, filePath: string, content: string) => void;
  onSaveUnitConfig: (unitId: string, filePath: string) => void;
  onSaveUnitConfigOverrides: (unitId: string) => void;
  unitFileLists: Record<string, Array<{ path: string; relativePath: string }>>;
  unitFileSelections: Record<string, string>;
  unitFileContents: Record<string, string>;
  unitFileErrors: Record<string, string | null>;
  unitFileLoading: Record<string, boolean>;
  onLoadUnitFiles: (unitId: string) => void;
  onOpenUnitFile: (unitId: string, filePath?: string) => void;
  onUpdateUnitFileContent: (unitId: string, content: string) => void;
  onSaveUnitFile: (unitId: string) => void;
}

const UnitList: React.FC<UnitListProps> = ({
  units,
  onAddUnit,
  onRemoveUnits,
  onSelectionChange,
  onRetry,
  onUpdateGroup,
  selectedIds,
  isDeploying,
  unitSteps,
  unitErrors,
  unitHistory,
  reviewMode,
  onToggleReviewMode,
  verifiedIds,
  onToggleVerified,
  onRunUnitStep,
  defaultIps,
  onUpdateIpOverrides,
  unitConfigFiles,
  unitConfigErrors,
  unitConfigLoading,
  templateDefaults,
  onApplyTemplateDefaults,
  onLoadUnitConfigs,
  onUpdateUnitConfigContent,
  onSaveUnitConfig,
  onSaveUnitConfigOverrides,
  unitFileLists,
  unitFileSelections,
  unitFileContents,
  unitFileErrors,
  unitFileLoading,
  onLoadUnitFiles,
  onOpenUnitFile,
  onUpdateUnitFileContent,
  onSaveUnitFile
}) => {
  const [manualInput, setManualInput] = useState('');
  const [manualGroup, setManualGroup] = useState('Unassigned');
  const [bulkGroup, setBulkGroup] = useState('');
  const [searchText, setSearchText] = useState('');
  const [statusFilter, setStatusFilter] = useState<UnitStatus | 'ALL'>('ALL');
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState<Record<string, boolean>>({});

  const groupOptions = [
    'Datavan',
    'C6',
    'Hydration',
    'Blender 1',
    'Blender 2',
    'Pumps',
    'Sand 1',
    'Sand 2',
    'Unassigned'
  ];

  const handleManualAdd = () => {
    // Validate input based on regex: 62\d{4}
    // Allow comma separated
    const inputs = manualInput.split(/[\s,]+/);
    let added = 0;
    
    inputs.forEach(input => {
      const clean = input.trim();
      if (clean.match(/^62\d{4}$/)) {
        onAddUnit(clean, manualGroup === 'Unassigned' ? undefined : manualGroup);
        added++;
      }
    });

    if (added > 0) {
      setManualInput('');
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === units.length) {
      onSelectionChange([]);
    } else {
      onSelectionChange(units.map(u => u.id));
    }
  };

  const toggleSelectOne = (id: string) => {
    if (selectedIds.includes(id)) {
      onSelectionChange(selectedIds.filter(sid => sid !== id));
    } else {
      onSelectionChange([...selectedIds, id]);
    }
  };

  const handleBulkGroupApply = () => {
    if (!bulkGroup || selectedIds.length === 0) return;
    onUpdateGroup(selectedIds, bulkGroup === 'Unassigned' ? '' : bulkGroup);
    setBulkGroup('');
  };

  const getStatusIcon = (status: UnitStatus) => {
    switch (status) {
      case UnitStatus.SUCCESS: return <CheckCircle2 className="w-5 h-5 text-green-500" />;
      case UnitStatus.FAILED: return <AlertCircle className="w-5 h-5 text-red-500" />;
      case UnitStatus.RUNNING: return <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />;
      case UnitStatus.PENDING: return <Clock className="w-5 h-5 text-slate-500" />;
      case UnitStatus.QUEUED: return <Clock className="w-5 h-5 text-yellow-500" />;
      default: return null;
    }
  };

  // Helper for Loader2 import
  const Loader2 = ({ className }: { className?: string }) => (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width="24" height="24" viewBox="0 0 24 24" 
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" 
      className={className}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );

  const normalizedGroups = groupOptions.map(option => option.toLowerCase());
  const reviewCandidates = units.filter(unit => unit.source === UnitSource.OCR && !verifiedIds.includes(unit.id) && (
    (unit.confidence || 0) < 90 || !unit.group
  ));

  const visibleUnits = (reviewMode ? reviewCandidates : units)
    .filter(unit => {
      if (statusFilter !== 'ALL' && unit.status !== statusFilter) return false;
      if (!searchText.trim()) return true;
      const query = searchText.toLowerCase();
      return (
        unit.id.toLowerCase().includes(query) ||
        unit.registrationName.toLowerCase().includes(query) ||
        (unit.group || '').toLowerCase().includes(query)
      );
    });

  const groupedUnits = visibleUnits.reduce((acc, unit) => {
    const groupName = (unit.group || '').trim() || 'Unassigned';
    if (!acc[groupName]) acc[groupName] = [];
    acc[groupName].push(unit);
    return acc;
  }, {} as Record<string, Unit[]>);

  const buildEffectiveIps = (unit: Unit) => ({
    dataVanHmiIp: unit.ipOverrides?.dataVanHmiIp?.trim() || defaultIps.dataVanHmiIp || '',
    localHmiIp: unit.ipOverrides?.localHmiIp?.trim() || defaultIps.localHmiIp || '',
    mpcSecondaryIp: unit.ipOverrides?.mpcSecondaryIp?.trim() || defaultIps.mpcSecondaryIp || ''
  });

  const updateOverrideValue = (unit: Unit, field: keyof NonNullable<Unit['ipOverrides']>, value: string) => {
    const nextOverrides = { ...(unit.ipOverrides || {}) };
    const trimmed = value.trim();
    const defaultValue =
      field === 'dataVanHmiIp'
        ? (defaultIps.dataVanHmiIp || '')
        : field === 'localHmiIp'
          ? (defaultIps.localHmiIp || '')
          : (defaultIps.mpcSecondaryIp || '');
    if (trimmed) {
      if (defaultValue && trimmed === defaultValue) {
        delete nextOverrides[field];
      } else {
        nextOverrides[field] = trimmed;
      }
    } else {
      delete nextOverrides[field];
    }
    onUpdateIpOverrides(unit.id, Object.keys(nextOverrides).length ? nextOverrides : undefined);
  };

  const orderedGroupNames = [
    ...groupOptions,
    ...Object.keys(groupedUnits).filter(group => !normalizedGroups.includes(group.toLowerCase())).sort()
  ];

  const getConfigLabel = (relativePath: string) => {
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/eng/')) return 'Eng';
    if (normalized.includes('/adds/')) return 'Adds';
    return 'Unit';
  };

  const getTemplateDiffSummary = (unitId: string, template: UnitListProps['templateDefaults'][string]) => {
    if (!template) return [];
    const files = unitConfigFiles[unitId] || [];
    const summaries: Array<{ path: string; changed: number; keys: string[] }> = [];

    files.forEach((file) => {
      const override = template.configOverrides[file.relativePath];
      if (!override) return;
      try {
        const parsed = JSON.parse(file.content) as Record<string, unknown>;
        const keys = Object.keys(override);
        const changedKeys = keys.filter((key) => {
          const left = parsed ? parsed[key] : undefined;
          const right = (override as Record<string, unknown>)[key];
          return JSON.stringify(left) !== JSON.stringify(right);
        });
        summaries.push({ path: file.relativePath, changed: changedKeys.length, keys: changedKeys });
      } catch (error) {
        console.error(error);
      }
    });

    return summaries;
  };

  return (
    <div className="app-panel flex flex-col h-full rounded-2xl">
      
      {/* Header / Toolbar */}
      <div className="p-4 border-b border-slate-700 flex flex-col gap-3 bg-slate-800/80">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="panel-title">Extracted Units</p>
            <h2 className="font-semibold text-lg text-slate-100">{units.length} total</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
           <button
             onClick={onToggleReviewMode}
             className={`flex items-center px-3 py-1.5 text-xs font-medium rounded border ${
               reviewMode
                 ? 'text-blue-200 bg-blue-500/20 border-blue-500/40'
                 : 'text-slate-300 bg-slate-700/40 border-slate-600/60'
             }`}
           >
             Review {reviewCandidates.length > 0 ? `(${reviewCandidates.length})` : ''}
           </button>
           <button 
             onClick={() => onRemoveUnits(selectedIds)}
             disabled={isDeploying || selectedIds.length === 0}
             className="flex items-center px-3 py-1.5 text-xs font-medium text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded disabled:opacity-50 border border-transparent hover:border-red-400/30"
           >
             <Trash2 className="w-3 h-3 mr-1.5" />
             Remove Selected
           </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex-1 min-w-[180px]">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Search by unit, group, or tag..."
              className="w-full bg-slate-900/70 border border-slate-600/70 rounded px-3 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
              disabled={isDeploying}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as UnitStatus | 'ALL')}
            disabled={isDeploying}
            className="bg-slate-900/70 border border-slate-600/70 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
          >
            <option value="ALL">All Statuses</option>
            <option value={UnitStatus.PENDING}>Pending</option>
            <option value={UnitStatus.QUEUED}>Queued</option>
            <option value={UnitStatus.RUNNING}>Running</option>
            <option value={UnitStatus.SUCCESS}>Success</option>
            <option value={UnitStatus.FAILED}>Failed</option>
          </select>
        </div>
      </div>

      {/* Manual Add Bar */}
      <div className="p-3 bg-slate-950/60 border-b border-slate-800/80 flex space-x-2">
        <input 
          type="text" 
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
          placeholder="Manual add (e.g. 621696)"
          className="flex-1 bg-slate-800 border border-slate-600 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500"
          onKeyDown={(e) => e.key === 'Enter' && handleManualAdd()}
          disabled={isDeploying}
        />
        <select
          value={manualGroup}
          onChange={(e) => setManualGroup(e.target.value)}
          disabled={isDeploying}
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
        >
          {groupOptions.map(option => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <button 
          onClick={handleManualAdd}
          disabled={isDeploying || !manualInput}
          className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {/* Table Header */}
      <div className="grid grid-cols-12 gap-2 px-4 py-2 text-xs font-semibold text-slate-400 border-b border-slate-700 bg-slate-800/70 sticky top-0 z-10">
        <div className="col-span-1 flex items-center justify-center">
          <button onClick={toggleSelectAll} disabled={isDeploying}>
            {selectedIds.length > 0 && selectedIds.length === units.length ? (
              <CheckSquare className="w-4 h-4 text-blue-500" />
            ) : (
              <Square className="w-4 h-4" />
            )}
          </button>
        </div>
        <div className="col-span-3">Unit ID</div>
        <div className="col-span-2">Group</div>
        <div className="col-span-2">Source</div>
        <div className="col-span-1">Conf.</div>
        <div className="col-span-3">Status</div>
      </div>

      {/* List Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {visibleUnits.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-slate-500 text-sm">
            {reviewMode ? (
              <p>No units need review.</p>
            ) : (
              <>
                <p>No units extracted.</p>
                <p className="text-xs">Drag a screenshot or add manually.</p>
              </>
            )}
          </div>
        ) : (
          orderedGroupNames.map((groupName) => {
            const groupUnits = groupedUnits[groupName];
            if (!groupUnits || groupUnits.length === 0) return null;

            return (
              <div key={groupName}>
                <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 bg-slate-900/60 border-b border-slate-700/70 flex items-center justify-between">
                  <span>{groupName} ({groupUnits.length})</span>
                  <button
                    onClick={() => onSelectionChange(groupUnits.map(unit => unit.id))}
                    disabled={isDeploying}
                    className="text-[11px] text-blue-400 hover:text-blue-300"
                  >
                    Select group
                  </button>
                </div>
                {groupUnits.map((unit) => {
                  const isSelected = selectedIds.includes(unit.id);
                  const effectiveIps = buildEffectiveIps(unit);
                  const usingOverrides = Boolean(unit.ipOverrides && Object.keys(unit.ipOverrides).length > 0);
                  const groupKey = (unit.group || '').trim() || 'Unassigned';
                  const template = templateDefaults[groupKey];
                  const templateLabel = template ? new Date(template.updatedAt).toLocaleString() : '';

                  return (
                  <div 
                    key={unit.id}
                    className={`border-b border-slate-700/50 ${isSelected ? 'bg-blue-900/10' : ''}`}
                  >
                  <div 
                    className="grid grid-cols-12 gap-2 px-4 py-3 text-sm items-center hover:bg-slate-700/30"
                  >
                    <div className="col-span-1 flex items-center justify-center">
                      <button 
                        onClick={() => toggleSelectOne(unit.id)}
                        disabled={isDeploying}
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-blue-500" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-500" />
                        )}
                      </button>
                    </div>
              <div className="col-span-3 font-mono font-medium text-slate-200">
                {unit.registrationName}
              </div>
                    <div className="col-span-2 text-xs">
                      <select
                        value={(unit.group || '').trim() || 'Unassigned'}
                        onChange={(e) => onUpdateGroup([unit.id], e.target.value === 'Unassigned' ? '' : e.target.value)}
                        disabled={isDeploying}
                        className="w-full bg-slate-900/70 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                      >
                        {groupOptions.map(option => (
                          <option key={`${unit.id}-${option}`} value={option}>{option}</option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2 text-xs text-slate-400 uppercase tracking-wider">{unit.source}</div>
                    <div className="col-span-1 text-xs">
                      {unit.source === UnitSource.OCR ? (
                        <span className={`${(unit.confidence || 0) > 80 ? 'text-green-400' : 'text-yellow-400'}`}>
                          {unit.confidence}%
                        </span>
                      ) : (
                        <span className="text-slate-600">-</span>
                      )}
                    </div>
                    <div className="col-span-3 flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        {getStatusIcon(unit.status)}
                        <span className={`text-xs font-medium ${
                          unit.status === UnitStatus.SUCCESS ? 'text-green-400' :
                          unit.status === UnitStatus.FAILED ? 'text-red-400' :
                          unit.status === UnitStatus.RUNNING ? 'text-blue-400' :
                          'text-slate-500'
                        }`}>
                          {unit.status}
                        </span>
                        {unitSteps[unit.id] && unit.status !== UnitStatus.SUCCESS && unit.status !== UnitStatus.FAILED && (
                          <span className="text-[11px] text-slate-500">{unitSteps[unit.id]}</span>
                        )}
                      </div>
                      <div className="flex items-center space-x-2">
                        {unitErrors[unit.id] && (
                          <span className="text-[11px] text-red-300" title={unitErrors[unit.id]}>Error</span>
                        )}
                        {unitHistory[unit.id] && (
                          <span className="text-[11px] text-slate-500" title={`Last run: ${unitHistory[unit.id].lastRun}`}>
                            {unitHistory[unit.id].lastStatus}
                          </span>
                        )}
                        {reviewMode && (
                          <button
                            onClick={() => onToggleVerified(unit.id)}
                            className="text-[11px] text-blue-300 hover:text-blue-200"
                          >
                            Verify
                          </button>
                        )}
                      </div>
                      {unit.status === UnitStatus.FAILED && !isDeploying && (
                        <div className="flex items-center space-x-2">
                          <button 
                            onClick={() => onRetry(unit.id)}
                            className="text-slate-400 hover:text-white bg-slate-700 hover:bg-slate-600 p-1 rounded transition-colors"
                            title="Retry this unit"
                          >
                            <RotateCw className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => onRunUnitStep('download', unit.id)}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Download
                          </button>
                          <button
                            onClick={() => onRunUnitStep('update-config', unit.id)}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Update
                          </button>
                          <button
                            onClick={() => onRunUnitStep('deploy', unit.id)}
                            className="text-[11px] text-slate-400 hover:text-slate-200"
                          >
                            Deploy
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  {isSelected && (
                    <div className="px-4 pb-3 text-xs text-slate-300">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div>
                          <span className="uppercase tracking-wide text-[11px] text-slate-500">Unit Config IPs</span>
                          <p className="text-[11px] text-slate-500">
                            {usingOverrides ? 'Overrides active for this unit.' : 'Using environment defaults.'}
                          </p>
                        </div>
                        {usingOverrides && (
                          <button
                            onClick={() => onUpdateIpOverrides(unit.id, undefined)}
                            className="text-[11px] text-blue-300 hover:text-blue-200"
                          >
                            Use defaults
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-[11px] text-slate-500">DataVanHMIIp</label>
                          <input
                            type="text"
                            value={unit.ipOverrides?.dataVanHmiIp ?? defaultIps.dataVanHmiIp ?? ''}
                            placeholder={defaultIps.dataVanHmiIp || 'unset'}
                            onChange={(e) => updateOverrideValue(unit, 'dataVanHmiIp', e.target.value)}
                            disabled={isDeploying}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-500">LocalHMIIp</label>
                          <input
                            type="text"
                            value={unit.ipOverrides?.localHmiIp ?? defaultIps.localHmiIp ?? ''}
                            placeholder={defaultIps.localHmiIp || 'unset'}
                            onChange={(e) => updateOverrideValue(unit, 'localHmiIp', e.target.value)}
                            disabled={isDeploying}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] text-slate-500">MPCSecondaryIp</label>
                          <input
                            type="text"
                            value={unit.ipOverrides?.mpcSecondaryIp ?? defaultIps.mpcSecondaryIp ?? ''}
                            placeholder={defaultIps.mpcSecondaryIp || 'optional'}
                            onChange={(e) => updateOverrideValue(unit, 'mpcSecondaryIp', e.target.value)}
                            disabled={isDeploying}
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                          />
                        </div>
                      </div>
                      <div className="mt-2 text-[11px] text-slate-500">
                        Will overwrite to: DataVan {effectiveIps.dataVanHmiIp || 'unset'}, Local {effectiveIps.localHmiIp || 'unset'}
                        {effectiveIps.mpcSecondaryIp ? `, Secondary ${effectiveIps.mpcSecondaryIp}` : ''}
                      </div>
                      <div className="mt-4 border-t border-slate-800/70 pt-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="uppercase tracking-wide text-[11px] text-slate-500">Unit Config Files</span>
                            <p className="text-[11px] text-slate-500">Load and edit unit.config entries before deployment.</p>
                            {template && (
                              <p className="text-[11px] text-slate-500">
                                Template from {template.sourceUnitId} · {templateLabel}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            {template && (
                              <button
                                onClick={() => setTemplatePreviewOpen(prev => ({ ...prev, [unit.id]: !prev[unit.id] }))}
                                className="text-[11px] text-slate-300 hover:text-slate-100"
                                disabled={isDeploying}
                              >
                                {templatePreviewOpen[unit.id] ? 'Hide diff' : 'Preview diff'}
                              </button>
                            )}
                            {template && (
                              <button
                                onClick={() => onApplyTemplateDefaults(unit.id)}
                                className="text-[11px] text-emerald-300 hover:text-emerald-200"
                                disabled={isDeploying || (unitConfigFiles[unit.id] || []).length === 0}
                              >
                                Apply template
                              </button>
                            )}
                            <button
                              onClick={() => onLoadUnitConfigs(unit.id)}
                              className="text-[11px] text-blue-300 hover:text-blue-200"
                              disabled={isDeploying}
                            >
                              Load configs
                            </button>
                            <button
                              onClick={() => onSaveUnitConfigOverrides(unit.id)}
                              className="text-[11px] text-amber-300 hover:text-amber-200"
                              disabled={isDeploying}
                            >
                              Save defaults
                            </button>
                          </div>
                        </div>
                        {unitConfigErrors[unit.id] && (
                          <p className="text-[11px] text-red-300 mt-2">{unitConfigErrors[unit.id]}</p>
                        )}
                        {unitConfigLoading[unit.id] ? (
                          <p className="text-[11px] text-slate-500 mt-2">Loading unit.config files...</p>
                        ) : (unitConfigFiles[unit.id] || []).length === 0 ? (
                          <p className="text-[11px] text-slate-500 mt-2">No unit.config files loaded yet.</p>
                        ) : (
                          <div
                            className={`mt-3 grid grid-cols-1 gap-3 ${(unitConfigFiles[unit.id] || []).length > 1 ? 'lg:grid-cols-2' : ''}`}
                          >
                            {[...(unitConfigFiles[unit.id] || [])]
                              .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
                              .map((file) => (
                                <div key={file.path} className="rounded border border-slate-800/70 bg-slate-950/60 p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <div className="flex flex-col gap-0.5">
                                      <span className="text-[11px] text-slate-400">
                                        {getConfigLabel(file.relativePath)} config
                                      </span>
                                      <span className="text-[10px] text-slate-500">{file.relativePath}</span>
                                    </div>
                                    <button
                                      onClick={() => onSaveUnitConfig(unit.id, file.path)}
                                      className="text-[11px] text-blue-300 hover:text-blue-200"
                                      disabled={isDeploying}
                                    >
                                      Save file
                                    </button>
                                  </div>
                                  <textarea
                                    value={file.content}
                                    onChange={(e) => onUpdateUnitConfigContent(unit.id, file.path, e.target.value)}
                                    className="font-code w-full min-h-[160px] bg-slate-950 border border-slate-800 rounded px-2 py-2 text-[11px] text-slate-200 focus:outline-none focus:border-blue-500"
                                    spellCheck={false}
                                    disabled={isDeploying}
                                  />
                                </div>
                              ))}
                          </div>
                        )}
                        {template && templatePreviewOpen[unit.id] && (
                          <div className="mt-3 rounded border border-slate-800/70 bg-slate-950/60 p-3 text-[11px] text-slate-300">
                            <div className="font-semibold text-slate-200 mb-1">Template diff preview</div>
                            {(unitConfigFiles[unit.id] || []).length === 0 ? (
                              <p className="text-slate-500">Load unit.config files to compare with the template.</p>
                            ) : (
                              <>
                                {getTemplateDiffSummary(unit.id, template).length === 0 ? (
                                  <p className="text-slate-500">No template changes detected for loaded files.</p>
                                ) : (
                                  <ul className="space-y-2">
                                    {getTemplateDiffSummary(unit.id, template).map((summary) => (
                                      <li key={`template-${unit.id}-${summary.path}`}>
                                        <div className="text-slate-200">{summary.path}</div>
                                        <div className="text-slate-500">
                                          {summary.changed} key{summary.changed === 1 ? '' : 's'} differ
                                          {summary.keys.length > 0 ? `: ${summary.keys.slice(0, 6).join(', ')}` : ''}
                                          {summary.keys.length > 6 ? '…' : ''}
                                        </div>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="mt-4 border-t border-slate-800/70 pt-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="uppercase tracking-wide text-[11px] text-slate-500">Config File Browser</span>
                            <p className="text-[11px] text-slate-500">Open any downloaded config for review or edits.</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => onLoadUnitFiles(unit.id)}
                              className="text-[11px] text-blue-300 hover:text-blue-200"
                              disabled={isDeploying}
                            >
                              Refresh list
                            </button>
                          </div>
                        </div>
                        {unitFileErrors[unit.id] && (
                          <p className="text-[11px] text-red-300 mt-2">{unitFileErrors[unit.id]}</p>
                        )}
                        {unitFileLoading[unit.id] ? (
                          <p className="text-[11px] text-slate-500 mt-2">Loading file list...</p>
                        ) : (unitFileLists[unit.id] || []).length === 0 ? (
                          <p className="text-[11px] text-slate-500 mt-2">No files loaded yet.</p>
                        ) : (
                          <div className="mt-3">
                            <div className="flex items-center gap-2">
                              <select
                                value={unitFileSelections[unit.id] || ''}
                                onChange={(e) => onOpenUnitFile(unit.id, e.target.value)}
                                disabled={isDeploying}
                                className="flex-1 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
                              >
                                <option value="">Select file...</option>
                                {(unitFileLists[unit.id] || []).map((file) => (
                                  <option key={file.path} value={file.path}>
                                    {file.relativePath}
                                  </option>
                                ))}
                              </select>
                              <button
                                onClick={() => onOpenUnitFile(unit.id)}
                                className="text-[11px] text-blue-300 hover:text-blue-200"
                                disabled={isDeploying || !unitFileSelections[unit.id]}
                              >
                                Open
                              </button>
                              <button
                                onClick={() => onSaveUnitFile(unit.id)}
                                className="text-[11px] text-amber-300 hover:text-amber-200"
                                disabled={isDeploying || !unitFileSelections[unit.id]}
                              >
                                Save
                              </button>
                            </div>
                            <textarea
                              value={unitFileContents[unit.id] || ''}
                              onChange={(e) => onUpdateUnitFileContent(unit.id, e.target.value)}
                              className="font-code mt-3 w-full min-h-[160px] bg-slate-950 border border-slate-800 rounded px-2 py-2 text-[11px] text-slate-200 focus:outline-none focus:border-blue-500"
                              spellCheck={false}
                              disabled={isDeploying}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  </div>
                );
              })}
              </div>
            );
          })
        )}
      </div>

      {/* Footer / Counts */}
      <div className="p-3 bg-slate-900 border-t border-slate-700 text-xs text-slate-500 flex items-center justify-between">
        <span>Total: {units.length}</span>
        <div className="flex items-center space-x-2">
          <span>Selected: {selectedIds.length}</span>
          <select
            value={bulkGroup}
            onChange={(e) => setBulkGroup(e.target.value)}
            disabled={isDeploying || selectedIds.length === 0}
            className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-blue-500"
          >
            <option value="">Group selected...</option>
            {groupOptions.map(option => (
              <option key={`bulk-${option}`} value={option}>{option}</option>
            ))}
          </select>
          <button
            onClick={handleBulkGroupApply}
            disabled={isDeploying || selectedIds.length === 0 || !bulkGroup}
            className="px-2 py-1 text-xs font-medium text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
};

export default UnitList;
