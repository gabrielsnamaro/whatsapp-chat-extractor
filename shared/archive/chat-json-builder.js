import { phoneFromTitle } from '../utils/phone.js';

// Origem das conversas nos arquivos JSON: identifica esta extensão como a fonte dos dados
const SOURCE = 'WhatsAppWeb';

// Prefixo do chat_id numa execução sem a linha (iniciada por uma versão anterior da extensão)
const NO_LINE_PREFIX = 'sem-linha';

// Caracteres hexadecimais do SHA-256 que entram no chat_id de uma conversa sem telefone e no message_id
const TITLE_HASH_LENGTH = 16;
const MESSAGE_HASH_LENGTH = 32;

// Os mesmos caracteres invisíveis que o DomUtils.normalizeTitle tira dos títulos (content/dom/dom-utils.js; content script
// clássico não é importável aqui), inclusive os seletores de variação de emoji: o mesmo título lido de novo dá o mesmo hash
const INVISIBLE_TITLE_CHARS_PATTERN = /[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\uFE0E\uFE0F]/g;

// Tipo da conversa, como no resultado dela (DomUtils.CHAT_KINDS)
const CHAT_KIND = 'chat';
const GROUP_KIND = 'group';

// O telefone do contato veio do texto exportado: cabeçalho do chat.md ou remetente
const EXPORT_PHONE_SOURCE = 'export';

/**
 * @typedef {Object} RunMeta Dados da execução que o JSON leva
 * @property {string} runId O id da execução, o mesmo do _execucao.log
 * @property {string|null} linePhone A linha da execução; null numa execução iniciada por uma versão anterior da extensão
 * @property {string} extensionVersion A versão da extensão (manifest) que montou o ZIP; vai em cada conversa do JSON
 */

/**
 * @typedef {Object} ChatRecord Conversa no _conversas.jsonl, com os campos na ordem do formato descrito no README
 *   (seção "Arquivos JSON")
 * @property {string} chat_id
 * @property {string} source
 * @property {string|null} line_phone
 * @property {string|null} wa_chat_id
 * @property {'chat'|'group'|null} kind
 * @property {string} name
 * @property {string|null} contact_phone
 * @property {'title'|'contact_info'|'export'|null} contact_phone_source
 * @property {number} order
 * @property {string|null} folder
 * @property {string} export_status
 * @property {string|null} error_code
 * @property {number|null} message_count
 * @property {number|null} system_event_count
 * @property {number|null} omitted_media_count
 * @property {string|null} first_message_at
 * @property {string|null} last_message_at
 * @property {string} run_id
 * @property {string|null} exported_at
 * @property {string} time_zone
 * @property {string|null} parse_error Por que o texto da conversa, que está no ZIP, não foi lido ou interpretado
 * @property {string|null} extension_version A versão da extensão que montou o ZIP: a classificação das mensagens pode
 *   mudar de uma versão para outra
 */

/**
 * @typedef {Object} MessageRecord Mensagem ou evento no _mensagens.jsonl, com os campos na ordem do contrato
 * @property {string} message_id
 * @property {string} chat_id
 * @property {string|null} line_phone
 * @property {number} seq
 * @property {string|null} timestamp
 * @property {string} timestamp_raw
 * @property {string|null} sender_name
 * @property {string|null} sender_phone
 * @property {boolean|null} is_out
 * @property {string} msg_type
 * @property {string} text
 * @property {boolean} forwarded
 * @property {string|null} file_name
 * @property {boolean} edited
 */

/**
 * Título normalizado para o hash do chat_id: forma NFC, sem caracteres invisíveis, espaços colapsados e aparado
 * @param {string|null|undefined} title
 * @returns {string}
 */
function normalizeChatTitle(title) {
  return String(title ?? '')
    .normalize('NFC')
    .replace(INVISIBLE_TITLE_CHARS_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text
 * @returns {Promise<string>} SHA-256 do texto em UTF-8, em hexadecimal
 */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Data em ISO 8601 UTC sem os milissegundos ("2026-10-06T21:20:31Z"), como as datas que o parser converte
 * @param {string|null|undefined} value Data em ISO
 * @returns {string|null} null sem data, ou com uma data que não se lê (tentativa registrada sem o início)
 */
function toJsonTimestamp(value) {
  const ms = value == null ? Number.NaN : Date.parse(value);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 19)}Z` : null;
}

/**
 * Telefone do contato tirado do texto exportado, para a conversa individual que ficou sem ele: o do cabeçalho do chat.md
 * ("# Histórico de conversas do WhatsApp: <nome ou telefone>") e, sem ele, o do remetente, quando todos os que não são
 * "Você" têm o mesmo nome e esse nome é um telefone
 * @param {string|null} chatMarkdown
 * @param {import('./chat-text-parser.js').ChatTextEntry[]} entries
 * @returns {string|null}
 */
function exportedContactPhone(chatMarkdown, entries) {
  const header = (chatMarkdown ?? '').split('\n', 1)[0];
  const separatorAt = header.lastIndexOf(': ');
  const headerPhone = separatorAt === -1 ? null : phoneFromTitle(header.slice(separatorAt + 2));
  if (headerPhone) return headerPhone;

  const senders = new Set(entries.filter((entry) => entry.kind === 'message' && !entry.isOut).map((entry) => entry.senderName));
  return senders.size === 1 ? phoneFromTitle([...senders][0]) : null;
}

/**
 * Conversa do _conversas.jsonl, a partir da linha dela no índice e do texto lido no empacotamento. Sem arquivo no ZIP
 * (falha, não exportável, pasta Downloads), fica sem pasta, contagens e datas.
 * @param {Object} params
 * @param {import('./archive-packager.js').IndexRow} params.row
 * @param {RunMeta} params.runMeta
 * @param {string} params.timeZone Fuso em que o parser converteu as datas (o do runtime do empacotamento)
 * @param {string|null} [params.folder] Pasta da conversa no ZIP
 * @param {import('./chat-text-parser.js').ParsedChatText|null} [params.parsed] O texto da conversa interpretado; null
 *   quando não foi lido
 * @param {string|null} [params.chatMarkdown] O chat.md da exportação, quando ela tem
 * @param {string|null} [params.parseError] Por que o texto, que está no ZIP, não foi lido ou interpretado
 * @returns {Promise<ChatRecord>}
 */
export async function buildChatRecord({ row, runMeta, timeZone, folder = null, parsed = null, chatMarkdown = null, parseError = null }) {
  const linePhone = runMeta.linePhone ?? null;
  const kind = row.kind ?? null;
  const isGroup = kind === GROUP_KIND;
  let contactPhone = row.contactPhone ?? null;
  let contactPhoneSource = row.contactPhoneSource ?? null;
  // Só na conversa individual: num grupo, ou sem saber o tipo, o único remetente com nome de telefone pode ser um membro,
  // e o chat_id ficaria igual ao da conversa individual dele
  if (kind === CHAT_KIND && !contactPhone) {
    contactPhone = exportedContactPhone(chatMarkdown, parsed?.entries ?? []);
    contactPhoneSource = contactPhone ? EXPORT_PHONE_SOURCE : null;
  }
  // Sem telefone, o título identifica a conversa: o chat_id muda se o título mudar
  const chatKey = contactPhone && !isGroup
    ? contactPhone
    : `t${(await sha256Hex(normalizeChatTitle(row.title))).slice(0, TITLE_HASH_LENGTH)}`;
  const timestamps = (parsed?.entries ?? []).map((entry) => entry.timestamp).filter((timestamp) => timestamp !== null);

  return {
    chat_id: `${linePhone ?? NO_LINE_PREFIX}_${chatKey}`,
    source: SOURCE,
    line_phone: linePhone,
    wa_chat_id: isGroup ? null : contactPhone,
    kind,
    name: row.title,
    contact_phone: contactPhone,
    contact_phone_source: contactPhoneSource,
    order: row.order,
    folder,
    export_status: row.exportStatus,
    error_code: row.code ?? null,
    message_count: parsed?.messageCount ?? null,
    system_event_count: parsed?.systemEventCount ?? null,
    omitted_media_count: parsed?.omittedMediaCount ?? null,
    first_message_at: timestamps[0] ?? null,
    last_message_at: timestamps.at(-1) ?? null,
    run_id: runMeta.runId,
    exported_at: toJsonTimestamp(row.exportedAt),
    time_zone: timeZone,
    parse_error: parseError,
    extension_version: runMeta.extensionVersion ?? null
  };
}

/**
 * Telefone de quem mandou a mensagem
 * @param {ChatRecord} chat
 * @param {import('./chat-text-parser.js').ChatTextEntry} entry
 * @returns {string|null}
 */
function senderPhoneOf(chat, entry) {
  if (entry.kind === 'event') return null;
  if (entry.isOut) return chat.line_phone;
  // Numa conversa individual, quem não é "Você" é o contato; num grupo, ou sem saber o tipo, só o nome do remetente diz
  // o número, quando é um
  return chat.kind === CHAT_KIND ? chat.contact_phone : entry.senderPhone;
}

/**
 * Mensagens e eventos da conversa no _mensagens.jsonl, na ordem do texto. O message_id é o hash do chat_id, da data
 * bruta, do remetente, do texto e de quantas entradas anteriores da conversa têm os mesmos três: o mesmo histórico
 * exportado de novo dá os mesmos ids, e duas mensagens iguais no mesmo segundo ficam com ids diferentes
 * @param {ChatRecord} chat
 * @param {import('./chat-text-parser.js').ChatTextEntry[]} entries
 * @returns {Promise<MessageRecord[]>}
 */
export async function buildMessageRecords(chat, entries) {
  const occurrences = new Map();
  const hashInputs = entries.map((entry) => {
    const content = JSON.stringify([entry.timestampRaw, entry.senderName, entry.text]);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return JSON.stringify([chat.chat_id, entry.timestampRaw, entry.senderName, entry.text, occurrence]);
  });
  const hashes = await Promise.all(hashInputs.map(sha256Hex));

  return entries.map((entry, index) => ({
    message_id: hashes[index].slice(0, MESSAGE_HASH_LENGTH),
    chat_id: chat.chat_id,
    line_phone: chat.line_phone,
    seq: entry.seq,
    timestamp: entry.timestamp,
    timestamp_raw: entry.timestampRaw,
    sender_name: entry.senderName,
    sender_phone: senderPhoneOf(chat, entry),
    is_out: entry.isOut,
    msg_type: entry.msgType,
    text: entry.text,
    forwarded: entry.forwarded,
    file_name: entry.fileName,
    edited: entry.edited
  }));
}
