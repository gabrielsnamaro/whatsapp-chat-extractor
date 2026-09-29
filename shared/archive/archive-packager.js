import { ZipWriter } from './zip-builder.js';
import { ZipReader } from './zip-reader.js';
import { StagingRepository } from '../storage/staging-repository.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('ArchivePackager');

export const REPORT_FILENAME = '_relatorio.txt';

/**
 * Nome de pasta seguro e único (sem diferenciar maiúsculas) para uma conversa dentro do ZIP
 * @param {string} title
 * @param {Set<string>} usedNames Nomes já usados, em minúsculas (é atualizado)
 * @returns {string}
 */
export function buildUniqueFolderName(title, usedNames) {
  const safeTitle = String(title || 'conversa')
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/, '') // Windows não aceita pastas terminadas em ponto ou espaço
    .trim() || 'conversa';

  let folderName = safeTitle;
  let counter = 1;
  while (usedNames.has(folderName.toLowerCase())) {
    folderName = `${safeTitle}_${counter}`;
    counter++;
  }
  usedNames.add(folderName.toLowerCase());
  return folderName;
}

/**
 * Nome do arquivo interno de uma exportação nativa; o texto da conversa vira conversa.txt
 * @param {string} entryPath
 * @returns {string}
 */
export function normalizeInnerEntryName(entryPath) {
  const baseName = String(entryPath || '').split('/').pop().trim();
  const lower = baseName.toLowerCase();
  if (lower === '_chat.txt' || lower === 'chat.txt') return 'conversa.txt';
  return baseName || 'arquivo';
}

/**
 * ArchivePackager
 * Responsabilidade Única: Consolidar os arquivos do staging em um único ZIP master,
 * uma pasta por conversa, processando um registro por vez para limitar o uso de memória.
 */
export class ArchivePackager {
  /**
   * @param {Object} [params]
   * @param {string} [params.report] Conteúdo do relatório gravado na raiz do ZIP
   * @returns {Promise<{ blob: Blob, chatCount: number }>}
   */
  static async build({ report } = {}) {
    const writer = new ZipWriter();
    const usedFolders = new Set([REPORT_FILENAME.toLowerCase()]);
    const keys = await StagingRepository.listKeys();
    let chatCount = 0;

    for (const key of keys) {
      const record = await StagingRepository.getFile(key);
      if (!record) continue;
      chatCount++;

      const folder = buildUniqueFolderName(record.chatTitle || record.chatId, usedFolders);
      const blob = record.blob instanceof Blob ? record.blob : new Blob([record.blob]);

      if (await ZipReader.isZipBlob(blob)) {
        try {
          // Exportação com mídia: copia as entradas já comprimidas, sem descompactar e recompactar
          const usedInner = new Set();
          for (const entry of await ZipReader.readRawEntries(blob)) {
            const innerName = buildUniqueFolderName(normalizeInnerEntryName(entry.path), usedInner);
            writer.addRawEntry({ ...entry, path: `${folder}/${innerName}` });
          }
          continue;
        } catch (err) {
          log.warn(`ZIP nativo de "${folder}" ilegível; mantendo o arquivo original:`, err);
          await writer.addFile(`${folder}/${record.filename || 'exportacao.zip'}`, blob);
          continue;
        }
      }

      await writer.addFile(`${folder}/conversa.txt`, blob);
    }

    if (report) {
      await writer.addFile(REPORT_FILENAME, report);
    }

    return { blob: writer.finish(), chatCount };
  }
}
