import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightIcon, LockClosedIcon, SparklesIcon } from '@heroicons/react/24/outline';

interface ApiKeyInputProps {
  onKeySet: () => void;
}

export const ApiKeyInput: React.FC<ApiKeyInputProps> = ({ onKeySet }) => {
  const [inputKey, setInputKey] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!inputKey.trim()) return;
    localStorage.setItem('GEMINI_API_KEY', inputKey.trim());
    onKeySet();
  };

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
            inputKey ? 'translate-y-[-2vh] scale-90 opacity-60 blur-[1px]' : 'translate-y-0 opacity-100'
          }`}
        >
          <h1 className="mb-2 font-serif text-6xl font-black tracking-tighter text-slate-900 md:text-9xl">
            Writing<span className="text-teal-600">.</span>Workspace
          </h1>
          <p className="font-mono text-sm uppercase tracking-[0.3em] text-slate-400 md:text-base">
            Business Article Intelligence Engine
          </p>
        </div>

        <form onSubmit={handleSubmit} className="relative mx-auto mt-24 w-full max-w-2xl group md:mt-32">
          <div className="relative">
            <input
              ref={inputRef}
              type="password"
              value={inputKey}
              onChange={(event) => setInputKey(event.target.value)}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              className="w-full bg-transparent py-6 text-center font-serif text-4xl tracking-widest text-slate-800 placeholder-slate-200 outline-none transition-all md:text-6xl"
              placeholder="API KEY"
              autoComplete="off"
              spellCheck="false"
            />

            <div className="absolute bottom-0 left-0 h-[2px] w-full overflow-hidden bg-slate-200/50">
              <div
                className={`h-full bg-slate-900 transition-transform duration-700 ease-out ${
                  isFocused || inputKey ? 'translate-x-0' : '-translate-x-full'
                }`}
              />
            </div>

            <div
              className={`absolute -top-8 left-0 w-full text-center transition-all duration-500 ${
                inputKey ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
              }`}
            >
              <span className="flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-widest text-teal-600">
                <LockClosedIcon className="h-3 w-3" />
                Secure Access
              </span>
            </div>
          </div>

          <div
            className={`mt-16 flex flex-col items-center gap-6 transition-all duration-700 ${
              inputKey ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-8 opacity-0'
            }`}
          >
            <button
              type="submit"
              className="group relative flex items-center gap-4 rounded-full bg-slate-900 px-10 py-5 text-lg font-bold tracking-wide text-white shadow-2xl transition-all hover:scale-105 hover:bg-teal-700 hover:shadow-teal-900/20 active:scale-95"
            >
              <span>进入工作台</span>
              <ArrowRightIcon className="h-6 w-6 transition-transform group-hover:translate-x-1" />
              <div className="absolute inset-0 rounded-full ring-2 ring-white/20 transition-all group-hover:ring-white/40" />
            </button>
            <p className="font-mono text-xs text-slate-400">Press [ENTER] to confirm</p>
          </div>
        </form>
      </div>

      <div
        className={`absolute bottom-10 transition-all duration-700 ${
          inputKey ? 'translate-y-10 opacity-0' : 'translate-y-0 opacity-100'
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
            Get Gemini API Key
          </span>
        </a>
      </div>
    </div>
  );
};
