/**
 * Background Service Worker (Manifest V3)
 * Roteador de eventos do ciclo de vida da extensão e despachante para o ExtractionOrchestrator.
 */
import { ACTIONS } from '../shared/constants/actions.js';
import { ExtractionOrchestrator } from './extraction-orchestrator.js';
import { Logger } from '../shared/utils/logger.js';

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

chrome.runtime.onInstalled.addListener((details) => {
  log.info(`Extensão instalada/atualizada: ${details.reason}`);
});

/**
 * @param {Object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<Object>}
 */
async function handleMessage(message, sender) {
  if (TRANSFER_ACTIONS.has(message.action)) {
    if (!sender.tab?.url?.startsWith('https://web.whatsapp.com/')) {
      return { success: false, error: 'Origem não autorizada para transferência de arquivo.' };
    }
    return orchestrator.captures.handleTransferMessage(message);
  }

  switch (message.action) {
    case ACTIONS.PING:
      return { status: 'PONG', sender: 'service-worker' };

    case ACTIONS.GET_WORKFLOW_STATE:
      return { success: true, data: orchestrator.getState() };

    case ACTIONS.START_BATCH_EXTRACTION: {
      if (orchestrator.isBusy()) {
        return { success: false, error: 'Já existe uma extração em andamento.' };
      }
      const { maxChats, downloadAll, safeDelayMs } = message;
      log.info(`Iniciando extração em lote (maxChats: ${maxChats}, downloadAll: ${downloadAll})...`);
      // Responde de imediato ao popup; falhas chegam pelas notificações de progresso
      orchestrator.start({ maxChats, downloadAll, safeDelayMs }).catch((err) => {
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
