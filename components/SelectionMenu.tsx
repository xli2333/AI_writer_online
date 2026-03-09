
import React, { useState, useEffect, useRef } from 'react';
import { SparklesIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { createPortal } from 'react-dom';

interface SelectionMenuProps {
  position: { x: number; y: number } | null;
  selectedText: string;
  onClose: () => void;
  onSubmit: (instruction: string) => void;
  isLoading: boolean;
}

export const SelectionMenu: React.FC<SelectionMenuProps> = ({ position, selectedText, onClose, onSubmit, isLoading }) => {
  const [instruction, setInstruction] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (position && inputRef.current) {
      inputRef.current.focus();
    }
  }, [position]);

  if (!position) return null;

  // Use Portal to escape overflow:hidden containers
  return createPortal(
    <div 
        className="fixed z-[9999] animate-fade-in"
        style={{ 
            left: position.x, 
            top: position.y - 10, // Slight offset up
            transform: 'translate(-50%, -100%)' // Center horizontally, sit above
        }}
    >
        <div className="bg-slate-900 text-white p-2 rounded-xl shadow-2xl flex flex-col w-[320px] ring-1 ring-white/10">
            {/* Header / Selection Preview */}
            <div className="flex justify-between items-center px-2 pb-2 mb-2 border-b border-white/10">
                <div className="flex items-center gap-1.5 text-xs font-bold text-teal-400 uppercase tracking-wider">
                    <SparklesIcon className="w-3 h-3" />
                    <span>AI Refine</span>
                </div>
                <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                    <XMarkIcon className="w-4 h-4" />
                </button>
            </div>
            
            <p className="text-[10px] text-gray-400 px-2 mb-2 line-clamp-1 italic">
                "{selectedText}"
            </p>

            {/* Input Area */}
            <div className="flex gap-2">
                <input
                    ref={inputRef}
                    type="text"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder="例如：压缩这段、补一个数据、把语气收紧"
                    disabled={isLoading}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (instruction.trim()) onSubmit(instruction);
                        }
                    }}
                    className="flex-1 bg-slate-800 border-none rounded-lg text-sm px-3 py-2 text-white placeholder:text-gray-500 focus:ring-1 focus:ring-teal-500 outline-none"
                />
                <button
                    onClick={() => onSubmit(instruction)}
                    disabled={!instruction.trim() || isLoading}
                    className="bg-teal-600 hover:bg-teal-500 text-white rounded-lg px-3 py-2 transition-colors disabled:opacity-50 flex items-center justify-center"
                >
                    {isLoading ? (
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                        <SparklesIcon className="w-4 h-4" />
                    )}
                </button>
            </div>
        </div>
        {/* Triangle Pointer */}
        <div className="w-3 h-3 bg-slate-900 rotate-45 absolute left-1/2 -bottom-1.5 -translate-x-1/2 border-r border-b border-slate-900 shadow-sm" />
    </div>,
    document.body
  );
};
