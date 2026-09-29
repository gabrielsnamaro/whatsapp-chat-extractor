import { ACTIONS } from '../shared/constants/actions.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('ExportCaptureRegistry');

export class CaptureCancelledError extends Error {
  constructor(message = 'Captura cancelada.') {
    super(message);
    this.name = 'CaptureCancelledError';
  }
}

function base64ToBytes(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    return Uint8Array.fromBase64(base64);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * ExportCaptureRegistry
 * Responsabilidade Única: Receber, por captureId, o arquivo exportado de uma conversa
 * (em blocos base64 vindos do content script, ou o aviso de que foi salvo direto em disco)
 * e entregá-lo a quem o aguarda.
 *
 * O arquivo chega em blocos porque mensagens de extensão são serializadas em JSON e têm
 * limite de 64 MiB; como array de números, uma exportação com mídia de ~15 MB já estourava.
 */
export class ExportCaptureRegistry {
  constructor() {
    this._captures = new Map();
  }

  /**
   * Registra que um arquivo é esperado para este captureId. Transferências de ids não
   * esperados (ex: de uma execução anterior) são recusadas.
   * @param {string} captureId
   */
  expect(captureId) {
    this._captures.set(captureId, { id: captureId, transfer: null, result: null, error: null, waiter: null, timer: null, timeoutMs: 0 });
  }

  /**
   * Descarta a captura, rejeitando quem estiver aguardando
   * @param {string} captureId
   */
  discard(captureId) {
    const capture = this._captures.get(captureId);
    if (!capture) return;
    this._captures.delete(captureId);
    capture.waiter?.reject(new CaptureCancelledError());
  }

  /**
   * Trata as mensagens EXPORT_TRANSFER_* do content script
   * @param {Object} message
   * @returns {{ success: boolean, error?: string }}
   */
  handleTransferMessage(message) {
    const capture = this._captures.get(message.captureId);
    if (!capture) {
      return { success: false, error: 'Captura não esperada (concluída, descartada ou de uma execução anterior).' };
    }

    switch (message.action) {
      case ACTIONS.EXPORT_TRANSFER_START: {
        if (capture.result) {
          return { success: false, error: 'O arquivo desta captura já foi recebido.' };
        }
        const totalChunks = Number(message.totalChunks);
        if (!Number.isInteger(totalChunks) || totalChunks < 1) {
          return { success: false, error: 'Quantidade de blocos inválida.' };
        }
        capture.transfer = {
          filename: message.filename || 'conversa.txt',
          mimeType: message.mimeType || '',
          size: Number(message.size) || 0,
          source: message.source || 'page',
          chunks: new Array(totalChunks),
          received: 0
        };
        this._touch(capture);
        log.info(`Recebendo "${capture.transfer.filename}" (${(capture.transfer.size / 1024).toFixed(1)} KB, ${totalChunks} bloco(s))...`);
        return { success: true };
      }

      case ACTIONS.EXPORT_TRANSFER_CHUNK: {
        const transfer = capture.transfer;
        const index = Number(message.index);
        if (!transfer || !Number.isInteger(index) || index < 0 || index >= transfer.chunks.length) {
          return { success: false, error: 'Bloco fora de ordem ou transferência não iniciada.' };
        }
        if (!transfer.chunks[index]) transfer.received++;
        transfer.chunks[index] = base64ToBytes(message.data || '');
        this._touch(capture);
        return { success: true };
      }

      case ACTIONS.EXPORT_TRANSFER_END: {
        const transfer = capture.transfer;
        if (!transfer || transfer.received !== transfer.chunks.length) {
          return { success: false, error: 'Transferência incompleta.' };
        }
        const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
        if (transfer.size && blob.size !== transfer.size) {
          this._fail(message.captureId, new Error(`Arquivo recebido com ${blob.size} bytes; esperados ${transfer.size}.`));
          return { success: false, error: 'Tamanho do arquivo recebido não confere.' };
        }
        this._settle(message.captureId, { filename: transfer.filename, blob, source: transfer.source });
        return { success: true };
      }

      case ACTIONS.EXPORT_TRANSFER_FAILED:
        this._fail(message.captureId, new Error(message.error || 'Falha ao ler o arquivo exportado na página.'));
        return { success: true };

      default:
        return { success: false, error: `Ação de transferência desconhecida: ${message.action}` };
    }
  }

  /**
   * O download nativo não pôde ser lido pela aba e seguiu para a pasta Downloads
   * @param {string} captureId
   * @param {{ filename: string, downloadId: number }} info
   */
  resolveSavedToDisk(captureId, { filename, downloadId }) {
    if (!this._captures.has(captureId)) return;
    this._settle(captureId, { savedToDisk: true, filename, downloadId, source: 'download' });
  }

  /**
   * Aguarda o arquivo da captura. O prazo conta a partir da última atividade:
   * enquanto blocos estiverem chegando, a espera não expira.
   * @param {string} captureId
   * @param {Object} options
   * @param {number} options.timeoutMs
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{ filename: string, blob?: Blob, savedToDisk?: boolean, downloadId?: number, source: string }>}
   */
  waitFor(captureId, { timeoutMs, signal }) {
    const capture = this._captures.get(captureId);
    if (!capture) return Promise.reject(new Error('Captura não registrada.'));
    if (capture.result) {
      this._captures.delete(captureId);
      return Promise.resolve(capture.result);
    }
    if (capture.error) {
      this._captures.delete(captureId);
      return Promise.reject(capture.error);
    }
    if (signal?.aborted) return Promise.reject(new CaptureCancelledError());

    return new Promise((resolve, reject) => {
      const onAbort = () => this.discard(captureId);
      const cleanup = () => {
        clearTimeout(capture.timer);
        signal?.removeEventListener('abort', onAbort);
      };
      capture.timeoutMs = timeoutMs;
      capture.waiter = {
        resolve: (value) => { cleanup(); resolve(value); },
        reject: (err) => { cleanup(); reject(err); }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this._touch(capture);
    });
  }

  /**
   * Reinicia o prazo de espera a cada atividade da captura
   * @private
   */
  _touch(capture) {
    if (!capture.waiter || !capture.timeoutMs) return;
    clearTimeout(capture.timer);
    capture.timer = setTimeout(() => {
      const minutes = Math.round(capture.timeoutMs / 60000);
      this._fail(capture.id, new Error(`O WhatsApp Web não entregou o arquivo exportado em ${minutes} min.`));
    }, capture.timeoutMs);
  }

  /** @private */
  _settle(captureId, result) {
    const capture = this._captures.get(captureId);
    if (!capture) return;
    if (capture.waiter) {
      this._captures.delete(captureId);
      capture.waiter.resolve(result);
    } else {
      capture.result = result;
    }
  }

  /** @private */
  _fail(captureId, error) {
    const capture = this._captures.get(captureId);
    if (!capture) return;
    if (capture.waiter) {
      this._captures.delete(captureId);
      capture.waiter.reject(error);
    } else {
      capture.error = error;
    }
  }
}
