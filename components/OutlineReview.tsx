import React, { useState } from 'react';
import { ChatBubbleBottomCenterTextIcon, CheckIcon, SparklesIcon } from '@heroicons/react/24/outline';
import * as GeminiService from '../services/geminiService';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SelectionMenu } from './SelectionMenu';

interface OutlineReviewProps {
  outline: string;
  direction: string;
  ammoLibrary: string;
  onApprove: () => void;
  onRefine: (feedback: string) => void;
  onUpdateOutline: (newOutline: string) => void;
  isRefining: boolean;
}

export const OutlineReview: React.FC<OutlineReviewProps> = ({
  outline,
  direction,
  ammoLibrary,
  onApprove,
  onRefine,
  onUpdateOutline,
  isRefining,
}) => {
  const [feedback, setFeedback] = useState('');
  const [selection, setSelection] = useState('');
  const [selectionPos, setSelectionPos] = useState<{ x: number; y: number } | null>(null);
  const [isMenuLoading, setIsMenuLoading] = useState(false);

  const handleRefine = () => {
    if (!feedback.trim()) return;
    onRefine(feedback);
    setFeedback('');
  };

  const handleMouseUp = () => {
    const currentSelection = window.getSelection();
    if (!currentSelection || currentSelection.isCollapsed || !currentSelection.toString().trim()) {
      return;
    }

    const text = currentSelection.toString().trim();
    const range = currentSelection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    setSelection(text);
    setSelectionPos({
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  };

  const closeMenu = () => {
    setSelection('');
    setSelectionPos(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleSelectionRefine = async (instruction: string) => {
    if (!selection || !outline) return;
    setIsMenuLoading(true);

    try {
      const newOutline = await GeminiService.refineTextBySelection(ammoLibrary, outline, selection, instruction);
      onUpdateOutline(newOutline);
      closeMenu();
    } catch (error) {
      console.error('Outline refinement failed', error);
    } finally {
      setIsMenuLoading(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl animate-fade-in flex-col px-4 py-8 sm:px-6">
      <div className="mb-8 text-center">
        <span className="mb-2 block text-sm font-bold uppercase tracking-wider text-report-accent">Step 4 of 5</span>
        <h2 className="font-serif text-3xl font-bold text-report-text">审阅文章大纲</h2>
        <p className="mx-auto mt-2 max-w-2xl text-gray-500">
          先把结构和论证任务校准好，再进入分段写作。选中文本可以直接做局部微调。
        </p>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-8 lg:grid-cols-3">
        <div
          className="relative flex max-h-[820px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm lg:col-span-2"
          onMouseUp={handleMouseUp}
        >
          <div className="flex items-center justify-between border-b border-gray-200 bg-slate-50 px-6 py-3">
            <span className="text-sm font-bold text-report-secondary">大纲预览</span>
            <span className="text-xs text-gray-400">Markdown</span>
          </div>
          <div className="flex-1 overflow-y-auto bg-white p-8">
            <MarkdownRenderer content={outline} className="text-sm" />
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="rounded-xl border border-teal-100 bg-report-accent-light p-4">
            <h4 className="mb-2 text-xs font-bold uppercase text-report-accent">当前讨论方向</h4>
            <p className="text-sm font-medium leading-snug text-report-text">{direction}</p>
          </div>

          <div className="flex flex-1 flex-col rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center gap-2 font-bold text-gray-700">
              <ChatBubbleBottomCenterTextIcon className="h-5 w-5" />
              <h3>全局修改建议</h3>
            </div>

            <div className="flex flex-1 flex-col">
              <textarea
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="例如：把开头的判断压缩得更快一点，第三部分增加竞争视角，结尾换成更克制的收束。"
                className="mb-4 flex-1 resize-none rounded-lg border border-gray-200 p-4 text-sm leading-relaxed focus:border-transparent focus:ring-2 focus:ring-report-accent"
              />
              <button
                onClick={handleRefine}
                disabled={isRefining || !feedback.trim()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-report-accent bg-white py-3 font-semibold text-report-accent transition-colors hover:bg-report-accent-light disabled:opacity-50"
              >
                {isRefining ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    正在重写大纲...
                  </>
                ) : (
                  <>
                    <SparklesIcon className="h-4 w-4" />
                    提交全局修改
                  </>
                )}
              </button>
            </div>
          </div>

          <button
            onClick={onApprove}
            disabled={isRefining}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-report-accent py-4 font-bold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-teal-800 hover:shadow-xl"
          >
            <CheckIcon className="h-6 w-6" />
            批准大纲并开始写作
          </button>
        </div>
      </div>

      <SelectionMenu
        position={selectionPos}
        selectedText={selection}
        onClose={closeMenu}
        onSubmit={handleSelectionRefine}
        isLoading={isMenuLoading}
      />
    </div>
  );
};
