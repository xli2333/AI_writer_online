import React, { useEffect, useState } from 'react';
import { LockClosedIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';

interface PasswordGateProps {
  children: React.ReactNode;
}

const AUTH_HASH = 'MjAyNUZEU00=';
const SESSION_KEY = 'writing_workspace_auth_token';

export const PasswordGate: React.FC<PasswordGateProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = sessionStorage.getItem(SESSION_KEY);
    if (token === AUTH_HASH) {
      setIsAuthenticated(true);
    }
    setIsLoading(false);
  }, []);

  const handleLogin = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');

    try {
      if (btoa(input) === AUTH_HASH) {
        sessionStorage.setItem(SESSION_KEY, AUTH_HASH);
        setIsAuthenticated(true);
      } else {
        setError('Access denied');
        setInput('');
      }
    } catch {
      setError('Validation error');
    }
  };

  if (isLoading) return null;
  if (isAuthenticated) return <>{children}</>;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl animate-fade-in">
        <div className="border-b border-slate-100 bg-slate-50 px-8 py-8 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-slate-900 shadow-lg">
            <ShieldCheckIcon className="h-8 w-8 text-teal-400" />
          </div>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-slate-900">Writing Workspace</h1>
          <p className="mt-2 text-sm font-semibold uppercase tracking-widest text-slate-500">Authorized Access Only</p>
        </div>

        <form onSubmit={handleLogin} className="p-8">
          <div className="mb-6">
            <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-500">Security Key</label>
            <div className="relative">
              <LockClosedIcon className="absolute left-4 top-3.5 h-5 w-5 text-slate-400" />
              <input
                type="password"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Enter access code..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-12 pr-4 text-slate-900 outline-none transition-all placeholder:text-slate-400 focus:border-transparent focus:ring-2 focus:ring-teal-500"
                autoFocus
              />
            </div>
          </div>

          {error && (
            <div className="mb-6 rounded-lg border border-red-100 bg-red-50 p-3 text-center text-xs font-bold text-red-600 animate-pulse">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!input}
            className="w-full rounded-xl bg-slate-900 py-4 font-bold text-white shadow-lg transition-all hover:bg-teal-600 hover:shadow-xl active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Verify & Enter
          </button>
        </form>

        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-8 py-4">
          <span className="font-mono text-[10px] text-slate-400">SECURE CONNECTION</span>
          <span className="font-mono text-[10px] text-slate-400">v3.0.0</span>
        </div>
      </div>
    </div>
  );
};
