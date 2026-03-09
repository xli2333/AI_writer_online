import React from 'react';
import { SparklesIcon } from '@heroicons/react/24/outline';
import { ResearchDocument, WritingTaskOptions } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface ResearchReviewProps {
  topic: string;
  researchDocuments?: ResearchDocument[];
  options?: WritingTaskOptions;
  onApprove: () => void;
  isLoading: boolean;
}

export const ResearchReview: React.FC<ResearchReviewProps> = ({
  topic,
  researchDocuments,
  options,
  onApprove,
  isLoading,
}) => {
  const docs = Array.isArray(researchDocuments) ? researchDocuments : [];
  const deepResearchEnabled = Boolean(options?.enableDeepResearch);

  return (
    <div className="mx-auto max-w-7xl animate-fade-in px-4 py-10 sm:px-6">
      <div className="mb-8 text-center">
        <span className="mb-2 block text-sm font-bold uppercase tracking-wider text-report-accent">Step 2 of 5</span>
        <h2 className="font-serif text-3xl font-bold text-report-text">搜索研究与资料整理</h2>
        <p className="mx-auto mt-3 max-w-3xl text-gray-500">
          这里展示的是本次任务的资料库。普通三路搜索保留研究笔记，Deep Research 只保留清洗后的 Agent 文本输出，供后续方向选择与写作持续调用。
        </p>
      </div>

      <div className="mb-6 rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-wider text-slate-400">当前主题</p>
        <h3 className="mt-2 font-serif text-2xl font-bold text-slate-900">{topic}</h3>
        <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">综合研究</span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">量化研究</span>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-600">人文研究</span>
          {deepResearchEnabled && (
            <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-700">Deep Research 已启用</span>
          )}
        </div>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-6 py-4">
            <h3 className="font-serif text-xl font-bold text-slate-900">研究文档</h3>
            <p className="mt-1 text-sm text-slate-500">
              三路搜索显示为整理后的研究笔记；Deep Research 会硬性清洗，只保留 Agent 文本输出。
            </p>
          </div>
          <div className="max-h-[75vh] space-y-8 overflow-y-auto px-8 py-8">
            {docs.map((doc) => (
              <div key={doc.id} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-6">
                <h4 className="mb-4 font-serif text-xl font-bold text-slate-900">{doc.title}</h4>
                <MarkdownRenderer content={doc.content} />
              </div>
            ))}
          </div>
        </section>

        <aside className="space-y-6">
          {deepResearchEnabled && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm">
              <h3 className="font-serif text-lg font-bold text-amber-900">Deep Research 已参与本轮研究</h3>
              <p className="mt-2 text-sm leading-relaxed text-amber-800">
                当前资料库不只有标准三路搜索，还额外叠加了一层 Deep Research 深挖，用来补充反向信息、争议点和更高价值的公开证据。
              </p>
            </div>
          )}

          <button
            onClick={onApprove}
            disabled={isLoading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-report-accent py-4 font-bold text-white shadow-lg transition-all hover:-translate-y-0.5 hover:bg-teal-800 hover:shadow-xl disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                正在生成讨论方向...
              </>
            ) : (
              <>
                <SparklesIcon className="h-5 w-5" />
                这份资料库没有问题，继续选择讨论方向
              </>
            )}
          </button>
        </aside>
      </div>
    </div>
  );
};
