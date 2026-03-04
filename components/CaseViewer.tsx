
import React, { useState, useRef, useEffect } from 'react';
import { CaseStudyData } from '../types';
import { ArrowDownTrayIcon, ArrowPathIcon, AcademicCapIcon, BookOpenIcon, XMarkIcon, ArrowTopRightOnSquareIcon, ChevronDownIcon, ChevronUpIcon, SparklesIcon, ChatBubbleLeftRightIcon, StopIcon, ChevronLeftIcon, ChevronRightIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { CaseCopilot } from './CaseCopilot';
import { SelectionMenu } from './SelectionMenu';
import * as GeminiService from '../services/geminiService';

interface CaseViewerProps {
  data: CaseStudyData;
  onReset: () => void;
  onUpdateContent: (newContent: string) => void;
  onUpdateTeachingNotes: (newNotes: string) => void;
}

interface HistoryItem {
    caseContent: string;
    teachingNotes: string;
}

// --- STANDARD PARSING HELPERS ---

const parseInline = (text: string) => {
  const safeText = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return safeText
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="text-slate-700">$1</em>')
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono text-report-accent">$1</code>');
};

const cleanCell = (cell: string) => cell.trim();

const splitRow = (row: string) => {
    const trimmed = row.trim();
    let content = trimmed;
    if (content.startsWith('|')) content = content.substring(1);
    if (content.endsWith('|')) content = content.substring(0, content.length - 1);
    
    return content.split('|').map(cleanCell);
};

// --- COMPONENTS ---

const TableRenderer: React.FC<{ lines: string[], caption?: string }> = ({ lines, caption }) => {
    if (lines.length < 2) return null; 

    const headerRow = splitRow(lines[0]);
    const bodyRows = lines.slice(2).map(splitRow);

    let maxCols = headerRow.length;
    bodyRows.forEach(r => maxCols = Math.max(maxCols, r.length));

    const normalize = (row: string[]) => {
        while (row.length < maxCols) row.push('');
        return row;
    };

    const normHeader = normalize(headerRow);
    const normBody = bodyRows.map(normalize);

    return (
        <div className="my-8 w-full overflow-x-auto bg-white rounded-sm border border-slate-200 shadow-sm break-inside-avoid">
            {caption && (
                <div className="bg-slate-50 px-4 py-2 text-center border-b border-slate-200">
                    <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                        {caption}
                    </span>
                </div>
            )}
            <table className="w-full text-sm text-left border-collapse">
                <thead>
                    <tr>
                        {normHeader.map((h, i) => (
                            <th key={i} className="border-b-2 border-slate-300 bg-slate-100 px-4 py-3 font-bold text-slate-700 whitespace-pre-wrap border-r border-slate-200 last:border-r-0">
                                <span dangerouslySetInnerHTML={{__html: parseInline(h)}} />
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {normBody.map((row, rIndex) => (
                        <tr key={rIndex} className="hover:bg-blue-50/30 transition-colors even:bg-slate-50/30">
                            {row.map((cell, cIndex) => (
                                <td key={cIndex} className="border-b border-slate-200 border-r px-4 py-2.5 text-slate-700 align-top last:border-r-0">
                                    <span dangerouslySetInnerHTML={{__html: parseInline(cell)}} />
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

export const FormattedContent: React.FC<{ content: string; className?: string }> = ({ content, className }) => {
  if (!content) return null;

  const blocks: React.ReactNode[] = [];
  const lines = content.split('\n');
  
  let i = 0;
  while (i < lines.length) {
      const rawLine = lines[i];
      const line = rawLine.trim();

      // Handle Tables
      if (line.includes('|') && i + 1 < lines.length && lines[i+1].trim().match(/^\|?[\s\-:|]+\|?$/)) {
          let caption = undefined;
          const prevLine = i > 0 ? lines[i-1].trim() : '';
          if (prevLine.match(/^\*\*(图表|Table|Figure|Exhibit).*\*\*$/)) {
               caption = prevLine.replace(/\*\*/g, '');
          }

          const tableLines = [line, lines[i+1]];
          i += 2;
          while (i < lines.length && lines[i].trim().includes('|')) {
              tableLines.push(lines[i]);
              i++;
          }
          
          blocks.push(<TableRenderer key={`tbl-${i}`} lines={tableLines} caption={caption} />);
          continue;
      }

      // Handle Lists (Unordered & Ordered) with Indentation Support
      if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
          const listItems: { text: string; indent: number; type: 'ul' | 'ol' }[] = [];
          
          while (i < lines.length) {
              const currLine = lines[i];
              const trimmed = currLine.trim();
              const isUl = trimmed.match(/^[-*]\s/);
              const isOl = trimmed.match(/^\d+\.\s/);
              
              if (!isUl && !isOl) break;
              
              // Calculate indent (2 spaces = 1 unit roughly)
              const leadingSpaces = currLine.search(/\S|$/);
              const indentLevel = Math.floor(leadingSpaces / 2);
              
              const cleanText = isUl 
                ? trimmed.replace(/^[-*]\s+/, '') 
                : trimmed.replace(/^\d+\.\s+/, '');

              listItems.push({
                  text: cleanText,
                  indent: indentLevel,
                  type: isUl ? 'ul' : 'ol'
              });
              i++;
          }

          // Render the list block
          blocks.push(
              <div key={`list-${i}`} className="my-4 break-inside-avoid">
                  {listItems.map((item, idx) => (
                      <div 
                        key={idx} 
                        className="flex items-start mb-2"
                        style={{ paddingLeft: `${item.indent * 1.5}rem` }} // Visual nesting
                      >
                          <span className={`mr-2 flex-shrink-0 ${item.type === 'ul' ? 'text-report-accent' : 'text-slate-900 font-bold'}`}>
                              {item.type === 'ul' ? '•' : `${idx + 1}.`}
                          </span>
                          <span 
                            className="text-inherit leading-relaxed" 
                            dangerouslySetInnerHTML={{__html: parseInline(item.text)}} 
                          />
                      </div>
                  ))}
              </div>
          );
          continue;
      }

      // Handle Headers
      if (line.startsWith('# ')) {
          blocks.push(<h1 key={i} className="text-3xl font-serif font-bold text-slate-900 mt-12 mb-6 text-center pb-4 break-after-avoid">{line.replace(/^#\s+/, '')}</h1>);
          i++; continue;
      }
      if (line.startsWith('## ')) {
          blocks.push(<h2 key={i} className="text-xl font-sans font-bold text-report-accent mt-10 mb-5 uppercase tracking-widest border-l-4 border-report-accent pl-4 break-after-avoid">{line.replace(/^##\s+/, '')}</h2>);
          i++; continue;
      }
      if (line.startsWith('### ')) {
          blocks.push(<h3 key={i} className="text-lg font-serif font-bold text-slate-800 mt-6 mb-3 break-after-avoid">{line.replace(/^###\s+/, '')}</h3>);
          i++; continue;
      }

      // Handle Blockquotes
      if (line.startsWith('>')) {
          blocks.push(
            <blockquote key={i} className="border-l-4 border-report-accent pl-6 py-2 my-8 italic text-slate-600 font-serif text-lg leading-relaxed bg-slate-50 rounded-r-lg break-inside-avoid">
               <p dangerouslySetInnerHTML={{__html: parseInline(line.replace(/^>\s?/, ''))}} />
            </blockquote>
          );
          i++; continue;
      }

      // Handle Captions
      if (line.match(/^\*\*(图表|Table|Figure|Exhibit).*\*\*$/)) {
           blocks.push(<p key={i} className="mt-6 mb-2 text-center text-sm font-bold text-slate-800 uppercase tracking-wide">{line.replace(/\*\*/g, '')}</p>);
           i++; continue;
      }

      // Handle Regular Paragraphs
      if (line) {
          // Removed hardcoded text sizes so it can inherit form container (text-sm, etc.)
          blocks.push(<p key={i} className="mb-4 leading-relaxed text-justify font-serif break-inside-avoid" dangerouslySetInnerHTML={{__html: parseInline(line)}} />);
      }
      
      i++;
  }

  return <div className={`font-serif ${className}`}>{blocks}</div>;
};

export const CaseViewer: React.FC<CaseViewerProps> = ({ data, onReset, onUpdateContent, onUpdateTeachingNotes }) => {
  const [showSources, setShowSources] = useState(false);
  const [showCopilot, setShowCopilot] = useState(false);
  const [expandedSourceIndex, setExpandedSourceIndex] = useState<number | null>(null);
  const [isDownloading, setIsDownloading] = useState(false);
  
  // Selection State
  const [selection, setSelection] = useState('');
  const [selectionPos, setSelectionPos] = useState<{x: number, y: number} | null>(null);
  const [selectionSource, setSelectionSource] = useState<'case' | 'notes' | null>(null);

  // Global Refine Progress State (for overlay)
  const [refineStatus, setRefineStatus] = useState<string | null>(null);
  
  // History & Stop Control
  const abortControllerRef = useRef<boolean>(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Init history on mount (only once)
  useEffect(() => {
    if (history.length === 0 && data.caseContent) {
        setHistory([{
            caseContent: data.caseContent,
            teachingNotes: data.teachingNotes || ''
        }]);
    }
  }, []);

  // Sync external updates to history (e.g. if copilot changed it)
  useEffect(() => {
      const current = history[historyIndex];
      if (current && (current.caseContent !== data.caseContent || current.teachingNotes !== data.teachingNotes)) {
          const newHistory = history.slice(0, historyIndex + 1);
          newHistory.push({
              caseContent: data.caseContent || '',
              teachingNotes: data.teachingNotes || ''
          });
          setHistory(newHistory);
          setHistoryIndex(newHistory.length - 1);
      }
  }, [data.caseContent, data.teachingNotes]);

  // Refs for specific export sections
  const caseExportRef = useRef<HTMLDivElement>(null);
  const noteExportRef = useRef<HTMLDivElement>(null);

  const toggleSource = (index: number) => {
      if (expandedSourceIndex === index) {
          setExpandedSourceIndex(null);
      } else {
          setExpandedSourceIndex(index);
      }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // If a refinement is already in progress, disable selection
    if (refineStatus) return;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        return;
    }

    // Determine if selection is inside Case Content or Teaching Notes
    const target = e.target as HTMLElement;
    const caseSection = target.closest('[data-section="case"]');
    const notesSection = target.closest('[data-section="notes"]');

    if (caseSection) {
        setSelectionSource('case');
    } else if (notesSection) {
        setSelectionSource('notes');
    } else {
        return; // Selection outside editable areas
    }

    const text = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    setSelection(text);
    setSelectionPos({
        x: rect.left + rect.width / 2,
        y: rect.top
    });
  };

  const closeMenu = () => {
    setSelectionPos(null);
    setSelection('');
    setSelectionSource(null);
    window.getSelection()?.removeAllRanges();
  };

  // --- UNIFIED REFINE HANDLER ---
  const executeRefine = async (instruction: string, selectedText?: string, targetSource?: 'case' | 'notes') => {
      if (!targetSource) targetSource = 'case'; 
      const fullText = targetSource === 'case' ? data.caseContent : data.teachingNotes;
      if (!fullText) return;

      abortControllerRef.current = false;
      setRefineStatus("AI 正在初始化深度重构引擎...");
      
      try {
          const newText = await GeminiService.refineContent(
              fullText,
              instruction,
              selectedText, // undefined for global
              (msg) => setRefineStatus(msg),
              () => abortControllerRef.current // Check stop signal
          );
          
          if (targetSource === 'case') {
              onUpdateContent(newText);
          } else {
              onUpdateTeachingNotes(newText);
          }
      } catch (e: any) {
          if (e.message === "STOPPED") {
              setRefineStatus(null);
              // Do nothing, just close overlay
          } else {
              console.error("Refine failed", e);
              alert("修改遇到问题，请重试。");
          }
      } finally {
          setRefineStatus(null);
      }
  };

  const handleSelectionRefine = async (instruction: string) => {
      if (!selection || !selectionSource) return;
      closeMenu();
      await executeRefine(instruction, selection, selectionSource);
  };

  // Handler for Copilot triggered refine
  const handleCopilotRefineRequest = async (target: 'case' | 'notes', instruction: string) => {
      // We interpret 'case_content' as 'case' etc.
      const mappedTarget = target === 'notes' ? 'notes' : 'case';
      await executeRefine(instruction, undefined, mappedTarget);
  };

  const handleFirewallCheck = async () => {
      abortControllerRef.current = false;
      setRefineStatus("正在启动人工防火墙审查...");
      
      try {
          // 1. Audit Case Content
          setRefineStatus("正在审查案例正文...");
          const polishedCase = await GeminiService.runFinalPolish(
              data.caseContent || '',
              (msg) => setRefineStatus(`正文: ${msg}`),
              () => abortControllerRef.current
          );
          onUpdateContent(polishedCase);

          // 2. Audit Teaching Notes
          setRefineStatus("正在审查教学指南...");
          const polishedNotes = await GeminiService.runFinalPolish(
              data.teachingNotes || '',
              (msg) => setRefineStatus(`教参: ${msg}`),
              () => abortControllerRef.current
          );
          onUpdateTeachingNotes(polishedNotes);

          setRefineStatus(null);
          alert("防火墙审查与图表修复已完成！");

      } catch (e: any) {
          if (e.message !== "STOPPED") {
              console.error(e);
              alert("审查过程中断或出错。");
          }
      } finally {
          setRefineStatus(null);
      }
  };

  const handleStop = () => {
      abortControllerRef.current = true;
      setRefineStatus("正在停止...");
  };

  const handleUndo = () => {
      if (historyIndex > 0) {
          const prevIndex = historyIndex - 1;
          const prevData = history[prevIndex];
          setHistoryIndex(prevIndex);
          // Update parent state to reflect undo
          onUpdateContent(prevData.caseContent);
          onUpdateTeachingNotes(prevData.teachingNotes);
      }
  };

  const handleRedo = () => {
      if (historyIndex < history.length - 1) {
          const nextIndex = historyIndex + 1;
          const nextData = history[nextIndex];
          setHistoryIndex(nextIndex);
          // Update parent state to reflect redo
          onUpdateContent(nextData.caseContent);
          onUpdateTeachingNotes(nextData.teachingNotes);
      }
  };

  const downloadPDF = async (elementRef: React.RefObject<HTMLDivElement>, filename: string) => {
      const element = elementRef.current;
      if (!element) return;
      
      setIsDownloading(true);
      // Wait for web fonts to be fully ready before snapshotting to avoid CJK overlap.
      if ((document as any).fonts?.ready) {
          await (document as any).fonts.ready;
      }

      const captureWidth = Math.ceil(element.scrollWidth || element.getBoundingClientRect().width);
      const captureId = `pdf-capture-${Date.now()}`;
      element.setAttribute('data-pdf-capture-id', captureId);

      const opt = {
        margin:       [10, 10, 10, 10],
        filename:     filename,
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            width: captureWidth,
            windowWidth: captureWidth,
            scrollX: 0,
            scrollY: 0,
            onclone: (doc: Document) => {
                const clonedRoot = doc.querySelector(`[data-pdf-capture-id="${captureId}"]`) as HTMLElement | null;
                if (clonedRoot) {
                    clonedRoot.style.maxWidth = 'none';
                    clonedRoot.style.overflow = 'visible';
                    clonedRoot.style.width = `${captureWidth}px`;
                }
            }
        },
        jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak:    {
            mode: ['css', 'legacy'],
            avoid: ['.break-inside-avoid', 'table', 'tr', 'blockquote', 'h1', 'h2', 'h3']
        }
      };

      try {
          // @ts-ignore
          if (!window.html2pdf) {
              alert("PDF Generator library not loaded. Please refresh.");
              return;
          }
          // @ts-ignore
          await window.html2pdf().set(opt).from(element).save();
      } catch (err) {
          console.error("PDF Generation Error", err);
      } finally {
          element.removeAttribute('data-pdf-capture-id');
          setIsDownloading(false);
      }
  };

  return (
    <div className="min-h-screen w-full bg-report-bg pb-24 relative" onMouseUp={handleMouseUp}>
      
      {/* PROCESSING OVERLAY (Unified) */}
      {refineStatus && (
          <div className="fixed inset-0 z-[100] bg-white/90 backdrop-blur-md flex flex-col items-center justify-center animate-fade-in no-print">
              <div className="relative w-24 h-24 mb-8">
                  <div className="absolute inset-0 border-4 border-gray-100 rounded-full"></div>
                  <div className="absolute inset-0 border-4 border-report-accent rounded-full border-t-transparent animate-spin"></div>
                  <SparklesIcon className="absolute inset-0 m-auto w-8 h-8 text-report-accent animate-pulse" />
              </div>
              <h3 className="text-3xl font-serif font-bold text-slate-900 mb-2 tracking-tight">AI 智能重构中</h3>
              <p className="text-report-accent font-mono text-sm uppercase tracking-wider animate-pulse mb-8">{refineStatus}</p>
              
              <button 
                onClick={handleStop}
                className="px-6 py-2 bg-white border border-red-200 text-red-500 rounded-full text-sm font-bold hover:bg-red-50 transition-colors flex items-center gap-2 shadow-sm"
              >
                  <StopIcon className="w-4 h-4" />
                  停止生成 (Stop)
              </button>
          </div>
      )}
      
      {/* Top Bar */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40 no-print shadow-sm">
          <div className="max-w-6xl mx-auto px-4 h-16 flex justify-between items-center">
             <div className="flex items-center gap-2">
                <span className="font-serif font-bold text-xl text-slate-800">BizCase Final</span>
                <span className="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-md font-mono">v{historyIndex + 1}</span>
             </div>
             
             {/* Right Controls */}
             <div className="flex items-center gap-3">
                {/* Version Controls */}
                <div className="flex items-center gap-1 bg-gray-50 rounded-lg p-1 border border-gray-100">
                    <button 
                        onClick={handleUndo} 
                        disabled={historyIndex <= 0 || !!refineStatus}
                        className="p-1.5 rounded-md text-gray-500 hover:text-slate-800 hover:bg-white disabled:opacity-30 transition-all"
                        title="上一版"
                    >
                        <ChevronLeftIcon className="w-4 h-4" />
                    </button>
                    <button 
                        onClick={handleRedo} 
                        disabled={historyIndex >= history.length - 1 || !!refineStatus}
                        className="p-1.5 rounded-md text-gray-500 hover:text-slate-800 hover:bg-white disabled:opacity-30 transition-all"
                        title="下一版"
                    >
                        <ChevronRightIcon className="w-4 h-4" />
                    </button>
                </div>

                <div className="w-px h-8 bg-gray-200 mx-1"></div>

                <button 
                    onClick={() => setShowCopilot(true)}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors border ${showCopilot ? 'bg-teal-50 border-report-accent text-report-accent' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                >
                    <ChatBubbleLeftRightIcon className="w-4 h-4" />
                    Copilot
                </button>

                <button 
                    onClick={handleFirewallCheck}
                    disabled={!!refineStatus}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors border bg-white border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    title="人工启动防火墙检查与图表修复"
                >
                    <ShieldCheckIcon className="w-4 h-4 text-orange-500" />
                    Check
                </button>
                
                {/* Download Buttons */}
                <button 
                    onClick={() => downloadPDF(caseExportRef, `Case_Study_${data.topic.substring(0,10)}.pdf`)}
                    disabled={isDownloading}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 shadow-sm"
                >
                    <ArrowDownTrayIcon className="w-4 h-4" />
                    正文
                </button>
                <button 
                    onClick={() => downloadPDF(noteExportRef, `Teaching_Note_${data.topic.substring(0,10)}.pdf`)}
                    disabled={isDownloading}
                    className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-report-accent rounded-lg hover:bg-teal-800 shadow-sm"
                >
                    <ArrowDownTrayIcon className="w-4 h-4" />
                    教参
                </button>

                <div className="w-px h-8 bg-gray-200 mx-1"></div>
                <button 
                    onClick={onReset}
                    className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                    title="重置"
                >
                    <ArrowPathIcon className="w-5 h-5" />
                </button>
             </div>
          </div>
      </div>

      {/* Document Container */}
      <div className="max-w-[210mm] mx-auto mt-12 bg-white shadow-2xl min-h-[297mm] relative print:shadow-none print:mt-0 print:w-full print:max-w-none print:m-0">
        
        <div className="p-[25mm]">
            
            {/* --- CASE STUDY SECTION (Target for PDF Export 1) --- */}
            <div ref={caseExportRef} className="bg-white" data-section="case">
                {/* Header Section */}
                <header className="mb-12 border-b-4 border-double border-gray-200 pb-8 text-center">
                    <div className="flex justify-center items-center gap-4 mb-4 opacity-60">
                        <span className="h-px w-12 bg-gray-400"></span>
                        <span className="text-xs font-bold tracking-[0.3em] text-gray-500 uppercase">Business Case Study</span>
                        <span className="h-px w-12 bg-gray-400"></span>
                    </div>
                    <h1 className="text-4xl md:text-5xl font-serif font-bold text-slate-900 mb-6 leading-tight tracking-tight">
                        {data.topic}
                    </h1>
                    <div className="flex justify-center gap-6 text-xs text-gray-500 uppercase tracking-widest font-semibold">
                        <span>For Educational Use Only</span>
                        <span>•</span>
                        <span>{new Date().getFullYear()} Edition</span>
                    </div>
                </header>

                {/* Case Narrative Content */}
                <section className="mb-12">
                    <FormattedContent content={data.caseContent || ""} />
                </section>

                {/* Case Footer (Visible in PDF) */}
                <div className="pt-8 border-t border-gray-100 text-[10px] text-gray-400 font-sans text-center uppercase tracking-widest">
                    Generated by BizCase Pro • {data.topic} • Case Study
                </div>
            </div>

            {/* Visual Break on Screen */}
            <div className="no-print h-16 border-t border-dashed border-gray-200 my-12 relative flex items-center justify-center">
                <span className="bg-white px-4 text-xs text-gray-400 uppercase font-bold tracking-widest">End of Case / Start of Notes</span>
            </div>

            {/* --- TEACHING NOTE SECTION (Target for PDF Export 2) --- */}
            <div ref={noteExportRef} className="bg-white" data-section="notes">
                
                {/* Teaching Note Header (Ensures context in standalone PDF) */}
                <div className="mb-8 border-b border-gray-200 pb-6">
                    <div className="flex items-center gap-3 mb-2">
                        <AcademicCapIcon className="w-6 h-6 text-report-accent" />
                        <h2 className="text-2xl font-bold text-slate-800 font-serif">Teaching Note</h2>
                    </div>
                    <p className="text-sm text-gray-500 font-medium">
                        Case Reference: {data.topic}
                    </p>
                </div>

                {/* Teaching Note Content */}
                <section className="mb-12">
                    <div className="p-6 rounded-lg border border-slate-100 bg-slate-50/50">
                         <FormattedContent content={data.teachingNotes || ""} />
                    </div>
                </section>

                 {/* Teaching Note Footer (Visible in PDF) */}
                 <div className="pt-8 border-t border-gray-100 text-[10px] text-gray-400 font-sans text-center uppercase tracking-widest">
                    Generated by BizCase Pro • {data.topic} • Instructor's Guide
                </div>
            </div>

            {/* Interactive Footer (Screen Only) */}
            <footer 
                onClick={() => setShowSources(true)}
                className="mt-20 pt-8 border-t border-gray-100 text-[10px] text-gray-400 font-sans flex justify-between uppercase tracking-widest cursor-pointer hover:text-report-accent transition-colors group no-print"
            >
                <div className="flex items-center gap-2">
                    <BookOpenIcon className="w-4 h-4 text-gray-300 group-hover:text-report-accent" />
                    <span>Cited Sources: {data.sources.length} (Click to view)</span>
                </div>
                <span>Generated by BizCase Pro</span>
            </footer>

        </div>
      </div>

      {/* AI Copilot Drawer */}
      {showCopilot && (
          <div className="fixed inset-0 z-50 flex justify-end no-print">
              <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-sm transition-opacity" onClick={() => setShowCopilot(false)} />
              <CaseCopilot 
                  caseContent={data.caseContent || ''}
                  teachingNotes={data.teachingNotes || ''}
                  onRequestRefine={handleCopilotRefineRequest}
                  onClose={() => setShowCopilot(false)}
              />
          </div>
      )}

      {/* Source Sidebar (Drawer) */}
      {showSources && (
          <div className="fixed inset-0 z-50 flex justify-end animate-fade-in no-print">
             <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-sm transition-opacity" onClick={() => setShowSources(false)} />
             
             <div className="relative w-full max-w-md bg-white shadow-2xl h-full flex flex-col animate-slide-in-right">
                <div className="px-8 py-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                    <div className="flex items-center gap-2">
                        <BookOpenIcon className="w-5 h-5 text-report-accent" />
                        <h3 className="font-serif font-bold text-lg text-slate-900">Reference Library</h3>
                    </div>
                    <button onClick={() => setShowSources(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors">
                        <XMarkIcon className="w-5 h-5 text-gray-500" />
                    </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-6 bg-gray-50/50">
                    <div className="space-y-3">
                        {data.sources.map((s, i) => {
                            const isExpanded = expandedSourceIndex === i;
                            return (
                                <div 
                                   key={i} 
                                   className={`rounded-xl border transition-all duration-200 bg-white overflow-hidden ${isExpanded ? 'border-report-accent shadow-md ring-1 ring-report-accent/10' : 'border-gray-200 hover:border-gray-300'}`}
                                >
                                    <div 
                                        onClick={() => toggleSource(i)}
                                        className="flex items-start justify-between p-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                                    >
                                        <h4 className={`font-sans font-bold text-sm line-clamp-2 leading-snug flex-1 mr-4 ${isExpanded ? 'text-report-accent' : 'text-slate-800'}`}>
                                            {s.title || "Untitled Source"}
                                        </h4>
                                        <div className="text-gray-400 mt-0.5">
                                            {isExpanded ? <ChevronUpIcon className="w-4 h-4" /> : <ChevronDownIcon className="w-4 h-4" />}
                                        </div>
                                    </div>

                                    {isExpanded && (
                                        <div className="px-4 pb-4 pt-0 animate-fade-in">
                                            <div className="h-px w-full bg-gray-100 mb-3" />
                                            <p className="text-xs text-gray-500 mb-3 font-mono break-all bg-gray-50 p-2 rounded border border-gray-100">
                                                {s.uri}
                                            </p>
                                            {s.snippet && (
                                                <p className="text-xs text-slate-600 mb-4 italic border-l-2 border-gray-200 pl-3">
                                                    "{s.snippet}..."
                                                </p>
                                            )}
                                            <a 
                                                href={s.uri}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="flex items-center justify-center gap-2 w-full py-2 bg-report-accent text-white text-xs font-bold uppercase tracking-wide rounded-lg hover:bg-teal-800 transition-colors shadow-sm"
                                            >
                                                <span>Read Original Source</span>
                                                <ArrowTopRightOnSquareIcon className="w-3 h-3" />
                                            </a>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
             </div>
          </div>
      )}

      <SelectionMenu 
        position={selectionPos}
        selectedText={selection}
        onClose={closeMenu}
        onSubmit={handleSelectionRefine}
        isLoading={!!refineStatus} // Disable menu input if global refine is running
      />
    </div>
  );
};
