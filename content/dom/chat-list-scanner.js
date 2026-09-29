/**
 * ChatListScanner
 * Responsabilidade Única: Rolar o painel lateral (#pane-side) e identificar
 * a lista de conversas disponíveis com suporte a limites e desduplicação.
 */
(function registerChatListScanner() {
  const { SELECTORS, sleep, throwIfAborted, readCellTitle, normalizeTitle } = window.DomUtils;

  class ChatListScanner {
    /**
     * @param {Object} [options]
     * @param {number} [options.scrollStep=400] Quantidade de pixels rolados a cada iteração
     * @param {number} [options.scrollDelayMs=250] Tempo de espera para renderização virtual
     * @param {number} [options.maxConsecutiveNoNew=4] Limite de tentativas sem novas conversas para parar
     */
    constructor(options = {}) {
      this.scrollStep = options.scrollStep ?? 400;
      this.scrollDelayMs = options.scrollDelayMs ?? 250;
      this.maxConsecutiveNoNew = options.maxConsecutiveNoNew ?? 4;
    }

    /**
     * Obtém o elemento do container lateral #pane-side
     * @returns {HTMLElement|null}
     */
    getPaneElement() {
      return document.querySelector(SELECTORS.PANE_SIDE);
    }

    /**
     * Extrai os dados das conversas que estão visíveis no DOM no momento
     * @returns {Array<{ id: string, title: string, unread: string|null, timestamp: string|null }>}
     */
    getVisibleChats() {
      const pane = this.getPaneElement();
      if (!pane) return [];

      const chats = [];
      pane.querySelectorAll(SELECTORS.CHAT_CELL).forEach((cell) => {
        // Ignora botões/pastas fora da grade virtual de conversas (ex: Arquivadas)
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) return;

        const title = readCellTitle(cell);
        if (!title) return;

        // Conversas reais possuem histórico/prévia ou marcação de tempo
        const timestampEl = cell.querySelector(SELECTORS.CHAT_TIMESTAMP);
        if (!cell.querySelector(SELECTORS.CHAT_LAST_MESSAGE) && !timestampEl) return;

        const unreadEl = cell.querySelector(SELECTORS.CHAT_UNREAD_COUNT);
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
     * Títulos repetidos na mesma tela são homônimos (contatos diferentes com o mesmo nome)
     * e voltam marcados com `duplicateTitle: true`. Homônimos distantes na lista não são
     * detectáveis por aqui: a lista reordena durante a varredura e não expõe um id estável.
     *
     * @param {Object} [params]
     * @param {number|null} [params.maxLimit=null] Número máximo de conversas desejado
     * @param {Function} [params.onProgress=null] Callback invocado a cada incremento: (totalEncontrado) => void
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<Array<{ id: string, title: string, unread: string|null, timestamp: string|null, duplicateTitle: boolean }>>}
     */
    async scanAllChats({ maxLimit = null, onProgress = null, signal } = {}) {
      const pane = this.getPaneElement();
      if (!pane) {
        throw new Error(`Painel de conversas (${SELECTORS.PANE_SIDE}) não encontrado no DOM.`);
      }

      const chatsMap = new Map();
      const duplicateKeys = new Set();

      const collectCurrent = () => {
        let addedAny = false;
        const seenInSnapshot = new Set();

        for (const item of this.getVisibleChats()) {
          const key = normalizeTitle(item.title);
          if (seenInSnapshot.has(key)) duplicateKeys.add(key);
          seenInSnapshot.add(key);

          if (!chatsMap.has(key) && !(maxLimit && chatsMap.size >= maxLimit)) {
            chatsMap.set(key, item);
            addedAny = true;
            if (typeof onProgress === 'function') onProgress(chatsMap.size);
          }
        }
        return addedAny;
      };

      const buildResults = () => Array.from(chatsMap.entries())
        .map(([key, item]) => ({ ...item, duplicateTitle: duplicateKeys.has(key) }));

      collectCurrent();
      if (maxLimit && chatsMap.size >= maxLimit) {
        return buildResults();
      }

      let consecutiveNoNew = 0;
      let lastScrollTop = -1;

      try {
        while (true) {
          throwIfAborted(signal);
          pane.scrollTop += this.scrollStep;
          await sleep(this.scrollDelayMs, signal);

          const added = collectCurrent();
          if (maxLimit && chatsMap.size >= maxLimit) break;

          const isAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5;
          const scrollUnchanged = pane.scrollTop === lastScrollTop;
          lastScrollTop = pane.scrollTop;

          consecutiveNoNew = !added || scrollUnchanged || isAtBottom ? consecutiveNoNew + 1 : 0;
          if (consecutiveNoNew >= this.maxConsecutiveNoNew) break;
        }
      } finally {
        // Restaura o scroll para o topo para manter o estado visual
        pane.scrollTop = 0;
      }

      return buildResults();
    }
  }

  if (typeof window !== 'undefined') {
    window.ChatListScanner = ChatListScanner;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChatListScanner };
  }
})();
