import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LogEntry } from '../types';
import { Terminal, Save } from 'lucide-react';

interface DeploymentConsoleProps {
  logs: LogEntry[];
  onExportLogs: () => void;
  onOpenLogs: () => void;
}

const DeploymentConsole: React.FC<DeploymentConsoleProps> = ({ logs, onExportLogs, onOpenLogs }) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [unitFilter, setUnitFilter] = useState('');
  const [searchText, setSearchText] = useState('');
  const [typeFilters, setTypeFilters] = useState<Record<string, boolean>>({
    INFO: true,
    WARNING: true,
    ERROR: true,
    SUCCESS: true
  });

  const unitOptions = useMemo(() => {
    const ids = new Set<string>();
    logs.forEach((log) => {
      const match = log.message.match(/^\[(.+?)\]/);
      if (match) ids.add(match[1]);
    });
    return Array.from(ids).sort();
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (!typeFilters[log.type]) return false;
      if (unitFilter) {
        const match = log.message.match(/^\[(.+?)\]/);
        if (!match || match[1] !== unitFilter) return false;
      }
      if (searchText) {
        const lower = searchText.toLowerCase();
        if (!log.message.toLowerCase().includes(lower)) return false;
      }
      return true;
    });
  }, [logs, searchText, typeFilters, unitFilter]);

  const handleExportFiltered = () => {
    const text = filteredLogs.map(l => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `deploy_log_filtered_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="app-panel flex flex-col h-full rounded-2xl font-code text-sm shadow-soft">
      <div className="flex justify-between items-center px-4 py-2 bg-slate-900/80 border-b border-slate-800/80 rounded-t-2xl">
        <div className="flex items-center space-x-2 text-slate-300">
          <Terminal className="w-4 h-4" />
          <span className="font-semibold text-xs uppercase tracking-wider">PowerShell Output Stream</span>
        </div>
        <div className="flex items-center space-x-3 text-xs">
          <button
            onClick={onOpenLogs}
            className="text-slate-400 hover:text-white flex items-center space-x-1"
            title="Open logs"
          >
            <span>Open Logs</span>
          </button>
          <button
            onClick={handleExportFiltered}
            className="text-slate-400 hover:text-white flex items-center space-x-1"
            title="Export filtered logs"
          >
            <Save className="w-3 h-3" />
            <span>Export Filtered</span>
          </button>
          <button 
            onClick={onExportLogs}
            className="text-slate-400 hover:text-white flex items-center space-x-1"
            title="Save logs to file"
          >
            <Save className="w-3 h-3" />
            <span>Export All</span>
          </button>
        </div>
      </div>

      <div className="border-b border-slate-800/80 bg-slate-950/60 px-4 py-2 text-xs text-slate-400 flex flex-wrap gap-2 items-center">
        <select
          value={unitFilter}
          onChange={(e) => setUnitFilter(e.target.value)}
          className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
        >
          <option value="">All Units</option>
          {unitOptions.map((unit) => (
            <option key={`log-unit-${unit}`} value={unit}>{unit}</option>
          ))}
        </select>
        <input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search logs..."
          className="flex-1 min-w-[120px] bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
        />
        {Object.keys(typeFilters).map((type) => (
          <label key={type} className="flex items-center space-x-1">
            <input
              type="checkbox"
              checked={typeFilters[type]}
              onChange={(e) => setTypeFilters(prev => ({ ...prev, [type]: e.target.checked }))}
              className="text-blue-500"
            />
            <span>{type}</span>
          </label>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-1 scrollbar-thin bg-slate-950/80">
        {filteredLogs.length === 0 ? (
          <div className="text-slate-600 italic select-none">Waiting for deployment execution...</div>
        ) : (
          filteredLogs.map((log, index) => (
            <div key={index} className="flex space-x-3 break-all">
              <span className="text-slate-500 shrink-0 select-none">[{log.timestamp}]</span>
              <span className={`
                ${log.type === 'ERROR' ? 'text-red-500 font-bold' : ''}
                ${log.type === 'SUCCESS' ? 'text-green-400' : ''}
                ${log.type === 'WARNING' ? 'text-yellow-400' : ''}
                ${log.type === 'INFO' ? 'text-slate-300' : ''}
              `}>
                {log.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

export default DeploymentConsole;
