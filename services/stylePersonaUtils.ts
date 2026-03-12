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
  | 'xinzhiyuanPeoplePersona'
  | 'huxiuIndustryPersona'
  | 'huxiuConsumerPersona'
  | 'huxiuProfilePersona'
  | 'huxiuSocietyPersona'
  | 'wallstreetcnMacroPersona'
  | 'wallstreetcnMarketsPersona'
  | 'wallstreetcnCompanyPersona'
  | 'wallstreetcnStrategyPersona';

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

export const HUXIU_SUB_PERSONAS: SubPersonaDescriptor[] = [
  {
    id: 'huxiuIndustryPersona',
    label: '科技与产业攻防',
    description: '适合平台竞争、大厂战略、AI 与产业链攻防类写作。',
  },
  {
    id: 'huxiuConsumerPersona',
    label: '商业消费拆解',
    description: '适合品牌、零售、门店、渠道与消费公司分析稿。',
  },
  {
    id: 'huxiuProfilePersona',
    label: '人物与公司深描',
    description: '适合创始人、管理者、公司内幕和人物驱动稿。',
  },
  {
    id: 'huxiuSocietyPersona',
    label: '社会情绪观察',
    description: '适合职场、城市、代际、青年文化与情绪观察稿。',
  },
];

export const WALLSTREETCN_SUB_PERSONAS: SubPersonaDescriptor[] = [
  {
    id: 'wallstreetcnMacroPersona',
    label: '宏观与政策传导',
    description: '适合央行、通胀、财政、关税、增长与地缘冲击的宏观解读稿。',
  },
  {
    id: 'wallstreetcnMarketsPersona',
    label: '市场与资产定价',
    description: '适合股债汇商品加密等跨资产波动、交易逻辑和市场定价稿。',
  },
  {
    id: 'wallstreetcnCompanyPersona',
    label: '公司与资本故事',
    description: '适合财报、并购、行业龙头、资本开支与公司竞争格局稿。',
  },
  {
    id: 'wallstreetcnStrategyPersona',
    label: '策略与交易前瞻',
    description: '适合机构观点、情景推演、周度日程和交易手册型写作。',
  },
];

const includesAny = (value: string, fragments: string[]) => fragments.some((fragment) => value.includes(fragment));

export const resolveRuntimeSubPersona = (
  options?: Partial<Pick<WritingTaskOptions, 'styleProfile' | 'genre' | 'style' | 'articleGoal'>>
): RuntimeSubPersonaId => {
  const profile = String(options?.styleProfile || 'fdsm');
  const genre = String(options?.genre || '').toLowerCase();
  const style = String(options?.style || '').toLowerCase();
  const goal = String(options?.articleGoal || '').toLowerCase();
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

  if (profile === 'huxiu') {
    if (includesAny(combined, ['人物', '创始人', '管理者', 'ceo', '企业家', '对话', '专访', '访谈'])) {
      return 'huxiuProfilePersona';
    }

    if (includesAny(combined, ['中产', '年轻人', '职场', '城市', '代际', '情绪', '社会', '生活方式'])) {
      return 'huxiuSocietyPersona';
    }

    if (includesAny(combined, ['消费', '品牌', '零售', '餐饮', '门店', '上市', '电商', '渠道', '茶饮', '咖啡'])) {
      return 'huxiuConsumerPersona';
    }

    if (includesAny(combined, ['ai', '科技', '芯片', '大厂', '平台', '互联网', '算力', '自动驾驶', '机器人', '组织', '架构'])) {
      return 'huxiuIndustryPersona';
    }

    return 'huxiuIndustryPersona';
  }

  if (profile === 'wallstreetcn') {
    if (
      includesAny(combined, [
        '日程',
        '前瞻',
        '策略',
        '配置',
        '交易手册',
        '情景',
        '展望',
        '路线图',
        '预判',
        '仓位',
      ])
    ) {
      return 'wallstreetcnStrategyPersona';
    }

    if (
      includesAny(combined, [
        '美联储',
        '央行',
        '通胀',
        'cpi',
        'ppi',
        'pmi',
        'gdp',
        '财政',
        '关税',
        '衰退',
        '就业',
        '宏观',
        '政策',
        '债务',
        '地缘',
      ])
    ) {
      return 'wallstreetcnMacroPersona';
    }

    if (
      includesAny(combined, [
        '公司',
        '财报',
        '业绩',
        '估值',
        '并购',
        '创始人',
        'ceo',
        '资本开支',
        '龙头',
        '产业链',
        '车企',
        '芯片',
        '云',
        '平台',
      ])
    ) {
      return 'wallstreetcnCompanyPersona';
    }

    if (
      includesAny(combined, [
        '美股',
        'a股',
        '港股',
        '美债',
        '美元',
        '黄金',
        '原油',
        '比特币',
        '汇率',
        '商品',
        '期货',
        '市场',
        '波动',
        '交易',
        '资产',
      ])
    ) {
      return 'wallstreetcnMarketsPersona';
    }

    return 'wallstreetcnMarketsPersona';
  }

  return '';
};

export const getRuntimeSubPersonaDescriptor = (subPersonaId: RuntimeSubPersonaId) =>
  [...LATEPOST_SUB_PERSONAS, ...XINZHIYUAN_SUB_PERSONAS, ...HUXIU_SUB_PERSONAS, ...WALLSTREETCN_SUB_PERSONAS].find(
    (item) => item.id === subPersonaId
  );
