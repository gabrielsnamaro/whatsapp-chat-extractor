/**
 * Content Script (Injetado em https://web.whatsapp.com/*)
 * Atua estritamente como Mediador de Mensagens entre o Background/Popup da extensão
 * e os controladores especializados de DOM (ChatListScanner, ChatNavigator, ChatOptionsMenu, ExportModalHandler).
 */

(function initWhatsAppContentMediator() {
  // Após recarregar a extensão, o script antigo continua na página com o contexto invalidado.
  // O token garante que só a instância mais recente responda mensagens e intercepte downloads.
  const instanceToken = {};
  window.__waExtractorActiveInstance = instanceToken;
  const isActiveInstance = () => window.__waExtractorActiveInstance === instanceToken;

  const { SELECTORS, OperationCancelledError } = window.DomUtils;
  const scanner = new window.ChatListScanner();
  const chatNavigator = new window.ChatNavigator();
  const optionsMenu = new window.ChatOptionsMenu();
  const modalHandler = new window.ExportModalHandler();

  // 8 MiB por bloco (~11 MB em base64), abaixo do limite de 64 MiB por mensagem de extensão
  const TRANSFER_CHUNK_BYTES = 8 * 1024 * 1024;

  // O WhatsApp Web exporta a conversa em .zip ou .txt; imagens e documentos baixados da página não são tomados
  const CHAT_EXPORT_FILENAME = /\.(zip|txt)$/i;

  // Código da conversa que falha porque a captura não foi armada. Não é da automação do DOM
  // (DomUtils.ERROR_CODES): vem do aviso ao background antes do clique em "Exportar"
  const CAPTURE_NOT_ARMED_CODE = 'CAPTURE_NOT_ARMED';

  // Aviso da conversa exportada sem a confirmação de "Todas as mensagens" no modal (sem o rádio dela e
  // sem outro intervalo marcado). O background marca a conversa no relatório por este código
  const DATE_RANGE_UNCONFIRMED_WARNING = 'DATE_RANGE_UNCONFIRMED';

  // Conta logada (a linha): o WhatsApp Web grava o id dela em `last-wid-md`, como texto JSON
  // ("<dígitos>:<dispositivo>@c.us"). A chave `WALid` traz o LID da conta, que não é o telefone
  const ACCOUNT_LINE_STORAGE_KEY = 'last-wid-md';
  const ACCOUNT_WID_PATTERN = /^(\d{8,15})(?::\d+)?@c\.us$/;

  /** @type {AbortController|null} Operação DOM em andamento (scan ou exportação) */
  let currentOperation = null;
  /** @type {string|null} Captura aguardando o arquivo gerado pela exportação atual */
  let armedCaptureId = null;

  console.log('[WhatsApp Web Extractor] Mediador de Content Script inicializado.');

  function beginOperation() {
    currentOperation?.abort();
    currentOperation = new AbortController();
    return currentOperation;
  }

  function endOperation(operation) {
    if (currentOperation === operation) currentOperation = null;
  }

  /** Sessão logada: o painel lateral só existe depois da leitura do QR Code */
  function isSessionReady() {
    return Boolean(document.querySelector(SELECTORS.SIDE_PANEL) && document.querySelector(SELECTORS.PANE_SIDE));
  }

  /**
   * Linha da conta logada, lida do localStorage da página (o content script é da mesma origem)
   * @returns {{ phone: string, source: string }|null} Os dígitos do número, sem o "+"; null quando a chave falta,
   *   não tem o formato esperado ou o localStorage não pode ser lido
   */
  function readAccountLine() {
    let raw;
    try {
      raw = window.localStorage.getItem(ACCOUNT_LINE_STORAGE_KEY);
    } catch (err) {
      console.warn('[WhatsApp Web Extractor] Falha ao ler a linha da conta no localStorage da página:', err);
      return null;
    }
    if (typeof raw !== 'string') return null;

    let wid = raw.trim();
    try {
      const parsed = JSON.parse(wid);
      if (typeof parsed === 'string') wid = parsed;
    } catch (_) {
      // Gravado sem as aspas: vale o texto como está
    }
    const match = ACCOUNT_WID_PATTERN.exec(wid);
    return match ? { phone: match[1], source: ACCOUNT_LINE_STORAGE_KEY } : null;
  }

  async function sendToBackground(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.success) {
      throw new Error(response?.error || `O background recusou ${message.action}.`);
    }
    return response;
  }

  /**
   * Avisa o background de quantas conversas a varredura já encontrou, para o popup mostrar. Não espera a
   * resposta: um aviso perdido não atrapalha a varredura, e o seguinte traz o total atualizado.
   * @param {number} found
   */
  function reportScanProgress(found) {
    chrome.runtime.sendMessage({ action: 'SCAN_PROGRESS', found }).catch((err) => {
      console.warn('[WhatsApp Web Extractor] Falha ao avisar o background do andamento da varredura:', err);
    });
  }

  /**
   * Avisa o background, que arma a captura pelo chrome.downloads, e só depois da confirmação arma a
   * do clique no link. Sem a confirmação (recusa ou falha de comunicação), "Exportar" não é clicado.
   * @param {string} captureId
   */
  async function armCaptureBeforeConfirm(captureId) {
    try {
      await sendToBackground({ action: 'EXPORT_CAPTURE_ARMED', captureId });
    } catch (err) {
      const error = new Error(`A exportação não foi confirmada: a captura do arquivo não foi armada. ${err.message}`);
      error.code = CAPTURE_NOT_ARMED_CODE;
      throw error;
    }
    armedCaptureId = captureId;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function readBlob(fetchPromise) {
    const response = await fetchPromise;
    if (!response.ok) throw new Error(`HTTP ${response.status} ao ler o arquivo exportado.`);
    return response.blob();
  }

  /**
   * Envia o arquivo exportado ao background em blocos base64
   * @param {Object} params
   * @param {string} params.captureId
   * @param {string} params.filename
   * @param {Blob} params.blob
   * @param {'page'|'download'} params.source
   */
  async function transferBlob({ captureId, filename, blob, source }) {
    const totalChunks = Math.max(1, Math.ceil(blob.size / TRANSFER_CHUNK_BYTES));
    await sendToBackground({
      action: 'EXPORT_TRANSFER_START',
      captureId,
      filename,
      mimeType: blob.type,
      size: blob.size,
      totalChunks,
      source
    });
    for (let index = 0; index < totalChunks; index++) {
      const chunk = blob.slice(index * TRANSFER_CHUNK_BYTES, (index + 1) * TRANSFER_CHUNK_BYTES);
      await sendToBackground({ action: 'EXPORT_TRANSFER_CHUNK', captureId, index, data: await blobToBase64(chunk) });
    }
    await sendToBackground({ action: 'EXPORT_TRANSFER_END', captureId });
    console.log(`[WhatsApp Web Extractor] Arquivo "${filename}" (${(blob.size / 1024).toFixed(1)} KB) entregue ao background.`);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isActiveInstance()) return false;

    (async () => {
      try {
        switch (message.action) {
          case 'CHECK_PAGE_READY': {
            sendResponse({ success: true, ready: isSessionReady(), url: window.location.href, line: readAccountLine() });
            return;
          }

          case 'SCAN_CHATS_REQUEST': {
            const operation = beginOperation();
            try {
              // Com uma busca digitada na lista lateral, a varredura leria só os resultados dela
              chatNavigator.clearSearch();
              const { chats, stats } = await scanner.scanAllChats({
                maxLimit: message.maxLimit ?? null,
                onProgress: reportScanProgress,
                signal: operation.signal
              });
              console.log(`[WhatsApp Web Extractor] Escaneamento concluído: ${chats.length} conversas localizadas (parada: ${stats.stopReason}).`);
              sendResponse({ success: true, chats, stats });
            } finally {
              endOperation(operation);
            }
            return;
          }

          // Dispara a exportação nativa; o arquivo chega ao background separadamente, em blocos
          case 'EXPORT_CHAT_REQUEST': {
            // Um DISARM perdido (ex: service worker reiniciado no meio da espera) deixaria a captura da
            // conversa anterior armada até o onBeforeConfirm desta, e um arquivo nesse intervalo seria
            // bloqueado na página e recusado pelo background, sem ir para o ZIP nem para a pasta Downloads
            armedCaptureId = null;
            const { chat, captureId, queueIndex } = message;
            if (!chat?.title || !captureId) {
              sendResponse({ success: false, error: 'Parâmetros inválidos para exportação.' });
              return;
            }

            const operation = beginOperation();
            /** Diagnóstico da busca e da rolagem da abertura (ChatNavigator.openChat), quando elas rodaram */
            let openDiagnostics = null;
            try {
              const opened = await chatNavigator.openChat(chat, { signal: operation.signal, queueIndex });
              openDiagnostics = opened.diagnostics;
              await optionsMenu.triggerExportOption({ signal: operation.signal });
              // A captura só é armada imediatamente antes do clique em "Exportar" (o link de download só
              // existe depois dele): até lá, um arquivo atrasado da conversa anterior não é tomado como desta
              const { allMessagesConfirmed } = await modalHandler.confirmExport({
                signal: operation.signal,
                onBeforeConfirm: () => armCaptureBeforeConfirm(captureId)
              });
              const warnings = allMessagesConfirmed ? [] : [DATE_RANGE_UNCONFIRMED_WARNING];
              sendResponse({ success: true, triggered: true, via: opened.via, warnings, ...(openDiagnostics ? { openDiagnostics } : {}) });
            } catch (err) {
              if (armedCaptureId === captureId) armedCaptureId = null;
              // Uma falha no menu ou no modal também leva à resposta o diagnóstico da abertura que a precedeu;
              // uma falha na abertura já o traz (openChat)
              if (openDiagnostics && !err.openDiagnostics) err.openDiagnostics = openDiagnostics;
              throw err;
            } finally {
              endOperation(operation);
            }
            return;
          }

          case 'CANCEL_CURRENT_OPERATION': {
            currentOperation?.abort();
            armedCaptureId = null;
            modalHandler.cancelExport();
            optionsMenu.closeMenu();
            chatNavigator.clearSearch();
            sendResponse({ success: true });
            return;
          }

          case 'RESET_SIDEBAR': {
            chatNavigator.resetSidebar();
            sendResponse({ success: true });
            return;
          }

          case 'DISARM_EXPORT_CAPTURE': {
            if (!message.captureId || armedCaptureId === message.captureId) armedCaptureId = null;
            sendResponse({ success: true });
            return;
          }

          // Leitura do blob de um download interceptado pelo background (chrome.downloads)
          case 'FETCH_BLOB_REQUEST': {
            const { url, captureId, filename } = message;
            if (!url?.startsWith('blob:') || !captureId) {
              sendResponse({ success: false, error: 'Parâmetros inválidos para leitura do arquivo.' });
              return;
            }
            const blob = await readBlob(fetch(url));
            await transferBlob({ captureId, filename: filename || 'conversa.txt', blob, source: 'download' });
            sendResponse({ success: true });
            return;
          }

          default:
            sendResponse({ success: false, error: `Ação não reconhecida no content script: ${message.action}` });
        }
      } catch (err) {
        const cancelled = err instanceof OperationCancelledError;
        if (!cancelled) console.error('[WhatsApp Web Extractor] Erro no mediator do content script:', err);
        // DOMException traz um `code` numérico legado; só os códigos em texto são da extensão (DomUtils.ERROR_CODES)
        const code = typeof err.code === 'string' ? err.code : null;
        // Na exportação, o diagnóstico da abertura vai junto do erro, para o _execucao.log
        const openDiagnostics = err.openDiagnostics ?? null;
        sendResponse({ success: false, cancelled, error: err.message, code, ...(openDiagnostics ? { openDiagnostics } : {}) });
      }
    })();

    return true; // Mantém o canal de resposta assíncrona aberto
  });

  // Intercepta o link de download que o WhatsApp Web cria para o arquivo exportado.
  // Só toma o arquivo com uma captura armada: downloads manuais do usuário seguem normalmente.
  document.addEventListener('click', (event) => {
    if (!isActiveInstance()) return;

    const anchor = event.target?.closest?.('a[download]');
    if (!anchor?.href?.startsWith('blob:') || !CHAT_EXPORT_FILENAME.test(anchor.download)) return;
    const filename = anchor.download;

    if (!armedCaptureId) {
      // O download segue; durante uma extração, o background lista o arquivo no relatório
      chrome.runtime.sendMessage({ action: 'EXPORT_UNEXPECTED_FILE', filename }).catch((err) => {
        console.warn('[WhatsApp Web Extractor] Falha ao avisar o background de um arquivo exportado fora de hora:', err);
      });
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const captureId = armedCaptureId;
    armedCaptureId = null;
    console.log('[WhatsApp Web Extractor] Link de download interceptado no DOM durante extração:', filename);

    // O fetch sai antes de qualquer await: o WhatsApp pode revogar a URL logo após o clique
    const fetchPromise = fetch(anchor.href);
    readBlob(fetchPromise)
      .then((blob) => transferBlob({ captureId, filename, blob, source: 'page' }))
      .catch((err) => {
        console.warn('[WhatsApp Web Extractor] Falha ao capturar o arquivo exportado:', err);
        chrome.runtime.sendMessage({ action: 'EXPORT_TRANSFER_FAILED', captureId, error: err.message }).catch(() => {});
      });
  }, true);
})();
