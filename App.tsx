import React, { useEffect, useRef, useState } from 'react';
import {
  Cog6ToothIcon,
  DocumentTextIcon,
  LockOpenIcon,
  MagnifyingGlassIcon,
  PaperClipIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import {
  GenerationState,
  GenerationStep,
  UploadedFile,
  WritingProjectData,
  WritingTaskOptions,
} from './types';
import * as GeminiService from './services/geminiService';
import { clearAppCheckpoint, loadAppCheckpoint, saveAppCheckpoint } from './services/checkpointStore';
import { ApiKeyInput } from './components/ApiKeyInput';
import { ArticleViewer } from './components/ArticleViewer';
import { DirectionSelection } from './components/DirectionSelection';
import { OutlineReview } from './components/OutlineReview';
import { ResearchReview } from './components/ResearchReview';
import { SettingsModal } from './components/SettingsModal';

const defaultOptions: WritingTaskOptions = {
  genre: '商业分析',
  style: '理性克制',
  audience: '企业管理者',
  articleGoal: '解释问题，形成判断，并给出对管理和决策有用的启发。',
  desiredLength: 3000,
  chunkLength: 1500,
  includeTeachingNotes: false,
  enableDeepResearch: false,
  deepResearchPrompt: '',
};

const createEmptyProject = (options: WritingTaskOptions): WritingProjectData => ({
  topic: '',
  sources: [],
  ammoLibrary: '',
  researchDocuments: [],
  referenceArticles: [],
  directions: [],
  options,
});

const progressFromStatus = (message: string) => {
  if (message.includes('写作第')) return 75;
  if (message.includes('证据卡')) return 62;
  if (message.includes('写作方法')) return 56;
  if (message.includes('分段写作')) return 68;
  if (message.includes('审查')) return 88;
  if (message.includes('TN')) return 94;
  if (message.includes('终稿')) return 92;
  return 50;
};

const extractErrorDetails = (error: unknown) => GeminiService.formatRuntimeError(error);

const buildErrorState = (message: string, error: unknown): GenerationState => ({
  step: GenerationStep.ERROR,
  progress: 0,
  message,
  details: extractErrorDetails(error),
});

const stripMarkdownTitleDecorators = (line: string) =>
  line
    .trim()
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/^__(.+)__$/, '$1')
    .trim();

const extractTitle = (fallback: string, content?: string) => {
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const markdownHeading = lines.find((line) => /^#\s+/.test(line));
  if (markdownHeading) {
    return stripMarkdownTitleDecorators(markdownHeading);
  }

  const candidate = lines
    .slice(0, 8)
    .map(stripMarkdownTitleDecorators)
    .find(
      (line) =>
        line.length >= 6 &&
        line.length <= 40 &&
        !/^[0-9０-９一二三四五六七八九十]+[、.]/.test(line) &&
        !/^\d{4}[-/年]/.test(line) &&
        !/[。！？；]$/.test(line)
    );

  return candidate || fallback;
};

const normalizeGenModel = (model?: string | null) => {
  if (!model || model === 'gemini-3.1-pro') {
    return 'gemini-3.1-pro-preview';
  }

  return model;
};

const normalizeTaskOptions = (options?: Partial<WritingTaskOptions> | null): WritingTaskOptions => ({
  ...defaultOptions,
  ...options,
  desiredLength: typeof options?.desiredLength === 'number' ? options.desiredLength : defaultOptions.desiredLength,
  chunkLength: typeof options?.chunkLength === 'number' ? options.chunkLength : defaultOptions.chunkLength,
  includeTeachingNotes:
    typeof options?.includeTeachingNotes === 'boolean'
      ? options.includeTeachingNotes
      : defaultOptions.includeTeachingNotes,
  enableDeepResearch:
    typeof options?.enableDeepResearch === 'boolean' ? options.enableDeepResearch : defaultOptions.enableDeepResearch,
  deepResearchPrompt:
    typeof options?.deepResearchPrompt === 'string' ? options.deepResearchPrompt : defaultOptions.deepResearchPrompt,
});

const normalizeUploadedFiles = (files?: UploadedFile[] | null): UploadedFile[] =>
  Array.isArray(files)
    ? files
        .filter(
          (file) =>
            file &&
            typeof file.name === 'string' &&
            typeof file.mimeType === 'string' &&
            typeof file.data === 'string'
        )
        .map((file) => ({ ...file, isText: Boolean(file.isText) }))
    : [];

const normalizeProjectData = (
  projectData?: Partial<WritingProjectData> | null,
  fallbackOptions?: Partial<WritingTaskOptions> | null
): WritingProjectData => {
  const options = normalizeTaskOptions(projectData?.options || fallbackOptions || defaultOptions);

  return {
    ...createEmptyProject(options),
    ...projectData,
    topic: projectData?.topic || '',
    sources: Array.isArray(projectData?.sources) ? projectData.sources : [],
    researchDocuments: Array.isArray(projectData?.researchDocuments) ? projectData.researchDocuments : [],
    referenceArticles: Array.isArray(projectData?.referenceArticles) ? projectData.referenceArticles : [],
    directions: Array.isArray(projectData?.directions) ? projectData.directions : [],
    options,
  };
};

const deriveRestoredGenState = (
  projectData: WritingProjectData,
  previousState?: GenerationState | null
): GenerationState => {
  if (projectData.articleContent) {
    return {
      step: GenerationStep.COMPLETED,
      progress: 100,
      message: '已从本地缓存恢复到终稿阶段。',
    };
  }

  if (projectData.outline && projectData.selectedDirection) {
    return {
      step: GenerationStep.REVIEWING_OUTLINE,
      progress: 60,
      message: '已从本地缓存恢复到大纲审阅阶段。',
    };
  }

  if (projectData.directions.length > 0) {
    return {
      step: GenerationStep.SELECTING_DIRECTION,
      progress: 50,
      message: projectData.selectedDirection
        ? '上次大纲生成中断，已恢复到讨论方向阶段。'
        : '已从本地缓存恢复到讨论方向阶段。',
    };
  }

  if (projectData.researchDocuments.length > 0 || projectData.ammoLibrary) {
    return {
      step: GenerationStep.REVIEWING_RESEARCH,
      progress: 35,
      message:
        previousState?.step === GenerationStep.RESEARCHING
          ? '上次流程中断，已恢复到研究审阅阶段。'
          : '已从本地缓存恢复到研究审阅阶段。',
    };
  }

  return {
    step: GenerationStep.IDLE,
    progress: 0,
    message: '',
  };
};

const hasCustomizedOptions = (options: WritingTaskOptions) =>
  options.genre !== defaultOptions.genre ||
  options.style !== defaultOptions.style ||
  options.audience !== defaultOptions.audience ||
  options.articleGoal !== defaultOptions.articleGoal ||
  options.desiredLength !== defaultOptions.desiredLength ||
  options.chunkLength !== defaultOptions.chunkLength ||
  options.includeTeachingNotes !== defaultOptions.includeTeachingNotes ||
  options.enableDeepResearch !== defaultOptions.enableDeepResearch ||
  options.deepResearchPrompt !== defaultOptions.deepResearchPrompt;

const shouldPersistCheckpoint = ({
  topic,
  taskOptions,
  uploadedFiles,
  projectData,
  genState,
}: {
  topic: string;
  taskOptions: WritingTaskOptions;
  uploadedFiles: UploadedFile[];
  projectData: WritingProjectData;
  genState: GenerationState;
}) =>
  Boolean(
    topic.trim() ||
      hasCustomizedOptions(taskOptions) ||
      uploadedFiles.length ||
      projectData.topic ||
      projectData.ammoLibrary ||
      projectData.researchDocuments.length ||
      projectData.referenceArticles.length ||
      projectData.directions.length ||
      projectData.selectedDirection ||
      projectData.outline ||
      projectData.writingInsights ||
      projectData.evidenceCards ||
      projectData.chunkPlan?.length ||
      projectData.critique ||
      projectData.articleContent ||
      projectData.teachingNotes ||
      genState.step !== GenerationStep.IDLE
  );

const genreOptions = ['商业分析', '趋势解读', '案例分析', '行业评论', '人物观察'];
const styleOptions = ['理性克制', '洞察型', '媒体型', '启发式', '叙事型'];

const App: React.FC = () => {
  const [topic, setTopic] = useState('');
  const [taskOptions, setTaskOptions] = useState<WritingTaskOptions>(defaultOptions);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [isRefiningDirections, setIsRefiningDirections] = useState(false);
  const [isRefiningOutline, setIsRefiningOutline] = useState(false);
  const [isGeneratingDirections, setIsGeneratingDirections] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [isCheckpointHydrated, setIsCheckpointHydrated] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [projectData, setProjectData] = useState<WritingProjectData>(createEmptyProject(defaultOptions));
  const [genState, setGenState] = useState<GenerationState>({
    step: GenerationStep.IDLE,
    progress: 0,
    message: '',
  });

  useEffect(() => {
    let isMounted = true;
    const normalizedGenModel = normalizeGenModel(localStorage.getItem('GEN_MODEL'));
    if (localStorage.getItem('GEN_MODEL') !== normalizedGenModel) {
      localStorage.setItem('GEN_MODEL', normalizedGenModel);
    }

    if (localStorage.getItem('GEMINI_API_KEY')) {
      setHasApiKey(true);
    }

    const hydrateCheckpoint = async () => {
      try {
        const checkpoint = await loadAppCheckpoint();
        if (!isMounted || !checkpoint) return;

        const restoredTaskOptions = normalizeTaskOptions(checkpoint.taskOptions);
        const restoredProjectData = normalizeProjectData(checkpoint.projectData, restoredTaskOptions);
        const restoredGenState = deriveRestoredGenState(restoredProjectData, checkpoint.genState);

        setTopic(checkpoint.topic || restoredProjectData.topic || '');
        setTaskOptions(restoredTaskOptions);
        setUploadedFiles(normalizeUploadedFiles(checkpoint.uploadedFiles));
        setProjectData(restoredProjectData);
        setGenState(restoredGenState);
        if (restoredGenState.message) {
          setRestoreNotice(restoredGenState.message);
        }
      } catch (error) {
        console.error('Failed to restore checkpoint', error);
      } finally {
        if (isMounted) {
          setIsCheckpointHydrated(true);
        }
      }
    };

    void hydrateCheckpoint();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isCheckpointHydrated) return;

    const timer = window.setTimeout(() => {
      if (
        !shouldPersistCheckpoint({
          topic,
          taskOptions,
          uploadedFiles,
          projectData,
          genState,
        })
      ) {
        void clearAppCheckpoint();
        return;
      }

      void saveAppCheckpoint({
        version: 1,
        topic,
        taskOptions,
        uploadedFiles,
        projectData,
        genState,
        updatedAt: new Date().toISOString(),
      });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [isCheckpointHydrated, topic, taskOptions, uploadedFiles, projectData, genState]);

  const handleClearKey = () => {
    if (confirm('清除当前 API Key 并返回登录页？')) {
      localStorage.removeItem('GEMINI_API_KEY');
      setHasApiKey(false);
    }
  };

  const handleTaskOptionChange = <K extends keyof WritingTaskOptions>(key: K, value: WritingTaskOptions[K]) => {
    setTaskOptions((prev) => ({ ...prev, [key]: value }));
  };

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  const readFileAsText = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsText(file);
    });

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length) return;

    const files = Array.from(event.target.files);
    const nextFiles: UploadedFile[] = [];

    for (const file of files) {
      try {
        const isPdf = file.type === 'application/pdf';
        if (isPdf) {
          nextFiles.push({
            name: file.name,
            mimeType: file.type,
            data: await readFileAsBase64(file),
            isText: false,
          });
        } else {
          nextFiles.push({
            name: file.name,
            mimeType: 'text/plain',
            data: await readFileAsText(file),
            isText: true,
          });
        }
      } catch (error) {
        console.error(`Failed to read ${file.name}`, error);
      }
    }

    setUploadedFiles((prev) => [...prev, ...nextFiles]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index: number) => {
    setUploadedFiles((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  };

  const handleReset = () => {
    setTopic('');
    setUploadedFiles([]);
    setTaskOptions(defaultOptions);
    setProjectData(createEmptyProject(defaultOptions));
    setGenState({ step: GenerationStep.IDLE, progress: 0, message: '' });
    setRestoreNotice(null);
    void clearAppCheckpoint();
  };

  const handleStartResearch = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!topic.trim()) return;

    setGenState({ step: GenerationStep.RESEARCHING, progress: 8, message: '正在启动研究流程...' });
    setProjectData(createEmptyProject(taskOptions));

    try {
      const { ammoLibrary, researchDocuments, sources } = await GeminiService.gatherInformation(
        topic,
        uploadedFiles,
        taskOptions,
        (message) => {
          let progress = 18;
          if (message.includes('量化')) progress = 24;
          if (message.includes('人文')) progress = 30;
          if (message.includes('Deep Research')) progress = 36;
          if (message.includes('合并信息弹药库')) progress = 38;
          setGenState((prev) => ({ ...prev, message, progress }));
        }
      );

      setProjectData((prev) => ({
        ...prev,
        topic,
        ammoLibrary,
        researchDocuments,
        sources,
        options: taskOptions,
      }));

      setGenState({
        step: GenerationStep.REVIEWING_RESEARCH,
        progress: 35,
        message: '请先审阅信息弹药库。',
      });
    } catch (error) {
      console.error('Research stage failed', error);
      setGenState(buildErrorState('研究阶段失败，请稍后重试。', error));
    }
  };

  const handleApproveResearch = async () => {
    setIsGeneratingDirections(true);
    setGenState({
      step: GenerationStep.RESEARCHING,
      progress: 42,
      message: '正在基于信息弹药库生成讨论方向...',
    });

    try {
      const directions = await GeminiService.generateDiscussionDirections(topic, projectData.ammoLibrary, taskOptions);
      setProjectData((prev) => ({ ...prev, directions }));
      setGenState({
        step: GenerationStep.SELECTING_DIRECTION,
        progress: 50,
        message: '请选择讨论方向。',
      });
    } catch (error) {
      console.error('Direction generation failed', error);
      setGenState(buildErrorState('讨论方向生成失败，请重试。', error));
    } finally {
      setIsGeneratingDirections(false);
    }
  };

  const handleRefineDirections = async (refinement: string) => {
    setIsRefiningDirections(true);

    try {
      const directions = await GeminiService.refineDiscussionDirections(
        topic,
        projectData.ammoLibrary,
        taskOptions,
        refinement
      );
      setProjectData((prev) => ({ ...prev, directions }));
    } catch (error) {
      console.error('Direction refinement failed', error);
    } finally {
      setIsRefiningDirections(false);
    }
  };

  const handleDirectionSelect = async (direction: string) => {
    setProjectData((prev) => ({ ...prev, selectedDirection: direction }));
    setGenState({
      step: GenerationStep.REVIEWING_OUTLINE,
      progress: 54,
      message: '正在生成文章大纲...',
    });

    try {
      const outlineResult = await GeminiService.generateArticleOutline(
        topic,
        projectData.ammoLibrary,
        direction,
        taskOptions
      );
      setProjectData((prev) => ({
        ...prev,
        selectedDirection: direction,
        outline: outlineResult.outline,
        referenceArticles: outlineResult.referenceArticles,
      }));
      setGenState({
        step: GenerationStep.REVIEWING_OUTLINE,
        progress: 60,
        message: '请审阅大纲。',
      });
    } catch (error) {
      console.error('Outline generation failed', error);
      setGenState(buildErrorState('大纲生成失败，请重试。', error));
    }
  };

  const handleRefineOutline = async (feedback: string) => {
    if (!projectData.selectedDirection || !projectData.outline) return;

    setIsRefiningOutline(true);
    try {
      const nextOutlineResult = await GeminiService.generateArticleOutline(
        topic,
        projectData.ammoLibrary,
        projectData.selectedDirection,
        taskOptions,
        feedback,
        projectData.outline
      );
      setProjectData((prev) => ({
        ...prev,
        outline: nextOutlineResult.outline,
        referenceArticles:
          nextOutlineResult.referenceArticles.length > 0
            ? nextOutlineResult.referenceArticles
            : prev.referenceArticles,
      }));
    } catch (error) {
      console.error('Outline refinement failed', error);
    } finally {
      setIsRefiningOutline(false);
    }
  };

  const handleApproveOutline = async () => {
    if (!projectData.selectedDirection || !projectData.outline) return;

    setGenState({
      step: GenerationStep.WRITING,
      progress: 62,
      message: '正在进入分段写作...',
    });

    try {
      const result = await GeminiService.generateArticlePackage(
        topic,
        projectData.ammoLibrary,
        projectData.selectedDirection,
        projectData.outline,
        projectData.referenceArticles,
        taskOptions,
        (message) => {
          setGenState({
            step: GenerationStep.WRITING,
            progress: progressFromStatus(message),
            message,
          });
        }
      );

      const finalTitle = extractTitle(topic, result.articleContent);

      setProjectData((prev) => ({
        ...prev,
        topic: finalTitle,
        referenceArticles: result.referenceArticles,
        writingInsights: result.writingInsights,
        evidenceCards: result.evidenceCards,
        chunkPlan: result.chunkPlan,
        critique: result.critique,
        articleContent: result.articleContent,
        teachingNotes: result.teachingNotes,
      }));

      setGenState({
        step: GenerationStep.COMPLETED,
        progress: 100,
        message: '生成完成。',
      });
    } catch (error) {
      console.error('Writing stage failed', error);
      setGenState(buildErrorState('写作阶段失败，请稍后重试。', error));
    }
  };

  if (!hasApiKey) {
    return <ApiKeyInput onKeySet={() => setHasApiKey(true)} />;
  }

  const isIdle = genState.step === GenerationStep.IDLE;
  const isProcessing =
    genState.step === GenerationStep.RESEARCHING ||
    genState.step === GenerationStep.WRITING ||
    (genState.step === GenerationStep.REVIEWING_OUTLINE && !projectData.outline);
  const isReviewingResearch = genState.step === GenerationStep.REVIEWING_RESEARCH;
  const isSelecting = genState.step === GenerationStep.SELECTING_DIRECTION;
  const isReviewing = genState.step === GenerationStep.REVIEWING_OUTLINE && !!projectData.outline;
  const isCompleted = genState.step === GenerationStep.COMPLETED;
  const isError = genState.step === GenerationStep.ERROR;
  const processingReferenceArticles =
    genState.step === GenerationStep.WRITING ? projectData.referenceArticles.slice(0, 3) : [];

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900">
      <nav className="sticky top-0 z-50 border-b border-slate-100 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="cursor-pointer group" onClick={handleReset}>
            <span className="font-serif text-2xl font-bold tracking-tight text-slate-900 transition-colors group-hover:text-report-accent">
              Writing Workspace
            </span>
          </div>

          <div className="flex items-center gap-6">
            {isProcessing && (
              <div className="mr-4 flex flex-col items-end">
                <span className="mb-1 text-xs font-bold uppercase tracking-wider text-report-accent animate-pulse">
                  {genState.message}
                </span>
                <div className="h-1 w-48 overflow-hidden rounded-full bg-gray-100">
                  <div
                    className="h-full bg-gradient-to-r from-report-accent to-teal-400 transition-all duration-700 ease-out"
                    style={{ width: `${genState.progress}%` }}
                  />
                </div>
              </div>
            )}

            <button
              onClick={() => setIsSettingsOpen(true)}
              className="flex items-center gap-1 text-xs font-bold uppercase tracking-widest text-slate-400 transition-colors hover:text-slate-700"
              title="Model Settings"
            >
              <Cog6ToothIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Settings</span>
            </button>

            <button
              onClick={handleClearKey}
              className="flex items-center gap-1 text-xs font-bold uppercase tracking-widest text-slate-300 transition-colors hover:text-red-500"
              title="Disconnect API Key"
            >
              <LockOpenIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Disconnect</span>
            </button>
          </div>
        </div>
      </nav>

      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

      {restoreNotice && (
        <div className="border-b border-emerald-100 bg-emerald-50/80">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 text-sm text-emerald-900 sm:px-6 lg:px-8">
            <span>{restoreNotice}</span>
            <button
              onClick={() => setRestoreNotice(null)}
              className="shrink-0 font-semibold text-emerald-700 transition-colors hover:text-emerald-900"
            >
              知道了
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto w-full">
        {isIdle && (
          <div className="mx-auto max-w-5xl px-6 py-24 text-center animate-fade-in">
            <h1 className="mb-6 font-serif text-5xl font-bold leading-tight tracking-tight text-slate-900 md:text-6xl">
              搜索、整理、判断，
              <br />
              <span className="bg-gradient-to-r from-report-accent to-teal-500 bg-clip-text text-transparent">
                生成商业文章终稿
              </span>
            </h1>
            <p className="mx-auto mb-12 max-w-3xl text-lg leading-relaxed text-slate-500">
              这条流程保留原来的研究、方向选择、大纲、成文与审查骨架，但输出对象已经从 case 切换为商业文章，TN / 讨论指南可以按任务选择是否生成。
            </p>

            <div className="group rounded-3xl bg-white p-3 shadow-[0_20px_50px_rgba(0,0,0,0.08)] ring-1 ring-slate-100 transition-all duration-300 hover:-translate-y-1">
              <form onSubmit={handleStartResearch} className="flex flex-col">
                <div className="relative flex w-full items-center">
                  <MagnifyingGlassIcon className="absolute left-6 h-6 w-6 text-slate-400 transition-colors group-focus-within:text-report-accent" />
                  <input
                    type="text"
                    value={topic}
                    onChange={(event) => setTopic(event.target.value)}
                    placeholder="输入文章主题，例如：泡泡玛特出海逻辑、AI 医疗赛道的新分水岭"
                    className="w-full border-none bg-transparent py-5 pl-16 pr-44 text-lg text-slate-800 placeholder:text-slate-300 outline-none focus:ring-0"
                  />
                  <button
                    type="submit"
                    disabled={!topic.trim()}
                    className="absolute bottom-2 right-2 top-2 rounded-xl bg-report-accent px-8 text-base font-bold tracking-wide text-white shadow-lg transition-all hover:scale-[1.02] hover:bg-teal-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 disabled:shadow-none"
                  >
                    开始研究
                  </button>
                </div>

                {uploadedFiles.length > 0 && <div className="mx-4 h-px bg-gray-100" />}

                {uploadedFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 bg-slate-50 px-6 py-3 text-left">
                    {uploadedFiles.map((file, index) => (
                      <div
                        key={`${file.name}-${index}`}
                        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm shadow-sm"
                      >
                        <DocumentTextIcon className="h-4 w-4 text-report-accent" />
                        <span className="max-w-[150px] truncate font-medium text-slate-700" title={file.name}>
                          {file.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeFile(index)}
                          className="text-gray-400 transition-colors hover:text-red-500"
                        >
                          <XMarkIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid gap-4 border-t border-gray-100 bg-gray-50/50 px-5 py-5 text-left md:grid-cols-2 xl:grid-cols-4">
                  <label className="block">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">文体</span>
                    <select
                      value={taskOptions.genre}
                      onChange={(event) => handleTaskOptionChange('genre', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                    >
                      {genreOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">风格</span>
                    <select
                      value={taskOptions.style}
                      onChange={(event) => handleTaskOptionChange('style', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                    >
                      {styleOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">目标受众</span>
                    <input
                      type="text"
                      value={taskOptions.audience}
                      onChange={(event) => handleTaskOptionChange('audience', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">目标字数</span>
                    <input
                      type="number"
                      min={1200}
                      step={100}
                      value={taskOptions.desiredLength}
                      onChange={(event) => handleTaskOptionChange('desiredLength', Number(event.target.value) || 3000)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                    />
                  </label>

                  <label className="block xl:col-span-2">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">文章目标</span>
                    <input
                      type="text"
                      value={taskOptions.articleGoal}
                      onChange={(event) => handleTaskOptionChange('articleGoal', event.target.value)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">单轮写作长度</span>
                    <input
                      type="number"
                      min={1000}
                      max={1800}
                      step={100}
                      value={taskOptions.chunkLength}
                      onChange={(event) => handleTaskOptionChange('chunkLength', Number(event.target.value) || 1500)}
                      className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                    />
                  </label>

                  <label className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 xl:justify-center">
                    <input
                      type="checkbox"
                      checked={taskOptions.includeTeachingNotes}
                      onChange={(event) => handleTaskOptionChange('includeTeachingNotes', event.target.checked)}
                      className="h-4 w-4 rounded border-slate-300 text-report-accent focus:ring-report-accent"
                    />
                    <span className="text-sm font-medium text-slate-700">同时生成 TN / 讨论指南</span>
                  </label>

                  <label className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 xl:col-span-2">
                    <input
                      type="checkbox"
                      checked={taskOptions.enableDeepResearch}
                      onChange={(event) => handleTaskOptionChange('enableDeepResearch', event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-report-accent focus:ring-report-accent"
                    />
                    <span className="block">
                      <span className="block text-sm font-medium text-slate-700">启用 Deep Research Pro Preview</span>
                      <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                        启用后会在综合 / 量化 / 人文三路研究之外，再追加一层 Deep Research。耗时更长，但信息浓度和补充深挖能力更强。
                      </span>
                    </span>
                  </label>

                  {taskOptions.enableDeepResearch && (
                    <label className="block xl:col-span-2">
                      <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-400">
                        Deep Research 提示词
                      </span>
                      <textarea
                        rows={5}
                        value={taskOptions.deepResearchPrompt}
                        onChange={(event) => handleTaskOptionChange('deepResearchPrompt', event.target.value)}
                        placeholder="示例：请重点深挖这家公司最近两年的战略调整、关键高管表态、财务与市场份额变化、行业反方观点，以及海外市场的对照案例。"
                        className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-relaxed text-slate-800 outline-none focus:border-report-accent focus:ring-2 focus:ring-report-accent/20"
                      />
                      <span className="mt-2 block text-xs leading-relaxed text-slate-500">
                        这段内容只用于 Deep Research。综合 / 量化 / 人文三路搜索仍然走系统内置的默认研究提示词。
                      </span>
                    </label>
                  )}
                </div>

                <div className="flex items-center justify-between rounded-b-3xl border-t border-gray-100 bg-gray-50/50 px-4 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      ref={fileInputRef}
                      onChange={handleFileChange}
                      accept=".pdf,.txt,.md,.csv"
                      multiple
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-2 rounded px-2 py-1 text-xs font-bold text-gray-500 transition-colors hover:bg-white hover:text-report-accent"
                    >
                      <PaperClipIcon className="h-4 w-4" />
                      <span>上传补充资料（PDF/TXT/MD/CSV）</span>
                    </button>
                  </div>
                  <span className="text-[10px] font-medium text-gray-400">上传资料优先于网页搜索</span>
                </div>
              </form>
            </div>
          </div>
        )}

        {isProcessing && (
          <div className="flex min-h-[70vh] flex-col items-center justify-center p-8 text-center animate-fade-in">
            <div className="relative mb-10 h-24 w-24">
              <div className="absolute inset-0 animate-spin rounded-full border-t-4 border-report-accent" />
              <div
                className="absolute inset-3 animate-spin rounded-full border-t-4 border-teal-300"
                style={{ animationDirection: 'reverse', animationDuration: '1.5s' }}
              />
            </div>
            <h3 className="mb-3 font-serif text-3xl font-bold text-slate-800">工作流运行中</h3>
            <p className="max-w-md text-lg font-light text-slate-500">{genState.message}</p>
            {processingReferenceArticles.length > 0 && (
              <div className="mt-8 w-full max-w-2xl rounded-2xl border border-slate-200 bg-white/90 p-5 text-left shadow-sm">
                <p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">当前参考模板</p>
                <div className="space-y-3">
                  {processingReferenceArticles.map((article, index) => (
                    <div key={article.id || `${article.title}-${index}`} className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-wider text-report-accent">Template {index + 1}</p>
                      <p className="mt-1 text-sm font-medium leading-relaxed text-slate-800">{article.title}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {isSelecting && (
          <DirectionSelection
            directions={projectData.directions}
            options={taskOptions}
            onSelect={handleDirectionSelect}
            onRefine={handleRefineDirections}
            isRefining={isRefiningDirections}
          />
        )}

        {isReviewingResearch && (
          <ResearchReview
            topic={projectData.topic}
            researchDocuments={projectData.researchDocuments}
            options={projectData.options}
            onApprove={handleApproveResearch}
            isLoading={isGeneratingDirections}
          />
        )}

        {isReviewing && projectData.outline && projectData.selectedDirection && (
          <OutlineReview
            outline={projectData.outline}
            direction={projectData.selectedDirection}
            ammoLibrary={projectData.ammoLibrary}
            onApprove={handleApproveOutline}
            onRefine={handleRefineOutline}
            onUpdateOutline={(outline) => setProjectData((prev) => ({ ...prev, outline }))}
            isRefining={isRefiningOutline}
          />
        )}

        {isError && (
          <div className="mx-auto mt-20 max-w-xl rounded-2xl border border-red-100 bg-red-50 p-8 text-center text-red-900 shadow-lg">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <span className="text-2xl">!</span>
            </div>
            <h3 className="mb-2 text-xl font-bold">流程中断</h3>
            <p className="mb-4 text-red-700 opacity-80">{genState.message}</p>
            {genState.details && (
              <div className="mb-8 rounded-xl border border-red-100 bg-white/80 p-4 text-left">
                <p className="mb-2 text-xs font-bold uppercase tracking-wider text-red-500">Technical Details</p>
                <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed text-red-900">
                  {genState.details}
                </pre>
              </div>
            )}
            <button
              onClick={handleReset}
              className="rounded-lg border border-red-200 bg-white px-6 py-2 text-sm font-bold transition-colors hover:bg-red-50"
            >
              重新开始
            </button>
          </div>
        )}

        {isCompleted && (
          <ArticleViewer
            data={projectData}
            onReset={handleReset}
            onUpdateArticleContent={(articleContent) => setProjectData((prev) => ({ ...prev, articleContent }))}
            onUpdateTeachingNotes={(teachingNotes) => setProjectData((prev) => ({ ...prev, teachingNotes }))}
          />
        )}
      </main>
    </div>
  );
};

export default App;
