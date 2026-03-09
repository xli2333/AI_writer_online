import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightIcon, LockClosedIcon, SparklesIcon } from '@heroicons/react/24/outline';
import {
  formatRuntimeError,
  setStoredGeminiApiKey,
  validateGeminiApiKey,
} from '../services/geminiService';

interface ApiKeyInputProps {
  onKeySet: () => void;
}

export const ApiKeyInput: React.FC<ApiKeyInputProps> = ({ onKeySet }) => {
  const [inputKey, setInputKey] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedKey = inputKey.trim();
    if (!trimmedKey || isValidating) return;

    setErrorMessage('');
    setIsValidating(true);

    try {
      await validateGeminiApiKey(trimmedKey);
      setStoredGeminiApiKey(trimmedKey);
      onKeySet();
    } catch (error) {
      setErrorMessage(`Key 校验失败：${formatRuntimeError(error)}`);
    } finally {
      setIsValidating(false);
    }
  };

  const hasInput = inputKey.trim().length > 0;

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="fixed inset-0 z-[100] flex cursor-text flex-col items-center justify-center overflow-hidden bg-slate-50 selection:bg-teal-100 selection:text-teal-900"
    >
      <div
        className="pointer-events-none absolute left-[-10%] top-[-20%] h-[60%] w-[60%] animate-fade-in rounded-full bg-teal-100/40 blur-[120px] mix-blend-multiply"
        style={{ animationDuration: '3s' }}
      />
      <div
        className="pointer-events-none absolute bottom-[-20%] right-[-10%] h-[60%] w-[60%] animate-fade-in rounded-full bg-amber-100/40 blur-[120px] mix-blend-multiply"
        style={{ animationDuration: '3s', animationDelay: '0.5s' }}
      />

      <div className="relative z-10 flex w-full max-w-5xl flex-col items-center px-8 text-center">
        <div
          className={`transform transition-all duration-1000 ease-out ${
            hasInput ? 'translate-y-[-2vh] scale-90 opacity-60 blur-[1px]' : 'translate-y-0 opacity-100'
          }`}
        >
          <h1 className="mb-2 font-serif text-6xl font-black tracking-tighter text-slate-900 md:text-9xl">
            Writing<span className="text-teal-600">.</span>Workspace
          </h1>
          <p className="font-mono text-sm uppercase tracking-[0.3em] text-slate-400 md:text-base">
            Bring Your Own Gemini API Key
          </p>
        </div>

        <div className="mt-10 max-w-3xl text-sm leading-relaxed text-slate-500 md:text-base">
          这是一个公开部署的 BYOK 工作台。请输入你自己的 Gemini API Key。
          Key 只保存在当前浏览器会话中，用于直接请求 Gemini，不会上传到我们的服务器保存。
        </div>

        <form onSubmit={handleSubmit} className="relative mx-auto mt-16 w-full max-w-2xl group md:mt-20">
          <div className="relative">
            <input
              ref={inputRef}
              type="password"
              value={inputKey}
              onChange={(event) => setInputKey(event.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              className="w-full bg-transparent py-6 text-center font-serif text-3xl tracking-[0.2em] text-slate-800 placeholder-slate-300 outline-none transition-all md:text-5xl"
              placeholder="YOUR GEMINI API KEY"
              autoComplete="off"
              spellCheck="false"
            />

            <div className="absolute bottom-0 left-0 h-[2px] w-full overflow-hidden bg-slate-200/50">
              <div
                className={`h-full bg-slate-900 transition-transform duration-700 ease-out ${
                  isFocused || hasInput ? 'translate-x-0' : '-translate-x-full'
                }`}
              />
            </div>

            <div
              className={`absolute -top-8 left-0 w-full text-center transition-all duration-500 ${
                hasInput ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
              }`}
            >
              <span className="flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest text-teal-600">
                <LockClosedIcon className="h-3 w-3" />
                Session-Only BYOK Access
              </span>
            </div>
          </div>

          {errorMessage && (
            <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-left text-sm leading-relaxed text-rose-700">
              {errorMessage}
            </div>
          )}

          <div
            className={`mt-12 flex flex-col items-center gap-6 transition-all duration-700 ${
              hasInput ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-8 opacity-0'
            }`}
          >
            <button
              type="submit"
              disabled={!hasInput || isValidating}
              className="group relative flex items-center gap-4 rounded-full bg-slate-900 px-10 py-5 text-lg font-bold tracking-wide text-white shadow-2xl transition-all hover:scale-105 hover:bg-teal-700 hover:shadow-teal-900/20 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
            >
              {isValidating ? (
                <>
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
                  <span>校验并进入</span>
                </>
              ) : (
                <>
                  <span>校验并进入</span>
                  <ArrowRightIcon className="h-6 w-6 transition-transform group-hover:translate-x-1" />
                </>
              )}
              <div className="absolute inset-0 rounded-full ring-2 ring-white/20 transition-all group-hover:ring-white/40" />
            </button>
            <p className="font-mono text-xs text-slate-400">Press [ENTER] to validate your key</p>
          </div>
        </form>
      </div>

      <div
        className={`absolute bottom-10 transition-all duration-700 ${
          hasInput ? 'translate-y-10 opacity-0' : 'translate-y-0 opacity-100'
        }`}
      >
        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-3 text-slate-400 transition-colors hover:text-slate-900"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 transition-all group-hover:border-slate-900 group-hover:bg-slate-50">
            <SparklesIcon className="h-4 w-4" />
          </div>
          <span className="border-b border-transparent text-xs font-bold uppercase tracking-widest group-hover:border-slate-900">
            Get Your Gemini API Key
          </span>
        </a>
      </div>
    </div>
  );
};
