/**
 * Background Service Worker (Manifest V3)
 * Roteador de eventos do ciclo de vida da extensão e despachante para o ExtractionOrchestrator.
 */
import { ACTIONS } from '../shared/constants/actions.js';
import { ExtractionOrchestrator } from './extraction-orchestrator.js';
import { Logger } from '../shared/utils/logger.js';
import { isFromWhatsAppTab, isFromExtensionPage } from '../shared/utils/message-sender.js';

const log = new Logger('ServiceWorker');
const orchestrator = new ExtractionOrchestrator();

// O Chrome pode ter encerrado o service worker no meio de uma extração: reidrata antes de atender mensagens
const ready = orchestrator.restore().catch((err) => log.error('Falha ao restaurar o estado da extração:', err));

const TRANSFER_ACTIONS = new Set([
  ACTIONS.EXPORT_TRANSFER_START,
  ACTIONS.EXPORT_TRANSFER_CHUNK,
  ACTIONS.EXPORT_TRANSFER_END,
  ACTIONS.EXPORT_TRANSFER_FAILED
]);

// Comandos do popup: só valem vindos de uma página da extensão, e não de um content script
const POPUP_ACTIONS = new Set([
  ACTIONS.GET_WORKFLOW_STATE,
  ACTIONS.START_BATCH_EXTRACTION,
  ACTIONS.PAUSE_BATCH_EXTRACTION,
  ACTIONS.RESUME_BATCH_EXTRACTION,
  ACTIONS.CANCEL_BATCH_EXTRACTION
]);

chrome.runtime.onInstalled.addListener((details) => {
  log.info(`Extensão instalada/atualizada: ${details.reason}`);
});

/**
 * Mensagens sobre o arquivo exportado, a varredura e a visibilidade da aba só valem vindas do content script da aba do
 * WhatsApp Web (isFromWhatsAppTab); os comandos do popup, de uma página da extensão (isFromExtensionPage)
 * @param {Object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<Object>}
 */
async function handleMessage(message, sender) {
  if (POPUP_ACTIONS.has(message.action) && !isFromExtensionPage(sender)) {
    return { success: false, error: 'Origem não autorizada para comandar a extração.' };
  }
  if (TRANSFER_ACTIONS.has(message.action)) {
    if (!isFromWhatsAppTab(sender)) {
      return { success: false, error: 'Origem não autorizada para transferência de arquivo.' };
    }
    return orchestrator.captures.handleTransferMessage(message);
  }

  switch (message.action) {
    case ACTIONS.PING:
      return { status: 'PONG', sender: 'service-worker' };

    case ACTIONS.EXPORT_CAPTURE_ARMED:
      if (!isFromWhatsAppTab(sender)) {
        return { success: false, error: 'Origem não autorizada para armar a captura do arquivo.' };
      }
      return orchestrator.armCapture({ captureId: message.captureId, tabId: sender.tab.id });

    case ACTIONS.EXPORT_UNEXPECTED_FILE:
      if (!isFromWhatsAppTab(sender)) {
        return { success: false, error: 'Origem não autorizada para avisar de arquivo exportado.' };
      }
      return orchestrator.recordUnexpectedFile({ filename: message.filename, source: 'page' });

    case ACTIONS.SCAN_PROGRESS:
      if (!isFromWhatsAppTab(sender)) {
        return { success: false, error: 'Origem não autorizada para avisar o andamento da varredura.' };
      }
      return orchestrator.recordScanProgress({ found: message.found, tabId: sender.tab.id });

    case ACTIONS.TAB_VISIBILITY_CHANGED:
      if (!isFromWhatsAppTab(sender)) {
        return { success: false, error: 'Origem não autorizada para avisar a visibilidade da aba.' };
      }
      return orchestrator.recordTabVisibility({ visible: message.visible, tabId: sender.tab.id });

    case ACTIONS.GET_WORKFLOW_STATE:
      return { success: true, data: orchestrator.getState() };

    case ACTIONS.START_BATCH_EXTRACTION: {
      if (orchestrator.isBusy()) {
        return { success: false, error: 'Já existe uma extração em andamento.' };
      }
      // `linePhone` só vem quando o popup não detectou a linha na aba
      const { maxChats, downloadAll, safeDelayMs, historyLimitMs, linePhone } = message;
      log.info(`Iniciando extração em lote (maxChats: ${maxChats}, downloadAll: ${downloadAll})...`);
      // Responde de imediato ao popup; falhas chegam pelas notificações de progresso
      orchestrator.start({ maxChats, downloadAll, safeDelayMs, historyLimitMs, linePhone }).catch((err) => {
        log.error('Erro na execução da extração em lote:', err);
      });
      return { success: true, message: 'Extração iniciada com sucesso.' };
    }

    case ACTIONS.PAUSE_BATCH_EXTRACTION:
      return { success: orchestrator.pause() };

    case ACTIONS.RESUME_BATCH_EXTRACTION:
      return { success: orchestrator.resume() };

    case ACTIONS.CANCEL_BATCH_EXTRACTION:
      await orchestrator.cancel();
      return { success: true };

    default:
      return { success: false, error: 'Ação desconhecida: ' + message.action };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Mensagens com destino explícito (ex: offscreen document) não são deste roteador
  if (message?.target) return false;

  (async () => {
    try {
      await ready;
      sendResponse(await handleMessage(message, sender));
    } catch (err) {
      log.error('Erro ao processar mensagem no Service Worker:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Mantém o canal de resposta assíncrona aberto
});
