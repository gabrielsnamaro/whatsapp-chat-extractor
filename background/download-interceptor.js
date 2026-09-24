import { Logger } from '../shared/utils/logger.js';

const log = new Logger('DownloadInterceptor');

/**
 * DownloadInterceptor
 * Responsabilidade Única: Interceptar downloads nativos do WhatsApp Web,
 * cancelar o salvamento automático em disco e capturar a carga binária
 * para entrega ao orquestrador e StagingRepository.
 */
export class DownloadInterceptor {
  constructor() {
    this.isListening = false;
    this._onCreatedListener = this._handleDownloadCreated.bind(this);
    this._capturedDataMap = new Map(); // url -> { filename, bytes, timestamp }
    this._pendingDownloadResolvers = [];
  }

  /**
   * Inicia o monitoramento de downloads no navegador
   */
  startListening() {
    if (this.isListening) return;

    this.isListening = true;
    this._capturedDataMap.clear();
    this._pendingDownloadResolvers = [];

    if (typeof chrome !== 'undefined' && chrome.downloads?.onCreated) {
      chrome.downloads.onCreated.addListener(this._onCreatedListener);
      log.info('Escuta de downloads ativada.');
    }
  }

  /**
   * Interrompe o monitoramento de downloads
   */
  stopListening() {
    if (!this.isListening) return;

    this.isListening = false;
    if (typeof chrome !== 'undefined' && chrome.downloads?.onCreated) {
      chrome.downloads.onCreated.removeListener(this._onCreatedListener);
      log.info('Escuta de downloads desativada.');
    }

    // Rejeita eventuais promessas pendentes
    for (const { reject, timerId } of this._pendingDownloadResolvers) {
      clearTimeout(timerId);
      reject(new Error('Interceptador de downloads interrompido.'));
    }
    this._pendingDownloadResolvers = [];
    this._capturedDataMap.clear();
  }

  /**
   * Registra os dados binários capturados diretamente da aba do WhatsApp
   * @param {string} url
   * @param {string} filename
   * @param {Array<number>|Uint8Array} bytes
   */
  registerCapturedBytes(url, filename, bytes) {
    const uint8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    log.info(`Bytes pré-capturados para ${filename} (${(uint8.byteLength / 1024).toFixed(1)} KB)`);

    this._capturedDataMap.set(url, {
      filename,
      bytes: uint8,
      timestamp: Date.now()
    });

    // Se houver algum resolver aguardando este download
    if (this._pendingDownloadResolvers.length > 0) {
      const resolver = this._pendingDownloadResolvers.shift();
      clearTimeout(resolver.timerId);
      resolver.resolve({ filename, bytes: uint8 });
    }
  }

  /**
   * Trata o evento nativo chrome.downloads.onCreated
   * @private
   * @param {chrome.downloads.DownloadItem} downloadItem
   */
  _handleDownloadCreated(downloadItem) {
    const url = downloadItem.url || '';
    const filename = downloadItem.filename || '';

    // Verifica se o download é proveniente do WhatsApp Web
    const isWhatsAppBlob = url.startsWith('blob:') || url.includes('web.whatsapp.com');
    const isTxtOrZip = filename.toLowerCase().endsWith('.txt') || filename.toLowerCase().endsWith('.zip');

    if (!isWhatsAppBlob && !isTxtOrZip) {
      return; // Deixa outros downloads do usuário prosseguirem normalmente
    }

    log.info(`Download interceptado: id=${downloadItem.id}, url=${url.slice(0, 40)}..., filename=${filename}`);

    // Cancela imediatamente para não gravar no diretório Downloads do usuário
    try {
      chrome.downloads.cancel(downloadItem.id, () => {
        chrome.downloads.erase({ id: downloadItem.id });
      });
    } catch (err) {
      log.warn('Falha ao cancelar download nativo:', err);
    }

    // Notifica quem estiver aguardando
    if (this._pendingDownloadResolvers.length > 0) {
      const resolver = this._pendingDownloadResolvers.shift();
      clearTimeout(resolver.timerId);
      resolver.resolve({
        downloadId: downloadItem.id,
        url,
        filename: filename || 'conversa.txt'
      });
    }
  }

  /**
   * Aguarda a captura do arquivo exportado para o chat atual
   * @param {Object} params
   * @param {number} params.tabId ID da aba do WhatsApp Web
   * @param {number} [params.timeoutMs=20000]
   * @returns {Promise<{ filename: string, bytes: Uint8Array }>}
   */
  async waitForChatExport({ tabId, timeoutMs = 20000 }) {
    // 1. Verifica se já temos dados capturados recentemente no Map
    if (this._capturedDataMap.size > 0) {
      const [firstUrl, data] = this._capturedDataMap.entries().next().value;
      this._capturedDataMap.delete(firstUrl);
      return data;
    }

    // 2. Aguarda o evento de download ou a notificação de captura da página
    const downloadEvent = await new Promise((resolve, reject) => {
      const timerId = setTimeout(() => {
        const index = this._pendingDownloadResolvers.findIndex((r) => r.timerId === timerId);
        if (index !== -1) this._pendingDownloadResolvers.splice(index, 1);
        reject(new Error(`Timeout de ${timeoutMs}ms aguardando exportação do chat.`));
      }, timeoutMs);

      this._pendingDownloadResolvers.push({ resolve, reject, timerId });
    });

    // Se já retornou com bytes (resolvido por registerCapturedBytes)
    if (downloadEvent.bytes) {
      return {
        filename: downloadEvent.filename,
        bytes: downloadEvent.bytes
      };
    }

    // 3. Se obtivemos o evento do chrome.downloads com a URL do blob:
    // Solicitamos à aba ativa (content script) que faça o fetch local do blob
    if (downloadEvent.url && tabId) {
      try {
        log.info(`Solicitando fetch do blob ${downloadEvent.url.slice(0, 40)} à aba ${tabId}...`);
        const response = await chrome.tabs.sendMessage(tabId, {
          action: 'FETCH_BLOB_REQUEST',
          url: downloadEvent.url,
          filename: downloadEvent.filename
        });

        if (response && response.success && response.bytes) {
          const bytes = new Uint8Array(response.bytes);
          return {
            filename: response.filename || downloadEvent.filename || 'conversa.txt',
            bytes
          };
        }
      } catch (err) {
        log.warn('Não foi possível obter blob via FETCH_BLOB_REQUEST:', err);
      }
    }

    // Se houver algum item no cache que chegou paralelamente
    if (this._capturedDataMap.size > 0) {
      const [firstUrl, data] = this._capturedDataMap.entries().next().value;
      this._capturedDataMap.delete(firstUrl);
      return data;
    }

    throw new Error('Arquivo de exportação interceptado, mas os bytes não puderam ser recuperados.');
  }
}
