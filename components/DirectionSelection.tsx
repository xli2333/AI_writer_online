import React, { useState } from 'react';
import { CheckCircleIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { WritingTaskOptions } from '../types';

interface DirectionSelectionProps {
  directions: string[];
  options: WritingTaskOptions;
  onSelect: (direction: string) => void;
  onRefine: (refinement: string) => void;
  isRefining: boolean;
}

export const DirectionSelection: React.FC<DirectionSelectionProps> = ({
  directions,
  options,
  onSelect,
  onRefine,
  isRefining,
}) => {
  const [refinement, setRefinement] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);

  const handleRefineSubmit = () => {
    if (!refinement.trim()) return;
    onRefine(refinement);
    setRefinement('');
  };

  return (
    <div className="mx-auto max-w-5xl animate-fade-in px-4 py-12 sm:px-6">
      <div className="mb-10 text-center">
        <span className="mb-2 block text-sm font-bold uppercase tracking-wider text-report-accent">Step 3 of 5</span>
        <h2 className="mb-4 font-serif text-3xl font-bold text-report-text">选择讨论方向</h2>
        <p className="mx-auto max-w-2xl text-gray-500">
          资料库已经整理完成。先确定这篇文章最值得展开的切口，再进入提纲阶段。
        </p>
      </div>

      <div className="mb-8 grid gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-sm sm:grid-cols-2">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">文体</p>
          <p className="mt-1 text-sm font-medium text-slate-700">{options.genre}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">风格</p>
          <p className="mt-1 text-sm font-medium text-slate-700">{options.style}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">受众</p>
          <p className="mt-1 text-sm font-medium text-slate-700">{options.audience}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-slate-400">目标字数</p>
          <p className="mt-1 text-sm font-medium text-slate-700">
            约 {options.desiredLength} 字 / 单轮约 {options.chunkLength} 字
          </p>
        </div>
      </div>

      <div className={`grid gap-4 ${isRefining ? 'pointer-events-none opacity-50' : ''}`}>
        {directions.map((direction, index) => (
          <button
            key={index}
            onClick={() => onSelect(direction)}
            className="group relative rounded-2xl border border-gray-200 bg-white p-6 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-report-accent hover:shadow-lg"
          >
            <div className="flex items-start gap-5">
              <div className="mt-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border border-gray-200 bg-gray-50 font-mono text-sm text-gray-400 transition-colors group-hover:border-report-accent group-hover:bg-report-accent group-hover:text-white">
                {index + 1}
              </div>
              <div className="flex-1 pr-8">
                <p className="text-lg font-medium leading-relaxed text-report-text transition-colors group-hover:text-report-accent">
                  {direction}
                </p>
              </div>
              <div className="absolute right-6 top-1/2 -translate-y-1/2 opacity-0 transition-all group-hover:scale-110 group-hover:opacity-100">
                <CheckCircleIcon className="h-6 w-6 text-report-accent" />
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-dashed border-gray-300 bg-slate-50 p-6">
        {!showCustomInput ? (
          <div
            className="flex cursor-pointer items-center justify-center gap-2 py-2 text-report-secondary transition-colors hover:text-report-accent"
            onClick={() => setShowCustomInput(true)}
          >
            <SparklesIcon className="h-5 w-5" />
            <span className="font-medium">没有合适的方向？告诉 AI 你想强调什么</span>
          </div>
        ) : (
          <div className="animate-fade-in">
            <label className="mb-2 block text-sm font-bold text-gray-700">补充你的偏好</label>
            <textarea
              value={refinement}
              onChange={(event) => setRefinement(event.target.value)}
              placeholder="例如：更偏向行业趋势判断、组织管理启示，或者想把开头做得更像评论文章。"
              className="mb-4 w-full rounded-lg border border-gray-200 p-4 text-report-text focus:border-transparent focus:ring-2 focus:ring-report-accent"
              rows={3}
              disabled={isRefining}
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowCustomInput(false)}
                className="px-4 py-2 font-medium text-gray-500 hover:text-gray-700"
                disabled={isRefining}
              >
                取消
              </button>
              <button
                onClick={handleRefineSubmit}
                disabled={!refinement.trim() || isRefining}
                className="flex items-center gap-2 rounded-lg bg-report-accent px-6 py-2 font-medium text-white shadow-sm transition-colors hover:bg-teal-800 disabled:opacity-50"
              >
                {isRefining ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                    重新生成中...
                  </>
                ) : (
                  <>
                    <SparklesIcon className="h-4 w-4" />
                    生成新方向
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
