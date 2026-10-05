/**
 * Offscreen Document
 * Monta o ZIP master e expõe uma URL de Blob para o download. Existe porque o service worker
 * não tem URL.createObjectURL e, sem ele, o ZIP precisava virar uma data URL base64 inteira em memória.
 * Compartilha a origem da extensão, então lê o mesmo IndexedDB de staging que o background grava.
 */
import { ArchivePackager } from '../shared/archive/archive-packager.js';
import { OFFSCREEN_ACTIONS, OFFSCREEN_TARGET } from '../shared/constants/actions.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('Offscreen');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== OFFSCREEN_TARGET) return false;

  (async () => {
    try {
      switch (message.action) {
        case OFFSCREEN_ACTIONS.BUILD_ARCHIVE: {
          const { blob, chatCount, check } = await ArchivePackager.build({
            report: message.report,
            expectedKeys: message.expectedKeys
          });
          const url = URL.createObjectURL(blob);
          sendResponse({ success: true, url, size: blob.size, chatCount, check });
          return;
        }
        case OFFSCREEN_ACTIONS.REVOKE_ARCHIVE_URL: {
          URL.revokeObjectURL(message.url);
          sendResponse({ success: true });
          return;
        }
        default:
          sendResponse({ success: false, error: `Ação não reconhecida no offscreen: ${message.action}` });
      }
    } catch (err) {
      log.error('Erro no offscreen document:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});
