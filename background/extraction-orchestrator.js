import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { ACTIONS } from '../shared/constants/actions.js';
import { StagingRepository } from '../shared/storage/staging-repository.js';
import { StorageClient } from '../shared/clients/storage-client.js';
import { inspectChatExport } from '../shared/archive/chat-export-inspector.js';
import { REPORT_FILENAME } from '../shared/archive/archive-packager.js';
import { findWhatsAppTab } from '../shared/utils/whatsapp-tab.js';
import { normalizePhoneDigits, phoneFromTitle } from '../shared/utils/phone.js';
import { Logger } from '../shared/utils/logger.js';
import { DownloadInterceptor } from './download-interceptor.js';
import { ExportCaptureRegistry, CAPTURE_ERROR_CODES } from './export-capture-registry.js';
import { ArchiveDownloader } from './archive-downloader.js';

const log = new Logger('ExtractionOrchestrator');

const RUN_STORAGE_KEY = 'extractionRun';
// A fila e o resultado de cada conversa ficam em chaves próprias, fora do estado: o estado é gravado a cada
// conversa, e com eles dentro cada gravação regravaria a execução inteira (centenas de KB numa fila de 500)
const RUN_QUEUE_STORAGE_KEY = `${RUN_STORAGE_KEY}:queue`;
const RUN_RESULT_STORAGE_KEY_PREFIX = `${RUN_STORAGE_KEY}:result:`;
// Conversas grandes com mídia levam minutos para o WhatsApp gerar o arquivo
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
// Espera extra depois do prazo esgotado, com as duas fontes ainda armadas. O prazo já conta da última
// atividade, então um arquivo depois dele é raro, e a quarentena só custa nas conversas que o estouraram
const QUARANTINE_MS = 60 * 1000;
// Espera antes da repescagem: as falhas passageiras costumam vir em bloco (o WhatsApp lento por alguns
// minutos), e tentar de novo logo depois da última conversa da fila repetiria a falha
const RETRY_COOLDOWN_MS = 60 * 1000;
// Chamadas a APIs da extensão reiniciam o contador de inatividade do service worker
const KEEP_ALIVE_INTERVAL_MS = 20000;

const ACTIVE_STATES = [
  WORKFLOW_STATES.SCANNING,
  WORKFLOW_STATES.EXPORTING,
  WORKFLOW_STATES.WAITING_DOWNLOAD,
  WORKFLOW_STATES.PACKAGING
];

const RESULT_STATUS = Object.freeze({
  SAVED: 'saved',
  SAVED_TO_DISK: 'saved_to_disk',
  NOT_EXPORTABLE: 'not_exportable',
  FAILED: 'failed'
});

const RESULT_LABELS = Object.freeze({
  [RESULT_STATUS.SAVED]: 'OK',
  [RESULT_STATUS.SAVED_TO_DISK]: 'NA PASTA DOWNLOADS',
  [RESULT_STATUS.NOT_EXPORTABLE]: 'NÃO EXPORTÁVEL',
  [RESULT_STATUS.FAILED]: 'FALHA'
});

// Como a aba abriu a conversa, pelo `via` que o content devolve (ChatNavigator.openChat em
// content/dom/chat-navigator.js; content script clássico não é importável aqui)
const VIA_LABELS = Object.freeze({
  'already-open': 'já estava aberta',
  visible: 'lista visível',
  search: 'busca',
  scroll: 'rolagem da lista'
});

// Campos do diagnóstico da abertura que o content devolve quando a busca ou a rolagem rodaram
// (OpenDiagnostics em content/dom/chat-navigator.js); só eles vão para o histórico da tentativa
const OPEN_DIAGNOSTIC_KEYS = Object.freeze([
  'searchMs', 'searchCellsSeen', 'searchExited', 'scrollSteps', 'scrollMs', 'scrollHeightGrew', 'scrollStopReason'
]);

// Por que a rolagem de abertura parou, pelo `scrollStopReason` do diagnóstico ('found' e os LOCATE_FAILURES
// da rolagem em content/dom/dom-utils.js; content script clássico não é importável aqui)
const OPEN_SCROLL_STOP_LABELS = Object.freeze({
  found: 'achou a conversa',
  'end-of-list': 'fim da lista',
  'scroll-stalled': 'rolagem travada antes do fim da lista',
  'scroll-time-limit': 'teto de tempo',
  'scroll-step-limit': 'limite de passos',
  'list-missing': 'lista lateral não encontrada'
});

// Horário no log de uma tentativa registrada por uma versão anterior da extensão, que não o guardava
const UNTIMED_CLOCK = '--:--:--';

// Código lançado pelo content (DomUtils.ERROR_CODES em content/dom/dom-utils.js; content script
// clássico não é importável aqui) quando o menu não oferece "Exportar conversa". O próprio WhatsApp
// não exporta essa conversa, então ela é contada à parte e não como falha.
const NOT_EXPORTABLE_CODE = 'EXPORT_OPTION_UNAVAILABLE';

// Falhas que se repetiriam do mesmo jeito ficam fora da repescagem: não exportável, homônimo
// (AMBIGUOUS_TITLE) e modal sem "Todas as mensagens" (DATE_RANGE_NOT_ALL), códigos do content
// (DomUtils.ERROR_CODES). É uma lista de exclusão para um código novo, ou uma falha sem código, entrar
// na repescagem por padrão
const NOT_RETRIED_CODES = new Set([NOT_EXPORTABLE_CODE, 'AMBIGUOUS_TITLE', 'DATE_RANGE_NOT_ALL']);

// Exportação vazia: o arquivo chegou e está no ZIP, mas o texto da conversa veio em branco. É um
// SAVED com `empty: true`, não um status próprio, para continuar contando como "no ZIP"
const EMPTY_EXPORT_LABEL = 'OK – VAZIA';

// Conversa da fila sem resultado, no relatório e no índice
const NOT_PROCESSED_LABEL = 'NÃO PROCESSADA';

const LATE_FILE_NOTE = ' Chegou atrasado: o arquivo foi entregue na quarentena, depois do prazo de espera.';

// Aviso que o content (content/content.js) devolve quando exportou sem confirmar "Todas as mensagens"
// no modal: a conversa foi salva, mas pode não ter o histórico inteiro
const DATE_RANGE_UNCONFIRMED_WARNING = 'DATE_RANGE_UNCONFIRMED';
const DATE_RANGE_UNCONFIRMED_NOTE = " Aviso: não foi possível confirmar a opção 'Todas as mensagens' no modal.";

const UNEXPECTED_FILE_SOURCE_LABELS = Object.freeze({ page: 'página', download: 'chrome.downloads' });

// Por que a varredura da lista parou, pelos códigos que o content devolve nas estatísticas dela
// (STOP_REASONS em content/dom/chat-list-scanner.js; content script clássico não é importável aqui)
const SCAN_STOP_LABELS = Object.freeze({
  'end-of-list': 'parou no fim da lista',
  'scroll-stalled': 'parou porque a rolagem travou antes do fim da lista, que pode ter ficado incompleta',
  'limit-reached': 'parou ao atingir o limite escolhido',
  'time-limit': 'parou no tempo máximo da varredura, e a lista pode ter ficado incompleta'
});

// Toda conversa exportada é de uma linha só: sem a linha da conta (a detectada na aba ou a informada no popup), a
// extração não começa. O popup reconhece esta falha pelo código (popup/popup.js) e mostra o campo do número
const LINE_NOT_DETECTED_CODE = 'LINE_NOT_DETECTED';
const LINE_NOT_DETECTED_MESSAGE =
  'Não foi possível detectar o número da linha (a conta logada no WhatsApp Web). Informe o número no popup para iniciar.';

// Limites do número da linha e do telefone do contato lido no painel, os mesmos de phoneFromTitle
// (shared/utils/phone.js): menos de 10 dígitos não chega a ser DDD + número, e mais de 15 passa do máximo do E.164
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 15;

// De onde veio a linha da execução: da aba (o content a lê do localStorage da página) ou do popup
const LINE_SOURCES = Object.freeze({ AUTO: 'auto', MANUAL: 'manual' });
const LINE_SOURCE_LABELS = Object.freeze({
  [LINE_SOURCES.AUTO]: 'detectada na aba',
  [LINE_SOURCES.MANUAL]: 'informada no popup'
});

// Número brasileiro com o 9 depois do DDD: 55, o DDD, o 9 e mais 8 dígitos
const BRAZILIAN_NINTH_DIGIT_PATTERN = /^55(\d{2})9(\d{8})$/;

// Tipo da conversa, como a aba o devolve: o `chatKind` do menu de opções e o `kind` do painel "Dados do contato"
// (DomUtils.CHAT_KINDS em content/dom/dom-utils.js; content script clássico não é importável aqui)
const CHAT_KINDS = Object.freeze({ CHAT: 'chat', GROUP: 'group' });

// De onde veio o telefone do contato: do título da conversa (contato não salvo) ou do painel "Dados do contato"
const CONTACT_PHONE_SOURCES = Object.freeze({ TITLE: 'title', CONTACT_INFO: 'contact_info' });

// Motivo do aviso quando o painel de uma conversa individual foi lido e não mostrou o número
const CONTACT_PHONE_NOT_FOUND = 'número não encontrado no painel';

class RunCancelledError extends Error {
  constructor() {
    super('Extração cancelada.');
    this.name = 'RunCancelledError';
  }
}

/**
 * A conversa recebeu o arquivo, no ZIP ou na pasta Downloads
 * @param {{ status: string }|undefined} result
 * @returns {boolean}
 */
function gotFile(result) {
  return result?.status === RESULT_STATUS.SAVED || result?.status === RESULT_STATUS.SAVED_TO_DISK;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Milissegundos em segundos, com uma casa decimal só quando ela não é zero (ex: "2 s", "4.2 s") */
function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(1))} s`;
}

/**
 * Modo da execução, no relatório e no log. A varredura (chat-list-scanner.js) percorre só a lista
 * principal e não abre "Arquivadas"
 * @param {{ downloadAll: boolean, maxChats: number|null }} options
 * @returns {string}
 */
function describeMode({ downloadAll, maxChats }) {
  return downloadAll ? 'lista principal (arquivadas não incluídas)' : `limite de ${maxChats} conversa(s)`;
}

/**
 * Chave do arquivo de uma conversa no staging. Com 6 dígitos, a ordem das chaves (que é a das pastas no
 * ZIP) é a da fila; a conferência do ZIP usa a mesma chave para saber quais conversas devem estar nele.
 * @param {number} index Posição na fila
 * @returns {string}
 */
function stagingKeyOf(index) {
  return String(index).padStart(6, '0');
}

/**
 * Chave do resultado de uma conversa no chrome.storage.local, com a chave dela no staging
 * @param {number} index Posição na fila
 * @returns {string}
 */
function resultStorageKeyOf(index) {
  return `${RUN_RESULT_STORAGE_KEY_PREFIX}${stagingKeyOf(index)}`;
}

/**
 * Aviso para o popup quando o ZIP montado não confere com as conversas esperadas nele
 * @param {import('../shared/archive/archive-packager.js').ArchiveCheck} check
 * @returns {string|null} null quando confere
 */
function describeCheckDivergence({ missingKeys, unreadable, unexpected, crcMismatch }) {
  const issues = [];
  if (missingKeys.length) issues.push(`${missingKeys.length} conversa(s) esperada(s) não está(ão) no ZIP`);
  if (unreadable.length) issues.push(`${unreadable.length} com o ZIP do WhatsApp ilegível, gravado(s) como o arquivo original`);
  if (crcMismatch.length) issues.push(`${crcMismatch.length} com texto de CRC que não confere, copiado como estava, sem compressão`);
  if (unexpected.length) issues.push(`${unexpected.length} no ZIP sem ser esperada(s)`);
  if (!issues.length) return null;
  return `Conferência do ZIP: ${issues.join('; ')}. Veja a seção "Conferência do ZIP" no ${REPORT_FILENAME}.`;
}

/**
 * Diagnóstico da abertura que a aba devolveu, só com os campos conhecidos que vieram preenchidos: é
 * persistido com o histórico de cada tentativa, e só as aberturas pela busca ou pela rolagem o têm
 * @param {unknown} raw `openDiagnostics` da resposta ao EXPORT_CHAT_REQUEST
 * @returns {Object|null} null quando a aba não mandou nenhum campo conhecido
 */
function compactOpenDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entries = OPEN_DIAGNOSTIC_KEYS.filter((key) => raw[key] != null).map((key) => [key, raw[key]]);
  return entries.length ? Object.fromEntries(entries) : null;
}

/**
 * Trechos da linha de uma tentativa no log da execução com o diagnóstico da abertura: a busca (células
 * na lista quando ela achou a conversa ou esgotou o prazo, tempo e se a saída dela foi confirmada) e a
 * rolagem (passos, tempo, se a lista cresceu e por que parou)
 * @param {Object} diagnostics Diagnóstico compacto (compactOpenDiagnostics)
 * @returns {string[]}
 */
function describeOpenDiagnostics(diagnostics) {
  const { searchMs, searchCellsSeen, searchExited, scrollSteps, scrollMs, scrollHeightGrew, scrollStopReason } = diagnostics;
  const parts = [];
  if (searchMs != null) {
    const exit = searchExited == null ? '' : `, saída ${searchExited ? 'confirmada' : 'não confirmada'}`;
    // Conta as células de conversa no painel lateral ao fim da busca: sem um snapshot da tela de busca, não dá
    // para separar resultado da busca de linha da lista normal que tenha ficado na tela
    parts.push(`busca: ${formatSeconds(searchMs)}, ${searchCellsSeen} célula(s) de conversa no painel${exit}`);
  }
  if (scrollSteps != null) {
    const stop = OPEN_SCROLL_STOP_LABELS[scrollStopReason] ?? `motivo desconhecido (${scrollStopReason})`;
    parts.push(
      `rolagem: ${scrollSteps} passo(s) em ${formatSeconds(scrollMs)}, lista cresceu: ${scrollHeightGrew ? 'sim' : 'não'}, parou: ${stop}`
    );
  }
  return parts;
}

/**
 * Código de erro de uma resposta da aba ou de uma exceção. DOMException (ex: do IndexedDB) traz um
 * `code` numérico legado, que não é um código desta extensão.
 * @param {{ code?: unknown }|null|undefined} source
 * @returns {string|null}
 */
function errorCodeOf(source) {
  return typeof source?.code === 'string' ? source.code : null;
}

/**
 * Número da linha informado no popup, que só o manda quando não detectou a linha na aba
 * @param {unknown} value
 * @returns {string|null} Os dígitos; null quando nenhum número foi informado
 * @throws {Error} Número com menos de 10 ou mais de 15 dígitos
 */
function typedLinePhoneOf(value) {
  if (value == null || String(value).trim() === '') return null;
  const digits = normalizePhoneDigits(value) ?? '';
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) {
    throw new Error(
      `Número da linha inválido (${digits.length} dígito(s)): informe de ${PHONE_MIN_DIGITS} a ` +
        `${PHONE_MAX_DIGITS} dígitos, com o DDI (ex.: 5511999999999).`
    );
  }
  return digits;
}

/**
 * Linha da conta logada na aba, pela resposta ao CHECK_PAGE_READY (`line`, que o content lê do localStorage da página)
 * @param {Object|null} status
 * @returns {string|null} Os dígitos; null quando a aba não detectou a linha ou não respondeu
 */
function tabLinePhoneOf(status) {
  const phone = status?.line?.phone;
  return typeof phone === 'string' && /^\d+$/.test(phone) ? phone : null;
}

/**
 * Linha da execução: a detectada na aba e, sem ela, a informada no popup
 * @param {string|null} tabLinePhone
 * @param {string|null} typedLinePhone
 * @returns {{ phone: string, source: string }}
 * @throws {Error} Com o código LINE_NOT_DETECTED, sem nenhuma das duas
 */
function resolveRunLine(tabLinePhone, typedLinePhone) {
  if (tabLinePhone) {
    if (typedLinePhone && typedLinePhone !== tabLinePhone) {
      log.info('O número informado no popup não é o da linha detectada na aba; vale a detectada.');
    }
    return { phone: tabLinePhone, source: LINE_SOURCES.AUTO };
  }
  if (typedLinePhone) return { phone: typedLinePhone, source: LINE_SOURCES.MANUAL };
  const error = new Error(LINE_NOT_DETECTED_MESSAGE);
  error.code = LINE_NOT_DETECTED_CODE;
  throw error;
}

/**
 * Linha da execução no cabeçalho do relatório e do log
 * @param {{ phone: string, source: string }|null|undefined} line
 * @returns {string}
 */
function describeLine(line) {
  // Uma execução iniciada por uma versão anterior da extensão não tem a linha
  if (!line) return 'Linha: não registrada (execução iniciada por uma versão anterior da extensão)';
  return `Linha: ${line.phone} (${LINE_SOURCE_LABELS[line.source] ?? line.source})`;
}

/**
 * A mesma linha com e sem o 9 depois do DDD de um número brasileiro. Só a conferência da retomada usa, e só com a linha
 * digitada no popup: quem digita costuma pôr o 9, e o número da conta, como o WhatsApp o grava, pode vir sem ele
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameLineIgnoringNinthDigit(a, b) {
  const withoutNinthDigit = (phone) => phone.replace(BRAZILIAN_NINTH_DIGIT_PATTERN, '55$1$2');
  return withoutNinthDigit(a) === withoutNinthDigit(b);
}

/**
 * @param {unknown} value
 * @returns {'chat'|'group'|null} null para qualquer valor que não seja um dos dois tipos
 */
function chatKindOf(value) {
  return value === CHAT_KINDS.CHAT || value === CHAT_KINDS.GROUP ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string|null} O texto aparado; null quando não é texto ou está em branco
 */
function textOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * @param {unknown} value
 * @returns {number|null} Milissegundos inteiros; null quando não é um número finito ≥ 0
 */
function durationOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/**
 * Telefone do contato lido no painel: só os dígitos, aceito com 10 a 15, como o da linha
 * @param {unknown} value
 * @returns {string|null}
 */
function contactPhoneOf(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = normalizePhoneDigits(value);
  return digits && digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS ? digits : null;
}

/**
 * @typedef {Object} ContactInfoRead Leitura do painel "Dados do contato" numa tentativa, como a aba a devolveu
 * @property {'chat'|'group'|null} kind Pelo título do painel
 * @property {string|null} phone Só os dígitos
 * @property {number|null} ms Tempo da leitura, com a abertura e o fechamento do painel
 * @property {string|null} error Por que a leitura falhou (ex: o painel não abriu); null quando o painel foi lido
 * @property {string|null} reason Por que o painel lido não deu o número, quando a aba sabe (ex: título não reconhecido)
 * @property {string|null} warning Aviso que não impediu a leitura (ex: o painel não fechou)
 */

/**
 * Leitura do painel "Dados do contato" que veio na resposta da aba, só com os campos conhecidos
 * @param {Object|null|undefined} response Resposta ao EXPORT_CHAT_REQUEST, de sucesso ou de falha
 * @returns {ContactInfoRead|null} null quando a aba não leu o painel
 */
function contactInfoReadOf(response) {
  const info = response?.contactInfo;
  if (info && typeof info === 'object') {
    return {
      kind: chatKindOf(info.kind),
      phone: contactPhoneOf(info.phone),
      ms: durationOf(info.ms),
      error: null,
      reason: textOf(info.reason),
      warning: textOf(info.warning)
    };
  }
  const failure = response?.contactInfoError;
  if (failure && typeof failure === 'object') {
    return {
      kind: null,
      phone: null,
      ms: durationOf(failure.ms),
      error: textOf(failure.message) ?? 'falha sem mensagem na aba',
      reason: null,
      warning: null
    };
  }
  return null;
}

/**
 * @typedef {Object} ContactRecord Tipo da conversa e telefone do contato, no resultado dela
 * @property {'chat'|'group'|null} kind Pelo menu de opções ou, sem ele, pelo painel "Dados do contato"
 * @property {string|null} phone Só os dígitos; null num grupo
 * @property {'title'|'contact_info'|null} phoneSource Do título da conversa ou do painel
 * @property {number|null} infoMs Tempo da leitura do painel; null sem leitura
 * @property {string|null} infoError Por que o telefone de uma conversa individual não saiu do painel; null num grupo,
 *   com o telefone e sem leitura do painel
 */

/**
 * Tipo da conversa e telefone do contato numa tentativa
 * @param {Object} params
 * @param {string|null} params.titlePhone Telefone do título da conversa (phoneFromTitle)
 * @param {unknown} params.chatKind `chatKind` da resposta da aba
 * @param {ContactInfoRead|null} params.infoRead
 * @returns {ContactRecord|null} null quando não se sabe nada: nem o tipo, nem o telefone, nem a leitura do painel
 */
function buildContact({ titlePhone, chatKind, infoRead }) {
  const kind = chatKindOf(chatKind) ?? infoRead?.kind ?? null;
  if (!kind && !titlePhone && !infoRead) return null;
  // Num grupo não há telefone de contato: o título não é o número de ninguém, e o painel lista os participantes
  const isGroup = kind === CHAT_KINDS.GROUP;
  let phone = null;
  let phoneSource = null;
  if (!isGroup && titlePhone) {
    phone = titlePhone;
    phoneSource = CONTACT_PHONE_SOURCES.TITLE;
  } else if (!isGroup && infoRead?.phone) {
    phone = infoRead.phone;
    phoneSource = CONTACT_PHONE_SOURCES.CONTACT_INFO;
  }
  return {
    kind,
    phone,
    phoneSource,
    infoMs: infoRead?.ms ?? null,
    infoError: isGroup || phone || !infoRead ? null : (infoRead.error ?? infoRead.reason ?? CONTACT_PHONE_NOT_FOUND)
  };
}

/**
 * Leitura do painel no histórico da tentativa, para o log da execução
 * @param {ContactInfoRead} infoRead
 * @param {ContactRecord} contact O da mesma tentativa
 * @returns {{ ms: number|null, error: string|null, warning?: string }}
 */
function contactInfoAttemptOf(infoRead, contact) {
  return {
    ms: infoRead.ms,
    // Num grupo, a falha da leitura fica no log, mas não vira aviso de telefone no relatório
    error: infoRead.error ?? contact.infoError,
    ...(infoRead.warning ? { warning: infoRead.warning } : {})
  };
}

/**
 * Contato da conversa repescada: o da 2ª tentativa, sem perder o tipo e o telefone que só a 1ª leu (ex: a 2ª falhou
 * antes do painel e do menu)
 * @param {ContactRecord|undefined} first Da 1ª tentativa; ausente quando ela não soube nada ou numa execução gravada
 *   por uma versão anterior da extensão
 * @param {ContactRecord|undefined} second
 * @returns {ContactRecord|null}
 */
function mergeRetriedContact(first, second) {
  if (!first || !second) return second ?? first ?? null;
  const kind = second.kind ?? first.kind;
  if (kind === CHAT_KINDS.GROUP) {
    return { kind, phone: null, phoneSource: null, infoMs: second.infoMs ?? first.infoMs, infoError: null };
  }
  // O telefone vem com o tempo da leitura que o deu; sem telefone em nenhuma das duas, fica o motivo mais recente
  const withPhone = [second, first].find((contact) => contact.phone);
  if (withPhone) {
    return { kind, phone: withPhone.phone, phoneSource: withPhone.phoneSource, infoMs: withPhone.infoMs, infoError: null };
  }
  return {
    kind,
    phone: null,
    phoneSource: null,
    infoMs: second.infoMs ?? first.infoMs,
    infoError: second.infoError ?? first.infoError
  };
}

/**
 * Por que o telefone de uma conversa individual não foi lido no painel "Dados do contato", para a nota do relatório
 * @param {Object|undefined} result
 * @returns {string|null} null num grupo, com o telefone, sem leitura do painel e numa execução gravada por uma versão
 *   anterior da extensão (sem `contact`)
 */
function missingContactPhoneReason(result) {
  const contact = result?.contact;
  if (!contact || contact.kind === CHAT_KINDS.GROUP || contact.phone) return null;
  return contact.infoError ?? null;
}

/**
 * Trecho da linha de uma tentativa no log da execução com a leitura do painel "Dados do contato": o tempo ou, na
 * falha, o tempo e o motivo; e o aviso, quando houve
 * @param {{ ms: number|null, error: string|null, warning?: string }} contactInfo Do histórico da tentativa
 * @returns {string}
 */
function describeContactInfoAttempt({ ms, error, warning }) {
  const duration = ms == null ? null : formatSeconds(ms);
  const outcome = error ? `${duration ? `falhou em ${duration}` : 'falhou'} (${error})` : (duration ?? 'lido');
  return `dados do contato: ${outcome}${warning ? ` (aviso: ${warning})` : ''}`;
}

/**
 * @typedef {Object} AttemptRecord Uma tentativa de exportar a conversa, no histórico do resultado dela
 * @property {number} attempt 1 na fila, 2 na repescagem
 * @property {string|null} startedAt Início, em ISO; null numa tentativa registrada por uma versão anterior da extensão
 * @property {number|null} durationMs Duração da tentativa inteira, com a espera do arquivo e a quarentena; null como o início
 * @property {string} status Resultado desta tentativa (RESULT_STATUS)
 * @property {string|null} code Código do erro
 * @property {string|null} via Como a aba abriu a conversa; null quando ela não confirmou a exportação
 * @property {string|null} reason Texto do erro, sem o título da conversa; null quando a tentativa recebeu o arquivo
 * @property {boolean} quarantined O prazo de espera do arquivo esgotou e a tentativa passou pela quarentena
 * @property {boolean} late O arquivo chegou na quarentena
 * @property {Object} [openDiagnostics] Diagnóstico da busca e da rolagem da abertura (compactOpenDiagnostics),
 *   só quando a aba o mandou: ausente nas aberturas pela lista visível e nas tentativas de uma versão anterior
 * @property {{ ms: number|null, error: string|null, warning?: string }} [contactInfo] Leitura do painel "Dados do
 *   contato" (contactInfoAttemptOf), só quando a aba o leu nesta tentativa
 */

/**
 * Histórico de tentativas de uma conversa. Uma execução gravada por uma versão anterior da extensão só tem
 * o resultado final, e o histórico é reconstituído dele, sem horário nem duração.
 * @param {Object} result
 * @returns {AttemptRecord[]}
 */
function historyOf(result) {
  if (Array.isArray(result.history)) return result.history;

  const prefix = `"${result.title}": `;
  const message = result.message ?? '';
  const final = {
    attempt: result.attempts ?? 1,
    startedAt: null,
    durationMs: null,
    status: result.status,
    code: result.code ?? null,
    via: result.via ?? null,
    // A mensagem de uma falha começa pelo título, que a linha do log já mostra
    reason: gotFile(result) ? null : (message.startsWith(prefix) ? message.slice(prefix.length) : message) || null,
    // Só um arquivo atrasado prova a quarentena; sem ele, não há como saber
    quarantined: Boolean(result.late),
    late: Boolean(result.late)
  };
  if (final.attempt < 2) return [final];
  // Da 1ª tentativa de uma conversa repescada, o resultado só guardava o código
  const first = {
    attempt: 1,
    startedAt: null,
    durationMs: null,
    status: RESULT_STATUS.FAILED,
    code: result.firstAttemptCode ?? null,
    via: null,
    reason: null,
    quarantined: false,
    late: false
  };
  return [first, final];
}

/**
 * ExtractionOrchestrator
 * Responsabilidade Única: Coordenação do ciclo de vida da fila de extração em lote,
 * aplicação de restrições de limites de conversas, controle de pausas e disparo
 * do empacotamento do arquivo consolidado.
 *
 * O estado da execução é persistido a cada conversa: o Chrome pode encerrar o service
 * worker no meio de execuções longas, e a execução volta como pausada para ser retomada.
 * No chrome.storage.local, o estado fica em `extractionRun`, sem a fila e os resultados; a fila, em
 * `extractionRun:queue`, gravada uma vez depois da varredura; e o resultado de cada conversa, em
 * `extractionRun:result:<chave do staging>` (_persistRun).
 */
export class ExtractionOrchestrator {
  /**
   * @param {Object} [options]
   * @param {Object} [options.timings] Prazos em ms; os testes encurtam para não esperar os de produção
   * @param {number} [options.timings.captureTimeoutMs] Espera pelo arquivo exportado, contada da última atividade
   * @param {number} [options.timings.quarantineMs] Espera extra depois do prazo esgotado (quarentena)
   */
  constructor({ timings = {} } = {}) {
    this.timings = { captureTimeoutMs: CAPTURE_TIMEOUT_MS, quarantineMs: QUARANTINE_MS, ...timings };
    this.state = WORKFLOW_STATES.IDLE;
    this.isPaused = false;
    this.errorMessage = null;
    /** Código da falha da execução (ex: LINE_NOT_DETECTED, que o popup reconhece); null sem código */
    this.errorCode = null;
    this.statusMessage = null;
    this.currentIndex = 0;
    this.currentChatTitle = '';
    /** Conversas encontradas até agora pela varredura em andamento, mostradas no popup */
    this.scanFound = 0;

    /**
     * `line` é a linha da conta (o número da conta logada no WhatsApp Web), a detectada na aba (`auto`) ou a
     * informada no popup (`manual`): null até a aba ser conferida no início, e ausente numa execução iniciada
     * por uma versão anterior da extensão. `retry` é a repescagem: null até a fila terminar; `indices` são as
     * posições na fila que entraram nela, `cursor` a próxima a exportar e `startsAt` quando a rodada pode
     * começar. `scan` são as estatísticas da varredura (null até ela terminar).
     * @type {{ runId: string, tabId: number|null, line: { phone: string, source: 'auto'|'manual' }|null, options: Object, queue: Array, nextIndex: number, results: Array, unexpectedFiles: Array, retry: { indices: number[], cursor: number, startsAt: string }|null, scan: { found: number, steps: number, durationMs: number, stopReason: string, lastChatTimestamp: string|null }|null, startedAt: string }|null}
     */
    this.run = null;
    /** A fila ainda não foi para o storage; vai na próxima gravação do estado (_persistRun) */
    this._queueUnsaved = false;
    /** @type {Set<number>} Posições na fila cujo resultado ainda não foi para o storage; vão na próxima gravação do estado */
    this._unsavedResults = new Set();

    this.captures = new ExportCaptureRegistry();
    this.interceptor = new DownloadInterceptor({
      registry: this.captures,
      onUnexpectedFile: ({ filename }) => this.recordUnexpectedFile({ filename, source: 'download' })
    });

    /** @type {{ captureId: string, tabId: number, title: string }|null} Conversa em exportação agora */
    this._exportInProgress = null;
    this._activeState = WORKFLOW_STATES.IDLE;
    this._loopPromise = null;
    this._abortController = null;
    this._resumeResolver = null;
    this._keepAliveTimer = null;
  }

  /**
   * Indica se há um laço de execução rodando agora
   * @returns {boolean}
   */
  isBusy() {
    return Boolean(this._loopPromise);
  }

  /**
   * Reidrata a execução persistida após o service worker ser reiniciado
   */
  async restore() {
    const stored = await StorageClient.get([RUN_STORAGE_KEY, RUN_QUEUE_STORAGE_KEY], {});
    const saved = stored[RUN_STORAGE_KEY];
    if (!saved) return;

    const { state, errorMessage, errorCode, statusMessage, currentIndex, currentChatTitle, ...run } = saved;
    if (Array.isArray(run.queue)) {
      // Gravada por uma versão anterior da extensão, com a fila e os resultados dentro do estado: a próxima
      // gravação os passa para as chaves próprias, no mesmo `set` do estado
      this._queueUnsaved = true;
      run.results.forEach((result, index) => {
        if (result) this._unsavedResults.add(index);
      });
    } else {
      run.queue = run.queueRunId === run.runId ? (stored[RUN_QUEUE_STORAGE_KEY] ?? []) : [];
      run.results = await this._readResults(run.nextIndex);
    }
    this.run = run;
    this.currentIndex = currentIndex || 0;
    this.currentChatTitle = currentChatTitle || '';

    const wasRunning = ACTIVE_STATES.includes(state) || state === WORKFLOW_STATES.PAUSED;
    if (!wasRunning) {
      this.state = state;
      this.errorMessage = errorMessage || null;
      this.errorCode = errorCode || null;
      this.statusMessage = statusMessage || null;
      return;
    }

    if (!run.queue?.length) {
      this.state = WORKFLOW_STATES.FAILED;
      this.errorMessage = 'A extração foi interrompida pelo navegador durante a descoberta de conversas. Inicie novamente.';
      return;
    }

    // Nada está rodando agora: a execução volta pausada para o usuário retomar
    this.isPaused = true;
    this.state = WORKFLOW_STATES.PAUSED;
    this._activeState = run.nextIndex >= run.queue.length && !this._hasPendingRetry()
      ? WORKFLOW_STATES.PACKAGING
      : WORKFLOW_STATES.EXPORTING;
    this.statusMessage = state === WORKFLOW_STATES.PAUSED
      ? (statusMessage || 'Extração pausada.')
      : 'A extração foi interrompida pelo navegador. Clique em "Retomar" para continuar de onde parou.';
    log.info(`Execução ${run.runId} restaurada como pausada (${run.nextIndex}/${run.queue.length}).`);
  }

  /**
   * Resultados gravados nas chaves próprias, só das conversas já processadas: uma chave que tenha sobrado
   * de outra execução (numa remoção que falhou ao iniciar esta) numa posição ainda não alcançada não entra
   * @private
   * @param {number} processed Conversas já processadas (`nextIndex`)
   * @returns {Promise<Array<Object>>} Como o da execução em memória: sem a posição de uma chave ausente
   */
  async _readResults(processed) {
    const keys = Array.from({ length: processed }, (_, index) => resultStorageKeyOf(index));
    if (!keys.length) return [];
    const stored = await StorageClient.get(keys, {});
    const results = [];
    keys.forEach((key, index) => {
      if (stored[key] !== undefined) results[index] = stored[key];
    });
    return results;
  }

  /**
   * Retorna o estado atual da máquina de estados
   * @returns {Object}
   */
  getState() {
    const total = this.run?.queue?.length || 0;
    const processed = this.run?.nextIndex || 0;
    const results = (this.run?.results || []).filter(Boolean);
    const retry = this._retryProgress();
    let percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
    // Na repescagem a fila já está em 100%: a porcentagem passa a ser a da rodada
    if (retry) percentage = Math.round(((retry.current - 1) / retry.total) * 100);
    return {
      state: this.state,
      current: this.currentIndex || processed,
      total,
      percentage,
      retry,
      scanFound: this.scanFound,
      currentChatTitle: this.currentChatTitle,
      errorMessage: this.errorMessage,
      errorCode: this.errorCode,
      statusMessage: this.statusMessage,
      summary: {
        saved: results.filter((r) => r.status === RESULT_STATUS.SAVED).length,
        empty: results.filter((r) => r.status === RESULT_STATUS.SAVED && r.empty).length,
        savedToDisk: results.filter((r) => r.status === RESULT_STATUS.SAVED_TO_DISK).length,
        notExportable: results.filter((r) => r.status === RESULT_STATUS.NOT_EXPORTABLE).length,
        failed: results.filter((r) => r.status === RESULT_STATUS.FAILED).length
      }
    };
  }

  /**
   * Andamento da repescagem enquanto ela tem conversas por exportar. `current` é a posição na rodada da
   * conversa em exportação, ou da próxima durante a espera e a pausa.
   * @private
   * @returns {{ current: number, total: number }|null}
   */
  _retryProgress() {
    const retry = this.run?.retry;
    if (!retry || retry.cursor >= retry.indices.length) return null;
    return { current: retry.cursor + 1, total: retry.indices.length };
  }

  /**
   * A fila terminou e a repescagem ainda tem conversas por exportar, inclusive quando a rodada nem foi
   * montada (o service worker reiniciou logo depois da última conversa da fila)
   * @private
   * @returns {boolean}
   */
  _hasPendingRetry() {
    const { queue, nextIndex, retry } = this.run;
    if (nextIndex < queue.length) return false;
    return retry ? retry.cursor < retry.indices.length : this._retryCandidates().length > 0;
  }

  /**
   * Conversas que entram na repescagem: as que falharam, menos as de código em NOT_RETRIED_CODES. Uma
   * exportação vazia foi salva, não falhou, e fica fora.
   * @private
   * @returns {number[]} Posições na fila
   */
  _retryCandidates() {
    return this.run.results.flatMap((result, index) => (
      result?.status === RESULT_STATUS.FAILED && !NOT_RETRIED_CODES.has(result.code) ? [index] : []
    ));
  }

  /**
   * Notifica o popup, sem persistir o estado
   * @private
   * @param {Object} [extra] Campos adicionais só para a notificação (ex: infoMessage, warningMessage)
   */
  _sendProgressToPopup(extra = {}) {
    chrome.runtime.sendMessage({ action: ACTIONS.WORKFLOW_PROGRESS_UPDATE, ...this.getState(), ...extra }).catch(() => {
      // Popup fechado
    });
  }

  /**
   * Notifica o popup e persiste o estado da execução
   * @private
   * @param {Object} [extra] Campos adicionais só para a notificação (ex: infoMessage, warningMessage)
   */
  _notifyProgress(extra = {}) {
    this._sendProgressToPopup(extra);
    if (this.run) this._persistRun();
  }

  /**
   * Grava o estado da execução, sem a fila e os resultados, e no mesmo `set` o que deles ainda não foi para
   * o storage: a fila, depois da varredura, e o resultado de cada conversa, junto do estado com o novo
   * `nextIndex` (ou `retry.cursor`, na repescagem). Um `set` só porque um reinício entre duas gravações
   * deixaria o estado apontando para depois de uma conversa sem o resultado dela.
   * @private
   */
  _persistRun() {
    const { run } = this;
    // Marca no estado de qual execução é a fila gravada: se a limpeza da anterior falhar, a fila velha
    // continua no storage, e um reinício durante a varredura nova não pode retomá-la
    if (this._queueUnsaved) run.queueRunId = run.runId;
    const { queue, results, ...rest } = run;
    const items = {
      [RUN_STORAGE_KEY]: {
        ...rest,
        state: this.state,
        errorMessage: this.errorMessage,
        errorCode: this.errorCode,
        statusMessage: this.statusMessage,
        currentIndex: this.currentIndex,
        currentChatTitle: this.currentChatTitle
      }
    };
    const queueIncluded = this._queueUnsaved;
    const resultsIncluded = [...this._unsavedResults];
    if (queueIncluded) items[RUN_QUEUE_STORAGE_KEY] = queue;
    for (const index of resultsIncluded) items[resultStorageKeyOf(index)] = results[index];
    this._queueUnsaved = false;
    this._unsavedResults.clear();

    StorageClient.set(items).then((saved) => {
      // A falha já foi registrada pelo StorageClient. As gravações seguintes só levam o estado, e sem isto a
      // fila ou o resultado ficariam fora do storage de vez
      if (saved || this.run !== run) return;
      if (queueIncluded) this._queueUnsaved = true;
      resultsIncluded.forEach((index) => this._unsavedResults.add(index));
    });
  }

  /**
   * Guarda o resultado de uma conversa. Ele vai para o storage na próxima gravação do estado, que é a do
   * aviso do resultado (_notifyResult), depois de avançar `nextIndex` ou `retry.cursor`.
   * @private
   * @param {number} index Posição na fila
   * @param {Object} result
   */
  _setResult(index, result) {
    this.run.results[index] = result;
    this._unsavedResults.add(index);
  }

  /**
   * Apaga do storage a execução anterior inteira (estado, fila e resultados) antes da primeira gravação da
   * nova. A nova só regrava as chaves de resultado das posições que alcança: sem isto, uma fila menor
   * deixaria para trás os resultados das últimas posições da anterior. As chaves dos resultados saem do
   * tamanho da fila anterior.
   * @private
   */
  async _removePreviousRun() {
    const stored = await StorageClient.get([RUN_STORAGE_KEY, RUN_QUEUE_STORAGE_KEY], {});
    const previous = stored[RUN_STORAGE_KEY];
    // Uma execução gravada por uma versão anterior da extensão tem a fila dentro do estado
    const previousQueue = Array.isArray(previous?.queue) ? previous.queue : stored[RUN_QUEUE_STORAGE_KEY];
    const resultKeys = Array.from({ length: previousQueue?.length ?? 0 }, (_, index) => resultStorageKeyOf(index));
    await StorageClient.remove([RUN_STORAGE_KEY, RUN_QUEUE_STORAGE_KEY, ...resultKeys]);
  }

  /**
   * Muda a fase ativa sem sobrescrever uma pausa pedida pelo usuário
   * @private
   */
  _setPhase(state) {
    this._activeState = state;
    if (!this.isPaused) this.state = state;
  }

  /**
   * Pausa o fluxo ao fim da conversa atual
   * @returns {boolean}
   */
  pause() {
    const pausable = [WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.EXPORTING, WORKFLOW_STATES.WAITING_DOWNLOAD];
    if (!this.isBusy() || this.isPaused || !pausable.includes(this._activeState)) return false;

    this.isPaused = true;
    this.state = WORKFLOW_STATES.PAUSED;
    this.statusMessage = 'Pausa solicitada: a extração para ao concluir a conversa atual.';
    log.info('Orquestrador pausado pelo usuário.');
    this._notifyProgress();
    return true;
  }

  /**
   * Retoma o fluxo pausado, inclusive uma execução restaurada após reinício do service worker. Antes de voltar
   * a exportar, a linha da aba é conferida (_confirmTabLine): com a aba em outra conta, a execução continua pausada.
   * @returns {boolean}
   */
  resume() {
    if (!this.isPaused) return false;

    this.isPaused = false;
    this.state = this._activeState;
    this.statusMessage = null;
    log.info('Orquestrador retomado pelo usuário.');

    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    } else if (!this.isBusy() && this.run) {
      this._execute(async (signal) => {
        if (this.run.nextIndex < this.run.queue.length || this._hasPendingRetry()) {
          const { tab, linePhone } = await this._prepareTab(this.run.tabId);
          // Cancelada enquanto a aba era preparada: a pausa da conferência não pode sobrescrever o cancelamento
          if (signal.aborted) throw new RunCancelledError();
          this.run.tabId = tab.id;
          if (!this._confirmTabLine(linePhone)) return;
        }
        await this._processQueue(signal);
      });
    }

    this._notifyProgress();
    return true;
  }

  /**
   * Confere a linha da aba quando a execução volta a usá-la, depois de uma pausa ou de um reinício do service
   * worker: a aba pode ter entrado em outra conta nesse meio-tempo, e uma execução não mistura linhas. Com a aba
   * em outra conta, a execução volta para a pausa; sem a linha detectada na aba, segue com um aviso. Uma execução
   * iniciada por uma versão anterior da extensão não tem a linha, e segue sem conferir. A linha detectada no início
   * é comparada exatamente; a digitada no popup aceita a da aba que difere dela só pelo 9 depois do DDD, e continua
   * sendo a linha da execução.
   * @private
   * @param {string|null} tabLinePhone Linha detectada na aba agora
   * @returns {boolean} false quando a execução voltou para a pausa
   */
  _confirmTabLine(tabLinePhone) {
    const expected = this.run.line?.phone;
    if (!expected || tabLinePhone === expected) return true;

    if (tabLinePhone && this.run.line.source === LINE_SOURCES.MANUAL && isSameLineIgnoringNinthDigit(tabLinePhone, expected)) {
      log.info('A linha da aba difere da digitada no popup só pelo 9 depois do DDD; a extração segue com a linha digitada.');
      return true;
    }

    if (!tabLinePhone) {
      log.warn('Linha da aba não detectada na retomada; a extração segue sem conferir a conta.');
      // Só o popup: o aviso não muda o estado da execução
      this._sendProgressToPopup({
        warningMessage: '⚠️ A linha da aba do WhatsApp Web não foi detectada, e a conta dela não pôde ser conferida. ' +
          `Esta extração é da linha +${expected}: confira se a aba está logada nessa conta.`
      });
      return true;
    }

    this.isPaused = true;
    this.state = WORKFLOW_STATES.PAUSED;
    this.statusMessage = `A aba do WhatsApp Web está logada em outra conta (linha +${tabLinePhone}). ` +
      `Esta extração é da linha +${expected}: entre na conta da linha +${expected} e clique em "Retomar".`;
    log.warn('Retomada recusada: a aba está logada em outra conta.');
    this._notifyProgress({ warningMessage: this.statusMessage });
    return false;
  }

  /**
   * Cancela o fluxo de extração, interrompendo inclusive a etapa em andamento na aba
   */
  async cancel() {
    this.isPaused = false;
    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    }
    this._abortController?.abort();
    this.interceptor.disarm();

    if (this.run?.tabId != null) {
      chrome.tabs.sendMessage(this.run.tabId, { action: ACTIONS.CANCEL_CURRENT_OPERATION }).catch(() => {});
    }

    this.state = WORKFLOW_STATES.CANCELLED;
    this._activeState = WORKFLOW_STATES.CANCELLED;
    this.statusMessage = 'Extração cancelada.';
    log.info('Orquestrador cancelado pelo usuário.');
    this._notifyProgress();
  }

  /**
   * Arma o interceptor de downloads para a conversa em exportação. A aba chama isto (EXPORT_CAPTURE_ARMED)
   * imediatamente antes de clicar em "Exportar", e só arma a sua captura depois desta resposta: até lá
   * nenhuma das duas fontes está armada, e um arquivo atrasado da conversa anterior não é tomado como desta.
   * @param {{ captureId: string, tabId: number }} params
   * @returns {{ success: boolean, error?: string }}
   */
  armCapture({ captureId, tabId }) {
    const current = this._exportInProgress;
    if (!current || current.captureId !== captureId) {
      return { success: false, error: 'A captura não é a da conversa em exportação (concluída, cancelada ou de outra execução).' };
    }
    if (current.tabId !== tabId) {
      return { success: false, error: 'O aviso veio de outra aba, não da que está exportando a conversa.' };
    }
    this.interceptor.arm({ captureId, tabId });
    log.info(`Captura ${captureId} armada para "${current.title}".`);
    return { success: true };
  }

  /**
   * Registra um arquivo de exportação do WhatsApp que chegou sem captura armada (antes do clique em
   * "Exportar" da conversa atual ou entre conversas). Ele não é salvo: o download segue para a pasta
   * Downloads, e o relatório o lista. Fora de uma execução em andamento é um download do próprio
   * usuário, e é ignorado.
   * @param {{ filename: string|null, source: 'page'|'download' }} params
   * @returns {{ success: boolean, recorded: boolean }}
   */
  recordUnexpectedFile({ filename, source }) {
    if (!this.isBusy() || !this.run) return { success: true, recorded: false };

    const entry = {
      at: new Date().toISOString(),
      filename: typeof filename === 'string' && filename ? filename : null,
      source,
      duringChat: this._exportInProgress?.title ?? null
    };
    // Uma execução gravada por uma versão anterior da extensão e retomada agora não tem a lista
    (this.run.unexpectedFiles ??= []).push(entry);
    log.warn(`Arquivo recebido fora de hora (${UNEXPECTED_FILE_SOURCE_LABELS[source]}): ${entry.filename ?? '(nome ainda não definido)'}`);
    this._notifyProgress({
      warningMessage: `⚠️ Arquivo recebido fora de hora (${this._describeUnexpectedFile(entry)}): não foi salvo no ZIP e seguiu para a pasta Downloads.`
    });
    return { success: true, recorded: true };
  }

  /**
   * @private
   * @param {{ filename: string|null, source: string, duringChat: string|null }} entry
   * @returns {string}
   */
  _describeUnexpectedFile({ filename, source, duringChat }) {
    const name = filename ? `"${filename}"` : 'nome ainda não definido pelo Chrome';
    const moment = duringChat ? `durante "${duringChat}"` : 'entre conversas';
    return `${UNEXPECTED_FILE_SOURCE_LABELS[source]}, ${name}, ${moment}`;
  }

  /**
   * Repassa ao popup quantas conversas a varredura já encontrou (SCAN_PROGRESS, que a aba manda no
   * máximo a cada 500 ms). Não grava o storage: a retomada depois de um reinício não continua uma
   * varredura interrompida, e o total parcial não serve a ela. Um aviso de outra aba ou atrasado, que
   * chegue depois do fim da varredura, é ignorado.
   * @param {{ found: number, tabId: number }} params
   * @returns {{ success: boolean, recorded?: boolean, error?: string }}
   */
  recordScanProgress({ found, tabId }) {
    if (!Number.isInteger(found) || found < 0) {
      return { success: false, error: `Andamento da varredura inválido: ${String(found)}.` };
    }
    if (this._activeState !== WORKFLOW_STATES.SCANNING || this.run?.tabId !== tabId) {
      return { success: true, recorded: false };
    }
    this.scanFound = found;
    this._sendProgressToPopup();
    return { success: true, recorded: true };
  }

  /**
   * Inicia o fluxo completo de extração em lote
   * @param {Object} options
   * @param {number|null} [options.maxChats=null] Limite máximo de chats (para testes)
   * @param {boolean} [options.downloadAll=true] Se true, desconsidera maxChats e extrai todos
   * @param {number} [options.safeDelayMs=2000] Intervalo base entre conversas, em ms (recebe variação aleatória de
   *   até +50%). Aceita qualquer número finito ≥ 0: o mínimo de 1 s para o usuário é aplicado no popup, e os testes usam 0
   * @param {number} [options.retryCooldownMs=60000] Espera entre o fim da fila e a repescagem
   * @param {string|null} [options.linePhone=null] Número da linha informado no popup, que só o manda quando não
   *   detectou a linha na aba. Aceita o número formatado; vale só se a aba também não detectar a linha no início
   * @returns {Promise<void>}
   */
  async start({ maxChats = null, downloadAll = true, safeDelayMs = 2000, retryCooldownMs = RETRY_COOLDOWN_MS, linePhone = null } = {}) {
    if (this.isBusy()) {
      throw new Error('Já existe uma extração em andamento.');
    }
    if (typeof safeDelayMs !== 'number' || !Number.isFinite(safeDelayMs) || safeDelayMs < 0) {
      throw new Error(`Intervalo entre conversas inválido: ${String(safeDelayMs)} (esperado um número de milissegundos ≥ 0).`);
    }
    const typedLinePhone = typedLinePhoneOf(linePhone);

    // Uma execução pausada ou interrompida anterior é descartada ao iniciar outra
    this.isPaused = false;
    this.errorMessage = null;
    this.errorCode = null;
    this.statusMessage = null;
    this.currentIndex = 0;
    this.currentChatTitle = '';
    this.scanFound = 0;
    this.run = {
      runId: Date.now().toString(36),
      tabId: null,
      line: null,
      options: { maxChats, downloadAll, safeDelayMs, retryCooldownMs },
      queue: [],
      nextIndex: 0,
      results: [],
      unexpectedFiles: [],
      retry: null,
      scan: null,
      startedAt: new Date().toISOString()
    };
    this._queueUnsaved = false;
    this._unsavedResults = new Set();

    return this._execute(async (signal) => {
      await this._removePreviousRun();
      await StagingRepository.clear();
      const { tab, linePhone: tabLinePhone } = await this._prepareTab();
      this.run.tabId = tab.id;
      this.run.line = resolveRunLine(tabLinePhone, typedLinePhone);
      log.info(`Linha da execução: ${this.run.line.phone} (${LINE_SOURCE_LABELS[this.run.line.source]}).`);
      await this._scan(signal);
      await this._processQueue(signal);
    });
  }

  /**
   * Executa o corpo da execução com cancelamento, keepalive e tratamento de erro únicos
   * @private
   * @param {function(AbortSignal): Promise<void>} body
   * @returns {Promise<void>}
   */
  _execute(body) {
    const controller = new AbortController();
    this._abortController = controller;
    this._startKeepAlive();

    this._loopPromise = (async () => {
      try {
        await body(controller.signal);
      } catch (err) {
        if (err instanceof RunCancelledError || controller.signal.aborted) {
          this.state = WORKFLOW_STATES.CANCELLED;
          this.statusMessage = 'Extração cancelada.';
        } else {
          log.error('Erro crítico no fluxo do orquestrador:', err);
          this.state = WORKFLOW_STATES.FAILED;
          this.errorMessage = err.message;
          this.errorCode = errorCodeOf(err);
        }
        this._activeState = this.state;
        this.isPaused = false;
        this._notifyProgress();
      } finally {
        this.interceptor.stopListening();
        this._stopKeepAlive();
        this._abortController = null;
        this._loopPromise = null;
      }
    })();

    return this._loopPromise;
  }

  /** @private */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  /** @private */
  _stopKeepAlive() {
    clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  /**
   * @private
   * @param {AbortSignal} signal
   */
  async _waitResumeIfPaused(signal) {
    while (this.isPaused && !signal.aborted) {
      await new Promise((resolve) => {
        this._resumeResolver = resolve;
      });
      if (!this.isPaused && !signal.aborted) await this._checkTabLineOnResume(signal);
    }
    if (signal.aborted) throw new RunCancelledError();
  }

  /**
   * Na retomada de uma pausa do laço, pergunta a linha à aba (CHECK_PAGE_READY) e a confere (_confirmTabLine):
   * com a aba em outra conta, a execução volta para a pausa
   * @private
   * @param {AbortSignal} signal
   */
  async _checkTabLineOnResume(signal) {
    // Sem a linha na execução não há com o que comparar, e a aba nem é consultada
    if (!this.run.line) return;
    const status = await this._pingTab(this.run.tabId);
    // Cancelada durante a consulta: a pausa da conferência não pode sobrescrever o cancelamento
    if (signal.aborted) return;
    this._confirmTabLine(tabLinePhoneOf(status));
  }

  /**
   * Pausa interrompível pelo cancelamento
   * @private
   */
  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new RunCancelledError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(new RunCancelledError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Envia uma mensagem à aba sem ficar preso a ela quando a execução é cancelada
   * @private
   */
  _sendToTab(tabId, message, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RunCancelledError());
      const onAbort = () => reject(new RunCancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });
      chrome.tabs.sendMessage(tabId, message)
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener('abort', onAbort));
    });
  }

  /**
   * @private
   * @returns {Promise<Object|null>}
   */
  async _pingTab(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: ACTIONS.CHECK_PAGE_READY });
    } catch (_) {
      return null;
    }
  }

  /**
   * Localiza a aba do WhatsApp e garante que o content script responde. Após recarregar
   * a extensão, a aba já aberta fica sem content script até ser recarregada, então ele é reinjetado.
   * @private
   * @param {number|null} [preferredTabId=null]
   * @returns {Promise<{ tab: chrome.tabs.Tab, linePhone: string|null }>} A aba e a linha da conta logada nela, na
   *   mesma resposta que confere a aba; null quando a aba não detecta a linha
   */
  async _prepareTab(preferredTabId = null) {
    const tab = await findWhatsAppTab({ preferredTabId });
    if (!tab?.id) {
      throw new Error('Nenhuma aba do WhatsApp Web aberta encontrada.');
    }

    let status = await this._pingTab(tab.id);
    if (!status) {
      log.info(`Content script ausente na aba ${tab.id}; reinjetando...`);
      const files = chrome.runtime.getManifest().content_scripts?.[0]?.js || [];
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      status = await this._pingTab(tab.id);
    }

    if (!status) {
      throw new Error('Não foi possível comunicar com a aba do WhatsApp Web. Recarregue a página e tente novamente.');
    }
    if (!status.ready) {
      throw new Error('O WhatsApp Web ainda não está pronto (carregando ou aguardando a leitura do QR Code).');
    }
    return { tab, linePhone: tabLinePhoneOf(status) };
  }

  /**
   * FASE DE DESCOBERTA (SCANNING)
   * @private
   * @param {AbortSignal} signal
   */
  async _scan(signal) {
    const { tabId, options } = this.run;
    this._setPhase(WORKFLOW_STATES.SCANNING);
    this._notifyProgress();
    log.info(`Iniciando escaneamento de chats na aba ${tabId}...`);

    const limit = !options.downloadAll && options.maxChats > 0 ? options.maxChats : null;
    const response = await this._sendToTab(tabId, { action: ACTIONS.SCAN_CHATS_REQUEST, maxLimit: limit }, signal);
    if (!response?.success || !Array.isArray(response.chats)) {
      if (response?.cancelled && signal.aborted) throw new RunCancelledError();
      throw new Error(response?.error || 'Falha ao escanear conversas no WhatsApp Web.');
    }

    const chats = limit ? response.chats.slice(0, limit) : response.chats;
    this.run.queue = chats.map(({ id, title, duplicateTitle }) => ({ id, title, duplicateTitle: Boolean(duplicateTitle) }));
    this._queueUnsaved = true;
    this.scanFound = response.chats.length;
    const { stats } = response;
    this.run.scan = stats ? {
      found: response.chats.length,
      steps: stats.steps,
      durationMs: stats.durationMs,
      stopReason: stats.stopReason,
      lastChatTimestamp: stats.lastChatTimestamp ?? null
    } : null;
    log.info(`Fila montada com ${this.run.queue.length} conversas para exportação (varredura: ${stats?.stopReason ?? 'sem estatísticas'}).`);
    this._notifyProgress();
  }

  /**
   * FASE DE EXPORTAÇÃO SEQUENCIAL, seguida do empacotamento
   * @private
   * @param {AbortSignal} signal
   */
  async _processQueue(signal) {
    const { queue } = this.run;

    if (queue.length === 0) {
      this._setPhase(WORKFLOW_STATES.COMPLETED);
      this.statusMessage = 'Nenhuma conversa encontrada para exportar.';
      this._notifyProgress();
      return;
    }

    this.interceptor.startListening();

    while (this.run.nextIndex < queue.length) {
      await this._waitResumeIfPaused(signal);

      const index = this.run.nextIndex;
      const chat = queue[index];
      this.currentIndex = index + 1;
      this.currentChatTitle = chat.title;
      this._setPhase(WORKFLOW_STATES.EXPORTING);
      this._notifyProgress();
      log.info(`[${index + 1}/${queue.length}] Exportando conversa "${chat.title}"...`);

      const result = await this._exportChat(chat, index, signal);
      this._setResult(index, { ...result, attempts: 1 });
      this.run.nextIndex = index + 1;
      this._notifyResult(`[${index + 1}/${queue.length}]`, this.run.results[index]);

      if (this.run.nextIndex < queue.length) await this._waitBetweenChats(signal);
    }

    // Antes do stopListening: a repescagem usa as mesmas duas fontes de captura da fila
    await this._retryFailures(signal);
    this.interceptor.stopListening();
    await this._packageAndDownload(signal);
  }

  /**
   * REPESCAGEM: uma rodada só, no fim da fila e antes do empacotamento, com as conversas que falharam por
   * um motivo que pode passar (`_retryCandidates`). O andamento fica em `run.retry`, para a retomada
   * depois de um reinício do service worker continuar de onde parou; uma rodada concluída não se repete
   * (ex: "Retomar" depois de o download do ZIP não ser concluído).
   * @private
   * @param {AbortSignal} signal
   */
  async _retryFailures(signal) {
    const { queue } = this.run;
    let announce = false;
    if (!this.run.retry) {
      // Uma execução gravada por uma versão anterior da extensão não tem a espera nas opções
      const cooldownMs = this.run.options.retryCooldownMs ?? RETRY_COOLDOWN_MS;
      this.run.retry = {
        indices: this._retryCandidates(),
        cursor: 0,
        // Horário, e não duração: a retomada depois de um reinício espera só o que faltava
        startsAt: new Date(Date.now() + cooldownMs).toISOString()
      };
      announce = true;
    }

    const retry = this.run.retry;
    const total = retry.indices.length;
    if (retry.cursor >= total) return;

    this._setPhase(WORKFLOW_STATES.EXPORTING);
    this.currentChatTitle = '';
    const waitMs = Date.parse(retry.startsAt) - Date.now();
    const waitLabel = `${Math.ceil(waitMs / 1000)} s`;
    if (waitMs > 0 && !this.isPaused) {
      this.statusMessage = `Aguardando ${waitLabel} antes da repescagem de ${total} conversa(s).`;
    }
    this._notifyProgress(announce ? {
      infoMessage: `Repescagem: ${total} conversa(s) que falharam serão tentadas de novo${waitMs > 0 ? ` daqui a ${waitLabel}` : ''}.`
    } : {});
    if (waitMs > 0) {
      await this._sleep(waitMs, signal);
      // Uma pausa pedida durante a espera trocou a mensagem, e a dela continua valendo
      if (!this.isPaused) this.statusMessage = null;
    }
    await this._waitResumeIfPaused(signal);
    await this._resetSidebar(signal);

    while (retry.cursor < total) {
      await this._waitResumeIfPaused(signal);

      const index = retry.indices[retry.cursor];
      const chat = queue[index];
      const position = `${retry.cursor + 1}/${total}`;
      this.currentIndex = index + 1;
      this.currentChatTitle = chat.title;
      this._setPhase(WORKFLOW_STATES.EXPORTING);
      this._notifyProgress();
      log.info(`[repescagem ${position}] Exportando de novo a conversa "${chat.title}" (${index + 1}/${queue.length})...`);

      const previous = this.run.results[index];
      const firstAttemptCode = previous?.code ?? null;
      const result = await this._exportChat(chat, index, signal, { attempt: 2 });
      const contact = mergeRetriedContact(previous?.contact, result.contact);
      // Fica o resultado da repescagem, sucesso ou falha: a 1ª tentativa falhou sem deixar arquivo no
      // staging. O código dela fica para o relatório reconstituir a ordem real das tentativas, e o
      // histórico guarda as duas para o log da execução
      this._setResult(index, {
        ...result,
        attempts: 2,
        firstAttemptCode,
        history: [...(previous ? historyOf(previous) : []), ...result.history],
        ...(contact ? { contact } : {})
      });
      retry.cursor++;
      this._notifyResult(`[Repescagem ${position}]`, this.run.results[index]);

      if (retry.cursor < total) await this._waitBetweenChats(signal);
    }
    // Sem isto, o fim da execução mostraria a posição da última conversa repescada (ex: "2 de 5 (100%)")
    this.currentIndex = queue.length;
  }

  /**
   * Devolve a lista lateral da aba ao normal antes da repescagem. Se a aba não conseguir, a repescagem
   * segue com o aviso: cada conversa ainda tem a busca e a rolagem para ser encontrada, e uma falha fica
   * no resultado dela.
   * @private
   * @param {AbortSignal} signal
   */
  async _resetSidebar(signal) {
    let response;
    try {
      response = await this._sendToTab(this.run.tabId, { action: ACTIONS.RESET_SIDEBAR }, signal);
    } catch (err) {
      if (err instanceof RunCancelledError || signal.aborted) throw new RunCancelledError();
      response = { success: false, error: err.message };
    }
    if (response?.success) return;

    const reason = response?.error || 'a aba não respondeu.';
    log.warn(`Lista lateral não devolvida ao normal antes da repescagem: ${reason}`);
    // Só o popup: o aviso não muda o estado da execução
    this._sendProgressToPopup({
      warningMessage: `⚠️ Repescagem: a lista lateral não voltou ao normal, e as conversas são tentadas mesmo assim. Motivo: ${reason}`
    });
  }

  /**
   * Intervalo entre conversas, com variação aleatória para o ritmo não ser perfeitamente regular
   * @private
   * @param {AbortSignal} signal
   */
  _waitBetweenChats(signal) {
    const delay = Math.round(this.run.options.safeDelayMs * (1 + Math.random() * 0.5));
    return this._sleep(delay, signal);
  }

  /**
   * Avisa o popup do resultado de uma conversa
   * @private
   * @param {string} prefix Posição da conversa (ex: "[3/10]" na fila, "[Repescagem 1/2]")
   * @param {{ status: string, empty?: boolean, message: string }} result
   */
  _notifyResult(prefix, result) {
    if (result.status === RESULT_STATUS.FAILED) {
      this._notifyProgress({ warningMessage: `${prefix} ⚠️ ${result.message}` });
    } else if (result.status === RESULT_STATUS.NOT_EXPORTABLE) {
      this._notifyProgress({ warningMessage: `${prefix} ⚠️ [NÃO EXPORTÁVEL] ${result.message}` });
    } else if (result.empty) {
      this._notifyProgress({ warningMessage: `${prefix} ⚠️ [${EMPTY_EXPORT_LABEL}] ${result.message}` });
    } else {
      this._notifyProgress({ infoMessage: `${prefix} ✅ ${result.message}` });
    }
  }

  /**
   * Exporta uma conversa: dispara a exportação na aba e aguarda o arquivo pela página ou pelo download.
   * `code` é o código do erro (null sem erro ou sem código conhecido); `via` diz como a aba abriu a
   * conversa e `warnings` traz os códigos de aviso da aba (null e vazio se a aba não chegou a confirmar
   * a exportação); `staged` diz se o arquivo foi
   * gravado no staging; `late` diz se ele só chegou na quarentena. Uma conversa salva traz também o
   * resultado da inspeção do texto (`empty`, contagens e datas, null se o conteúdo não foi inspecionado,
   * com o motivo em `inspectionError`). `contact` traz o tipo da conversa e o telefone do contato, em qualquer
   * status, quando se sabe algum deles (pelo título, pelo menu ou pelo painel "Dados do contato"). `history` traz
   * só esta tentativa, com o início, a duração, se ela passou pela quarentena e, quando a aba os mandou, o
   * diagnóstico da busca e da rolagem da abertura e a leitura do painel; a repescagem a junta à da fila.
   * @private
   * @param {{ title: string, duplicateTitle: boolean }} chat
   * @param {number} index Posição na fila
   * @param {AbortSignal} signal
   * @param {Object} [options]
   * @param {number} [options.attempt=1] 1 na fila, 2 na repescagem
   * @returns {Promise<{ title: string, status: string, code: string|null, via: string|null, warnings: string[], staged: boolean, late: boolean, message: string, size?: number, contact?: ContactRecord, history: AttemptRecord[] }>}
   */
  async _exportChat(chat, index, signal, { attempt = 1 } = {}) {
    const { runId, tabId } = this.run;
    // Uma captura por tentativa: um bloco atrasado da transferência da 1ª é recusado na repescagem
    const captureId = attempt === 1 ? `${runId}-${index}` : `${runId}-${index}-r${attempt - 1}`;
    const startedAt = new Date();
    // O título de um contato não salvo é o próprio telefone: só sem ele a aba abre o painel "Dados do contato"
    const titlePhone = phoneFromTitle(chat.title);
    let via = null;
    let warnings = [];
    let late = false;
    let quarantined = false;
    let openDiagnostics = null;
    let contact = buildContact({ titlePhone, chatKind: null, infoRead: null });
    let contactInfoAttempt = null;
    const withHistory = (result, reason = null) => ({
      ...result,
      ...(contact ? { contact } : {}),
      history: [{
        attempt,
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        status: result.status,
        code: result.code,
        via: result.via,
        reason,
        quarantined,
        late: result.late,
        ...(openDiagnostics ? { openDiagnostics } : {}),
        ...(contactInfoAttempt ? { contactInfo: contactInfoAttempt } : {})
      }]
    });
    const failed = (message, code) => withHistory({
      title: chat.title,
      status: code === NOT_EXPORTABLE_CODE ? RESULT_STATUS.NOT_EXPORTABLE : RESULT_STATUS.FAILED,
      code,
      via,
      warnings,
      staged: false,
      late: false,
      message: `"${chat.title}": ${message}`
    }, message);

    // As duas fontes só são armadas quando a aba avisa que vai clicar em "Exportar" (armCapture)
    this.captures.expect(captureId);
    this._exportInProgress = { captureId, tabId, title: chat.title };

    try {
      // A posição na fila é a da conversa na lista durante a varredura: a rolagem da aba começa perto dela
      const trigger = await this._sendToTab(tabId, {
        action: ACTIONS.EXPORT_CHAT_REQUEST,
        chat,
        captureId,
        queueIndex: index,
        readContactInfo: !titlePhone
      }, signal);
      // Vem também na falha: uma conversa não encontrada diz no log como foram a busca e a rolagem
      openDiagnostics = compactOpenDiagnostics(trigger?.openDiagnostics);
      // Também na falha: a conversa não exportável traz o tipo, e o painel é lido antes do menu de opções
      const infoRead = contactInfoReadOf(trigger);
      contact = buildContact({ titlePhone, chatKind: trigger?.chatKind, infoRead });
      contactInfoAttempt = infoRead ? contactInfoAttemptOf(infoRead, contact) : null;
      if (!trigger?.success) {
        if (trigger?.cancelled && signal.aborted) throw new RunCancelledError();
        return failed(trigger?.error || 'erro desconhecido na página.', errorCodeOf(trigger));
      }
      via = trigger.via ?? null;
      warnings = Array.isArray(trigger.warnings) ? trigger.warnings : [];

      this._setPhase(WORKFLOW_STATES.WAITING_DOWNLOAD);
      // Só o popup: o estado vai para o storage com o resultado da conversa, e a retomada depois de um
      // reinício exporta a conversa de novo, esteja ela esperando o arquivo ou não
      this._sendProgressToPopup();
      let captured;
      try {
        captured = await this.captures.waitFor(captureId, { timeoutMs: this.timings.captureTimeoutMs, signal });
      } catch (err) {
        if (errorCodeOf(err) !== CAPTURE_ERROR_CODES.FILE_NOT_DELIVERED) throw err;
        quarantined = true;
        // O registry apagou a captura ao esgotar o prazo. Registrá-la de novo sem nenhum await no meio
        // não deixa brecha para o arquivo atrasado chegar e ser recusado como captura não esperada
        this.captures.expect(captureId);
        captured = await this._waitInQuarantine(chat, captureId, err, signal);
        late = true;
      }
      const lateNote = late ? LATE_FILE_NOTE : '';

      if (captured.savedToDisk) {
        return withHistory({
          title: chat.title,
          status: RESULT_STATUS.SAVED_TO_DISK,
          code: null,
          via,
          warnings,
          staged: false,
          late,
          message: `"${chat.title}" foi baixado direto para a pasta Downloads (${captured.filename}) e não está no ZIP.${lateNote}`
        });
      }

      const { inspection, inspectionError } = await this._inspectExport(chat, captured.blob);

      await StagingRepository.saveChatFile({
        chatId: stagingKeyOf(index),
        chatTitle: chat.title,
        filename: captured.filename,
        blob: captured.blob
      });

      const details = [formatSize(captured.blob.size)];
      if (inspection?.omittedMediaCount > 0) details.push(`${inspection.omittedMediaCount} anexo(s) omitido(s)`);
      const formatUnrecognized = Boolean(inspection) && !inspection.isEmpty && inspection.messageCount === null;
      const inspectionNote = inspectionError
        ? ` Conteúdo não inspecionado: ${inspectionError}`
        : formatUnrecognized ? ' Formato do texto não reconhecido: mensagens e anexos não contados.' : '';
      const homonymNote = chat.duplicateTitle ? ' Atenção: existe outra conversa com o mesmo nome, que não foi exportada.' : '';
      return withHistory({
        title: chat.title,
        status: RESULT_STATUS.SAVED,
        code: null,
        via,
        warnings,
        staged: true,
        late,
        size: captured.blob.size,
        empty: inspection?.isEmpty === true,
        inspectionError,
        messageCount: inspection?.messageCount ?? null,
        systemEventCount: inspection?.systemEventCount ?? null,
        omittedMediaCount: inspection?.omittedMediaCount ?? null,
        firstTimestamp: inspection?.firstTimestamp ?? null,
        lastTimestamp: inspection?.lastTimestamp ?? null,
        message: `"${chat.title}" salvo (${details.join(', ')}).${inspectionNote}${homonymNote}${lateNote}`
      });
    } catch (err) {
      if (err instanceof RunCancelledError || signal.aborted) throw new RunCancelledError();
      log.warn(`Falha na conversa "${chat.title}":`, err);
      return failed(err.message, errorCodeOf(err));
    } finally {
      this._exportInProgress = null;
      this.captures.discard(captureId);
      this.interceptor.disarm();
      chrome.tabs.sendMessage(tabId, { action: ACTIONS.DISARM_EXPORT_CAPTURE, captureId }).catch(() => {});
    }
  }

  /**
   * Quarentena: depois do prazo esgotado, espera mais `quarantineMs` com as duas fontes ainda armadas.
   * Um arquivo que chegue aqui é desta conversa, porque a seguinte ainda não clicou em "Exportar". Se o
   * prazo da quarentena também esgotar, vale a falha do prazo original.
   * @private
   * @param {{ title: string }} chat
   * @param {string} captureId Já registrada de novo no registry
   * @param {Error} notDelivered A falha FILE_NOT_DELIVERED do prazo original
   * @param {AbortSignal} signal
   */
  async _waitInQuarantine(chat, captureId, notDelivered, signal) {
    log.warn(`"${chat.title}": prazo esgotado; aguardando o arquivo por mais ${this.timings.quarantineMs} ms (quarentena).`);
    try {
      return await this.captures.waitFor(captureId, { timeoutMs: this.timings.quarantineMs, signal });
    } catch (err) {
      throw errorCodeOf(err) === CAPTURE_ERROR_CODES.FILE_NOT_DELIVERED ? notDelivered : err;
    }
  }

  /**
   * Inspeciona o texto do arquivo capturado. Uma falha aqui não impede salvar a conversa: o arquivo
   * chegou e vai para o ZIP, e a falha fica no log e no resultado ("conteúdo não inspecionado").
   * @private
   * @returns {Promise<{ inspection: import('../shared/archive/chat-export-inspector.js').ChatExportInspection|null, inspectionError: string|null }>}
   */
  async _inspectExport(chat, blob) {
    try {
      return { inspection: await inspectChatExport(blob), inspectionError: null };
    } catch (err) {
      log.warn(`Conteúdo de "${chat.title}" não inspecionado; a conversa é salva mesmo assim:`, err);
      return { inspection: null, inspectionError: err.message };
    }
  }

  /**
   * Relatório gravado na raiz do ZIP com o status de cada conversa
   * @private
   * @returns {string}
   */
  _buildReport() {
    const { queue, results, options, retry, scan, startedAt, line } = this.run;
    const summary = this.getState().summary;
    const omittedMedia = results.reduce((total, result) => total + (result?.omittedMediaCount ?? 0), 0);
    // Conversa salva sem contagem (não inspecionada ou formato não reconhecido) deixa o total abaixo do real
    const uncounted = results.filter((result) => result?.staged && !result.empty && result.omittedMediaCount == null).length;
    const partialNote = uncounted ? `; total parcial: ${uncounted} conversa(s) sem contagem` : '';
    // Só nas que receberam arquivo: numa falha não há histórico para conferir. Uma execução gravada por
    // uma versão anterior da extensão não tem `warnings` nos resultados
    const hasUnconfirmedRange = (result) => gotFile(result) && Boolean(result.warnings?.includes(DATE_RANGE_UNCONFIRMED_WARNING));
    const unconfirmedRange = results.filter(hasUnconfirmedRange).length;
    const missingContactPhones = results.filter(missingContactPhoneReason).length;

    const lines = [
      'Relatório de extração - WhatsApp Web Extractor',
      `Início: ${new Date(startedAt).toLocaleString('pt-BR')}`,
      `Geração do ZIP: ${new Date().toLocaleString('pt-BR')}`,
      describeLine(line),
      `Modo: ${describeMode(options)}`
    ];
    // Uma execução gravada por uma versão anterior da extensão não tem as estatísticas da varredura
    if (scan) lines.push(this._describeScan(scan));
    lines.push(
      'Conteúdo: somente texto; o WhatsApp Web exporta sem mídia, e os anexos aparecem como marcadores ' +
        `(${omittedMedia} anexo(s) omitido(s) nesta execução${partialNote}).`,
      `Conversas na fila: ${queue.length} | no ZIP: ${summary.saved} (vazias: ${summary.empty}) | ` +
        `na pasta Downloads: ${summary.savedToDisk} | não exportáveis: ${summary.notExportable} | falhas: ${summary.failed}`
    );
    if (unconfirmedRange) {
      lines.push(
        `Aviso: em ${unconfirmedRange} conversa(s) não foi possível confirmar a opção 'Todas as mensagens' no modal; ` +
          'confira se o histórico delas veio completo.'
      );
    }
    if (missingContactPhones) {
      lines.push(
        `Aviso: em ${missingContactPhones} conversa(s) o telefone do contato não foi lido no painel 'Dados do contato'; ` +
          'o motivo está na linha de cada uma.'
      );
    }
    if (retry?.indices.length) {
      const recovered = retry.indices.filter((index) => gotFile(results[index])).length;
      lines.push(
        `Repescagem: ${retry.indices.length} conversa(s) tentada(s) de novo no fim da fila, ${recovered} recuperada(s); ` +
          'as demais tiveram uma tentativa só.'
      );
    }
    lines.push('');

    const checkNotes = this._notDeliveredCheckNotes();
    queue.forEach((chat, i) => {
      const result = results[i];
      if (!result) {
        lines.push(`[${NOT_PROCESSED_LABEL}] ${i + 1}. "${chat.title}"`);
        return;
      }
      const attemptsNote = result.attempts > 1 ? ` Tentativas: ${result.attempts}.` : '';
      const rangeNote = hasUnconfirmedRange(result) ? DATE_RANGE_UNCONFIRMED_NOTE : '';
      const contactReason = missingContactPhoneReason(result);
      const contactNote = contactReason ? ` Aviso: telefone do contato não lido no painel (${contactReason}).` : '';
      lines.push(
        `[${result.empty ? EMPTY_EXPORT_LABEL : RESULT_LABELS[result.status]}] ${i + 1}. ${result.message}${rangeNote}${contactNote}${attemptsNote}${checkNotes.get(i) ?? ''}`
      );
    });

    const unexpectedFiles = this.run.unexpectedFiles ?? [];
    if (unexpectedFiles.length) {
      lines.push(
        '',
        `Arquivos recebidos fora de hora (${unexpectedFiles.length}): chegaram sem captura armada, não estão no ZIP ` +
          'e o download seguiu para a pasta Downloads. O mesmo arquivo pode aparecer uma vez por fonte (página e chrome.downloads).'
      );
      for (const entry of unexpectedFiles) {
        lines.push(`- ${new Date(entry.at).toLocaleString('pt-BR')}: ${this._describeUnexpectedFile(entry)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Linha da varredura no relatório e no log da execução: quantas conversas ela achou, por que parou e a
   * data/hora exibida na última conversa da lista, que mostra se ela chegou mesmo ao fim
   * @private
   * @param {{ found: number, durationMs: number, stopReason: string, lastChatTimestamp: string|null }} scan
   * @returns {string}
   */
  _describeScan({ found, durationMs, stopReason, lastChatTimestamp }) {
    const duration = Number.isFinite(durationMs) ? ` em ${Math.round(durationMs / 1000)} s` : '';
    const reason = SCAN_STOP_LABELS[stopReason] ?? `parou por um motivo desconhecido (${stopReason})`;
    const lastChat = lastChatTimestamp
      ? `data/hora exibida na última conversa: ${lastChatTimestamp}`
      : 'a última conversa não tinha data/hora legível';
    return `Varredura: ${found} conversa(s) encontrada(s)${duration}; ${reason}; ${lastChat}.`;
  }

  /**
   * Nota "conferir" de cada conversa que recebeu arquivo logo depois de uma tentativa que não entregou o
   * dela: um arquivo atrasado que chegue depois do clique em "Exportar" da tentativa seguinte não se
   * distingue do desta. "Logo depois" é na ordem real das exportações (a fila e, em seguida, a
   * repescagem), não na posição da fila. A nota diz qual foi a exportação anterior porque ela não é
   * sempre a linha de cima, e a linha de cima pode já mostrar a conversa recuperada na repescagem.
   * @private
   * @returns {Map<number, string>} Nota por posição na fila
   */
  _notDeliveredCheckNotes() {
    const { queue, results, retry } = this.run;
    const retried = retry ? retry.indices.slice(0, retry.cursor) : [];
    const retriedSet = new Set(retried);

    // A 1ª tentativa de uma conversa repescada só sobrevive no `firstAttemptCode` do resultado
    const attempts = [];
    queue.forEach((_, index) => {
      const result = results[index];
      if (!result) return;
      const final = !retriedSet.has(index);
      attempts.push({ index, number: 1, final, code: final ? result.code : result.firstAttemptCode });
    });
    for (const index of retried) attempts.push({ index, number: 2, final: true, code: results[index].code });

    const notes = new Map();
    attempts.forEach((attempt, position) => {
      const previous = attempts[position - 1];
      if (!attempt.final || !gotFile(results[attempt.index]) || previous?.code !== CAPTURE_ERROR_CODES.FILE_NOT_DELIVERED) return;
      notes.set(
        attempt.index,
        ` Conferir: a exportação anterior (${previous.index + 1}. "${queue[previous.index].title}", ` +
          `${previous.number}ª tentativa) não entregou o arquivo.`
      );
    });
    return notes;
  }

  /**
   * Log da execução gravado na raiz do ZIP (_execucao.log), para diagnosticar falhas sem o DevTools
   * aberto. É montado só com o que fica persistido no run, então sobrevive a um reinício do service worker
   * (o console do background, não): cabeçalho, linha da varredura e uma linha por evento, em ordem
   * cronológica — cada tentativa de cada conversa, o início da repescagem e os arquivos recebidos fora de hora.
   * @private
   * @returns {string}
   */
  _buildExecutionLog() {
    const { runId, queue, results, options, retry, scan, startedAt, line } = this.run;

    const attemptEvents = (belongs) => queue.flatMap((chat, index) => {
      const result = results[index];
      if (!result) return [];
      const history = historyOf(result);
      return history.filter(belongs).map((entry) => ({
        at: entry.startedAt,
        text: this._describeAttempt(index, chat.title, entry, entry === history.at(-1) && result.empty === true)
      }));
    });
    // Montados na ordem em que acontecem (fila, início da repescagem, repescagem), para dois eventos no
    // mesmo milissegundo não saírem invertidos da ordenação, que é estável
    const events = [
      ...attemptEvents((entry) => entry.attempt === 1),
      ...(retry?.indices.length
        ? [{ at: retry.startsAt, text: `Repescagem: rodada prevista para este horário (fim da espera; uma pausa a adia), com ${retry.indices.length} conversa(s) que falharam na fila.` }]
        : []),
      ...attemptEvents((entry) => entry.attempt !== 1),
      // Uma execução gravada por uma versão anterior da extensão não tem a lista
      ...(this.run.unexpectedFiles ?? []).map((entry) => ({
        at: entry.at,
        text: `Arquivo recebido fora de hora (${this._describeUnexpectedFile(entry)}): não foi salvo no ZIP e seguiu para a pasta Downloads.`
      }))
    ].map((event) => ({ ...event, at: Date.parse(event.at) }));
    // Sem horário, só tentativas registradas antes da atualização da extensão: vêm antes de todas as outras
    const untimed = events.filter((event) => !Number.isFinite(event.at));
    const timed = events.filter((event) => Number.isFinite(event.at)).sort((a, b) => a.at - b.at);

    const lines = [
      'Log da execução - WhatsApp Web Extractor',
      `Execução: ${runId} | início: ${new Date(startedAt).toLocaleString('pt-BR')} | versão da extensão: ${chrome.runtime.getManifest().version}`,
      describeLine(line),
      `Modo: ${describeMode(options)} | intervalo entre conversas: ${formatSeconds(options.safeDelayMs)}, com variação de até +50%`,
      scan ? this._describeScan(scan) : 'Varredura: sem estatísticas registradas nesta execução.'
    ];
    if (untimed.length) {
      lines.push(`As linhas com ${UNTIMED_CLOCK} foram registradas por uma versão anterior da extensão, sem horário nem duração, e vêm antes das demais.`);
    }
    lines.push(
      '',
      ...untimed.map(({ text }) => `${UNTIMED_CLOCK} ${text}`),
      ...timed.map(({ at, text }) => `${new Date(at).toLocaleTimeString('pt-BR')} ${text}`)
    );
    return lines.join('\n') + '\n';
  }

  /**
   * Linha de uma tentativa no log da execução, sem o horário
   * @private
   * @param {number} index Posição na fila
   * @param {string} title
   * @param {AttemptRecord} entry
   * @param {boolean} emptyExport A tentativa salvou o arquivo e o texto da conversa veio em branco
   * @returns {string}
   */
  _describeAttempt(index, title, entry, emptyExport) {
    const label = emptyExport ? EMPTY_EXPORT_LABEL : (RESULT_LABELS[entry.status] ?? entry.status);
    // Uma falha sem código conhecido entra na repescagem; o log diz que ela veio assim
    const code = entry.code ?? (gotFile(entry) ? null : 'sem código');
    const parts = [
      `nº ${index + 1} "${title}"`,
      `tentativa ${entry.attempt}`,
      Number.isFinite(entry.durationMs) ? formatSeconds(entry.durationMs) : 'duração não registrada',
      `abertura: ${entry.via ? (VIA_LABELS[entry.via] ?? entry.via) : 'não informada'}`,
      code ? `${label} (${code})` : label
    ];
    if (entry.quarantined) {
      parts.push(`quarentena: ${entry.late ? 'o arquivo chegou nela, atrasado' : 'o arquivo não foi recebido nela'}`);
    }
    if (entry.reason) parts.push(`motivo: ${entry.reason}`);
    // No fim da linha, para os campos de antes ficarem na mesma posição em todas as tentativas
    if (entry.openDiagnostics) parts.push(...describeOpenDiagnostics(entry.openDiagnostics));
    if (entry.contactInfo) parts.push(describeContactInfoAttempt(entry.contactInfo));
    return parts.join(' | ');
  }

  /**
   * Linhas do _indice.csv, uma por conversa da fila, inclusive as que não foram para o ZIP (falha, não
   * exportável, pasta Downloads). A pasta só se conhece no empacotamento, que a acha pela chave do
   * staging (`chatId`); sem arquivo no staging, a chave é null e a pasta fica vazia.
   * @private
   * @returns {import('../shared/archive/archive-packager.js').IndexRow[]}
   */
  _buildIndexRows() {
    const { queue, results } = this.run;
    return queue.map((chat, index) => {
      const result = results[index];
      const row = {
        chatId: null,
        order: index + 1,
        title: chat.title,
        status: NOT_PROCESSED_LABEL,
        code: null,
        attempts: null,
        bytes: null,
        messageCount: null,
        systemEventCount: null,
        omittedMediaCount: null,
        firstTimestamp: null,
        lastTimestamp: null,
        durationMs: null,
        via: null
      };
      if (!result) return row;

      const history = historyOf(result);
      const durations = history.map((entry) => entry.durationMs);
      const { via } = history.at(-1);
      return {
        ...row,
        chatId: result.staged ? stagingKeyOf(index) : null,
        status: result.empty ? EMPTY_EXPORT_LABEL : (RESULT_LABELS[result.status] ?? result.status),
        code: result.code ?? null,
        attempts: history.length,
        bytes: result.size ?? null,
        messageCount: result.messageCount ?? null,
        systemEventCount: result.systemEventCount ?? null,
        omittedMediaCount: result.omittedMediaCount ?? null,
        firstTimestamp: result.firstTimestamp ?? null,
        lastTimestamp: result.lastTimestamp ?? null,
        // Uma tentativa sem duração (registrada por uma versão anterior da extensão) deixaria a soma abaixo do real
        durationMs: durations.every(Number.isFinite) ? durations.reduce((total, ms) => total + ms, 0) : null,
        via: via ? (VIA_LABELS[via] ?? via) : null
      };
    });
  }

  /**
   * FASE DE EMPACOTAMENTO (PACKAGING) e download único do ZIP master
   * @private
   * @param {AbortSignal} signal
   */
  async _packageAndDownload(signal) {
    this._setPhase(WORKFLOW_STATES.PACKAGING);
    this.currentChatTitle = '';
    this._notifyProgress({ infoMessage: 'Empacotando conversas no ZIP consolidado...' });

    const { summary } = this.getState();
    if (summary.saved === 0) {
      throw new Error('Nenhuma conversa foi salva durante a extração; não há o que empacotar.');
    }

    const archiveFilename = `whatsapp_backup_${new Date().toISOString().slice(0, 10)}.zip`;
    // Toda conversa com arquivo gravado no staging deve estar no ZIP, inclusive as vazias e as atrasadas
    const expectedKeys = this.run.results.flatMap((result, index) => (result?.staged ? [stagingKeyOf(index)] : []));
    const outcome = await ArchiveDownloader.buildAndDownload({
      archiveFilename,
      report: this._buildReport(),
      executionLog: this._buildExecutionLog(),
      indexRows: this._buildIndexRows(),
      expectedKeys,
      signal
    });

    if (!outcome.completed) {
      // Mantém o staging: o usuário pode gerar o download de novo sem refazer as exportações
      this.isPaused = true;
      this.state = WORKFLOW_STATES.PAUSED;
      this.statusMessage = `O download do ZIP não foi concluído (${outcome.error}). Clique em "Retomar" para gerar o download novamente.`;
      this._notifyProgress({ warningMessage: this.statusMessage });
      return;
    }

    // O ZIP já foi salvo: uma falha na limpeza não invalida a execução
    await StagingRepository.clear().catch((err) => log.warn('Falha ao limpar o staging após o download:', err));
    this._setPhase(WORKFLOW_STATES.COMPLETED);
    this.currentChatTitle = 'Concluído';
    // Conta o que foi empacotado, não o que foi salvo: um arquivo que sumiu do staging não está no ZIP
    const { check } = outcome;
    const inZip = `${check.packed} conversa(s) no ZIP` + (summary.empty ? ` (${summary.empty} vazia(s))` : '');
    const counts = [inZip, `${summary.failed} falha(s)`];
    if (summary.notExportable) counts.push(`${summary.notExportable} não exportável(is)`);
    if (summary.savedToDisk) counts.push(`${summary.savedToDisk} baixada(s) direto na pasta Downloads`);
    this.statusMessage = `Backup salvo: ${archiveFilename} (${formatSize(outcome.size)}). ${counts.join(', ')}.`;
    log.info('Fluxo de extração em lote concluído com sucesso!');
    const divergence = describeCheckDivergence(check);
    if (divergence) log.warn(divergence);
    this._notifyProgress({
      infoMessage: `🎉 ${this.statusMessage}`,
      ...(divergence ? { warningMessage: `⚠️ ${divergence}` } : {})
    });
  }
}
