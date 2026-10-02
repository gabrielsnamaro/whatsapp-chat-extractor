import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadInterceptor } from '../background/download-interceptor.js';
import { ExportCaptureRegistry } from '../background/export-capture-registry.js';
import { ACTIONS } from '../shared/constants/actions.js';
import {
  WHATSAPP_TAB_ID,
  createFakeChrome,
  installFakeChrome,
  uninstallFakeChrome,
  whatsAppDownload,
  waitUntil
} from './helpers/fake-chrome.js';

// O interceptor isolado: quais downloads do WhatsApp ele toma para a captura armada, quais deixa
// seguir, e o que avisa como recebido fora de hora quando nenhuma captura está armada

const originalConsole = { log: console.log, warn: console.warn };
before(() => {
  console.log = () => {};
  console.warn = () => {};
});
after(() => {
  Object.assign(console, originalConsole);
});

let fake = null;
let interceptor = null;
let unexpected = [];

beforeEach(() => {
  fake = createFakeChrome();
  installFakeChrome(fake);
  fake.content.onFetchBlob = () => ({ success: true });
  unexpected = [];
  interceptor = new DownloadInterceptor({
    registry: new ExportCaptureRegistry(),
    onUnexpectedFile: (info) => unexpected.push(info)
  });
  interceptor.startListening();
});

afterEach(() => {
  interceptor.stopListening();
  uninstallFakeChrome();
});

/**
 * Dispara o download e espera a leitura pela aba. Os downloads que não devem ser tomados vão antes,
 * no mesmo tique: se algum deles fosse tomado, a leitura dele chegaria antes da deste.
 */
async function dispatchAndWaitFetch(ignoredItems, takenItem) {
  const before = fake.content.fetchRequests.length;
  for (const item of ignoredItems) fake.dispatchDownload(item);
  fake.dispatchDownload(takenItem);
  await waitUntil(() => fake.content.fetchRequests.length > before, { description: `leitura do download ${takenItem.id}` });
  return fake.content.fetchRequests.slice(before);
}

test('com a captura armada, outro arquivo do WhatsApp segue e a captura continua armada para a exportação', async () => {
  interceptor.arm({ captureId: 'cap-1', tabId: WHATSAPP_TAB_ID });

  const fetched = await dispatchAndWaitFetch(
    [
      whatsAppDownload({ id: 1, filename: '/home/fulano/Downloads/foto.jpg', mime: 'image/jpeg' }),
      whatsAppDownload({ id: 2, filename: 'documento.pdf', mime: '' }),
      // Sem nome ainda, o tipo decide: imagem e PDF não são exportação de conversa
      whatsAppDownload({ id: 3, filename: '', mime: 'image/jpeg' }),
      whatsAppDownload({ id: 5, filename: '', mime: 'application/pdf' })
    ],
    whatsAppDownload({ id: 4, filename: '/home/fulano/Downloads/Conversa do WhatsApp com Ana.ZIP', mime: '' })
  );

  assert.deepEqual(fetched.map(({ action, captureId, filename, url }) => ({ action, captureId, filename, url })), [
    { action: ACTIONS.FETCH_BLOB_REQUEST, captureId: 'cap-1', filename: 'Conversa do WhatsApp com Ana.ZIP', url: whatsAppDownload({ id: 4 }).url }
  ]);
  for (const id of [1, 2, 3, 5]) assert.deepEqual(fake.downloadCallsFor(id), [], `download ${id} não deveria ser tocado`);
  assert.deepEqual(fake.downloadCallsFor(4).map((call) => call.method), ['pause', 'search', 'cancel', 'erase']);
  // Com a captura armada, os ignorados não são "fora de hora"
  assert.deepEqual(unexpected, []);
});

test('sem nome no onCreated, o tipo ZIP ou texto é aceito, e o tipo genérico ou a falta de nome e tipo também', async () => {
  const cases = [
    { item: whatsAppDownload({ id: 10, filename: '', mime: 'application/zip' }), filename: 'exportacao.zip' },
    { item: whatsAppDownload({ id: 11, filename: '', mime: 'application/x-zip-compressed' }), filename: 'exportacao.zip' },
    { item: whatsAppDownload({ id: 12, filename: '', mime: 'text/plain;charset=utf-8' }), filename: 'conversa.txt' },
    { item: whatsAppDownload({ id: 13, filename: '', mime: '' }), filename: 'conversa.txt' },
    // O tipo genérico não diz o que o arquivo é: decide como se o tipo faltasse
    { item: whatsAppDownload({ id: 15, filename: '', mime: 'application/octet-stream' }), filename: 'conversa.txt' },
    { item: whatsAppDownload({ id: 14, filename: 'C:\\Users\\fulano\\Downloads\\conversa.txt', mime: '' }), filename: 'conversa.txt' }
  ];

  for (const [i, { item, filename }] of cases.entries()) {
    interceptor.arm({ captureId: `cap-${i}`, tabId: WHATSAPP_TAB_ID });
    const [fetched] = await dispatchAndWaitFetch([], item);
    assert.deepEqual({ captureId: fetched.captureId, filename: fetched.filename }, { captureId: `cap-${i}`, filename }, `download ${item.id}`);
  }
  assert.deepEqual(unexpected, []);
});

test('uma captura por exportação: o segundo arquivo de exportação não é tomado', async () => {
  interceptor.arm({ captureId: 'cap-1', tabId: WHATSAPP_TAB_ID });
  await dispatchAndWaitFetch([], whatsAppDownload({ id: 20, filename: 'a.zip' }));

  // Depois de tomar um arquivo a captura desarma: o próximo é "fora de hora" e segue
  fake.dispatchDownload(whatsAppDownload({ id: 21, filename: 'b.zip' }));
  assert.deepEqual(unexpected, [{ filename: 'b.zip' }]);
  assert.deepEqual(fake.downloadCallsFor(21), []);
  assert.equal(fake.content.fetchRequests.length, 1);
});

test('sem captura armada, a exportação do WhatsApp é avisada como fora de hora e segue, e os demais downloads são ignorados', async () => {
  fake.dispatchDownload(whatsAppDownload({ id: 30, filename: '/home/fulano/Downloads/Conversa do WhatsApp com Bia.zip' }));
  fake.dispatchDownload(whatsAppDownload({ id: 31, filename: '', mime: 'application/zip' }));
  fake.dispatchDownload(whatsAppDownload({ id: 32, filename: 'foto.jpg', mime: 'image/jpeg' }));
  // Download de outro site e o ZIP final da própria extensão não são do WhatsApp
  fake.dispatchDownload({ id: 33, url: 'https://exemplo.com/arquivo.zip', filename: 'arquivo.zip', mime: 'application/zip' });
  fake.dispatchDownload({ ...whatsAppDownload({ id: 34, filename: 'whatsapp_backup_2026-10-02.zip' }), byExtensionId: fake.api.runtime.id });
  // Sem nome, o tipo genérico pode ser a exportação e é avisado; um vídeo não é
  fake.dispatchDownload(whatsAppDownload({ id: 36, filename: '', mime: 'application/octet-stream' }));
  fake.dispatchDownload(whatsAppDownload({ id: 37, filename: '', mime: 'video/mp4' }));

  // O aviso é síncrono no onCreated; nada foi pausado nem lido
  assert.deepEqual(unexpected, [{ filename: 'Conversa do WhatsApp com Bia.zip' }, { filename: null }, { filename: null }]);
  for (const id of [30, 31, 32, 33, 34, 36, 37]) assert.deepEqual(fake.downloadCallsFor(id), [], `download ${id} não deveria ser tocado`);
  assert.deepEqual(fake.content.fetchRequests, []);

  // Com a escuta desativada, nem o aviso
  interceptor.stopListening();
  fake.dispatchDownload(whatsAppDownload({ id: 35, filename: 'c.zip' }));
  assert.equal(unexpected.length, 3);
});

test('a aba não consegue ler o arquivo: o download é retomado e a captura resolve como salva na pasta Downloads', async () => {
  const registry = new ExportCaptureRegistry();
  interceptor.stopListening();
  interceptor = new DownloadInterceptor({ registry, onUnexpectedFile: (info) => unexpected.push(info) });
  interceptor.startListening();
  fake.content.onFetchBlob = () => ({ success: false, error: 'HTTP 404 ao ler o arquivo exportado.' });

  registry.expect('cap-1');
  interceptor.arm({ captureId: 'cap-1', tabId: WHATSAPP_TAB_ID });
  fake.dispatchDownload(whatsAppDownload({ id: 40, filename: '', mime: 'application/zip' }));

  const captured = await registry.waitFor('cap-1', { timeoutMs: 1000 });
  assert.deepEqual(captured, { savedToDisk: true, filename: 'exportacao.zip', downloadId: 40, source: 'download' });
  assert.deepEqual(fake.downloadCallsFor(40).map((call) => call.method), ['pause', 'resume']);
});
