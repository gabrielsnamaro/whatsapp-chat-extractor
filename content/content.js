/**
 * Content Script (Injetado em https://web.whatsapp.com/*)
 * Atua estritamente como Mediador de Mensagens entre o Background/Popup da extensão
 * e os controladores especializados de DOM (ChatListScanner, ChatNavigator, ChatOptionsMenu, ExportModalHandler).
 */

(function initWhatsAppContentMediator() {
  console.log('[WhatsApp Web Extractor] Mediador de Content Script inicializado.');

  // Instâncias dos controladores de DOM de responsabilidade única
  const scanner = new (window.ChatListScanner || ChatListScanner)();
  const navigator = new (window.ChatNavigator || ChatNavigator)();
  const optionsMenu = new (window.ChatOptionsMenu || ChatOptionsMenu)();
  const modalHandler = new (window.ExportModalHandler || ExportModalHandler)();

  function isPageReady() {
    return Boolean(document.querySelector('#app') || document.querySelector('#pane-side'));
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        switch (message.action) {
          // Verificação de prontidão da página
          case 'CHECK_PAGE_READY': {
            const ready = isPageReady();
            sendResponse({ success: true, ready, url: window.location.href });
            return;
          }

          // Descoberta e listagem de conversas (com suporte a limite maxLimit)
          case 'SCAN_CHATS_REQUEST': {
            const maxLimit = message.maxLimit ?? null;
            console.log(`[WhatsApp Web Extractor] Iniciando escaneamento de chats (limite: ${maxLimit ?? 'todos'})...`);

            const chats = await scanner.scanAllChats({
              maxLimit,
              onProgress: (count) => {
                // Opcional: emitir progresso intermediário se houver canal aberto
              }
            });

            console.log(`[WhatsApp Web Extractor] Escaneamento concluído: ${chats.length} conversas localizadas.`);
            sendResponse({ success: true, chats });
            return;
          }

          // Execução do fluxo de exportação nativa de um chat específico
          case 'EXPORT_CHAT_REQUEST': {
            const chat = message.chat;
            if (!chat || !chat.title) {
              sendResponse({ success: false, error: 'Parâmetro de conversa inválido para exportação.' });
              return;
            }

            console.log(`[WhatsApp Web Extractor] Processando exportação do chat: "${chat.title}"...`);

            // 1. Navegar até a conversa e aguardar montagem do cabeçalho
            await navigator.openChat(chat);

            // 2. Acionar o menu suspenso e clicar em "Exportar conversa"
            await optionsMenu.triggerExportOption();

            // 3. Confirmar o modal nativo com "Todas as mensagens"
            await modalHandler.confirmExport();

            console.log(`[WhatsApp Web Extractor] Solicitação de exportação disparada com sucesso para "${chat.title}".`);
            sendResponse({ success: true, chatTitle: chat.title });
            return;
          }

          // Obter conversa ativa atualmente no cabeçalho
          case 'GET_ACTIVE_CHAT': {
            const activeTitle = navigator.getActiveChatTitle();
            sendResponse({ success: true, activeTitle });
            return;
          }

          // Busca sob demanda de conteúdo de blob gerado nesta aba
          case 'FETCH_BLOB_REQUEST': {
            const { url, filename } = message;
            if (!url) {
              sendResponse({ success: false, error: 'URL do blob ausente.' });
              return;
            }

            try {
              const res = await fetch(url);
              const buffer = await res.arrayBuffer();
              const bytes = Array.from(new Uint8Array(buffer));
              sendResponse({ success: true, filename, bytes });
            } catch (err) {
              console.error('[WhatsApp Web Extractor] Erro ao buscar blob URL na página:', err);
              sendResponse({ success: false, error: err.message });
            }
            return;
          }

          default:
            sendResponse({ success: false, error: `Ação não reconhecida no content script: ${message.action}` });
        }
      } catch (err) {
        console.error('[WhatsApp Web Extractor] Erro no mediator do content script:', err);
        sendResponse({ success: false, error: err.message });
      }
    })();

    return true; // Mantém o canal de resposta assíncrona aberto
  });

  // Escuta no DOM para capturar imediatamente cliques em links de download com blob:
  document.addEventListener('click', async (event) => {
    try {
      const anchor = event.target?.closest?.('a[download]');
      if (anchor && anchor.href && anchor.href.startsWith('blob:')) {
        console.log('[WhatsApp Web Extractor] Link de download interceptado no DOM:', anchor.download);
        const res = await fetch(anchor.href);
        const buffer = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));

        chrome.runtime.sendMessage({
          action: 'BLOB_CAPTURED_FROM_PAGE',
          url: anchor.href,
          filename: anchor.download || 'conversa.txt',
          bytes
        });
      }
    } catch (err) {
      console.warn('[WhatsApp Web Extractor] Erro ao pré-capturar blob do clique:', err);
    }
  }, true);
})();
