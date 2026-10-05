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
 * @typedef {Object} ArchiveCheck Conferência do ZIP montado contra as conversas esperadas nele
 * @property {number} expected Conversas esperadas (chaves distintas)
 * @property {number} packed Conversas gravadas no ZIP, inclusive as de ZIP nativo ilegível
 * @property {string[]} missingKeys Chaves esperadas que ficaram fora do ZIP (ausentes do staging)
 * @property {string[]} unreadable Chaves cujo ZIP nativo estava ilegível e foi gravado como o arquivo original
 * @property {string[]} unexpected Chaves do staging que não eram esperadas, gravadas no ZIP mesmo assim
 */

/**
 * Linhas da seção "Conferência do ZIP" do relatório
 * @param {ArchiveCheck} check
 * @param {Object} details
 * @param {Array<{ key: string, title: string, reason: string }>} details.unreadable
 * @param {Array<{ key: string, title: string }>} details.unexpected
 * @returns {string[]}
 */
/**
 * A chave do staging é a posição na fila a partir de 000000; o relatório numera as conversas a partir de 1
 * @param {string} key
 * @returns {string}
 */
function describeStagingKey(key) {
  return /^\d+$/.test(key) ? `nº ${Number(key) + 1} (${key})` : key;
}

function buildCheckSection(check, { unreadable, unexpected }) {
  const diverges = check.missingKeys.length > 0 || unreadable.length > 0 || unexpected.length > 0;
  const lines = [
    `Conferência do ZIP: ${check.expected} conversa(s) esperada(s), ${check.packed} empacotada(s)` +
      (diverges ? '.' : '; sem divergência.')
  ];
  if (check.missingKeys.length) {
    lines.push(`- Esperada(s) e ausente(s) do staging, fora do ZIP (${check.missingKeys.length}): ${check.missingKeys.map(describeStagingKey).join(', ')}.`);
  }
  for (const { key, title, reason } of unreadable) {
    lines.push(`- ZIP nativo ilegível, gravado como o arquivo original na pasta da conversa: ${describeStagingKey(key)} "${title}". Motivo: ${reason}`);
  }
  if (unexpected.length) {
    const described = unexpected.map(({ key, title }) => `${describeStagingKey(key)} "${title}"`).join(', ');
    lines.push(`- No staging sem constar entre as esperadas, incluída(s) no ZIP mesmo assim (${unexpected.length}): ${described}.`);
  }
  if (diverges) {
    // O cabeçalho é montado antes do empacotamento e conta as salvas, não o que entrou no ZIP
    lines.push('- O "no ZIP" do cabeçalho conta as conversas salvas durante a extração; o que de fato está no ZIP é o total empacotado acima.');
  }
  return lines;
}

/**
 * ArchivePackager
 * Responsabilidade Única: Consolidar os arquivos do staging em um único ZIP master,
 * uma pasta por conversa, processando um registro por vez para limitar o uso de memória.
 */
export class ArchivePackager {
  /**
   * Monta o ZIP e acrescenta ao relatório a seção "Conferência do ZIP", que compara o que foi
   * empacotado com as conversas esperadas.
   * @param {Object} params
   * @param {string} [params.report] Conteúdo do relatório gravado na raiz do ZIP
   * @param {string[]} params.expectedKeys Chaves do staging que devem estar no ZIP
   * @returns {Promise<{ blob: Blob, chatCount: number, check: ArchiveCheck }>}
   */
  static async build({ report, expectedKeys } = {}) {
    // Sem a lista, uma conversa que sumiu do staging sairia do ZIP sem nenhum aviso
    if (!Array.isArray(expectedKeys)) {
      throw new Error('O empacotamento não recebeu a lista das conversas esperadas no ZIP (expectedKeys).');
    }
    const expected = new Set(expectedKeys);
    const writer = new ZipWriter();
    const usedFolders = new Set([REPORT_FILENAME.toLowerCase()]);
    const keys = await StagingRepository.listKeys();
    const packedKeys = new Set();
    const unreadable = [];
    const unexpected = [];

    for (const key of keys) {
      const record = await StagingRepository.getFile(key);
      if (!record) {
        // Se a chave era esperada, a conferência a lista como ausente
        log.warn(`Chave "${key}" listada no staging, mas sem registro na leitura; fica fora do ZIP.`);
        continue;
      }
      packedKeys.add(key);

      const title = record.chatTitle || record.chatId;
      if (!expected.has(key)) unexpected.push({ key, title });
      const folder = buildUniqueFolderName(title, usedFolders);
      const blob = record.blob instanceof Blob ? record.blob : new Blob([record.blob]);

      if (await ZipReader.isZipBlob(blob)) {
        try {
          // ZIP nativo (o WhatsApp Web exporta assim mesmo só com texto): copia as entradas como estão,
          // sem descompactar e recompactar
          const usedInner = new Set();
          for (const entry of await ZipReader.readRawEntries(blob)) {
            const innerName = buildUniqueFolderName(normalizeInnerEntryName(entry.path), usedInner);
            writer.addRawEntry({ ...entry, path: `${folder}/${innerName}` });
          }
          continue;
        } catch (err) {
          log.warn(`ZIP nativo de "${folder}" ilegível; mantendo o arquivo original:`, err);
          unreadable.push({ key, title, reason: err.message });
          await writer.addFile(`${folder}/${record.filename || 'exportacao.zip'}`, blob);
          continue;
        }
      }

      await writer.addFile(`${folder}/conversa.txt`, blob);
    }

    const check = {
      expected: expected.size,
      packed: packedKeys.size,
      missingKeys: [...expected].filter((key) => !packedKeys.has(key)),
      unreadable: unreadable.map(({ key }) => key),
      unexpected: unexpected.map(({ key }) => key)
    };
    const reportHead = report ? `${report.endsWith('\n') ? report : `${report}\n`}\n` : '';
    const checkSection = buildCheckSection(check, { unreadable, unexpected }).join('\n');
    await writer.addFile(REPORT_FILENAME, `${reportHead}${checkSection}\n`);

    return { blob: writer.finish(), chatCount: packedKeys.size, check };
  }
}
