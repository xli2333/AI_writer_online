import React, { useEffect, useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/solid';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const normalizeGenModel = (model?: string | null) => {
  if (!model || model === 'gemini-3.1-pro') {
    return 'gemini-3.1-pro-preview';
  }

  return model;
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const generationPresets = [
    { label: 'Gemini 3.1 Pro Preview', value: 'gemini-3.1-pro-preview' },
    { label: 'Gemini 3 Pro', value: 'gemini-3-pro-preview' },
    { label: 'Gemini 2.5 Pro', value: 'gemini-2.5-pro' },
    { label: 'Gemini 3 Flash', value: 'gemini-3-flash-preview' },
    { label: 'Gemini 3.1 Flash Lite', value: 'gemini-3.1-flash-lite' },
  ];

  const researchPresets = [
    { label: 'Gemini 3 Flash', value: 'gemini-3-flash-preview' },
    { label: 'Gemini 3.1 Flash Lite', value: 'gemini-3.1-flash-lite' },
    { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
  ];

  const [genSelection, setGenSelection] = useState('gemini-3.1-pro-preview');
  const [searchSelection, setSearchSelection] = useState('gemini-3.1-flash-lite');

  useEffect(() => {
    if (!isOpen) return;
    const normalizedGenModel = normalizeGenModel(localStorage.getItem('GEN_MODEL'));
    if (localStorage.getItem('GEN_MODEL') !== normalizedGenModel) {
      localStorage.setItem('GEN_MODEL', normalizedGenModel);
    }
    setGenSelection(normalizedGenModel);
    setSearchSelection(localStorage.getItem('SEARCH_MODEL') || 'gemini-3.1-flash-lite');
  }, [isOpen]);

  const handleSave = () => {
    localStorage.setItem('GEN_MODEL', genSelection);
    localStorage.setItem('SEARCH_MODEL', searchSelection);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/20 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-slate-100">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="font-serif text-xl font-bold text-slate-900">模型配置</h2>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6">
          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">核心写作模型</label>
            <select
              value={genSelection}
              onChange={(event) => setGenSelection(event.target.value)}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-medium text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/50"
            >
              {generationPresets.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-400">
              负责方向生成、提纲、分段写作、审稿和终稿改写。
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">研究模型</label>
            <select
              value={searchSelection}
              onChange={(event) => setSearchSelection(event.target.value)}
              className="w-full appearance-none rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 font-medium text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/50"
            >
              {researchPresets.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-slate-400">
              负责综合 / 量化 / 人文三路搜索研究，仅使用 Flash 系列。
            </p>
          </div>
        </div>

        <div className="mt-8 flex justify-end">
          <button
            onClick={handleSave}
            className="rounded-lg bg-slate-900 px-6 py-2.5 text-sm font-bold text-white shadow-lg transition-all hover:bg-slate-800 hover:shadow-xl active:scale-95"
          >
            保存配置
          </button>
        </div>
      </div>
    </div>
  );
};
