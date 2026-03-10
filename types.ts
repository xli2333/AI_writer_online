export enum GenerationStep {
  IDLE = 'IDLE',
  RESEARCHING = 'RESEARCHING',
  REVIEWING_RESEARCH = 'REVIEWING_RESEARCH',
  SELECTING_DIRECTION = 'SELECTING_DIRECTION',
  REVIEWING_OUTLINE = 'REVIEWING_OUTLINE',
  WRITING = 'WRITING',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

export type WorkflowSnapshotType =
  | 'research_ready'
  | 'directions_ready'
  | 'outline_ready'
  | 'chunk_plan_ready'
  | 'chunk_draft'
  | 'draft_assembled'
  | 'draft_editorial'
  | 'final_article'
  | 'teaching_notes';

export type WorkflowResumeAction =
  | 'review_research'
  | 'review_outline'
  | 'continue_from_chunks'
  | 'continue_from_draft'
  | 'continue_teaching_notes'
  | 'view_only';

export interface SearchSource {
  title: string;
  uri: string;
  snippet?: string;
  track?: string;
}

export interface UploadedFile {
  name: string;
  mimeType: string;
  data: string;
  isText: boolean;
}

export interface ResearchDocument {
  id: string;
  title: string;
  content: string;
}

export interface WritingTaskOptions {
  styleProfile: string;
  genre: string;
  style: string;
  audience: string;
  articleGoal: string;
  desiredLength: number;
  chunkLength: number;
  includeTeachingNotes: boolean;
  enableDeepResearch: boolean;
  deepResearchPrompt: string;
}

export interface StyleProfileDescriptor {
  id: string;
  label: string;
  shortLabel: string;
  description: string;
}

export interface SubPersonaDescriptor {
  id: string;
  label: string;
  description: string;
}

export interface PersonaStatusDescriptor {
  profileId: string;
  versionLabel: string;
  personaUpdatedAt?: string;
  personaSourceCount: number;
  lastEvolutionAt?: string;
  lastPatchAppliedAt?: string;
  lastPatchWinRate?: number;
  lastEvolutionPassed?: boolean;
  benchmarkTaskCount: number;
  antiPatternCount: number;
  subPersonas: SubPersonaDescriptor[];
}

export type ArticleIllustrationRole =
  | 'hero'
  | 'main_question'
  | 'core_argument'
  | 'key_case'
  | 'person'
  | 'organization'
  | 'industry_context'
  | 'process_mechanism'
  | 'outcome'
  | 'data_chart';

export type ArticleIllustrationRenderMode = 'nanobanana_pro' | 'svg_chart' | 'mock_svg';

export type ArticleIllustrationChartType = 'comparison_bar' | 'metric_grid' | 'timeline';

export interface ArticleIllustrationDataPoint {
  label: string;
  value: number;
  displayValue: string;
  unit?: string;
  note?: string;
}

export interface ArticleIllustrationDataSpec {
  chartType: ArticleIllustrationChartType;
  title: string;
  insight: string;
  unit?: string;
  points: ArticleIllustrationDataPoint[];
}

export interface ArticleIllustrationVisualSystem {
  collectionTitle: string;
  profileLabel: string;
  visualDirection: string;
  palette: string[];
  realismLevel: string;
  compositionRules: string[];
  moodKeywords: string[];
  chartStyle: string;
  consistencyRules: string[];
  lighting: string;
  texture: string;
  negativeRules: string[];
}

export interface ArticleIllustrationSlot {
  id: string;
  order: number;
  role: ArticleIllustrationRole;
  renderMode: ArticleIllustrationRenderMode;
  title: string;
  sectionTitle: string;
  purpose: string;
  explanation: string;
  anchorExcerpt: string;
  focusTerms: string[];
  qualityChecks: string[];
  prompt: string;
  negativePrompt: string;
  anchorParagraphIndex: number;
  anchorParagraphRange?: [number, number];
  activeAssetId?: string;
  versionCount?: number;
  lastUserPrompt?: string;
  dataSpec?: ArticleIllustrationDataSpec;
  status: 'planned' | 'rendering' | 'ready' | 'error';
  assetUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  error?: string;
}

export interface ArticleIllustrationAsset {
  id: string;
  slotId: string;
  role: ArticleIllustrationRole;
  renderMode: ArticleIllustrationRenderMode;
  title: string;
  url: string;
  mimeType: string;
  width: number;
  height: number;
  versionIndex: number;
  createdAt: string;
  userPrompt?: string;
  editorCaption?: string;
}

export type ArticleIllustrationProgressPhase = 'queued' | 'planning' | 'rendering' | 'finalizing' | 'ready' | 'error';

export interface ArticleIllustrationProgress {
  phase: ArticleIllustrationProgressPhase;
  currentStep: string;
  completedCount: number;
  totalCount: number;
  currentSlotId?: string;
  currentSlotOrder?: number;
  currentSlotTitle?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ArticleIllustrationBundle {
  promptVersion: string;
  sourceHash: string;
  articleHash: string;
  articleTitle: string;
  styleProfile: string;
  model: string;
  wordCount: number;
  targetImageCount: number;
  globalUserPrompt?: string;
  status: 'idle' | 'planning' | 'rendering' | 'ready' | 'partial' | 'error';
  generatedAt?: string;
  updatedAt?: string;
  visualSystem: ArticleIllustrationVisualSystem;
  slots: ArticleIllustrationSlot[];
  assets: ArticleIllustrationAsset[];
  assetVersions: Record<string, ArticleIllustrationAsset[]>;
  progress?: ArticleIllustrationProgress;
  warnings?: string[];
  error?: string;
}

export interface ArticleIllustrationJobStatus {
  sourceHash: string;
  status: ArticleIllustrationProgressPhase;
  currentStep: string;
  completedCount: number;
  totalCount: number;
  currentSlotId?: string;
  currentSlotOrder?: number;
  currentSlotTitle?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface WritingChunkPlanItem {
  index: number;
  title: string;
  sections: string[];
  targetLength: number;
  purpose: string;
}

export interface ReferenceTemplateArticle {
  id: string;
  title: string;
  date?: string;
  styleProfile?: string;
  genre?: string;
  style?: string[];
  summary?: string;
  structurePattern?: string;
  openingPattern?: string;
  endingPattern?: string;
  coreArgument?: string;
  relativePath?: string;
  fullText?: string;
  whySelected?: string;
  score?: number;
  stylePurityScore?: number;
}

export interface WritingProjectData {
  topic: string;
  sources: SearchSource[];
  ammoLibrary: string;
  researchDocuments: ResearchDocument[];
  referenceArticles: ReferenceTemplateArticle[];
  directions: string[];
  selectedDirection?: string;
  outline?: string;
  writingInsights?: string;
  evidenceCards?: string;
  chunkPlan?: WritingChunkPlanItem[];
  chunkDrafts?: string[];
  assembledDraft?: string;
  workingArticleDraft?: string;
  critique?: string;
  articleContent?: string;
  teachingNotes?: string;
  illustrationBundle?: ArticleIllustrationBundle;
  workflowSnapshots?: WorkflowSnapshot[];
  activeSnapshotId?: string;
  options: WritingTaskOptions;
}

export type WorkflowSnapshotProjectData = Omit<WritingProjectData, 'workflowSnapshots' | 'activeSnapshotId'>;

export interface WorkflowSnapshot {
  id: string;
  type: WorkflowSnapshotType;
  label: string;
  description: string;
  createdAt: string;
  restoreStep: GenerationStep;
  resumeAction: WorkflowResumeAction;
  sourceChunkIndex?: number;
  projectData: WorkflowSnapshotProjectData;
}

export interface GenerationState {
  step: GenerationStep;
  progress: number;
  message: string;
  details?: string;
}
