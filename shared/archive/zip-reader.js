import { Logger } from '../utils/logger.js';

const log = new Logger('ZipReader');

/**
 * ZipReader
 * Responsabilidade Única: Leitura e extração de arquivos binários .ZIP
 * utilizando a API nativa DecompressionStream('deflate-raw') do navegador.
 * Permite descompactar arquivos sem qualquer biblioteca externa pesada.
 */
export class ZipReader {
  /**
   * Converte a entrada em Uint8Array uniforme
   * @private
   * @param {Blob|ArrayBuffer|Uint8Array|Array<number>} data
   * @returns {Promise<Uint8Array>}
   */
  static async _toUint8Array(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      return new Uint8Array(buffer);
    }
    if (Array.isArray(data)) {
      return new Uint8Array(data);
    }
    if (data && data.buffer instanceof ArrayBuffer) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    return new Uint8Array(0);
  }

  /**
   * Verifica se os dados binários correspondem a um arquivo ZIP válido (assinatura PK\x03\x04)
   * @param {Blob|ArrayBuffer|Uint8Array|Array<number>} data
   * @returns {boolean}
   */
  static isZip(data) {
    if (!data) return false;
    let bytes = null;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (Array.isArray(data)) {
      bytes = data;
    } else if (data.buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    if (!bytes || bytes.length < 4) return false;
    return bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;
  }

  /**
   * Descompacta um fluxo de bytes comprimido com DEFLATE (método 8)
   * @private
   * @param {Uint8Array} compressedBytes
   * @returns {Promise<Uint8Array>}
   */
  static async _decompressDeflate(compressedBytes) {
    try {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compressedBytes);
      writer.close();

      const chunks = [];
      const reader = ds.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const decompressed = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        decompressed.set(chunk, offset);
        offset += chunk.length;
      }
      return decompressed;
    } catch (err) {
      log.error('Falha ao descompactar fluxo DEFLATE:', err);
      throw err;
    }
  }

  /**
   * Extrai todos os arquivos contidos em um binário .ZIP
   * @param {Blob|ArrayBuffer|Uint8Array} zipData
   * @returns {Promise<Array<{ path: string, content: Uint8Array, size: number }>>}
   */
  static async extractEntries(zipData) {
    const bytes = await this._toUint8Array(zipData);
    if (!this.isZip(bytes)) {
      throw new Error('Dados fornecidos não possuem assinatura válida de arquivo ZIP.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder('utf-8');

    // 1. Tenta localizar o registro do Fim do Diretório Central (EOCD - 0x06054b50)
    let eocdOffset = -1;
    for (let i = bytes.byteLength - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    if (eocdOffset !== -1) {
      return this._extractFromCentralDirectory(bytes, view, eocdOffset, decoder);
    }

    // 2. Fallback: Se o EOCD não for localizado, percorre sequencialmente os Local File Headers (0x04034b50)
    return this._extractFromLocalHeaders(bytes, view, decoder);
  }

  /**
   * Extração padrão a partir do Diretório Central do ZIP
   * @private
   */
  static async _extractFromCentralDirectory(bytes, view, eocdOffset, decoder) {
    const totalEntries = view.getUint16(eocdOffset + 10, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);

    const entries = [];
    let currentCd = cdOffset;

    for (let i = 0; i < totalEntries; i++) {
      if (currentCd + 46 > bytes.byteLength) break;
      if (view.getUint32(currentCd, true) !== 0x02014b50) break; // Assinatura Central Directory

      const compMethod = view.getUint16(currentCd + 10, true);
      const compSize = view.getUint32(currentCd + 20, true);
      const uncompSize = view.getUint32(currentCd + 24, true);
      const fnLen = view.getUint16(currentCd + 28, true);
      const extraLen = view.getUint16(currentCd + 30, true);
      const commentLen = view.getUint16(currentCd + 32, true);
      const lfhOffset = view.getUint32(currentCd + 42, true);

      const fnBytes = bytes.subarray(currentCd + 46, currentCd + 46 + fnLen);
      const filePath = decoder.decode(fnBytes);

      // Pula diretórios vazios
      if (!filePath.endsWith('/')) {
        // Lê os offsets do Local File Header para localizar onde os dados binários iniciam
        const localFnLen = view.getUint16(lfhOffset + 26, true);
        const localExtraLen = view.getUint16(lfhOffset + 28, true);
        const dataStart = lfhOffset + 30 + localFnLen + localExtraLen;
        const compData = bytes.subarray(dataStart, dataStart + compSize);

        let decompressed;
        if (compMethod === 0) {
          decompressed = compData;
        } else if (compMethod === 8) {
          decompressed = await this._decompressDeflate(compData);
        } else {
          log.warn(`Método de compressão ${compMethod} não suportado para ${filePath}; mantendo bruto.`);
          decompressed = compData;
        }

        entries.push({
          path: filePath,
          content: decompressed,
          size: uncompSize || decompressed.length
        });
      }

      currentCd += 46 + fnLen + extraLen + commentLen;
    }

    return entries;
  }

  /**
   * Fallback sequencial por Local File Headers
   * @private
   */
  static async _extractFromLocalHeaders(bytes, view, decoder) {
    const entries = [];
    let offset = 0;

    while (offset + 30 < bytes.byteLength) {
      if (view.getUint32(offset, true) !== 0x04034b50) {
        break; // Não é mais um LFH
      }

      const compMethod = view.getUint16(offset + 8, true);
      const compSize = view.getUint32(offset + 18, true);
      const uncompSize = view.getUint32(offset + 22, true);
      const fnLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);

      const fnBytes = bytes.subarray(offset + 30, offset + 30 + fnLen);
      const filePath = decoder.decode(fnBytes);

      const dataStart = offset + 30 + fnLen + extraLen;
      const compData = bytes.subarray(dataStart, dataStart + compSize);

      if (!filePath.endsWith('/')) {
        let decompressed;
        if (compMethod === 0) {
          decompressed = compData;
        } else if (compMethod === 8) {
          decompressed = await this._decompressDeflate(compData);
        } else {
          decompressed = compData;
        }

        entries.push({
          path: filePath,
          content: decompressed,
          size: uncompSize || decompressed.length
        });
      }

      offset = dataStart + compSize;
    }

    return entries;
  }
}
