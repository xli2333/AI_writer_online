import type { SubPersonaDescriptor, WritingTaskOptions } from '../types';

export type RuntimeSubPersonaId =
  | ''
  | 'latepostNewsPersona'
  | 'latepostFeaturePersona'
  | 'latepostProfilePersona'
  | 'latepostIndustryReviewPersona';

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

const includesAny = (value: string, fragments: string[]) => fragments.some((fragment) => value.includes(fragment));

export const resolveRuntimeSubPersona = (
  options?: Partial<Pick<WritingTaskOptions, 'styleProfile' | 'genre' | 'style' | 'articleGoal'>>
): RuntimeSubPersonaId => {
  if (String(options?.styleProfile || 'fdsm') !== 'latepost') {
    return '';
  }

  const genre = String(options?.genre || '');
  const style = String(options?.style || '');
  const goal = String(options?.articleGoal || '');
  const combined = `${genre} ${style} ${goal}`;

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
};

export const getRuntimeSubPersonaDescriptor = (subPersonaId: RuntimeSubPersonaId) =>
  LATEPOST_SUB_PERSONAS.find((item) => item.id === subPersonaId);
