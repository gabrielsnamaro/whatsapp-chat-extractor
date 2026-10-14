import { ZipWriter, calculateCrc32 } from './zip-builder.js';
import { ZipReader } from './zip-reader.js';
import { parseChatText } from './chat-text-parser.js';
import { buildChatRecord, buildMessageRecords } from './chat-json-builder.js';
import { StagingRepository } from '../storage/staging-repository.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('ArchivePackager');

export const REPORT_FILENAME = '_relatorio.txt';
export const EXECUTION_LOG_FILENAME = '_execucao.log';
export const INDEX_FILENAME = '_indice.csv';
export const CHATS_JSON_FILENAME = '_conversas.jsonl';
export const MESSAGES_JSON_FILENAME = '_mensagens.jsonl';

// Entradas de texto de um ZIP nativo, pelo nome que elas têm nele (o nome no ZIP final pode ganhar um
// sufixo "_1" de desempate depois da extensão)
const TEXT_ENTRY_PATTERN = /\.(txt|md)$/i;

// Nome do texto da conversa no ZIP final: o _chat.txt de um ZIP nativo, ou o arquivo exportado quando não é ZIP
const CHAT_TEXT_FILENAME = 'conversa.txt';
// Versão em markdown do texto, que o WhatsApp grava ao lado do _chat.txt; para o JSON, só o cabeçalho dela serve
const CHAT_MARKDOWN_FILENAME = 'chat.md';

// Motivos do parse_error. O do ZIP sem o texto, como os do ZIP e do texto ilegíveis (montados com o erro), é o mesmo do
// inspetor (chat-export-inspector.js)
const MISSING_CHAT_TEXT_ERROR = 'O ZIP exportado não contém o texto da conversa (_chat.txt).';
const UNRECOGNIZED_FORMAT_ERROR = 'Formato do texto não reconhecido: nenhuma linha segue a forma "[data] Nome: texto" ou "[data] - evento".';
// Seguido da mensagem do erro inesperado na montagem do JSON de uma conversa
const INTERNAL_JSON_ERROR_PREFIX = 'erro interno ao montar o JSON: ';

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
  if (lower === '_chat.txt' || lower === 'chat.txt') return CHAT_TEXT_FILENAME;
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
 * @property {string[]} [jsonUnparsed] Chaves das conversas com arquivo no ZIP cujo texto não foi lido ou interpretado:
 *   ficam no _conversas.jsonl com o parse_error, sem mensagens no _mensagens.jsonl. Ausente quando o ZIP não leva o JSON
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
 * @property {string} exportStatus O status em código, para o JSON: saved, empty, saved_to_disk, not_exportable, failed
 *   ou not_processed
 * @property {'chat'|'group'|null} kind Tipo da conversa; null quando não se sabe
 * @property {string|null} contactPhone Telefone do contato (só os dígitos), do título ou do painel "Dados do contato"
 * @property {'title'|'contact_info'|null} contactPhoneSource
 * @property {string|null} exportedAt Início (ISO) da tentativa que recebeu o arquivo; null quando nenhuma recebeu
 */

/**
 * @typedef {Object} ChatJsonSummary O que foi para o JSON, na seção "Conferência do ZIP"
 * @property {number} chatCount Conversas no _conversas.jsonl
 * @property {number} messageCount Mensagens no _mensagens.jsonl
 * @property {number} eventCount Eventos no _mensagens.jsonl
 * @property {Array<{ key: string, title: string, reason: string }>} unparsed Conversas com arquivo no ZIP cujo texto não
 *   foi lido ou interpretado
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
 * @param {ChatJsonSummary|null} details.json null quando o ZIP não leva o JSON
 * @returns {string[]}
 */
function buildCheckSection(check, { unreadable, unexpected, crcMismatch, json }) {
  const unparsed = json?.unparsed ?? [];
  const diverges = check.missingKeys.length > 0 || unreadable.length > 0 || unexpected.length > 0 || crcMismatch.length > 0 ||
    unparsed.length > 0;
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
  if (json) {
    lines.push(
      `JSON: ${json.chatCount} conversa(s) em ${CHATS_JSON_FILENAME}; ` +
        `${json.messageCount} mensagem(ns) e ${json.eventCount} evento(s) em ${MESSAGES_JSON_FILENAME}.`
    );
    for (const { key, title, reason } of unparsed) {
      lines.push(
        `- Texto da conversa não interpretado, sem as mensagens no ${MESSAGES_JSON_FILENAME}: ` +
          `${describeStagingKey(key)} "${title}". Motivo: ${reason}`
      );
    }
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
 * JSON Lines: um objeto por linha, cada linha terminada em \n, inclusive a última
 * @param {Object[]} records
 * @returns {string}
 */
function toJsonLines(records) {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

/**
 * @typedef {Object} ChatTextSource O que o empacotamento guardou do arquivo de uma conversa para ler o texto dela: as
 *   entradas do ZIP nativo, os bytes do arquivo quando ele é o próprio texto, ou por que o ZIP nativo não pôde ser lido
 * @property {{ path: string, method: number, data: Uint8Array }|null} [textEntry] O _chat.txt (ou chat.txt) do ZIP nativo
 * @property {{ path: string, method: number, data: Uint8Array }|null} [markdownEntry] O chat.md do ZIP nativo
 * @property {Uint8Array} [textBytes] O arquivo exportado, quando ele não é ZIP
 * @property {string} [readError] Por que o ZIP nativo não pôde ser lido
 */

/**
 * O chat.md da exportação em texto. Ele só serve de reserva para o telefone do contato: uma falha na leitura fica no
 * log e não marca a conversa
 * @param {{ path: string, method: number, data: Uint8Array }} entry
 * @returns {Promise<string|null>}
 */
async function readChatMarkdown(entry) {
  try {
    return new TextDecoder('utf-8').decode(await ZipReader.decompressEntry(entry));
  } catch (err) {
    log.warn(`"${entry.path}" ilegível na exportação; o telefone do contato não sai dele:`, err);
    return null;
  }
}

/**
 * Lê e interpreta o texto da conversa para o JSON. Uma falha aqui não muda o que foi para o ZIP: a conversa fica sem as
 * mensagens, com o motivo. Texto em branco (exportação vazia) não é falha.
 * @param {ChatTextSource} source
 * @returns {Promise<{ parsed: import('./chat-text-parser.js').ParsedChatText|null, chatMarkdown: string|null, parseError: string|null }>}
 */
async function readChatSource({ textEntry = null, markdownEntry = null, textBytes = null, readError = null }) {
  const chatMarkdown = markdownEntry ? await readChatMarkdown(markdownEntry) : null;
  if (readError) return { parsed: null, chatMarkdown, parseError: readError };

  let bytes = textBytes;
  if (!bytes) {
    if (!textEntry) return { parsed: null, chatMarkdown, parseError: MISSING_CHAT_TEXT_ERROR };
    try {
      // O WhatsApp grava o texto sem compressão; com o CRC divergente, os dados são lidos como estão
      bytes = await ZipReader.decompressEntry(textEntry);
    } catch (err) {
      return {
        parsed: null,
        chatMarkdown,
        parseError: `O texto da conversa (${textEntry.path}) está ilegível no ZIP exportado (${err.message}).`
      };
    }
  }
  const parsed = parseChatText(new TextDecoder('utf-8').decode(bytes));
  return { parsed, chatMarkdown, parseError: parsed.isEmpty || parsed.recognized ? null : UNRECOGNIZED_FORMAT_ERROR };
}

/**
 * Junta o _conversas.jsonl e o _mensagens.jsonl durante o empacotamento. Cada conversa com arquivo é lida e convertida
 * na volta dela (add), para o texto de todas não ficar na memória ao mesmo tempo; as que não têm arquivo no ZIP entram
 * no fim (finish). As duas listas saem na ordem da fila.
 * @param {IndexRow[]} indexRows
 * @param {import('./chat-json-builder.js').RunMeta} runMeta
 */
function createChatJsonCollector(indexRows, runMeta) {
  // O parser converte as datas no fuso do runtime, que é este
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rowByKey = new Map(indexRows.filter((row) => row.chatId != null).map((row) => [row.chatId, row]));
  const chatByKey = new Map();
  const messagesByKey = new Map();
  const unparsed = [];
  let messageCount = 0;
  let eventCount = 0;

  /**
   * Conversa e mensagens do JSON de uma conversa com arquivo no ZIP. Um texto que não pôde ser lido ou interpretado
   * volta no parse_error, sem mensagens
   * @returns {Promise<{ chat: import('./chat-json-builder.js').ChatRecord, messages: { lines: string, messageCount: number, eventCount: number }|null }>}
   */
  async function convertChat(row, folder, source) {
    const { parsed, chatMarkdown, parseError } = await readChatSource(source);
    if (parseError) log.warn(`"${folder}": texto da conversa não interpretado, sem mensagens no ${MESSAGES_JSON_FILENAME}: ${parseError}`);
    const chat = await buildChatRecord({ row, runMeta, timeZone, folder, parsed, chatMarkdown, parseError });
    if (!parsed?.entries.length) return { chat, messages: null };
    const lines = toJsonLines(await buildMessageRecords(chat, parsed.entries));
    return { chat, messages: { lines, messageCount: parsed.messageCount, eventCount: parsed.systemEventCount } };
  }

  return {
    /**
     * @param {{ key: string, title: string, folder: string, source: ChatTextSource }} packed
     */
    async add({ key, title, folder, source }) {
      // Uma chave do staging fora da fila não tem linha no índice, nem conversa no JSON
      const row = rowByKey.get(key);
      if (!row) return;
      let converted;
      try {
        converted = await convertChat(row, folder, source);
      } catch (err) {
        // Um erro inesperado numa conversa não derruba o ZIP nem as outras: ela fica no _conversas.jsonl com o motivo, sem
        // mensagens, como uma de texto ilegível
        log.warn(`"${folder}": erro interno ao montar o JSON da conversa, que fica sem mensagens no ${MESSAGES_JSON_FILENAME}:`, err);
        const parseError = `${INTERNAL_JSON_ERROR_PREFIX}${err.message}`;
        converted = { chat: await buildChatRecord({ row, runMeta, timeZone, folder, parseError }), messages: null };
      }
      // O estado só muda com a conversa já montada, para uma falha no meio não deixar parte dela no JSON
      const { chat, messages } = converted;
      chatByKey.set(key, chat);
      if (chat.parse_error) unparsed.push({ key, title, reason: chat.parse_error });
      if (!messages) return;
      messagesByKey.set(key, new Blob([messages.lines]));
      messageCount += messages.messageCount;
      eventCount += messages.eventCount;
    },

    /**
     * @returns {Promise<{ chats: string, messages: Blob, summary: ChatJsonSummary }>}
     */
    async finish() {
      const chats = [];
      for (const row of indexRows) {
        // Sem arquivo no ZIP (falha, não exportável, pasta Downloads, ausente do staging): sem pasta nem contagens
        chats.push(chatByKey.get(row.chatId) ?? await buildChatRecord({ row, runMeta, timeZone }));
      }
      return {
        chats: toJsonLines(chats),
        messages: new Blob(indexRows.flatMap((row) => messagesByKey.get(row.chatId) ?? [])),
        summary: { chatCount: chats.length, messageCount, eventCount, unparsed }
      };
    }
  };
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
   * @param {import('./chat-json-builder.js').RunMeta} [params.runMeta] Dados da execução: com eles e as linhas do
   *   índice, o ZIP leva também o _conversas.jsonl e o _mensagens.jsonl na raiz
   * @returns {Promise<{ blob: Blob, chatCount: number, check: ArchiveCheck }>}
   */
  static async build({ report, expectedKeys, executionLog, indexRows, runMeta } = {}) {
    // Sem a lista, uma conversa que sumiu do staging sairia do ZIP sem nenhum aviso
    if (!Array.isArray(expectedKeys)) {
      throw new Error('O empacotamento não recebeu a lista das conversas esperadas no ZIP (expectedKeys).');
    }
    // Sem o id, as conversas do JSON sairiam sem o run_id
    if (indexRows && runMeta && !runMeta.runId) {
      throw new Error('O empacotamento recebeu os dados da execução sem o id dela (runMeta.runId).');
    }
    const json = indexRows && runMeta ? createChatJsonCollector(indexRows, runMeta) : null;
    const expected = new Set(expectedKeys);
    const writer = new ZipWriter();
    // Os arquivos da raiz ficam reservados: uma conversa com o mesmo nome vai para outra pasta
    const usedFolders = new Set(
      [REPORT_FILENAME, EXECUTION_LOG_FILENAME, INDEX_FILENAME, CHATS_JSON_FILENAME, MESSAGES_JSON_FILENAME]
        .map((name) => name.toLowerCase())
    );
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

      /** @type {ChatTextSource} */
      let source;
      if (await ZipReader.isZipBlob(blob)) {
        try {
          // ZIP nativo (o WhatsApp Web exporta assim mesmo só com texto): as entradas são copiadas sem
          // descompactar, menos o texto que ele grava sem compressão, comprimido aqui
          const usedInner = new Set();
          const mismatchedPaths = [];
          let textEntry = null;
          let markdownEntry = null;
          for (const entry of await ZipReader.readRawEntries(blob)) {
            const innerName = normalizeInnerEntryName(entry.path);
            // O texto é lido para o JSON só depois da cópia: uma falha nele não pode deixar a conversa pela metade no ZIP
            if (innerName === CHAT_TEXT_FILENAME) textEntry ??= entry;
            if (innerName.toLowerCase() === CHAT_MARKDOWN_FILENAME) markdownEntry ??= entry;
            const path = `${folder}/${buildUniqueFolderName(innerName, usedInner)}`;
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
          source = { textEntry, markdownEntry };
        } catch (err) {
          log.warn(`ZIP nativo de "${folder}" ilegível; mantendo o arquivo original:`, err);
          unreadable.push({ key, title, reason: err.message });
          await writer.addFile(`${folder}/${record.filename || 'exportacao.zip'}`, blob);
          source = { readError: `O ZIP exportado está ilegível (${err.message}).` };
        }
      } else {
        const textBytes = new Uint8Array(await blob.arrayBuffer());
        await writer.addFile(`${folder}/${CHAT_TEXT_FILENAME}`, textBytes);
        source = { textBytes };
      }

      await json?.add({ key, title, folder, source });
    }

    const jsonFiles = await json?.finish();
    const check = {
      expected: expected.size,
      packed: packedKeys.size,
      missingKeys: [...expected].filter((key) => !packedKeys.has(key)),
      unreadable: unreadable.map(({ key }) => key),
      unexpected: unexpected.map(({ key }) => key),
      crcMismatch: crcMismatch.map(({ key }) => key),
      ...(jsonFiles ? { jsonUnparsed: jsonFiles.summary.unparsed.map(({ key }) => key) } : {})
    };
    const reportHead = report ? `${report.endsWith('\n') ? report : `${report}\n`}\n` : '';
    const checkSection = buildCheckSection(check, { unreadable, unexpected, crcMismatch, json: jsonFiles?.summary ?? null }).join('\n');
    await writer.addFile(REPORT_FILENAME, `${reportHead}${checkSection}\n`);
    if (executionLog) await writer.addFile(EXECUTION_LOG_FILENAME, executionLog);
    if (indexRows) await writer.addFile(INDEX_FILENAME, buildIndexCsv(indexRows, folderByKey));
    if (jsonFiles) {
      await writer.addFile(CHATS_JSON_FILENAME, jsonFiles.chats);
      // Sem nenhuma mensagem, o arquivo existe e fica vazio
      await writer.addFile(MESSAGES_JSON_FILENAME, jsonFiles.messages);
    }

    return { blob: writer.finish(), chatCount: packedKeys.size, check };
  }
}
