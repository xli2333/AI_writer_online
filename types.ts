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

export type ArticleIllustrationProgressPhase = 'queued' | 'planning' | 'rendering' | 'finalizing' | 'ready' | 'error' | 'canceled';
export type ArticleIllustrationProgressActivity =
  | 'planning'
  | 'rendering_image'
  | 'captioning'
  | 'finalizing'
  | 'ready'
  | 'error'
  | 'canceled';

export interface ArticleIllustrationProgress {
  phase: ArticleIllustrationProgressPhase;
  activity?: ArticleIllustrationProgressActivity;
  currentStep: string;
  completedCount: number;
  totalCount: number;
  currentItemIndex?: number;
  currentSlotId?: string;
  currentSlotOrder?: number;
  currentSlotTitle?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ArticleIllustrationStyleReferenceImage {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
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
  imageCountPrompt?: string;
  styleReferenceImage?: ArticleIllustrationStyleReferenceImage;
  status: 'idle' | 'planning' | 'rendering' | 'ready' | 'partial' | 'error' | 'canceled';
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
  runId?: string;
  status: ArticleIllustrationProgressPhase;
  activity?: ArticleIllustrationProgressActivity;
  currentStep: string;
  completedCount: number;
  totalCount: number;
  currentItemIndex?: number;
  currentSlotId?: string;
  currentSlotOrder?: number;
  currentSlotTitle?: string;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
}

export type WechatTemplateId =
  | 'latepost_report'
  | 'insight_brief'
  | 'warm_column'
  | 'bauhaus'
  | 'knowledge_base'
  | 'morandi_forest'
  | 'neo_brutalism'
  | 'receipt'
  | 'sunset_film'
  | 'capital_review';

export type WechatDraftStatus = 'idle' | 'preview_ready' | 'draft_ready' | 'publishing' | 'published' | 'error';

export type WechatCreditsVariant = 'stacked_labels' | 'minimal_labels' | 'inline_meta_bar';

export type WechatHeadingVariant =
  | 'chapter_marker'
  | 'red_bar'
  | 'underline'
  | 'plain'
  | 'section_band'
  | 'accent_tag'
  | 'number_badge';

export type WechatParagraphVariant = 'body' | 'lead' | 'callout' | 'closing' | 'spotlight' | 'compact' | 'data_callout';

export type WechatQuoteVariant = 'editorial_quote' | 'plain_quote' | 'accent_panel' | 'centered_pull';

export type WechatListVariant = 'bullet_brief' | 'numbered_steps' | 'plain_list' | 'check_grid' | 'card_list';

export type WechatTableVariant = 'data_grid' | 'compact_grid' | 'matrix_panel' | 'minimal_rows';

export type WechatImageVariant = 'full_bleed' | 'editorial_card' | 'caption_focus' | 'shadow_card' | 'caption_band' | 'border_frame';

export type WechatHighlightVariant = 'marker' | 'underline' | 'ink' | 'accent_bar';

export interface WechatBlockVariantSelection<TVariant extends string> {
  blockIndex: number;
  variant: TVariant;
}

export interface WechatHighlightSelection {
  blockIndex: number;
  text: string;
  variant: WechatHighlightVariant;
}

export interface WechatBeautyAgentInfo {
  used: boolean;
  model?: string;
  fallbackReason?: string;
  planHash?: string;
}

export interface WechatRenderPlan {
  creditsVariant: WechatCreditsVariant;
  headingStyles: Array<WechatBlockVariantSelection<WechatHeadingVariant>>;
  paragraphStyles: Array<WechatBlockVariantSelection<WechatParagraphVariant>>;
  quoteStyles: Array<WechatBlockVariantSelection<WechatQuoteVariant>>;
  listStyles: Array<WechatBlockVariantSelection<WechatListVariant>>;
  tableStyles: Array<WechatBlockVariantSelection<WechatTableVariant>>;
  imageStyles: Array<WechatBlockVariantSelection<WechatImageVariant>>;
  highlightSentences: WechatHighlightSelection[];
  dividerAfterBlocks: number[];
  beautyAgent: WechatBeautyAgentInfo;
}

export interface WechatStyleReferenceImage {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface WechatLayoutSettings {
  templateId: WechatTemplateId;
  author: string;
  editor?: string;
  creditLines?: string[];
  digest: string;
  contentSourceUrl: string;
  coverStrategy: 'hero' | 'first_ready' | 'manual';
  preferredCoverAssetId?: string;
  openingHighlightMode: 'off' | 'first_sentence' | 'smart_lead';
  needOpenComment: boolean;
  onlyFansCanComment: boolean;
  artDirectionPrompt?: string;
  styleReferenceImages?: WechatStyleReferenceImage[];
}

export interface WechatDraftRecord {
  status: WechatDraftStatus;
  mediaId?: string;
  publishId?: string;
  articleUrl?: string;
  templateId?: WechatTemplateId;
  draftTitle?: string;
  coverAssetId?: string;
  draftUpdatedAt?: string;
  publishedAt?: string;
  warnings?: string[];
  error?: string;
}

export interface WechatPublisherConfigStatus {
  configured: boolean;
  appIdPresent: boolean;
  appSecretPresent: boolean;
  defaultAuthor: string;
  defaultTemplateId: WechatTemplateId;
  publishEnabled: boolean;
  missingKeys?: string[];
}

export interface WechatPreviewMetadata {
  templateId: WechatTemplateId;
  rendererVersion?: string;
  title: string;
  author: string;
  editor?: string;
  digest: string;
  contentSourceUrl?: string;
  coverAssetId?: string;
  coverImageUrl?: string;
  imageCount: number;
  blockCount: number;
  warnings?: string[];
  renderPlan?: WechatRenderPlan;
  beautyAgent?: WechatBeautyAgentInfo;
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
  wechatLayout?: WechatLayoutSettings;
  wechatDraft?: WechatDraftRecord;
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
