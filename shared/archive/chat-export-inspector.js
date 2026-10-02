import { ZipReader } from './zip-reader.js';
import { normalizeInnerEntryName } from './archive-packager.js';

// Mesma regra do packager: a entrada que vira conversa.txt no ZIP final (_chat.txt ou chat.txt)
const CHAT_TEXT_ENTRY_NAME = normalizeInnerEntryName('_chat.txt');

// Marcadores que o WhatsApp põe no lugar da mídia. Lista fixa, dependente do português da interface,
// como os rótulos de botão que a automação procura
const OMITTED_MEDIA_PATTERN = /<[^<>]*(omitid|ocultad)[ao]>|<Mensagem de [aá]lbum>/gi;

// O que vem depois de "[data] ": "Nome: texto", ou "Nome:" sozinho quando o texto começa na linha
// seguinte. A data não é interpretada, para a contagem não depender do formato regional dela
const MESSAGE_PATTERN = /^[^:\n]+:( |$)/;
const SYSTEM_EVENT_PREFIX = '- ';

/**
 * @typedef {Object} ChatExportInspection
 * @property {boolean} isEmpty Texto da conversa em branco (só espaços e quebras de linha)
 * @property {number} textBytes Tamanho do texto da conversa, descompactado
 * @property {number|null} omittedMediaCount Marcadores de anexo
 * @property {number|null} messageCount
 * @property {number|null} systemEventCount
 * @property {string|null} firstTimestamp Texto entre colchetes da primeira linha reconhecida, sem interpretar
 * @property {string|null} lastTimestamp Idem, da última linha reconhecida
 *
 * As contagens e as datas ficam null quando o texto não está em branco mas nenhuma linha segue o
 * formato esperado (formato não reconhecido): zero afirmaria uma conversa sem mensagens.
 */

/**
 * Lê o texto da conversa: o _chat.txt de um ZIP nativo, ou o arquivo inteiro se não for ZIP
 * @param {Blob} blob
 * @returns {Promise<Uint8Array>}
 */
async function readChatText(blob) {
  if (!(await ZipReader.isZipBlob(blob))) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  let entries;
  try {
    entries = await ZipReader.readRawEntries(blob);
  } catch (err) {
    throw new Error(`O ZIP exportado está ilegível (${err.message}).`, { cause: err });
  }

  const chatEntry = entries.find((entry) => normalizeInnerEntryName(entry.path) === CHAT_TEXT_ENTRY_NAME);
  if (!chatEntry) {
    throw new Error('O ZIP exportado não contém o texto da conversa (_chat.txt).');
  }

  try {
    return await ZipReader.decompressEntry(chatEntry);
  } catch (err) {
    throw new Error(`O texto da conversa (${chatEntry.path}) está ilegível no ZIP exportado (${err.message}).`, { cause: err });
  }
}

/**
 * @param {string} line Linha sem a quebra de linha
 * @returns {'message'|'systemEvent'|null} null para continuação da linha anterior
 */
function classifyLine(line) {
  if (!line.startsWith('[')) return null;
  const end = line.indexOf('] ');
  if (end === -1) return null;
  const rest = line.slice(end + 2);
  if (rest.startsWith(SYSTEM_EVENT_PREFIX)) return 'systemEvent';
  if (MESSAGE_PATTERN.test(rest)) return 'message';
  return null;
}

function timestampOf(line) {
  return line.slice(1, line.indexOf(']'));
}

/**
 * Inspeciona o arquivo exportado de uma conversa: se o texto veio em branco, quantas mensagens,
 * eventos de sistema e anexos omitidos ele tem, e as datas da primeira e da última linha.
 * Lança erro se o ZIP estiver ilegível ou não tiver o texto da conversa.
 * @param {Blob} blob ZIP nativo do WhatsApp Web ou texto puro
 * @returns {Promise<ChatExportInspection>}
 */
export async function inspectChatExport(blob) {
  const bytes = await readChatText(blob);
  const text = new TextDecoder('utf-8').decode(bytes);
  const textBytes = bytes.length;

  if (text.trim() === '') {
    return {
      isEmpty: true,
      textBytes,
      omittedMediaCount: 0,
      messageCount: 0,
      systemEventCount: 0,
      firstTimestamp: null,
      lastTimestamp: null
    };
  }

  let messageCount = 0;
  let systemEventCount = 0;
  let firstLine = null;
  let lastLine = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const kind = classifyLine(line);
    if (!kind) continue;
    if (kind === 'message') messageCount++;
    else systemEventCount++;
    firstLine ??= line;
    lastLine = line;
  }

  if (!firstLine) {
    return {
      isEmpty: false,
      textBytes,
      omittedMediaCount: null,
      messageCount: null,
      systemEventCount: null,
      firstTimestamp: null,
      lastTimestamp: null
    };
  }

  return {
    isEmpty: false,
    textBytes,
    omittedMediaCount: text.match(OMITTED_MEDIA_PATTERN)?.length ?? 0,
    messageCount,
    systemEventCount,
    firstTimestamp: timestampOf(firstLine),
    lastTimestamp: timestampOf(lastLine)
  };
}
