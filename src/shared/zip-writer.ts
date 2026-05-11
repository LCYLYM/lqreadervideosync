export interface ZipTextFile {
  path: string;
  content: string;
}

export interface ZipBinaryFile {
  path: string;
  bytes: Uint8Array;
}

export type ZipFileEntry = ZipTextFile | ZipBinaryFile;

const textEncoder = new TextEncoder();
const crc32Table = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { date: number; time: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function normalizeZipPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "_")
    .trim();
}

function resolveEntryBytes(entry: ZipFileEntry): Uint8Array {
  if ("bytes" in entry) {
    return entry.bytes;
  }
  return textEncoder.encode(entry.content);
}

export function createZipArchive(entries: ZipFileEntry[], date = new Date()): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralDirectoryChunks: Uint8Array[] = [];
  const timestamp = dosDateTime(date);
  let offset = 0;

  for (const entry of entries) {
    const fileName = normalizeZipPath(entry.path);
    if (!fileName) {
      continue;
    }
    const fileNameBytes = textEncoder.encode(fileName);
    const contentBytes = resolveEntryBytes(entry);
    const checksum = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, timestamp.time);
    writeUint16(localHeader, 12, timestamp.date);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, contentBytes.length);
    writeUint32(localHeader, 22, contentBytes.length);
    writeUint16(localHeader, 26, fileNameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileNameBytes, 30);

    chunks.push(localHeader, contentBytes);

    const centralDirectoryHeader = new Uint8Array(46 + fileNameBytes.length);
    writeUint32(centralDirectoryHeader, 0, 0x02014b50);
    writeUint16(centralDirectoryHeader, 4, 20);
    writeUint16(centralDirectoryHeader, 6, 20);
    writeUint16(centralDirectoryHeader, 8, 0x0800);
    writeUint16(centralDirectoryHeader, 10, 0);
    writeUint16(centralDirectoryHeader, 12, timestamp.time);
    writeUint16(centralDirectoryHeader, 14, timestamp.date);
    writeUint32(centralDirectoryHeader, 16, checksum);
    writeUint32(centralDirectoryHeader, 20, contentBytes.length);
    writeUint32(centralDirectoryHeader, 24, contentBytes.length);
    writeUint16(centralDirectoryHeader, 28, fileNameBytes.length);
    writeUint16(centralDirectoryHeader, 30, 0);
    writeUint16(centralDirectoryHeader, 32, 0);
    writeUint16(centralDirectoryHeader, 34, 0);
    writeUint16(centralDirectoryHeader, 36, 0);
    writeUint32(centralDirectoryHeader, 38, 0);
    writeUint32(centralDirectoryHeader, 42, offset);
    centralDirectoryHeader.set(fileNameBytes, 46);
    centralDirectoryChunks.push(centralDirectoryHeader);

    offset += localHeader.length + contentBytes.length;
  }

  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;
  for (const chunk of centralDirectoryChunks) {
    centralDirectorySize += chunk.length;
  }
  const endOfCentralDirectory = new Uint8Array(22);
  writeUint32(endOfCentralDirectory, 0, 0x06054b50);
  writeUint16(endOfCentralDirectory, 4, 0);
  writeUint16(endOfCentralDirectory, 6, 0);
  writeUint16(endOfCentralDirectory, 8, centralDirectoryChunks.length);
  writeUint16(endOfCentralDirectory, 10, centralDirectoryChunks.length);
  writeUint32(endOfCentralDirectory, 12, centralDirectorySize);
  writeUint32(endOfCentralDirectory, 16, centralDirectoryOffset);
  writeUint16(endOfCentralDirectory, 20, 0);

  const totalLength = [...chunks, ...centralDirectoryChunks, endOfCentralDirectory].reduce(
    (sum, chunk) => sum + chunk.length,
    0
  );
  const archive = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of [...chunks, ...centralDirectoryChunks, endOfCentralDirectory]) {
    archive.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return archive;
}
