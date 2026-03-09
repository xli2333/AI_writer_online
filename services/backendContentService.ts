import type { PersonaStatusDescriptor, StyleProfileDescriptor, WritingTaskOptions } from '../types';

export interface RuntimePromptAssets {
  masterPersona: string;
  antiAiStyleRules: string;
  commercialHumanizerRules: string;
  commercialHumanizerPatterns: string;
  commercialHumanizerQuickChecks: string;
  profileAntiPatterns: string;
  latepostNewsPersona?: string;
  latepostFeaturePersona?: string;
  latepostProfilePersona?: string;
  latepostIndustryReviewPersona?: string;
}

interface PromptAssetPayload {
  assets?: Record<string, string>;
}

interface CatalogPayload {
  catalog?: Record<string, unknown>[];
}

interface FullTextPayload {
  articles?: Array<{
    relativePath?: string;
    fullText?: string;
  }>;
}

interface StyleProfilesPayload {
  profiles?: StyleProfileDescriptor[];
}

interface PersonaStatusPayload {
  status?: PersonaStatusDescriptor;
}

const DEFAULT_PROMPT_ASSET_NAMES = [
  'masterPersona',
  'antiAiStyleRules',
  'commercialHumanizerRules',
  'commercialHumanizerPatterns',
  'commercialHumanizerQuickChecks',
  'profileAntiPatterns',
] as const;

const PROFILE_PROMPT_ASSET_NAMES: Record<string, string[]> = {
  latepost: [
    'latepostNewsPersona',
    'latepostFeaturePersona',
    'latepostProfilePersona',
    'latepostIndustryReviewPersona',
  ],
};

const fetchJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Backend request failed: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
};

const runtimePromptAssetsPromises = new Map<string, Promise<RuntimePromptAssets>>();
const referenceCatalogPromises = new Map<string, Promise<Record<string, unknown>[]>>();
const personaStatusPromises = new Map<string, Promise<PersonaStatusDescriptor>>();
let styleProfilesPromise: Promise<StyleProfileDescriptor[]> | null = null;

export const loadRuntimePromptAssets = async (profile = 'fdsm'): Promise<RuntimePromptAssets> => {
  if (!runtimePromptAssetsPromises.has(profile)) {
    const names = [...DEFAULT_PROMPT_ASSET_NAMES, ...(PROFILE_PROMPT_ASSET_NAMES[profile] || [])].join(',');
    runtimePromptAssetsPromises.set(
      profile,
      fetchJson<PromptAssetPayload>(
        `/api/content/prompt-assets?profile=${encodeURIComponent(profile)}&names=${encodeURIComponent(names)}`
      ).then((payload) => {
        const assets = payload.assets || {};
        return {
          masterPersona: String(assets.masterPersona || '').trim(),
          antiAiStyleRules: String(assets.antiAiStyleRules || '').trim(),
          commercialHumanizerRules: String(assets.commercialHumanizerRules || '').trim(),
          commercialHumanizerPatterns: String(assets.commercialHumanizerPatterns || '').trim(),
          commercialHumanizerQuickChecks: String(assets.commercialHumanizerQuickChecks || '').trim(),
          profileAntiPatterns: String(assets.profileAntiPatterns || '').trim(),
          latepostNewsPersona: String(assets.latepostNewsPersona || '').trim(),
          latepostFeaturePersona: String(assets.latepostFeaturePersona || '').trim(),
          latepostProfilePersona: String(assets.latepostProfilePersona || '').trim(),
          latepostIndustryReviewPersona: String(assets.latepostIndustryReviewPersona || '').trim(),
        };
      })
    );
  }

  return runtimePromptAssetsPromises.get(profile)!;
};

export const loadStyleProfiles = async () => {
  if (!styleProfilesPromise) {
    styleProfilesPromise = fetchJson<StyleProfilesPayload>('/api/content/style-profiles').then((payload) =>
      Array.isArray(payload.profiles) ? payload.profiles : []
    );
  }

  return styleProfilesPromise;
};

export const loadPersonaStatus = async (profile = 'fdsm') => {
  if (!personaStatusPromises.has(profile)) {
    personaStatusPromises.set(
      profile,
      fetchJson<PersonaStatusPayload>(`/api/content/persona-status?profile=${encodeURIComponent(profile)}`).then(
        (payload) =>
          payload.status || {
            profileId: profile,
            versionLabel: 'unknown',
            personaSourceCount: 0,
            benchmarkTaskCount: 0,
            antiPatternCount: 0,
            subPersonas: [],
          }
      )
    );
  }

  return personaStatusPromises.get(profile)!;
};

export const loadReferenceTemplateCatalog = async (profile = 'fdsm') => {
  if (!referenceCatalogPromises.has(profile)) {
    referenceCatalogPromises.set(
      profile,
      fetchJson<CatalogPayload>(`/api/reference-templates/catalog?profile=${encodeURIComponent(profile)}`).then(
        (payload) => payload.catalog || []
      )
    );
  }

  return referenceCatalogPromises.get(profile)!;
};

export const loadReferenceTemplateFullTexts = async (profile: string, relativePaths: string[]) => {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    return new Map<string, string>();
  }

  const payload = await fetchJson<FullTextPayload>('/api/reference-templates/full-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, relativePaths }),
  });

  return new Map(
    (payload.articles || []).map((article) => [String(article.relativePath || ''), String(article.fullText || '')])
  );
};

export const buildTaskLookupText = (topic: string, direction: string, options: WritingTaskOptions) =>
  [topic, direction, options.styleProfile, options.genre, options.style, options.audience, options.articleGoal]
    .filter(Boolean)
    .join(' ');
