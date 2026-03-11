import type { SubPersonaDescriptor, WritingTaskOptions } from '../types';

export type RuntimeSubPersonaId =
  | ''
  | 'latepostNewsPersona'
  | 'latepostFeaturePersona'
  | 'latepostProfilePersona'
  | 'latepostIndustryReviewPersona'
  | 'xinzhiyuanBreakingPersona'
  | 'xinzhiyuanPaperPersona'
  | 'xinzhiyuanProductPersona'
  | 'xinzhiyuanPeoplePersona';

export const LATEPOST_SUB_PERSONAS: SubPersonaDescriptor[] = [
  {
    id: 'latepostNewsPersona',
    label: '快讯与组织变动',
    description: '适合独家信息、组织调整、业务变化和关键事件报道。',
  },
  {
    id: 'latepostFeaturePersona',
    label: '公司深描',
    description: '适合公司观察、业务拆解和组织机制型长文。',
  },
  {
    id: 'latepostProfilePersona',
    label: '人物与公司',
    description: '适合人物切口、管理者判断与人物-组织绑定稿。',
  },
  {
    id: 'latepostIndustryReviewPersona',
    label: '行业复盘',
    description: '适合趋势评论、行业终局判断与赛道格局稿。',
  },
];

export const XINZHIYUAN_SUB_PERSONAS: SubPersonaDescriptor[] = [
  {
    id: 'xinzhiyuanBreakingPersona',
    label: '快讯与前沿动态',
    description: '适合模型发布、行业热点、组织动作与高时效 AI 快讯。',
  },
  {
    id: 'xinzhiyuanPaperPersona',
    label: '论文与基准拆解',
    description: '适合论文解读、实验结果、技术路线与 benchmark 对比稿。',
  },
  {
    id: 'xinzhiyuanProductPersona',
    label: '产品与工具实测',
    description: '适合模型体验、Agent 工具、产品发布与上手评测稿。',
  },
  {
    id: 'xinzhiyuanPeoplePersona',
    label: '人物与团队观察',
    description: '适合研究者、创业团队、实验室与关键人物稿。',
  },
];

const includesAny = (value: string, fragments: string[]) => fragments.some((fragment) => value.includes(fragment));

export const resolveRuntimeSubPersona = (
  options?: Partial<Pick<WritingTaskOptions, 'styleProfile' | 'genre' | 'style' | 'articleGoal'>>
): RuntimeSubPersonaId => {
  const profile = String(options?.styleProfile || 'fdsm');

  const genre = String(options?.genre || '');
  const style = String(options?.style || '');
  const goal = String(options?.articleGoal || '');
  const combined = `${genre} ${style} ${goal}`;

  if (profile === 'latepost') {
    if (includesAny(combined, ['人物', '创始人', '管理者', '企业家'])) {
      return 'latepostProfilePersona';
    }

    if (includesAny(combined, ['趋势', '赛道', '行业评论', '行业复盘', '行业判断'])) {
      return 'latepostIndustryReviewPersona';
    }

    if (includesAny(combined, ['独家', '组织', '调整', '高管', '裁员', '架构', '财报', '快讯', '媒体型'])) {
      return 'latepostNewsPersona';
    }

    return 'latepostFeaturePersona';
  }

  if (profile === 'xinzhiyuan') {
    if (includesAny(combined, ['论文', '研究', '实验', '基准', 'benchmark', 'arxiv', '算法', '训练', '推理', '开源'])) {
      return 'xinzhiyuanPaperPersona';
    }

    if (includesAny(combined, ['人物', '团队', '创始人', '创业者', 'ceo', '科学家', '研究员', '实验室', '校友'])) {
      return 'xinzhiyuanPeoplePersona';
    }

    if (
      includesAny(combined, [
        '产品',
        '工具',
        '实测',
        '上手',
        '体验',
        'agent',
        '应用',
        '编程',
        '插件',
        '工作流',
        'demo',
        '开箱',
      ])
    ) {
      return 'xinzhiyuanProductPersona';
    }

    return 'xinzhiyuanBreakingPersona';
  }

  return '';
};

export const getRuntimeSubPersonaDescriptor = (subPersonaId: RuntimeSubPersonaId) =>
  [...LATEPOST_SUB_PERSONAS, ...XINZHIYUAN_SUB_PERSONAS].find((item) => item.id === subPersonaId);
