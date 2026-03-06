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

const splitRow = (row: string) => {
  const trimmed = row.trim();
  let content = trimmed;
  if (content.startsWith('|')) content = content.slice(1);
  if (content.endsWith('|')) content = content.slice(0, -1);
  return content.split('|').map(cleanCell);
};

const TableRenderer: React.FC<{ lines: string[]; caption?: string }> = ({ lines, caption }) => {
  if (lines.length < 2) return null;

  const headerRow = splitRow(lines[0]);
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

  return (
    <div className="my-8 w-full overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm break-inside-avoid">
      {caption && (
        <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-center">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-700">{caption}</span>
        </div>
      )}
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            {normalizedHeader.map((header, index) => (
              <th
                key={index}
                className="border-b-2 border-slate-300 border-r border-slate-200 bg-slate-100 px-4 py-3 font-bold text-slate-700 last:border-r-0"
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
                  className="border-b border-r border-slate-200 px-4 py-2.5 align-top text-slate-700 last:border-r-0"
                >
                  <span dangerouslySetInnerHTML={{ __html: parseInline(cell) }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const MarkdownRenderer: React.FC<{ content: string; className?: string }> = ({ content, className }) => {
  if (!content) return null;

  const blocks: React.ReactNode[] = [];
  const lines = content.split('\n');

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index];
    const line = rawLine.trim();

    if (line.includes('|') && index + 1 < lines.length && lines[index + 1].trim().match(/^\|?[\s\-:|]+\|?$/)) {
      let caption: string | undefined;
      const prevLine = index > 0 ? lines[index - 1].trim() : '';
      if (prevLine.match(/^\*\*(图表|Table|Figure|Exhibit).*\*\*$/)) {
        caption = prevLine.replace(/\*\*/g, '');
      }

      const tableLines = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].trim().includes('|')) {
        tableLines.push(lines[index]);
        index += 1;
      }

      blocks.push(<TableRenderer key={`table-${index}`} lines={tableLines} caption={caption} />);
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
        <div key={`list-${index}`} className="my-4 break-inside-avoid">
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
          className="my-8 break-inside-avoid rounded-r-lg border-l-4 border-report-accent bg-slate-50 py-2 pl-6 font-serif text-lg italic leading-relaxed text-slate-600"
        >
          <p dangerouslySetInnerHTML={{ __html: parseInline(line.replace(/^>\s?/, '')) }} />
        </blockquote>
      );
      index += 1;
      continue;
    }

    if (line.match(/^\*\*(图表|Table|Figure|Exhibit).*\*\*$/)) {
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
          className="mb-4 break-inside-avoid text-justify font-serif leading-relaxed"
          dangerouslySetInnerHTML={{ __html: parseInline(line) }}
        />
      );
    }

    index += 1;
  }

  return <div className={`font-serif ${className || ''}`}>{blocks}</div>;
};
