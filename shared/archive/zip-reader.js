import { Logger } from '../utils/logger.js';

const log = new Logger('ZipReader');

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_ENTRY = 0x02014b50;
const SIG_END_OF_CENTRAL_DIR = 0x06054b50;

/**
 * ZipReader
 * Responsabilidade Única: Leitura de arquivos .ZIP (como os exportados pelo WhatsApp Web)
 * sem bibliotecas externas, usando DecompressionStream('deflate-raw') nativo.
 */
export class ZipReader {
  /**
   * Converte a entrada em Uint8Array uniforme
   * @private
   * @param {Blob|ArrayBuffer|Uint8Array|Array<number>} data
   * @returns {Promise<Uint8Array>}
   */
  static async _toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (Array.isArray(data)) return new Uint8Array(data);
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(0);
  }

  /**
   * Verifica a assinatura PK\x03\x04 no início dos dados
   * @param {Uint8Array|ArrayBuffer|Array<number>} data
   * @returns {boolean}
   */
  static isZip(data) {
    if (!data) return false;
    let bytes = null;
    if (data instanceof Uint8Array || Array.isArray(data)) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data.buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (!bytes || bytes.length < 4) return false;
    return bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  /**
   * Verifica a assinatura ZIP de um Blob lendo só os 4 primeiros bytes
   * @param {Blob} blob
   * @returns {Promise<boolean>}
   */
  static async isZipBlob(blob) {
    if (!blob || blob.size < 4) return false;
    return this.isZip(new Uint8Array(await blob.slice(0, 4).arrayBuffer()));
  }

  /**
   * Descompacta um fluxo DEFLATE bruto (método 8)
   * @private
   * @param {Uint8Array} compressedBytes
   * @returns {Promise<Uint8Array>}
   */
  static async _decompressDeflate(compressedBytes) {
    const stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * Lista as entradas do ZIP com os dados ainda comprimidos, prontos para serem copiados
   * para outro ZIP sem descompactar e recompactar.
   * @param {Blob|ArrayBuffer|Uint8Array} zipData
   * @returns {Promise<Array<{ path: string, method: number, crc32: number, compressedSize: number, uncompressedSize: number, data: Uint8Array }>>}
   */
  static async readRawEntries(zipData) {
    const bytes = await this._toUint8Array(zipData);
    if (!this.isZip(bytes)) {
      throw new Error('Dados fornecidos não possuem assinatura válida de arquivo ZIP.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8');

    // O EOCD fica nos últimos 22 bytes + até 64 KB de comentário
    let eocdOffset = -1;
    const searchFloor = Math.max(0, bytes.byteLength - 22 - 0xFFFF);
    for (let i = bytes.byteLength - 22; i >= searchFloor; i--) {
      if (view.getUint32(i, true) === SIG_END_OF_CENTRAL_DIR) {
        eocdOffset = i;
        break;
      }
    }

    return eocdOffset !== -1
      ? this._readFromCentralDirectory(bytes, view, eocdOffset, decoder)
      : this._readFromLocalHeaders(bytes, view, decoder);
  }

  /**
   * Extrai todos os arquivos contidos em um binário .ZIP, descompactados
   * @param {Blob|ArrayBuffer|Uint8Array} zipData
   * @returns {Promise<Array<{ path: string, content: Uint8Array, size: number }>>}
   */
  static async extractEntries(zipData) {
    const entries = [];
    for (const entry of await this.readRawEntries(zipData)) {
      let content = entry.data;
      if (entry.method === 8) {
        content = await this._decompressDeflate(entry.data);
      } else if (entry.method !== 0) {
        log.warn(`Método de compressão ${entry.method} não suportado para ${entry.path}; mantendo bruto.`);
      }
      entries.push({ path: entry.path, content, size: entry.uncompressedSize || content.length });
    }
    return entries;
  }

  /**
   * Leitura padrão a partir do Diretório Central. É a fonte confiável de tamanhos
   * quando as entradas usam data descriptor (bit 3), comum em ZIPs gerados em streaming.
   * @private
   */
  static _readFromCentralDirectory(bytes, view, eocdOffset, decoder) {
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    let cursor = view.getUint32(eocdOffset + 16, true);
    const entries = [];

    for (let i = 0; i < totalEntries; i++) {
      if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== SIG_CENTRAL_ENTRY) break;

      const method = view.getUint16(cursor + 10, true);
      const crc32 = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const fnLen = view.getUint16(cursor + 28, true);
      const extraLen = view.getUint16(cursor + 30, true);
      const commentLen = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + fnLen));

      if (!path.endsWith('/')) {
        const localFnLen = view.getUint16(localOffset + 26, true);
        const localExtraLen = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + localFnLen + localExtraLen;
        entries.push({
          path,
          method,
          crc32,
          compressedSize,
          uncompressedSize,
          data: bytes.subarray(dataStart, dataStart + compressedSize)
        });
      }

      cursor += 46 + fnLen + extraLen + commentLen;
    }

    return entries;
  }

  /**
   * Fallback sequencial por Local File Headers quando o EOCD não é localizado
   * @private
   */
  static _readFromLocalHeaders(bytes, view, decoder) {
    const entries = [];
    let offset = 0;

    while (offset + 30 < bytes.byteLength && view.getUint32(offset, true) === SIG_LOCAL_HEADER) {
      const method = view.getUint16(offset + 8, true);
      const crc32 = view.getUint32(offset + 14, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const fnLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const path = decoder.decode(bytes.subarray(offset + 30, offset + 30 + fnLen));
      const dataStart = offset + 30 + fnLen + extraLen;

      if (!path.endsWith('/')) {
        entries.push({
          path,
          method,
          crc32,
          compressedSize,
          uncompressedSize,
          data: bytes.subarray(dataStart, dataStart + compressedSize)
        });
      }
      offset = dataStart + compressedSize;
    }

    return entries;
  }
}
