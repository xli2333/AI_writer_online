import React, { useMemo } from 'react';
import {
  ArrowPathIcon,
  PlayIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { WorkflowSnapshot } from '../types';

interface WorkflowNavigatorProps {
  isOpen: boolean;
  snapshots: WorkflowSnapshot[];
  activeSnapshotId?: string;
  isBusy?: boolean;
  onClose: () => void;
  onRestore: (snapshot: WorkflowSnapshot) => void;
  onContinue: (snapshot: WorkflowSnapshot) => void;
}

const canContinueSnapshot = (snapshot: WorkflowSnapshot) =>
  snapshot.resumeAction === 'continue_from_chunks' ||
  snapshot.resumeAction === 'continue_from_draft' ||
  snapshot.resumeAction === 'continue_teaching_notes';

const getContinueLabel = (snapshot: WorkflowSnapshot) => {
  switch (snapshot.resumeAction) {
    case 'continue_from_chunks':
      return '从这里续写';
    case 'continue_from_draft':
      return '从这里定稿';
    case 'continue_teaching_notes':
      return '继续 TN';
    default:
      return '继续';
  }
};

const formatSnapshotTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

export const WorkflowNavigator: React.FC<WorkflowNavigatorProps> = ({
  isOpen,
  snapshots,
  activeSnapshotId,
  isBusy = false,
  onClose,
  onRestore,
  onContinue,
}) => {
  const orderedSnapshots = useMemo(() => [...snapshots].reverse(), [snapshots]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/20 backdrop-blur-sm"
        aria-label="Close workflow navigator"
        onClick={onClose}
      />

      <aside className="relative z-[91] flex h-full w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-slate-400">Workflow</p>
            <h2 className="mt-2 font-serif text-2xl font-bold text-slate-900">已保存节点</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              每个 chunk、拼合稿和终稿都会落盘。你可以先恢复，再从对应节点继续往下跑。
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close workflow navigator"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-6">
          {orderedSnapshots.length === 0 && (
            <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 px-6 py-10 text-center text-sm text-slate-500">
              当前还没有保存节点。
            </div>
          )}

          {orderedSnapshots.map((snapshot) => {
            const isActive = snapshot.id === activeSnapshotId;

            return (
              <section
                key={snapshot.id}
                className={`rounded-3xl border px-5 py-5 transition-colors ${
                  isActive ? 'border-report-accent bg-teal-50/60' : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-slate-900">{snapshot.label}</h3>
                      {isActive && (
                        <span className="rounded-full bg-report-accent px-2 py-0.5 text-[11px] font-bold text-white">
                          当前
                        </span>
                      )}
                      {typeof snapshot.sourceChunkIndex === 'number' && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                          Chunk {snapshot.sourceChunkIndex}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">{snapshot.description}</p>
                  </div>

                  <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    {formatSnapshotTime(snapshot.createdAt)}
                  </span>
                </div>

                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => onRestore(snapshot)}
                    disabled={isBusy}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowPathIcon className="h-4 w-4" />
                    恢复到这里
                  </button>

                  {canContinueSnapshot(snapshot) && (
                    <button
                      type="button"
                      onClick={() => onContinue(snapshot)}
                      disabled={isBusy}
                      className="inline-flex items-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <PlayIcon className="h-4 w-4" />
                      {getContinueLabel(snapshot)}
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
};
