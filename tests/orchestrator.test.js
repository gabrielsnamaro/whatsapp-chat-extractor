import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionOrchestrator } from '../background/extraction-orchestrator.js';
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
const DATE_PT_BR = String.raw`\d{2}/\d{2}/\d{4},? \d{2}:\d{2}:\d{2}`;

function sidebarChats(titles, { duplicates = [] } = {}) {
  return titles.map((title) => ({
    id: `chat_${title}`,
    title,
    unread: null,
    timestamp: null,
    duplicateTitle: duplicates.includes(title)
  }));
}

function chatBytes(title, size) {
  const bytes = new Uint8Array(size).fill(0x2e);
  bytes.set(new TextEncoder().encode(title).subarray(0, size));
  return bytes;
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Comportamento da aba no EXPORT_CHAT_REQUEST: entrega o arquivo da conversa, ou responde a
 * falha configurada para aquele título, como o content real faz quando a automação DOM falha
 */
function deliveringExport(orch, { sizes = {}, failures = {} } = {}) {
  return (message) => {
    const { chat, captureId } = message;
    if (failures[chat.title]) {
      return { success: false, cancelled: false, error: failures[chat.title] };
    }
    deliverFile(orch, captureId, chatBytes(chat.title, sizes[chat.title] ?? 1536));
    return { success: true, triggered: true };
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

function createOrchestrator() {
  const orch = new ExtractionOrchestrator();
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
  assert.deepEqual(state.summary, { saved: 3, savedToDisk: 0, failed: 0 });
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
  assert.match(report, /^Modo: todas as conversas$/m);
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
});

test('falha no meio da fila não interrompe as conversas seguintes', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { fake, staging, archive } = setUp({ chats: sidebarChats(['Ana', 'Bia', 'Caio']) });
  const orch = createOrchestrator();
  fake.content.onExport = deliveringExport(orch, { failures: { Bia: 'Conversa não encontrada na lista.' } });

  await orch.start({ safeDelayMs: 0 });

  const state = orch.getState();
  assert.equal(state.state, WORKFLOW_STATES.COMPLETED);
  assert.deepEqual(state.summary, { saved: 2, savedToDisk: 0, failed: 1 });
  assert.deepEqual(fake.content.exportRequests.map((m) => m.chat.title), ['Ana', 'Bia', 'Caio']);
  assert.deepEqual(orch.run.results.map((r) => r.status), ['saved', 'failed', 'saved']);
  assert.deepEqual(orch.run.results[1], {
    title: 'Bia',
    status: 'failed',
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
  assert.deepEqual(state.summary, { saved: 1, savedToDisk: 0, failed: 0 });

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
  assert.equal(lines.length, 10);
  assert.equal(lines[0], 'Relatório de extração - WhatsApp Web Extractor');
  // As datas dependem do fuso de quem roda o teste
  assert.match(lines[1], new RegExp(`^Início: ${DATE_PT_BR}$`));
  assert.match(lines[2], new RegExp(`^Geração do ZIP: ${DATE_PT_BR}$`));
  assert.deepEqual(lines.slice(3), [
    'Modo: limite de 3 conversa(s)',
    'Conversas na fila: 3 | no ZIP: 2 | na pasta Downloads: 0 | falhas: 1',
    '',
    '[OK] 1. "Ana" salvo (1.5 KB).',
    '[FALHA] 2. "Bia": Conversa não encontrada na lista.',
    `[OK] 3. "Caio" salvo (3.0 KB).${DUPLICATE_NOTE}`,
    ''
  ]);
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
  assert.deepEqual(state.summary, { saved: 5, savedToDisk: 0, failed: 0 });

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
