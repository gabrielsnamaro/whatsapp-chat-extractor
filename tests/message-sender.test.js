import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, OFFSCREEN_ACTIONS, OFFSCREEN_TARGET } from '../shared/constants/actions.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { isFromWhatsAppTab, isFromExtensionPage } from '../shared/utils/message-sender.js';
import { findWhatsAppTab, countWhatsAppTabs } from '../shared/utils/whatsapp-tab.js';
import { createFakeChrome, installFakeChrome, uninstallFakeChrome, WHATSAPP_TAB_ID } from './helpers/fake-chrome.js';

// Remetentes como o Chrome os monta (chrome.runtime.MessageSender): o content script tem a aba e a URL da página; o popup e
// o service worker, a URL da extensão e nenhuma aba
const EXTENSION_ID = 'fake-extension-id';
const WHATSAPP_URL = 'https://web.whatsapp.com/';
const SENDERS = Object.freeze({
  popup: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` },
  popupInTab: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html`, tab: { id: 9, url: `chrome-extension://${EXTENSION_ID}/popup/popup.html` } },
  serviceWorker: { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}/background/service-worker.js` },
  content: { id: EXTENSION_ID, url: WHATSAPP_URL, tab: { id: WHATSAPP_TAB_ID, url: WHATSAPP_URL }, frameId: 0 },
  // A URL do frame faltando: vale a da aba
  contentWithoutFrameUrl: { id: EXTENSION_ID, tab: { id: WHATSAPP_TAB_ID, url: WHATSAPP_URL } },
  contentOfOtherSite: { id: EXTENSION_ID, url: 'https://exemplo.invalid/', tab: { id: 3, url: 'https://exemplo.invalid/' } },
  otherExtension: { id: 'outra-extensao', url: 'chrome-extension://outra-extensao/pagina.html' }
});

const originalConsole = { log: console.log, warn: console.warn, info: console.info, debug: console.debug };
let fake = null;

before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  console.debug = () => {};
  fake = createFakeChrome();
  installFakeChrome(fake);
});

after(() => {
  uninstallFakeChrome();
  Object.assign(console, originalConsole);
});

test('remetente: só o content script da aba do WhatsApp Web é dela; só o popup e o service worker são páginas da extensão', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(SENDERS).map(([name, sender]) => [name, isFromWhatsAppTab(sender)])), {
    popup: false,
    popupInTab: false,
    serviceWorker: false,
    content: true,
    contentWithoutFrameUrl: true,
    contentOfOtherSite: false,
    otherExtension: false
  });
  assert.deepEqual(Object.fromEntries(Object.entries(SENDERS).map(([name, sender]) => [name, isFromExtensionPage(sender)])), {
    popup: true,
    popupInTab: true,
    serviceWorker: true,
    content: false,
    contentWithoutFrameUrl: false,
    contentOfOtherSite: false,
    otherExtension: false
  });
  assert.equal(isFromWhatsAppTab(undefined), false);
  assert.equal(isFromExtensionPage(undefined), false);
});

test('aba do WhatsApp Web: a URL de cada aba é conferida, mesmo que o filtro da consulta não seja aplicado', async () => {
  const queries = [];
  const realQuery = fake.api.tabs.query;
  // Sem a permissão `tabs`, a aba de outro site vem sem a URL; aqui a consulta devolve todas, como se ignorasse o filtro
  fake.api.tabs.query = async (queryInfo) => {
    queries.push(queryInfo);
    return [
      { id: 1, active: true, lastAccessed: 9 },
      { id: 2, url: 'https://exemplo.invalid/', active: true, lastAccessed: 8 },
      { id: 3, url: 'https://web.whatsapp.com/', active: false, lastAccessed: 5 },
      { id: 4, url: 'https://web.whatsapp.com.exemplo.invalid/', active: true, lastAccessed: 7 }
    ];
  };
  try {
    assert.equal((await findWhatsAppTab()).id, 3);
    // A aba indicada só vale se for do WhatsApp Web
    assert.equal((await findWhatsAppTab({ preferredTabId: 2 })).id, 3);
    assert.equal(await countWhatsAppTabs(), 1);
    // O padrão da consulta é o mesmo da permissão de host
    assert.deepEqual(queries[0], { url: 'https://web.whatsapp.com/*' });
  } finally {
    fake.api.tabs.query = realQuery;
  }
});

/** Manda uma mensagem aos listeners do chrome.runtime.onMessage, como o Chrome faz, e espera a resposta */
function dispatch(message, sender) {
  return new Promise((resolve) => {
    let answered = false;
    const sendResponse = (response) => {
      answered = true;
      resolve(response);
    };
    const keepsChannel = [...fake.api.runtime.onMessage.listeners].map((listener) => listener(message, sender, sendResponse));
    // Nenhum listener respondeu nem segurou o canal: o Chrome não entrega resposta nenhuma
    if (!answered && !keepsChannel.includes(true)) resolve(undefined);
  });
}

test('service worker: os comandos do popup só valem de uma página da extensão, e os avisos da aba só da aba do WhatsApp Web', async () => {
  await import('../background/service-worker.js');

  assert.deepEqual(await dispatch({ action: ACTIONS.GET_WORKFLOW_STATE }, SENDERS.popup).then((r) => [r.success, r.data.state]), [true, WORKFLOW_STATES.IDLE]);
  assert.equal((await dispatch({ action: ACTIONS.GET_WORKFLOW_STATE }, SENDERS.popupInTab)).success, true);

  const refused = { success: false, error: 'Origem não autorizada para comandar a extração.' };
  for (const sender of [SENDERS.content, SENDERS.otherExtension]) {
    for (const action of [
      ACTIONS.GET_WORKFLOW_STATE, ACTIONS.START_BATCH_EXTRACTION, ACTIONS.PAUSE_BATCH_EXTRACTION,
      ACTIONS.RESUME_BATCH_EXTRACTION, ACTIONS.CANCEL_BATCH_EXTRACTION
    ]) {
      assert.deepEqual(await dispatch({ action, downloadAll: true, safeDelayMs: 0 }, sender), refused, `${action} de ${sender.url}`);
    }
  }
  // Nenhum comando recusado chegou ao orquestrador: a aba não recebeu nada
  assert.deepEqual(fake.receivedActions(), []);

  // A visibilidade da aba só vale vinda da aba do WhatsApp Web; fora de uma execução, ela é ignorada
  assert.deepEqual(await dispatch({ action: ACTIONS.TAB_VISIBILITY_CHANGED, visible: false }, SENDERS.content), { success: true, recorded: false });
  assert.deepEqual(await dispatch({ action: ACTIONS.TAB_VISIBILITY_CHANGED, visible: false }, SENDERS.contentWithoutFrameUrl), { success: true, recorded: false });
  for (const sender of [SENDERS.popup, SENDERS.contentOfOtherSite]) {
    assert.deepEqual(
      await dispatch({ action: ACTIONS.TAB_VISIBILITY_CHANGED, visible: false }, sender),
      { success: false, error: 'Origem não autorizada para avisar a visibilidade da aba.' }
    );
  }
});

test('offscreen document: atende o service worker, e não um content script nem outra extensão', async () => {
  await import('../offscreen/offscreen.js');

  const revoke = { target: OFFSCREEN_TARGET, action: OFFSCREEN_ACTIONS.REVOKE_ARCHIVE_URL, url: 'blob:nulo' };
  assert.deepEqual(await dispatch(revoke, SENDERS.serviceWorker), { success: true });
  for (const sender of [SENDERS.content, SENDERS.otherExtension]) {
    assert.deepEqual(await dispatch(revoke, sender), { success: false, error: 'Origem não autorizada para o offscreen document.' });
  }
});
