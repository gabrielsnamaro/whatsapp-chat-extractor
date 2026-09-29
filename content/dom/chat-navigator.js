/**
 * ChatNavigator
 * Responsabilidade Única: Localizar e selecionar uma conversa específica na lista
 * lateral e aguardar a renderização e confirmação do cabeçalho da conversa aberta.
 */
(function registerChatNavigator() {
  const {
    SELECTORS, TIMEOUTS, OperationTimeoutError,
    waitFor, sleep, throwIfAborted, simulateClick, pressEscape,
    readTextWithEmojis, readCellTitle, isTitleMatch
  } = window.DomUtils;

  class ChatNavigator {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita dos timeouts padrão (ms)
     * @param {number} [options.scrollDelayMs=200] Espera de renderização da lista virtual a cada passo
     */
    constructor(options = {}) {
      this.timeouts = {
        openChatMs: TIMEOUTS.OPEN_CHAT_MS,
        searchResultsMs: TIMEOUTS.SEARCH_RESULTS_MS,
        ...options.timeouts
      };
      this.scrollDelayMs = options.scrollDelayMs ?? 200;
    }

    /**
     * Retorna o título da conversa atualmente aberta no #main header
     * @returns {string|null}
     */
    getActiveChatTitle() {
      const headerTitleEl = document.querySelector(SELECTORS.MAIN_HEADER_TITLE) ||
                            document.querySelector(SELECTORS.MAIN_HEADER_TITLE_FALLBACK);
      if (!headerTitleEl) return null;
      return (headerTitleEl.getAttribute('title') || readTextWithEmojis(headerTitleEl)).trim() || null;
    }

    /**
     * Lista as células com título exato dentro de um contêiner
     * @private
     * @param {Element|null} root
     * @param {string} targetTitle
     * @returns {HTMLElement[]}
     */
    _findMatchingCells(root, targetTitle) {
      if (!root) return [];
      const matches = [];
      for (const cell of root.querySelectorAll(SELECTORS.CHAT_CELL)) {
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) continue;
        if (isTitleMatch(readCellTitle(cell), targetTitle)) {
          matches.push(cell);
        }
      }
      return matches;
    }

    /**
     * Procura no DOM visível da lista a célula correspondente ao título.
     * Duas células com o mesmo título ao mesmo tempo indicam homônimos: sem como
     * saber qual é a pedida, falha em vez de escolher uma arbitrariamente.
     * @param {string} targetTitle
     * @returns {HTMLElement|null}
     */
    findVisibleCellByTitle(targetTitle) {
      const matches = this._findMatchingCells(document.querySelector(SELECTORS.PANE_SIDE), targetTitle);
      if (matches.length > 1) {
        throw new Error(`Há mais de uma conversa chamada "${targetTitle}"; não é possível escolher com segurança.`);
      }
      return matches[0] || null;
    }

    /**
     * @private
     * @returns {HTMLInputElement|HTMLElement|null}
     */
    _findSearchInput() {
      return document.querySelector(SELECTORS.SEARCH_INPUT);
    }

    /**
     * Preenche a caixa de busca de forma que o React perceba a alteração
     * @private
     * @param {HTMLInputElement|HTMLElement} input
     * @param {string} text
     */
    _setSearchText(input, text) {
      input.focus();
      if (input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      // Versões antigas usavam um contenteditable no lugar do <input>
      document.execCommand('selectAll', false, null);
      document.execCommand(text ? 'insertText' : 'delete', false, text || null);
    }

    /**
     * Limpa a busca para devolver a lista lateral ao estado normal
     */
    clearSearch() {
      const input = this._findSearchInput();
      if (!input) return;
      const currentValue = input instanceof HTMLInputElement ? input.value : input.textContent;
      if (currentValue) {
        this._setSearchText(input, '');
      }
    }

    /**
     * Localiza a conversa pela caixa de busca da lista lateral. Os resultados podem incluir
     * a seção de mensagens com o mesmo título; a seção de conversas vem primeiro, então usa a primeira.
     * @private
     * @param {string} targetTitle
     * @param {AbortSignal} [signal]
     * @returns {Promise<HTMLElement|null>}
     */
    async _locateCellViaSearch(targetTitle, signal) {
      const input = this._findSearchInput();
      if (!input) return null;

      this._setSearchText(input, targetTitle);
      try {
        return await waitFor(
          () => this._findMatchingCells(document.querySelector(SELECTORS.SIDE_PANEL), targetTitle)[0] || null,
          {
            timeoutMs: this.timeouts.searchResultsMs,
            description: `resultados da busca por "${targetTitle}"`,
            signal
          }
        );
      } catch (err) {
        if (err instanceof OperationTimeoutError) {
          this.clearSearch();
          return null;
        }
        throw err;
      }
    }

    /**
     * Varre a lista inteira do topo ao fim. Passos menores que a altura visível
     * garantem que nenhuma linha da lista virtual seja pulada.
     * @private
     * @param {string} targetTitle
     * @param {AbortSignal} [signal]
     * @returns {Promise<HTMLElement|null>}
     */
    async _locateCellWithScroll(targetTitle, signal) {
      const pane = document.querySelector(SELECTORS.PANE_SIDE);
      if (!pane) return null;

      pane.scrollTop = 0;
      await sleep(300, signal);

      const step = Math.max(100, Math.floor(pane.clientHeight * 0.7));
      let consecutiveStall = 0;

      while (true) {
        throwIfAborted(signal);
        const cell = this.findVisibleCellByTitle(targetTitle);
        if (cell) return cell;

        const previousTop = pane.scrollTop;
        pane.scrollTop += step;
        await sleep(this.scrollDelayMs, signal);

        const isAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5;
        consecutiveStall = pane.scrollTop === previousTop || isAtBottom ? consecutiveStall + 1 : 0;
        if (consecutiveStall >= 3) {
          return this.findVisibleCellByTitle(targetTitle);
        }
      }
    }

    /**
     * Abre a conversa especificada e aguarda a confirmação visual no cabeçalho
     * @param {Object|string} chat Info da conversa ou string do título
     * @param {string} [chat.title]
     * @param {Object} [params]
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ success: boolean, title: string, via: string }>}
     */
    async openChat(chat, { signal } = {}) {
      const targetTitle = typeof chat === 'string' ? chat : chat?.title;
      if (!targetTitle) {
        throw new Error('Título da conversa não fornecido ao ChatNavigator.');
      }

      // 1. Fecha qualquer menu ou modal residual antes de navegar
      if (document.querySelector(SELECTORS.EXPORT_MODAL) || document.querySelector(SELECTORS.MENU_CONTAINER)) {
        pressEscape();
        await sleep(250, signal);
      }

      // 2. A conversa desejada já está aberta
      if (isTitleMatch(this.getActiveChatTitle(), targetTitle)) {
        return { success: true, title: targetTitle, via: 'already-open' };
      }

      // 3. Localiza a célula: visível agora → busca → varredura completa da lista
      let via = 'visible';
      let cellElement = this.findVisibleCellByTitle(targetTitle);
      if (!cellElement) {
        via = 'search';
        cellElement = await this._locateCellViaSearch(targetTitle, signal);
      }
      if (!cellElement) {
        via = 'scroll';
        cellElement = await this._locateCellWithScroll(targetTitle, signal);
      }
      if (!cellElement) {
        throw new Error(`Conversa "${targetTitle}" não foi encontrada na lista lateral.`);
      }

      try {
        cellElement.scrollIntoView({ behavior: 'auto', block: 'center' });
        await sleep(150, signal);
        simulateClick(cellElement);

        // 4. Aguarda o cabeçalho mostrar a conversa; re-tenta o clique a cada 2s (abrir chat é idempotente)
        let lastClickAt = Date.now();
        await waitFor(() => {
          if (isTitleMatch(this.getActiveChatTitle(), targetTitle)) return true;
          // A célula clicada tem título exato; se ela ficou selecionada, o chat aberto é ela
          const isSelected = cellElement.isConnected && cellElement.closest('[aria-selected="true"]') !== null;
          return isSelected && Boolean(document.querySelector(SELECTORS.MAIN_HEADER));
        }, {
          timeoutMs: this.timeouts.openChatMs,
          description: `a abertura da conversa "${targetTitle}"`,
          signal,
          onTick: () => {
            if (Date.now() - lastClickAt > 2000 && cellElement.isConnected) {
              simulateClick(cellElement);
              lastClickAt = Date.now();
            }
          }
        });

        // Estabilização da renderização da conversa antes de abrir o menu
        await sleep(500, signal);
        return { success: true, title: targetTitle, via };
      } finally {
        if (via === 'search') {
          this.clearSearch();
        }
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.ChatNavigator = ChatNavigator;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChatNavigator };
  }
})();
