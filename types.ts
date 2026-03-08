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
