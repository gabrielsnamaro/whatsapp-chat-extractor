/**
 * ChatListScanner
 * Responsabilidade Única: Rolar o painel lateral (#pane-side) e identificar
 * a lista de conversas disponíveis com suporte a limites e desduplicação.
 */
class ChatListScanner {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   * @param {number} [options.scrollStep=400] Quantidade de pixels rolados a cada iteração
   * @param {number} [options.scrollDelayMs=250] Tempo de espera para renderização virtual
   * @param {number} [options.maxConsecutiveNoNew=4] Limite de tentativas sem novas conversas para parar
   */
  constructor(options = {}) {
    this.selectors = {
      container: '#pane-side',
      row: '[role="row"]',
      cell: '[role="row"] [data-testid="cell-frame-container"]',
      archivedButton: '[data-testid="chatlist-panel-archived-button"]',
      title: '[data-testid="cell-frame-title"]',
      lastMessage: '[data-testid="cell-frame-secondary"]',
      timestamp: '[data-testid="cell-frame-primary-detail"]',
      unreadBadge: '[data-testid="icon-unread-count"]',
      ...options.selectors
    };

    this.scrollStep = options.scrollStep ?? 400;
    this.scrollDelayMs = options.scrollDelayMs ?? 250;
    this.maxConsecutiveNoNew = options.maxConsecutiveNoNew ?? 4;
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
   * Obtém o elemento do container lateral #pane-side
   * @returns {HTMLElement|null}
   */
  getPaneElement() {
    return document.querySelector(this.selectors.container);
  }

  /**
   * Extrai os dados das conversas que estão visíveis no DOM no momento
   * @returns {Array<{ id: string, title: string, unread: string|null, timestamp: string|null }>}
   */
  getVisibleChats() {
    const pane = this.getPaneElement();
    if (!pane) return [];

    const cells = pane.querySelectorAll(this.selectors.cell);
    const chats = [];

    cells.forEach((cell) => {
      // Validação semântica: ignora botões/pastas fora da grade virtual de conversas (ex: Arquivadas)
      if (!cell.closest(this.selectors.row)) return;
      if (cell.closest(this.selectors.archivedButton)) return;

      const titleEl = cell.querySelector(this.selectors.title);
      if (!titleEl) return;

      const spanWithTitle = titleEl.querySelector('span[title]');
      const title = (spanWithTitle?.getAttribute('title') || titleEl.textContent || '').trim();

      if (!title) return;

      // Conversas reais possuem histórico/prévia ou marcação de tempo
      const hasMessagePreview = Boolean(cell.querySelector(this.selectors.lastMessage));
      const hasTimestamp = Boolean(cell.querySelector(this.selectors.timestamp));
      if (!hasMessagePreview && !hasTimestamp) return;

      const unreadEl = cell.querySelector(this.selectors.unreadBadge);
      const timestampEl = cell.querySelector(this.selectors.timestamp);

      chats.push({
        id: `chat_${title.replace(/\s+/g, '_')}`,
        title,
        unread: unreadEl ? unreadEl.textContent.trim() : null,
        timestamp: timestampEl ? timestampEl.textContent.trim() : null
      });
    });

    return chats;
  }

  /**
   * Realiza a varredura progressiva por scroll virtual no #pane-side
   * até atingir o fim da lista ou o maxLimit estipulado.
   *
   * @param {Object} [params]
   * @param {number|null} [params.maxLimit=null] Número máximo de conversas desejado
   * @param {Function} [params.onProgress=null] Callback invocado a cada incremento: (totalEncontrado) => void
   * @returns {Promise<Array<{ id: string, title: string, unread: string|null, timestamp: string|null }>>}
   */
  async scanAllChats({ maxLimit = null, onProgress = null } = {}) {
    const pane = this.getPaneElement();
    if (!pane) {
      throw new Error(`Painel de conversas (${this.selectors.container}) não encontrado no DOM.`);
    }

    const chatsMap = new Map();

    const collectCurrent = () => {
      let addedAny = false;
      const current = this.getVisibleChats();
      for (const item of current) {
        if (!chatsMap.has(item.title)) {
          chatsMap.set(item.title, item);
          addedAny = true;
          if (typeof onProgress === 'function') {
            onProgress(chatsMap.size);
          }
          if (maxLimit && chatsMap.size >= maxLimit) {
            break;
          }
        }
      }
      return addedAny;
    };

    // Coleta inicial antes de qualquer rolagem
    collectCurrent();

    // Se já atingiu o limite solicitado (ex: teste rápido com poucos chats), encerra imediatamente
    if (maxLimit && chatsMap.size >= maxLimit) {
      return Array.from(chatsMap.values()).slice(0, maxLimit);
    }

    let consecutiveNoNew = 0;
    let lastScrollTop = -1;

    try {
      while (true) {
        pane.scrollTop += this.scrollStep;
        await this._sleep(this.scrollDelayMs);

        const added = collectCurrent();

        if (maxLimit && chatsMap.size >= maxLimit) {
          break;
        }

        const isAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5;
        const scrollUnchanged = pane.scrollTop === lastScrollTop;
        lastScrollTop = pane.scrollTop;

        if (!added || scrollUnchanged || isAtBottom) {
          consecutiveNoNew++;
        } else {
          consecutiveNoNew = 0;
        }

        if (consecutiveNoNew >= this.maxConsecutiveNoNew) {
          break;
        }
      }
    } finally {
      // Restaura suavemente o scroll para o topo para manter o estado visual
      pane.scrollTop = 0;
    }

    const results = Array.from(chatsMap.values());
    return maxLimit ? results.slice(0, maxLimit) : results;
  }
}

if (typeof window !== 'undefined') {
  window.ChatListScanner = ChatListScanner;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatListScanner };
}
