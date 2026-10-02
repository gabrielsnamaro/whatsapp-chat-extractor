/**
 * ChatOptionsMenu
 * Responsabilidade Única: Interagir com o menu contextual do cabeçalho da conversa aberta
 * e acionar a opção nativa "Exportar conversa".
 */
(function registerChatOptionsMenu() {
  const {
    SELECTORS, TIMEOUTS, ERROR_CODES, DomAutomationError, OperationTimeoutError, waitFor, isVisible, simulateClick, pressEscape
  } = window.DomUtils;

  class ChatOptionsMenu {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita dos timeouts padrão (ms)
     */
    constructor(options = {}) {
      this.timeouts = {
        moreOptionsButtonMs: TIMEOUTS.MORE_OPTIONS_BUTTON_MS,
        menuMs: TIMEOUTS.MENU_MS,
        menuItemMs: TIMEOUTS.MENU_ITEM_MS,
        ...options.timeouts
      };
    }

    /**
     * Localiza o botão "Mais opções" no cabeçalho atual
     * @private
     * @returns {HTMLElement|null}
     */
    _findMoreOptionsButton() {
      return document.querySelector(SELECTORS.BTN_MORE_OPTIONS);
    }

    /**
     * @private
     * @returns {HTMLElement|null}
     */
    _findVisibleMenu() {
      const menu = document.querySelector(SELECTORS.MENU_CONTAINER);
      return isVisible(menu) ? menu : null;
    }

    /**
     * Localiza o item de exportação dentro do menu
     * @param {HTMLElement} menu
     * @returns {HTMLElement|null}
     */
    findExportMenuItem(menu) {
      const item = menu.querySelector(SELECTORS.MENU_ITEM_EXPORT_CHAT);
      if (item) return item;

      const items = menu.querySelectorAll(`${SELECTORS.MENU_ITEM}, button`);
      for (const el of items) {
        if (el.getAttribute('aria-label') === SELECTORS.EXPORT_MENU_TEXT ||
            (el.textContent || '').trim() === SELECTORS.EXPORT_MENU_TEXT) {
          return el;
        }
      }
      return null;
    }

    /**
     * Fecha o menu suspenso caso ele esteja aberto
     */
    closeMenu() {
      if (document.querySelector(SELECTORS.MENU_CONTAINER)) {
        pressEscape();
      }
    }

    /**
     * Clica no botão de opções e seleciona "Exportar conversa"
     * @param {Object} [params]
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ success: boolean }>}
     */
    async triggerExportOption({ signal } = {}) {
      const btn = await waitFor(() => this._findMoreOptionsButton(), {
        timeoutMs: this.timeouts.moreOptionsButtonMs,
        description: 'o botão "Mais opções" no cabeçalho da conversa',
        signal
      });

      simulateClick(btn);

      // Se o menu não abrir, re-tenta o clique a cada 1,5s (com clique único não há risco de abrir e fechar)
      let lastClickAt = Date.now();
      const menu = await waitFor(() => this._findVisibleMenu(), {
        timeoutMs: this.timeouts.menuMs,
        description: 'a abertura do menu de opções',
        signal,
        onTick: () => {
          if (Date.now() - lastClickAt > 1500) {
            simulateClick(this._findMoreOptionsButton() || btn);
            lastClickAt = Date.now();
          }
        }
      });

      let exportItem;
      try {
        exportItem = await waitFor(() => this.findExportMenuItem(menu), {
          timeoutMs: this.timeouts.menuItemMs,
          description: 'o item "Exportar conversa" no menu de opções',
          signal
        });
      } catch (err) {
        if (!(err instanceof OperationTimeoutError)) throw err;
        // O menu abriu e não trouxe o item: é uma conversa não exportável, não uma lentidão a repescar
        this.closeMenu();
        throw new DomAutomationError(
          ERROR_CODES.EXPORT_OPTION_UNAVAILABLE,
          'Opção "Exportar conversa" não disponível para esta conversa (ex: chat de avisos ou restrito).'
        );
      }

      simulateClick(exportItem);
      return { success: true };
    }
  }

  if (typeof window !== 'undefined') {
    window.ChatOptionsMenu = ChatOptionsMenu;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChatOptionsMenu };
  }
})();
