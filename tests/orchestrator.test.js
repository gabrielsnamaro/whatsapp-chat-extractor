import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionOrchestrator } from '../background/extraction-orchestrator.js';
import { ZipBuilder } from '../shared/archive/zip-builder.js';
import { ACTIONS } from '../shared/constants/actions.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import {
  WHATSAPP_TAB_ID,
  FAKE_LINE_PHONE,
  accountLine,
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
 * bytes arbitrários de um título por um arquivo específico (ex: um ZIP nativo). `contacts` acrescenta à
 * resposta de um título, de sucesso ou de falha e nas duas tentativas, o que o content real manda do tipo da
 * conversa e do painel "Dados do contato" (`chatKind`, `contactInfo` ou `contactInfoError`).
 */
function deliveringExport(orch, { sizes = {}, failures = {}, firstAttemptFailures = {}, files = {}, contacts = {} } = {}) {
  return (message) => {
    const { chat, captureId } = message;
    const contactFields = contacts[chat.title] ?? {};
    const failure = failures[chat.title] ?? (isRetryAttempt(message) ? undefined : firstAttemptFailures[chat.title]);
    if (failure) {
      const { error, code = null } = typeof failure === 'string' ? { error: failure } : failure;
      return { success: false, cancelled: false, error, code, ...contactFields };
    }
    armCapture(orch, captureId);
    deliverFile(orch, captureId, files[chat.title] ?? chatBytes(chat.title, sizes[chat.title] ?? 1536));
    return { ...triggeredResponse(), ...contactFields };
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Tentativa como fica no histórico da conversa, sem o início e a duração, que mudam a cada execução */
function attemptRecord({ attempt = 1, status, code = null, via = null, reason = null, quarantined = false, late = false }) {
  return { attempt, status, code, via, reason, quarantined, late };
}

/**
 * Resultado com o histórico sem o início e a duração de cada tentativa, para comparar com attemptRecord.
 * Antes de tirá-los, confere que o início é uma data ISO e a duração um número inteiro de ms ≥ 0.
 */
function withoutAttemptTimes(result) {
  return {
    ...result,
    history: result.history.map(({ startedAt, durationMs, ...entry }) => {
      assert.match(startedAt, ISO_DATE);
      assert.ok(Number.isInteger(durationMs) && durationMs >= 0, `duração inválida: ${durationMs}`);
      return entry;
    })
  };
}

const RESULT_KEY = /^extractionRun:result:(\d{6})$/;

/**
 * Execução como ficou no chrome.storage.local: o estado (`extractionRun`) com a fila e os resultados das
 * chaves próprias. Todos os resultados gravados entram, inclusive um que tivesse sobrado de outra execução.
 * @param {Object} storage Cópia do storage (snapshotStorage)
 */
function persistedRun(storage) {
  const results = [];
  for (const [key, value] of Object.entries(storage)) {
    const match = RESULT_KEY.exec(key);
    if (match) results[Number(match[1])] = value;
  }
  return { ...storage.extractionRun, queue: storage['extractionRun:queue'] ?? [], results };
}

/**
 * Storage como as versões anteriores da extensão gravavam: a execução inteira numa chave só, com a fila e os
 * resultados dentro do estado, sem as chaves próprias
 * @param {Object} storage Cópia do storage no formato atual (snapshotStorage)
 */
function toSingleKeyFormat(storage) {
  const others = Object.entries(storage).filter(([key]) => !key.startsWith('extractionRun'));
  return { ...Object.fromEntries(others), extractionRun: persistedRun(storage) };
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

  const persisted = persistedRun(fake.snapshotStorage());
  assert.equal(persisted.state, WORKFLOW_STATES.COMPLETED);
  assert.equal(persisted.nextIndex, 3);
  assert.deepEqual(persisted.results.map((r) => r.status), ['saved', 'saved', 'saved']);
  // Sem erro não há código; o `via` vem da resposta da aba
  assert.deepEqual(persisted.results.map((r) => [r.code, r.via]), [[null, 'visible'], [null, 'visible'], [null, 'visible']]);
  // Os bytes arbitrários foram inspecionados como texto puro: não estão em branco, mas o formato não
  // foi reconhecido, então não há contagens nem datas (e nada é somado aos anexos omitidos). O
  // histórico tem a única tentativa, persistida com o resultado
  assert.deepEqual(withoutAttemptTimes(persisted.results[0]), {
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
    attempts: 1,
    history: [attemptRecord({ status: 'saved', via: 'visible' })]
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
  assert.deepEqual(withoutAttemptTimes(orch.run.results[1]), {
    title: 'Bia',
    status: 'failed',
    code: null,
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: '"Bia": Conversa não encontrada na lista.',
    attempts: 2,
    firstAttemptCode: null,
    history: [
      attemptRecord({ attempt: 1, status: 'failed', reason: 'Conversa não encontrada na lista.' }),
      attemptRecord({ attempt: 2, status: 'failed', reason: 'Conversa não encontrada na lista.' })
    ]
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
  assert.equal(lines.length, 14);
  assert.equal(lines[0], 'Relatório de extração - WhatsApp Web Extractor');
  // As datas dependem do fuso de quem roda o teste
  assert.match(lines[1], new RegExp(`^Início: ${DATE_PT_BR}$`));
  assert.match(lines[2], new RegExp(`^Geração do ZIP: ${DATE_PT_BR}$`));
  assert.deepEqual(lines.slice(3), [
    `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`,
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
  assert.deepEqual(withoutAttemptTimes(orch.run.results[1]), {
    title: 'Bia',
    status: 'not_exportable',
    code: 'EXPORT_OPTION_UNAVAILABLE',
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: `"Bia": ${EXPORT_UNAVAILABLE_MESSAGE}`,
    attempts: 1,
    history: [attemptRecord({ status: 'not_exportable', code: 'EXPORT_OPTION_UNAVAILABLE', reason: EXPORT_UNAVAILABLE_MESSAGE })]
  });

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[6], 'Conversas na fila: 3 | no ZIP: 2 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 1 | falhas: 0');
  assert.deepEqual(lines.slice(8, 11), [
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

  // A mensagem é a do prazo original, não a da quarentena; as duas tentativas passaram por ela sem o arquivo
  const notDelivered = 'O WhatsApp Web não entregou o arquivo exportado em 0.05 s.';
  const notDeliveredAttempt = (attempt) => attemptRecord({
    attempt, status: 'failed', code: 'FILE_NOT_DELIVERED', via: 'search', reason: notDelivered, quarantined: true
  });
  assert.deepEqual(withoutAttemptTimes(orch.run.results[1]), {
    title: 'Bia',
    status: 'failed',
    code: 'FILE_NOT_DELIVERED',
    via: 'search',
    staged: false,
    late: false,
    warnings: [],
    message: `"Bia": ${notDelivered}`,
    attempts: 2,
    firstAttemptCode: 'FILE_NOT_DELIVERED',
    history: [notDeliveredAttempt(1), notDeliveredAttempt(2)]
  });
  // A duração de cada tentativa inclui o prazo e a quarentena
  for (const { durationMs } of orch.run.results[1].history) {
    assert.ok(durationMs >= captureTimeoutMs + quarantineMs - 10, `tentativa de ${durationMs} ms, menor que o prazo mais a quarentena`);
  }

  // No log, cada tentativa de Bia diz que passou pela quarentena sem receber o arquivo
  const bia = archive.calls[0].executionLog.split('\n').filter((line) => line.includes(' nº 2 "Bia" '));
  assert.deepEqual(bia.map((line) => line.replace(/^\d{2}:\d{2}:\d{2} /, '').replace(/ \| \d+(?:\.\d)? s \| /, ' | <duração> | ')), [1, 2].map((attempt) => (
    `nº 2 "Bia" | tentativa ${attempt} | <duração> | abertura: busca | FALHA (FILE_NOT_DELIVERED) | ` +
      `quarentena: o arquivo não foi recebido nela | motivo: ${notDelivered}`
  )));

  // Um arquivo atrasado de Bia que chegasse depois do clique em "Exportar" de Caio seria tomado como de
  // Caio: o relatório marca só a conversa seguinte a um FILE_NOT_DELIVERED e diz qual tentativa foi
  assert.deepEqual(archive.calls[0].report.split('\n').slice(9, 13), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[FALHA] 2. "Bia": ${notDelivered} Tentativas: 2.`,
    `[OK] 3. "Caio" salvo (1.5 KB).${notDeliveredCheckNote(2, 'Bia', 1)}`,
    '[OK] 4. "Davi" salvo (1.5 KB).'
  ]);
  // A marcação é só do relatório; o resultado de Caio não muda
  assert.equal(orch.run.results[2].message, '"Caio" salvo (1.5 KB).');
  assert.equal(persistedRun(fake.snapshotStorage()).results[1].code, 'FILE_NOT_DELIVERED');
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
  // O histórico de cada tentativa diz se ela passou pela quarentena e se o arquivo chegou nela
  assert.deepEqual(
    orch.run.results.map((r) => r.history.map(({ attempt, quarantined, late }) => ({ attempt, quarantined, late }))),
    [
      [{ attempt: 1, quarantined: false, late: false }],
      [{ attempt: 1, quarantined: true, late: true }],
      [{ attempt: 1, quarantined: true, late: true }],
      [{ attempt: 1, quarantined: false, late: false }]
    ]
  );
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
  assert.deepEqual(archive.calls[0].report.split('\n').slice(8, 12), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[OK] 2. "Bia" salvo (2.0 KB).${LATE_NOTE}`,
    `[OK] 3. "Caio" salvo (3.0 KB).${LATE_NOTE}`,
    '[OK] 4. "Davi" salvo (1.5 KB).'
  ]);
  assert.equal(persistedRun(fake.snapshotStorage()).results[1].late, true);
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

  // O código e a mensagem são os da falha que chegou, não os do prazo esgotado; as duas falham igual na
  // repescagem, e cada tentativa passou pela quarentena
  const quarantinedFailure = (attempt, code, reason) => attemptRecord({ attempt, status: 'failed', code, via: 'visible', reason, quarantined: true });
  assert.deepEqual(orch.run.results.slice(1, 3).map(withoutAttemptTimes), [
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
      firstAttemptCode: 'TRANSFER_FAILED',
      history: [1, 2].map((attempt) => quarantinedFailure(attempt, 'TRANSFER_FAILED', 'HTTP 404 ao ler o arquivo exportado.'))
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
      firstAttemptCode: 'SIZE_MISMATCH',
      history: [1, 2].map((attempt) => quarantinedFailure(attempt, 'SIZE_MISMATCH', 'Arquivo recebido com 5 bytes; esperados 10.'))
    }
  ]);
  assert.deepEqual(staging.saves.map((s) => s.chatTitle), ['Ana', 'Davi']);

  // Sem FILE_NOT_DELIVERED no resultado, a conversa seguinte não é marcada para conferir
  assert.deepEqual(archive.calls[0].report.split('\n').slice(9, 13), [
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
  assert.equal(lines[6], 'Conversas na fila: 10 | no ZIP: 2 (vazias: 1) | na pasta Downloads: 1 | não exportáveis: 1 | falhas: 6');
  assert.equal(lines[7], retryHeader(6, 0));
  // Cada conversa par vem depois de um FILE_NOT_DELIVERED: Bia (falha) e Juca (não exportável) não
  // receberam arquivo nenhum e não são marcadas; na pasta Downloads, vazia e atrasada, sim. Na
  // repescagem todas falham, então nenhuma tentativa dela recebe a marcação
  assert.deepEqual(lines.slice(9, 19), [
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

  // No log, cada tentativa da fila leva a marcação do relatório, o código (ou "sem código", numa falha
  // sem ele), a quarentena e o motivo; depois do resultado vêm só esses campos
  const queueAttempts = archive.calls[0].executionLog.split('\n')
    .filter((line) => line.includes(' | tentativa 1 | '))
    .map((line) => line.split(' | ').slice(4).join(' | '));
  const notDeliveredAttempt = `FALHA (FILE_NOT_DELIVERED) | quarentena: o arquivo não foi recebido nela | motivo: ${notDeliveredMessage}`;
  assert.deepEqual(queueAttempts, [
    notDeliveredAttempt,
    'FALHA (sem código) | motivo: Conversa não encontrada na lista.',
    notDeliveredAttempt,
    'NA PASTA DOWNLOADS',
    notDeliveredAttempt,
    'OK – VAZIA',
    notDeliveredAttempt,
    'OK | quarentena: o arquivo chegou nela, atrasado',
    notDeliveredAttempt,
    `NÃO EXPORTÁVEL (EXPORT_OPTION_UNAVAILABLE) | motivo: ${EXPORT_UNAVAILABLE_MESSAGE}`
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
    persistedRun(fake.snapshotStorage()).results.map((r) => [r.code, r.via]),
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
  assert.deepEqual(withoutAttemptTimes(orch.run.results[1]), {
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
    attempts: 1,
    history: [attemptRecord({ status: 'saved', via: 'visible' })]
  });

  // O arquivo vazio vai para o staging e para o ZIP como os outros
  assert.deepEqual(staging.saves.map((s) => s.chatId), ['000000', '000001', '000002']);
  assert.deepEqual(new Uint8Array(await staging.saves[1].blob.arrayBuffer()), emptyZip);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002']);

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[6], 'Conversas na fila: 3 | no ZIP: 3 (vazias: 1) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0');
  assert.deepEqual(lines.slice(8, 11), [
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
  assert.equal(persistedRun(fake.snapshotStorage()).results[1].empty, true);
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
  assert.match(result.inspectionError, /^O ZIP exportado está ilegível \(A entrada "_chat\.txt" está truncada: .+\)\.$/);
  assert.deepEqual(withoutAttemptTimes(result), {
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
    attempts: 1,
    history: [attemptRecord({ status: 'saved', via: 'visible' })]
  });

  // O arquivo vai para o staging como chegou
  assert.deepEqual(new Uint8Array(await staging.saves[1].blob.arrayBuffer()), truncatedZip);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002']);
  assert.equal(archive.calls[0].report.split('\n')[9], `[OK] 2. ${result.message}`);
  assert.equal(persistedRun(fake.snapshotStorage()).results[1].inspectionError, result.inspectionError);

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
  assert.equal(lines[5], `${CONTENT_LINE_PREFIX} (4 anexo(s) omitido(s) nesta execução).`);
  assert.deepEqual(lines.slice(8, 11), [
    `[OK] 1. "Ana" salvo (${sizeLabel(anaZip)}, 3 anexo(s) omitido(s)).`,
    `[OK] 2. "Bia" salvo (${sizeLabel(biaZip)}).`,
    `[OK] 3. "Caio" salvo (${sizeLabel(caioZip)}, 1 anexo(s) omitido(s)).`
  ]);

  // Os campos da inspeção ficam no resultado persistido, junto do status
  assert.deepEqual(
    persistedRun(fake.snapshotStorage()).results.map(({ messageCount, systemEventCount, omittedMediaCount, firstTimestamp, lastTimestamp }) => (
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
    lines[5],
    `${CONTENT_LINE_PREFIX} (1 anexo(s) omitido(s) nesta execução; total parcial: 2 conversa(s) sem contagem).`
  );
  assert.equal(lines[9], `[OK] 2. "Bia" salvo (${sizeLabel(biaZip)}). Formato do texto não reconhecido: mensagens e anexos não contados.`);
  assert.match(lines[10], /^\[OK\] 3\. "Caio" salvo \([^)]*\)\. Conteúdo não inspecionado: /);
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
  assert.equal(persistedRun(snapshot).results.length, 2);
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
  assert.deepEqual(lines.slice(10, 12), ['', unexpectedFilesHeader(1)]);
  assert.match(lines[12], unexpectedFileLine('chrome.downloads, "Conversa do WhatsApp com Fulano.zip", durante "Ana"'));
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
  assert.deepEqual(withoutAttemptTimes(orch.run.results[0]), {
    title: 'Ana',
    status: 'failed',
    code: 'CAPTURE_NOT_ARMED',
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: `"Ana": ${notArmedError}`,
    attempts: 2,
    firstAttemptCode: 'CAPTURE_NOT_ARMED',
    history: [1, 2].map((attempt) => attemptRecord({ attempt, status: 'failed', code: 'CAPTURE_NOT_ARMED', reason: notArmedError }))
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
  assert.deepEqual(lines.slice(8, 13), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[OK] 2. "Bia" salvo (1.5 KB).',
    '[OK] 3. "Caio" salvo (1.5 KB).',
    '',
    unexpectedFilesHeader(2)
  ]);
  assert.match(lines[13], unexpectedFileLine('chrome.downloads, nome ainda não definido pelo Chrome, entre conversas'));
  assert.match(lines[14], unexpectedFileLine('página, "Conversa do WhatsApp com Ana.zip", durante "Bia"'));
  assert.deepEqual(lines.slice(15), ['']);

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
  assert.deepEqual(archive.calls[0].report.split('\n').slice(8), ['[OK] 1. "Ana" salvo (1.5 KB).', '']);
});

/**
 * Storage de uma execução interrompida no meio da fila, como uma versão anterior da extensão o gravava:
 * numa chave só e sem a lista `unexpectedFiles`. A instância A exporta Ana e Bia e fica presa em Caio,
 * como se o Chrome encerrasse o service worker ali.
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
  const previousVersion = toSingleKeyFormat(snapshot);
  delete previousVersion.extractionRun.unexpectedFiles;
  return previousVersion;
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
  assert.deepEqual(lines.slice(8, 14), [
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[OK] 2. "Bia" salvo (1.5 KB).',
    '[OK] 3. "Caio" salvo (1.5 KB).',
    '[OK] 4. "Davi" salvo (1.5 KB).',
    '',
    unexpectedFilesHeader(1)
  ]);
  assert.match(lines[14], unexpectedFileLine('chrome.downloads, "Conversa do WhatsApp com Fulano.zip", durante "Davi"'));
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
  assert.deepEqual(archive.calls[0].report.split('\n').slice(8), [
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
  assert.equal(lines[6], 'Conversas na fila: 5 | no ZIP: 5 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0');
  assert.equal(lines[7], retryHeader(2, 2));
  assert.deepEqual(lines.slice(8), [
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
  // O resultado é o da repescagem, e o histórico guarda o motivo de cada tentativa
  assert.deepEqual(withoutAttemptTimes(orch.run.results[1]), {
    title: 'Bia',
    status: 'failed',
    code: 'TIMEOUT',
    via: null,
    staged: false,
    late: false,
    warnings: [],
    message: `"Bia": ${timeouts[2]}`,
    attempts: 2,
    firstAttemptCode: 'TIMEOUT',
    history: [
      attemptRecord({ attempt: 1, status: 'failed', code: 'TIMEOUT', reason: timeouts[1] }),
      attemptRecord({ attempt: 2, status: 'failed', code: 'TIMEOUT', reason: timeouts[2] })
    ]
  });
  assert.deepEqual(orch.run.retry, { indices: [1], cursor: 1, startsAt: orch.run.retry.startsAt });
  assert.deepEqual(staging.saves.map((s) => s.chatTitle), ['Ana', 'Caio']);

  const lines = archive.calls[0].report.split('\n');
  assert.equal(lines[7], retryHeader(1, 0));
  assert.equal(lines[10], `[FALHA] 2. "Bia": ${timeouts[2]} Tentativas: 2.`);
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
  assert.equal(lines[7], '');
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
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results[0].warnings, ['DATE_RANGE_UNCONFIRMED']);

  const rangeNote = " Aviso: não foi possível confirmar a opção 'Todas as mensagens' no modal.";
  const lines = archive.calls[0].report.split('\n');
  assert.deepEqual(lines.slice(6, 13), [
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
  assert.equal(archive.calls[0].report.split('\n')[7], retryHeader(1, 1));
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
  assert.equal(lines[7], retryHeader(3, 2));
  // Caio vem depois da 1ª tentativa de Bia, que foi recuperada depois: a linha de cima já mostra [OK], e a
  // nota diz qual tentativa não entregou. A repescada Bia vem depois da 1ª de Eva, a última da fila;
  // a repescada Eva, depois da 2ª de Davi
  assert.deepEqual(lines.slice(9, 14), [
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
    assert.equal(lines[7], retryHeader(2, 2));
    assert.deepEqual(lines.slice(9, 13), [
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
  assert.equal(archive.calls[0].report.split('\n')[7], retryHeader(1, 1));

  // Depois de reinício, com o storage do momento da pausa: a fase restaurada é a de empacotamento, e a
  // aba não é usada. O staging já foi limpo pelo download da instância anterior, mas o substituto do
  // download conclui mesmo assim (só a conferência dele, que este teste não olha, depende do staging)
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
    assert.deepEqual(lines.slice(4, 6), [
      'Modo: lista principal (arquivadas não incluídas)',
      `Varredura: 2 conversa(s) encontrada(s) ${summary}.`
    ]);
    assert.ok(lines[6].startsWith(CONTENT_LINE_PREFIX));
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
    resumed[5],
    'Varredura: 3 conversa(s) encontrada(s) em 4 s; parou no fim da lista; data/hora exibida na última conversa: 05/01/2024.'
  );

  const previousVersion = toSingleKeyFormat(snapshot);
  delete previousVersion.extractionRun.scan;
  const withoutStats = await resumeFrom(previousVersion);
  assert.equal(withoutStats.some((line) => line.startsWith('Varredura:')), false);
  assert.ok(withoutStats[5].startsWith(CONTENT_LINE_PREFIX));
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

// Conferência do ZIP: as conversas esperadas nele, a mensagem final pela contagem empacotada e o aviso de divergência

test('conferência do ZIP: esperadas são as conversas com arquivo no staging, e a mensagem final usa a contagem empacotada e avisa a divergência', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Fabi']) });
  const orch = createOrchestrator({ timings: { captureTimeoutMs: 40, quarantineMs: 2000 } });
  const emptyZip = await nativeExportZip('\n');
  const deliver = deliveringExport(orch, {
    files: { Bia: emptyZip },
    failures: { Eva: { error: EXPORT_UNAVAILABLE_MESSAGE, code: 'EXPORT_OPTION_UNAVAILABLE' } }
  });
  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    if (chat.title === 'Caio') {
      // O arquivo chega depois do prazo, na quarentena
      armCapture(orch, captureId);
      setTimeout(() => deliverFile(orch, captureId, chatBytes('Caio', 2048)), 100);
      return triggeredResponse();
    }
    if (chat.title === 'Davi') {
      armCapture(orch, captureId);
      orch.captures.resolveSavedToDisk(captureId, { filename: 'Conversa do WhatsApp com Davi.zip', downloadId: 6 });
      return triggeredResponse();
    }
    // Como o Chrome limpando o IndexedDB sob pressão de espaço: o arquivo de Ana some do staging antes do ZIP
    if (chat.title === 'Fabi') staging.files.delete('000000');
    return deliver(message);
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(
    orch.run.results.map(({ status, staged, empty, late }) => [status, staged, empty ?? null, late]),
    [
      ['saved', true, false, false],
      ['saved', true, true, false],
      ['saved', true, false, true],
      ['saved_to_disk', false, null, false],
      ['not_exportable', false, null, false],
      ['saved', true, false, false]
    ]
  );
  // Para o orquestrador, quatro conversas foram salvas
  assert.deepEqual(state.summary, { saved: 4, empty: 1, savedToDisk: 1, notExportable: 1, failed: 0 });

  // Esperadas no ZIP: a salva, a vazia, a atrasada e a última; a da pasta Downloads e a não exportável, não
  const [{ archiveFilename, expectedKeys, stagedKeys }] = archive.calls;
  assert.deepEqual(expectedKeys, ['000000', '000001', '000002', '000005']);
  assert.deepEqual(stagedKeys, ['000001', '000002', '000005']);

  // A mensagem final conta as três empacotadas, e o aviso da divergência vai ao popup junto com ela
  assert.equal(
    state.statusMessage,
    `Backup salvo: ${archiveFilename} (2.0 KB). 3 conversa(s) no ZIP (1 vazia(s)), 0 falha(s), 1 não exportável(is), ` +
      '1 baixada(s) direto na pasta Downloads.'
  );
  const final = fake.progressUpdates().at(-1);
  assert.equal(final.infoMessage, `🎉 ${state.statusMessage}`);
  assert.equal(
    final.warningMessage,
    '⚠️ Conferência do ZIP: 1 conversa(s) esperada(s) não está(ão) no ZIP. Veja a seção "Conferência do ZIP" no _relatorio.txt.'
  );
});

test('conferência do ZIP com ZIP nativo ilegível, CRC divergente e chave fora das esperadas: a mensagem final usa a contagem empacotada e o aviso diz cada divergência', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  // Como o ArchivePackager responde quando o ZIP nativo de Bia está ilegível (vai como o arquivo original),
  // o texto de Ana tem um CRC que não confere (vai como estava) e o staging tem uma chave que não era esperada
  harness.archive.restore();
  const archive = stubArchiveDownloader({
    staging,
    outcome: {
      completed: true,
      size: 4096,
      chatCount: 3,
      check: { expected: 2, packed: 3, missingKeys: [], unreadable: ['000001'], unexpected: ['000007'], crcMismatch: ['000000'] }
    }
  });
  harness.archive = archive;
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(archive.calls[0].expectedKeys, ['000000', '000001']);
  assert.equal(state.statusMessage, `Backup salvo: ${archive.calls[0].archiveFilename} (4.0 KB). 3 conversa(s) no ZIP, 0 falha(s).`);
  assert.equal(
    fake.progressUpdates().at(-1).warningMessage,
    '⚠️ Conferência do ZIP: 1 com o ZIP do WhatsApp ilegível, gravado(s) como o arquivo original; ' +
      '1 com texto de CRC que não confere, copiado como estava, sem compressão; 1 no ZIP sem ser esperada(s). ' +
      'Veja a seção "Conferência do ZIP" no _relatorio.txt.'
  );
});

// Log da execução (_execucao.log): uma linha por evento, montado só com o que fica persistido no run

const CLOCK = String.raw`\d{2}:\d{2}:\d{2}`;
const DURATION = String.raw`\d+(?:\.\d)? s`;

/** Texto para usar dentro de uma expressão regular, sem caracteres especiais */
function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Confere cada linha de evento do log contra o padrão da mesma posição, precedido do horário hh:mm:ss */
function assertTimedEvents(lines, patterns, log) {
  assert.equal(lines.length, patterns.length, log);
  lines.forEach((line, i) => assert.match(line, new RegExp(`^${CLOCK} ${patterns[i]}$`)));
}

test('_execucao.log: uma linha por tentativa, em ordem cronológica, com horário, duração, via e código; a conversa repescada tem as duas', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.scanStats = { steps: 4, durationMs: 3200, stopReason: 'end-of-list', lastChatTimestamp: '12/03/2021' };
  const deliver = deliveringExport(orch, { firstAttemptFailures: { Bia: notFound('Bia') } });
  // Cada conversa é aberta de um jeito; Bia, na repescagem, pela busca
  const vias = { Ana: 'visible', Bia: 'search', Caio: 'scroll' };
  fake.content.onExport = async (message) => {
    if (message.chat.title === 'Caio') {
      orch.recordUnexpectedFile({ filename: 'Conversa do WhatsApp com Fulano.zip', source: 'page' });
      // Para o arquivo fora de hora não cair no mesmo milissegundo do início da repescagem
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const response = deliver(message);
    return response.success ? { ...response, via: vias[message.chat.title] } : response;
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const { runId, results } = orch.run;
  // O resultado de Bia é o da repescagem, e o histórico guarda as duas tentativas, na ordem
  assert.deepEqual(withoutAttemptTimes(results[1]).history, [
    attemptRecord({ attempt: 1, status: 'failed', code: 'CHAT_NOT_FOUND', reason: notFound('Bia').error }),
    attemptRecord({ attempt: 2, status: 'saved', via: 'search' })
  ]);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results[1].history, results[1].history);

  const [{ executionLog }] = archive.calls;
  assert.ok(executionLog.endsWith('\n'));
  const lines = executionLog.split('\n');
  assert.equal(lines[0], 'Log da execução - WhatsApp Web Extractor');
  assert.match(
    lines[1],
    new RegExp(`^Execução: ${literal(runId)} \\| início: ${DATE_PT_BR} \\| versão da extensão: ${literal(fake.api.runtime.getManifest().version)}$`)
  );
  assert.deepEqual(lines.slice(2, 6), [
    `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`,
    'Modo: lista principal (arquivadas não incluídas) | intervalo entre conversas: 0 s, com variação de até +50%',
    'Varredura: 3 conversa(s) encontrada(s) em 3 s; parou no fim da lista; data/hora exibida na última conversa: 12/03/2021.',
    ''
  ]);

  // Na ordem real: as três tentativas da fila (o arquivo fora de hora chegou durante Caio), o início da
  // repescagem e a 2ª tentativa de Bia. Sem `via`, a aba não chegou a confirmar a exportação
  const events = lines.slice(6, -1);
  assertTimedEvents(events, [
    `nº 1 "Ana" \\| tentativa 1 \\| ${DURATION} \\| abertura: lista visível \\| OK`,
    `nº 2 "Bia" \\| tentativa 1 \\| ${DURATION} \\| abertura: não informada \\| FALHA \\(CHAT_NOT_FOUND\\) \\| motivo: ${literal(notFound('Bia').error)}`,
    `nº 3 "Caio" \\| tentativa 1 \\| ${DURATION} \\| abertura: rolagem da lista \\| OK`,
    literal('Arquivo recebido fora de hora (página, "Conversa do WhatsApp com Fulano.zip", durante "Caio"): não foi salvo no ZIP e seguiu para a pasta Downloads.'),
    literal('Repescagem: rodada prevista para este horário (fim da espera; uma pausa a adia), com 1 conversa(s) que falharam na fila.'),
    `nº 2 "Bia" \\| tentativa 2 \\| ${DURATION} \\| abertura: busca \\| OK`
  ], executionLog);
  // O horário de cada tentativa é o do início dela, no fuso local
  assert.ok(events[5].startsWith(new Date(results[1].history[1].startedAt).toLocaleTimeString('pt-BR')));
  assert.ok(events[1].startsWith(new Date(results[1].history[0].startedAt).toLocaleTimeString('pt-BR')));
});

test('_execucao.log de execução gravada por uma versão anterior, sem histórico: as tentativas dela vêm primeiro, sem horário, e as da retomada com horário', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']);
  const { fake: fakeA, archive } = setUp({ chats });
  // A versão anterior gravava a execução numa chave só e não gravava o histórico de tentativas
  const snapshot = toSingleKeyFormat(await snapshotDuringRetry(fakeA, { stallAt: 1 }));
  for (const result of snapshot.extractionRun.results) delete result.history;

  const fakeB = createFakeChrome({ chats, storage: snapshot });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  fakeB.content.onExport = deliveringExport(orchB);
  await orchB.restore();
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  // Bia e Davi: a 1ª tentativa é reconstituída do resultado da versão anterior, sem horário, e a 2ª é a
  // da retomada; Ana e Caio continuam sem histórico
  assert.deepEqual(
    orchB.run.results.map((r) => r.history?.map(({ attempt, startedAt, status, code }) => [attempt, startedAt !== null, status, code])),
    [
      undefined,
      [[1, false, 'failed', 'CHAT_NOT_FOUND'], [2, true, 'saved', null]],
      undefined,
      [[1, false, 'failed', 'TIMEOUT'], [2, true, 'saved', null]]
    ]
  );

  const { executionLog } = archive.calls[0];
  const lines = executionLog.split('\n');
  // O content simulado não manda as estatísticas da varredura
  assert.deepEqual(lines.slice(4, 11), [
    'Varredura: sem estatísticas registradas nesta execução.',
    'As linhas com --:--:-- foram registradas por uma versão anterior da extensão, sem horário nem duração, e vêm antes das demais.',
    '',
    '--:--:-- nº 1 "Ana" | tentativa 1 | duração não registrada | abertura: lista visível | OK',
    `--:--:-- nº 2 "Bia" | tentativa 1 | duração não registrada | abertura: não informada | FALHA (CHAT_NOT_FOUND) | motivo: ${notFound('Bia').error}`,
    '--:--:-- nº 3 "Caio" | tentativa 1 | duração não registrada | abertura: lista visível | OK',
    '--:--:-- nº 4 "Davi" | tentativa 1 | duração não registrada | abertura: não informada | FALHA (TIMEOUT) | motivo: Timeout de 30s aguardando o menu.'
  ]);
  assertTimedEvents(lines.slice(11, -1), [
    literal('Repescagem: rodada prevista para este horário (fim da espera; uma pausa a adia), com 2 conversa(s) que falharam na fila.'),
    `nº 2 "Bia" \\| tentativa 2 \\| ${DURATION} \\| abertura: lista visível \\| OK`,
    `nº 4 "Davi" \\| tentativa 2 \\| ${DURATION} \\| abertura: lista visível \\| OK`
  ], executionLog);
});

/** Linha de uma tentativa no log sem o horário, e com a duração (o 3º campo) trocada por <duração> */
function withoutClockAndDuration(line) {
  return line.replace(new RegExp(`^${CLOCK} `), '').replace(new RegExp(` \\| ${DURATION} \\| `), ' | <duração> | ');
}

test('_execucao.log: diagnóstico da abertura pela busca e pela rolagem no fim da linha da tentativa, guardado no histórico só quando a aba o manda', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const menuTimeout = 'Timeout de 15s aguardando o menu de opções da conversa.';
  const deliver = deliveringExport(orch, { failures: { Caio: { error: menuTimeout, code: 'TIMEOUT' } } });
  // Como o content real: Bia abre pela busca; Caio, pela rolagem depois de a busca não achar, e falha no
  // menu, e a falha traz o diagnóstico da abertura que a precedeu. Um campo que o orquestrador não conhece não é guardado
  const searchDiagnostics = { searchMs: 1234, searchCellsSeen: 3, searchExited: true };
  const scrollDiagnostics = {
    searchMs: 8000, searchCellsSeen: 0, searchExited: false, scrollSteps: 12, scrollMs: 4321, scrollHeightGrew: true, scrollStopReason: 'found'
  };
  fake.content.onExport = (message) => {
    const response = deliver(message);
    if (message.chat.title === 'Bia') return { ...response, via: 'search', openDiagnostics: { ...searchDiagnostics, campoDeUmaVersaoFutura: 1 } };
    if (message.chat.title === 'Caio') return { ...response, openDiagnostics: scrollDiagnostics };
    return response;
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const { results } = orch.run;
  // Só as tentativas cuja resposta trouxe o diagnóstico o guardam; Caio falha igual na repescagem
  assert.deepEqual(results.map((r) => r.history.map((entry) => entry.openDiagnostics ?? null)), [
    [null],
    [searchDiagnostics],
    [scrollDiagnostics, scrollDiagnostics]
  ]);
  assert.equal('openDiagnostics' in results[0].history[0], false);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results.map((r) => r.history), results.map((r) => r.history));

  // Os campos de antes ficam na mesma posição; o diagnóstico vem depois do motivo
  const events = archive.calls[0].executionLog.split('\n').slice(6, -1);
  const caioDiagnostics = 'busca: 8 s, 0 célula(s) de conversa no painel, saída não confirmada | ' +
    'rolagem: 12 passo(s) em 4.3 s, lista cresceu: sim, parou: achou a conversa';
  assert.deepEqual(events.map(withoutClockAndDuration), [
    'nº 1 "Ana" | tentativa 1 | <duração> | abertura: lista visível | OK',
    'nº 2 "Bia" | tentativa 1 | <duração> | abertura: busca | OK | busca: 1.2 s, 3 célula(s) de conversa no painel, saída confirmada',
    `nº 3 "Caio" | tentativa 1 | <duração> | abertura: não informada | FALHA (TIMEOUT) | motivo: ${menuTimeout} | ${caioDiagnostics}`,
    'Repescagem: rodada prevista para este horário (fim da espera; uma pausa a adia), com 1 conversa(s) que falharam na fila.',
    `nº 3 "Caio" | tentativa 2 | <duração> | abertura: não informada | FALHA (TIMEOUT) | motivo: ${menuTimeout} | ${caioDiagnostics}`
  ]);
});

test('rolagem de abertura interrompida no teto: a conversa falha com CHAT_NOT_FOUND, entra na repescagem e o log mostra o diagnóstico das duas tentativas', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  // Como o content real quando a rolagem estoura o teto de tempo: a mensagem diz o teto, e o diagnóstico vem com a falha
  const cappedError = 'Conversa "Bia" não foi encontrada na lista lateral (busca: sem resultado em 8 s; ' +
    'rolagem: interrompida no teto de 60 s, após 95 passo(s)).';
  const capped = {
    searchMs: 8000, searchCellsSeen: 0, searchExited: true, scrollSteps: 95, scrollMs: 60012, scrollHeightGrew: true, scrollStopReason: 'scroll-time-limit'
  };
  const recovered = { searchMs: 600, searchCellsSeen: 1, searchExited: true };
  const deliver = deliveringExport(orch);
  fake.content.onExport = (message) => {
    if (message.chat.title !== 'Bia') return deliver(message);
    if (!isRetryAttempt(message)) return { success: false, cancelled: false, error: cappedError, code: 'CHAT_NOT_FOUND', openDiagnostics: capped };
    return { ...deliver(message), via: 'search', openDiagnostics: recovered };
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  // CHAT_NOT_FOUND entra na repescagem, e lá a busca acha a conversa
  assert.deepEqual(orch.run.retry.indices, [1]);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio', 'Bia']);
  assert.deepEqual(withoutAttemptTimes(orch.run.results[1]).history, [
    { ...attemptRecord({ attempt: 1, status: 'failed', code: 'CHAT_NOT_FOUND', reason: cappedError }), openDiagnostics: capped },
    { ...attemptRecord({ attempt: 2, status: 'saved', via: 'search' }), openDiagnostics: recovered }
  ]);

  const { report, executionLog } = archive.calls[0];
  assert.equal(report.split('\n')[7], retryHeader(1, 1));
  const bia = executionLog.split('\n').filter((line) => line.includes(' nº 2 "Bia" ')).map(withoutClockAndDuration);
  assert.deepEqual(bia, [
    `nº 2 "Bia" | tentativa 1 | <duração> | abertura: não informada | FALHA (CHAT_NOT_FOUND) | motivo: ${cappedError} | ` +
      'busca: 8 s, 0 célula(s) de conversa no painel, saída confirmada | rolagem: 95 passo(s) em 60 s, lista cresceu: sim, parou: teto de tempo',
    'nº 2 "Bia" | tentativa 2 | <duração> | abertura: busca | OK | busca: 0.6 s, 1 célula(s) de conversa no painel, saída confirmada'
  ]);
});

// Índice da execução (_indice.csv): as linhas que o orquestrador monta; o CSV é testado no packager

test('linhas do _indice.csv: uma por conversa da fila, também as fora do ZIP, com a chave do staging só nas que têm arquivo nele', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Fabi']) });
  const orch = createOrchestrator();
  const anaZip = await nativeExportZip([
    '[01/02/2026, 09:00:00] - Ana criou o grupo "Família"',
    '[01/02/2026, 09:01:00] Ana: <imagem ocultada>',
    '[01/02/2026, 09:02:00] Bia: <documento omitido>',
    'legenda do documento',
    '[01/02/2026, 09:03:00] Ana: bom dia',
    ''
  ].join('\n'));
  const emptyZip = await nativeExportZip('\n');
  const deliver = deliveringExport(orch, {
    files: { Ana: anaZip, Caio: emptyZip },
    firstAttemptFailures: { Bia: notFound('Bia') },
    failures: {
      Eva: { error: EXPORT_UNAVAILABLE_MESSAGE, code: 'EXPORT_OPTION_UNAVAILABLE' },
      Fabi: { error: 'Timeout de 15s aguardando o menu de opções da conversa.', code: 'TIMEOUT' }
    }
  });
  fake.content.onExport = (message) => {
    const { chat, captureId } = message;
    if (chat.title === 'Davi') {
      armCapture(orch, captureId);
      orch.captures.resolveSavedToDisk(captureId, { filename: 'Conversa do WhatsApp com Davi.zip', downloadId: 4 });
      return triggeredResponse();
    }
    // Bia é recuperada na repescagem, aberta pela busca
    const response = deliver(message);
    return response.success && chat.title === 'Bia' ? { ...response, via: 'search' } : response;
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const [{ indexRows, expectedKeys }] = archive.calls;
  // A duração é a soma das tentativas da conversa, com a repescagem
  indexRows.forEach((row, index) => {
    const history = orch.run.results[index].history;
    assert.ok(Number.isInteger(row.durationMs), `duração inválida na linha ${index + 1}: ${row.durationMs}`);
    assert.equal(row.durationMs, history.reduce((total, entry) => total + entry.durationMs, 0));
  });
  const noFile = { bytes: null, messageCount: null, systemEventCount: null, omittedMediaCount: null, firstTimestamp: null, lastTimestamp: null };
  assert.deepEqual(indexRows.map(({ durationMs, ...row }) => row), [
    {
      chatId: '000000', order: 1, title: 'Ana', status: 'OK', code: null, attempts: 1, bytes: anaZip.length, messageCount: 3,
      systemEventCount: 1, omittedMediaCount: 2, firstTimestamp: '01/02/2026, 09:00:00', lastTimestamp: '01/02/2026, 09:03:00', via: 'lista visível'
    },
    {
      chatId: '000001', order: 2, title: 'Bia', status: 'OK', code: null, attempts: 2, bytes: 1536, messageCount: 1, systemEventCount: 0,
      omittedMediaCount: 0, firstTimestamp: '01/01/2026, 09:00:00', lastTimestamp: '01/01/2026, 09:00:00', via: 'busca'
    },
    {
      chatId: '000002', order: 3, title: 'Caio', status: 'OK – VAZIA', code: null, attempts: 1, bytes: emptyZip.length, messageCount: 0,
      systemEventCount: 0, omittedMediaCount: 0, firstTimestamp: null, lastTimestamp: null, via: 'lista visível'
    },
    { chatId: null, order: 4, title: 'Davi', status: 'NA PASTA DOWNLOADS', code: null, attempts: 1, ...noFile, via: 'lista visível' },
    { chatId: null, order: 5, title: 'Eva', status: 'NÃO EXPORTÁVEL', code: 'EXPORT_OPTION_UNAVAILABLE', attempts: 1, ...noFile, via: null },
    { chatId: null, order: 6, title: 'Fabi', status: 'FALHA', code: 'TIMEOUT', attempts: 2, ...noFile, via: null }
  ]);
  // As chaves das linhas são as das conversas esperadas no ZIP: o empacotamento acha a pasta de cada uma por ela
  assert.deepEqual(indexRows.flatMap((row) => row.chatId ?? []), expectedKeys);
});

// Checkpoint no chrome.storage.local: o estado numa chave, a fila noutra (gravada uma vez) e o resultado de
// cada conversa na sua, gravado no mesmo set do estado que avança a fila ou a repescagem

/** O que cada gravação (set) do chrome.storage.local levou, na ordem */
function storageWrites(fake) {
  return fake.storageOps.filter((op) => op.method === 'set').map((op) => op.items);
}

/** Chaves do staging dos resultados gravados num set */
function resultKeysIn(items) {
  return Object.keys(items).flatMap((key) => RESULT_KEY.exec(key)?.[1] ?? []);
}

test('checkpoint: numa fila de 10 conversas, no máximo 2 gravações por conversa; a fila vai uma vez, e cada resultado no mesmo set do estado com o novo nextIndex', { timeout: TEST_TIMEOUT_MS }, async () => {
  const titles = ['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Fabi', 'Gil', 'Hugo', 'Ivo', 'Juca'];
  const { fake } = setUp({ chats: sidebarChats(titles) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  await orch.start({ safeDelayMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const writes = storageWrites(fake);
  // Toda gravação leva o estado, e o estado nunca leva a fila nem os resultados
  for (const items of writes) {
    assert.ok(items.extractionRun, `gravação sem o estado: ${Object.keys(items).join(', ')}`);
    assert.equal('queue' in items.extractionRun, false);
    assert.equal('results' in items.extractionRun, false);
  }
  // O storage só é apagado uma vez, no início (a execução anterior)
  assert.deepEqual(fake.storageOps.map((op) => op.method).filter((method) => method === 'remove'), ['remove']);
  assert.equal(fake.storageOps[0].method, 'remove');

  // A fila vai uma vez só, no fim da varredura
  const queueWrites = writes.filter((items) => 'extractionRun:queue' in items);
  assert.equal(queueWrites.length, 1);
  assert.deepEqual(queueWrites[0]['extractionRun:queue'], orch.run.queue);
  assert.equal(queueWrites[0].extractionRun.state, WORKFLOW_STATES.SCANNING);

  // Cada resultado vai uma vez, sozinho, no set do estado que já aponta para a conversa seguinte
  const resultWrites = writes.filter((items) => resultKeysIn(items).length > 0);
  const keys = titles.map((_, index) => String(index).padStart(6, '0'));
  assert.deepEqual(resultWrites.map(resultKeysIn), keys.map((key) => [key]));
  resultWrites.forEach((items, index) => {
    assert.equal(items.extractionRun.nextIndex, index + 1);
    assert.deepEqual(items[`extractionRun:result:${keys[index]}`], orch.run.results[index]);
  });

  // Durante a fila, no máximo 2 gravações por conversa: o início dela e o resultado (antes eram 3, cada uma
  // com a execução inteira). Fora dela, só as transições: início e fim da varredura, empacotamento e fim
  const queueWriteAt = writes.indexOf(queueWrites[0]);
  const packagingAt = writes.findIndex((items) => items.extractionRun.state === WORKFLOW_STATES.PACKAGING);
  const duringQueue = writes.slice(queueWriteAt + 1, packagingAt);
  const writesPerChat = titles.map((_, index) => duringQueue.filter((items) => items.extractionRun.currentIndex === index + 1).length);
  assert.ok(writesPerChat.every((count) => count <= 2), `gravações por conversa: ${writesPerChat.join(', ')}`);
  assert.equal(writesPerChat.reduce((total, count) => total + count, 0), duringQueue.length, 'gravação da fila sem conversa em andamento');
  assert.deepEqual(
    [...writes.slice(0, queueWriteAt + 1), ...writes.slice(packagingAt)].map((items) => items.extractionRun.state),
    [WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.PACKAGING, WORKFLOW_STATES.COMPLETED]
  );
});

test('checkpoint na repescagem: o resultado vai no mesmo set do estado com o novo retry.cursor, no máximo 2 gravações por conversa repescada', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { firstAttemptFailures: { Ana: notFound('Ana'), Caio: notFound('Caio') } });

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const writes = storageWrites(fake);
  // O início da repescagem grava o estado com a rodada montada, ainda sem nenhuma conversa exportada
  const retryStartAt = writes.findIndex((items) => items.extractionRun.retry);
  assert.deepEqual(
    { ...writes[retryStartAt].extractionRun.retry, startsAt: null },
    { indices: [0, 2], cursor: 0, startsAt: null }
  );
  assert.deepEqual(resultKeysIn(writes[retryStartAt]), []);

  const packagingAt = writes.findIndex((items) => items.extractionRun.state === WORKFLOW_STATES.PACKAGING);
  const duringRetry = writes.slice(retryStartAt + 1, packagingAt);
  const resultWrites = duringRetry.filter((items) => resultKeysIn(items).length > 0);
  assert.deepEqual(
    resultWrites.map((items) => [resultKeysIn(items), items.extractionRun.retry.cursor, items[`extractionRun:result:${resultKeysIn(items)[0]}`].attempts]),
    [[['000000'], 1, 2], [['000002'], 2, 2]]
  );
  assert.ok(duringRetry.length <= 2 * 2, `${duringRetry.length} gravações para 2 conversas repescadas`);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results.map((result) => [result.status, result.attempts]), [
    ['saved', 2], ['saved', 1], ['saved', 2]
  ]);
});

test('gravação que falha: o erro fica registrado, a execução segue e o resultado vai de novo na gravação seguinte', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);
  // Só a gravação do resultado de Bia falha, uma vez
  const realSet = fake.api.storage.local.set;
  let failedOnce = false;
  fake.api.storage.local.set = async (items) => {
    if (!failedOnce && 'extractionRun:result:000001' in items) {
      failedOnce = true;
      throw new Error('QUOTA_BYTES quota exceeded');
    }
    return realSet(items);
  };

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    await orch.start({ safeDelayMs: 0 });
  } finally {
    console.error = originalError;
  }

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.equal(failedOnce, true);
  // O StorageClient registra a falha com o erro original
  const storageErrors = errors.filter(([message]) => String(message).includes('Erro ao salvar dados no storage:'));
  assert.equal(storageErrors.length, 1);
  assert.equal(storageErrors[0][1].message, 'QUOTA_BYTES quota exceeded');
  // O resultado de Bia vai numa gravação seguinte, junto do estado, e fica no storage
  const writes = storageWrites(fake);
  const resent = writes.filter((items) => 'extractionRun:result:000001' in items);
  assert.equal(resent.length, 1);
  assert.ok(resent[0].extractionRun.nextIndex >= 2);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results, orch.run.results);
});

test('iniciar outra execução apaga todas as chaves da anterior antes da 1ª gravação da nova, sem mexer nas preferências do popup', { timeout: TEST_TIMEOUT_MS }, async () => {
  // Execução A: 5 conversas, concluída
  const { fake: fakeA } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']) });
  const orchA = createOrchestrator();
  fakeA.content.onExport = deliveringExport(orchA);
  await orchA.start({ safeDelayMs: 0 });
  assert.equal(orchA.getState().state, WORKFLOW_STATES.COMPLETED);
  const keysOfA = [
    'extractionRun',
    'extractionRun:queue',
    ...['000000', '000001', '000002', '000003', '000004'].map((key) => `extractionRun:result:${key}`)
  ];
  assert.deepEqual(fakeA.storageKeys(), keysOfA);

  // Execução B: 2 conversas, num service worker novo, com o storage de A e as preferências do popup
  const extractionConfig = { downloadAll: false, maxChats: 3, safeDelayMs: 2000 };
  const fakeB = createFakeChrome({ chats: sidebarChats(['Zeca', 'Yara']), storage: { ...fakeA.snapshotStorage(), extractionConfig } });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  fakeB.content.onExport = deliveringExport(orchB);
  const realSet = fakeB.api.storage.local.set;
  let keysAtFirstWrite = null;
  fakeB.api.storage.local.set = (items) => {
    keysAtFirstWrite ??= fakeB.storageKeys();
    return realSet(items);
  };

  // Como o service worker ao subir: restaura A antes de atender o pedido de iniciar B
  await orchB.restore();
  await orchB.start({ safeDelayMs: 0 });

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  // A remoção vem antes de qualquer gravação de B e leva todas as chaves de A, pelo tamanho da fila dela
  const [firstOp] = fakeB.storageOps;
  assert.equal(firstOp.method, 'remove');
  assert.deepEqual([...firstOp.keys].sort(), keysOfA);
  assert.deepEqual(keysAtFirstWrite, ['extractionConfig']);

  // No fim, só as chaves de B (as posições 3 a 5 de A não sobram), e as preferências intactas
  assert.deepEqual(fakeB.storageKeys(), [
    'extractionConfig',
    'extractionRun',
    'extractionRun:queue',
    'extractionRun:result:000000',
    'extractionRun:result:000001'
  ]);
  const persisted = persistedRun(fakeB.snapshotStorage());
  assert.equal(persisted.runId, orchB.run.runId);
  assert.deepEqual(persisted.queue.map((chat) => chat.title), ['Zeca', 'Yara']);
  assert.deepEqual(persisted.results.map((result) => result.title), ['Zeca', 'Yara']);
  assert.deepEqual(fakeB.readStorage('extractionConfig'), extractionConfig);
});

test('execução gravada numa chave só, pela versão anterior: a retomada continua dela, e a 1ª gravação passa a fila e os resultados para as chaves próprias no mesmo set', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']);
  const { fake: fakeA, staging, archive } = setUp({ chats });

  /** Faz a instância exportar até a conversa `stallAt`, copiar o storage ali e ficar presa esperando o arquivo dela */
  function stallingAt(fake, orch, stallAt) {
    const deliver = deliveringExport(orch);
    const stalled = createDeferred();
    fake.content.onExport = (message) => {
      if (message.chat.title !== stallAt) return deliver(message);
      stalled.resolve(fake.snapshotStorage());
      return { success: true, triggered: true };
    };
    return stalled.promise;
  }

  // A (versão anterior): exporta Ana e Bia e fica presa em Caio, como se o Chrome encerrasse o service worker ali
  const orchA = createOrchestrator();
  const stalledA = stallingAt(fakeA, orchA, 'Caio');
  const loopA = orchA.start({ safeDelayMs: 0 });
  const legacy = toSingleKeyFormat(await stalledA);
  await orchA.cancel();
  await loopA;
  assert.deepEqual(Object.keys(legacy), ['extractionRun']);
  assert.deepEqual([legacy.extractionRun.queue.length, legacy.extractionRun.results.length, legacy.extractionRun.nextIndex], [5, 2, 2]);

  // B: lê a fila e os resultados de dentro do estado, exporta Caio e fica presa em Davi
  const fakeB = createFakeChrome({ chats, storage: legacy });
  installFakeChrome(fakeB);
  const orchB = createOrchestrator();
  const stalledB = stallingAt(fakeB, orchB, 'Davi');
  await orchB.restore();
  const restored = orchB.getState();
  assert.deepEqual([restored.state, restored.current, restored.total], [WORKFLOW_STATES.PAUSED, 3, 5]);
  assert.deepEqual(restored.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  // A restauração só lê: o storage continua no formato antigo até a 1ª gravação
  assert.deepEqual(fakeB.storageOps, []);
  assert.equal(orchB.resume(), true);
  const loopB = orchB._loopPromise;
  const snapshotB = await stalledB;
  await orchB.cancel();
  await loopB;

  // A 1ª gravação de B (a da retomada) leva o estado, sem a fila e os resultados, a fila e os resultados de Ana
  // e Bia; as seguintes não levam a fila de novo, e só o resultado novo (Caio) vai junto do estado
  const [firstWrite, ...laterWrites] = storageWrites(fakeB);
  assert.deepEqual(Object.keys(firstWrite).sort(), [
    'extractionRun', 'extractionRun:queue', 'extractionRun:result:000000', 'extractionRun:result:000001'
  ]);
  assert.equal('queue' in firstWrite.extractionRun, false);
  assert.equal('results' in firstWrite.extractionRun, false);
  assert.deepEqual(firstWrite['extractionRun:queue'], legacy.extractionRun.queue);
  assert.deepEqual([firstWrite['extractionRun:result:000000'], firstWrite['extractionRun:result:000001']], legacy.extractionRun.results);
  assert.equal(laterWrites.some((items) => 'extractionRun:queue' in items), false);
  assert.deepEqual(laterWrites.flatMap(resultKeysIn), ['000002']);
  assert.deepEqual(Object.keys(snapshotB).sort(), [
    'extractionRun', 'extractionRun:queue', 'extractionRun:result:000000', 'extractionRun:result:000001', 'extractionRun:result:000002'
  ]);

  // C: reinício de novo, agora do formato novo; continua de Davi
  const fakeC = createFakeChrome({ chats, storage: snapshotB });
  installFakeChrome(fakeC);
  const orchC = createOrchestrator();
  fakeC.content.onExport = deliveringExport(orchC);
  await orchC.restore();
  assert.equal(orchC.resume(), true);
  await orchC._loopPromise;

  assert.equal(orchC.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Caio', 'Davi']);
  assert.deepEqual(fakeC.content.exportRequests.map((m) => m.chat.title), ['Davi', 'Eva']);
  assert.deepEqual(staging.saves.map((s) => [s.chatId, s.chatTitle]), [
    ['000000', 'Ana'], ['000001', 'Bia'], ['000002', 'Caio'], ['000003', 'Davi'], ['000004', 'Eva']
  ]);
  assert.equal(archive.calls.length, 1);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002', '000003', '000004']);
  assert.equal(archive.calls[0].report.split('\n').filter((line) => line.startsWith('[OK] ')).length, 5);
});

test('fila de outra execução que sobrou no storage não é retomada: reinício durante a varredura nova termina em falha', { timeout: TEST_TIMEOUT_MS }, async () => {
  const fake = createFakeChrome({
    chats: sidebarChats(['Ana']),
    storage: {
      // Estado da execução nova, interrompida na varredura, antes de gravar a fila dela
      extractionRun: {
        runId: 'nova',
        tabId: null,
        options: { maxChats: null, downloadAll: true, safeDelayMs: 0 },
        nextIndex: 0,
        startedAt: '2026-10-06T12:00:00.000Z',
        state: WORKFLOW_STATES.SCANNING
      },
      // Fila da execução anterior, que a limpeza não conseguiu apagar
      'extractionRun:queue': [{ id: 'chat_Velha', title: 'Velha', duplicateTitle: false }]
    }
  });
  installFakeChrome(fake);
  harness = { staging: stubStaging(), archive: stubArchiveDownloader({ staging: stubStaging() }), orchestrators: [] };
  const orch = createOrchestrator();

  await orch.restore();

  assert.equal(orch.getState().state, WORKFLOW_STATES.FAILED);
  assert.deepEqual(orch.run.queue, []);
  assert.match(orch.getState().errorMessage, /durante a descoberta de conversas/);
});

// Linha da conta (o número da conta logada no WhatsApp Web): a detectada na aba ou, sem ela, a informada no
// popup; gravada no início da execução e conferida a cada retomada

const OTHER_LINE_PHONE = '5511911111111';
const LINE_NOT_DETECTED_MESSAGE =
  'Não foi possível detectar o número da linha (a conta logada no WhatsApp Web). Informe o número no popup para iniciar.';

/** Mensagem da retomada recusada com a aba logada em outra conta */
function otherAccountMessage(tabPhone, runPhone) {
  return `A aba do WhatsApp Web está logada em outra conta (linha +${tabPhone}). ` +
    `Esta extração é da linha +${runPhone}: entre na conta da linha +${runPhone} e clique em "Retomar".`;
}

/** Aviso da retomada com a aba sem a linha detectada */
function lineNotCheckedWarning(runPhone) {
  return '⚠️ A linha da aba do WhatsApp Web não foi detectada, e a conta dela não pôde ser conferida. ' +
    `Esta extração é da linha +${runPhone}: confira se a aba está logada nessa conta.`;
}

/**
 * Storage de uma execução interrompida no meio da fila: a instância A exporta as conversas antes de `stallAt` e
 * fica presa nela, como se o Chrome encerrasse o service worker ali
 * @param {Object} [startOptions] Opções do início de A, além do intervalo zero (ex: `linePhone`)
 */
async function snapshotStalledAt(fakeA, stallAt, startOptions = {}) {
  const orchA = createOrchestrator();
  const deliverA = deliveringExport(orchA);
  const stalled = createDeferred();
  let snapshot = null;
  fakeA.content.onExport = (message) => {
    if (message.chat.title !== stallAt) return deliverA(message);
    snapshot = fakeA.snapshotStorage();
    stalled.resolve();
    return { success: true, triggered: true };
  };

  const loopA = orchA.start({ safeDelayMs: 0, ...startOptions });
  await stalled.promise;
  await orchA.cancel();
  await loopA;
  return snapshot;
}

/** Service worker novo, restaurado do storage dado, com a aba logada na linha `line` (null: aba sem a linha) */
async function restartWith(storage, { chats, line }) {
  const fake = createFakeChrome({ chats, storage, line });
  installFakeChrome(fake);
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);
  await orch.restore();
  return { fake, orch };
}

test('linha detectada na aba: gravada em run.line antes da varredura, persistida e no cabeçalho do relatório e do log', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia']) });
  const orch = createOrchestrator();
  let lineAtScan = null;
  fake.content.onScan = () => { lineAtScan = structuredClone(orch.run.line); };
  fake.content.onExport = deliveringExport(orch);

  await orch.start({ safeDelayMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  const line = { phone: FAKE_LINE_PHONE, source: 'auto' };
  assert.deepEqual(lineAtScan, line);
  assert.deepEqual(orch.run.line, line);
  // A linha sai da mesma resposta que confere a aba, e já vai na 1ª gravação do estado
  assert.equal(fake.content.readyChecks, 1);
  assert.deepEqual(storageWrites(fake)[0].extractionRun.line, line);
  assert.deepEqual(fake.readStorage('extractionRun').line, line);

  const { report, executionLog } = archive.calls[0];
  assert.equal(report.split('\n')[3], `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`);
  assert.equal(executionLog.split('\n')[2], `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`);
});

test('sem a linha na aba e sem número informado, a extração falha antes da varredura com LINE_NOT_DETECTED, e o código é limpo ao iniciar outra', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana']);
  const { fake, archive } = setUp({ chats });
  fake.content.line = null;
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  const silencedError = console.error;
  console.error = () => {};
  try {
    await orch.start({ safeDelayMs: 0 });
  } finally {
    console.error = silencedError;
  }

  const failed = orch.getState();
  assert.deepEqual(
    [failed.state, failed.errorMessage, failed.errorCode],
    [WORKFLOW_STATES.FAILED, LINE_NOT_DETECTED_MESSAGE, 'LINE_NOT_DETECTED']
  );
  // A aba foi conferida, e nada além disso: nem varredura, nem exportação, nem ZIP
  assert.deepEqual(fake.receivedActions(), [ACTIONS.CHECK_PAGE_READY]);
  assert.equal(archive.calls.length, 0);
  assert.equal(orch.run.line, null);
  // O popup recebe a falha com o código, que fica no storage e volta depois de um reinício
  const notified = fake.progressUpdates().at(-1);
  assert.deepEqual(
    [notified.state, notified.errorCode, notified.errorMessage],
    [WORKFLOW_STATES.FAILED, 'LINE_NOT_DETECTED', LINE_NOT_DETECTED_MESSAGE]
  );
  const { orch: restored } = await restartWith(fake.snapshotStorage(), { chats, line: null });
  assert.deepEqual([restored.getState().state, restored.getState().errorCode], [WORKFLOW_STATES.FAILED, 'LINE_NOT_DETECTED']);

  // Com a linha detectada, a execução seguinte começa sem o código da anterior
  installFakeChrome(fake);
  fake.content.line = accountLine(FAKE_LINE_PHONE);
  let errorCodeAtScan;
  fake.content.onScan = () => { errorCodeAtScan = orch.getState().errorCode; };
  await orch.start({ safeDelayMs: 0 });
  assert.equal(errorCodeAtScan, null);
  assert.deepEqual([orch.getState().state, orch.getState().errorCode], [WORKFLOW_STATES.COMPLETED, null]);
});

test('sem a linha na aba, vale o número informado no popup, só com os dígitos e com origem "manual", de 10 a 15 dígitos', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana']) });
  fake.content.line = null;
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  for (const [linePhone, phone] of [
    ['+55 (11) 92222-2222', '5511922222222'],
    ['1192222222', '1192222222'],
    ['999999999999999', '999999999999999']
  ]) {
    await orch.start({ safeDelayMs: 0, linePhone });

    assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED, linePhone);
    assert.deepEqual(orch.run.line, { phone, source: 'manual' });
    assert.deepEqual(fake.readStorage('extractionRun').line, { phone, source: 'manual' });
    const { report, executionLog } = archive.calls.at(-1);
    assert.equal(report.split('\n')[3], `Linha: ${phone} (informada no popup)`);
    assert.equal(executionLog.split('\n')[2], `Linha: ${phone} (informada no popup)`);
  }
});

test('com a linha detectada na aba, o número informado no popup não é usado', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  await orch.start({ safeDelayMs: 0, linePhone: '5511922222222' });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(orch.run.line, { phone: FAKE_LINE_PHONE, source: 'auto' });
  assert.equal(archive.calls[0].report.split('\n')[3], `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`);
});

test('número da linha inválido: start() lança o erro sem começar a execução, mesmo com a linha detectada na aba', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch);

  for (const [linePhone, digits] of [['99999-9999', 9], ['+999 9999 99999-9999', 16], ['sem número', 0]]) {
    await assert.rejects(
      orch.start({ safeDelayMs: 0, linePhone }),
      { message: `Número da linha inválido (${digits} dígito(s)): informe de 10 a 15 dígitos, com o DDI (ex.: 5511999999999).` },
      linePhone
    );
    assert.equal(orch.isBusy(), false);
    assert.equal(orch.getState().state, WORKFLOW_STATES.IDLE);
    assert.equal(orch.run, null);
  }
  assert.equal(fake.content.readyChecks, 0);
  assert.equal(archive.calls.length, 0);

  // Campo em branco é o mesmo que não informar o número
  await orch.start({ safeDelayMs: 0, linePhone: '  ' });
  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(orch.run.line, { phone: FAKE_LINE_PHONE, source: 'auto' });
});

test('retomada depois de reinício com a aba em outra conta: a execução continua pausada, sem exportar nada, até a aba voltar à linha dela', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotStalledAt(fakeA, 'Caio');
  assert.deepEqual(snapshot.extractionRun.line, { phone: FAKE_LINE_PHONE, source: 'auto' });

  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: accountLine(OTHER_LINE_PHONE) });
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  const message = otherAccountMessage(OTHER_LINE_PHONE, FAKE_LINE_PHONE);
  const refused = orchB.getState();
  assert.deepEqual([refused.state, refused.statusMessage, refused.errorMessage], [WORKFLOW_STATES.PAUSED, message, null]);
  assert.equal(orchB.isBusy(), false);
  // A aba só foi conferida: nada exportado nem empacotado
  assert.deepEqual(fakeB.receivedActions(), [ACTIONS.CHECK_PAGE_READY]);
  assert.equal(archive.calls.length, 0);
  // O popup recebe o aviso, e a pausa com a mensagem fica no storage
  assert.equal(fakeB.progressUpdates().at(-1).warningMessage, message);
  assert.deepEqual(
    [fakeB.readStorage('extractionRun').state, fakeB.readStorage('extractionRun').statusMessage],
    [WORKFLOW_STATES.PAUSED, message]
  );

  // A aba volta à conta da execução: "Retomar" continua de Caio
  fakeB.content.line = accountLine(FAKE_LINE_PHONE);
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Caio', 'Davi']);
  assert.equal(archive.calls.length, 1);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000001', '000002', '000003']);
  assert.equal(archive.calls[0].report.split('\n')[3], `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`);
});

test('cancelamento enquanto a retomada depois de reinício confere a aba: a execução fica cancelada, e não pausada pela outra conta', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotStalledAt(fakeA, 'Caio');

  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: accountLine(OTHER_LINE_PHONE) });
  // A aba demora a responder o CHECK_PAGE_READY, e o usuário cancela nesse meio-tempo
  const answer = createDeferred();
  let checkPending = false;
  const realSendMessage = fakeB.api.tabs.sendMessage;
  fakeB.api.tabs.sendMessage = async (tabId, message) => {
    if (message.action === ACTIONS.CHECK_PAGE_READY) {
      checkPending = true;
      await answer.promise;
    }
    return realSendMessage(tabId, message);
  };

  assert.equal(orchB.resume(), true);
  const loop = orchB._loopPromise;
  await waitUntil(() => checkPending, { description: 'CHECK_PAGE_READY da retomada enviado' });
  await orchB.cancel();
  answer.resolve();
  await loop;

  assert.deepEqual([orchB.getState().state, orchB.getState().statusMessage], [WORKFLOW_STATES.CANCELLED, 'Extração cancelada.']);
  assert.equal(orchB.isPaused, false);
  assert.deepEqual(fakeB.content.exportRequests, []);
  assert.equal(archive.calls.length, 0);
  assert.equal(fakeB.readStorage('extractionRun').state, WORKFLOW_STATES.CANCELLED);
});

test('retomada depois de reinício com a aba sem a linha detectada: a execução segue, com um aviso no popup', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotStalledAt(fakeA, 'Caio');

  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: null });
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Caio']);
  assert.deepEqual(fakeB.progressUpdates().map((m) => m.warningMessage).filter(Boolean), [lineNotCheckedWarning(FAKE_LINE_PHONE)]);
  // A linha da execução continua a do início
  assert.deepEqual(orchB.run.line, { phone: FAKE_LINE_PHONE, source: 'auto' });
  assert.equal(archive.calls[0].report.split('\n')[3], `Linha: ${FAKE_LINE_PHONE} (detectada na aba)`);
});

test('pausa no meio da fila e troca de conta na aba: "Retomar" pergunta a linha à aba e volta a pausar, até a aba voltar à conta da execução', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch);
  fake.content.onExport = (message) => {
    if (message.chat.title === 'Bia') orch.pause();
    return deliver(message);
  };

  const loop = orch.start({ safeDelayMs: 0 });
  await waitUntil(() => orch.run?.nextIndex === 2, { description: 'fim da exportação de "Bia"' });
  // Folga para o laço chegar à espera da retomada
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(orch.getState().state, WORKFLOW_STATES.PAUSED);

  // Durante a pausa, a aba entra em outra conta
  fake.content.line = accountLine(OTHER_LINE_PHONE);
  assert.equal(orch.resume(), true);
  const message = otherAccountMessage(OTHER_LINE_PHONE, FAKE_LINE_PHONE);
  await waitUntil(() => orch.getState().statusMessage === message, { description: 'volta à pausa com a aba em outra conta' });

  assert.equal(orch.getState().state, WORKFLOW_STATES.PAUSED);
  assert.equal(orch.isBusy(), true);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia']);
  assert.equal(fake.progressUpdates().at(-1).warningMessage, message);
  assert.equal(fake.readStorage('extractionRun').statusMessage, message);
  assert.equal(countAction(fake, ACTIONS.CHECK_PAGE_READY), 2);

  // De volta à conta da execução, a retomada segue de Caio
  fake.content.line = accountLine(FAKE_LINE_PHONE);
  assert.equal(orch.resume(), true);
  await loop;

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio']);
  // A linha é perguntada à aba na retomada, antes de exportar a conversa seguinte
  const actions = fake.receivedActions();
  assert.equal(countAction(fake, ACTIONS.CHECK_PAGE_READY), 3);
  const lastCheck = actions.lastIndexOf(ACTIONS.CHECK_PAGE_READY);
  assert.deepEqual(actions.slice(lastCheck, lastCheck + 2), [ACTIONS.CHECK_PAGE_READY, ACTIONS.EXPORT_CHAT_REQUEST]);
  assert.equal(archive.calls.length, 1);
});

test('reinício na repescagem com a aba em outra conta: a rodada só continua quando a aba volta à linha da execução', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio', 'Davi']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotDuringRetry(fakeA, { stallAt: 1 });

  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: accountLine(OTHER_LINE_PHONE) });
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  const refused = orchB.getState();
  assert.deepEqual([refused.state, refused.statusMessage], [WORKFLOW_STATES.PAUSED, otherAccountMessage(OTHER_LINE_PHONE, FAKE_LINE_PHONE)]);
  // Nem a lista lateral nem as conversas da rodada foram pedidas à aba
  assert.deepEqual(fakeB.receivedActions(), [ACTIONS.CHECK_PAGE_READY]);
  assert.equal(orchB.run.retry.cursor, 0);

  fakeB.content.line = accountLine(FAKE_LINE_PHONE);
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Bia', 'Davi']);
  assert.deepEqual(orchB.run.results.map((r) => r.attempts), [1, 2, 1, 2]);
  assert.equal(archive.calls.length, 1);
});

test('execução gravada por uma versão anterior, sem a linha: a retomada segue sem conferir a conta, e o relatório e o log dizem que a linha não foi registrada', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotWithoutUnexpectedFiles(fakeA);
  delete snapshot.extractionRun.line;

  // A aba está em outra conta, mas sem a linha da execução não há com o que comparar
  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: accountLine(OTHER_LINE_PHONE) });
  assert.equal(orchB.run.line, undefined);
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Caio']);
  assert.equal(fakeB.content.readyChecks, 1);
  assert.deepEqual(fakeB.progressUpdates().map((m) => m.warningMessage).filter(Boolean), []);
  const notRecorded = 'Linha: não registrada (execução iniciada por uma versão anterior da extensão)';
  const { report, executionLog } = archive.calls[0];
  assert.equal(report.split('\n')[3], notRecorded);
  assert.equal(executionLog.split('\n')[2], notRecorded);
});

test('retomada com a linha digitada no popup com o 9 depois do DDD e a aba na mesma conta sem ele: segue, sem mudar a linha da execução; outro número continua recusado', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  // A aba não detectou a linha no início, e vale a digitada, com o 9
  fakeA.content.line = null;
  const snapshot = await snapshotStalledAt(fakeA, 'Caio', { linePhone: '+55 11 90000-0000' });
  const typedLine = { phone: FAKE_LINE_PHONE, source: 'manual' };
  assert.deepEqual(snapshot.extractionRun.line, typedLine);

  // Na retomada, a aba detecta a mesma conta, sem o 9, como o WhatsApp grava o número da conta
  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: accountLine('551100000000') });
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.equal(orchB.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(fakeB.content.exportRequests.map((m) => m.chat.title), ['Caio']);
  assert.deepEqual(fakeB.progressUpdates().map((m) => m.warningMessage).filter(Boolean), []);
  // A linha da execução continua a digitada, no estado e no relatório
  assert.deepEqual(orchB.run.line, typedLine);
  assert.deepEqual(fakeB.readStorage('extractionRun').line, typedLine);
  assert.equal(archive.calls[0].report.split('\n')[3], `Linha: ${FAKE_LINE_PHONE} (informada no popup)`);

  // Outro número, com ou sem o 9, de outro DDD ou com outros dígitos, continua recusado
  for (const otherPhone of ['551122222222', '5511922222222', '552100000000', '5521900000000']) {
    const { fake, orch } = await restartWith(snapshot, { chats, line: accountLine(otherPhone) });
    assert.equal(orch.resume(), true);
    await orch._loopPromise;
    assert.deepEqual(
      [orch.getState().state, orch.getState().statusMessage],
      [WORKFLOW_STATES.PAUSED, otherAccountMessage(otherPhone, FAKE_LINE_PHONE)],
      otherPhone
    );
    assert.deepEqual(fake.content.exportRequests, [], otherPhone);
    assert.deepEqual(orch.run.line, typedLine, otherPhone);
  }
  assert.equal(archive.calls.length, 1);
});

test('retomada com a linha detectada na aba no início: a comparação é exata, e a mesma conta sem o 9 é recusada como outra', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const snapshot = await snapshotStalledAt(fakeA, 'Caio');
  assert.deepEqual(snapshot.extractionRun.line, { phone: FAKE_LINE_PHONE, source: 'auto' });

  const { fake: fakeB, orch: orchB } = await restartWith(snapshot, { chats, line: accountLine('551100000000') });
  assert.equal(orchB.resume(), true);
  await orchB._loopPromise;

  assert.deepEqual(
    [orchB.getState().state, orchB.getState().statusMessage],
    [WORKFLOW_STATES.PAUSED, otherAccountMessage('551100000000', FAKE_LINE_PHONE)]
  );
  assert.deepEqual(fakeB.content.exportRequests, []);
  assert.equal(archive.calls.length, 0);
});

// Tipo da conversa e telefone do contato: o tipo sai do menu de opções; o telefone, do título (contato não salvo) ou do
// painel "Dados do contato", que a aba só abre quando o título não é um telefone

// Números fictícios: o título de um contato não salvo, e os lidos no painel (pessoa e conta comercial)
const UNSAVED_TITLE = '+55 11 90000-0001';
const UNSAVED_PHONE = '5511900000001';
const PANEL_PHONE = '5511900000002';
const BUSINESS_PHONE = '551130000003';
// Mensagem que o content (contact-info-reader.js) devolve quando o painel não abre no prazo
const DRAWER_NOT_OPENED = "o painel 'Dados do contato' não abriu em 5 s";
const PHONE_NOT_FOUND = 'número não encontrado no painel';

/** Leitura do painel que terminou, como o content real a devolve (ContactInfoReader.read) */
function contactInfo({ kind = 'chat', phone = null, ms = 1200, ...extra } = {}) {
  return { kind, phone, ms, ...extra };
}

/** Tipo e telefone do contato como ficam no resultado da conversa */
function contactRecord({ kind = null, phone = null, phoneSource = null, infoMs = null, infoError = null } = {}) {
  return { kind, phone, phoneSource, infoMs, infoError };
}

/** Nota da linha do relatório quando o telefone de uma conversa individual não foi lido no painel */
function contactNote(reason) {
  return ` Aviso: telefone do contato não lido no painel (${reason}).`;
}

/** Linha do cabeçalho do relatório com as conversas sem o telefone do contato */
function missingContactsHeader(count) {
  return `Aviso: em ${count} conversa(s) o telefone do contato não foi lido no painel 'Dados do contato'; ` +
    'o motivo está na linha de cada uma.';
}

/** Leitura do painel de cada tentativa no histórico da conversa; null na tentativa que não leu o painel */
function contactInfoAttempts(results) {
  return results.map((result) => result.history.map((entry) => entry.contactInfo ?? null));
}

test('tipo e telefone do contato: o título que é telefone dispensa o painel; o título com nome pede o painel, e o telefone dele é guardado; o grupo fica sem telefone e sem aviso', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats([UNSAVED_TITLE, 'Ana', 'Loja', 'Família']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, {
    contacts: {
      [UNSAVED_TITLE]: { chatKind: 'chat' },
      Ana: { chatKind: 'chat', contactInfo: contactInfo({ phone: PANEL_PHONE, ms: 1234 }) },
      // Conta comercial: o número do painel tem 12 dígitos, sem o 9 depois do DDD, e fica como veio
      Loja: { chatKind: 'chat', contactInfo: contactInfo({ phone: BUSINESS_PHONE, ms: 1500 }) },
      Família: { chatKind: 'group', contactInfo: contactInfo({ kind: 'group', ms: 2000 }) }
    }
  });

  await orch.start({ safeDelayMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  // O painel só é pedido quando o título não é um telefone
  assert.deepEqual(
    fake.content.exportRequests.map((m) => [m.chat.title, m.readContactInfo]),
    [[UNSAVED_TITLE, false], ['Ana', true], ['Loja', true], ['Família', true]]
  );
  const contacts = [
    contactRecord({ kind: 'chat', phone: UNSAVED_PHONE, phoneSource: 'title' }),
    contactRecord({ kind: 'chat', phone: PANEL_PHONE, phoneSource: 'contact_info', infoMs: 1234 }),
    contactRecord({ kind: 'chat', phone: BUSINESS_PHONE, phoneSource: 'contact_info', infoMs: 1500 }),
    contactRecord({ kind: 'group', infoMs: 2000 })
  ];
  assert.deepEqual(orch.run.results.map((r) => r.contact), contacts);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results.map((r) => r.contact), contacts);
  // A leitura do painel fica no histórico da tentativa que a fez
  assert.deepEqual(contactInfoAttempts(orch.run.results), [
    [null], [{ ms: 1234, error: null }], [{ ms: 1500, error: null }], [{ ms: 2000, error: null }]
  ]);

  // Nenhum aviso no relatório; no log, o tempo do painel no fim da linha da tentativa que o leu
  const { report, executionLog } = archive.calls[0];
  assert.deepEqual(report.split('\n').slice(6), [
    'Conversas na fila: 4 | no ZIP: 4 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0',
    '',
    `[OK] 1. "${UNSAVED_TITLE}" salvo (1.5 KB).`,
    '[OK] 2. "Ana" salvo (1.5 KB).',
    '[OK] 3. "Loja" salvo (1.5 KB).',
    '[OK] 4. "Família" salvo (1.5 KB).',
    ''
  ]);
  assert.deepEqual(executionLog.split('\n').slice(6, -1).map(withoutClockAndDuration), [
    `nº 1 "${UNSAVED_TITLE}" | tentativa 1 | <duração> | abertura: lista visível | OK`,
    'nº 2 "Ana" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 1.2 s',
    'nº 3 "Loja" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 1.5 s',
    'nº 4 "Família" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 2 s'
  ]);
});

test('painel "Dados do contato" que falha ou não mostra o número: a conversa é salva, com a nota na linha do relatório, a contagem no cabeçalho e o tempo do painel no log', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio', 'Davi', 'Eva']) });
  const orch = createOrchestrator();
  const unknownTitle = 'título do painel não reconhecido: "Contact info"';
  fake.content.onExport = deliveringExport(orch, {
    contacts: {
      Ana: { chatKind: 'chat', contactInfoError: { message: DRAWER_NOT_OPENED, ms: 5012 } },
      Bia: { chatKind: 'chat', contactInfo: contactInfo({ ms: 900 }) },
      // Nem o menu nem o painel com os textos esperados: o tipo fica desconhecido, e a aba diz o motivo
      Caio: { chatKind: null, contactInfo: contactInfo({ kind: null, ms: 800, reason: unknownTitle }) },
      // O número foi lido, e o painel continuou aberto: só o log registra
      Davi: { chatKind: 'chat', contactInfo: contactInfo({ phone: PANEL_PHONE, ms: 7100, warning: 'o painel não fechou' }) },
      // Telefone com dígitos de menos não é aceito
      Eva: { chatKind: 'chat', contactInfo: contactInfo({ phone: '119000', ms: 1000 }) }
    }
  });

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  // A falha do painel não derruba a exportação: todas foram salvas, e nenhuma entrou na repescagem
  assert.deepEqual(state.summary, { saved: 5, empty: 0, savedToDisk: 0, notExportable: 0, failed: 0 });
  assert.equal(fake.content.exportRequests.length, 5);
  assert.deepEqual(orch.run.results.map((r) => r.contact), [
    contactRecord({ kind: 'chat', infoMs: 5012, infoError: DRAWER_NOT_OPENED }),
    contactRecord({ kind: 'chat', infoMs: 900, infoError: PHONE_NOT_FOUND }),
    contactRecord({ infoMs: 800, infoError: unknownTitle }),
    contactRecord({ kind: 'chat', phone: PANEL_PHONE, phoneSource: 'contact_info', infoMs: 7100 }),
    contactRecord({ kind: 'chat', infoMs: 1000, infoError: PHONE_NOT_FOUND })
  ]);
  assert.deepEqual(contactInfoAttempts(orch.run.results), [
    [{ ms: 5012, error: DRAWER_NOT_OPENED }],
    [{ ms: 900, error: PHONE_NOT_FOUND }],
    [{ ms: 800, error: unknownTitle }],
    [{ ms: 7100, error: null, warning: 'o painel não fechou' }],
    [{ ms: 1000, error: PHONE_NOT_FOUND }]
  ]);
  // A mensagem da conversa não muda: o aviso fica no relatório, e o popup não recebe aviso nenhum
  assert.equal(orch.run.results[0].message, '"Ana" salvo (1.5 KB).');
  assert.deepEqual(fake.progressUpdates().map((m) => m.warningMessage).filter(Boolean), []);

  const { report, executionLog } = archive.calls[0];
  assert.deepEqual(report.split('\n').slice(6), [
    'Conversas na fila: 5 | no ZIP: 5 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0',
    missingContactsHeader(4),
    '',
    `[OK] 1. "Ana" salvo (1.5 KB).${contactNote(DRAWER_NOT_OPENED)}`,
    `[OK] 2. "Bia" salvo (1.5 KB).${contactNote(PHONE_NOT_FOUND)}`,
    `[OK] 3. "Caio" salvo (1.5 KB).${contactNote(unknownTitle)}`,
    '[OK] 4. "Davi" salvo (1.5 KB).',
    `[OK] 5. "Eva" salvo (1.5 KB).${contactNote(PHONE_NOT_FOUND)}`,
    ''
  ]);
  assert.deepEqual(executionLog.split('\n').slice(6, -1).map(withoutClockAndDuration), [
    `nº 1 "Ana" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: falhou em 5 s (${DRAWER_NOT_OPENED})`,
    `nº 2 "Bia" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: falhou em 0.9 s (${PHONE_NOT_FOUND})`,
    `nº 3 "Caio" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: falhou em 0.8 s (${unknownTitle})`,
    'nº 4 "Davi" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 7.1 s (aviso: o painel não fechou)',
    `nº 5 "Eva" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: falhou em 1 s (${PHONE_NOT_FOUND})`
  ]);
});

test('tipo e telefone do contato também na falha: a não exportável guarda o chatKind e o telefone lido antes do menu; a falha na abertura fica só com o telefone do título', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', UNSAVED_TITLE, 'Caio', 'Davi']) });
  const orch = createOrchestrator();
  const ambiguous = (title) => ({ error: `Há mais de uma conversa chamada "${title}"; não é possível escolher com segurança.`, code: 'AMBIGUOUS_TITLE' });
  fake.content.onExport = deliveringExport(orch, {
    failures: {
      Ana: { error: EXPORT_UNAVAILABLE_MESSAGE, code: 'EXPORT_OPTION_UNAVAILABLE' },
      // Falham na abertura, antes do painel e do menu: a aba não manda nada do contato
      Bia: ambiguous('Bia'),
      [UNSAVED_TITLE]: ambiguous(UNSAVED_TITLE),
      // Falha no modal, depois do painel e do menu
      Caio: { error: 'O modal de exportação não oferece "Todas as mensagens".', code: 'DATE_RANGE_NOT_ALL' }
    },
    contacts: {
      Ana: { chatKind: 'chat', contactInfo: contactInfo({ phone: PANEL_PHONE, ms: 1100 }) },
      Caio: { chatKind: 'group', contactInfo: contactInfo({ kind: 'group', ms: 1300 }) }
    }
  });

  await orch.start({ safeDelayMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(orch.run.results.map(({ status, code }) => [status, code]), [
    ['not_exportable', 'EXPORT_OPTION_UNAVAILABLE'],
    ['failed', 'AMBIGUOUS_TITLE'],
    ['failed', 'AMBIGUOUS_TITLE'],
    ['failed', 'DATE_RANGE_NOT_ALL'],
    ['saved', null]
  ]);
  const contacts = [
    contactRecord({ kind: 'chat', phone: PANEL_PHONE, phoneSource: 'contact_info', infoMs: 1100 }),
    null,
    contactRecord({ phone: UNSAVED_PHONE, phoneSource: 'title' }),
    contactRecord({ kind: 'group', infoMs: 1300 }),
    // A aba simulada não mandou o tipo nem a leitura do painel
    null
  ];
  assert.deepEqual(orch.run.results.map((r) => r.contact ?? null), contacts);
  // Sem nada conhecido do contato, o resultado fica sem o campo
  assert.equal('contact' in orch.run.results[1], false);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results.map((r) => r.contact ?? null), contacts);
  assert.deepEqual(contactInfoAttempts(orch.run.results), [[{ ms: 1100, error: null }], [null], [null], [{ ms: 1300, error: null }], [null]]);

  // A não exportável continua contada à parte, e nenhuma linha leva o aviso do telefone
  const { report } = archive.calls[0];
  assert.equal(report.includes('telefone do contato'), false);
  const lines = report.split('\n');
  assert.equal(lines[6], 'Conversas na fila: 5 | no ZIP: 1 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 1 | falhas: 3');
  assert.equal(lines[8], `[NÃO EXPORTÁVEL] 1. "Ana": ${EXPORT_UNAVAILABLE_MESSAGE}`);
});

test('repescagem: o resultado da 2ª tentativa não perde o telefone nem o tipo lidos na 1ª, e o log mostra o painel de cada tentativa', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const menuTimeout = 'Timeout de 15s aguardando o menu de opções da conversa.';
  const modalTimeout = 'Timeout de 30s aguardando o modal "Exportar conversa".';
  const failure = (error, code, fields) => ({ success: false, cancelled: false, error, code, ...fields });
  // Resposta da aba em cada tentativa de cada conversa: [fila, repescagem]. Sem `success: false`, a exportação deu certo
  const responses = {
    // Na fila, o painel deu o número, e o menu não abriu; na repescagem, exportada, mas o painel não abriu
    Ana: [
      failure(menuTimeout, 'TIMEOUT', { contactInfo: contactInfo({ phone: PANEL_PHONE, ms: 1000 }) }),
      { chatKind: 'chat', contactInfoError: { message: DRAWER_NOT_OPENED, ms: 5000 } }
    ],
    // Na fila, um grupo que falhou no modal; na repescagem, não encontrada, sem nada do contato
    Bia: [
      failure(modalTimeout, 'TIMEOUT', { chatKind: 'group', contactInfo: contactInfo({ kind: 'group', ms: 1500 }) }),
      failure(notFound('Bia').error, 'CHAT_NOT_FOUND')
    ],
    // Na fila, nem o painel nem o menu abriram; na repescagem, exportada com o número do painel
    Caio: [
      failure(menuTimeout, 'TIMEOUT', { contactInfoError: { message: DRAWER_NOT_OPENED, ms: 5000 } }),
      { chatKind: 'chat', contactInfo: contactInfo({ phone: '5511900000003', ms: 1200 }) }
    ]
  };
  const deliver = deliveringExport(orch);
  fake.content.onExport = (message) => {
    const response = responses[message.chat.title][isRetryAttempt(message) ? 1 : 0];
    return response.success === false ? response : { ...deliver(message), ...response };
  };

  await orch.start({ safeDelayMs: 0, retryCooldownMs: 0 });

  assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(orch.run.retry.indices, [0, 1, 2]);
  assert.deepEqual(orch.run.results.map(({ status, attempts }) => [status, attempts]), [['saved', 2], ['failed', 2], ['saved', 2]]);
  const contacts = [
    // O número da fila fica, e a falha do painel na repescagem não vira aviso
    contactRecord({ kind: 'chat', phone: PANEL_PHONE, phoneSource: 'contact_info', infoMs: 1000 }),
    // O tipo lido na fila fica
    contactRecord({ kind: 'group', infoMs: 1500 }),
    // O número da repescagem vale, e a falha do painel na fila deixa de ser aviso
    contactRecord({ kind: 'chat', phone: '5511900000003', phoneSource: 'contact_info', infoMs: 1200 })
  ];
  assert.deepEqual(orch.run.results.map((r) => r.contact), contacts);
  assert.deepEqual(persistedRun(fake.snapshotStorage()).results.map((r) => r.contact), contacts);
  // O histórico guarda a leitura do painel de cada tentativa que a fez
  assert.deepEqual(contactInfoAttempts(orch.run.results), [
    [{ ms: 1000, error: null }, { ms: 5000, error: DRAWER_NOT_OPENED }],
    [{ ms: 1500, error: null }, null],
    [{ ms: 5000, error: DRAWER_NOT_OPENED }, { ms: 1200, error: null }]
  ]);

  const { report, executionLog } = archive.calls[0];
  assert.deepEqual(report.split('\n').slice(6), [
    'Conversas na fila: 3 | no ZIP: 2 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 1',
    retryHeader(3, 2),
    '',
    '[OK] 1. "Ana" salvo (1.5 KB). Tentativas: 2.',
    `[FALHA] 2. "Bia": ${notFound('Bia').error} Tentativas: 2.`,
    '[OK] 3. "Caio" salvo (1.5 KB). Tentativas: 2.',
    ''
  ]);
  assert.deepEqual(executionLog.split('\n').slice(6, -1).map(withoutClockAndDuration), [
    `nº 1 "Ana" | tentativa 1 | <duração> | abertura: não informada | FALHA (TIMEOUT) | motivo: ${menuTimeout} | dados do contato: 1 s`,
    `nº 2 "Bia" | tentativa 1 | <duração> | abertura: não informada | FALHA (TIMEOUT) | motivo: ${modalTimeout} | dados do contato: 1.5 s`,
    `nº 3 "Caio" | tentativa 1 | <duração> | abertura: não informada | FALHA (TIMEOUT) | motivo: ${menuTimeout} | ` +
      `dados do contato: falhou em 5 s (${DRAWER_NOT_OPENED})`,
    'Repescagem: rodada prevista para este horário (fim da espera; uma pausa a adia), com 3 conversa(s) que falharam na fila.',
    `nº 1 "Ana" | tentativa 2 | <duração> | abertura: lista visível | OK | dados do contato: falhou em 5 s (${DRAWER_NOT_OPENED})`,
    `nº 2 "Bia" | tentativa 2 | <duração> | abertura: não informada | FALHA (CHAT_NOT_FOUND) | motivo: ${notFound('Bia').error}`,
    'nº 3 "Caio" | tentativa 2 | <duração> | abertura: lista visível | OK | dados do contato: 1.2 s'
  ]);
});

test('tipo e telefone do contato persistidos com o resultado: depois de um reinício, a retomada os lê de volta para o relatório e o log; a execução gravada sem eles segue sem a nota', { timeout: TEST_TIMEOUT_MS }, async () => {
  const chats = sidebarChats(['Ana', 'Bia', 'Caio']);
  const { fake: fakeA, archive } = setUp({ chats });
  const contacts = {
    Ana: { chatKind: 'chat', contactInfo: contactInfo({ phone: PANEL_PHONE, ms: 1234 }) },
    Bia: { chatKind: 'chat', contactInfoError: { message: DRAWER_NOT_OPENED, ms: 5012 } },
    Caio: { chatKind: 'group', contactInfo: contactInfo({ kind: 'group', ms: 1500 }) }
  };
  const orchA = createOrchestrator();
  const deliverA = deliveringExport(orchA, { contacts });
  const stalled = createDeferred();
  let snapshot = null;
  // Em Caio, o storage é copiado como estaria se o Chrome encerrasse o service worker ali
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

  const savedBeforeRestart = [
    contactRecord({ kind: 'chat', phone: PANEL_PHONE, phoneSource: 'contact_info', infoMs: 1234 }),
    contactRecord({ kind: 'chat', infoMs: 5012, infoError: DRAWER_NOT_OPENED })
  ];
  assert.deepEqual(persistedRun(snapshot).results.map((r) => r.contact), savedBeforeRestart);

  /** Nova instância com o storage dado, retomada até o fim; devolve a instância, o relatório e o log */
  async function resumeFrom(storage) {
    const fake = createFakeChrome({ chats, storage });
    installFakeChrome(fake);
    const orch = createOrchestrator();
    fake.content.onExport = deliveringExport(orch, { contacts });
    await orch.restore();
    assert.equal(orch.resume(), true);
    await orch._loopPromise;
    assert.equal(orch.getState().state, WORKFLOW_STATES.COMPLETED);
    assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Caio']);
    const { report, executionLog } = archive.calls.at(-1);
    return { orch, report, executionLog };
  }

  // Os contatos de antes do reinício voltam do storage; o de Caio é o da retomada
  const resumed = await resumeFrom(snapshot);
  assert.deepEqual(resumed.orch.run.results.map((r) => r.contact), [...savedBeforeRestart, contactRecord({ kind: 'group', infoMs: 1500 })]);
  assert.deepEqual(resumed.report.split('\n').slice(6), [
    'Conversas na fila: 3 | no ZIP: 3 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 0',
    missingContactsHeader(1),
    '',
    '[OK] 1. "Ana" salvo (1.5 KB).',
    `[OK] 2. "Bia" salvo (1.5 KB).${contactNote(DRAWER_NOT_OPENED)}`,
    '[OK] 3. "Caio" salvo (1.5 KB).',
    ''
  ]);
  assert.deepEqual(resumed.executionLog.split('\n').slice(6, -1).map(withoutClockAndDuration), [
    'nº 1 "Ana" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 1.2 s',
    `nº 2 "Bia" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: falhou em 5 s (${DRAWER_NOT_OPENED})`,
    'nº 3 "Caio" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 1.5 s'
  ]);

  // Uma versão anterior da extensão não gravava o contato nem a leitura do painel no histórico
  const previousVersion = structuredClone(snapshot);
  for (const [key, result] of Object.entries(previousVersion)) {
    if (!RESULT_KEY.test(key)) continue;
    delete result.contact;
    for (const entry of result.history) delete entry.contactInfo;
  }
  const legacy = await resumeFrom(previousVersion);
  assert.deepEqual(legacy.orch.run.results.map((r) => r.contact ?? null), [null, null, contactRecord({ kind: 'group', infoMs: 1500 })]);
  assert.equal(legacy.report.includes('telefone do contato'), false);
  assert.deepEqual(legacy.executionLog.split('\n').slice(6, -1).map(withoutClockAndDuration), [
    'nº 1 "Ana" | tentativa 1 | <duração> | abertura: lista visível | OK',
    'nº 2 "Bia" | tentativa 1 | <duração> | abertura: lista visível | OK',
    'nº 3 "Caio" | tentativa 1 | <duração> | abertura: lista visível | OK | dados do contato: 1.5 s'
  ]);
});
