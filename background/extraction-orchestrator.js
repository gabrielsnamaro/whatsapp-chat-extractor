import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { ACTIONS } from '../shared/constants/actions.js';
import { StagingRepository } from '../shared/storage/staging-repository.js';
import { ZipBuilder } from '../shared/archive/zip-builder.js';
import { DownloadInterceptor } from './download-interceptor.js';
import { StorageClient } from '../shared/clients/storage-client.js';
import { Logger } from '../shared/utils/logger.js';

const log = new Logger('ExtractionOrchestrator');

/**
 * ExtractionOrchestrator
 * Responsabilidade Única: Coordenação do ciclo de vida da fila de extração em lote,
 * aplicação de restrições de limites de conversas, controle de pausas e disparo
 * do empacotamento do arquivo consolidado.
 */
export class ExtractionOrchestrator {
  constructor() {
    this.state = WORKFLOW_STATES.IDLE;
    this.chatsQueue = [];
    this.currentIndex = 0;
    this.totalChats = 0;
    this.currentChatTitle = '';
    this.isPaused = false;
    this.isCancelled = false;
    this.errorMessage = null;

    this.interceptor = new DownloadInterceptor();
    this._resumeResolver = null;
  }

  /**
   * Helper utilitário para pausas assíncronas
   * @private
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Localiza a aba aberta do WhatsApp Web
   * @private
   * @returns {Promise<chrome.tabs.Tab|null>}
   */
  async _findWhatsAppTab() {
    const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
    return tabs && tabs.length > 0 ? tabs[0] : null;
  }

  /**
   * Notifica a extensão (popup e logs) sobre atualizações de progresso
   * @private
   */
  _notifyProgress(extra = {}) {
    const payload = {
      state: this.state,
      current: this.currentIndex,
      total: this.totalChats,
      percentage: this.totalChats > 0 ? Math.round((this.currentIndex / this.totalChats) * 100) : 0,
      currentChatTitle: this.currentChatTitle,
      errorMessage: this.errorMessage,
      ...extra
    };

    try {
      chrome.runtime.sendMessage({
        action: ACTIONS.WORKFLOW_PROGRESS_UPDATE,
        ...payload
      }).catch(() => {
        // Ignora erro se popup não estiver aberto no momento
      });
    } catch (_) {}

    // Persiste também o estado no StorageClient para recuperação ao reabrir popup
    StorageClient.set({ extractorWorkflowState: payload });
  }

  /**
   * Retorna o estado atual da máquina de estados
   * @returns {Object}
   */
  getState() {
    return {
      state: this.state,
      current: this.currentIndex,
      total: this.totalChats,
      percentage: this.totalChats > 0 ? Math.round((this.currentIndex / this.totalChats) * 100) : 0,
      currentChatTitle: this.currentChatTitle,
      errorMessage: this.errorMessage
    };
  }

  /**
   * Pausa o fluxo de extração em andamento
   */
  pause() {
    if (this.state === WORKFLOW_STATES.EXPORTING || this.state === WORKFLOW_STATES.SCANNING) {
      this.isPaused = true;
      this.state = WORKFLOW_STATES.PAUSED;
      log.info('Orquestrador pausado pelo usuário.');
      this._notifyProgress();
    }
  }

  /**
   * Retoma o fluxo de extração pausado
   */
  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.state = WORKFLOW_STATES.EXPORTING;
      log.info('Orquestrador retomado pelo usuário.');
      if (this._resumeResolver) {
        this._resumeResolver();
        this._resumeResolver = null;
      }
      this._notifyProgress();
    }
  }

  /**
   * Cancela o fluxo de extração
   */
  cancel() {
    this.isCancelled = true;
    this.isPaused = false;
    this.state = WORKFLOW_STATES.CANCELLED;
    this.interceptor.stopListening();
    if (this._resumeResolver) {
      this._resumeResolver();
      this._resumeResolver = null;
    }
    log.info('Orquestrador cancelado pelo usuário.');
    this._notifyProgress();
  }

  /**
   * Aguarda caso o orquestrador esteja em pausa
   * @private
   */
  async _waitResumeIfPaused() {
    while (this.isPaused && !this.isCancelled) {
      await new Promise((resolve) => {
        this._resumeResolver = resolve;
      });
    }
  }

  /**
   * Converte Uint8Array para Data URL para acionar download no Service Worker
   * @private
   * @param {Uint8Array} bytes
   * @param {string} mimeType
   * @returns {string}
   */
  _uint8ArrayToDataUrl(bytes, mimeType = 'application/zip') {
    let binary = '';
    const len = bytes.byteLength;
    const chunkSize = 0x8000;
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  }

  /**
   * Inicia o fluxo completo de extração em lote
   * @param {Object} options
   * @param {number|null} [options.maxChats=null] Limite máximo de chats (para testes)
   * @param {boolean} [options.downloadAll=true] Se true, desconsidera maxChats e extrai todos
   * @param {number} [options.safeDelayMs=2000] Intervalo de segurança anti-ban entre conversas
   * @returns {Promise<Object>}
   */
  async start({ maxChats = null, downloadAll = true, safeDelayMs = 2000 } = {}) {
    if (this.state !== WORKFLOW_STATES.IDLE && this.state !== WORKFLOW_STATES.COMPLETED && this.state !== WORKFLOW_STATES.FAILED && this.state !== WORKFLOW_STATES.CANCELLED) {
      throw new Error(`Orquestrador já em execução no estado ${this.state}`);
    }

    this.isPaused = false;
    this.isCancelled = false;
    this.errorMessage = null;
    this.currentIndex = 0;
    this.chatsQueue = [];

    // Limpa o staging anterior antes de começar um novo lote
    await StagingRepository.clear();

    const tab = await this._findWhatsAppTab();
    if (!tab || !tab.id) {
      this.state = WORKFLOW_STATES.FAILED;
      this.errorMessage = 'Nenhuma aba do WhatsApp Web aberta encontrada.';
      this._notifyProgress();
      throw new Error(this.errorMessage);
    }

    try {
      // 1. FASE DE DESCOBERTA (SCANNING)
      this.state = WORKFLOW_STATES.SCANNING;
      this._notifyProgress();
      log.info(`Iniciando escaneamento de chats na aba ${tab.id}...`);

      const scanLimit = downloadAll ? null : maxChats;
      const scanResponse = await chrome.tabs.sendMessage(tab.id, {
        action: ACTIONS.SCAN_CHATS_REQUEST,
        maxLimit: scanLimit
      });

      if (!scanResponse || !scanResponse.success || !Array.isArray(scanResponse.chats)) {
        throw new Error(scanResponse?.error || 'Falha ao escanear conversas no WhatsApp Web.');
      }

      let chats = scanResponse.chats;
      if (!downloadAll && maxChats && maxChats > 0) {
        chats = chats.slice(0, maxChats);
      }

      this.chatsQueue = chats;
      this.totalChats = chats.length;
      log.info(`Fila montada com ${this.totalChats} conversas para exportação.`);

      if (this.totalChats === 0) {
        this.state = WORKFLOW_STATES.COMPLETED;
        this._notifyProgress();
        return { success: true, count: 0 };
      }

      // 2. ATIVA INTERCEPTADOR DE DOWNLOADS
      this.interceptor.startListening();

      // 3. FASE DE EXPORTAÇÃO SEQUENCIAL
      this.state = WORKFLOW_STATES.EXPORTING;

      for (let i = 0; i < this.chatsQueue.length; i++) {
        if (this.isCancelled) {
          log.info('Fluxo cancelado durante a fila.');
          return { success: false, cancelled: true };
        }

        await this._waitResumeIfPaused();
        if (this.isCancelled) return { success: false, cancelled: true };

        const chat = this.chatsQueue[i];
        this.currentIndex = i + 1;
        this.currentChatTitle = chat.title;
        this._notifyProgress();

        log.info(`[${this.currentIndex}/${this.totalChats}] Exportando conversa "${chat.title}"...`);

        // Dispara exportação no DOM via Content Script
        const exportTriggerResponse = await chrome.tabs.sendMessage(tab.id, {
          action: ACTIONS.EXPORT_CHAT_REQUEST,
          chat
        });

        if (!exportTriggerResponse || !exportTriggerResponse.success) {
          log.warn(`Aviso: falha ao acionar exportação no chat "${chat.title}":`, exportTriggerResponse?.error);
          continue; // Prossegue para o próximo chat para não travar o lote inteiro
        }

        // Aguarda a captura do arquivo pelo interceptador
        try {
          const captured = await this.interceptor.waitForChatExport({
            tabId: tab.id,
            timeoutMs: 25000
          });

          // Grava no StagingRepository (IndexedDB)
          await StagingRepository.saveChatFile({
            chatId: chat.id,
            chatTitle: chat.title,
            filename: captured.filename,
            blob: captured.bytes
          });

          log.info(`Chat "${chat.title}" armazenado com sucesso no staging.`);
        } catch (captureErr) {
          log.error(`Erro ao capturar arquivo do chat "${chat.title}":`, captureErr);
          // Continua para os próximos chats
        }

        // Intervalo de segurança anti-ban entre chats sucessivos
        if (i < this.chatsQueue.length - 1) {
          log.info(`Aguardando delay de segurança (${safeDelayMs}ms)...`);
          await this._sleep(safeDelayMs);
        }
      }

      this.interceptor.stopListening();

      if (this.isCancelled) {
        return { success: false, cancelled: true };
      }

      // 4. FASE DE EMPACOTAMENTO EM ZIP CONSOLIDADO (PACKAGING)
      this.state = WORKFLOW_STATES.PACKAGING;
      this._notifyProgress();
      log.info('Compilando arquivo ZIP master consolidado...');

      const stagedFiles = await StagingRepository.getAllFiles();
      if (stagedFiles.length === 0) {
        throw new Error('Nenhum arquivo de conversa foi armazenado durante a extração.');
      }

      const dateStr = new Date().toISOString().slice(0, 10);
      const archiveFilename = `whatsapp_backup_${dateStr}.zip`;

      const zipBlob = await ZipBuilder.buildArchive(stagedFiles, {
        archiveName: archiveFilename
      });

      const zipArrayBuffer = await zipBlob.arrayBuffer();
      const zipBytes = new Uint8Array(zipArrayBuffer);
      const zipDataUrl = this._uint8ArrayToDataUrl(zipBytes, 'application/zip');

      // 5. DISPARAR DOWNLOAD ÚNICO DO ZIP MASTER
      log.info(`Disparando download consolidado: ${archiveFilename} (${(zipBytes.byteLength / 1024).toFixed(1)} KB)`);
      await chrome.downloads.download({
        url: zipDataUrl,
        filename: archiveFilename,
        saveAs: true
      });

      // 6. LIMPEZA DO STAGING E FINALIZAÇÃO (COMPLETED)
      await StagingRepository.clear();
      this.state = WORKFLOW_STATES.COMPLETED;
      this.currentChatTitle = 'Concluído';
      this._notifyProgress();
      log.info('Fluxo de extração em lote concluído com sucesso!');

      return {
        success: true,
        totalExported: stagedFiles.length,
        archiveFilename
      };
    } catch (err) {
      log.error('Erro crítico no fluxo do orquestrador:', err);
      this.interceptor.stopListening();
      this.state = WORKFLOW_STATES.FAILED;
      this.errorMessage = err.message;
      this._notifyProgress();
      throw err;
    }
  }
}
