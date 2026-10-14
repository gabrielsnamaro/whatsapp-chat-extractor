import { phoneFromTitle } from '../utils/phone.js';

// Marcadores que o WhatsApp põe no lugar da mídia. Lista fixa, dependente do português da interface,
// como os rótulos de botão que a automação procura
const OMITTED_MEDIA_PATTERN = /<[^<>]*(omitid|ocultad)[ao]>|<Mensagem de [aá]lbum>/gi;

// Uma linha abre uma entrada pela forma "[data] ...". O que vem depois de "[data] " é "- evento", "Nome: texto", ou
// "Nome:" sozinho quando o texto começa na linha seguinte. Com alguma data no formato esperado no arquivo, só o colchete
// com data abre entrada (parseChatText); sem nenhuma, vale qualquer colchete, para a contagem não depender do formato
// regional da data
const MESSAGE_PATTERN = /^([^:\n]+):( |$)/;
const SYSTEM_EVENT_PREFIX = '- ';

// "M/D/AA, H:MM:SS AM", o formato das exportações mesmo com a interface em português, ou
// "D/M/AAAA, HH:MM:SS", em 24 h. Qual dos dois primeiros números é o mês se decide por arquivo
const DATE_TIME_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:,\s*|\s+)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?$/i;
const MONTH_DAY = 'month-day';
const DAY_MONTH = 'day-month';

// Remetente das mensagens enviadas pela própria conta
const OWN_SENDER_NAME = 'Você';

// Marcas no texto da mensagem. Apagada, editada, vídeo, figurinha e GIF não apareceram nas exportações
// conferidas: os textos são os conhecidos do WhatsApp, e o que não casar fica como texto ("chat")
const FORWARDED_PREFIX_PATTERN = /^\[Encaminhada\]\s*/i;
const REVOKED_PATTERN = /^(?:Mensagem apagada|Esta mensagem foi apagada|Você apagou esta mensagem)\.?$/i;
// O marcador de anexo abre a mensagem e o que vem depois dele é a legenda: exigir o marcador sozinho faria o
// anexo com legenda virar texto, e o tipo das mensagens divergiria da contagem de anexos omitidos
const MEDIA_MARKERS = [
  { pattern: /^<imagem (?:ocultada|omitida)>/i, msgType: 'image' },
  { pattern: /^<(?:vídeo|GIF) omitido>/i, msgType: 'video' },
  { pattern: /^<áudio (?:omitido|ocultado)>/i, msgType: 'audio' },
  { pattern: /^<mensagem de voz omitida>/i, msgType: 'ptt' },
  { pattern: /^<figurinha omitida>/i, msgType: 'sticker' },
  // Qualquer outro marcador que a contagem de anexos omitidos reconhece
  { pattern: new RegExp(`^(?:${OMITTED_MEDIA_PATTERN.source})`, 'i'), msgType: 'media' }
];
// Comparados como texto, sem regex: uma regex que aceita espaços em volta do marcador volta atrás em tempo
// quadrático numa sequência longa de espaços
const EDITED_MARKER = '<mensagem editada>';
const DOCUMENT_MARKER = '<documento omitido>';

const CALL_EVENT_PATTERN = /^\[Ligação\]$/i;
// Mensagem que o celular recebeu e o WhatsApp Web não mostra
const UNSUPPORTED_EVENT_PATTERN = /não é compatível com sua versão do WhatsApp/i;

/**
 * @typedef {Object} ChatTextEntry Mensagem ou evento do texto exportado, na ordem do arquivo
 * @property {number} seq Posição entre as entradas, a partir de 1
 * @property {'message'|'event'} kind
 * @property {string} timestampRaw Texto entre colchetes, como está no arquivo
 * @property {string|null} timestamp O mesmo instante em ISO 8601 UTC ("2026-08-01T12:00:05Z"), lido no fuso
 *   local; null quando a data não pôde ser interpretada
 * @property {string|null} senderName null em evento
 * @property {string|null} senderPhone Dígitos do remetente quando o nome dele é só um telefone
 * @property {boolean|null} isOut true para "Você" (a própria conta); null em evento
 * @property {string} msgType Tipo da mensagem: chat, image, video, audio, ptt, document, sticker, revoked, call_log,
 *   media (anexo fora desse mapa), unsupported e system
 * @property {string} text Texto de todas as linhas da entrada, sem "[Encaminhada]" nem "<Mensagem editada>", e sem
 *   espaços e quebras de linha no fim
 * @property {boolean} forwarded
 * @property {string|null} fileName Nome do documento escrito depois de "<documento omitido>", na mesma linha
 * @property {boolean} edited
 */

/**
 * @typedef {Object} ParsedChatText
 * @property {boolean} isEmpty Texto em branco (só espaços e quebras de linha)
 * @property {boolean} recognized Alguma linha segue a forma "[data] ..."; false em texto em branco
 * @property {'month-day'|'day-month'|null} dateOrder Ordem do mês e do dia decidida para o arquivo; null
 *   quando nenhuma data tem a forma esperada
 * @property {ChatTextEntry[]} entries
 * @property {number|null} messageCount
 * @property {number|null} systemEventCount
 * @property {number|null} omittedMediaCount Marcadores de anexo no texto inteiro
 * @property {string|null} firstTimestamp Data bruta da primeira entrada
 * @property {string|null} lastTimestamp Data bruta da última entrada
 *
 * As contagens ficam null quando o texto não está em branco mas nenhuma linha segue a forma esperada
 * (formato não reconhecido): zero afirmaria uma conversa sem mensagens.
 */

/**
 * @param {string} line Linha sem a quebra de linha
 * @returns {{ kind: 'message'|'event', timestampRaw: string, senderName: string|null, firstLine: string }|null}
 *   null quando a linha não tem a forma de cabeçalho, e continua a entrada anterior
 */
function readEntryHeader(line) {
  if (!line.startsWith('[')) return null;
  const end = line.indexOf('] ');
  if (end === -1) return null;
  const rest = line.slice(end + 2);
  const timestampRaw = line.slice(1, line.indexOf(']'));
  if (rest.startsWith(SYSTEM_EVENT_PREFIX)) {
    return { kind: 'event', timestampRaw, senderName: null, firstLine: rest.slice(SYSTEM_EVENT_PREFIX.length) };
  }
  const match = MESSAGE_PATTERN.exec(rest);
  if (!match) return null;
  return { kind: 'message', timestampRaw, senderName: match[1].trim(), firstLine: rest.slice(match[0].length) };
}

/**
 * @typedef {Object} DateParts Campos da data como estão no arquivo, antes de decidir qual número é o mês
 * @property {number} first
 * @property {number} second
 * @property {number} year Com 4 dígitos
 * @property {number} hour Como está escrita, em 12 ou 24 h
 * @property {number} minute
 * @property {number} seconds
 * @property {'AM'|'PM'|null} meridiem null no relógio de 24 h
 */

/**
 * @param {string} timestampRaw
 * @returns {DateParts|null}
 */
function readDateParts(timestampRaw) {
  const match = DATE_TIME_PATTERN.exec(timestampRaw.trim());
  if (!match) return null;
  const [, first, second, year, hour, minute, seconds, meridiem] = match;
  return {
    first: Number(first),
    second: Number(second),
    year: year.length === 2 ? 2000 + Number(year) : Number(year),
    hour: Number(hour),
    minute: Number(minute),
    seconds: seconds ? Number(seconds) : 0,
    meridiem: meridiem ? meridiem.toUpperCase() : null
  };
}

/**
 * Um número acima de 12 resolve a ordem do arquivo inteiro. Sem nenhum, vale mês/dia no relógio de 12 h,
 * que é como o WhatsApp Web exporta, e dia/mês no de 24 h
 * @param {DateParts[]} dates
 * @returns {'month-day'|'day-month'|null}
 */
function decideDateOrder(dates) {
  if (dates.length === 0) return null;
  if (dates.some((date) => date.first > 12)) return DAY_MONTH;
  if (dates.some((date) => date.second > 12)) return MONTH_DAY;
  return dates.some((date) => date.meridiem) ? MONTH_DAY : DAY_MONTH;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A hora do arquivo não traz fuso: é a hora local de quem exportou, lida aqui no fuso local do runtime
 * @param {DateParts} date
 * @param {'month-day'|'day-month'} order
 * @returns {string|null}
 */
function toUtcTimestamp(date, order) {
  const month = order === MONTH_DAY ? date.first : date.second;
  const day = order === MONTH_DAY ? date.second : date.first;
  let hour = date.hour;
  if (date.meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (date.meridiem === 'PM' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  if (date.minute > 59 || date.seconds > 59) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(date.year, month)) return null;
  const instant = new Date(date.year, month - 1, day, hour, date.minute, date.seconds);
  return `${instant.toISOString().slice(0, 19)}Z`;
}

/**
 * @param {string} body Texto da mensagem, já sem "[Encaminhada]" e "<Mensagem editada>"
 * @returns {{ msgType: string, fileName: string|null }}
 */
function classifyMessageBody(body) {
  const content = body.trim();
  if (REVOKED_PATTERN.test(content)) return { msgType: 'revoked', fileName: null };
  if (content.slice(0, DOCUMENT_MARKER.length).toLowerCase() === DOCUMENT_MARKER) {
    // O nome do arquivo, quando há, vem na mesma linha, depois do marcador; as linhas seguintes não fazem parte dele
    const firstLineEnd = content.indexOf('\n');
    const firstLine = firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
    return { msgType: 'document', fileName: firstLine.slice(DOCUMENT_MARKER.length).trim() || null };
  }
  const marker = MEDIA_MARKERS.find(({ pattern }) => pattern.test(content));
  return { msgType: marker ? marker.msgType : 'chat', fileName: null };
}

function classifyEventText(text) {
  if (CALL_EVENT_PATTERN.test(text.trim())) return 'call_log';
  if (UNSUPPORTED_EVENT_PATTERN.test(text)) return 'unsupported';
  return 'system';
}

/**
 * @param {string} text
 * @returns {{ text: string, edited: boolean }} O texto sem o marcador de editada no fim, quando há
 */
function stripEditedMarker(text) {
  const trimmed = text.trimEnd();
  if (trimmed.slice(-EDITED_MARKER.length).toLowerCase() !== EDITED_MARKER) return { text, edited: false };
  return { text: trimmed.slice(0, -EDITED_MARKER.length).trimEnd(), edited: true };
}

/**
 * Texto das linhas de uma entrada. As linhas em branco e os espaços do fim não fazem parte dela: sem isso, o texto de
 * uma mensagem seguida de linha em branco mudaria quando ela deixasse de ser a última do arquivo, e com ele o
 * message_id, que é calculado sobre o texto
 * @param {string[]} lines
 * @returns {string}
 */
function joinEntryLines(lines) {
  return lines.join('\n').trimEnd();
}

/**
 * @returns {ChatTextEntry}
 */
function buildMessage(seq, draft, timestamp) {
  const fullText = joinEntryLines(draft.lines);
  const forwardedPrefix = FORWARDED_PREFIX_PATTERN.exec(fullText);
  const { text, edited } = stripEditedMarker(forwardedPrefix ? fullText.slice(forwardedPrefix[0].length) : fullText);
  const { msgType, fileName } = classifyMessageBody(text);
  return {
    seq,
    kind: 'message',
    timestampRaw: draft.timestampRaw,
    timestamp,
    senderName: draft.senderName,
    senderPhone: phoneFromTitle(draft.senderName),
    isOut: draft.senderName.normalize('NFC') === OWN_SENDER_NAME,
    msgType,
    text,
    forwarded: Boolean(forwardedPrefix),
    fileName,
    edited
  };
}

/**
 * @returns {ChatTextEntry}
 */
function buildEvent(seq, draft, timestamp) {
  const text = joinEntryLines(draft.lines);
  return {
    seq,
    kind: 'event',
    timestampRaw: draft.timestampRaw,
    timestamp,
    senderName: null,
    senderPhone: null,
    isOut: null,
    msgType: classifyEventText(text),
    text,
    forwarded: false,
    fileName: null,
    edited: false
  };
}

/**
 * Lê o texto exportado de uma conversa (o _chat.txt): as mensagens e os eventos, na ordem do arquivo, com a
 * data em UTC, o remetente, o tipo e o texto de todas as linhas de cada um
 * @param {string} text
 * @returns {ParsedChatText}
 */
export function parseChatText(text) {
  if (text.trim() === '') {
    return {
      isEmpty: true,
      recognized: false,
      dateOrder: null,
      entries: [],
      messageCount: 0,
      systemEventCount: 0,
      omittedMediaCount: 0,
      firstTimestamp: null,
      lastTimestamp: null
    };
  }

  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const headers = lines.map((line) => {
    const header = readEntryHeader(line);
    return header && { ...header, date: readDateParts(header.timestampRaw) };
  });
  // O texto exportado não escapa nada: uma linha digitada no meio de uma mensagem com a forma "[lembrete] Ana: …" abriria
  // uma entrada falsa. Com alguma data no arquivo, só o colchete com data abre entrada
  const datedOnly = headers.some((header) => header?.date);

  // As linhas antes da primeira entrada (o aviso de criptografia, sem data) não são mensagem e ficam de fora
  const drafts = [];
  lines.forEach((line, index) => {
    const header = headers[index];
    if (header && (header.date || !datedOnly)) {
      drafts.push({ ...header, lines: header.firstLine === '' ? [] : [header.firstLine] });
    } else if (drafts.length > 0) {
      drafts.at(-1).lines.push(line);
    }
  });

  if (drafts.length === 0) {
    return {
      isEmpty: false,
      recognized: false,
      dateOrder: null,
      entries: [],
      messageCount: null,
      systemEventCount: null,
      omittedMediaCount: null,
      firstTimestamp: null,
      lastTimestamp: null
    };
  }

  const dateOrder = decideDateOrder(drafts.map((draft) => draft.date).filter(Boolean));
  const entries = drafts.map((draft, index) => {
    const timestamp = draft.date ? toUtcTimestamp(draft.date, dateOrder) : null;
    return draft.kind === 'event' ? buildEvent(index + 1, draft, timestamp) : buildMessage(index + 1, draft, timestamp);
  });
  const messageCount = entries.filter((entry) => entry.kind === 'message').length;

  return {
    isEmpty: false,
    recognized: true,
    dateOrder,
    entries,
    messageCount,
    systemEventCount: entries.length - messageCount,
    omittedMediaCount: text.match(OMITTED_MEDIA_PATTERN)?.length ?? 0,
    firstTimestamp: entries[0].timestampRaw,
    lastTimestamp: entries.at(-1).timestampRaw
  };
}
