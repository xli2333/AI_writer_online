export const DEFAULT_STYLE_PROFILE_ID = 'fdsm';

export const STYLE_PROFILES = [
  {
    id: 'fdsm',
    label: '复旦商业文章',
    shortLabel: 'FDSM',
    description: '偏管理学、商业分析、学术转译与案例拆解的中文商业写作风格。',
    rawDir: 'raw_materials',
    ragDir: 'rag_assets',
    globalDir: 'rag_assets/global',
    runtimeDir: 'rag_assets/global/runtime',
    metadataDir: 'rag_assets/metadata',
    summariesDir: 'rag_assets/summaries/per_article',
    personaDir: 'rag_assets/persona',
    evalDir: 'rag_assets/evals',
    benchmarkDir: 'rag_assets/evals/benchmark_tasks',
  },
  {
    id: 'latepost',
    label: '晚点 LatePost',
    shortLabel: 'LatePost',
    description: '偏商业报道、公司观察、独家信息与人物/组织叙事的中文商业写作风格。',
    rawDir: 'style_corpora/latepost/raw_materials',
    ragDir: 'rag_assets/profiles/latepost',
    globalDir: 'rag_assets/profiles/latepost/global',
    runtimeDir: 'rag_assets/profiles/latepost/global/runtime',
    metadataDir: 'rag_assets/profiles/latepost/metadata',
    summariesDir: 'rag_assets/profiles/latepost/summaries/per_article',
    personaDir: 'rag_assets/profiles/latepost/persona',
    evalDir: 'rag_assets/profiles/latepost/evals',
    benchmarkDir: 'rag_assets/profiles/latepost/evals/benchmark_tasks',
  },
  {
    id: 'xinzhiyuan',
    label: '新智元',
    shortLabel: 'XinZhiYuan',
    description: '偏 AI 前沿快讯、论文拆解、模型产品观察与产业人物叙事的中文科技媒体写作风格。',
    rawDir: 'style_corpora/xinzhiyuan/raw_materials',
    ragDir: 'rag_assets/profiles/xinzhiyuan',
    globalDir: 'rag_assets/profiles/xinzhiyuan/global',
    runtimeDir: 'rag_assets/profiles/xinzhiyuan/global/runtime',
    metadataDir: 'rag_assets/profiles/xinzhiyuan/metadata',
    summariesDir: 'rag_assets/profiles/xinzhiyuan/summaries/per_article',
    personaDir: 'rag_assets/profiles/xinzhiyuan/persona',
    evalDir: 'rag_assets/profiles/xinzhiyuan/evals',
    benchmarkDir: 'rag_assets/profiles/xinzhiyuan/evals/benchmark_tasks',
  },
  {
    id: 'huxiu',
    label: '虎嗅 Huxiu',
    shortLabel: 'Huxiu',
    description: '偏商业观察、科技产业攻防、消费公司拆解、人物深描与社会情绪观察的中文媒体写作风格。',
    rawDir: 'style_corpora/huxiu/raw_materials',
    ragDir: 'rag_assets/profiles/huxiu',
    globalDir: 'rag_assets/profiles/huxiu/global',
    runtimeDir: 'rag_assets/profiles/huxiu/global/runtime',
    metadataDir: 'rag_assets/profiles/huxiu/metadata',
    summariesDir: 'rag_assets/profiles/huxiu/summaries/per_article',
    personaDir: 'rag_assets/profiles/huxiu/persona',
    evalDir: 'rag_assets/profiles/huxiu/evals',
    benchmarkDir: 'rag_assets/profiles/huxiu/evals/benchmark_tasks',
  },
  {
    id: 'wallstreetcn',
    label: '华尔街见闻',
    shortLabel: 'WallstreetCN',
    description: '偏宏观政策传导、市场定价、机构策略解读与公司资本故事的中文财经媒体写作风格。',
    rawDir: 'style_corpora/wallstreetcn/raw_materials',
    ragDir: 'rag_assets/profiles/wallstreetcn',
    globalDir: 'rag_assets/profiles/wallstreetcn/global',
    runtimeDir: 'rag_assets/profiles/wallstreetcn/global/runtime',
    metadataDir: 'rag_assets/profiles/wallstreetcn/metadata',
    summariesDir: 'rag_assets/profiles/wallstreetcn/summaries/per_article',
    personaDir: 'rag_assets/profiles/wallstreetcn/persona',
    evalDir: 'rag_assets/profiles/wallstreetcn/evals',
    benchmarkDir: 'rag_assets/profiles/wallstreetcn/evals/benchmark_tasks',
  },
];

export const STYLE_PROFILE_MAP = Object.fromEntries(STYLE_PROFILES.map((profile) => [profile.id, profile]));

export const resolveStyleProfileId = (profileId) => {
  const normalized = String(profileId || '').trim().toLowerCase();
  return STYLE_PROFILE_MAP[normalized]?.id || DEFAULT_STYLE_PROFILE_ID;
};

export const getStyleProfile = (profileId) => STYLE_PROFILE_MAP[resolveStyleProfileId(profileId)];

export const getPublicStyleProfiles = () =>
  STYLE_PROFILES.map(({ id, label, shortLabel, description }) => ({
    id,
    label,
    shortLabel,
    description,
  }));
