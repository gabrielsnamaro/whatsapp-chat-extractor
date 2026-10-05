import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionOrchestrator } from '../background/extraction-orchestrator.js';
import { ZipBuilder } from '../shared/archive/zip-builder.js';
import { ACTIONS } from '../shared/constants/actions.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import {
  WHATSAPP_TAB_ID,
  createFakeChrome,
  installFakeChrome,
  uninstallFakeChrome,
  armCapture,
  deliverFile,
  whatsAppDownload,
  stubStaging,
  stubArchiveDownloader,
  waitUntil
} from './helpers/fake-chrome.js';

// Sem limite, um cancelamento que deixasse de interromper a espera do arquivo travaria a suíte
// pelos 10 min do prazo de captura em vez de falhar
const TEST_TIMEOUT_MS = 5000;

// Testes de caracterização: descrevem o comportamento atual do orquestrador, para as fases
// seguintes do plano mexerem nele sabendo o que mudou.

const DUPLICATE_NOTE = ' Atenção: existe outra conversa com o mesmo nome, que não foi exportada.';
// Texto que o content (chat-options-menu.js) devolve quando o menu não tem "Exportar conversa"
const EXPORT_UNAVAILABLE_MESSAGE = 'Opção "Exportar conversa" não disponível para esta conversa (ex: chat de avisos ou restrito).';
const DATE_PT_BR = String.raw`\d{2}/\d{2}/\d{4},? \d{2}:\d{2}:\d{2}`;
const CONTENT_LINE_PREFIX = 'Conteúdo: somente texto; o WhatsApp Web exporta sem mídia, e os anexos aparecem como marcadores';

function sidebarChats(titles, { duplicates = [] } = {}) {
  return titles.map((title) => ({
    id: `chat_${title}`,
    title,
    unread: null,
    timestamp: null,
    duplicateTitle: duplicates.includes(title)
  }));
}

/**
 * Texto puro do tamanho pedido: uma linha de mensagem do título seguida de pontos (continuação).
 * Não é ZIP, então o inspetor lê como texto: 1 mensagem, sem anexos.
 */
function chatBytes(title, size) {
  const bytes = new Uint8Array(size).fill(0x2e);
  bytes.set(new TextEncoder().encode(`[01/01/2026, 09:00:00] ${title}: `).subarray(0, size));
  return bytes;
}

/** ZIP como o que o WhatsApp Web exporta: o texto em _chat.txt e um chat.md ao lado */
async function nativeExportZip(chatText) {
  const blob = await ZipBuilder.buildArchive([
    { path: '_chat.txt', content: chatText },
    { path: 'chat.md', content: '# Conversa fictícia\n' }
  ]);
  return new Uint8Array(await blob.arrayBuffer());
}

/** Tamanho como o orquestrador escreve na mensagem da conversa, para arquivos abaixo de 1 MB */
function sizeLabel(bytes) {
  return `${(bytes.length / 1024).toFixed(1)} KB`;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/** Resposta do content real quando a exportação foi disparada na página */
function triggeredResponse(via = 'visible') {
  return { success: true, triggered: true, via, warnings: [] };
}

/**
 * Comportamento da aba no EXPORT_CHAT_REQUEST: arma a captura (como o content real antes do clique
 * em "Exportar") e entrega o arquivo da conversa, ou responde a falha configurada para aquele título,
 * como o content real faz quando a automação DOM falha. A falha é o texto do erro (sem código) ou
 * `{ error, code }`. `failures` vale para as duas tentativas (a da fila e a da repescagem);
 * `firstAttemptFailures`, só para a da fila, e a conversa é recuperada na repescagem. `files` troca os
 * bytes arbitrários de um título por um arquivo específico (ex: um ZIP nativo).
 */
function deliveringExport(orch, { sizes = {}, failures = {}, firstAttemptFailures = {}, files = {} } = {}) {
  return (message) => {
    const { chat, captureId } = message;
    const failure = failures[chat.title] ?? (isRetryAttempt(message) ? undefined : firstAttemptFailures[chat.title]);
    if (failure) {
      const { error, code = null } = typeof failure === 'string' ? { error: failure } : failure;
      return { success: false, cancelled: false, error, code };
    }
    armCapture(orch, captureId);
    deliverFile(orch, captureId, files[chat.title] ?? chatBytes(chat.title, sizes[chat.title] ?? 1536));
    return triggeredResponse();
  };
}

/** Texto do relatório para um arquivo recebido fora de hora; a data depende do fuso */
function unexpectedFileLine(description) {
  return new RegExp(`^- ${DATE_PT_BR}: ${description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

function unexpectedFilesHeader(count) {
  return `Arquivos recebidos fora de hora (${count}): chegaram sem captura armada, não estão no ZIP ` +
    'e o download seguiu para a pasta Downloads. O mesmo arquivo pode aparecer uma vez por fonte (página e chrome.downloads).';
}

const LATE_NOTE = ' Chegou atrasado: o arquivo foi entregue na quarentena, depois do prazo de espera.';

/** Nota da conversa que recebeu arquivo logo depois de uma tentativa que não entregou o dela */
function notDeliveredCheckNote(position, title, attempt) {
  return ` Conferir: a exportação anterior (${position}. "${title}", ${attempt}ª tentativa) não entregou o arquivo.`;
}

/** Linha do cabeçalho do relatório quando houve repescagem */
function retryHeader(total, recovered) {
  return `Repescagem: ${total} conversa(s) tentada(s) de novo no fim da fila, ${recovered} recuperada(s); ` +
    'as demais tiveram uma tentativa só.';
}

/** Tentativa da repescagem: o captureId dela termina com o número da rodada */
function isRetryAttempt(message) {
  return /-r\d+$/.test(message.captureId);
}

let harness = null;
const originalConsole = { log: console.log, warn: console.warn, debug: console.debug };

before(() => {
  // O Logger do background escreve a cada etapa; console.error continua visível
  console.log = () => {};
  console.warn = () => {};
  console.debug = () => {};
});

after(() => {
  Object.assign(console, originalConsole);
});

function setUp({ chats }) {
  const fake = createFakeChrome({ chats });
  installFakeChrome(fake);
  const staging = stubStaging();
  const archive = stubArchiveDownloader({ staging });
  harness = { staging, archive, orchestrators: [] };
  return { fake, staging, archive };
}

function createOrchestrator(options) {
  const orch = new ExtractionOrchestrator(options);
  harness.orchestrators.push(orch);
  return orch;
}

afterEach(async () => {
  if (!harness) return;
  // O keepalive (setInterval de 20 s) só é limpo no fim do laço; sem isso o processo não termina
  for (const orch of harness.orchestrators) {
    if (orch.isBusy()) {
      const loop = orch._loopPromise;
      await orch.cancel();
      await loop;
    }
  }
  harness.archive.restore();
  harness.staging.restore();
  uninstallFakeChrome();
  harness = null;
});

test('três conversas salvas: staging por posição na fila, ZIP e mensagem final', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch, { sizes: { Ana: 1536, Bia: 2048, Caio: 3072 } });
  const listenersDuringExport = [];
  fake.content.onExport = (message) => {
    listenersDuringExport.push(fake.api.downloads.onCreated.listeners.size);
    return deliver(message);
  };

  await orch.start({ downloadAll: true, safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.equal(orch.isBusy(), false);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  assert.equal(state.total, 3);
  assert.equal(state.percentage, 100);
  assert.equal(state.currentChatTitle, 'Concluído');

  // A aba é conferida uma vez, a lista é lida inteira e cada exportação é desarmada ao fim
  const { runId } = orch.run;
  assert.deepEqual(fake.receivedActions(), [
    ACTIONS.CHECK_PAGE_READY,
    ACTIONS.SCAN_CHATS_REQUEST,
    ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE,
    ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE,
    ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE
  ]);
  assert.equal(fake.content.readyChecks, 1);
  assert.equal(fake.content.injected, false);
  assert.equal(fake.content.received[1].maxLimit, null);
  assert.deepEqual(
    fake.content.exportRequests.map((m) => [m.chat, m.captureId]),
    [
      [{ id: 'chat_Ana', title: 'Ana', duplicateTitle: false }, `${runId}-0`],
      [{ id: 'chat_Bia', title: 'Bia', duplicateTitle: false }, `${runId}-1`],
      [{ id: 'chat_Caio', title: 'Caio', duplicateTitle: false }, `${runId}-2`]
    ]
  );
  assert.deepEqual(
    fake.content.received.filter((m) => m.action === ACTIONS.DISARM_EXPORT_CAPTURE).map((m) => m.captureId),
    [`${runId}-0`, `${runId}-1`, `${runId}-2`]
  );

  // A escuta de downloads fica ativa só durante a fila
  assert.deepEqual(listenersDuringExport, [1, 1, 1]);
  assert.equal(fake.api.downloads.onCreated.listeners.size, 0);

  // O arquivo chega intacto ao staging, com a chave da posição na fila
  assert.deepEqual(
    staging.saves.map(({ chatId, chatTitle, filename, size }) => ({ chatId, chatTitle, filename, size })),
    [
      { chatId: '000000', chatTitle: 'Ana', filename: 'conversa.zip', size: 1536 },
      { chatId: '000001', chatTitle: 'Bia', filename: 'conversa.zip', size: 2048 },
      { chatId: '000002', chatTitle: 'Caio', filename: 'conversa.zip', size: 3072 }
    ]
  );
  assert.deepEqual(new Uint8Array(await staging.saves[1].blob.arrayBuffer()), chatBytes('Bia', 2048));

  // Um único ZIP com as três conversas; depois do download o staging é limpo
  assert.equal(archive.calls.length, 1);
  const [{ archiveFilename, report, stagedKeys }] = archive.calls;
  assert.match(archiveFilename, /^whatsapp_backup_\d{4}-\d{2}-\d{2}\.zip$/);
  assert.deepEqual(stagedKeys, ['000000', '000001', '000002']);
  assert.match(report, /^Modo: lista principal \(arquivadas não incluídas\)$/m);
  assert.equal(staging.files.size, 0);

  assert.equal(state.statusMessage, `Backup salvo: ${archiveFilename} (2.0 KB). 3 conversa(s) no ZIP, 0 falha(s).`);
  const infoMessages = fake.progressUpdates().map((m) => m.infoMessage).filter(Boolean);
  assert.deepEqual(infoMessages, [
    '[1/3] ✅ "Ana" salvo (1.5 KB).',
    '[2/3] ✅ "Bia" salvo (2.0 KB).',
    '[3/3] ✅ "Caio" salvo (3.0 KB).',
    'Empacotando conversas no ZIP consolidado...',
    `🎉 ${state.statusMessage}`
  ]);

  const persisted = fake.readStorage('extractionRun');
  assert.equal(persisted.state, WORKFLOW_STATES.COMPLETED);
  assert.equal(persisted.nextIndex, 3);
  assert.deepEqual(persisted.results.map((r) => r.status), ['saved', 'saved', 'saved']);
  // Sem erro não há código; o `via` vem da resposta da aba
  assert.deepEqual(persisted.results.map((r) => [r.code, r.via]), [[null, 'visible'], [null, 'visible'], [null, 'visible']]);
  // Os bytes arbitrários foram inspecionados como texto puro: não estão em branco, mas o formato não
  // foi reconhecido, então não há contagens nem datas (e nada é somado aos anexos omitidos)
  assert.deepEqual(persisted.results[0], {
    title: 'Ana',
    status: 'saved',
    code: null,
    via: 'visible',
    staged: true,
    late: false,
    warnings: [],
    size: 1536,
    empty: false,
    inspectionError: null,
    messageCount: 1,
    systemEventCount: 0,
    omittedMediaCount: 0,
    firstTimestamp: '01/01/2026, 09:00:00',
    lastTimestamp: '01/01/2026, 09:00:00',
    message: '"Ana" salvo (1.5 KB).',
    attempts: 1
  });
  assert.deepEqual(persisted.results.map((r) => r.staged), [true, true, true]);
  // Sem falha não há repescagem: nenhuma conversa é pedida de novo e a lista lateral não é mexida
  assert.deepEqual(persisted.retry, { indices: [], cursor: 0, startsAt: persisted.retry.startsAt });
  assert.equal(state.retry, null);
});

test('falha no meio da fila não interrompe as conversas seguintes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  // A falha se repete na repescagem: a aba responde a mesma falha nas duas tentativas
  fake.content.onExport = deliveringExport(orch, { failures: { Bia: 'Conversa não encontrada na lista.' } });

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Bia']);
  assert.deepEqual(orch.run.results.map((r) => r.status), ['saved', 'failed', 'saved']);
  // Falha sem código conhecido: `code` null; a aba não confirmou a exportação, então `via` também
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'failed',
    code: null,
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: '"Bia": Conversa não encontrada na lista.',
    attempts: 2,
    firstAttemptCode: null
  });

  // A conversa seguinte mantém a chave da sua posição na fila
  assert.deepEqual(staging.saves.map((s) => s.chatId), ['000000', '000002']);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000002']);

  // A captura da conversa que falhou também é desarmada na aba, nas duas tentativas
  const { runId } = orch.run;
  const disarmed = fake.content.received.filter((m) => m.action === ACTIONS.DISARM_EXPORT_CAPTURE).map((m) => m.captureId);
  assert.ok(disarmed.includes(`${runId}-1`));
  assert.ok(disarmed.includes(`${runId}-1-r1`));

  const warnings = fake.progressUpdates().map((m) => m.warningMessage).filter(Boolean);
  assert.deepEqual(warnings, [
    '[2/3] ⚠️ "Bia": Conversa não encontrada na lista.',
    '[Repescagem 1/1] ⚠️ "Bia": Conversa não encontrada na lista.'
  ]);
  assert.match(state.statusMessage, /\. 2 conversa\(s\) no ZIP, 1 falha\(s\)\.$/);
});

test('cancelamento durante a espera do arquivo encerra sem empacotar', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch);
  // Bia: a página arma a captura e confirma a exportação, mas o arquivo nunca chega
  fake.content.onExport = (message) => {
    if (message.chat.title !== 'Bia') return deliver(message);
    armCapture(orch, message.captureId);
    return { success: true, triggered: true };
  };

  const loop = orch.start({ safeDelayMs: 0 });
  await waitUntil(
    () => fake.content.exportRequests.length === 2 && orch.getState().state === WORKFLOW_STATES.WAITING_DOWNLOAD,
    { description: 'orquestrador esperando o arquivo de "Bia"' }
  );

  await orch.cancel();
  await loop;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.CANCELLED);
  assert.equal(state.statusMessage, 'Extração cancelada.');
  assert.equal(orch.isBusy(), false);
  assert.equal(archive.calls.length, 0);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia']);
  assert.ok(fake.receivedActions().includes(ACTIONS.CANCEL_CURRENT_OPERATION));

  // A conversa interrompida não ganha resultado e fica como a próxima da fila
  assert.equal(orch.run.nextIndex, 1);
  assert.equal(orch.run.results.length, 1);
  assert.deepEqual(state.summary, { saved: 1, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });

  // O staging não é limpo no cancelamento
  assert.deepEqual([...staging.files.keys()], ['000000']);

  // Um arquivo que chegue depois do cancelamento é recusado
  const late = orch.captures.handleTransferMessage({
    action: ACTIONS.EXPORT_TRANSFER_START,
    captureId: `${orch.run.runId}-1`,
    totalChunks: 1,
    size: 10
  });
  assert.equal(late.success, false);

  assert.equal(fake.readStorage('extractionRun').state, WORKFLOW_STATES.CANCELLED);
  assert.equal(fake.api.downloads.onCreated.listeners.size, 0);
});

test('relatório: cabeçalho, datas e uma linha por conversa', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({
    chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi'], { duplicates: ['Caio'] })
  });
  const orch = createOrchestrator();
  // Como o content real: a varredura parou no limite, e a última conversa lida exibia "Ontem"
  fake.content.scanStats = { steps: 1, durationMs: 1400, stopReason: 'limit-reached', lastChatTimestamp: 'Ontem' };
  fake.content.onExport = deliveringExport(orch, {
    sizes: { Ana: 1536, Caio: 3072 },
    failures: { Bia: 'Conversa não encontrada na lista.' }
  });

  await orch.start({ downloadAll: false, maxChats: 3, safeDelayMs: 0, retryCooldownMs: 0 });

  // Com limite, a varredura recebe o limite e a fila para nele; Bia é tentada de novo na repescagem
  assert.equal(fake.content.received.find((m) => m.action === ACTIONS.SCAN_CHATS_REQUEST).maxLimit, 3);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Bia']);

  const { report } = archive.calls[0];
  assert.ok(report.endsWith('\n'));
  const lines = report.split('\n');
  assert.equal(lines.length, 13);
  assert.equal(lines[0], 'Relatório de extração - WhatsApp Web Extractor');
  // As datas dependem do fuso de quem roda o teste
  assert.match(lines[1], new RegExp(`^Início: ${DATE_PT_BR}$`));
  assert.match(lines[2], new RegExp(`^Geração do ZIP: ${DATE_PT_BR}$`));
  assert.deepEqual(lines.slice(3), [
    'Modo: limite de 3 conversa(s)',
    'Varredura: 3 conversa(s) encontrada(s) em 1 s; parou ao atingir o limite escolhido; data/hora exibida na última conversa: Ontem.',
    `${CONTENT_LINE_PREFIX} (0 anexo(s) omitido(s) nesta execução).`,
    'Conversas na fila: 3 | no ZIP: 2 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 1',
    retryHeader(1, 0),
    '',
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[FALHA] 2. "Bia": Conversa não encontrada na lista. Tentativas: 2.',
    `[OK] 3. "Caio" salvo (3.0 KB).${DUPLICATE_NOTE}`,
    ''
  ]);
});

test('conversa sem "Exportar conversa" no menu é não exportável, contada à parte das falhas', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, {
    failures: { Bia: { error: EXPORT_UNAVAILABLE_MESSAGE, code: 'EXPORT_OPTION_UNAVAILABLE' } }
  });

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 1, failed: 0 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio']);
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'not_exportable',
    code: 'EXPORT_OPTION_UNAVAILABLE',
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: `"Bia": ${EXPORT_UNAVAILABLE_MESSAGE}`,
    attempts: 1
  });

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[5], 'Conversas na fila: 3 | no ZIP: 2 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 1 | falhas: 0');
  assert.deepEqual(lines.slice(7, 10), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[NÃO EXPORTÁVEL] 2. "Bia": ${EXPORT_UNAVAILABLE_MESSAGE}`,
    '[OK] 3. "Caio" salvo (1.5 KB).'
  ]);

  // Popup: o aviso da conversa leva a marcação, e o resumo traz a contagem à parte
  const updates = fake.progressUpdates();
  assert.deepEqual(
    updates.map((m) => m.warningMessage).filter(Boolean),
    [`[2/3] ⚠️ [NÃO EXPORTÁVEL] "Bia": ${EXPORT_UNAVAILABLE_MESSAGE}`]
  );
  assert.equal(updates.at(-1).summary.notExportable, 1);
  assert.equal(updates.at(-1).summary.failed, 0);
  assert.match(state.statusMessage, /\. 2 conversa\(s\) no ZIP, 0 falha\(s\), 1 não exportável\(is\)\.$/);
});

test('arquivo não entregue no prazo nem na quarentena: falha FILE_NOT_DELIVERED do prazo original, e a seguinte fica marcada para conferir', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']) });
  const captureTimeoutMs = 50;
  const quarantineMs = 60;
  const orch = createOrchestrator({ timings: { captureTimeoutMs, quarantineMs } });
  const deliver = deliveringExport(orch);
  // Bia: a página abre a conversa pela busca, arma a captura e confirma a exportação, mas o arquivo nunca chega
  fake.content.onExport = (message) => {
    if (message.chat.title !== 'Bia') return deliver(message);
    armCapture(orch, message.captureId);
    return triggeredResponse('search');
  };

  const startedAt = performance.now();
  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });
  // A folga de 10 ms cobre o relógio dos timers do Node, que pode disparar um pouco antes. São duas
  // esperas: a da fila e a da repescagem, em que o arquivo de Bia também não chega
  assert.ok(
    performance.now() - startedAt >= 2 * (captureTimeoutMs + quarantineMs) - 10,
    'cada espera pelo arquivo deveria durar o prazo e mais a quarentena'
  );

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Davi', 'Bia']);

  // A mensagem é a do prazo original, não a da quarentena
  const notDelivered = 'O WhatsApp Web não entregou o arquivo exportado em 0.05 s.';
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'failed',
    code: 'FILE_NOT_DELIVERED',
    via: 'search',
    staged: false,
    late: false,
    warnings: [],
    message: `"Bia": ${notDelivered}`,
    attempts: 2,
    firstAttemptCode: 'FILE_NOT_DELIVERED'
  });

  // Um arquivo atrasado de Bia que chegasse depois do clique em "Exportar" de Caio seria tomado como de
  // Caio: o relatório marca só a conversa seguinte a um FILE_NOT_DELIVERED e diz qual tentativa foi
  assert.deepEqual(archive.calls[0].report.split('\n').slice(8, 12), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[FALHA] 2. "Bia": ${notDelivered} Tentativas: 2.`,
    `[OK] 3. "Caio" salvo (1.5 KB).${notDeliveredCheckNote(2, 'Bia', 1)}`,
    '[OK] 4. "Davi" salvo (1.5 KB).'
  ]);
  // A marcação é só do relatório; o resultado de Caio não muda
  assert.equal(orch.run.results[2].message, '"Caio" salvo (1.5 KB).');
  assert.equal(fake.readStorage('extractionRun').results[1].code, 'FILE_NOT_DELIVERED');
});

test('arquivo atrasado chega na quarentena, pela página ou pelo chrome.downloads, e é salvo na conversa certa', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']) });
  const captureTimeoutMs = 40;
  const lateDelayMs = 100;
  const orch = createOrchestrator({ timings: { captureTimeoutMs, quarantineMs: 2000 } });
  const deliver = deliveringExport(orch);
  const disarmedBeforeArrival = {};
  const disarmed = (captureId) => fake.content.received.some((m) => m.action === ACTIONS.DISARM_EXPORT_CAPTURE && m.captureId === captureId);

  fake.content.onFetchBlob = (message) => {
    deliverFile(orch, message.captureId, chatBytes('Caio', 3072), { filename: message.filename, source: 'download' });
    return { success: true };
  };
  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    if (chat.title !== 'Bia' && chat.title !== 'Caio') return deliver(message);
    armCapture(orch, captureId);
    // O arquivo chega depois do prazo, dentro da quarentena: Bia pelo clique na página, Caio pelo chrome.downloads
    setTimeout(() => {
      disarmedBeforeArrival[chat.title] = disarmed(captureId);
      if (chat.title === 'Bia') deliverFile(orch, captureId, chatBytes('Bia', 2048));
      else fake.dispatchDownload(whatsAppDownload({ id: 41, filename: '' }));
    }, lateDelayMs);
    return triggeredResponse();
  };

  const startedAt = performance.now();
  await orch.start({ safeDelayMs: 0 });
  const elapsed = performance.now() - startedAt;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 4, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  // A quarentena termina quando o arquivo chega, sem esperar o prazo dela inteiro
  assert.ok(elapsed >= 2 * lateDelayMs - 10, `a fila terminou em ${elapsed.toFixed(0)} ms, antes da chegada dos arquivos`);
  assert.ok(elapsed < 1500, `a fila levou ${elapsed.toFixed(0)} ms: a quarentena não terminou com a chegada do arquivo`);

  // As duas fontes continuavam armadas: nada foi desarmado na aba antes da chegada
  assert.deepEqual(disarmedBeforeArrival, { Bia: false, Caio: false });
  assert.equal(fake.content.fetchRequests.length, 1);
  assert.equal(fake.content.fetchRequests[0].captureId, `${orch.run.runId}-2`);

  assert.deepEqual(orch.run.results.map(({ status, code, staged, late }) => ({ status, code, staged, late })), [
    { status: 'saved', code: null, staged: true, late: false },
    { status: 'saved', code: null, staged: true, late: true },
    { status: 'saved', code: null, staged: true, late: true },
    { status: 'saved', code: null, staged: true, late: false }
  ]);
  assert.equal(orch.run.results[1].message, `"Bia" salvo (2.0 KB).${LATE_NOTE}`);
  // Chegou na quarentena: a conversa foi salva e não é repescada
  assert.deepEqual(orch.run.results.map((r) => r.attempts), [1, 1, 1, 1]);
  assert.equal(fake.content.exportRequests.length, 4);

  // Salvo na conversa certa, com a mesma inspeção e o mesmo staging das outras
  assert.deepEqual(staging.saves.map(({ chatId, chatTitle, filename, size }) => ({ chatId, chatTitle, filename, size })), [
    { chatId: '000000', chatTitle: 'Ana', filename: 'conversa.zip', size: 1536 },
    { chatId: '000001', chatTitle: 'Bia', filename: 'conversa.zip', size: 2048 },
    { chatId: '000002', chatTitle: 'Caio', filename: 'exportacao.zip', size: 3072 },
    { chatId: '000003', chatTitle: 'Davi', filename: 'conversa.zip', size: 1536 }
  ]);
  assert.deepEqual(new Uint8Array(await staging.saves[1].blob.arrayBuffer()), chatBytes('Bia', 2048));
  assert.equal(orch.run.results[1].messageCount, 1);

  // Chegou na quarentena: a conversa seguinte não é marcada para conferir
  assert.deepEqual(archive.calls[0].report.split('\n').slice(7, 11), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[OK] 2. "Bia" salvo (2.0 KB).${LATE_NOTE}`,
    `[OK] 3. "Caio" salvo (3.0 KB).${LATE_NOTE}`,
    '[OK] 4. "Davi" salvo (1.5 KB).'
  ]);
  assert.equal(fake.readStorage('extractionRun').results[1].late, true);
});

test('outra falha na quarentena prevalece sobre o prazo esgotado: leitura falha na página ou tamanho divergente', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']) });
  const captureTimeoutMs = 40;
  const lateDelayMs = 100;
  const orch = createOrchestrator({ timings: { captureTimeoutMs, quarantineMs: 2000 } });
  const deliver = deliveringExport(orch);
  const arrivedAfterMs = {};

  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    if (chat.title !== 'Bia' && chat.title !== 'Caio') return deliver(message);
    armCapture(orch, captureId);
    const requestedAt = performance.now();
    const transfer = (fields) => orch.captures.handleTransferMessage({ captureId, ...fields });
    // Depois do prazo, dentro da quarentena: a página de Bia não consegue ler o arquivo, e de Caio
    // chegam menos bytes do que o anunciado
    setTimeout(() => {
      arrivedAfterMs[chat.title] = performance.now() - requestedAt;
      if (chat.title === 'Bia') {
        transfer({ action: ACTIONS.EXPORT_TRANSFER_FAILED, error: 'HTTP 404 ao ler o arquivo exportado.' });
        return;
      }
      transfer({ action: ACTIONS.EXPORT_TRANSFER_START, filename: 'conversa.zip', mimeType: 'application/zip', size: 10, totalChunks: 1 });
      transfer({ action: ACTIONS.EXPORT_TRANSFER_CHUNK, index: 0, data: Buffer.from('12345').toString('base64') });
      transfer({ action: ACTIONS.EXPORT_TRANSFER_END });
    }, lateDelayMs);
    return triggeredResponse();
  };

  const startedAt = performance.now();
  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });
  const elapsed = performance.now() - startedAt;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 0, failed: 2 });
  for (const title of ['Bia', 'Caio']) {
    assert.ok(arrivedAfterMs[title] >= captureTimeoutMs, `a falha de "${title}" chegou antes do fim do prazo original`);
  }
  // A quarentena termina com a falha, sem esperar o prazo dela inteiro (na fila e na repescagem)
  assert.ok(elapsed < 1500, `a execução levou ${elapsed.toFixed(0)} ms: a quarentena não terminou com a falha`);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Davi', 'Bia', 'Caio']);

  // O código e a mensagem são os da falha que chegou, não os do prazo esgotado; as duas falham igual na repescagem
  assert.deepEqual(orch.run.results.slice(1, 3), [
    {
      title: 'Bia',
      status: 'failed',
      code: 'TRANSFER_FAILED',
      via: 'visible',
      staged: false,
      late: false,
      warnings: [],
      message: '"Bia": HTTP 404 ao ler o arquivo exportado.',
      attempts: 2,
      firstAttemptCode: 'TRANSFER_FAILED'
    },
    {
      title: 'Caio',
      status: 'failed',
      code: 'SIZE_MISMATCH',
      via: 'visible',
      staged: false,
      late: false,
      warnings: [],
      message: '"Caio": Arquivo recebido com 5 bytes; esperados 10.',
      attempts: 2,
      firstAttemptCode: 'SIZE_MISMATCH'
    }
  ]);
  assert.deepEqual(staging.saves.map((s) => s.chatTitle), ['Ana', 'Davi']);

  // Sem FILE_NOT_DELIVERED no resultado, a conversa seguinte não é marcada para conferir
  assert.deepEqual(archive.calls[0].report.split('\n').slice(8, 12), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[FALHA] 2. "Bia": HTTP 404 ao ler o arquivo exportado. Tentativas: 2.',
    '[FALHA] 3. "Caio": Arquivo recebido com 5 bytes; esperados 10. Tentativas: 2.',
    '[OK] 4. "Davi" salvo (1.5 KB).'
  ]);
});

test('"conferir" só marca a conversa seguinte que recebeu arquivo, não uma falha nem uma não exportável', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Fabi', 'Gil', 'Hugo', 'Ivo', 'Juca']);
  const { fake, archive } = setUp({ chats });
  const captureTimeoutMs = 20;
  const quarantineMs = 80;
  const orch = createOrchestrator({ timings: { captureTimeoutMs, quarantineMs } });
  const emptyZip = await nativeExportZip('\n');
  const deliver = deliveringExport(orch, {
    files: { Fabi: emptyZip },
    failures: {
      Bia: 'Conversa não encontrada na lista.',
      Juca: { error: EXPORT_UNAVAILABLE_MESSAGE, code: 'EXPORT_OPTION_UNAVAILABLE' }
    }
  });
  // Cada uma destas confirma a exportação, mas o arquivo não chega nem no prazo nem na quarentena
  const notDelivered = ['Ana', 'Caio', 'Eva', 'Gil', 'Ivo'];

  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    if (notDelivered.includes(chat.title)) {
      armCapture(orch, captureId);
      return triggeredResponse();
    }
    if (chat.title === 'Davi') {
      armCapture(orch, captureId);
      orch.captures.resolveSavedToDisk(captureId, { filename: 'Conversa do WhatsApp com Davi.zip', downloadId: 4 });
      return triggeredResponse();
    }
    if (chat.title === 'Hugo') {
      armCapture(orch, captureId);
      // Depois do prazo, no meio da quarentena
      setTimeout(() => deliverFile(orch, captureId, chatBytes('Hugo', 2048)), captureTimeoutMs + quarantineMs / 2);
      return triggeredResponse();
    }
    return deliver(message);
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  // As falhas são repescadas e falham do mesmo jeito; as que receberam arquivo e a não exportável, não
  assert.deepEqual(orch.run.retry.indices, [0, 1, 2, 4, 6, 8]);
  const notDeliveredMessage = 'O WhatsApp Web não entregou o arquivo exportado em 0.02 s.';
  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[5], 'Conversas na fila: 10 | no ZIP: 2 (vazias: 1) | na pasta Downloads: 1 | não exportáveis: 1 | falhas: 6');
  assert.equal(lines[6], retryHeader(6, 0));
  // Cada conversa par vem depois de um FILE_NOT_DELIVERED: Bia (falha) e Juca (não exportável) não
  // receberam arquivo nenhum e não são marcadas; na pasta Downloads, vazia e atrasada, sim. Na
  // repescagem todas falham, então nenhuma tentativa dela recebe a marcação
  assert.deepEqual(lines.slice(8, 18), [
    `[FALHA] 1. "Ana": ${notDeliveredMessage} Tentativas: 2.`,
    '[FALHA] 2. "Bia": Conversa não encontrada na lista. Tentativas: 2.',
    `[FALHA] 3. "Caio": ${notDeliveredMessage} Tentativas: 2.`,
    '[NA PASTA DOWNLOADS] 4. "Davi" foi baixado direto para a pasta Downloads (Conversa do WhatsApp com Davi.zip) e não está no ZIP.' +
      notDeliveredCheckNote(3, 'Caio', 1),
    `[FALHA] 5. "Eva": ${notDeliveredMessage} Tentativas: 2.`,
    `[OK – VAZIA] 6. "Fabi" salvo (${sizeLabel(emptyZip)}).${notDeliveredCheckNote(5, 'Eva', 1)}`,
    `[FALHA] 7. "Gil": ${notDeliveredMessage} Tentativas: 2.`,
    `[OK] 8. "Hugo" salvo (2.0 KB).${LATE_NOTE}${notDeliveredCheckNote(7, 'Gil', 1)}`,
    `[FALHA] 9. "Ivo": ${notDeliveredMessage} Tentativas: 2.`,
    `[NÃO EXPORTÁVEL] 10. "Juca": ${EXPORT_UNAVAILABLE_MESSAGE}`
  ]);
});

test('código do erro gravado em cada resultado, venha da página ou da captura do arquivo', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch, {
    failures: { Ana: { error: 'Há mais de uma conversa chamada "Ana"; não é possível escolher com segurança.', code: 'AMBIGUOUS_TITLE' } }
  });
  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    const transfer = (fields) => orch.captures.handleTransferMessage({ captureId, ...fields });
    if (chat.title !== 'Ana') armCapture(orch, captureId);
    switch (chat.title) {
      case 'Bia':
        // A página confirmou a exportação, mas não conseguiu ler o arquivo gerado
        transfer({ action: ACTIONS.EXPORT_TRANSFER_FAILED, error: 'HTTP 404 ao ler o arquivo exportado.' });
        return triggeredResponse();
      case 'Caio':
        // Chegaram menos bytes do que o anunciado no início da transferência
        transfer({ action: ACTIONS.EXPORT_TRANSFER_START, filename: 'conversa.zip', mimeType: 'application/zip', size: 10, totalChunks: 1 });
        transfer({ action: ACTIONS.EXPORT_TRANSFER_CHUNK, index: 0, data: Buffer.from('12345').toString('base64') });
        transfer({ action: ACTIONS.EXPORT_TRANSFER_END });
        return triggeredResponse();
      case 'Davi':
        deliverFile(orch, captureId, chatBytes('Davi', 1536));
        return triggeredResponse('search');
      case 'Eva':
        orch.captures.resolveSavedToDisk(captureId, { filename: 'Conversa do WhatsApp com Eva.zip', downloadId: 9 });
        return triggeredResponse('scroll');
      default:
        return deliver(message);
    }
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 1, empty: 0, savedToDisk: 1, notExportable: 0, failed: 3 });
  // Bia e Caio são repescadas e falham do mesmo jeito; Ana (homônimo) fica fora da repescagem
  assert.deepEqual(orch.run.results.map(({ attempts, firstAttemptCode }) => [attempts, firstAttemptCode]), [
    [1, undefined], [2, 'TRANSFER_FAILED'], [2, 'SIZE_MISMATCH'], [1, undefined], [1, undefined]
  ]);
  assert.deepEqual(orch.run.results.map(({ status, code, via }) => [status, code, via]), [
    ['failed', 'AMBIGUOUS_TITLE', null],
    ['failed', 'TRANSFER_FAILED', 'visible'],
    ['failed', 'SIZE_MISMATCH', 'visible'],
    ['saved', null, 'search'],
    ['saved_to_disk', null, 'scroll']
  ]);
  // Só o arquivo que foi gravado no staging conta como `staged`; o da pasta Downloads, não
  assert.deepEqual(orch.run.results.map((r) => r.staged), [false, false, false, true, false]);
  assert.deepEqual(orch.run.results.slice(1, 3).map((r) => r.message), [
    '"Bia": HTTP 404 ao ler o arquivo exportado.',
    '"Caio": Arquivo recebido com 5 bytes; esperados 10.'
  ]);

  // O código e o `via` sobrevivem ao checkpoint, para a retomada e o relatório
  assert.deepEqual(
    fake.readStorage('extractionRun').results.map((r) => [r.code, r.via]),
    [['AMBIGUOUS_TITLE', null], ['TRANSFER_FAILED', 'visible'], ['SIZE_MISMATCH', 'visible'], [null, 'search'], [null, 'scroll']]
  );
  assert.match(state.statusMessage, /\. 1 conversa\(s\) no ZIP, 3 falha\(s\), 1 baixada\(s\) direto na pasta Downloads\.$/);
});

test('exportação vazia: [OK – VAZIA] no relatório, contada no ZIP e gravada no staging', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  // Como as 9 conversas vazias de 01/10/2026: o ZIP chega, mas o _chat.txt só tem uma quebra de linha
  const emptyZip = await nativeExportZip('\n');
  fake.content.onExport = deliveringExport(orch, { files: { Bia: emptyZip } });

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  // A vazia está no ZIP: conta em `saved` e, à parte, em `empty`
  assert.deepEqual(state.summary, { saved: 3, empty: 1, savedToDisk: 0, notExportable: 0, failed: 0 });
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'saved',
    code: null,
    via: 'visible',
    staged: true,
    late: false,
    warnings: [],
    size: emptyZip.length,
    empty: true,
    inspectionError: null,
    messageCount: 0,
    systemEventCount: 0,
    omittedMediaCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    message: `"Bia" salvo (${sizeLabel(emptyZip)}).`,
    attempts: 1
  });

  // O arquivo vazio vai para o staging e para o ZIP como os outros
  assert.deepEqual(staging.saves.map((s) => s.chatId), ['000000', '000001', '000002']);
  assert.deepEqual(new Uint8Array(await staging.saves[1].blob.arrayBuffer()), emptyZip);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002']);

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[5], 'Conversas na fila: 3 | no ZIP: 3 (vazias: 1) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0');
  assert.deepEqual(lines.slice(7, 10), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[OK – VAZIA] 2. "Bia" salvo (${sizeLabel(emptyZip)}).`,
    '[OK] 3. "Caio" salvo (1.5 KB).'
  ]);

  // Popup: aviso com a marcação, e a contagem no resumo e na mensagem final
  const updates = fake.progressUpdates();
  assert.deepEqual(
    updates.map((m) => m.warningMessage).filter(Boolean),
    [`[2/3] ⚠️ [OK – VAZIA] "Bia" salvo (${sizeLabel(emptyZip)}).`]
  );
  assert.equal(updates.at(-1).summary.empty, 1);
  assert.match(state.statusMessage, /\. 3 conversa\(s\) no ZIP \(1 vazia\(s\)\), 0 falha\(s\)\.$/);
  assert.equal(fake.readStorage('extractionRun').results[1].empty, true);
});

test('conteúdo não inspecionado: a conversa é salva mesmo assim, e o relatório e o log dizem o motivo', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  // ZIP com a assinatura certa, cortado no meio do _chat.txt comprimido
  const fullZip = await nativeExportZip('[01/02/2026, 09:01:00] Ana: Bom dia!\n'.repeat(40));
  const truncatedZip = fullZip.slice(0, 30 + '_chat.txt'.length + 10);
  fake.content.onExport = deliveringExport(orch, { files: { Bia: truncatedZip } });

  const warnings = [];
  const silencedWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    await orch.start({ safeDelayMs: 0 });
  } finally {
    console.warn = silencedWarn;
  }

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });

  const result = orch.run.results[1];
  assert.match(result.inspectionError, /^O texto da conversa \(_chat\.txt\) está ilegível no ZIP exportado \(.+\)\.$/);
  assert.deepEqual(result, {
    title: 'Bia',
    status: 'saved',
    code: null,
    via: 'visible',
    staged: true,
    late: false,
    warnings: [],
    size: truncatedZip.length,
    empty: false,
    inspectionError: result.inspectionError,
    messageCount: null,
    systemEventCount: null,
    omittedMediaCount: null,
    firstTimestamp: null,
    lastTimestamp: null,
    message: `"Bia" salvo (${sizeLabel(truncatedZip)}). Conteúdo não inspecionado: ${result.inspectionError}`,
    attempts: 1
  });

  // O arquivo vai para o staging como chegou
  assert.deepEqual(new Uint8Array(await staging.saves[1].blob.arrayBuffer()), truncatedZip);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002']);
  assert.equal(archive.calls[0].report.split('\n')[8], `[OK] 2. ${result.message}`);
  assert.equal(fake.readStorage('extractionRun').results[1].inspectionError, result.inspectionError);

  // A falha da inspeção vai para o log do background, com o erro original
  const inspectionWarnings = warnings.filter(([message]) => String(message).includes('Conteúdo de "Bia" não inspecionado'));
  assert.equal(inspectionWarnings.length, 1);
  assert.ok(inspectionWarnings[0][1] instanceof Error);
});

test('anexos omitidos: contagem na linha da conversa e total da execução no cabeçalho', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const anaZip = await nativeExportZip([
    '[01/02/2026, 09:00:00] - Ana criou o grupo "Família"',
    '[01/02/2026, 09:01:00] Ana: <imagem ocultada>',
    '[01/02/2026, 09:02:00] Bia: <documento omitido>',
    'legenda do documento',
    '[01/02/2026, 09:03:00] Ana: <mensagem de voz omitida>',
    ''
  ].join('\n'));
  const biaZip = await nativeExportZip('[02/02/2026, 10:00:00] Bia: só texto\n');
  const caioZip = await nativeExportZip('[03/02/2026, 11:00:00] Caio: <áudio omitido>\n');
  fake.content.onExport = deliveringExport(orch, { files: { Ana: anaZip, Bia: biaZip, Caio: caioZip } });

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[4], `${CONTENT_LINE_PREFIX} (4 anexo(s) omitido(s) nesta execução).`);
  assert.deepEqual(lines.slice(7, 10), [
    `[OK] 1. "Ana" salvo (${sizeLabel(anaZip)}, 3 anexo(s) omitido(s)).`,
    `[OK] 2. "Bia" salvo (${sizeLabel(biaZip)}).`,
    `[OK] 3. "Caio" salvo (${sizeLabel(caioZip)}, 1 anexo(s) omitido(s)).`
  ]);

  // Os campos da inspeção ficam no resultado persistido, junto do status
  assert.deepEqual(
    fake.readStorage('extractionRun').results.map(({ messageCount, systemEventCount, omittedMediaCount, firstTimestamp, lastTimestamp }) => (
      { messageCount, systemEventCount, omittedMediaCount, firstTimestamp, lastTimestamp }
    )),
    [
      { messageCount: 3, systemEventCount: 1, omittedMediaCount: 3, firstTimestamp: '01/02/2026, 09:00:00', lastTimestamp: '01/02/2026, 09:03:00' },
      { messageCount: 1, systemEventCount: 0, omittedMediaCount: 0, firstTimestamp: '02/02/2026, 10:00:00', lastTimestamp: '02/02/2026, 10:00:00' },
      { messageCount: 1, systemEventCount: 0, omittedMediaCount: 1, firstTimestamp: '03/02/2026, 11:00:00', lastTimestamp: '03/02/2026, 11:00:00' }
    ]
  );

  const infoMessages = fake.progressUpdates().map((m) => m.infoMessage).filter(Boolean);
  assert.equal(infoMessages[0], `[1/3] ✅ "Ana" salvo (${sizeLabel(anaZip)}, 3 anexo(s) omitido(s)).`);
  assert.match(state.statusMessage, /\. 3 conversa\(s\) no ZIP, 0 falha\(s\)\.$/);
});

test('formato do texto não reconhecido e conteúdo não inspecionado: a linha avisa e o total de anexos fica marcado como parcial', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const anaZip = await nativeExportZip('[01/02/2026, 09:01:00] Ana: <imagem ocultada>\n');
  const biaZip = await nativeExportZip('texto sem nenhuma linha de mensagem reconhecível\n');
  const caioFull = await nativeExportZip('[03/02/2026, 11:00:00] Caio: Bom dia!\n'.repeat(40));
  const caioTruncated = caioFull.slice(0, 30 + '_chat.txt'.length + 10);
  fake.content.onExport = deliveringExport(orch, { files: { Ana: anaZip, Bia: biaZip, Caio: caioTruncated } });

  const silencedWarn = console.warn;
  console.warn = () => {};
  try {
    await orch.start({ safeDelayMs: 0 });
  } finally {
    console.warn = silencedWarn;
  }

  const lines = archive.calls[0].report.split('\n');
  assert.equal(
    lines[4],
    `${CONTENT_LINE_PREFIX} (1 anexo(s) omitido(s) nesta execução; total parcial: 2 conversa(s) sem contagem).`
  );
  assert.equal(lines[8], `[OK] 2. "Bia" salvo (${sizeLabel(biaZip)}). Formato do texto não reconhecido: mensagens e anexos não contados.`);
  assert.match(lines[9], /^\[OK\] 3\. "Caio" salvo \([^)]*\)\. Conteúdo não inspecionado: /);
});

test('retomada no meio da fila: nova instância exporta só as conversas restantes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']);
  const { fake: fakeA, staging, archive } = setUp({ chats });
  const orchA = createOrchestrator();
  const deliverA = deliveringExport(orchA);
  const stalled = createDeferred();
  let snapshot = null;

  // Na 3ª conversa, o storage é copiado como estaria se o Chrome encerrasse o service worker
  // ali, e a instância A fica presa esperando um arquivo que não vem
  fakeA.content.onExport = (message) => {
    if (message.chat.title !== 'Caio') return deliverA(message);
    snapshot = fakeA.snapshotStorage();
    stalled.resolve();
    return { success: true, triggered: true };
  };

  const loopA = orchA.start({ safeDelayMs: 0 });
  await stalled.promise;
  await orchA.cancel();
  await loopA;

  assert.equal(snapshot.extractionRun.state, WORKFLOW_STATES.EXPORTING);
  assert.equal(snapshot.extractionRun.nextIndex, 2);
  assert.equal(snapshot.extractionRun.results.length, 2);
  const { runId } = snapshot.extractionRun;

  // Instância B: service worker novo, com o storage do momento da interrupção
  const fakeB = createFakeChrome({ chats, storage: snapshot });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  fakeB.content.onExport = deliveringExport(orchB);

  await orchB.restore();
  const restored = orchB.getState();
  assert.equal(restored.state, WORKFLOW_STATES.PAUSED);
  assert.equal(restored.statusMessage, 'A extração foi interrompida pelo navegador. Clique em "Retomar" para continuar de onde parou.');
  assert.equal(restored.current, 3);
  assert.equal(restored.total, 5);
  assert.equal(orchB.isBusy(), false);

  // resume() não devolve a promise do laço
  assert.equal(orchB.resume(), true);
  const loopB = orchB._loopPromise;
  assert.ok(loopB, 'resume() deveria iniciar um laço novo');
  await loopB;

  const state = orchB.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 5, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });

  // B reconfere a aba, não refaz a varredura e continua do índice salvo, com o mesmo runId
  assert.equal(fakeB.content.readyChecks, 1);
  assert.equal(fakeB.receivedActions().includes(ACTIONS.SCAN_CHATS_REQUEST), false);
  assert.deepEqual(
    fakeB.content.exportRequests.map((m) => [m.chat.title, m.captureId]),
    [['Caio', `${runId}-2`], ['Davi', `${runId}-3`], ['Eva', `${runId}-4`]]
  );

  // O ZIP junta o que A salvou antes da interrupção com o que B salvou depois
  assert.deepEqual(staging.saves.map((s) => [s.chatId, s.chatTitle]), [
    ['000000', 'Ana'], ['000001', 'Bia'], ['000002', 'Caio'], ['000003', 'Davi'], ['000004', 'Eva']
  ]);
  assert.equal(archive.calls.length, 1);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002', '000003', '000004']);
  const okLines = archive.calls[0].report.split('\n').filter((line) => line.startsWith('[OK] '));
  assert.equal(okLines.length, 5);
});

test('intervalo entre conversas fica entre d e 1,5 × d, sem espera depois da última', { timeout: TEST_TIMEOUT_MS }, async () => {
  const delayMs = 40;
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  // Registra só os timers criados diretamente pelo orquestrador (o intervalo entre conversas)
  const realSetTimeout = globalThis.setTimeout;
  const sleeps = [];
  globalThis.setTimeout = function recordingSetTimeout(callback, ms, ...args) {
    const caller = new Error().stack.split('\n')[2] || '';
    if (caller.includes('extraction-orchestrator.js')) {
      sleeps.push({ ms, afterExport: fake.content.exportRequests.length });
    }
    return realSetTimeout(callback, ms, ...args);
  };
  try {
    await orch.start({ safeDelayMs: delayMs });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.equal(archive.calls.length, 1);

  // Uma espera depois da 1ª e da 2ª conversa; nenhuma depois da 3ª
  assert.deepEqual(sleeps.map((s) => s.afterExport), [1, 2]);
  for (const { ms } of sleeps) {
    assert.ok(ms >= delayMs && ms <= delayMs * 1.5, `intervalo de ${ms} ms fora de [${delayMs}, ${delayMs * 1.5}]`);
  }

  // A espera acontece de fato entre uma exportação e a seguinte. A folga de 5 ms cobre o relógio
  // dos timers do Node, que é o do início da volta do event loop e pode disparar um pouco antes
  const arrivals = fake.content.exportRequests.map((m) => m.receivedAt);
  for (let i = 1; i < arrivals.length; i++) {
    const gap = arrivals[i] - arrivals[i - 1];
    assert.ok(gap >= sleeps[i - 1].ms - 5, `entre a conversa ${i} e a ${i + 1} passaram ${gap.toFixed(1)} ms`);
  }
});

test('intervalo entre conversas inválido: start() lança o erro sem começar a execução', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  for (const safeDelayMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '2000', null]) {
    await assert.rejects(
      orch.start({ safeDelayMs }),
      /^Error: Intervalo entre conversas inválido: .+ \(esperado um número de milissegundos ≥ 0\)\.$/,
      `safeDelayMs = ${String(safeDelayMs)}`
    );
    assert.equal(orch.isBusy(), false);
    assert.equal(orch.getState().state, WORKFLOW_STATES.IDLE);
    assert.equal(orch.run, null);
  }
  assert.equal(fake.content.readyChecks, 0);
  assert.equal(archive.calls.length, 0);

  // 0 é aceito: o mínimo de 1 s é do popup, não do orquestrador
  await orch.start({ safeDelayMs: 0 });
  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.equal(archive.calls.length, 1);
});

test('interceptor só é armado depois do EXPORT_CAPTURE_ARMED: um download antes do aviso não é tomado', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch);
  fake.content.onFetchBlob = (message) => {
    deliverFile(orch, message.captureId, chatBytes('Ana', 1536), { filename: message.filename, source: 'download' });
    return { success: true };
  };
  fake.content.onExport = async (message) => {
    if (message.chat.title !== 'Ana') return deliver(message);
    // A conversa já foi pedida à aba, mas ela ainda não avisou que vai clicar em "Exportar"
    fake.dispatchDownload(whatsAppDownload({ id: 11, filename: 'Conversa do WhatsApp com Fulano.zip' }));
    armCapture(orch, message.captureId);
    // Depois do aviso: o download do WhatsApp sem nome ainda, mas com tipo ZIP, é tomado
    fake.dispatchDownload(whatsAppDownload({ id: 12, filename: '', mime: 'application/zip' }));
    await waitUntil(() => fake.content.fetchRequests.length === 1, { description: 'leitura do download interceptado' });
    return triggeredResponse();
  };

  await orch.start({ safeDelayMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const { runId } = orch.run;
  // O download anterior ao aviso seguiu para a pasta Downloads: nem pausado, nem lido pela aba
  assert.deepEqual(fake.downloadCallsFor(11), []);
  assert.deepEqual(fake.content.fetchRequests.map(({ url, captureId, filename }) => ({ url, captureId, filename })), [
    { url: whatsAppDownload({ id: 12 }).url, captureId: `${runId}-0`, filename: 'exportacao.zip' }
  ]);
  assert.deepEqual(fake.downloadCallsFor(12).map((call) => call.method), ['pause', 'search', 'cancel', 'erase']);

  assert.deepEqual(staging.saves.map(({ chatTitle, filename }) => [chatTitle, filename]), [['Ana', 'exportacao.zip'], ['Bia', 'conversa.zip']]);
  assert.deepEqual(orch.run.results.map((r) => r.status), ['saved', 'saved']);

  // O download anterior ao aviso fica registrado como recebido fora de hora, durante a conversa
  assert.equal(orch.run.unexpectedFiles.length, 1);
  assert.match(orch.run.unexpectedFiles[0].at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual({ ...orch.run.unexpectedFiles[0], at: null }, {
    at: null,
    filename: 'Conversa do WhatsApp com Fulano.zip',
    source: 'download',
    duringChat: 'Ana'
  });
  const lines = archive.calls[0].report.split('\n');
  assert.deepEqual(lines.slice(9, 11), ['', unexpectedFilesHeader(1)]);
  assert.match(lines[11], unexpectedFileLine('chrome.downloads, "Conversa do WhatsApp com Fulano.zip", durante "Ana"'));
});

test('aviso de captura armada recusado: outra captura, outra aba ou conversa já encerrada; a conversa falha com CAPTURE_NOT_ARMED', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch);
  const refusals = {};
  const notArmedError = 'A exportação não foi confirmada: a captura do arquivo não foi armada. ' +
    'A captura não é a da conversa em exportação (concluída, cancelada ou de outra execução).';

  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    if (chat.title !== 'Ana') return deliver(message);
    const { runId } = orch.run;
    refusals.otherCapture = orch.armCapture({ captureId: `${runId}-1`, tabId: WHATSAPP_TAB_ID });
    refusals.previousRun = orch.armCapture({ captureId: 'execucao-anterior-0', tabId: WHATSAPP_TAB_ID });
    refusals.otherTab = orch.armCapture({ captureId, tabId: WHATSAPP_TAB_ID + 1 });
    // Com as recusas, o interceptor continua desarmado: um download do WhatsApp agora não é tomado
    fake.dispatchDownload(whatsAppDownload({ id: 21, filename: 'Conversa do WhatsApp com Ana.zip' }));
    // Como o content real numa recusa: não clica em "Exportar", cancela o modal e responde a falha
    return { success: false, cancelled: false, error: notArmedError, code: 'CAPTURE_NOT_ARMED' };
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  // Falha passageira de comunicação: Ana entra na repescagem, e lá as recusas se repetem
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Ana']);
  const otherCapture = 'A captura não é a da conversa em exportação (concluída, cancelada ou de outra execução).';
  assert.deepEqual(refusals, {
    otherCapture: { success: false, error: otherCapture },
    previousRun: { success: false, error: otherCapture },
    otherTab: { success: false, error: 'O aviso veio de outra aba, não da que está exportando a conversa.' }
  });
  // Depois que a conversa termina, a captura de cada tentativa dela também é recusada
  for (const captureId of [`${orch.run.runId}-0`, `${orch.run.runId}-0-r1`]) {
    assert.deepEqual(orch.armCapture({ captureId, tabId: WHATSAPP_TAB_ID }), { success: false, error: otherCapture });
  }

  assert.deepEqual(fake.downloadCallsFor(21), []);
  assert.deepEqual(fake.content.fetchRequests, []);
  assert.deepEqual(orch.run.results[0], {
    title: 'Ana',
    status: 'failed',
    code: 'CAPTURE_NOT_ARMED',
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: `"Ana": ${notArmedError}`,
    attempts: 2,
    firstAttemptCode: 'CAPTURE_NOT_ARMED'
  });
  assert.deepEqual(staging.saves.map((s) => s.chatTitle), ['Bia']);
  assert.deepEqual(orch.getState().summary, { saved: 1, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
});

test('arquivos recebidos fora de hora, da página e do chrome.downloads, vão para o relatório e não são salvos', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch);

  // Fora de uma execução, um arquivo do WhatsApp é download do próprio usuário: ignorado
  assert.deepEqual(orch.recordUnexpectedFile({ filename: 'manual.zip', source: 'page' }), { success: true, recorded: false });

  fake.content.onExport = (message) => {
    if (message.chat.title === 'Bia') {
      // Antes do clique em "Exportar" de Bia (captura desarmada), o content avisa como o service worker
      // repassaria o EXPORT_UNEXPECTED_FILE, sem bloquear o download
      orch.recordUnexpectedFile({ filename: 'Conversa do WhatsApp com Ana.zip', source: 'page' });
    }
    return deliver(message);
  };

  const loop = orch.start({ safeDelayMs: 150 });
  // No intervalo entre Ana e Bia nenhuma captura está armada: o download do WhatsApp não é tomado
  await waitUntil(() => orch.run?.results.length === 1, { description: 'fim da exportação de "Ana"' });
  assert.equal(fake.content.exportRequests.length, 1, 'o download deveria ser disparado antes de pedir "Bia" à aba');
  fake.dispatchDownload(whatsAppDownload({ id: 31, filename: '', mime: 'text/plain' }));
  await loop;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  assert.deepEqual(staging.saves.map((s) => s.chatTitle), ['Ana', 'Bia', 'Caio']);
  assert.deepEqual(fake.downloadCallsFor(31), []);
  assert.deepEqual(fake.content.fetchRequests, []);

  const unexpected = orch.run.unexpectedFiles.map(({ at, ...entry }) => entry);
  assert.deepEqual(unexpected, [
    { filename: null, source: 'download', duringChat: null },
    { filename: 'Conversa do WhatsApp com Ana.zip', source: 'page', duringChat: 'Bia' }
  ]);
  // Persistido com o run, para sobreviver a um reinício do service worker
  assert.deepEqual(fake.readStorage('extractionRun').unexpectedFiles, orch.run.unexpectedFiles);

  const lines = archive.calls[0].report.split('\n');
  assert.deepEqual(lines.slice(7, 12), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[OK] 2. "Bia" salvo (1.5 KB).',
    '[OK] 3. "Caio" salvo (1.5 KB).',
    '',
    unexpectedFilesHeader(2)
  ]);
  assert.match(lines[12], unexpectedFileLine('chrome.downloads, nome ainda não definido pelo Chrome, entre conversas'));
  assert.match(lines[13], unexpectedFileLine('página, "Conversa do WhatsApp com Ana.zip", durante "Bia"'));
  assert.deepEqual(lines.slice(14), ['']);

  // Popup: um aviso por arquivo
  const warnings = fake.progressUpdates().map((m) => m.warningMessage).filter(Boolean);
  assert.deepEqual(warnings, [
    '⚠️ Arquivo recebido fora de hora (chrome.downloads, nome ainda não definido pelo Chrome, entre conversas): não foi salvo no ZIP e seguiu para a pasta Downloads.',
    '⚠️ Arquivo recebido fora de hora (página, "Conversa do WhatsApp com Ana.zip", durante "Bia"): não foi salvo no ZIP e seguiu para a pasta Downloads.'
  ]);

  // Terminada a execução, volta a ser ignorado
  assert.deepEqual(orch.recordUnexpectedFile({ filename: 'depois.zip', source: 'page' }), { success: true, recorded: false });
  assert.equal(orch.run.unexpectedFiles.length, 2);
});

test('relatório sem arquivos fora de hora não tem a seção', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  await orch.start({ safeDelayMs: 0 });

  assert.deepEqual(orch.run.unexpectedFiles, []);
  assert.equal(archive.calls[0].report.includes('fora de hora'), false);
  assert.deepEqual(archive.calls[0].report.split('\n').slice(7), ['[OK] 1. "Ana" salvo (1.5 KB).', '']);
});

/**
 * Storage de uma execução interrompida no meio da fila, como a versão anterior da extensão o gravava:
 * sem a lista `unexpectedFiles`. A instância A exporta Ana e Bia e fica presa em Caio, como se o
 * Chrome encerrasse o service worker ali.
 */
async function snapshotWithoutUnexpectedFiles(fakeA) {
  const orchA = createOrchestrator();
  const deliverA = deliveringExport(orchA);
  const stalled = createDeferred();
  let snapshot = null;
  fakeA.content.onExport = (message) => {
    if (message.chat.title !== 'Caio') return deliverA(message);
    snapshot = fakeA.snapshotStorage();
    stalled.resolve();
    return { success: true, triggered: true };
  };

  const loopA = orchA.start({ safeDelayMs: 0 });
  await stalled.promise;
  await orchA.cancel();
  await loopA;

  assert.equal(snapshot.extractionRun.nextIndex, 2);
  assert.deepEqual(snapshot.extractionRun.unexpectedFiles, []);
  delete snapshot.extractionRun.unexpectedFiles;
  return snapshot;
}

test('execução gravada pela versão anterior, sem a lista de arquivos fora de hora: a retomada registra o arquivo e o relatório tem a seção', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotWithoutUnexpectedFiles(fakeA);

  const fakeB = createFakeChrome({ chats, storage: snapshot });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  const deliverB = deliveringExport(orchB);
  fakeB.content.onExport = (message) => {
    // Antes do aviso de captura armada de Davi: o download do WhatsApp chega fora de hora
    if (message.chat.title === 'Davi') {
      fakeB.dispatchDownload(whatsAppDownload({ id: 51, filename: 'Conversa do WhatsApp com Fulano.zip' }));
    }
    return deliverB(message);
  };

  await orchB.restore();
  assert.equal(orchB.run.unexpectedFiles, undefined);
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Caio', 'Davi']);
  assert.deepEqual(fakeB.downloadCallsFor(51), []);
  assert.deepEqual(orchB.run.unexpectedFiles.map(({ at, ...entry }) => entry), [
    { filename: 'Conversa do WhatsApp com Fulano.zip', source: 'download', duringChat: 'Davi' }
  ]);
  assert.deepEqual(fakeB.readStorage('extractionRun').unexpectedFiles, orchB.run.unexpectedFiles);

  const lines = archive.calls[0].report.split('\n');
  assert.deepEqual(lines.slice(7, 13), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[OK] 2. "Bia" salvo (1.5 KB).',
    '[OK] 3. "Caio" salvo (1.5 KB).',
    '[OK] 4. "Davi" salvo (1.5 KB).',
    '',
    unexpectedFilesHeader(1)
  ]);
  assert.match(lines[13], unexpectedFileLine('chrome.downloads, "Conversa do WhatsApp com Fulano.zip", durante "Davi"'));
});

test('execução gravada pela versão anterior, sem a lista e sem arquivo fora de hora: o relatório sai sem a seção', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotWithoutUnexpectedFiles(fakeA);

  const fakeB = createFakeChrome({ chats, storage: snapshot });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  fakeB.content.onExport = deliveringExport(orchB);

  await orchB.restore();
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.equal(orchB.run.unexpectedFiles, undefined);
  assert.deepEqual(archive.calls[0].report.split('\n').slice(7), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[OK] 2. "Bia" salvo (1.5 KB).',
    '[OK] 3. "Caio" salvo (1.5 KB).',
    ''
  ]);
});

// Repescagem: uma rodada só, no fim da fila, com as conversas que falharam por um motivo que pode passar

/** Falha como o content real responde quando nem a busca nem a rolagem acham a conversa */
function notFound(title) {
  return {
    error: `Conversa "${title}" não foi encontrada na lista lateral (busca: sem resultado em 8 s; rolagem: 12 passo(s) até o fim da lista).`,
    code: 'CHAT_NOT_FOUND'
  };
}

function countAction(fake, action) {
  return fake.receivedActions().filter((a) => a === action).length;
}

test('repescagem recupera falhas passageiras: lista lateral devolvida ao normal antes da 1ª exportação da rodada, captura própria e tentativas no relatório', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']) });
  const orch = createOrchestrator();
  const sidebarResetBeforeRetry = [];
  fake.content.onResetSidebar = () => {
    sidebarResetBeforeRetry.push(fake.content.exportRequests.filter(isRetryAttempt).length);
    return { success: true };
  };
  fake.content.onExport = deliveringExport(orch, {
    firstAttemptFailures: {
      Bia: notFound('Bia'),
      // Sem código conhecido, como o botão "Exportar" que some depois de armar a captura
      Davi: 'Botão "Exportar" não encontrado no modal de exportação depois de armar a captura do arquivo.'
    }
  });

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 5, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  // Fim da execução: o progresso volta a ser o da fila, e não a posição da última conversa repescada
  assert.deepEqual([state.current, state.total, state.percentage, state.retry], [5, 5, 100, null]);

  // Cada tentativa tem a sua captura: um bloco atrasado da 1ª é recusado na repescagem
  const { runId } = orch.run;
  assert.deepEqual(fake.content.exportRequests.map((m) => [m.chat.title, m.captureId]), [
    ['Ana', `${runId}-0`], ['Bia', `${runId}-1`], ['Caio', `${runId}-2`], ['Davi', `${runId}-3`], ['Eva', `${runId}-4`],
    ['Bia', `${runId}-1-r1`], ['Davi', `${runId}-3-r1`]
  ]);
  assert.equal(orch.captures.handleTransferMessage({ action: ACTIONS.EXPORT_TRANSFER_START, captureId: `${runId}-1`, totalChunks: 1, size: 1 }).success, false);

  // A lista lateral volta ao normal uma vez, depois da última conversa da fila e antes da 1ª da rodada
  assert.deepEqual(sidebarResetBeforeRetry, [0]);
  const actions = fake.receivedActions();
  const resetAt = actions.indexOf(ACTIONS.RESET_SIDEBAR);
  assert.equal(actions.slice(0, resetAt).filter((a) => a === ACTIONS.EXPORT_CHAT_REQUEST).length, 5);
  assert.deepEqual(actions.slice(resetAt - 1), [
    ACTIONS.DISARM_EXPORT_CAPTURE,
    ACTIONS.RESET_SIDEBAR,
    ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE,
    ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE
  ]);

  // O resultado da repescagem fica no lugar da falha, com o código da 1ª tentativa
  assert.deepEqual(orch.run.results.map(({ status, code, attempts, firstAttemptCode }) => [status, code, attempts, firstAttemptCode]), [
    ['saved', null, 1, undefined],
    ['saved', null, 2, 'CHAT_NOT_FOUND'],
    ['saved', null, 1, undefined],
    ['saved', null, 2, null],
    ['saved', null, 1, undefined]
  ]);
  assert.deepEqual(orch.run.retry, { indices: [1, 3], cursor: 2, startsAt: orch.run.retry.startsAt });
  assert.match(orch.run.retry.startsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fake.readStorage('extractionRun').retry, orch.run.retry);

  // No staging, cada conversa recuperada fica com a chave da sua posição na fila
  assert.deepEqual(staging.saves.map((s) => [s.chatId, s.chatTitle]), [
    ['000000', 'Ana'], ['000002', 'Caio'], ['000004', 'Eva'], ['000001', 'Bia'], ['000003', 'Davi']
  ]);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002', '000003', '000004']);

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[5], 'Conversas na fila: 5 | no ZIP: 5 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0');
  assert.equal(lines[6], retryHeader(2, 2));
  assert.deepEqual(lines.slice(7), [
    '',
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[OK] 2. "Bia" salvo (1.5 KB). Tentativas: 2.',
    '[OK] 3. "Caio" salvo (1.5 KB).',
    '[OK] 4. "Davi" salvo (1.5 KB). Tentativas: 2.',
    '[OK] 5. "Eva" salvo (1.5 KB).',
    ''
  ]);

  // Popup: a falha da fila, o anúncio da rodada e o resultado de cada repescada
  const updates = fake.progressUpdates();
  assert.deepEqual(updates.map((m) => m.warningMessage).filter(Boolean), [
    `[2/5] ⚠️ "Bia": ${notFound('Bia').error}`,
    '[4/5] ⚠️ "Davi": Botão "Exportar" não encontrado no modal de exportação depois de armar a captura do arquivo.'
  ]);
  assert.deepEqual(updates.map((m) => m.infoMessage).filter((m) => m && !/^\[\d\/5\]/.test(m)), [
    'Repescagem: 2 conversa(s) que falharam serão tentadas de novo.',
    '[Repescagem 1/2] ✅ "Bia" salvo (1.5 KB).',
    '[Repescagem 2/2] ✅ "Davi" salvo (1.5 KB).',
    'Empacotando conversas no ZIP consolidado...',
    `🎉 ${state.statusMessage}`
  ]);
  // Durante a rodada, o progresso é o dela, e a posição na fila continua em `current`
  const retryUpdates = updates
    .filter((m) => m.retry && m.state === WORKFLOW_STATES.EXPORTING && m.currentChatTitle)
    .map(({ retry, percentage, current, total, currentChatTitle }) => [retry, percentage, current, total, currentChatTitle]);
  assert.deepEqual(retryUpdates, [
    [{ current: 1, total: 2 }, 0, 2, 5, 'Bia'],
    [{ current: 2, total: 2 }, 50, 4, 5, 'Davi']
  ]);
  assert.match(state.statusMessage, /\. 5 conversa\(s\) no ZIP, 0 falha\(s\)\.$/);
});

test('falha que persiste: uma única repescagem, sem segunda rodada, e fica a falha nova', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const timeouts = {
    1: 'Timeout de 30s aguardando a abertura da conversa "Bia".',
    2: 'Timeout de 15s aguardando o menu de opções da conversa.'
  };
  const deliver = deliveringExport(orch);
  // Bia falha por tempo esgotado nas duas tentativas, cada vez numa etapa
  fake.content.onExport = (message) => {
    if (message.chat.title !== 'Bia') return deliver(message);
    return { success: false, cancelled: false, error: timeouts[isRetryAttempt(message) ? 2 : 1], code: 'TIMEOUT' };
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Bia']);
  assert.equal(countAction(fake, ACTIONS.RESET_SIDEBAR), 1);
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'failed',
    code: 'TIMEOUT',
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: `"Bia": ${timeouts[2]}`,
    attempts: 2,
    firstAttemptCode: 'TIMEOUT'
  });
  assert.deepEqual(orch.run.retry, { indices: [1], cursor: 1, startsAt: orch.run.retry.startsAt });
  assert.deepEqual(staging.saves.map((s) => s.chatTitle), ['Ana', 'Caio']);

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[6], retryHeader(1, 0));
  assert.equal(lines[9], `[FALHA] 2. "Bia": ${timeouts[2]} Tentativas: 2.`);
  assert.deepEqual(
    fake.progressUpdates().map((m) => m.warningMessage).filter(Boolean),
    [`[2/3] ⚠️ "Bia": ${timeouts[1]}`, `[Repescagem 1/1] ⚠️ "Bia": ${timeouts[2]}`]
  );
  assert.match(state.statusMessage, /\. 2 conversa\(s\) no ZIP, 1 falha\(s\)\.$/);
});

test('fora da repescagem: exportação vazia, não exportável, homônimo e modal sem "Todas as mensagens"; sem nada a repescar, não há espera', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']) });
  const orch = createOrchestrator();
  const emptyZip = await nativeExportZip('\n');
  fake.content.onExport = deliveringExport(orch, {
    files: { Bia: emptyZip },
    failures: {
      Caio: { error: EXPORT_UNAVAILABLE_MESSAGE, code: 'EXPORT_OPTION_UNAVAILABLE' },
      Davi: { error: 'Há mais de uma conversa chamada "Davi"; não é possível escolher com segurança.', code: 'AMBIGUOUS_TITLE' },
      Eva: { error: 'O modal de exportação não oferece "Todas as mensagens".', code: 'DATE_RANGE_NOT_ALL' }
    }
  });

  // Espera de produção (60 s): só não estoura o limite do teste porque ninguém entra na repescagem
  const startedAt = performance.now();
  await orch.start({ safeDelayMs: 0 });
  const elapsed = performance.now() - startedAt;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.ok(elapsed < 1000, `a execução levou ${elapsed.toFixed(0)} ms: esperou por uma repescagem vazia`);
  assert.deepEqual(state.summary, { saved: 2, empty: 1, savedToDisk: 0, notExportable: 1, failed: 2 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Davi', 'Eva']);
  assert.equal(countAction(fake, ACTIONS.RESET_SIDEBAR), 0);
  assert.deepEqual(orch.run.retry, { indices: [], cursor: 0, startsAt: orch.run.retry.startsAt });
  assert.deepEqual(orch.run.results.map((r) => r.attempts), [1, 1, 1, 1, 1]);
  assert.equal(orch.run.results[1].empty, true);

  // O cabeçalho só fala da repescagem quando houve uma, e nenhum aviso do popup a anuncia
  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[6], '');
  assert.equal(archive.calls[0].report.includes('Repescagem'), false);
  assert.equal(archive.calls[0].report.includes('Tentativas'), false);
  const updates = fake.progressUpdates();
  assert.equal(updates.some((m) => m.retry), false);
  assert.equal(updates.some((m) => m.infoMessage?.startsWith('Repescagem')), false);
});

test('modal sem "Todas as mensagens": aviso na linha e total no cabeçalho; com outro intervalo marcado, falha fora da repescagem', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']) });
  const orch = createOrchestrator();
  // Texto que o content (export-modal-handler.js) lança quando o modal tem outro intervalo marcado
  const dateRangeNotAll = 'O modal de exportação não oferece "Todas as mensagens" e está com outro intervalo de datas marcado; ' +
    'a conversa não foi exportada para não sair incompleta.';
  const deliver = deliveringExport(orch, { failures: { Davi: { error: dateRangeNotAll, code: 'DATE_RANGE_NOT_ALL' } } });
  // Ana e Caio: o modal não tinha o rádio nem outro intervalo marcado, e a aba exportou com o aviso
  fake.content.onExport = (message) => {
    const response = deliver(message);
    return ['Ana', 'Caio'].includes(message.chat.title) ? { ...response, warnings: ['DATE_RANGE_UNCONFIRMED'] } : response;
  };

  // Espera de produção antes da repescagem (60 s): só não estoura o limite do teste se Davi ficar fora dela
  const startedAt = performance.now();
  await orch.start({ safeDelayMs: 0 });
  const elapsed = performance.now() - startedAt;

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.ok(elapsed < 1000, `a execução levou ${elapsed.toFixed(0)} ms: esperou por uma repescagem`);
  assert.deepEqual(orch.getState().summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Davi']);
  assert.deepEqual(orch.run.retry.indices, []);
  assert.deepEqual(
    orch.run.results.map(({ status, code, attempts, warnings }) => [status, code, attempts, warnings]),
    [
      ['saved', null, 1, ['DATE_RANGE_UNCONFIRMED']],
      ['saved', null, 1, []],
      ['saved', null, 1, ['DATE_RANGE_UNCONFIRMED']],
      ['failed', 'DATE_RANGE_NOT_ALL', 1, []]
    ]
  );
  assert.deepEqual(fake.readStorage('extractionRun').results[0].warnings, ['DATE_RANGE_UNCONFIRMED']);

  const rangeNote = " Aviso: não foi possível confirmar a opção 'Todas as mensagens' no modal.";
  const lines = archive.calls[0].report.split('\n');
  assert.deepEqual(lines.slice(5, 12), [
    'Conversas na fila: 4 | no ZIP: 3 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 1',
    "Aviso: em 2 conversa(s) não foi possível confirmar a opção 'Todas as mensagens' no modal; confira se o histórico delas veio completo.",
    '',
    `[OK] 1. "Ana" salvo (1.5 KB).${rangeNote}`,
    '[OK] 2. "Bia" salvo (1.5 KB).',
    `[OK] 3. "Caio" salvo (1.5 KB).${rangeNote}`,
    `[FALHA] 4. "Davi": ${dateRangeNotAll}`
  ]);
});

test('entram na repescagem: falhas passageiras, captura não armada, falha sem código e código desconhecido', { timeout: TEST_TIMEOUT_MS }, async () => {
  // A classificação olha só o código do resultado, venha ele da página ou da captura do arquivo
  const firstAttemptCodes = {
    Ana: 'CHAT_NOT_FOUND',
    Bia: 'TIMEOUT',
    Caio: 'FILE_NOT_DELIVERED',
    Davi: 'TRANSFER_FAILED',
    Eva: 'SIZE_MISMATCH',
    Fabi: 'CAPTURE_NOT_ARMED',
    Gil: null,
    Hugo: 'CODIGO_DE_UMA_VERSAO_FUTURA'
  };
  const { fake } = setUp({ chats: sidebarChats([...Object.keys(firstAttemptCodes), 'Ivo']) });
  const orch = createOrchestrator();
  const firstAttemptFailures = Object.fromEntries(
    Object.entries(firstAttemptCodes).map(([title, code]) => [title, { error: `falha passageira de "${title}".`, code }])
  );
  fake.content.onExport = deliveringExport(orch, {
    firstAttemptFailures,
    failures: { Ivo: { error: 'Há mais de uma conversa chamada "Ivo"; não é possível escolher com segurança.', code: 'AMBIGUOUS_TITLE' } }
  });

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(orch.run.retry.indices, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    orch.run.results.map(({ title, status, attempts, firstAttemptCode }) => [title, status, attempts, firstAttemptCode]),
    [
      ...Object.entries(firstAttemptCodes).map(([title, code]) => [title, 'saved', 2, code]),
      ['Ivo', 'failed', 1, undefined]
    ]
  );
  assert.deepEqual(orch.getState().summary, { saved: 8, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
});

test('pausa e retomada na repescagem: a pausa vale ao fim da conversa repescada, e a retomada exporta a seguinte', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch, { firstAttemptFailures: { Ana: notFound('Ana'), Bia: notFound('Bia') } });
  let pausedDuringRetry = null;
  fake.content.onExport = (message) => {
    if (isRetryAttempt(message) && message.chat.title === 'Ana') pausedDuringRetry = orch.pause();
    return deliver(message);
  };

  const loop = orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });
  await waitUntil(() => orch.run?.retry?.cursor === 1, { description: 'fim da 1ª conversa da repescagem' });
  // Folga para o laço chegar à espera da retomada, se fosse continuar sem ela
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(pausedDuringRetry, true);
  const paused = orch.getState();
  assert.equal(paused.state, WORKFLOW_STATES.PAUSED);
  assert.equal(paused.statusMessage, 'Pausa solicitada: a extração para ao concluir a conversa atual.');
  assert.deepEqual([paused.retry, paused.percentage], [{ current: 2, total: 2 }, 50]);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Ana']);
  assert.equal(orch.run.results[0].attempts, 2);
  assert.equal(archive.calls.length, 0);
  assert.equal(fake.readStorage('extractionRun').state, WORKFLOW_STATES.PAUSED);
  assert.equal(fake.readStorage('extractionRun').retry.cursor, 1);

  assert.equal(orch.resume(), true);
  await loop;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Ana', 'Bia']);
  // A pausa no meio da rodada não devolve a lista ao normal de novo
  assert.equal(countAction(fake, ACTIONS.RESET_SIDEBAR), 1);
  assert.equal(archive.calls.length, 1);
});

test('pausa pedida durante a espera antes da repescagem vale antes de mexer na lista lateral', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });
  const retryCooldownMs = 150;

  const loop = orch.start({ safeDelayMs: 0, retryCooldownMs });
  await waitUntil(() => orch.getState().retry !== null, { description: 'início da espera da repescagem' });
  assert.equal(orch.pause(), true);
  // A espera termina, mas a rodada não começa: nem a lista lateral nem a conversa são pedidas à aba
  await new Promise((resolve) => setTimeout(resolve, retryCooldownMs + 100));

  const paused = orch.getState();
  assert.equal(paused.state, WORKFLOW_STATES.PAUSED);
  assert.equal(paused.statusMessage, 'Pausa solicitada: a extração para ao concluir a conversa atual.');
  assert.equal(countAction(fake, ACTIONS.RESET_SIDEBAR), 0);
  assert.equal(fake.content.exportRequests.length, 2);

  assert.equal(orch.resume(), true);
  await loop;

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const actions = fake.receivedActions();
  assert.deepEqual(actions.slice(actions.indexOf(ACTIONS.RESET_SIDEBAR)), [
    ACTIONS.RESET_SIDEBAR, ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE
  ]);
  assert.equal(orch.run.results[1].attempts, 2);
  assert.equal(archive.calls.length, 1);
});

test('cancelamento na repescagem, esperando o arquivo: encerra sem empacotar e a falha da fila fica', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });
  // Na repescagem, a página arma a captura e confirma a exportação, mas o arquivo nunca chega
  fake.content.onExport = (message) => {
    if (!isRetryAttempt(message)) return deliver(message);
    armCapture(orch, message.captureId);
    return triggeredResponse();
  };

  const loop = orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });
  await waitUntil(
    () => fake.content.exportRequests.length === 3 && orch.getState().state === WORKFLOW_STATES.WAITING_DOWNLOAD,
    { description: 'repescagem esperando o arquivo de "Bia"' }
  );
  await orch.cancel();
  await loop;

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.CANCELLED);
  assert.equal(orch.isBusy(), false);
  assert.equal(archive.calls.length, 0);
  assert.ok(fake.receivedActions().includes(ACTIONS.CANCEL_CURRENT_OPERATION));
  // A tentativa interrompida não ganha resultado e continua a próxima da rodada
  assert.deepEqual([orch.run.results[1].code, orch.run.results[1].attempts], ['CHAT_NOT_FOUND', 1]);
  assert.equal(orch.run.retry.cursor, 0);
  assert.deepEqual([...staging.files.keys()], ['000000']);
  assert.equal(fake.api.downloads.onCreated.listeners.size, 0);
  assert.equal(fake.readStorage('extractionRun').state, WORKFLOW_STATES.CANCELLED);
  // Um arquivo que chegue depois do cancelamento é recusado
  const late = orch.captures.handleTransferMessage({
    action: ACTIONS.EXPORT_TRANSFER_START,
    captureId: `${orch.run.runId}-1-r1`,
    totalChunks: 1,
    size: 10
  });
  assert.equal(late.success, false);
});

test('cancelamento durante a espera antes da repescagem: encerra na hora, sem mexer na lista lateral e sem empacotar', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });

  const loop = orch.start({ safeDelayMs: 0, retryCooldownMs: 10000 });
  await waitUntil(() => orch.getState().retry !== null, { description: 'início da espera da repescagem' });

  // Durante a espera: a rodada aparece no progresso, e a mensagem diz o que se espera
  const waiting = orch.getState();
  assert.equal(waiting.state, WORKFLOW_STATES.EXPORTING);
  assert.deepEqual([waiting.retry, waiting.percentage, waiting.currentChatTitle], [{ current: 1, total: 1 }, 0, '']);
  assert.equal(waiting.statusMessage, 'Aguardando 10 s antes da repescagem de 1 conversa(s).');
  assert.ok(
    fake.progressUpdates().some((m) => m.infoMessage === 'Repescagem: 1 conversa(s) que falharam serão tentadas de novo daqui a 10 s.')
  );
  // O horário de início fica no storage, para uma retomada depois de reinício esperar só o que faltava
  const startsAt = Date.parse(fake.readStorage('extractionRun').retry.startsAt);
  assert.ok(startsAt - Date.now() > 5000);

  const cancelledAt = performance.now();
  await orch.cancel();
  await loop;
  assert.ok(performance.now() - cancelledAt < 1000, 'o cancelamento deveria interromper a espera');

  assert.equal(orch.getState().state, WORKFLOW_STATES.CANCELLED);
  assert.equal(countAction(fake, ACTIONS.RESET_SIDEBAR), 0);
  assert.equal(fake.content.exportRequests.length, 2);
  assert.equal(archive.calls.length, 0);
});

test('lista lateral não volta ao normal: aviso no popup, e a repescagem segue mesmo assim', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  fake.content.onResetSidebar = () => {
    throw new Error('Lista lateral (#pane-side) não encontrada para voltar ao topo.');
  };
  fake.content.onExport = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });

  const warned = [];
  const silencedWarn = console.warn;
  console.warn = (...args) => { warned.push(args.join(' ')); };
  try {
    await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });
  } finally {
    console.warn = silencedWarn;
  }

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Bia']);
  assert.deepEqual(orch.run.results.map((r) => [r.status, r.attempts]), [['saved', 1], ['saved', 2]]);
  assert.ok(fake.progressUpdates().some((m) => m.warningMessage ===
    '⚠️ Repescagem: a lista lateral não voltou ao normal, e as conversas são tentadas mesmo assim. ' +
    'Motivo: Lista lateral (#pane-side) não encontrada para voltar ao topo.'));
  assert.ok(warned.some((line) => line.includes('Lista lateral não devolvida ao normal antes da repescagem')));
  assert.equal(archive.calls[0].report.split('\n')[6], retryHeader(1, 1));
});

test('"conferir" na ordem real das exportações: a 1ª da repescagem vem depois da última da fila, e a nota diz qual tentativa não entregou', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']) });
  const orch = createOrchestrator({ timings: { captureTimeoutMs: 20, quarantineMs: 30 } });
  const deliver = deliveringExport(orch);
  // Confirmam a exportação, mas o arquivo não chega: Bia, Davi e Eva na fila; Davi de novo na repescagem
  const notDelivered = { queue: ['Bia', 'Davi', 'Eva'], retry: ['Davi'] };
  fake.content.onExport = (message) => {
    if (!notDelivered[isRetryAttempt(message) ? 'retry' : 'queue'].includes(message.chat.title)) return deliver(message);
    armCapture(orch, message.captureId);
    return triggeredResponse();
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  // Ordem real: Ana, Bia, Caio, Davi, Eva (fila) e Bia, Davi, Eva (repescagem)
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Bia', 'Davi', 'Eva']);
  const notDeliveredMessage = 'O WhatsApp Web não entregou o arquivo exportado em 0.02 s.';
  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[6], retryHeader(3, 2));
  // Caio vem depois da 1ª tentativa de Bia, que foi recuperada depois: a linha de cima já mostra [OK], e a
  // nota diz qual tentativa não entregou. A repescada Bia vem depois da 1ª de Eva, a última da fila;
  // a repescada Eva, depois da 2ª de Davi
  assert.deepEqual(lines.slice(8, 13), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[OK] 2. "Bia" salvo (1.5 KB). Tentativas: 2.${notDeliveredCheckNote(5, 'Eva', 1)}`,
    `[OK] 3. "Caio" salvo (1.5 KB).${notDeliveredCheckNote(2, 'Bia', 1)}`,
    `[FALHA] 4. "Davi": ${notDeliveredMessage} Tentativas: 2.`,
    `[OK] 5. "Eva" salvo (1.5 KB). Tentativas: 2.${notDeliveredCheckNote(4, 'Davi', 2)}`
  ]);
  // A marcação é só do relatório: os resultados não mudam
  assert.deepEqual(orch.run.results.map((r) => r.message), [
    '"Ana" salvo (1.5 KB).',
    '"Bia" salvo (1.5 KB).',
    '"Caio" salvo (1.5 KB).',
    `"Davi": ${notDeliveredMessage}`,
    '"Eva" salvo (1.5 KB).'
  ]);
});

/**
 * Instância A interrompida no meio da repescagem, como se o Chrome encerrasse o service worker ali: o
 * storage é copiado quando a aba recebe a tentativa de número `stallAt` da rodada, e A fica presa
 * esperando um arquivo que não vem. Na fila, Bia não é encontrada e Davi esgota o tempo.
 */
async function snapshotDuringRetry(fakeA, { stallAt }) {
  const orchA = createOrchestrator();
  const deliverA = deliveringExport(orchA, { firstAttemptFailures: { Bia: notFound('Bia'), Davi: { error: 'Timeout de 30s aguardando o menu.', code: 'TIMEOUT' } } });
  const stalled = createDeferred();
  let retryAttempts = 0;
  let snapshot = null;
  fakeA.content.onExport = (message) => {
    if (isRetryAttempt(message) && ++retryAttempts === stallAt) {
      snapshot = fakeA.snapshotStorage();
      stalled.resolve();
      return { success: true, triggered: true };
    }
    return deliverA(message);
  };

  const loopA = orchA.start({ safeDelayMs: 0, retryCooldownMs: 0 });
  await stalled.promise;
  await orchA.cancel();
  await loopA;
  return snapshot;
}

for (const { stallAt, remaining } of [
  { stallAt: 1, remaining: [['Bia', 1], ['Davi', 3]] },
  { stallAt: 2, remaining: [['Davi', 3]] }
]) {
  test(`retomada depois de reinício na ${stallAt}ª tentativa da repescagem: a nova instância reconfere a aba e exporta só o que restava da rodada`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']);
    const { fake: fakeA, staging, archive } = setUp({ chats });
    const snapshot = await snapshotDuringRetry(fakeA, { stallAt });

    const saved = snapshot.extractionRun;
    assert.equal(saved.state, WORKFLOW_STATES.EXPORTING);
    assert.equal(saved.nextIndex, 4);
    assert.deepEqual([saved.retry.indices, saved.retry.cursor], [[1, 3], stallAt - 1]);
    const { runId } = saved;

    // Instância B: service worker novo, com o storage do momento da interrupção
    const fakeB = createFakeChrome({ chats, storage: snapshot });
    installFakeChrome(fakeB);
    const orchB = createOrchestrator();
    fakeB.content.onExport = deliveringExport(orchB);

    await orchB.restore();
    const restored = orchB.getState();
    assert.equal(restored.state, WORKFLOW_STATES.PAUSED);
    assert.equal(restored.statusMessage, 'A extração foi interrompida pelo navegador. Clique em "Retomar" para continuar de onde parou.');
    assert.deepEqual(restored.retry, { current: stallAt, total: 2 });

    assert.equal(orchB.resume(), true);
    // A fila acabou, mas a repescagem não: a fase retomada é a de exportação, não a de empacotamento
    assert.equal(orchB.getState().state, WORKFLOW_STATES.EXPORTING);
    await orchB._loopPromise;

    const state = orchB.getState();
    assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
    assert.deepEqual(state.summary, { saved: 4, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });

    // B reconfere a aba antes da repescagem, devolve a lista ao normal e exporta só o que restava dela
    assert.deepEqual(fakeB.receivedActions(), [
      ACTIONS.CHECK_PAGE_READY,
      ACTIONS.RESET_SIDEBAR,
      ...remaining.flatMap(() => [ACTIONS.EXPORT_CHAT_REQUEST, ACTIONS.DISARM_EXPORT_CAPTURE])
    ]);
    assert.deepEqual(
      fakeB.content.exportRequests.map((m) => [m.chat.title, m.captureId]),
      remaining.map(([title, index]) => [title, `${runId}-${index}-r1`])
    );

    assert.deepEqual(orchB.run.results.map((r) => r.attempts), [1, 2, 1, 2]);
    assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002', '000003']);
    assert.equal(staging.saves.length, 4);
    const lines = archive.calls[0].report.split('\n');
    assert.equal(lines[6], retryHeader(2, 2));
    assert.deepEqual(lines.slice(8, 12), [
      '[OK] 1. "Ana" salvo (1.5 KB).',
      '[OK] 2. "Bia" salvo (1.5 KB). Tentativas: 2.',
      '[OK] 3. "Caio" salvo (1.5 KB).',
      '[OK] 4. "Davi" salvo (1.5 KB). Tentativas: 2.'
    ]);
  });
}

test('download do ZIP não concluído: "Retomar" gera o ZIP de novo sem repetir a repescagem, também depois de reinício', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia']);
  const { fake, staging } = setUp({ chats });
  harness.archive.restore();
  const failedDownload = stubArchiveDownloader({ staging, outcome: { completed: false, error: 'o "Salvar como" foi cancelado' } });
  harness.archive = failedDownload;
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.PAUSED);
  assert.equal(failedDownload.calls.length, 1);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Bia']);
  const snapshot = fake.snapshotStorage();
  const actionsBeforeResume = fake.receivedActions().length;

  // A mesma instância: o download é gerado de novo, sem conferir a aba nem repescar
  failedDownload.restore();
  const archive = stubArchiveDownloader({ staging });
  harness.archive = archive;
  assert.equal(orch.resume(), true);
  await orch._loopPromise;

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.equal(fake.receivedActions().length, actionsBeforeResume);
  assert.equal(archive.calls.length, 1);
  assert.equal(archive.calls[0].report.split('\n')[6], retryHeader(1, 1));

  // Depois de reinício, com o storage do momento da pausa: a fase restaurada é a de empacotamento, e a
  // aba não é usada. O staging já foi limpo pelo download da instância anterior, mas o substituto do
  // download não depende dele
  const fakeB = createFakeChrome({ chats, storage: snapshot });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  await orchB.restore();
  assert.equal(orchB.getState().retry, null);
  assert.equal(orchB.resume(), true);
  assert.equal(orchB.getState().state, WORKFLOW_STATES.PACKAGING);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.receivedActions(), []);
  assert.equal(archive.calls.length, 2);
});

// Varredura da lista: estatísticas no relatório, andamento no popup e posição da conversa na fila

for (const { stopReason, durationMs, lastChatTimestamp, summary } of [
  {
    stopReason: 'end-of-list',
    durationMs: 21400,
    lastChatTimestamp: '12/03/2021',
    summary: 'em 21 s; parou no fim da lista; data/hora exibida na última conversa: 12/03/2021'
  },
  {
    stopReason: 'scroll-stalled',
    durationMs: 9600,
    lastChatTimestamp: 'Ontem',
    summary: 'em 10 s; parou porque a rolagem travou antes do fim da lista, que pode ter ficado incompleta; ' +
      'data/hora exibida na última conversa: Ontem'
  },
  {
    stopReason: 'time-limit',
    durationMs: 240000,
    lastChatTimestamp: null,
    summary: 'em 240 s; parou no tempo máximo da varredura, e a lista pode ter ficado incompleta; ' +
      'a última conversa não tinha data/hora legível'
  },
  {
    stopReason: 'motivo-de-uma-versao-futura',
    durationMs: 500,
    lastChatTimestamp: '10:42',
    summary: 'em 1 s; parou por um motivo desconhecido (motivo-de-uma-versao-futura); data/hora exibida na última conversa: 10:42'
  }
]) {
  test(`linha da varredura no relatório, logo depois do modo: ${stopReason}`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
    const orch = createOrchestrator();
    fake.content.scanStats = { steps: 7, durationMs, stopReason, lastChatTimestamp };
    fake.content.onExport = deliveringExport(orch);

    await orch.start({ safeDelayMs: 0 });

    assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
    assert.deepEqual(orch.run.scan, { found: 2, steps: 7, durationMs, stopReason, lastChatTimestamp });
    assert.deepEqual(fake.readStorage('extractionRun').scan, orch.run.scan);
    const lines = archive.calls[0].report.split('\n');
    assert.deepEqual(lines.slice(3, 5), [
      'Modo: lista principal (arquivadas não incluídas)',
      `Varredura: 2 conversa(s) encontrada(s) ${summary}.`
    ]);
    assert.ok(lines[5].startsWith(CONTENT_LINE_PREFIX));
  });
}

test('estatísticas da varredura sobrevivem a um reinício; execução gravada antes delas sai sem a linha da varredura', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const stats = { steps: 3, durationMs: 4200, stopReason: 'end-of-list', lastChatTimestamp: '05/01/2024' };
  fakeA.content.scanStats = stats;
  const orchA = createOrchestrator();
  const deliverA = deliveringExport(orchA);
  const stalled = createDeferred();
  let snapshot = null;
  // Em Bia, o storage é copiado como estaria se o Chrome encerrasse o service worker ali
  fakeA.content.onExport = (message) => {
    if (message.chat.title !== 'Bia') return deliverA(message);
    snapshot = fakeA.snapshotStorage();
    stalled.resolve();
    return { success: true, triggered: true };
  };

  const loopA = orchA.start({ safeDelayMs: 0 });
  await stalled.promise;
  await orchA.cancel();
  await loopA;
  assert.deepEqual(snapshot.extractionRun.scan, { found: 3, ...stats });

  /** Nova instância com o storage dado, retomada até o fim; devolve as linhas do relatório */
  async function resumeFrom(storage) {
    const fake = createFakeChrome({ chats, storage });
    installFakeChrome(fake);
    const orch = createOrchestrator();
    fake.content.onExport = deliveringExport(orch);
    await orch.restore();
    assert.equal(orch.resume(), true);
    await orch._loopPromise;
    assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
    // A retomada não refaz a varredura: a linha vem do que foi persistido
    assert.equal(fake.receivedActions().includes(ACTIONS.SCAN_CHATS_REQUEST), false);
    return archive.calls.at(-1).report.split('\n');
  }

  const resumed = await resumeFrom(snapshot);
  assert.equal(
    resumed[4],
    'Varredura: 3 conversa(s) encontrada(s) em 4 s; parou no fim da lista; data/hora exibida na última conversa: 05/01/2024.'
  );

  const previousVersion = structuredClone(snapshot);
  delete previousVersion.extractionRun.scan;
  const withoutStats = await resumeFrom(previousVersion);
  assert.equal(withoutStats.some((line) => line.startsWith('Varredura:')), false);
  assert.ok(withoutStats[4].startsWith(CONTENT_LINE_PREFIX));
});

test('andamento da varredura: o popup recebe o total encontrado a cada aviso da aba, sem gravar o storage', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const realSet = fake.api.storage.local.set;
  let storageWrites = 0;
  fake.api.storage.local.set = (items) => {
    storageWrites++;
    return realSet(items);
  };

  // Durante a varredura, a aba avisa o andamento pelo mesmo método do orquestrador que o service worker chama
  const duringScan = {};
  fake.content.onScan = () => {
    const writesBefore = storageWrites;
    const updatesBefore = fake.progressUpdates().length;
    duringScan.responses = [1, 2, 3].map((found) => orch.recordScanProgress({ found, tabId: WHATSAPP_TAB_ID }));
    duringScan.otherTab = orch.recordScanProgress({ found: 9, tabId: WHATSAPP_TAB_ID + 1 });
    duringScan.invalid = orch.recordScanProgress({ found: -1, tabId: WHATSAPP_TAB_ID });
    duringScan.writes = storageWrites - writesBefore;
    duringScan.updates = fake.progressUpdates().slice(updatesBefore).map((m) => [m.state, m.scanFound]);
  };
  // Um aviso atrasado, que chegue depois da resposta da varredura, não volta o popup para ela
  const deliver = deliveringExport(orch);
  let lateProgress = null;
  fake.content.onExport = (message) => {
    lateProgress ??= orch.recordScanProgress({ found: 2, tabId: WHATSAPP_TAB_ID });
    return deliver(message);
  };

  await orch.start({ safeDelayMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(duringScan.responses, [1, 2, 3].map(() => ({ success: true, recorded: true })));
  assert.deepEqual(duringScan.otherTab, { success: true, recorded: false });
  assert.deepEqual(duringScan.invalid, { success: false, error: 'Andamento da varredura inválido: -1.' });
  // Um aviso ao popup por aviso aceito da aba, e nenhuma gravação no storage
  assert.deepEqual(duringScan.updates, [
    [WORKFLOW_STATES.SCANNING, 1], [WORKFLOW_STATES.SCANNING, 2], [WORKFLOW_STATES.SCANNING, 3]
  ]);
  assert.equal(duringScan.writes, 0);
  assert.deepEqual(lateProgress, { success: true, recorded: false });
  // O total da fila montada fica no estado, e as conversas seguem para a exportação
  assert.equal(orch.getState().scanFound, 3);
  assert.equal(fake.content.exportRequests.length, 3);
  assert.ok(storageWrites > 0, 'o estado da execução continua sendo persistido fora dos avisos da varredura');
});

test('EXPORT_CHAT_REQUEST leva a posição da conversa na fila, também na repescagem', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  // A aba começa a rolagem da lista perto dessa posição; a conversa repescada mantém a da fila
  assert.deepEqual(
    fake.content.exportRequests.map((m) => [m.chat.title, m.queueIndex, isRetryAttempt(m)]),
    [['Ana', 0, false], ['Bia', 1, false], ['Caio', 2, false], ['Bia', 1, true]]
  );
});
