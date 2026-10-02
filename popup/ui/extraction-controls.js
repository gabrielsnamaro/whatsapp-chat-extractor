import { WORKFLOW_STATES } from '../../shared/constants/workflow-states.js';
import { StorageClient } from '../../shared/clients/storage-client.js';

const DEFAULT_SAFE_DELAY_SECONDS = 2;
// Abaixo disso o ritmo fica com cara de automação, e o WhatsApp pode restringir a conta
const MIN_SAFE_DELAY_SECONDS = 1;

/**
 * Intervalo entre conversas digitado no popup, em segundos. Vazio volta ao padrão; inválido ou abaixo
 * do mínimo vai para o mínimo.
 * @param {string} rawValue Valor do campo (`input.value`)
 * @param {Object} [options]
 * @param {boolean} [options.badInput=false] O navegador recusou o texto digitado (`validity.badInput`),
 *   caso em que `rawValue` chega vazio
 * @returns {number}
 */
export function normalizeSafeDelaySeconds(rawValue, { badInput = false } = {}) {
  if (badInput) return MIN_SAFE_DELAY_SECONDS;
  const text = String(rawValue ?? '').trim();
  if (!text) return DEFAULT_SAFE_DELAY_SECONDS;
  const seconds = Number(text);
  return Number.isFinite(seconds) && seconds >= MIN_SAFE_DELAY_SECONDS ? seconds : MIN_SAFE_DELAY_SECONDS;
}

/**
 * ExtractionControls
 * Responsabilidade Única: Gerenciar as opções de extração (Todos vs Limite Numérico para testes),
 * persistir as preferências do usuário e tratar os eventos dos botões de ação do fluxo.
 */
export class ExtractionControls {
  constructor() {
    this.radioAll = document.getElementById('mode-all');
    this.radioLimit = document.getElementById('mode-limit');
    this.inputMaxChats = document.getElementById('max-chats-input');
    this.inputSafeDelay = document.getElementById('safe-delay-input');

    this.btnStart = document.getElementById('btn-start-batch');
    this.btnPause = document.getElementById('btn-pause-batch');
    this.btnResume = document.getElementById('btn-resume-batch');
    this.btnCancel = document.getElementById('btn-cancel-batch');

    this._setupFormListeners();
  }

  /**
   * Inicializa ouvintes de alteração do formulário de opções
   * @private
   */
  _setupFormListeners() {
    const handleModeChange = () => {
      const isLimit = this.radioLimit?.checked;
      if (this.inputMaxChats) {
        this.inputMaxChats.disabled = !isLimit;
        if (isLimit) {
          this.inputMaxChats.focus();
        }
      }
      this.savePreferences();
    };

    if (this.radioAll) this.radioAll.addEventListener('change', handleModeChange);
    if (this.radioLimit) this.radioLimit.addEventListener('change', handleModeChange);
    if (this.inputMaxChats) {
      this.inputMaxChats.addEventListener('change', () => this.savePreferences());
      this.inputMaxChats.addEventListener('input', () => this.savePreferences());
    }
    // Só no change: no input, digitar "1,5" passaria por "1," e o campo seria corrigido no meio da digitação
    if (this.inputSafeDelay) {
      this.inputSafeDelay.addEventListener('change', () => {
        this.inputSafeDelay.value = String(this._readSafeDelaySeconds());
        this.savePreferences();
      });
    }
  }

  /**
   * Carrega opções persistidas do StorageClient
   */
  async loadPreferences() {
    try {
      const saved = await StorageClient.get('extractionConfig', {
        downloadAll: false,
        maxChats: 3,
        safeDelayMs: DEFAULT_SAFE_DELAY_SECONDS * 1000
      });

      if (this.inputSafeDelay) {
        const savedSeconds = Number(saved.safeDelayMs) / 1000;
        this.inputSafeDelay.value = String(normalizeSafeDelaySeconds(Number.isFinite(savedSeconds) ? String(savedSeconds) : ''));
      }

      if (saved.downloadAll) {
        if (this.radioAll) this.radioAll.checked = true;
        if (this.inputMaxChats) this.inputMaxChats.disabled = true;
      } else {
        if (this.radioLimit) this.radioLimit.checked = true;
        if (this.inputMaxChats) {
          this.inputMaxChats.disabled = false;
          this.inputMaxChats.value = saved.maxChats || 3;
        }
      }
    } catch (_) {}
  }

  /**
   * Salva opções atuais no StorageClient
   */
  async savePreferences() {
    const opts = this.getOptions();
    await StorageClient.set({ extractionConfig: opts });
  }

  /**
   * @private
   * @returns {number} Intervalo entre conversas em segundos, já validado
   */
  _readSafeDelaySeconds() {
    if (!this.inputSafeDelay) return DEFAULT_SAFE_DELAY_SECONDS;
    return normalizeSafeDelaySeconds(this.inputSafeDelay.value, { badInput: Boolean(this.inputSafeDelay.validity?.badInput) });
  }

  /**
   * Retorna os parâmetros atuais configurados pelo usuário
   * @returns {{ downloadAll: boolean, maxChats: number|null, safeDelayMs: number }} `safeDelayMs` em ms
   */
  getOptions() {
    const downloadAll = Boolean(this.radioAll?.checked);
    let maxChats = null;

    if (!downloadAll && this.inputMaxChats) {
      const parsed = parseInt(this.inputMaxChats.value, 10);
      maxChats = isNaN(parsed) || parsed < 1 ? 3 : parsed;
    }

    const safeDelayMs = Math.round(this._readSafeDelaySeconds() * 1000);
    return { downloadAll, maxChats, safeDelayMs };
  }

  /**
   * Atualiza a visibilidade e disponibilidade dos controles conforme o estado da máquina
   * @param {string} state Estado atual de WORKFLOW_STATES
   */
  updateUiState(state) {
    const isRunning = [
      WORKFLOW_STATES.SCANNING,
      WORKFLOW_STATES.EXPORTING,
      WORKFLOW_STATES.WAITING_DOWNLOAD,
      WORKFLOW_STATES.PACKAGING
    ].includes(state);

    const isPaused = state === WORKFLOW_STATES.PAUSED;

    // Desabilita campos de configuração durante a execução
    if (this.radioAll) this.radioAll.disabled = isRunning || isPaused;
    if (this.radioLimit) this.radioLimit.disabled = isRunning || isPaused;
    if (this.inputMaxChats) this.inputMaxChats.disabled = (isRunning || isPaused) || this.radioAll?.checked;
    if (this.inputSafeDelay) this.inputSafeDelay.disabled = isRunning || isPaused;

    // Controle de exibição dos botões de ação
    if (this.btnStart) {
      this.btnStart.classList.toggle('hidden', isRunning || isPaused);
      this.btnStart.disabled = isRunning || isPaused;
    }

    if (this.btnPause) {
      this.btnPause.classList.toggle('hidden', !isRunning);
      this.btnPause.disabled = !isRunning;
    }

    if (this.btnResume) {
      this.btnResume.classList.toggle('hidden', !isPaused);
      this.btnResume.disabled = !isPaused;
    }

    if (this.btnCancel) {
      this.btnCancel.classList.toggle('hidden', !isRunning && !isPaused);
      this.btnCancel.disabled = !isRunning && !isPaused;
    }
  }

  /**
   * Registra callbacks para cada ação do usuário
   */
  onStart(callback) {
    if (this.btnStart) {
      this.btnStart.addEventListener('click', () => callback(this.getOptions()));
    }
  }

  onPause(callback) {
    if (this.btnPause) {
      this.btnPause.addEventListener('click', callback);
    }
  }

  onResume(callback) {
    if (this.btnResume) {
      this.btnResume.addEventListener('click', callback);
    }
  }

  onCancel(callback) {
    if (this.btnCancel) {
      this.btnCancel.addEventListener('click', callback);
    }
  }
}
