import React from 'react';

const parseInline = (text: string) => {
  const safeText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return safeText
    .replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold text-slate-900">$1</strong>')
    .replace(/\*(.*?)\*/g, '<em class="text-slate-700">$1</em>')
    .replace(/`([^`]+)`/g, '<code class="bg-gray-100 px-1 py-0.5 rounded text-sm font-mono text-report-accent">$1</code>');
};

const cleanCell = (cell: string) => cell.trim();
const TABLE_CAPTION_PATTERN = /^\*\*(图表|Table|Figure|Exhibit).*\*\*$/;
const TABLE_SEPARATOR_PATTERN = /^\|?[\s\-:|]+\|?$/;
type TableAlignment = 'left' | 'center' | 'right';

const isLikelyCssArtifactLine = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return false;

  return (
    trimmed === '{' ||
    trimmed === '}' ||
    /^(?:[.#@][\w-]+|[a-z][\w-]*(?:\s+[.#]?[a-z][\w-]*)*)\s*\{$/i.test(trimmed) ||
    /^(?:--)?[a-z-]{2,}\s*:\s*[^{}]{1,200};?$/i.test(trimmed)
  );
};

const splitRow = (row: string) => {
  const trimmed = row.trim();
  let content = trimmed;
  if (content.startsWith('|')) content = content.slice(1);
  if (content.endsWith('|')) content = content.slice(0, -1);
  return content.split('|').map(cleanCell);
};

const parseTableAlignment = (cell: string): TableAlignment => {
  const trimmed = cell.trim();
  const leftAligned = trimmed.startsWith(':');
  const rightAligned = trimmed.endsWith(':');

  if (leftAligned && rightAligned) return 'center';
  if (rightAligned) return 'right';
  return 'left';
};

const isNumericLikeCell = (value: string) => {
  const normalized = value.replace(/[,\s]/g, '').trim();
  if (!normalized) return false;
  return /^[<>~≈]?[$€£¥]?-?\d+(?:\.\d+)?(?:%|x|X|倍|万|亿|年|天|元|美元|m|M|k|K)?$/.test(normalized);
};

const resolveAlignmentClass = (alignment: TableAlignment) => {
  if (alignment === 'center') return 'text-center';
  if (alignment === 'right') return 'text-right';
  return 'text-left';
};

const collectTableLines = (sourceLines: string[], startIndex: number) => {
  const tableLines = [sourceLines[startIndex], sourceLines[startIndex + 1]];
  let nextIndex = startIndex + 2;

  while (nextIndex < sourceLines.length && sourceLines[nextIndex].trim().includes('|')) {
    tableLines.push(sourceLines[nextIndex]);
    nextIndex += 1;
  }

  return { tableLines, nextIndex };
};

const TableRenderer: React.FC<{ lines: string[]; caption?: string }> = ({ lines, caption }) => {
  if (lines.length < 2) return null;

  const headerRow = splitRow(lines[0]);
  const alignmentRow = splitRow(lines[1]);
  const bodyRows = lines.slice(2).map(splitRow);

  let maxCols = headerRow.length;
  bodyRows.forEach((row) => {
    maxCols = Math.max(maxCols, row.length);
  });

  const normalize = (row: string[]) => {
    while (row.length < maxCols) row.push('');
    return row;
  };

  const normalizedHeader = normalize(headerRow);
  const normalizedBody = bodyRows.map(normalize);
  const normalizedAlignments = normalize(alignmentRow.map(parseTableAlignment));
  const numericColumns = Array.from({ length: maxCols }, (_, colIndex) => {
    const values = normalizedBody.map((row) => row[colIndex]).filter(Boolean);
    return values.length > 0 && values.every(isNumericLikeCell);
  });
  const minTableWidth = maxCols >= 5 ? `${Math.min(84, maxCols * 10)}rem` : undefined;

  return (
    <div className="pdf-avoid-break my-8 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      {caption && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-center">
          <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-700">{caption}</span>
        </div>
      )}
      <div className="w-full overflow-x-auto">
        <table className="min-w-full border-collapse text-sm" style={minTableWidth ? { minWidth: minTableWidth } : undefined}>
          <thead>
          <tr>
            {normalizedHeader.map((header, index) => (
              <th
                key={index}
                className={`border-b-2 border-slate-300 border-r border-slate-200 bg-slate-100 px-4 py-3 font-bold text-slate-700 last:border-r-0 ${resolveAlignmentClass(
                  normalizedAlignments[index]
                )} ${numericColumns[index] ? 'whitespace-nowrap' : 'break-words'}`}
              >
                <span dangerouslySetInnerHTML={{ __html: parseInline(header) }} />
              </th>
            ))}
          </tr>
          </thead>
          <tbody>
          {normalizedBody.map((row, rowIndex) => (
            <tr key={rowIndex} className="even:bg-slate-50/40 hover:bg-blue-50/30 transition-colors">
              {row.map((cell, colIndex) => (
                <td
                  key={colIndex}
                  className={`border-b border-r border-slate-200 px-4 py-2.5 align-top text-slate-700 last:border-r-0 ${resolveAlignmentClass(
                    normalizedAlignments[colIndex]
                  )} ${numericColumns[colIndex] ? 'whitespace-nowrap font-medium tabular-nums' : 'break-words'}`}
                >
                  <span dangerouslySetInnerHTML={{ __html: parseInline(cell) }} />
                </td>
              ))}
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export const MarkdownRenderer: React.FC<{
  content: string;
  className?: string;
  renderAfterParagraphRange?: (start: number, end: number) => React.ReactNode;
}> = ({ content, className, renderAfterParagraphRange }) => {
  if (!content) return null;

  const blocks: React.ReactNode[] = [];
  const lines = content.split('\n');
  let paragraphCursor = 0;

  const pushAfterRange = (start: number, end: number, key: string) => {
    if (!renderAfterParagraphRange) return;
    const node = renderAfterParagraphRange(start, end);
    if (node) {
      blocks.push(<React.Fragment key={key}>{node}</React.Fragment>);
    }
  };

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (isLikelyCssArtifactLine(line)) {
      const artifactLines: string[] = [];
      let cursor = index;

      while (cursor < lines.length) {
        const candidate = lines[cursor].trim();
        if (candidate && !isLikelyCssArtifactLine(candidate)) break;
        artifactLines.push(lines[cursor]);
        cursor += 1;
      }

      const meaningfulArtifactLines = artifactLines.filter((candidate) => candidate.trim());
      if (meaningfulArtifactLines.length >= 4) {
        blocks.push(
          <div
            key={`artifact-${index}`}
            className="my-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-relaxed text-amber-800"
          >
            已省略疑似页面样式/脚本片段。
          </div>
        );
        index = cursor;
        continue;
      }
    }

    if (
      TABLE_CAPTION_PATTERN.test(line) &&
      index + 2 < lines.length &&
      lines[index + 1].trim().includes('|') &&
      TABLE_SEPARATOR_PATTERN.test(lines[index + 2].trim())
    ) {
      const caption = line.replace(/\*\*/g, '');
      const { tableLines, nextIndex } = collectTableLines(lines, index + 1);
      index = nextIndex;

      const rangeStart = paragraphCursor;
      const rangeEnd = paragraphCursor + Math.max(0, tableLines.length - 1);
      blocks.push(<TableRenderer key={`table-${index}`} lines={tableLines} caption={caption} />);
      pushAfterRange(rangeStart, rangeEnd, `after-table-${index}`);
      paragraphCursor = rangeEnd + 1;
      continue;
    }

    if (line.includes('|') && index + 1 < lines.length && TABLE_SEPARATOR_PATTERN.test(lines[index + 1].trim())) {
      const { tableLines, nextIndex } = collectTableLines(lines, index);
      index = nextIndex;

      const rangeStart = paragraphCursor;
      const rangeEnd = paragraphCursor + Math.max(0, tableLines.length - 1);
      blocks.push(<TableRenderer key={`table-${index}`} lines={tableLines} />);
      pushAfterRange(rangeStart, rangeEnd, `after-table-${index}`);
      paragraphCursor = rangeEnd + 1;
      continue;
    }

    if (line.match(/^[-*]\s/) || line.match(/^\d+\.\s/)) {
      const listItems: { text: string; indent: number; type: 'ul' | 'ol'; order: number }[] = [];
      let orderedCounter = 1;

      while (index < lines.length) {
        const currentLine = lines[index];
        const trimmed = currentLine.trim();
        const isUnordered = trimmed.match(/^[-*]\s/);
        const isOrdered = trimmed.match(/^\d+\.\s/);

        if (!isUnordered && !isOrdered) break;

        const leadingSpaces = currentLine.search(/\S|$/);
        const indentLevel = Math.floor(leadingSpaces / 2);
        const cleanText = isUnordered
          ? trimmed.replace(/^[-*]\s+/, '')
          : trimmed.replace(/^\d+\.\s+/, '');

        listItems.push({
          text: cleanText,
          indent: indentLevel,
          type: isUnordered ? 'ul' : 'ol',
          order: isUnordered ? 0 : orderedCounter,
        });

        if (isOrdered) orderedCounter += 1;
        index += 1;
      }

      blocks.push(
        <div key={`list-${index}`} className="pdf-avoid-break my-4">
          {listItems.map((item, itemIndex) => (
            <div key={itemIndex} className="mb-2 flex items-start" style={{ paddingLeft: `${item.indent * 1.5}rem` }}>
              <span className={`mr-2 flex-shrink-0 ${item.type === 'ul' ? 'text-report-accent' : 'font-bold text-slate-900'}`}>
                {item.type === 'ul' ? '•' : `${item.order}.`}
              </span>
              <span className="leading-relaxed text-inherit" dangerouslySetInnerHTML={{ __html: parseInline(item.text) }} />
            </div>
          ))}
        </div>
      );
      const rangeStart = paragraphCursor;
      const rangeEnd = paragraphCursor + Math.max(0, listItems.length - 1);
      pushAfterRange(rangeStart, rangeEnd, `after-list-${index}`);
      paragraphCursor = rangeEnd + 1;
      continue;
    }

    if (line.startsWith('# ')) {
      blocks.push(
        <h1 key={index} className="mb-6 mt-12 break-after-avoid text-center font-serif text-3xl font-bold text-slate-900">
          {line.replace(/^#\s+/, '')}
        </h1>
      );
      index += 1;
      continue;
    }

    if (line.startsWith('## ')) {
      blocks.push(
        <h2
          key={index}
          className="mb-5 mt-10 break-after-avoid border-l-4 border-report-accent pl-4 font-sans text-xl font-bold uppercase tracking-widest text-report-accent"
        >
          {line.replace(/^##\s+/, '')}
        </h2>
      );
      index += 1;
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push(
        <h3 key={index} className="mb-3 mt-6 break-after-avoid font-serif text-lg font-bold text-slate-800">
          {line.replace(/^###\s+/, '')}
        </h3>
      );
      index += 1;
      continue;
    }

    if (line.startsWith('>')) {
      blocks.push(
        <blockquote
          key={index}
          className="pdf-avoid-break my-8 rounded-r-lg border-l-4 border-report-accent bg-slate-50 py-2 pl-6 font-serif text-lg italic leading-relaxed text-slate-600"
        >
          <p dangerouslySetInnerHTML={{ __html: parseInline(line.replace(/^>\s?/, '')) }} />
        </blockquote>
      );
      pushAfterRange(paragraphCursor, paragraphCursor, `after-quote-${index}`);
      paragraphCursor += 1;
      index += 1;
      continue;
    }

    if (line.match(TABLE_CAPTION_PATTERN)) {
      blocks.push(
        <p key={index} className="mb-2 mt-6 text-center text-sm font-bold uppercase tracking-wide text-slate-800">
          {line.replace(/\*\*/g, '')}
        </p>
      );
      index += 1;
      continue;
    }

    if (line) {
      blocks.push(
        <p
          key={index}
          className="mb-4 text-justify font-serif font-normal leading-relaxed"
          dangerouslySetInnerHTML={{ __html: parseInline(line) }}
        />
      );
      pushAfterRange(paragraphCursor, paragraphCursor, `after-paragraph-${index}`);
      paragraphCursor += 1;
    }

    index += 1;
  }

  return <div className={`article-copy font-serif ${className || ''}`}>{blocks}</div>;
};
