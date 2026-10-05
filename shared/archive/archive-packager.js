import { ZipWriter, calculateCrc32 } from './zip-builder.js';
import { ZipReader } from './zip-reader.js';
import { StagingRepository } from '../storage/staging-repository.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('ArchivePackager');

export const REPORT_FILENAME = '_relatorio.txt';
export const EXECUTION_LOG_FILENAME = '_execucao.log';
export const INDEX_FILENAME = '_indice.csv';

// Entradas de texto de um ZIP nativo, pelo nome que elas têm nele (o nome no ZIP final pode ganhar um
// sufixo "_1" de desempate depois da extensão)
const TEXT_ENTRY_PATTERN = /\.(txt|md)$/i;

const INDEX_COLUMNS = [
  'Ordem', 'Título', 'Pasta', 'Status', 'Código', 'Tentativas', 'Bytes', 'Mensagens', 'Eventos de sistema',
  'Anexos omitidos', 'Primeira data', 'Última data', 'Duração (s)', 'Abertura'
];

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
 * @property {string[]} crcMismatch Chaves com alguma entrada de texto do ZIP nativo cujo CRC não confere com
 *   os dados dela, copiada como estava, sem compressão
 */

/**
 * @typedef {Object} IndexRow Linha do _indice.csv, uma por conversa da fila, montada pelo orquestrador; a
 *   pasta de cada conversa só se conhece no empacotamento
 * @property {string|null} chatId Chave do staging; null quando a conversa não tem arquivo nele (pasta vazia)
 * @property {number} order Posição na fila a partir de 1, como no relatório
 * @property {string} title
 * @property {string} status Marcação do relatório (OK, OK – VAZIA, NA PASTA DOWNLOADS, NÃO EXPORTÁVEL, FALHA ou NÃO PROCESSADA)
 * @property {string|null} code Código do erro da última tentativa
 * @property {number|null} attempts
 * @property {number|null} bytes Tamanho do arquivo exportado
 * @property {number|null} messageCount
 * @property {number|null} systemEventCount
 * @property {number|null} omittedMediaCount
 * @property {string|null} firstTimestamp Texto bruto, como o inspetor leu
 * @property {string|null} lastTimestamp Texto bruto, como o inspetor leu
 * @property {number|null} durationMs Soma das tentativas; null se alguma não tem a duração registrada
 * @property {string|null} via Como a aba abriu a conversa na última tentativa, no rótulo do log da execução
 */

/**
 * A chave do staging é a posição na fila a partir de 000000; o relatório numera as conversas a partir de 1
 * @param {string} key
 * @returns {string}
 */
function describeStagingKey(key) {
  return /^\d+$/.test(key) ? `nº ${Number(key) + 1} (${key})` : key;
}

/**
 * Linhas da seção "Conferência do ZIP" do relatório
 * @param {ArchiveCheck} check
 * @param {Object} details
 * @param {Array<{ key: string, title: string, reason: string }>} details.unreadable
 * @param {Array<{ key: string, title: string }>} details.unexpected
 * @param {Array<{ key: string, title: string, paths: string[] }>} details.crcMismatch Caminhos no ZIP final
 * @returns {string[]}
 */
function buildCheckSection(check, { unreadable, unexpected, crcMismatch }) {
  const diverges = check.missingKeys.length > 0 || unreadable.length > 0 || unexpected.length > 0 || crcMismatch.length > 0;
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
  for (const { key, title, paths } of crcMismatch) {
    lines.push(
      '- Texto com CRC que não confere com o conteúdo, copiado do ZIP nativo como estava, sem compressão (pode ter chegado corrompido): ' +
        `${describeStagingKey(key)} "${title}". Arquivo(s) no ZIP: ${paths.map((path) => `"${path}"`).join(', ')}.`
    );
  }
  if (unexpected.length) {
    const described = unexpected.map(({ key, title }) => `${describeStagingKey(key)} "${title}"`).join(', ');
    lines.push(`- No staging sem constar entre as esperadas, incluída(s) no ZIP mesmo assim (${unexpected.length}): ${described}.`);
  }
  // Só faz sentido quando a contagem muda: ilegível e CRC divergente entram no ZIP mesmo assim
  if (check.missingKeys.length > 0 || unexpected.length > 0) {
    // O cabeçalho é montado antes do empacotamento e conta as salvas, não o que entrou no ZIP
    lines.push('- O "no ZIP" do cabeçalho conta as conversas salvas durante a extração; o que de fato está no ZIP é o total empacotado acima.');
  }
  return lines;
}

/**
 * Campo do _indice.csv. Um texto que começa com +, =, - ou @ ganha um apóstrofo na frente, porque o Excel o
 * trataria como fórmula (a maioria dos títulos é telefone, "+55…"); com ;, aspas ou quebra de linha, vai
 * entre aspas, com as aspas dobradas.
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function csvField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[+=\-@]/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Segundos com uma casa decimal e vírgula, que o Excel em português lê como número (com ponto, "4.2"
 * viraria data)
 * @param {number|null} ms
 * @returns {string|null}
 */
function formatIndexSeconds(ms) {
  return Number.isFinite(ms) ? String(Number((ms / 1000).toFixed(1))).replace('.', ',') : null;
}

/**
 * Conteúdo do _indice.csv: separador ";" (no Excel em português a vírgula é a decimal), BOM para ele ler
 * os acentos como UTF-8 e CRLF entre as linhas
 * @param {IndexRow[]} rows
 * @param {Map<string, string>} folderByKey Pasta de cada chave do staging no ZIP
 * @returns {string}
 */
function buildIndexCsv(rows, folderByKey) {
  const lines = [
    INDEX_COLUMNS,
    ...rows.map((row) => [
      row.order,
      row.title,
      folderByKey.get(row.chatId) ?? null,
      row.status,
      row.code,
      row.attempts,
      row.bytes,
      row.messageCount,
      row.systemEventCount,
      row.omittedMediaCount,
      row.firstTimestamp,
      row.lastTimestamp,
      formatIndexSeconds(row.durationMs),
      row.via
    ])
  ];
  return `\uFEFF${lines.map((cells) => cells.map(csvField).join(';')).join('\r\n')}\r\n`;
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
   * @param {string} [params.executionLog] Log da execução, gravado na raiz do ZIP quando houver
   * @param {IndexRow[]} [params.indexRows] Linhas do _indice.csv, gravado na raiz do ZIP quando houver
   * @returns {Promise<{ blob: Blob, chatCount: number, check: ArchiveCheck }>}
   */
  static async build({ report, expectedKeys, executionLog, indexRows } = {}) {
    // Sem a lista, uma conversa que sumiu do staging sairia do ZIP sem nenhum aviso
    if (!Array.isArray(expectedKeys)) {
      throw new Error('O empacotamento não recebeu a lista das conversas esperadas no ZIP (expectedKeys).');
    }
    const expected = new Set(expectedKeys);
    const writer = new ZipWriter();
    // Os arquivos da raiz ficam reservados: uma conversa com o mesmo nome vai para outra pasta
    const usedFolders = new Set([REPORT_FILENAME, EXECUTION_LOG_FILENAME, INDEX_FILENAME].map((name) => name.toLowerCase()));
    const keys = await StagingRepository.listKeys();
    const packedKeys = new Set();
    const folderByKey = new Map();
    const unreadable = [];
    const unexpected = [];
    const crcMismatch = [];

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
      folderByKey.set(key, folder);
      const blob = record.blob instanceof Blob ? record.blob : new Blob([record.blob]);

      if (await ZipReader.isZipBlob(blob)) {
        try {
          // ZIP nativo (o WhatsApp Web exporta assim mesmo só com texto): as entradas são copiadas sem
          // descompactar, menos o texto que ele grava sem compressão, comprimido aqui
          const usedInner = new Set();
          const mismatchedPaths = [];
          for (const entry of await ZipReader.readRawEntries(blob)) {
            const path = `${folder}/${buildUniqueFolderName(normalizeInnerEntryName(entry.path), usedInner)}`;
            if (entry.method === 0 && TEXT_ENTRY_PATTERN.test(entry.path)) {
              // Fica o CRC original, e só depois de conferido contra os dados: recalculado, ele passaria a
              // confirmar um texto que chegou corrompido
              if (calculateCrc32(entry.data) === entry.crc32) {
                await writer.addFile(path, entry.data, { compress: true, crc32: entry.crc32 });
                continue;
              }
              mismatchedPaths.push(path);
            }
            writer.addRawEntry({ ...entry, path });
          }
          if (mismatchedPaths.length) {
            log.warn(`"${folder}": ${mismatchedPaths.length} texto(s) com CRC que não confere, copiado(s) como estava(m).`);
            crcMismatch.push({ key, title, paths: mismatchedPaths });
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
      unexpected: unexpected.map(({ key }) => key),
      crcMismatch: crcMismatch.map(({ key }) => key)
    };
    const reportHead = report ? `${report.endsWith('\n') ? report : `${report}\n`}\n` : '';
    const checkSection = buildCheckSection(check, { unreadable, unexpected, crcMismatch }).join('\n');
    await writer.addFile(REPORT_FILENAME, `${reportHead}${checkSection}\n`);
    if (executionLog) await writer.addFile(EXECUTION_LOG_FILENAME, executionLog);
    if (indexRows) await writer.addFile(INDEX_FILENAME, buildIndexCsv(indexRows, folderByKey));

    return { blob: writer.finish(), chatCount: packedKeys.size, check };
  }
}
