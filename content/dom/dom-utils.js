/**
 * DomUtils
 * Responsabilidade Única: Utilitários compartilhados pelas classes de automação DOM
 * (seletores, códigos de erro, esperas com timeout/cancelamento, clique simulado e leitura de títulos).
 *
 * Content scripts clássicos não importam módulos ES, por isso o compartilhamento é via window.
 * Deve ser o primeiro arquivo da lista de content scripts no manifest.
 */
(function registerDomUtils() {
  /**
   * Seletores DOM canônicos mapeados da pasta kb/ (WhatsApp Web).
   * Priorizam atributos semânticos estáveis (id, data-testid, role, aria-*).
   */
  const SELECTORS = Object.freeze({
    // Indicadores de estado e painéis estruturais
    APP_ROOT: '#app',
    SIDE_PANEL: '#side',
    PANE_SIDE: '#pane-side',
    MAIN_CHAT: '#main',

    // Lista lateral de conversas (#pane-side)
    CHAT_ROW: '[role="row"]',
    CHAT_CELL: '[role="row"] [data-testid="cell-frame-container"]',
    ARCHIVED_BUTTON: '[data-testid="chatlist-panel-archived-button"]',
    CHAT_TITLE: '[data-testid="cell-frame-title"]',
    CHAT_LAST_MESSAGE: '[data-testid="cell-frame-secondary"]',
    CHAT_TIMESTAMP: '[data-testid="cell-frame-primary-detail"]',
    CHAT_UNREAD_COUNT: '[data-testid="icon-unread-count"]',
    SEARCH_INPUT: '#side input[data-tab="3"], #side input[role="textbox"], #side div[contenteditable="true"][data-tab="3"]',

    // Cabeçalho da conversa aberta (#main header)
    MAIN_HEADER: '#main header',
    MAIN_HEADER_TITLE: '#main header [data-testid="conversation-info-header-chat-title"]',
    MAIN_HEADER_TITLE_FALLBACK: '#main header span[dir="auto"]',
    BTN_MORE_OPTIONS: '#main header button[aria-label="Mais opções"], #main header [role="button"][aria-label="Mais opções"]',

    // Menu suspenso ("Mais opções")
    MENU_CONTAINER: 'div[role="menu"]',
    MENU_ITEM: '[role="menuitem"]',
    MENU_ITEM_EXPORT_CHAT: 'div[role="menu"] button[role="menuitem"][aria-label="Exportar conversa"]',
    EXPORT_MENU_TEXT: 'Exportar conversa',

    // Modal nativo de exportação de conversa
    EXPORT_MODAL: 'div[data-testid="export-chat-modal"]',
    EXPORT_MODAL_FALLBACK: 'div[role="dialog"]',
    EXPORT_RADIO_ALL_MSGS: 'input#date-range-all',
    EXPORT_RADIO_ALL_LABEL: 'label[for="date-range-all"]',
    EXPORT_DATE_RANGE_RADIOS: 'input[name="date-range"]',
    EXPORT_MODAL_BUTTONS: 'button, div[role="button"]',
    EXPORT_CONFIRM_TEXT: 'Exportar',
    EXPORT_CANCEL_TEXT: 'Cancelar'
  });

  /**
   * Timeouts padrão por etapa. São generosos de propósito: os timeouts curtos
   * anteriores (5–10s) estouravam em máquinas lentas e em contas grandes.
   */
  const TIMEOUTS = Object.freeze({
    OPEN_CHAT_MS: 30000,
    MORE_OPTIONS_BUTTON_MS: 30000,
    MENU_MS: 15000,
    // Curto de propósito: o menu já abriu, e um menu sem o item é uma conversa não exportável
    MENU_ITEM_MS: 1500,
    MODAL_MS: 30000,
    // O modal já abriu: o botão "Exportar" faz parte dele e só demora o tempo de renderizar
    MODAL_CONFIRM_BUTTON_MS: 3000,
    SEARCH_RESULTS_MS: 8000,
    MODAL_CLOSE_MS: 5000
  });

  /**
   * Códigos de erro da automação DOM. Vão na resposta ao background, que classifica o resultado
   * da conversa por eles (ex: uma conversa não exportável é contada à parte das falhas).
   */
  const ERROR_CODES = Object.freeze({
    CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
    AMBIGUOUS_TITLE: 'AMBIGUOUS_TITLE',
    EXPORT_OPTION_UNAVAILABLE: 'EXPORT_OPTION_UNAVAILABLE',
    DATE_RANGE_NOT_ALL: 'DATE_RANGE_NOT_ALL',
    TIMEOUT: 'TIMEOUT'
  });

  /** Por que uma tentativa de localizar a conversa na lista lateral não achou a célula */
  const LOCATE_FAILURES = Object.freeze({
    SEARCH_INPUT_MISSING: 'search-input-missing',
    SEARCH_NO_RESULT: 'search-no-result',
    LIST_MISSING: 'list-missing',
    END_OF_LIST: 'end-of-list',
    SCROLL_STALLED: 'scroll-stalled'
  });

  const LOCATE_VIA_LABELS = Object.freeze({ search: 'busca', scroll: 'rolagem' });

  class OperationCancelledError extends Error {
    constructor(message = 'Operação cancelada.') {
      super(message);
      this.name = 'OperationCancelledError';
    }
  }

  class OperationTimeoutError extends Error {
    constructor(message) {
      super(message);
      this.name = 'OperationTimeoutError';
      this.code = ERROR_CODES.TIMEOUT;
    }
  }

  class DomAutomationError extends Error {
    /**
     * @param {string} code Um dos ERROR_CODES
     * @param {string} message Texto exibido no relatório da extração
     */
    constructor(code, message) {
      super(message);
      this.name = 'DomAutomationError';
      this.code = code;
    }
  }

  function formatSeconds(ms) {
    return `${Number((ms / 1000).toFixed(2))} s`;
  }

  /**
   * @param {{ via: string, reason: string, timeoutMs?: number, steps?: number }} attempt
   * @returns {string}
   */
  function describeFailedAttempt({ via, reason, timeoutMs, steps }) {
    const label = LOCATE_VIA_LABELS[via];
    if (!label) throw new Error(`Tentativa de localização desconhecida: ${via}`);

    switch (reason) {
      case LOCATE_FAILURES.SEARCH_INPUT_MISSING:
        return `${label}: campo de busca não encontrado`;
      case LOCATE_FAILURES.SEARCH_NO_RESULT:
        return `${label}: sem resultado em ${formatSeconds(timeoutMs)}`;
      case LOCATE_FAILURES.LIST_MISSING:
        return `${label}: lista lateral não encontrada`;
      case LOCATE_FAILURES.END_OF_LIST:
        return `${label}: ${steps} passo(s) até o fim da lista`;
      case LOCATE_FAILURES.SCROLL_STALLED:
        return `${label}: parou após ${steps} passo(s), antes do fim da lista`;
      default:
        throw new Error(`Motivo de tentativa desconhecido: ${reason}`);
    }
  }

  /**
   * Mensagem de conversa não encontrada com o motivo de cada tentativa (busca, rolagem).
   * Não toca no DOM, para ser testada no Node.
   * @param {string} targetTitle
   * @param {Array<{ via: 'search'|'scroll', reason: string, timeoutMs?: number, steps?: number }>} failedAttempts
   * @returns {string}
   */
  function buildChatNotFoundMessage(targetTitle, failedAttempts) {
    const base = `Conversa "${targetTitle}" não foi encontrada na lista lateral`;
    if (!failedAttempts.length) return `${base}.`;
    return `${base} (${failedAttempts.map(describeFailedAttempt).join('; ')}).`;
  }

  /**
   * Posição da lista lateral em que a varredura de abertura começa: uma tela acima da linha estimada
   * da conversa (posição na fila × altura de uma linha). A tela de folga cobre a conversa que subiu um
   * pouco desde a varredura e a pasta "Arquivadas" acima da grade; a que desceu é achada na descida.
   * Não toca no DOM, para ser testada no Node.
   * @param {{ index: number, rowHeight: number, viewportHeight: number }} params
   * @returns {number} scrollTop inicial, nunca negativo
   */
  function estimateScrollStart({ index, rowHeight, viewportHeight }) {
    for (const [name, value] of Object.entries({ index, rowHeight, viewportHeight })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Valor inválido para estimar a posição da conversa na lista: ${name} = ${String(value)}`);
      }
    }
    return Math.max(0, Math.floor(index * rowHeight - viewportHeight));
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw new OperationCancelledError();
  }

  /**
   * Pausa assíncrona interrompível por AbortSignal
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new OperationCancelledError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new OperationCancelledError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Aguarda até que `probe()` retorne um valor verdadeiro, respeitando timeout e cancelamento
   * @param {function(): any} probe
   * @param {Object} options
   * @param {number} options.timeoutMs
   * @param {string} options.description Texto usado na mensagem de timeout
   * @param {number} [options.intervalMs=150]
   * @param {AbortSignal} [options.signal]
   * @param {function(number): void} [options.onTick] Invocado a cada tentativa sem sucesso com o tempo decorrido
   * @returns {Promise<any>}
   */
  async function waitFor(probe, { timeoutMs, description, intervalMs = 150, signal, onTick } = {}) {
    const startedAt = Date.now();
    while (true) {
      throwIfAborted(signal);
      const result = probe();
      if (result) return result;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new OperationTimeoutError(`Timeout de ${Math.round(timeoutMs / 1000)}s aguardando ${description}.`);
      }
      if (onTick) onTick(elapsed);
      await sleep(intervalMs, signal);
    }
  }

  /**
   * Considera visível qualquer elemento com caixa renderizada. Ao contrário de
   * offsetParent, funciona para menus e modais com position: fixed.
   * @param {Element|null} element
   * @returns {boolean}
   */
  function isVisible(element) {
    return Boolean(element) && element.isConnected && element.getClientRects().length > 0;
  }

  /**
   * Dispara um único clique com a sequência de eventos de ponteiro que o React escuta.
   * element.click() já emite o evento click; emitir outro MouseEvent('click') fazia
   * cada clique contar duas vezes (menus abriam e fechavam, "Exportar" disparava duas vezes).
   * @param {HTMLElement} element
   */
  function simulateClick(element) {
    if (!element) return;
    try { element.focus({ preventScroll: true }); } catch (_) {}

    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const baseInit = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
    const pointerInit = { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    try { element.dispatchEvent(new PointerEvent('pointerdown', { ...pointerInit, buttons: 1 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { ...baseInit, buttons: 1 })); } catch (_) {}
    try { element.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { ...baseInit, buttons: 0 })); } catch (_) {}
    element.click();
  }

  function pressEscape() {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /**
   * Lê o texto visível de um elemento incluindo emojis, que o WhatsApp Web
   * renderiza como <img alt="🤓"> e por isso somem do textContent
   * @param {Element|null} element
   * @returns {string}
   */
  function readTextWithEmojis(element) {
    if (!element) return '';
    let text = '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.nodeValue;
      } else if (node.tagName === 'IMG' && node.alt) {
        text += node.alt;
      }
      node = walker.nextNode();
    }
    return text;
  }

  /**
   * Título de uma célula da lista: atributo title (preserva emojis) com fallback para o texto
   * @param {Element} cell
   * @returns {string}
   */
  function readCellTitle(cell) {
    const titleEl = cell?.querySelector(SELECTORS.CHAT_TITLE);
    if (!titleEl) return '';
    const spanWithTitle = titleEl.querySelector('span[title]');
    return (spanWithTitle?.getAttribute('title') || readTextWithEmojis(titleEl)).trim();
  }

  /**
   * Normaliza títulos para comparação exata: forma NFC, sem caracteres invisíveis
   * (inclusive seletores de variação de emoji) e espaços colapsados. A caixa é mantida:
   * "João" e "joão" são conversas diferentes, e igualá-las fazia o scanner guardar só uma
   * e a abertura poder pegar uma no lugar da outra.
   * @param {string} str
   * @returns {string}
   */
  function normalizeTitle(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .normalize('NFC')
      .replace(/[​-‍﻿‎‏‪-‮︎️]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Igualdade exata após normalização. Comparação parcial foi descartada porque fazia
   * "Ana" casar com "Mariana" e exportar a conversa errada sob o nome da esperada.
   * @param {string} candidateTitle
   * @param {string} targetTitle
   * @returns {boolean}
   */
  function isTitleMatch(candidateTitle, targetTitle) {
    const cleanCand = normalizeTitle(candidateTitle);
    return Boolean(cleanCand) && cleanCand === normalizeTitle(targetTitle);
  }

  const DomUtils = Object.freeze({
    SELECTORS,
    TIMEOUTS,
    ERROR_CODES,
    LOCATE_FAILURES,
    OperationCancelledError,
    OperationTimeoutError,
    DomAutomationError,
    buildChatNotFoundMessage,
    estimateScrollStart,
    throwIfAborted,
    sleep,
    waitFor,
    isVisible,
    simulateClick,
    pressEscape,
    readTextWithEmojis,
    readCellTitle,
    normalizeTitle,
    isTitleMatch
  });

  if (typeof window !== 'undefined') {
    window.DomUtils = DomUtils;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DomUtils };
  }
})();
