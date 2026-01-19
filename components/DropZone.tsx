import React, { useCallback, useState, useEffect } from 'react';
import { Upload, Image as ImageIcon, Loader2, X } from 'lucide-react';

interface DropZoneProps {
  onImageLoaded: (file: File) => void;
  isProcessing: boolean;
}

const DropZone: React.FC<DropZoneProps> = ({ onImageLoaded, isProcessing }) => {
  const [dragActive, setDragActive] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Cleanup object URL
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = (file: File) => {
    // Create preview
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    onImageLoaded(file);
  };

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  }, [onImageLoaded]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      handleFile(e.target.files[0]);
    }
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (e.clipboardData.items) {
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        const item = e.clipboardData.items[i];
        if (item.type.indexOf('image') !== -1) {
          const file = item.getAsFile();
          if (file) handleFile(file);
          break;
        }
      }
    }
  }, [onImageLoaded]);

  const clearPreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewUrl(null);
  };

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl h-52 transition-all overflow-hidden flex flex-col items-center justify-center ${
        dragActive ? 'border-blue-400 bg-blue-500/10 shadow-soft' : 'border-slate-600/70 hover:border-slate-400/80'
      } ${isProcessing ? 'opacity-60 pointer-events-none' : ''}`}
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
      // @ts-ignore
      onPaste={handlePaste as any}
      tabIndex={0}
    >
      <input
        type="file"
        id="file-upload"
        className="hidden"
        accept="image/*"
        onChange={handleChange}
      />

      {previewUrl ? (
        <div className="relative w-full h-full group">
          <img 
            src={previewUrl} 
            alt="Preview" 
            className="w-full h-full object-cover opacity-70 group-hover:opacity-40 transition-opacity" 
          />
          <div className="absolute top-2 left-2 rounded-full bg-slate-950/80 px-2.5 py-1 text-[10px] uppercase tracking-wider text-slate-200">
            {isProcessing ? 'Extracting' : 'Ready'}
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            {isProcessing ? (
              <div className="bg-slate-900/80 p-3 rounded-full">
                 <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
              </div>
            ) : (
              <button 
                onClick={clearPreview}
                className="bg-red-500/80 hover:bg-red-600 text-white p-2 rounded-full opacity-0 group-hover:opacity-100 transition-opacity transform translate-y-2 group-hover:translate-y-0"
                title="Clear Image"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>
          <div className="absolute bottom-2 left-0 right-0 text-center pointer-events-none">
             <span className="bg-black/50 text-xs px-2 py-1 rounded text-white">Image Loaded</span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center text-center p-4">
          {isProcessing ? (
            <Loader2 className="w-10 h-10 text-blue-500 animate-spin" />
          ) : (
            <>
              <div className="p-3 bg-slate-800/80 rounded-full mb-3 shadow-soft">
                <Upload className="w-6 h-6 text-slate-300" />
              </div>
              <div className="text-slate-300">
                <p className="text-sm font-semibold">Drop Screenshot</p>
                <p className="text-xs text-slate-500 mt-1">
                  Paste from clipboard or{' '}
                  <label htmlFor="file-upload" className="text-blue-400 hover:text-blue-300 cursor-pointer">browse</label>
                </p>
                <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-slate-600">
                  <ImageIcon className="w-3 h-3" />
                  <span>PNG, JPG, or WebP. Fastest results with clear labels.</span>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default DropZone;
