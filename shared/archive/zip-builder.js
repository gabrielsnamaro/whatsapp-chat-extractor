import { Logger } from '../utils/logger.js';

const log = new Logger('ZipBuilder');

// Tabela estática para cálculo de CRC32 padrão IEEE 802.3
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

export function calculateCrc32(uint8Array) {
  let crc = -1;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ uint8Array[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

const UINT32_MAX = 0xFFFFFFFF;
const UINT16_MAX = 0xFFFF;

// Formatos já comprimidos: deflate só gastaria CPU sem reduzir tamanho
const PRECOMPRESSED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif',
  'mp4', 'mov', 'm4v', '3gp', 'webm', 'mkv',
  'opus', 'ogg', 'oga', 'mp3', 'm4a', 'aac', 'amr',
  'zip', 'rar', '7z', 'gz', 'pdf', 'docx', 'xlsx', 'pptx'
]);

function isPrecompressedPath(path) {
  const match = /\.([a-z0-9]+)$/i.exec(path || '');
  return Boolean(match) && PRECOMPRESSED_EXTENSIONS.has(match[1].toLowerCase());
}

async function toUint8Array(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (Array.isArray(data)) return new Uint8Array(data);
  if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(0);
}

async function compressDeflateRaw(uint8Array) {
  const stream = new Blob([uint8Array]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

/**
 * Sanitiza o caminho de uma entrada para o padrão ZIP (barras normais, sem raiz absoluta)
 * @param {string} path Caminho do arquivo no zip (ex: "João/conversa.txt")
 * @returns {string}
 */
export function sanitizeZipPath(path) {
  if (!path || typeof path !== 'string') return 'arquivo.txt';
  return path
    .replace(/\\/g, '/')
    .replace(/[:*?"<>|]/g, '_')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/') || 'arquivo.txt';
}

/**
 * ZipWriter
 * Responsabilidade Única: Montar um arquivo .ZIP entrada por entrada, sem manter o
 * conteúdo inteiro em memória JS (cada parte vira um Blob), com suporte a ZIP64
 * (>4 GB ou >65.535 entradas) e cópia de entradas já comprimidas de outro ZIP.
 */
export class ZipWriter {
  /**
   * @param {Object} [options]
   * @param {Date} [options.date=new Date()] Data gravada nas entradas
   * @param {boolean} [options.forceZip64=false] Grava estruturas ZIP64 mesmo sem necessidade (usado em testes)
   */
  constructor({ date = new Date(), forceZip64 = false } = {}) {
    this._parts = [];
    this._centralEntries = [];
    this._offset = 0;
    this._dos = toDosDateTime(date);
    this._forceZip64 = forceZip64;
    this._encoder = new TextEncoder();
  }

  get entryCount() {
    return this._centralEntries.length;
  }

  /**
   * Adiciona um arquivo comprimindo com deflate quando vale a pena
   * @param {string} path
   * @param {string|Uint8Array|ArrayBuffer|Blob} content
   * @param {Object} [options]
   * @param {boolean} [options.compress] Força (true) ou impede (false) a compressão; padrão por extensão
   */
  async addFile(path, content, { compress } = {}) {
    const bytes = await toUint8Array(content);
    const crc32 = calculateCrc32(bytes);
    const shouldCompress = (compress ?? !isPrecompressedPath(path)) && bytes.length > 0;

    let data = bytes;
    let method = 0;
    if (shouldCompress) {
      try {
        const compressed = await compressDeflateRaw(bytes);
        if (compressed.length < bytes.length) {
          data = compressed;
          method = 8;
        }
      } catch (err) {
        log.warn(`Falha no deflate de ${path}; gravando sem compressão:`, err);
      }
    }

    this.addRawEntry({ path, method, crc32, compressedSize: data.length, uncompressedSize: bytes.length, data });
  }

  /**
   * Adiciona uma entrada cujos dados já estão no formato final (ex: copiada de outro ZIP)
   * @param {Object} entry
   * @param {string} entry.path
   * @param {number} entry.method 0 = store, 8 = deflate
   * @param {number} entry.crc32
   * @param {number} entry.compressedSize
   * @param {number} entry.uncompressedSize
   * @param {Uint8Array|Blob} entry.data
   */
  addRawEntry({ path, method, crc32, compressedSize, uncompressedSize, data }) {
    const pathBytes = this._encoder.encode(sanitizeZipPath(path));
    const localOffset = this._offset;
    const zip64 = this._forceZip64 || compressedSize >= UINT32_MAX || uncompressedSize >= UINT32_MAX;
    const versionNeeded = zip64 ? 45 : 20;

    // Cabeçalho local (30 bytes + nome + extra ZIP64 com os dois tamanhos)
    const localExtraLen = zip64 ? 20 : 0;
    const local = new Uint8Array(30 + pathBytes.length + localExtraLen);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, versionNeeded, true);
    lv.setUint16(6, 0x0800, true); // bit 11 = nomes em UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, this._dos.time, true);
    lv.setUint16(12, this._dos.date, true);
    lv.setUint32(14, crc32, true);
    lv.setUint32(18, zip64 ? UINT32_MAX : compressedSize, true);
    lv.setUint32(22, zip64 ? UINT32_MAX : uncompressedSize, true);
    lv.setUint16(26, pathBytes.length, true);
    lv.setUint16(28, localExtraLen, true);
    local.set(pathBytes, 30);
    if (zip64) {
      const extraAt = 30 + pathBytes.length;
      lv.setUint16(extraAt, 0x0001, true);
      lv.setUint16(extraAt + 2, 16, true);
      lv.setBigUint64(extraAt + 4, BigInt(uncompressedSize), true);
      lv.setBigUint64(extraAt + 12, BigInt(compressedSize), true);
    }

    this._parts.push(new Blob([local]), data instanceof Blob ? data : new Blob([data]));
    this._offset += local.length + compressedSize;

    this._centralEntries.push({ pathBytes, method, crc32, compressedSize, uncompressedSize, localOffset, versionNeeded });
  }

  /**
   * Fecha o arquivo gravando o diretório central
   * @returns {Blob}
   */
  finish() {
    const cdOffset = this._offset;
    let cdSize = 0;

    for (const entry of this._centralEntries) {
      const zip64 = this._forceZip64 || entry.compressedSize >= UINT32_MAX ||
                    entry.uncompressedSize >= UINT32_MAX || entry.localOffset >= UINT32_MAX;
      const extraLen = zip64 ? 28 : 0;
      const cd = new Uint8Array(46 + entry.pathBytes.length + extraLen);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, zip64 ? 45 : 20, true);
      cv.setUint16(6, zip64 ? 45 : entry.versionNeeded, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, entry.method, true);
      cv.setUint16(12, this._dos.time, true);
      cv.setUint16(14, this._dos.date, true);
      cv.setUint32(16, entry.crc32, true);
      cv.setUint32(20, zip64 ? UINT32_MAX : entry.compressedSize, true);
      cv.setUint32(24, zip64 ? UINT32_MAX : entry.uncompressedSize, true);
      cv.setUint16(28, entry.pathBytes.length, true);
      cv.setUint16(30, extraLen, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, zip64 ? UINT32_MAX : entry.localOffset, true);
      cd.set(entry.pathBytes, 46);
      if (zip64) {
        const extraAt = 46 + entry.pathBytes.length;
        cv.setUint16(extraAt, 0x0001, true);
        cv.setUint16(extraAt + 2, 24, true);
        cv.setBigUint64(extraAt + 4, BigInt(entry.uncompressedSize), true);
        cv.setBigUint64(extraAt + 12, BigInt(entry.compressedSize), true);
        cv.setBigUint64(extraAt + 20, BigInt(entry.localOffset), true);
      }
      this._parts.push(new Blob([cd]));
      cdSize += cd.length;
    }

    const count = this._centralEntries.length;
    const needsZip64End = this._forceZip64 || count >= UINT16_MAX || cdSize >= UINT32_MAX || cdOffset >= UINT32_MAX;

    if (needsZip64End) {
      const zip64EndOffset = cdOffset + cdSize;
      const end64 = new Uint8Array(56 + 20);
      const ev = new DataView(end64.buffer);
      // Registro de fim do diretório central ZIP64
      ev.setUint32(0, 0x06064b50, true);
      ev.setBigUint64(4, 44n, true);
      ev.setUint16(12, 45, true);
      ev.setUint16(14, 45, true);
      ev.setUint32(16, 0, true);
      ev.setUint32(20, 0, true);
      ev.setBigUint64(24, BigInt(count), true);
      ev.setBigUint64(32, BigInt(count), true);
      ev.setBigUint64(40, BigInt(cdSize), true);
      ev.setBigUint64(48, BigInt(cdOffset), true);
      // Localizador do registro ZIP64
      ev.setUint32(56, 0x07064b50, true);
      ev.setUint32(60, 0, true);
      ev.setBigUint64(64, BigInt(zip64EndOffset), true);
      ev.setUint32(72, 1, true);
      this._parts.push(new Blob([end64]));
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, needsZip64End ? UINT16_MAX : count, true);
    ev.setUint16(10, needsZip64End ? UINT16_MAX : count, true);
    ev.setUint32(12, needsZip64End ? UINT32_MAX : cdSize, true);
    ev.setUint32(16, needsZip64End ? UINT32_MAX : cdOffset, true);
    ev.setUint16(20, 0, true);
    this._parts.push(new Blob([eocd]));

    const zipBlob = new Blob(this._parts, { type: 'application/zip' });
    log.info(`Arquivo ZIP gerado com ${count} entrada(s) (${(zipBlob.size / 1024).toFixed(1)} KB)${needsZip64End ? ' [ZIP64]' : ''}.`);
    return zipBlob;
  }
}

/**
 * Atalho para montar um ZIP a partir de uma lista de arquivos em memória
 */
export class ZipBuilder {
  /**
   * @param {Array<{ path?: string, filename?: string, content?: any, blob?: any }>} files
   * @param {Object} [options={}]
   * @param {function(number, number, string): void} [options.onProgress] Callback de progresso
   * @param {boolean} [options.forceZip64=false]
   * @returns {Promise<Blob>}
   */
  static async buildArchive(files, options = {}) {
    const writer = new ZipWriter({ forceZip64: options.forceZip64 });
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = file.path || file.filename || `arquivo_${i + 1}.txt`;
      if (options.onProgress) options.onProgress(i + 1, files.length, path);
      await writer.addFile(path, file.content !== undefined ? file.content : (file.blob || ''));
    }
    return writer.finish();
  }
}
