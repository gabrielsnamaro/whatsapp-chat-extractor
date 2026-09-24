/**
 * Background Service Worker (Manifest V3)
 * Coordena ciclo de vida, persistência e comunicação com clients externos.
 */
import { ACTIONS } from '../shared/constants/actions.js';
import { StorageClient } from '../shared/clients/storage-client.js';
import { BackendClient } from '../shared/clients/backend-client.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('ServiceWorker');

chrome.runtime.onInstalled.addListener(async (details) => {
  log.info(`Extensão instalada/atualizada: ${details.reason}`);
  await StorageClient.set({
    extractorStatus: 'idle',
    installedAt: new Date().toISOString()
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === ACTIONS.PING || message.action === 'PING') {
        sendResponse({ status: 'PONG', sender: 'service-worker' });
        return;
      }

      if (message.action === ACTIONS.GET_STATUS || message.action === 'GET_STATUS') {
        const state = await StorageClient.get(['extractorStatus', 'lastExtraction'], {});
        sendResponse({ success: true, data: state });
        return;
      }

      if (message.action === ACTIONS.FIND_WHATSAPP_TAB || message.action === 'FIND_WHATSAPP_TAB') {
        const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
        if (tabs && tabs.length > 0) {
          sendResponse({ success: true, tab: tabs[0] });
        } else {
          sendResponse({ success: false, message: 'Nenhuma aba do WhatsApp Web aberta.' });
        }
        return;
      }

      // Handler para sincronização através do BackendClient modular
      if (message.action === ACTIONS.SYNC_TO_BACKEND) {
        const client = await BackendClient.fromStorage();
        const result = await client.syncChats(message.chats || []);
        sendResponse({ success: true, result });
        return;
      }

      sendResponse({ success: false, error: 'Ação desconhecida: ' + message.action });
    } catch (err) {
      log.error('Erro ao processar mensagem:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Mantém o canal de resposta assíncrona aberto
});
