import { ZipReader } from './zip-reader.js';
import { normalizeInnerEntryName } from './archive-packager.js';
import { parseChatText } from './chat-text-parser.js';

// Mesma regra do packager: a entrada que vira conversa.txt no ZIP final (_chat.txt ou chat.txt)
const CHAT_TEXT_ENTRY_NAME = normalizeInnerEntryName('_chat.txt');

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
export async function readChatText(blob) {
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
 * Inspeciona o arquivo exportado de uma conversa: se o texto veio em branco, quantas mensagens,
 * eventos de sistema e anexos omitidos ele tem, e as datas da primeira e da última linha.
 * As contagens saem do mesmo parser que lê as mensagens, para o índice e as mensagens nunca divergirem.
 * Lança erro se o ZIP estiver ilegível ou não tiver o texto da conversa.
 * @param {Blob} blob ZIP nativo do WhatsApp Web ou texto puro
 * @returns {Promise<ChatExportInspection>}
 */
export async function inspectChatExport(blob) {
  const bytes = await readChatText(blob);
  const parsed = parseChatText(new TextDecoder('utf-8').decode(bytes));
  return {
    isEmpty: parsed.isEmpty,
    textBytes: bytes.length,
    omittedMediaCount: parsed.omittedMediaCount,
    messageCount: parsed.messageCount,
    systemEventCount: parsed.systemEventCount,
    firstTimestamp: parsed.firstTimestamp,
    lastTimestamp: parsed.lastTimestamp
  };
}
