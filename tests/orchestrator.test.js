import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionOrchestrator } from '../background/extraction-orchestrator.js';
import { ZipBuilder } from '../shared/archive/zip-builder.js';
import { ACTIONS } from '../shared/constants/actions.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import {
  createFakeChrome,
  installFakeChrome,
  uninstallFakeChrome,
  deliverFile,
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
 * Comportamento da aba no EXPORT_CHAT_REQUEST: entrega o arquivo da conversa, ou responde a
 * falha configurada para aquele título, como o content real faz quando a automação DOM falha.
 * A falha é o texto do erro (sem código) ou `{ error, code }`. `files` troca os bytes arbitrários
 * de um título por um arquivo específico (ex: um ZIP nativo).
 */
function deliveringExport(orch, { sizes = {}, failures = {}, files = {} } = {}) {
  return (message) => {
    const { chat, captureId } = message;
    const failure = failures[chat.title];
    if (failure) {
      const { error, code = null } = typeof failure === 'string' ? { error: failure } : failure;
      return { success: false, cancelled: false, error, code };
    }
    deliverFile(orch, captureId, files[chat.title] ?? chatBytes(chat.title, sizes[chat.title] ?? 1536));
    return triggeredResponse();
  };
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
    size: 1536,
    empty: false,
    inspectionError: null,
    messageCount: 1,
    systemEventCount: 0,
    omittedMediaCount: 0,
    firstTimestamp: '01/01/2026, 09:00:00',
    lastTimestamp: '01/01/2026, 09:00:00',
    message: '"Ana" salvo (1.5 KB).'
  });
  assert.deepEqual(persisted.results.map((r) => r.staged), [true, true, true]);
});

test('falha no meio da fila não interrompe as conversas seguintes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { failures: { Bia: 'Conversa não encontrada na lista.' } });

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio']);
  assert.deepEqual(orch.run.results.map((r) => r.status), ['saved', 'failed', 'saved']);
  // Falha sem código conhecido: `code` null; a aba não confirmou a exportação, então `via` também
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'failed',
    code: null,
    via: null,
    staged: false,
    message: '"Bia": Conversa não encontrada na lista.'
  });

  // A conversa seguinte mantém a chave da sua posição na fila
  assert.deepEqual(staging.saves.map((s) => s.chatId), ['000000', '000002']);
  assert.deepEqual(archive.calls[0].stagedKeys, ['000000', '000002']);

  // A captura da conversa que falhou também é desarmada na aba
  const { runId } = orch.run;
  assert.ok(fake.content.received.some((m) => m.action === ACTIONS.DISARM_EXPORT_CAPTURE && m.captureId === `${runId}-1`));

  const warnings = fake.progressUpdates().map((m) => m.warningMessage).filter(Boolean);
  assert.deepEqual(warnings, ['[2/3] ⚠️ "Bia": Conversa não encontrada na lista.']);
  assert.match(state.statusMessage, /\. 2 conversa\(s\) no ZIP, 1 falha\(s\)\.$/);
});

test('cancelamento durante a espera do arquivo encerra sem empacotar', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  const deliver = deliveringExport(orch);
  // Bia: a página confirma a exportação, mas o arquivo nunca chega
  fake.content.onExport = (message) => (message.chat.title === 'Bia' ? { success: true, triggered: true } : deliver(message));

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
  fake.content.onExport = deliveringExport(orch, {
    sizes: { Ana: 1536, Caio: 3072 },
    failures: { Bia: 'Conversa não encontrada na lista.' }
  });

  await orch.start({ downloadAll: false, maxChats: 3, safeDelayMs: 0 });

  // Com limite, a varredura recebe o limite e a fila para nele
  assert.equal(fake.content.received.find((m) => m.action === ACTIONS.SCAN_CHATS_REQUEST).maxLimit, 3);
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio']);

  const { report } = archive.calls[0];
  assert.ok(report.endsWith('\n'));
  const lines = report.split('\n');
  assert.equal(lines.length, 11);
  assert.equal(lines[0], 'Relatório de extração - WhatsApp Web Extractor');
  // As datas dependem do fuso de quem roda o teste
  assert.match(lines[1], new RegExp(`^Início: ${DATE_PT_BR}$`));
  assert.match(lines[2], new RegExp(`^Geração do ZIP: ${DATE_PT_BR}$`));
  assert.deepEqual(lines.slice(3), [
    'Modo: limite de 3 conversa(s)',
    `${CONTENT_LINE_PREFIX} (0 anexo(s) omitido(s) nesta execução).`,
    'Conversas na fila: 3 | no ZIP: 2 (vazias: 0) | na pasta Downloads: 0 | não exportáveis: 0 | falhas: 1',
    '',
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[FALHA] 2. "Bia": Conversa não encontrada na lista.',
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
    message: `"Bia": ${EXPORT_UNAVAILABLE_MESSAGE}`
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

test('arquivo não entregue no prazo: falha FILE_NOT_DELIVERED com o prazo em segundos, e a fila segue', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator({ timings: { captureTimeoutMs: 50 } });
  const deliver = deliveringExport(orch);
  // Bia: a página abre a conversa pela busca e confirma a exportação, mas o arquivo nunca chega
  fake.content.onExport = (message) => (message.chat.title === 'Bia' ? triggeredResponse('search') : deliver(message));

  const startedAt = performance.now();
  await orch.start({ safeDelayMs: 0 });
  assert.ok(performance.now() - startedAt >= 45, 'a espera pelo arquivo deveria durar o prazo configurado');

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio']);

  const notDelivered = 'O WhatsApp Web não entregou o arquivo exportado em 0.05 s.';
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'failed',
    code: 'FILE_NOT_DELIVERED',
    via: 'search',
    staged: false,
    message: `"Bia": ${notDelivered}`
  });
  assert.equal(archive.calls[0].report.split('\n')[8], `[FALHA] 2. "Bia": ${notDelivered}`);
  assert.equal(fake.readStorage('extractionRun').results[1].code, 'FILE_NOT_DELIVERED');
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

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 1, empty: 0, savedToDisk: 1, notExportable: 0, failed: 3 });
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
    size: emptyZip.length,
    empty: true,
    inspectionError: null,
    messageCount: 0,
    systemEventCount: 0,
    omittedMediaCount: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    message: `"Bia" salvo (${sizeLabel(emptyZip)}).`
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
    size: truncatedZip.length,
    empty: false,
    inspectionError: result.inspectionError,
    messageCount: null,
    systemEventCount: null,
    omittedMediaCount: null,
    firstTimestamp: null,
    lastTimestamp: null,
    message: `"Bia" salvo (${sizeLabel(truncatedZip)}). Conteúdo não inspecionado: ${result.inspectionError}`
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
