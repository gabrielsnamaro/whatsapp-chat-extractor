/**
 * Content Script (Injetado em https://web.whatsapp.com/*)
 * Interage diretamente com o DOM do WhatsApp Web e APIs internas da página.
 */

console.log('[WhatsApp Web Extractor] Content Script carregado na página do WhatsApp Web.');

// Notifica quando o WhatsApp Web terminar de carregar os elementos principais
function isWhatsAppReady() {
  // O app principal do WhatsApp Web usa #app ou div[tabindex="-1"]
  return Boolean(document.querySelector('#app') || document.querySelector('#pane-side'));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.action === 'CHECK_PAGE_READY') {
        const ready = isWhatsAppReady();
        sendResponse({ success: true, ready, url: window.location.href });
        return;
      }

      if (message.action === 'EXTRACT_CHAT_METADATA') {
        // Exemplo inicial de extração de elementos visíveis na lista de chats
        const paneSide = document.querySelector('#pane-side');
        if (!paneSide) {
          sendResponse({ success: false, error: 'Painel de conversas (#pane-side) não encontrado no DOM.' });
          return;
        }

        sendResponse({
          success: true,
          message: 'Painel de conversas detectado com sucesso.',
          ready: true
        });
        return;
      }

      sendResponse({ success: false, error: 'Ação desconhecida no content script: ' + message.action });
    } catch (err) {
      console.error('[WhatsApp Web Extractor] Erro no content script:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Mantém o canal aberto para respostas assíncronas
});
