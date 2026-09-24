/**
 * Background Service Worker (Manifest V3)
 * Gerencia ciclo de vida, persistência temporária e coordenação de abas.
 */

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[WhatsApp Web Extractor] Extensão instalada/atualizada:', details.reason);
  await chrome.storage.local.set({
    extractorStatus: 'idle',
    installedAt: new Date().toISOString()
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === 'PING') {
        sendResponse({ status: 'PONG', sender: 'service-worker' });
        return;
      }

      if (message.action === 'GET_STATUS') {
        const state = await chrome.storage.local.get(['extractorStatus', 'lastExtraction']);
        sendResponse({ success: true, data: state });
        return;
      }

      if (message.action === 'FIND_WHATSAPP_TAB') {
        const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
        if (tabs && tabs.length > 0) {
          sendResponse({ success: true, tab: tabs[0] });
        } else {
          sendResponse({ success: false, message: 'Nenhuma aba do WhatsApp Web aberta.' });
        }
        return;
      }

      sendResponse({ success: false, error: 'Ação desconhecida: ' + message.action });
    } catch (err) {
      console.error('[WhatsApp Web Extractor] Erro no listener:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Mantém o canal de resposta assíncrona aberto
});
