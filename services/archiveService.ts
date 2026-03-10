export interface ArchiveEntry {
  path: string;
  data: Uint8Array;
  lastModified?: Date;
}

const textEncoder = new TextEncoder();
const ZIP_SIGNATURES = {
  localFileHeader: 0x04034b50,
  centralDirectoryHeader: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
};
const ZIP_FLAGS_UTF8 = 0x0800;
const ZIP_STORE_METHOD = 0;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const writeUint16 = (target: Uint8Array, offset: number, value: number) => {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
};

const writeUint32 = (target: Uint8Array, offset: number, value: number) => {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
};

const normalizeArchivePath = (value: string) =>
  String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');

const toDosDateTime = (input?: Date) => {
  const source = input instanceof Date && !Number.isNaN(input.getTime()) ? input : new Date();
  const year = Math.min(Math.max(source.getFullYear(), 1980), 2107);
  const month = source.getMonth() + 1;
  const day = source.getDate();
  const hours = source.getHours();
  const minutes = source.getMinutes();
  const seconds = Math.floor(source.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
};

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

export const encodeTextArchiveEntry = (path: string, content: string, lastModified?: Date): ArchiveEntry => ({
  path,
  data: textEncoder.encode(String(content || '').replace(/\r\n/g, '\n')),
  lastModified,
});

export const downloadBlob = (filename: string, blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const buildZipArchive = (entries: ArchiveEntry[]) => {
  const files = entries
    .map((entry) => {
      const path = normalizeArchivePath(entry.path);
      if (!path) return null;
      const fileName = textEncoder.encode(path);
      const content = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || []);
      const modified = toDosDateTime(entry.lastModified);
      return {
        path,
        fileName,
        content,
        crc: crc32(content),
        modified,
      };
    })
    .filter(Boolean) as Array<{
    path: string;
    fileName: Uint8Array;
    content: Uint8Array;
    crc: number;
    modified: { time: number; date: number };
  }>;

  let localDirectorySize = 0;
  let centralDirectorySize = 0;
  const offsets: number[] = [];

  files.forEach((file) => {
    offsets.push(localDirectorySize);
    localDirectorySize += 30 + file.fileName.length + file.content.length;
    centralDirectorySize += 46 + file.fileName.length;
  });

  const output = new Uint8Array(localDirectorySize + centralDirectorySize + 22);
  let cursor = 0;

  files.forEach((file) => {
    writeUint32(output, cursor, ZIP_SIGNATURES.localFileHeader);
    writeUint16(output, cursor + 4, 20);
    writeUint16(output, cursor + 6, ZIP_FLAGS_UTF8);
    writeUint16(output, cursor + 8, ZIP_STORE_METHOD);
    writeUint16(output, cursor + 10, file.modified.time);
    writeUint16(output, cursor + 12, file.modified.date);
    writeUint32(output, cursor + 14, file.crc);
    writeUint32(output, cursor + 18, file.content.length);
    writeUint32(output, cursor + 22, file.content.length);
    writeUint16(output, cursor + 26, file.fileName.length);
    writeUint16(output, cursor + 28, 0);
    output.set(file.fileName, cursor + 30);
    output.set(file.content, cursor + 30 + file.fileName.length);
    cursor += 30 + file.fileName.length + file.content.length;
  });

  const centralDirectoryOffset = cursor;

  files.forEach((file, index) => {
    writeUint32(output, cursor, ZIP_SIGNATURES.centralDirectoryHeader);
    writeUint16(output, cursor + 4, 20);
    writeUint16(output, cursor + 6, 20);
    writeUint16(output, cursor + 8, ZIP_FLAGS_UTF8);
    writeUint16(output, cursor + 10, ZIP_STORE_METHOD);
    writeUint16(output, cursor + 12, file.modified.time);
    writeUint16(output, cursor + 14, file.modified.date);
    writeUint32(output, cursor + 16, file.crc);
    writeUint32(output, cursor + 20, file.content.length);
    writeUint32(output, cursor + 24, file.content.length);
    writeUint16(output, cursor + 28, file.fileName.length);
    writeUint16(output, cursor + 30, 0);
    writeUint16(output, cursor + 32, 0);
    writeUint16(output, cursor + 34, 0);
    writeUint16(output, cursor + 36, 0);
    writeUint32(output, cursor + 38, 0);
    writeUint32(output, cursor + 42, offsets[index]);
    output.set(file.fileName, cursor + 46);
    cursor += 46 + file.fileName.length;
  });

  writeUint32(output, cursor, ZIP_SIGNATURES.endOfCentralDirectory);
  writeUint16(output, cursor + 4, 0);
  writeUint16(output, cursor + 6, 0);
  writeUint16(output, cursor + 8, files.length);
  writeUint16(output, cursor + 10, files.length);
  writeUint32(output, cursor + 12, centralDirectorySize);
  writeUint32(output, cursor + 16, centralDirectoryOffset);
  writeUint16(output, cursor + 20, 0);

  return new Blob([output], { type: 'application/zip' });
};
