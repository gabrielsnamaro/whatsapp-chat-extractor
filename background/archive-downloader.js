import { OFFSCREEN_ACTIONS, OFFSCREEN_TARGET } from '../shared/constants/actions.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('ArchiveDownloader');

const OFFSCREEN_PATH = 'offscreen/offscreen.html';

/**
 * ArchiveDownloader
 * Responsabilidade Única: Pedir ao offscreen document o ZIP master montado a partir do staging,
 * disparar o download pela URL de Blob e aguardar até ele terminar (ou ser cancelado pelo usuário).
 */
export class ArchiveDownloader {
  /**
   * @param {Object} params
   * @param {string} params.archiveFilename
   * @param {string} params.report Relatório gravado na raiz do ZIP
   * @param {string[]} params.expectedKeys Chaves do staging que devem estar no ZIP, para a conferência
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{ completed: boolean, error?: string, size?: number, chatCount?: number, check?: import('../shared/archive/archive-packager.js').ArchiveCheck }>}
   */
  static async buildAndDownload({ archiveFilename, report, expectedKeys, signal }) {
    await this._ensureOffscreenDocument();
    let url = null;

    try {
      const built = await chrome.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        action: OFFSCREEN_ACTIONS.BUILD_ARCHIVE,
        report,
        expectedKeys
      });
      if (!built?.success) {
        throw new Error(built?.error || 'O offscreen document não conseguiu montar o ZIP.');
      }
      url = built.url;
      log.info(`ZIP montado: ${built.chatCount} conversa(s), ${(built.size / 1024 / 1024).toFixed(1)} MB. Disparando download...`);

      let downloadId;
      try {
        downloadId = await chrome.downloads.download({ url, filename: archiveFilename, saveAs: true, conflictAction: 'uniquify' });
      } catch (err) {
        return { completed: false, error: err.message, size: built.size, chatCount: built.chatCount, check: built.check };
      }

      // A URL de Blob só pode ser revogada depois que o download terminar
      const outcome = await this._waitForDownloadEnd(downloadId, signal);
      return { ...outcome, size: built.size, chatCount: built.chatCount, check: built.check };
    } finally {
      if (url) {
        await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, action: OFFSCREEN_ACTIONS.REVOKE_ARCHIVE_URL, url }).catch(() => {});
      }
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }

  /** @private */
  static async _ensureOffscreenDocument() {
    const documentUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl]
    });
    if (existing.length > 0) return;

    await chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification: 'Montar o ZIP consolidado das conversas e gerar uma URL de Blob para o download.'
    });
  }

  /**
   * @private
   * @param {number} downloadId
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ completed: boolean, error?: string }>}
   */
  static _waitForDownloadEnd(downloadId, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        chrome.downloads.onChanged.removeListener(onChanged);
        signal?.removeEventListener('abort', onAbort);
        callback(value);
      };
      const settleFromState = (state, error) => {
        if (state === 'complete') finish(resolve, { completed: true });
        if (state === 'interrupted') finish(resolve, { completed: false, error: error || 'download interrompido' });
      };
      const onChanged = (delta) => {
        if (delta.id === downloadId && delta.state) {
          settleFromState(delta.state.current, delta.error?.current);
        }
      };
      const onAbort = () => {
        chrome.downloads.cancel(downloadId).catch(() => {});
        finish(reject, new Error('Download do ZIP cancelado.'));
      };

      chrome.downloads.onChanged.addListener(onChanged);
      signal?.addEventListener('abort', onAbort, { once: true });

      // O download pode ter terminado antes de o listener ser registrado
      chrome.downloads.search({ id: downloadId })
        .then(([item]) => item && settleFromState(item.state, item.error))
        .catch(() => {});
    });
  }
}
