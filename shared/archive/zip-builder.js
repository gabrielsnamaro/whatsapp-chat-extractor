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

function calculateCrc32(uint8Array) {
  let crc = -1;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ uint8Array[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
 * Construtor nativo de arquivos .ZIP padrão PK (zero dependências externas).
 * Utiliza CompressionStream('deflate-raw') nativo do navegador para alta performance.
 */
export class ZipBuilder {
  /**
   * Converte qualquer formato de entrada em Uint8Array
   * @private
   */
  static async _toUint8Array(data) {
    if (typeof data === 'string') {
      return new TextEncoder().encode(data);
    }
    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      return new Uint8Array(buffer);
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (data instanceof Uint8Array) {
      return data;
    }
    return new Uint8Array(0);
  }

  /**
   * Compacta dados com DEFLATE nativo via CompressionStream
   * @private
   */
  static async _compressDeflate(uint8Array) {
    try {
      const cs = new CompressionStream('deflate-raw');
      const writer = cs.writable.getWriter();
      writer.write(uint8Array);
      writer.close();

      const chunks = [];
      const reader = cs.readable.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      const compressed = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        compressed.set(chunk, offset);
        offset += chunk.length;
      }
      return { compressed, compressionMethod: 8 }; // 8 = Deflated
    } catch (err) {
      // Fallback para Store (sem compressão)
      log.warn('Falha no CompressionStream; utilizando Store (sem compressão):', err);
      return { compressed: uint8Array, compressionMethod: 0 }; // 0 = Stored
    }
  }

  /**
   * Sanitiza o nome do diretório/arquivo para o padrão de arquivo ZIP
   * @param {string} path Caminho do arquivo no arquivo zip (ex: "chats/João/conversa.txt")
   * @returns {string}
   */
  static sanitizeZipPath(path) {
    return path
      .replace(/[\\:*?"<>|]/g, '_')
      .replace(/^\/+/, '');
  }

  /**
   * Compila um arquivo .ZIP a partir de uma lista de arquivos
   * @param {Array<{ path: string, content: string|Blob|ArrayBuffer|Uint8Array }>} files
   * @param {Object} [options={}]
   * @param {function(number, number, string): void} [options.onProgress] Callback de progresso
   * @returns {Promise<Blob>}
   */
  static async buildArchive(files, options = {}) {
    log.info(`Iniciando compilação do arquivo ZIP com ${files.length} arquivos...`);

    const localHeaders = [];
    const centralDirectoryEntries = [];
    let currentOffset = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const sanitizedPath = this.sanitizeZipPath(file.path);
      const pathBytes = new TextEncoder().encode(sanitizedPath);

      if (options.onProgress) {
        options.onProgress(i + 1, files.length, sanitizedPath);
      }

      const rawBytes = await this._toUint8Array(file.content);
      const uncompressedSize = rawBytes.length;
      const crc = calculateCrc32(rawBytes);

      const { compressed, compressionMethod } = await this._compressDeflate(rawBytes);
      const compressedSize = compressed.length;

      // 1. Cabeçalho local de arquivo (Local File Header - 30 bytes)
      const localHeader = new Uint8Array(30 + pathBytes.length);
      const lv = new DataView(localHeader.buffer);

      lv.setUint32(0, 0x04034b50, true); // Assinatura PK\x03\x04
      lv.setUint16(4, 20, true);         // Versão necessária (2.0)
      lv.setUint16(6, 0x0800, true);     // Flags (bit 11 = UTF-8 filenames)
      lv.setUint16(8, compressionMethod, true); // Método de compressão
      lv.setUint16(10, 0, true);         // Hora DOS
      lv.setUint16(12, 0, true);         // Data DOS
      lv.setUint32(14, crc, true);       // CRC32
      lv.setUint32(18, compressedSize, true); // Tamanho comprimido
      lv.setUint32(22, uncompressedSize, true); // Tamanho descomprimido
      lv.setUint16(26, pathBytes.length, true); // Comprimento do nome do arquivo
      lv.setUint16(28, 0, true);         // Comprimento do campo extra
      localHeader.set(pathBytes, 30);

      localHeaders.push(localHeader, compressed);

      // 2. Entrada do Diretório Central (Central Directory Entry - 46 bytes)
      const cdEntry = new Uint8Array(46 + pathBytes.length);
      const cv = new DataView(cdEntry.buffer);

      cv.setUint32(0, 0x02014b50, true); // Assinatura PK\x01\x02
      cv.setUint16(4, 20, true);         // Versão feita por
      cv.setUint16(6, 20, true);         // Versão necessária
      cv.setUint16(8, 0x0800, true);     // Flags (UTF-8)
      cv.setUint16(10, compressionMethod, true);
      cv.setUint16(12, 0, true);         // Hora DOS
      cv.setUint16(14, 0, true);         // Data DOS
      cv.setUint32(16, crc, true);
      cv.setUint32(20, compressedSize, true);
      cv.setUint32(24, uncompressedSize, true);
      cv.setUint16(28, pathBytes.length, true);
      cv.setUint16(30, 0, true);         // Campo extra
      cv.setUint16(32, 0, true);         // Comentário
      cv.setUint16(34, 0, true);         // Número do disco
      cv.setUint16(36, 0, true);         // Atributos internos
      cv.setUint32(38, 0, true);         // Atributos externos
      cv.setUint32(42, currentOffset, true); // Offset relativo do cabeçalho local
      cdEntry.set(pathBytes, 46);

      centralDirectoryEntries.push(cdEntry);

      currentOffset += localHeader.length + compressed.length;
    }

    // 3. Fim do Diretório Central (End of Central Directory Record - 22 bytes)
    const cdOffset = currentOffset;
    let cdSize = 0;
    for (const entry of centralDirectoryEntries) {
      cdSize += entry.length;
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);  // Assinatura PK\x05\x06
    ev.setUint16(4, 0, true);          // Número do disco
    ev.setUint16(6, 0, true);          // Disco onde o diretório central começa
    ev.setUint16(8, files.length, true); // Registros neste disco
    ev.setUint16(10, files.length, true); // Total de registros
    ev.setUint32(12, cdSize, true);    // Tamanho do diretório central
    ev.setUint32(16, cdOffset, true);  // Offset do diretório central
    ev.setUint16(20, 0, true);         // Tamanho do comentário

    const allParts = [...localHeaders, ...centralDirectoryEntries, eocd];
    const zipBlob = new Blob(allParts, { type: 'application/zip' });

    log.info(`Arquivo ZIP gerado com sucesso (${(zipBlob.size / 1024).toFixed(1)} KB).`);
    return zipBlob;
  }
}
