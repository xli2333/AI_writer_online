declare module '*.md?raw' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_BACKEND_ORIGIN?: string;
  readonly VITE_WECHAT_DRAFT_PASSWORD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
