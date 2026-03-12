const normalizeOrigin = (value?: string) => {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  return normalized || '';
};

const runtimeBackendOrigin = normalizeOrigin(import.meta.env.VITE_BACKEND_ORIGIN);
const shouldUseSameOriginProxy = () =>
  typeof window !== 'undefined' && /\.vercel\.app$/i.test(window.location.hostname);

export const getBackendOrigin = () => runtimeBackendOrigin;

export const resolveBackendUrl = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:|https?:)/i.test(raw)) return raw;
  if (raw.startsWith('//')) return `${window.location.protocol}${raw}`;
  if (shouldUseSameOriginProxy() && (raw.startsWith('/api/') || raw.startsWith('/generated-assets/'))) {
    return raw;
  }
  if (!runtimeBackendOrigin) return raw;
  return new URL(raw.startsWith('/') ? raw : `/${raw}`, `${runtimeBackendOrigin}/`).toString();
};

export const resolveGeneratedAssetUrl = (value: string) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/generated-assets/')) {
    return resolveBackendUrl(raw);
  }
  return resolveBackendUrl(raw);
};
