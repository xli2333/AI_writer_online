import React, { useEffect, useRef, useState } from 'react';
import {
  ComputerDesktopIcon,
  PaperAirplaneIcon,
  SparklesIcon,
  UserCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import * as GeminiService from '../services/geminiService';

interface WritingCopilotProps {
  ammoLibrary: string;
  articleContent: string;
  teachingNotes: string;
  onRequestRefine: (target: 'article' | 'notes', instruction: string) => void;
  onClose: () => void;
}

interface Message {
  role: 'user' | 'model';
  text: string;
  isAction?: boolean;
}

export const WritingCopilot: React.FC<WritingCopilotProps> = ({
  ammoLibrary,
  articleContent,
  teachingNotes,
  onRequestRefine,
  onClose,
}) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'model',
      text: '我是这篇文章的编辑 Copilot。你可以让我压缩段落、补强证据、改标题、清理 AI 腔，或者单独处理 TN / 讨论指南。',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: userMessage }]);
    setIsLoading(true);

    try {
      const history = messages
        .filter((message) => !message.isAction)
        .map((message) => ({
          role: message.role,
          parts: [{ text: message.text }],
        }));

      const response = await GeminiService.chatWithEditor(
        ammoLibrary,
        articleContent,
        teachingNotes,
        history,
        userMessage
      );

      if (response.refinementRequest) {
        setMessages((prev) => [
          ...prev,
          { role: 'model', text: '正在调起深度编辑流程，请稍候。', isAction: true },
        ]);
        onRequestRefine(response.refinementRequest.target, response.refinementRequest.instruction);
      }

      if (response.text) {
        setMessages((prev) => [...prev, { role: 'model', text: response.text }]);
      }
    } catch (error) {
      console.error(error);
      setMessages((prev) => [...prev, { role: 'model', text: '编辑 Copilot 暂时不可用，请稍后再试。' }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full animate-slide-in-right flex-col border-l border-gray-200 bg-white shadow-2xl md:w-[460px]">
      <div className="flex items-center justify-between border-b border-gray-100 bg-slate-50 px-6 py-4">
        <div className="flex items-center gap-2 text-slate-800">
          <SparklesIcon className="h-5 w-5 text-report-accent" />
          <h3 className="font-serif text-lg font-bold">写作 Copilot</h3>
        </div>
        <button onClick={onClose} className="rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-200">
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50/50 p-4">
        {messages.map((message, index) => (
          <div key={index} className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                message.role === 'user' ? 'bg-slate-200' : 'bg-report-accent text-white'
              }`}
            >
              {message.role === 'user' ? (
                <UserCircleIcon className="h-5 w-5 text-gray-500" />
              ) : (
                <ComputerDesktopIcon className="h-5 w-5" />
              )}
            </div>

            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                message.role === 'user'
                  ? 'border border-gray-100 bg-white text-slate-800'
                  : message.isAction
                    ? 'border border-blue-100 bg-blue-50 font-bold italic text-blue-700'
                    : 'border border-gray-100 bg-white text-slate-700'
              }`}
            >
              {message.text}
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-report-accent text-white">
              <ComputerDesktopIcon className="h-5 w-5" />
            </div>
            <div className="flex items-center gap-2 rounded-2xl border border-gray-100 bg-white px-4 py-3 shadow-sm">
              <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 delay-100" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400 delay-200" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-gray-100 bg-white p-4">
        <div className="relative">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSend();
              }
            }}
            placeholder="例如：把开头改得更直接；删掉第三部分的空话；给 TN 增加两个讨论问题。"
            className="w-full resize-none rounded-xl border border-gray-200 bg-gray-50 py-3 pl-4 pr-12 text-sm shadow-inner focus:border-transparent focus:ring-2 focus:ring-report-accent"
            rows={2}
            disabled={isLoading}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading}
            className="absolute bottom-2 right-2 rounded-lg bg-report-accent p-2 text-white shadow-sm transition-colors hover:bg-teal-700 disabled:opacity-50"
          >
            <PaperAirplaneIcon className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-center text-[10px] text-gray-400">Copilot 可以直接触发全文改写或 TN 改写。</p>
      </div>
    </div>
  );
};
