import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { ACTIONS } from '../shared/constants/actions.js';
import { StagingRepository } from '../shared/storage/staging-repository.js';
import { StorageClient } from '../shared/clients/storage-client.js';
import { inspectChatExport } from '../shared/archive/chat-export-inspector.js';
import { findWhatsAppTab } from '../shared/utils/whatsapp-tab.js';
import { Logger } from '../shared/utils/logger.js';
import { DownloadInterceptor } from './download-interceptor.js';
import { ExportCaptureRegistry, CAPTURE_ERROR_CODES } from './export-capture-registry.js';
import { ArchiveDownloader } from './archive-downloader.js';

const log = new Logger('ExtractionOrchestrator');

const RUN_STORAGE_KEY = 'extractionRun';
// Conversas grandes com mídia levam minutos para o WhatsApp gerar o arquivo
const CAPTURE_TIMEOUT_MS = 10 * 60 * 1000;
// Espera extra depois do prazo esgotado, com as duas fontes ainda armadas. O prazo já conta da última
// atividade, então um arquivo depois dele é raro, e a quarentena só custa nas conversas que o estouraram
const QUARANTINE_MS = 60 * 1000;
// Chamadas a APIs da extensão reiniciam o contador de inatividade do service worker
const KEEP_ALIVE_INTERVAL_MS = 20000;

const ACTIVE_STATES = [
  WORKFLOW_STATES.SCANNING,
  WORKFLOW_STATES.EXPORTING,
  WORKFLOW_STATES.WAITING_DOWNLOAD,
  WORKFLOW_STATES.PACKAGING
];

const RESULT_STATUS = Object.freeze({
  SAVED: 'saved',
  SAVED_TO_DISK: 'saved_to_disk',
  NOT_EXPORTABLE: 'not_exportable',
  FAILED: 'failed'
});

// Código lançado pelo content (DomUtils.ERROR_CODES em content/dom/dom-utils.js; content script
// clássico não é importável aqui) quando o menu não oferece "Exportar conversa". O próprio WhatsApp
// não exporta essa conversa, então ela é contada à parte e não como falha.
const NOT_EXPORTABLE_CODE = 'EXPORT_OPTION_UNAVAILABLE';

// Exportação vazia: o arquivo chegou e está no ZIP, mas o texto da conversa veio em branco. É um
// SAVED com `empty: true`, não um status próprio, para continuar contando como "no ZIP"
const EMPTY_EXPORT_LABEL = 'OK – VAZIA';

const LATE_FILE_NOTE = ' Chegou atrasado: o arquivo foi entregue na quarentena, depois do prazo de espera.';
// Um arquivo atrasado que chegue depois do clique em "Exportar" da conversa seguinte não se distingue do dela
const PREVIOUS_NOT_DELIVERED_NOTE = ' Conferir: a conversa anterior não entregou o arquivo.';

const UNEXPECTED_FILE_SOURCE_LABELS = Object.freeze({ page: 'página', download: 'chrome.downloads' });

class RunCancelledError extends Error {
  constructor() {
    super('Extração cancelada.');
    this.name = 'RunCancelledError';
  }
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Código de erro de uma resposta da aba ou de uma exceção. DOMException (ex: do IndexedDB) traz um
 * `code` numérico legado, que não é um código desta extensão.
 * @param {{ code?: unknown }|null|undefined} source
 * @returns {string|null}
 */
function errorCodeOf(source) {
  return typeof source?.code === 'string' ? source.code : null;
}

/**
 * ExtractionOrchestrator
 * Responsabilidade Única: Coordenação do ciclo de vida da fila de extração em lote,
 * aplicação de restrições de limites de conversas, controle de pausas e disparo
 * do empacotamento do arquivo consolidado.
 *
 * O estado da execução é persistido a cada conversa: o Chrome pode encerrar o service
 * worker no meio de execuções longas, e a execução volta como pausada para ser retomada.
 */
export class ExtractionOrchestrator {
  /**
   * @param {Object} [options]
   * @param {Object} [options.timings] Prazos em ms; os testes encurtam para não esperar os de produção
   * @param {number} [options.timings.captureTimeoutMs] Espera pelo arquivo exportado, contada da última atividade
   * @param {number} [options.timings.quarantineMs] Espera extra depois do prazo esgotado (quarentena)
   */
  constructor({ timings = {} } = {}) {
    this.timings = { captureTimeoutMs: CAPTURE_TIMEOUT_MS, quarantineMs: QUARANTINE_MS, ...timings };
    this.state = WORKFLOW_STATES.IDLE;
    this.isPaused = false;
    this.errorMessage = null;
    this.statusMessage = null;
    this.currentIndex = 0;
    this.currentChatTitle = '';

    /** @type {{ runId: string, tabId: number|null, options: Object, queue: Array, nextIndex: number, results: Array, unexpectedFiles: Array, startedAt: string }|null} */
    this.run = null;

    this.captures = new ExportCaptureRegistry();
    this.interceptor = new DownloadInterceptor({
      registry: this.captures,
      onUnexpectedFile: ({ filename }) => this.recordUnexpectedFile({ filename, source: 'download' })
    });

    /** @type {{ captureId: string, tabId: number, title: string }|null} Conversa em exportação agora */
    this._exportInProgress = null;
    this._activeState = WORKFLOW_STATES.IDLE;
    this._loopPromise = null;
    this._abortController = null;
    this._resumeResolver = null;
    this._keepAliveTimer = null;
  }

  /**
   * Indica se há um laço de execução rodando agora
   * @returns {boolean}
   */
  isBusy() {
    return Boolean(this._loopPromise);
  }

  /**
   * Reidrata a execução persistida após o service worker ser reiniciado
   */
  async restore() {
    const saved = await StorageClient.get(RUN_STORAGE_KEY, null);
    if (!saved) return;

    const { state, errorMessage, statusMessage, currentIndex, currentChatTitle, ...run } = saved;
    this.run = run;
    this.currentIndex = currentIndex || 0;
    this.currentChatTitle = currentChatTitle || '';

    const wasRunning = ACTIVE_STATES.includes(state) || state === WORKFLOW_STATES.PAUSED;
    if (!wasRunning) {
      this.state = state;
      this.errorMessage = errorMessage || null;
      this.statusMessage = statusMessage || null;
      return;
    }

    if (!run.queue?.length) {
      this.state = WORKFLOW_STATES.FAILED;
      this.errorMessage = 'A extração foi interrompida pelo navegador durante a descoberta de conversas. Inicie novamente.';
      return;
    }

    // Nada está rodando agora: a execução volta pausada para o usuário retomar
    this.isPaused = true;
    this.state = WORKFLOW_STATES.PAUSED;
    this._activeState = run.nextIndex >= run.queue.length ? WORKFLOW_STATES.PACKAGING : WORKFLOW_STATES.EXPORTING;
    this.statusMessage = state === WORKFLOW_STATES.PAUSED
      ? (statusMessage || 'Extração pausada.')
      : 'A extração foi interrompida pelo navegador. Clique em "Retomar" para continuar de onde parou.';
    log.info(`Execução ${run.runId} restaurada como pausada (${run.nextIndex}/${run.queue.length}).`);
  }

  /**
   * Retorna o estado atual da máquina de estados
   * @returns {Object}
   */
  getState() {
    const total = this.run?.queue?.length || 0;
    const processed = this.run?.nextIndex || 0;
    const results = (this.run?.results || []).filter(Boolean);
    return {
      state: this.state,
      current: this.currentIndex || processed,
      total,
      percentage: total > 0 ? Math.round((processed / total) * 100) : 0,
      currentChatTitle: this.currentChatTitle,
      errorMessage: this.errorMessage,
      statusMessage: this.statusMessage,
      summary: {
        saved: results.filter((r) => r.status === RESULT_STATUS.SAVED).length,
        empty: results.filter((r) => r.status === RESULT_STATUS.SAVED && r.empty).length,
        savedToDisk: results.filter((r) => r.status === RESULT_STATUS.SAVED_TO_DISK).length,
        notExportable: results.filter((r) => r.status === RESULT_STATUS.NOT_EXPORTABLE).length,
        failed: results.filter((r) => r.status === RESULT_STATUS.FAILED).length
      }
    };
  }

  /**
   * Notifica o popup e persiste o estado da execução
   * @private
   * @param {Object} [extra] Campos adicionais só para a notificação (ex: infoMessage, warningMessage)
   */
  _notifyProgress(extra = {}) {
    const payload = { ...this.getState(), ...extra };

    chrome.runtime.sendMessage({ action: ACTIONS.WORKFLOW_PROGRESS_UPDATE, ...payload }).catch(() => {
      // Popup fechado
    });

    if (this.run) {
      StorageClient.set({
        [RUN_STORAGE_KEY]: {
          ...this.run,
          state: this.state,
          errorMessage: this.errorMessage,
          statusMessage: this.statusMessage,
          currentIndex: this.currentIndex,
          currentChatTitle: this.currentChatTitle
        }
      });
    }
  }

  /**
   * Muda a fase ativa sem sobrescrever uma pausa pedida pelo usuário
   * @private
   */
  _setPhase(state) {
    this._activeState = state;
    if (!this.isPaused) this.state = state;
  }

  /**
   * Pausa o fluxo ao fim da conversa atual
   * @returns {boolean}
   */
  pause() {
    const pausable = [WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.EXPORTING, WORKFLOW_STATES.WAITING_DOWNLOAD];
    if (!this.isBusy() || this.isPaused || !pausable.includes(this._activeState)) return false;

    this.isPaused = true;
    this.state = WORKFLOW_STATES.PAUSED;
    this.statusMessage = 'Pausa solicitada: a extração para ao concluir a conversa atual.';
    log.info('Orquestrador pausado pelo usuário.');
    this._notifyProgress();
    return true;
  }

  /**
   * Retoma o fluxo pausado, inclusive uma execução restaurada após reinício do service worker
   * @returns {boolean}
   */
  resume() {
    if (!this.isPaused) return false;

    this.isPaused = false;
    this.state = this._activeState;
    this.statusMessage = null;
    log.info('Orquestrador retomado pelo usuário.');

    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    } else if (!this.isBusy() && this.run) {
      this._execute(async (signal) => {
        if (this.run.nextIndex < this.run.queue.length) {
          const tab = await this._prepareTab(this.run.tabId);
          this.run.tabId = tab.id;
        }
        await this._processQueue(signal);
      });
    }

    this._notifyProgress();
    return true;
  }

  /**
   * Cancela o fluxo de extração, interrompendo inclusive a etapa em andamento na aba
   */
  async cancel() {
    this.isPaused = false;
    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    }
    this._abortController?.abort();
    this.interceptor.disarm();

    if (this.run?.tabId != null) {
      chrome.tabs.sendMessage(this.run.tabId, { action: ACTIONS.CANCEL_CURRENT_OPERATION }).catch(() => {});
    }

    this.state = WORKFLOW_STATES.CANCELLED;
    this._activeState = WORKFLOW_STATES.CANCELLED;
    this.statusMessage = 'Extração cancelada.';
    log.info('Orquestrador cancelado pelo usuário.');
    this._notifyProgress();
  }

  /**
   * Arma o interceptor de downloads para a conversa em exportação. A aba chama isto (EXPORT_CAPTURE_ARMED)
   * imediatamente antes de clicar em "Exportar", e só arma a sua captura depois desta resposta: até lá
   * nenhuma das duas fontes está armada, e um arquivo atrasado da conversa anterior não é tomado como desta.
   * @param {{ captureId: string, tabId: number }} params
   * @returns {{ success: boolean, error?: string }}
   */
  armCapture({ captureId, tabId }) {
    const current = this._exportInProgress;
    if (!current || current.captureId !== captureId) {
      return { success: false, error: 'A captura não é a da conversa em exportação (concluída, cancelada ou de outra execução).' };
    }
    if (current.tabId !== tabId) {
      return { success: false, error: 'O aviso veio de outra aba, não da que está exportando a conversa.' };
    }
    this.interceptor.arm({ captureId, tabId });
    log.info(`Captura ${captureId} armada para "${current.title}".`);
    return { success: true };
  }

  /**
   * Registra um arquivo de exportação do WhatsApp que chegou sem captura armada (antes do clique em
   * "Exportar" da conversa atual ou entre conversas). Ele não é salvo: o download segue para a pasta
   * Downloads, e o relatório o lista. Fora de uma execução em andamento é um download do próprio
   * usuário, e é ignorado.
   * @param {{ filename: string|null, source: 'page'|'download' }} params
   * @returns {{ success: boolean, recorded: boolean }}
   */
  recordUnexpectedFile({ filename, source }) {
    if (!this.isBusy() || !this.run) return { success: true, recorded: false };

    const entry = {
      at: new Date().toISOString(),
      filename: typeof filename === 'string' && filename ? filename : null,
      source,
      duringChat: this._exportInProgress?.title ?? null
    };
    // Uma execução gravada por uma versão anterior da extensão e retomada agora não tem a lista
    (this.run.unexpectedFiles ??= []).push(entry);
    log.warn(`Arquivo recebido fora de hora (${UNEXPECTED_FILE_SOURCE_LABELS[source]}): ${entry.filename ?? '(nome ainda não definido)'}`);
    this._notifyProgress({
      warningMessage: `⚠️ Arquivo recebido fora de hora (${this._describeUnexpectedFile(entry)}): não foi salvo no ZIP e seguiu para a pasta Downloads.`
    });
    return { success: true, recorded: true };
  }

  /**
   * @private
   * @param {{ filename: string|null, source: string, duringChat: string|null }} entry
   * @returns {string}
   */
  _describeUnexpectedFile({ filename, source, duringChat }) {
    const name = filename ? `"${filename}"` : 'nome ainda não definido pelo Chrome';
    const moment = duringChat ? `durante "${duringChat}"` : 'entre conversas';
    return `${UNEXPECTED_FILE_SOURCE_LABELS[source]}, ${name}, ${moment}`;
  }

  /**
   * Inicia o fluxo completo de extração em lote
   * @param {Object} options
   * @param {number|null} [options.maxChats=null] Limite máximo de chats (para testes)
   * @param {boolean} [options.downloadAll=true] Se true, desconsidera maxChats e extrai todos
   * @param {number} [options.safeDelayMs=2000] Intervalo base entre conversas (recebe variação aleatória de até +50%)
   * @returns {Promise<void>}
   */
  async start({ maxChats = null, downloadAll = true, safeDelayMs = 2000 } = {}) {
    if (this.isBusy()) {
      throw new Error('Já existe uma extração em andamento.');
    }

    // Uma execução pausada ou interrompida anterior é descartada ao iniciar outra
    this.isPaused = false;
    this.errorMessage = null;
    this.statusMessage = null;
    this.currentIndex = 0;
    this.currentChatTitle = '';
    this.run = {
      runId: Date.now().toString(36),
      tabId: null,
      options: { maxChats, downloadAll, safeDelayMs },
      queue: [],
      nextIndex: 0,
      results: [],
      unexpectedFiles: [],
      startedAt: new Date().toISOString()
    };

    return this._execute(async (signal) => {
      await StagingRepository.clear();
      const tab = await this._prepareTab();
      this.run.tabId = tab.id;
      await this._scan(signal);
      await this._processQueue(signal);
    });
  }

  /**
   * Executa o corpo da execução com cancelamento, keepalive e tratamento de erro únicos
   * @private
   * @param {function(AbortSignal): Promise<void>} body
   * @returns {Promise<void>}
   */
  _execute(body) {
    const controller = new AbortController();
    this._abortController = controller;
    this._startKeepAlive();

    this._loopPromise = (async () => {
      try {
        await body(controller.signal);
      } catch (err) {
        if (err instanceof RunCancelledError || controller.signal.aborted) {
          this.state = WORKFLOW_STATES.CANCELLED;
          this.statusMessage = 'Extração cancelada.';
        } else {
          log.error('Erro crítico no fluxo do orquestrador:', err);
          this.state = WORKFLOW_STATES.FAILED;
          this.errorMessage = err.message;
        }
        this._activeState = this.state;
        this.isPaused = false;
        this._notifyProgress();
      } finally {
        this.interceptor.stopListening();
        this._stopKeepAlive();
        this._abortController = null;
        this._loopPromise = null;
      }
    })();

    return this._loopPromise;
  }

  /** @private */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  /** @private */
  _stopKeepAlive() {
    clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }

  /**
   * @private
   * @param {AbortSignal} signal
   */
  async _waitResumeIfPaused(signal) {
    while (this.isPaused && !signal.aborted) {
      await new Promise((resolve) => {
        this._resumeResolver = resolve;
      });
    }
    if (signal.aborted) throw new RunCancelledError();
  }

  /**
   * Pausa interrompível pelo cancelamento
   * @private
   */
  _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new RunCancelledError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(new RunCancelledError());
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Envia uma mensagem à aba sem ficar preso a ela quando a execução é cancelada
   * @private
   */
  _sendToTab(tabId, message, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RunCancelledError());
      const onAbort = () => reject(new RunCancelledError());
      signal?.addEventListener('abort', onAbort, { once: true });
      chrome.tabs.sendMessage(tabId, message)
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener('abort', onAbort));
    });
  }

  /**
   * @private
   * @returns {Promise<Object|null>}
   */
  async _pingTab(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { action: ACTIONS.CHECK_PAGE_READY });
    } catch (_) {
      return null;
    }
  }

  /**
   * Localiza a aba do WhatsApp e garante que o content script responde. Após recarregar
   * a extensão, a aba já aberta fica sem content script até ser recarregada, então ele é reinjetado.
   * @private
   * @param {number|null} [preferredTabId=null]
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async _prepareTab(preferredTabId = null) {
    const tab = await findWhatsAppTab({ preferredTabId });
    if (!tab?.id) {
      throw new Error('Nenhuma aba do WhatsApp Web aberta encontrada.');
    }

    let status = await this._pingTab(tab.id);
    if (!status) {
      log.info(`Content script ausente na aba ${tab.id}; reinjetando...`);
      const files = chrome.runtime.getManifest().content_scripts?.[0]?.js || [];
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
      status = await this._pingTab(tab.id);
    }

    if (!status) {
      throw new Error('Não foi possível comunicar com a aba do WhatsApp Web. Recarregue a página e tente novamente.');
    }
    if (!status.ready) {
      throw new Error('O WhatsApp Web ainda não está pronto (carregando ou aguardando a leitura do QR Code).');
    }
    return tab;
  }

  /**
   * FASE DE DESCOBERTA (SCANNING)
   * @private
   * @param {AbortSignal} signal
   */
  async _scan(signal) {
    const { tabId, options } = this.run;
    this._setPhase(WORKFLOW_STATES.SCANNING);
    this._notifyProgress();
    log.info(`Iniciando escaneamento de chats na aba ${tabId}...`);

    const limit = !options.downloadAll && options.maxChats > 0 ? options.maxChats : null;
    const response = await this._sendToTab(tabId, { action: ACTIONS.SCAN_CHATS_REQUEST, maxLimit: limit }, signal);
    if (!response?.success || !Array.isArray(response.chats)) {
      if (response?.cancelled && signal.aborted) throw new RunCancelledError();
      throw new Error(response?.error || 'Falha ao escanear conversas no WhatsApp Web.');
    }

    const chats = limit ? response.chats.slice(0, limit) : response.chats;
    this.run.queue = chats.map(({ id, title, duplicateTitle }) => ({ id, title, duplicateTitle: Boolean(duplicateTitle) }));
    log.info(`Fila montada com ${this.run.queue.length} conversas para exportação.`);
    this._notifyProgress();
  }

  /**
   * FASE DE EXPORTAÇÃO SEQUENCIAL, seguida do empacotamento
   * @private
   * @param {AbortSignal} signal
   */
  async _processQueue(signal) {
    const { queue, options } = this.run;

    if (queue.length === 0) {
      this._setPhase(WORKFLOW_STATES.COMPLETED);
      this.statusMessage = 'Nenhuma conversa encontrada para exportar.';
      this._notifyProgress();
      return;
    }

    this.interceptor.startListening();

    while (this.run.nextIndex < queue.length) {
      await this._waitResumeIfPaused(signal);

      const index = this.run.nextIndex;
      const chat = queue[index];
      this.currentIndex = index + 1;
      this.currentChatTitle = chat.title;
      this._setPhase(WORKFLOW_STATES.EXPORTING);
      this._notifyProgress();
      log.info(`[${index + 1}/${queue.length}] Exportando conversa "${chat.title}"...`);

      const result = await this._exportChat(chat, index, signal);
      this.run.results[index] = result;
      this.run.nextIndex = index + 1;

      const prefix = `[${index + 1}/${queue.length}]`;
      if (result.status === RESULT_STATUS.FAILED) {
        this._notifyProgress({ warningMessage: `${prefix} ⚠️ ${result.message}` });
      } else if (result.status === RESULT_STATUS.NOT_EXPORTABLE) {
        this._notifyProgress({ warningMessage: `${prefix} ⚠️ [NÃO EXPORTÁVEL] ${result.message}` });
      } else if (result.empty) {
        this._notifyProgress({ warningMessage: `${prefix} ⚠️ [${EMPTY_EXPORT_LABEL}] ${result.message}` });
      } else {
        this._notifyProgress({ infoMessage: `${prefix} ✅ ${result.message}` });
      }

      if (this.run.nextIndex < queue.length) {
        // Variação aleatória para o ritmo não ser perfeitamente regular
        const delay = Math.round(options.safeDelayMs * (1 + Math.random() * 0.5));
        await this._sleep(delay, signal);
      }
    }

    this.interceptor.stopListening();
    await this._packageAndDownload(signal);
  }

  /**
   * Exporta uma conversa: dispara a exportação na aba e aguarda o arquivo pela página ou pelo download.
   * `code` é o código do erro (null sem erro ou sem código conhecido); `via` diz como a aba abriu a
   * conversa (null se a aba não chegou a confirmar a exportação); `staged` diz se o arquivo foi
   * gravado no staging; `late` diz se ele só chegou na quarentena. Uma conversa salva traz também o
   * resultado da inspeção do texto (`empty`, contagens e datas, null se o conteúdo não foi inspecionado,
   * com o motivo em `inspectionError`).
   * @private
   * @returns {Promise<{ title: string, status: string, code: string|null, via: string|null, staged: boolean, late: boolean, message: string, size?: number }>}
   */
  async _exportChat(chat, index, signal) {
    const { runId, tabId } = this.run;
    const captureId = `${runId}-${index}`;
    let via = null;
    let late = false;
    const failed = (message, code) => ({
      title: chat.title,
      status: code === NOT_EXPORTABLE_CODE ? RESULT_STATUS.NOT_EXPORTABLE : RESULT_STATUS.FAILED,
      code,
      via,
      staged: false,
      late: false,
      message: `"${chat.title}": ${message}`
    });

    // As duas fontes só são armadas quando a aba avisa que vai clicar em "Exportar" (armCapture)
    this.captures.expect(captureId);
    this._exportInProgress = { captureId, tabId, title: chat.title };

    try {
      const trigger = await this._sendToTab(tabId, { action: ACTIONS.EXPORT_CHAT_REQUEST, chat, captureId }, signal);
      if (!trigger?.success) {
        if (trigger?.cancelled && signal.aborted) throw new RunCancelledError();
        return failed(trigger?.error || 'erro desconhecido na página.', errorCodeOf(trigger));
      }
      via = trigger.via ?? null;

      this._setPhase(WORKFLOW_STATES.WAITING_DOWNLOAD);
      this._notifyProgress();
      let captured;
      try {
        captured = await this.captures.waitFor(captureId, { timeoutMs: this.timings.captureTimeoutMs, signal });
      } catch (err) {
        if (errorCodeOf(err) !== CAPTURE_ERROR_CODES.FILE_NOT_DELIVERED) throw err;
        // O registry apagou a captura ao esgotar o prazo. Registrá-la de novo sem nenhum await no meio
        // não deixa brecha para o arquivo atrasado chegar e ser recusado como captura não esperada
        this.captures.expect(captureId);
        captured = await this._waitInQuarantine(chat, captureId, err, signal);
        late = true;
      }
      const lateNote = late ? LATE_FILE_NOTE : '';

      if (captured.savedToDisk) {
        return {
          title: chat.title,
          status: RESULT_STATUS.SAVED_TO_DISK,
          code: null,
          via,
          staged: false,
          late,
          message: `"${chat.title}" foi baixado direto para a pasta Downloads (${captured.filename}) e não está no ZIP.${lateNote}`
        };
      }

      const { inspection, inspectionError } = await this._inspectExport(chat, captured.blob);

      await StagingRepository.saveChatFile({
        chatId: String(index).padStart(6, '0'),
        chatTitle: chat.title,
        filename: captured.filename,
        blob: captured.blob
      });

      const details = [formatSize(captured.blob.size)];
      if (inspection?.omittedMediaCount > 0) details.push(`${inspection.omittedMediaCount} anexo(s) omitido(s)`);
      const formatUnrecognized = Boolean(inspection) && !inspection.isEmpty && inspection.messageCount === null;
      const inspectionNote = inspectionError
        ? ` Conteúdo não inspecionado: ${inspectionError}`
        : formatUnrecognized ? ' Formato do texto não reconhecido: mensagens e anexos não contados.' : '';
      const homonymNote = chat.duplicateTitle ? ' Atenção: existe outra conversa com o mesmo nome, que não foi exportada.' : '';
      return {
        title: chat.title,
        status: RESULT_STATUS.SAVED,
        code: null,
        via,
        staged: true,
        late,
        size: captured.blob.size,
        empty: inspection?.isEmpty === true,
        inspectionError,
        messageCount: inspection?.messageCount ?? null,
        systemEventCount: inspection?.systemEventCount ?? null,
        omittedMediaCount: inspection?.omittedMediaCount ?? null,
        firstTimestamp: inspection?.firstTimestamp ?? null,
        lastTimestamp: inspection?.lastTimestamp ?? null,
        message: `"${chat.title}" salvo (${details.join(', ')}).${inspectionNote}${homonymNote}${lateNote}`
      };
    } catch (err) {
      if (err instanceof RunCancelledError || signal.aborted) throw new RunCancelledError();
      log.warn(`Falha na conversa "${chat.title}":`, err);
      return failed(err.message, errorCodeOf(err));
    } finally {
      this._exportInProgress = null;
      this.captures.discard(captureId);
      this.interceptor.disarm();
      chrome.tabs.sendMessage(tabId, { action: ACTIONS.DISARM_EXPORT_CAPTURE, captureId }).catch(() => {});
    }
  }

  /**
   * Quarentena: depois do prazo esgotado, espera mais `quarantineMs` com as duas fontes ainda armadas.
   * Um arquivo que chegue aqui é desta conversa, porque a seguinte ainda não clicou em "Exportar". Se o
   * prazo da quarentena também esgotar, vale a falha do prazo original.
   * @private
   * @param {{ title: string }} chat
   * @param {string} captureId Já registrada de novo no registry
   * @param {Error} notDelivered A falha FILE_NOT_DELIVERED do prazo original
   * @param {AbortSignal} signal
   */
  async _waitInQuarantine(chat, captureId, notDelivered, signal) {
    log.warn(`"${chat.title}": prazo esgotado; aguardando o arquivo por mais ${this.timings.quarantineMs} ms (quarentena).`);
    try {
      return await this.captures.waitFor(captureId, { timeoutMs: this.timings.quarantineMs, signal });
    } catch (err) {
      throw errorCodeOf(err) === CAPTURE_ERROR_CODES.FILE_NOT_DELIVERED ? notDelivered : err;
    }
  }

  /**
   * Inspeciona o texto do arquivo capturado. Uma falha aqui não impede salvar a conversa: o arquivo
   * chegou e vai para o ZIP, e a falha fica no log e no resultado ("conteúdo não inspecionado").
   * @private
   * @returns {Promise<{ inspection: import('../shared/archive/chat-export-inspector.js').ChatExportInspection|null, inspectionError: string|null }>}
   */
  async _inspectExport(chat, blob) {
    try {
      return { inspection: await inspectChatExport(blob), inspectionError: null };
    } catch (err) {
      log.warn(`Conteúdo de "${chat.title}" não inspecionado; a conversa é salva mesmo assim:`, err);
      return { inspection: null, inspectionError: err.message };
    }
  }

  /**
   * Relatório gravado na raiz do ZIP com o status de cada conversa
   * @private
   * @returns {string}
   */
  _buildReport() {
    const { queue, results, options, startedAt } = this.run;
    const summary = this.getState().summary;
    const labels = {
      [RESULT_STATUS.SAVED]: 'OK',
      [RESULT_STATUS.SAVED_TO_DISK]: 'NA PASTA DOWNLOADS',
      [RESULT_STATUS.NOT_EXPORTABLE]: 'NÃO EXPORTÁVEL',
      [RESULT_STATUS.FAILED]: 'FALHA'
    };
    const omittedMedia = results.reduce((total, result) => total + (result?.omittedMediaCount ?? 0), 0);
    // Conversa salva sem contagem (não inspecionada ou formato não reconhecido) deixa o total abaixo do real
    const uncounted = results.filter((result) => result?.staged && !result.empty && result.omittedMediaCount == null).length;
    const partialNote = uncounted ? `; total parcial: ${uncounted} conversa(s) sem contagem` : '';

    const lines = [
      'Relatório de extração - WhatsApp Web Extractor',
      `Início: ${new Date(startedAt).toLocaleString('pt-BR')}`,
      `Geração do ZIP: ${new Date().toLocaleString('pt-BR')}`,
      // A varredura (chat-list-scanner.js) percorre só a lista principal e não abre "Arquivadas"
      `Modo: ${options.downloadAll ? 'lista principal (arquivadas não incluídas)' : `limite de ${options.maxChats} conversa(s)`}`,
      'Conteúdo: somente texto; o WhatsApp Web exporta sem mídia, e os anexos aparecem como marcadores ' +
        `(${omittedMedia} anexo(s) omitido(s) nesta execução${partialNote}).`,
      `Conversas na fila: ${queue.length} | no ZIP: ${summary.saved} (vazias: ${summary.empty}) | ` +
        `na pasta Downloads: ${summary.savedToDisk} | não exportáveis: ${summary.notExportable} | falhas: ${summary.failed}`,
      ''
    ];
    queue.forEach((chat, i) => {
      const result = results[i];
      if (!result) {
        lines.push(`[NÃO PROCESSADA] ${i + 1}. "${chat.title}"`);
        return;
      }
      const gotFile = result.status === RESULT_STATUS.SAVED || result.status === RESULT_STATUS.SAVED_TO_DISK;
      const checkNote = gotFile && results[i - 1]?.code === CAPTURE_ERROR_CODES.FILE_NOT_DELIVERED ? PREVIOUS_NOT_DELIVERED_NOTE : '';
      lines.push(`[${result.empty ? EMPTY_EXPORT_LABEL : labels[result.status]}] ${i + 1}. ${result.message}${checkNote}`);
    });

    const unexpectedFiles = this.run.unexpectedFiles ?? [];
    if (unexpectedFiles.length) {
      lines.push(
        '',
        `Arquivos recebidos fora de hora (${unexpectedFiles.length}): chegaram sem captura armada, não estão no ZIP ` +
          'e o download seguiu para a pasta Downloads. O mesmo arquivo pode aparecer uma vez por fonte (página e chrome.downloads).'
      );
      for (const entry of unexpectedFiles) {
        lines.push(`- ${new Date(entry.at).toLocaleString('pt-BR')}: ${this._describeUnexpectedFile(entry)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /**
   * FASE DE EMPACOTAMENTO (PACKAGING) e download único do ZIP master
   * @private
   * @param {AbortSignal} signal
   */
  async _packageAndDownload(signal) {
    this._setPhase(WORKFLOW_STATES.PACKAGING);
    this.currentChatTitle = '';
    this._notifyProgress({ infoMessage: 'Empacotando conversas no ZIP consolidado...' });

    const { summary } = this.getState();
    if (summary.saved === 0) {
      throw new Error('Nenhuma conversa foi salva durante a extração; não há o que empacotar.');
    }

    const archiveFilename = `whatsapp_backup_${new Date().toISOString().slice(0, 10)}.zip`;
    const outcome = await ArchiveDownloader.buildAndDownload({ archiveFilename, report: this._buildReport(), signal });

    if (!outcome.completed) {
      // Mantém o staging: o usuário pode gerar o download de novo sem refazer as exportações
      this.isPaused = true;
      this.state = WORKFLOW_STATES.PAUSED;
      this.statusMessage = `O download do ZIP não foi concluído (${outcome.error}). Clique em "Retomar" para gerar o download novamente.`;
      this._notifyProgress({ warningMessage: this.statusMessage });
      return;
    }

    // O ZIP já foi salvo: uma falha na limpeza não invalida a execução
    await StagingRepository.clear().catch((err) => log.warn('Falha ao limpar o staging após o download:', err));
    this._setPhase(WORKFLOW_STATES.COMPLETED);
    this.currentChatTitle = 'Concluído';
    const inZip = `${summary.saved} conversa(s) no ZIP` + (summary.empty ? ` (${summary.empty} vazia(s))` : '');
    const counts = [inZip, `${summary.failed} falha(s)`];
    if (summary.notExportable) counts.push(`${summary.notExportable} não exportável(is)`);
    if (summary.savedToDisk) counts.push(`${summary.savedToDisk} baixada(s) direto na pasta Downloads`);
    this.statusMessage = `Backup salvo: ${archiveFilename} (${formatSize(outcome.size)}). ${counts.join(', ')}.`;
    log.info('Fluxo de extração em lote concluído com sucesso!');
    this._notifyProgress({ infoMessage: `🎉 ${this.statusMessage}` });
  }
}
