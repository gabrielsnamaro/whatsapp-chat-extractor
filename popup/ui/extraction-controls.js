import { WORKFLOW_STATES } from '../../shared/constants/workflow-states.js';
import { StorageClient } from '../../shared/clients/storage-client.js';
import { phoneFromTitle } from '../../shared/utils/phone.js';

const DEFAULT_SAFE_DELAY_SECONDS = 2;
// Abaixo disso o ritmo fica com cara de automação, e o WhatsApp pode restringir a conta
const MIN_SAFE_DELAY_SECONDS = 1;

// Limite, por conversa, da carga das mensagens mais antigas do celular antes de exportar; 0 desliga a carga. O teto é o do
// orquestrador (MAX_HISTORY_LIMIT_MS): a carga roda na mesma chamada à aba que a exportação, e o Chrome encerra o service
// worker quando uma chamada passa de 5 min
const DEFAULT_HISTORY_LIMIT_SECONDS = 60;
const MAX_HISTORY_LIMIT_SECONDS = 180;

const LINE_PHONE_REQUIRED_MESSAGE = 'Informe o número da linha (a conta logada no WhatsApp Web) com o DDI, ' +
  'de 10 a 15 dígitos (ex.: 5511999999999), para iniciar.';

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
 * Limite para carregar as mensagens mais antigas digitado no popup, em segundos inteiros. Vazio, inválido ou negativo
 * volta ao padrão; acima do teto vai para o teto; só o 0 desliga a carga (um valor entre 0 e 1 vai para 1).
 * @param {string} rawValue Valor do campo (`input.value`)
 * @param {Object} [options]
 * @param {boolean} [options.badInput=false] O navegador recusou o texto digitado (`validity.badInput`), caso em que
 *   `rawValue` chega vazio
 * @returns {number}
 */
export function normalizeHistoryLimitSeconds(rawValue, { badInput = false } = {}) {
  const text = String(rawValue ?? '').trim();
  if (badInput || !text) return DEFAULT_HISTORY_LIMIT_SECONDS;
  const seconds = Number(text);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_HISTORY_LIMIT_SECONDS;
  if (seconds === 0) return 0;
  return Math.min(Math.max(1, Math.round(seconds)), MAX_HISTORY_LIMIT_SECONDS);
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
    this.inputHistoryLimit = document.getElementById('history-limit-input');
    this.linePhoneRow = document.getElementById('line-phone-row');
    this.inputLinePhone = document.getElementById('line-phone-input');
    /** O campo "Número da linha" está à mostra: a linha da conta não foi detectada na aba */
    this._linePhoneVisible = false;

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
    if (this.inputHistoryLimit) {
      this.inputHistoryLimit.addEventListener('change', () => {
        this.inputHistoryLimit.value = String(this._readHistoryLimitSeconds());
        this.savePreferences();
      });
    }
    // Também só no change. O número não vai para o extractionConfig: vale só para a execução que vai iniciar
    if (this.inputLinePhone) {
      this.inputLinePhone.addEventListener('change', () => {
        const linePhone = this._readLinePhone();
        if (linePhone) this.inputLinePhone.value = linePhone;
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
        safeDelayMs: DEFAULT_SAFE_DELAY_SECONDS * 1000,
        historyLimitMs: DEFAULT_HISTORY_LIMIT_SECONDS * 1000
      });

      if (this.inputSafeDelay) {
        const savedSeconds = Number(saved.safeDelayMs) / 1000;
        this.inputSafeDelay.value = String(normalizeSafeDelaySeconds(Number.isFinite(savedSeconds) ? String(savedSeconds) : ''));
      }

      // Uma preferência gravada antes do campo existir não tem o limite, e o campo fica com o padrão
      if (this.inputHistoryLimit) {
        const savedSeconds = saved.historyLimitMs == null ? NaN : Number(saved.historyLimitMs) / 1000;
        this.inputHistoryLimit.value = String(normalizeHistoryLimitSeconds(Number.isFinite(savedSeconds) ? String(savedSeconds) : ''));
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
   * @private
   * @returns {number} Limite para carregar as mensagens mais antigas, em segundos, já validado
   */
  _readHistoryLimitSeconds() {
    if (!this.inputHistoryLimit) return DEFAULT_HISTORY_LIMIT_SECONDS;
    return normalizeHistoryLimitSeconds(this.inputHistoryLimit.value, { badInput: Boolean(this.inputHistoryLimit.validity?.badInput) });
  }

  /**
   * Retorna os parâmetros atuais configurados pelo usuário
   * @returns {{ downloadAll: boolean, maxChats: number|null, safeDelayMs: number, historyLimitMs: number }}
   *   `safeDelayMs` e `historyLimitMs` em ms
   */
  getOptions() {
    const downloadAll = Boolean(this.radioAll?.checked);
    let maxChats = null;

    if (!downloadAll && this.inputMaxChats) {
      const parsed = parseInt(this.inputMaxChats.value, 10);
      maxChats = isNaN(parsed) || parsed < 1 ? 3 : parsed;
    }

    const safeDelayMs = Math.round(this._readSafeDelaySeconds() * 1000);
    const historyLimitMs = this._readHistoryLimitSeconds() * 1000;
    return { downloadAll, maxChats, safeDelayMs, historyLimitMs };
  }

  /**
   * Mostra o campo "Número da linha" quando a linha da conta não é detectada na aba, e o esconde quando é
   * @param {boolean} visible
   */
  setLinePhoneVisible(visible) {
    this._linePhoneVisible = Boolean(visible);
    this.linePhoneRow?.classList.toggle('hidden', !this._linePhoneVisible);
  }

  /**
   * @private
   * @returns {string|null} Os dígitos do número digitado no campo da linha, de 10 a 15; null vazio ou inválido
   */
  _readLinePhone() {
    // A regra do título que é um telefone: "+", espaços, hífens e parênteses saem, e uma letra invalida o número
    // em vez de sumir dele (um "O" digitado no lugar de um zero não vira outro número)
    return phoneFromTitle(this.inputLinePhone?.value ?? '');
  }

  /**
   * Parâmetros do início da extração: os de getOptions e o número da linha, só com o campo dele à mostra. O
   * número vale só para esta execução e fica fora do extractionConfig (savePreferences grava getOptions), para
   * não sobrar a linha de uma conta quando outra logar.
   * @returns {{ downloadAll: boolean, maxChats: number|null, safeDelayMs: number, historyLimitMs: number, linePhone: string|null }}
   *   `linePhone`: os dígitos; null com o campo escondido ou com um número inválido
   */
  getStartOptions() {
    return { ...this.getOptions(), linePhone: this._linePhoneVisible ? this._readLinePhone() : null };
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
    if (this.inputHistoryLimit) this.inputHistoryLimit.disabled = isRunning || isPaused;
    if (this.inputLinePhone) this.inputLinePhone.disabled = isRunning || isPaused;

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
   * Registra callbacks para cada ação do usuário. Com o campo "Número da linha" à mostra, o início só é pedido
   * com um número de 10 a 15 dígitos; senão, `onInvalidLinePhone` recebe o aviso para o log do popup
   * @param {function(Object): void} callback Recebe getStartOptions
   * @param {function(string): void} [onInvalidLinePhone]
   */
  onStart(callback, onInvalidLinePhone = () => {}) {
    if (this.btnStart) {
      this.btnStart.addEventListener('click', () => {
        const options = this.getStartOptions();
        if (this._linePhoneVisible && !options.linePhone) {
          onInvalidLinePhone(LINE_PHONE_REQUIRED_MESSAGE);
          return;
        }
        callback(options);
      });
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
