/**
 * Background Service Worker (Manifest V3)
 * Roteador de eventos do ciclo de vida da extensão e despachante para o ExtractionOrchestrator.
 */
import { ACTIONS } from '../shared/constants/actions.js';
import { StorageClient } from '../shared/clients/storage-client.js';
import { BackendClient } from '../shared/clients/backend-client.js';
import { ExtractionOrchestrator } from './extraction-orchestrator.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('ServiceWorker');
const orchestrator = new ExtractionOrchestrator();

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

      // Consulta de estado da máquina de fluxo de extração
      if (message.action === ACTIONS.GET_WORKFLOW_STATE || message.action === 'GET_WORKFLOW_STATE') {
        sendResponse({ success: true, data: orchestrator.getState() });
        return;
      }

      // Controle da extração em lote (Popup -> Orchestrator)
      if (message.action === ACTIONS.START_BATCH_EXTRACTION) {
        const { maxChats, downloadAll, safeDelayMs, preloadHistory } = message;
        log.info(`Iniciando extração em lote (maxChats: ${maxChats}, downloadAll: ${downloadAll}, preloadHistory: ${preloadHistory ?? true})...`);

        // Responde de imediato ao popup e executa o orquestrador em segundo plano
        orchestrator.start({ maxChats, downloadAll, safeDelayMs, preloadHistory }).catch((err) => {
          log.error('Erro na execução da extração em lote:', err);
        });

        sendResponse({ success: true, message: 'Extração iniciada com sucesso.' });
        return;
      }

      if (message.action === ACTIONS.PAUSE_BATCH_EXTRACTION) {
        orchestrator.pause();
        sendResponse({ success: true });
        return;
      }

      if (message.action === ACTIONS.RESUME_BATCH_EXTRACTION) {
        orchestrator.resume();
        sendResponse({ success: true });
        return;
      }

      if (message.action === ACTIONS.CANCEL_BATCH_EXTRACTION) {
        orchestrator.cancel();
        sendResponse({ success: true });
        return;
      }

      // Notificação de blob pré-capturado pelo Content Script no DOM
      if (message.action === ACTIONS.BLOB_CAPTURED_FROM_PAGE || message.action === 'BLOB_CAPTURED_FROM_PAGE') {
        const { url, filename, bytes } = message;
        orchestrator.interceptor.registerCapturedBytes(url, filename, bytes);
        sendResponse({ success: true });
        return;
      }

      // Handler legado para sincronização via BackendClient
      if (message.action === ACTIONS.SYNC_TO_BACKEND) {
        const client = await BackendClient.fromStorage();
        const result = await client.syncChats(message.chats || []);
        sendResponse({ success: true, result });
        return;
      }

      sendResponse({ success: false, error: 'Ação desconhecida: ' + message.action });
    } catch (err) {
      log.error('Erro ao processar mensagem no Service Worker:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Mantém o canal de resposta assíncrona aberto
});
