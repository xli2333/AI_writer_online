import coreWritingSkillsRaw from '../rag_assets/global/core_writing_skills.md?raw';
import universalPromptRaw from '../rag_assets/global/universal_prompt.md?raw';
import workflowRaw from '../rag_assets/workflows/ai_writing_workflow.md?raw';
import taskBriefTemplateRaw from '../rag_assets/workflows/task_brief_template.md?raw';
import { WritingTaskOptions } from '../types';

const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();

export const promptAssets = {
  coreWritingSkills: normalize(coreWritingSkillsRaw),
  universalPrompt: normalize(universalPromptRaw),
  workflow: normalize(workflowRaw),
  taskBriefTemplate: normalize(taskBriefTemplateRaw),
};

export const buildTaskBrief = (topic: string, direction: string, options: WritingTaskOptions) => {
  const lines = [
    `写作主题：${topic}`,
    `讨论方向：${direction}`,
    `风格库：${options.styleProfile || 'fdsm'}`,
    `文体：${options.genre}`,
    `风格：${options.style}`,
    `目标受众：${options.audience}`,
    `文章目标：${options.articleGoal}`,
    options.desiredLength > 0 ? `目标字数：约 ${options.desiredLength} 字` : '',
    options.chunkLength > 0 ? `单轮写作长度：约 ${options.chunkLength} 字` : '',
    `是否生成 TN：${options.includeTeachingNotes ? '是' : '否'}`,
    `是否启用 Deep Research：${options.enableDeepResearch ? '是' : '否'}`,
  ].filter(Boolean);

  if (options.enableDeepResearch && options.deepResearchPrompt.trim()) {
    lines.push(`Deep Research 提示词：${options.deepResearchPrompt.trim()}`);
  }

  return lines.join('\n');
};
