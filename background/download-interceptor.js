import { ACTIONS } from '../shared/constants/actions.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('DownloadInterceptor');

// O WhatsApp Web exporta a conversa em .zip ou .txt; imagens e documentos baixados da página não são tomados
const CHAT_EXPORT_FILENAME = /\.(zip|txt)$/i;
const CHAT_EXPORT_MIME = /zip|^text\/plain\b/i;
// Tipo genérico não diz o que o arquivo é: sem o nome, decide como se o tipo faltasse
const GENERIC_MIME = /^application\/octet-stream\b/i;

/**
 * DownloadInterceptor
 * Responsabilidade Única: Capturar pelo chrome.downloads o arquivo exportado quando ele não
 * passa pelo listener de clique do content script (ex: o WhatsApp dispara o download a partir
 * de um <a> fora do documento), evitando que caia na pasta Downloads do usuário.
 */
export class DownloadInterceptor {
  /**
   * @param {Object} params
   * @param {import('./export-capture-registry.js').ExportCaptureRegistry} params.registry
   * @param {function({ filename: string|null }): void} params.onUnexpectedFile Arquivo de exportação do
   *   WhatsApp que chegou com a escuta ativa e sem captura armada (o download não é bloqueado)
   */
  constructor({ registry, onUnexpectedFile }) {
    this._registry = registry;
    this._onUnexpectedFile = onUnexpectedFile;
    this._armed = null;
    this._isListening = false;
    this._onCreatedListener = (item) => {
      this._handleDownloadCreated(item).catch((err) => log.error('Erro ao tratar download interceptado:', err));
    };
  }

  startListening() {
    if (this._isListening) return;
    this._isListening = true;
    chrome.downloads.onCreated.addListener(this._onCreatedListener);
    log.info('Escuta de downloads ativada.');
  }

  stopListening() {
    if (!this._isListening) return;
    this._isListening = false;
    this._armed = null;
    chrome.downloads.onCreated.removeListener(this._onCreatedListener);
    log.info('Escuta de downloads desativada.');
  }

  /**
   * Passa a interceptar o próximo download do WhatsApp para esta captura.
   * Fora desse intervalo, downloads manuais do usuário seguem normalmente.
   * @param {{ captureId: string, tabId: number }} params
   */
  arm({ captureId, tabId }) {
    this._armed = { captureId, tabId };
  }

  disarm() {
    this._armed = null;
  }

  /**
   * @private
   * @param {chrome.downloads.DownloadItem} item
   * @returns {boolean}
   */
  _isWhatsAppExport(item) {
    if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) return false;
    const url = item.finalUrl || item.url || '';
    return url.startsWith('blob:https://web.whatsapp.com/') ||
           url.startsWith('https://web.whatsapp.com/') ||
           (url.startsWith('blob:') && (item.referrer || '').startsWith('https://web.whatsapp.com/'));
  }

  /**
   * Nome do arquivo sem o caminho; vazio enquanto o Chrome não o definiu
   * @private
   * @param {chrome.downloads.DownloadItem} item
   * @returns {string}
   */
  _basename(item) {
    return (item.filename || '').split(/[\\/]/).pop();
  }

  /**
   * Só a exportação de uma conversa (.zip ou .txt) é tomada. No onCreated o nome costuma vir vazio,
   * e aí decide o tipo: ZIP ou texto é aceito, e outro tipo conhecido (imagem, PDF...) é recusado. Sem
   * nome e sem tipo, ou com o tipo genérico application/octet-stream, o download é aceito, para não
   * deixar escapar uma exportação de que o Chrome ainda não disse nada.
   * @private
   * @param {chrome.downloads.DownloadItem} item
   * @returns {boolean}
   */
  _isChatExportFile(item) {
    const name = this._basename(item);
    if (name) return CHAT_EXPORT_FILENAME.test(name);
    const mime = (item.mime || '').trim();
    if (!mime || GENERIC_MIME.test(mime)) return true;
    return CHAT_EXPORT_MIME.test(mime);
  }

  /**
   * @private
   * @param {chrome.downloads.DownloadItem} item
   * @returns {string}
   */
  _guessFilename(item) {
    const fromPath = this._basename(item);
    if (fromPath) return fromPath;
    return /zip/i.test(item.mime || '') ? 'exportacao.zip' : 'conversa.txt';
  }

  /**
   * Remove o download do disco e do histórico depois que os bytes foram lidos pela aba
   * @private
   */
  async _discardDownload(downloadId) {
    const [current] = await chrome.downloads.search({ id: downloadId });
    if (current?.state === 'complete') {
      await chrome.downloads.removeFile(downloadId).catch(() => {});
    } else {
      await chrome.downloads.cancel(downloadId).catch(() => {});
    }
    await chrome.downloads.erase({ id: downloadId }).catch(() => {});
  }

  /**
   * @private
   * @param {chrome.downloads.DownloadItem} item
   */
  async _handleDownloadCreated(item) {
    if (!this._isWhatsAppExport(item)) return;

    const armed = this._armed;
    if (!this._isChatExportFile(item)) {
      if (armed) {
        log.info(`Download do WhatsApp ignorado (não é exportação de conversa): id=${item.id}, arquivo=${this._basename(item)}`);
      }
      return;
    }

    if (!armed) {
      // Antes do clique em "Exportar" ou entre conversas: o download segue, e o arquivo vai para o relatório
      const filename = this._basename(item) || null;
      log.warn(`Arquivo do WhatsApp recebido sem captura armada: id=${item.id}, arquivo=${filename ?? '(nome ainda não definido)'}`);
      this._onUnexpectedFile({ filename });
      return;
    }

    // Uma captura por exportação
    this._armed = null;
    const filename = this._guessFilename(item);
    log.info(`Download nativo do WhatsApp interceptado: id=${item.id}, arquivo=${filename}`);

    // Pausa em vez de cancelar: se a aba não conseguir ler o blob, o download é retomado
    // e o arquivo ao menos chega à pasta Downloads, em vez de se perder
    await chrome.downloads.pause(item.id).catch(() => {});

    try {
      const response = await chrome.tabs.sendMessage(armed.tabId, {
        action: ACTIONS.FETCH_BLOB_REQUEST,
        url: item.finalUrl || item.url,
        captureId: armed.captureId,
        filename
      });
      if (!response?.success) {
        throw new Error(response?.error || 'A aba não respondeu à leitura do arquivo.');
      }
      await this._discardDownload(item.id);
    } catch (err) {
      log.warn('Arquivo não pôde ser lido pela aba; o download seguirá para a pasta Downloads:', err);
      await chrome.downloads.resume(item.id).catch(() => {});
      this._registry.resolveSavedToDisk(armed.captureId, { filename, downloadId: item.id });
    }
  }
}
