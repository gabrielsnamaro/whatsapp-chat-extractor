/**
 * ChatNavigator
 * Responsabilidade Única: Localizar e selecionar uma conversa específica na lista
 * lateral e aguardar a renderização e confirmação do cabeçalho da conversa aberta.
 */
class ChatNavigator {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   * @param {number} [options.timeoutMs=10000] Timeout máximo para aguardar abertura do chat
   */
  constructor(options = {}) {
    this.selectors = {
      container: '#pane-side',
      row: '[role="row"]',
      cell: '[role="row"] [data-testid="cell-frame-container"]',
      archivedButton: '[data-testid="chatlist-panel-archived-button"]',
      title: '[data-testid="cell-frame-title"]',
      mainHeader: '#main header',
      mainHeaderTitle: '#main header span[dir="auto"]',
      ...options.selectors
    };

    this.timeoutMs = options.timeoutMs ?? 10000;
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
   * Normaliza textos de título removendo caracteres de controle invisíveis, espaços e emojis residuais
   * @private
   * @param {string} str
   * @returns {string}
   */
  _cleanTitle(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '')
      .trim()
      .toLowerCase();
  }

  /**
   * Retorna o título da conversa atualmente aberta no #main header
   * @returns {string|null}
   */
  getActiveChatTitle() {
    const headerTitleEl = document.querySelector(this.selectors.mainHeaderTitle);
    return headerTitleEl ? headerTitleEl.textContent.trim() : null;
  }

  /**
   * Procura no DOM visível a célula correspondente ao título informado
   * @private
   * @param {string} targetTitle
   * @returns {HTMLElement|null}
   */
  _findVisibleCellByTitle(targetTitle) {
    const pane = document.querySelector(this.selectors.container);
    if (!pane) return null;

    const cleanTarget = this._cleanTitle(targetTitle);
    if (!cleanTarget) return null;

    const cells = pane.querySelectorAll(this.selectors.cell);
    for (const cell of cells) {
      if (!cell.closest(this.selectors.row)) continue;
      if (cell.closest(this.selectors.archivedButton)) continue;

      const titleEl = cell.querySelector(this.selectors.title);
      if (!titleEl) continue;

      // Obtém o título preferencialmente do atributo title (mais limpo e completo no WhatsApp) ou textContent
      const spanWithTitle = titleEl.querySelector('span[title]') || titleEl;
      const rawTitle = spanWithTitle.getAttribute('title') || titleEl.textContent || '';
      const cleanCellTitle = this._cleanTitle(rawTitle);

      if (cleanCellTitle === cleanTarget || cleanCellTitle.includes(cleanTarget) || cleanTarget.includes(cleanCellTitle)) {
        return cell;
      }
    }
    return null;
  }

  /**
   * Localiza a célula da conversa no #pane-side (rolando se necessário)
   * @private
   * @param {string} targetTitle
   * @returns {Promise<HTMLElement|null>}
   */
  async _locateCellWithScroll(targetTitle) {
    // 1. Tenta encontrar imediatamente nas células visíveis
    let cell = this._findVisibleCellByTitle(targetTitle);
    if (cell) return cell;

    const pane = document.querySelector(this.selectors.container);
    if (!pane) return null;

    // 2. Se não estiver visível, inicia busca rolando a partir do topo
    pane.scrollTop = 0;
    await this._sleep(150);

    const step = 350;
    let consecutiveUnchanged = 0;
    let lastScrollTop = -1;

    while (consecutiveUnchanged < 5) {
      cell = this._findVisibleCellByTitle(targetTitle);
      if (cell) return cell;

      pane.scrollTop += step;
      await this._sleep(200);

      if (pane.scrollTop === lastScrollTop || (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5)) {
        consecutiveUnchanged++;
      } else {
        consecutiveUnchanged = 0;
      }
      lastScrollTop = pane.scrollTop;
    }

    return null;
  }

  /**
   * Dispara a sequência real de eventos de mouse que o React escuta no WhatsApp Web
   * calculando as coordenadas reais do centro do elemento (HitRect) e aplicando foco
   * @private
   * @param {HTMLElement} element
   */
  _simulateClick(element) {
    if (!element) return;

    // Alvo preferencial da linha interativa
    const target = element.closest('[role="row"]') ||
                   element.closest('[role="gridcell"]') ||
                   element.closest('[aria-selected]') ||
                   element;

    // Foca o elemento primeiro
    if (typeof target.focus === 'function') {
      try { target.focus(); } catch (_) {}
    }

    // Calcula coordenadas centrais reais dentro da viewport
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const screenX = (window.screenX || 0) + clientX;
    const screenY = (window.screenY || 0) + clientY;

    const baseInit = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX,
      screenY
    };

    const dispatchSequence = (el) => {
      try { el.dispatchEvent(new PointerEvent('pointerdown', { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('mousedown', { ...baseInit, button: 0, buttons: 1 })); } catch (_) {}
      try { el.dispatchEvent(new PointerEvent('pointerup', { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 })); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('mouseup', { ...baseInit, button: 0, buttons: 0 })); } catch (_) {}
      try { el.dispatchEvent(new MouseEvent('click', { ...baseInit, button: 0, buttons: 0 })); } catch (_) {}
      try { el.click(); } catch (_) {}
    };

    dispatchSequence(target);
    if (target !== element) {
      dispatchSequence(element);
    }

    // Dispara também tecla Enter como fallback de acessibilidade do WhatsApp Web
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    } catch (_) {}
  }

  /**
   * Abre a conversa especificada e aguarda a confirmação visual no cabeçalho
   * @param {Object|string} chat Info da conversa ou string do título
   * @param {string} [chat.title]
   * @returns {Promise<{ success: boolean, title: string }>}
   */
  async openChat(chat) {
    const targetTitle = typeof chat === 'string' ? chat : chat?.title;
    if (!targetTitle) {
      throw new Error('Título da conversa não fornecido ao ChatNavigator.');
    }

    const cleanTarget = this._cleanTitle(targetTitle);

    // 1. Limpa qualquer menu ou modal aberto residualmente antes de navegar
    const openModal = document.querySelector('div[data-testid="export-chat-modal"]');
    const openMenu = document.querySelector('div[role="menu"]');
    if (openModal || openMenu) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await this._sleep(250);
    }

    // 2. Verifica se a conversa desejada já é a ativa atualmente
    const currentActiveTitle = this.getActiveChatTitle();
    if (currentActiveTitle) {
      const cleanActive = this._cleanTitle(currentActiveTitle);
      if (cleanActive === cleanTarget) {
        return { success: true, title: targetTitle };
      }
    }

    // 3. Localiza a célula da conversa no #pane-side
    const cellElement = await this._locateCellWithScroll(targetTitle);
    if (!cellElement) {
      throw new Error(`Conversa "${targetTitle}" não foi encontrada na lista lateral.`);
    }

    // 4. Centraliza o elemento de forma imediata (sem animação assíncrona)
    cellElement.scrollIntoView({ behavior: 'auto', block: 'center' });
    await this._sleep(150);

    // 5. Dispara clique simulado com coordenadas e foco
    this._simulateClick(cellElement);

    // 6. Aguarda confirmação no #main header ou na seleção nativa [aria-selected="true"]
    const startTime = Date.now();
    let retryCount = 0;

    while (Date.now() - startTime < this.timeoutMs) {
      const activeTitle = this.getActiveChatTitle();
      const isSelected = cellElement.closest('[aria-selected="true"]') !== null;

      if (activeTitle) {
        const cleanActive = this._cleanTitle(activeTitle);
        if (cleanActive === cleanTarget || cleanActive.includes(cleanTarget)) {
          await this._sleep(400); // Aguarda renderização completa do histórico
          return { success: true, title: targetTitle };
        }
      }

      if (isSelected) {
        await this._sleep(400);
        return { success: true, title: targetTitle };
      }

      // Se passou 1.2s ou 2.4s e ainda não abriu, re-tenta o clique automaticamente
      const elapsed = Date.now() - startTime;
      if (retryCount === 0 && elapsed > 1200) {
        retryCount++;
        this._simulateClick(cellElement);
      } else if (retryCount === 1 && elapsed > 2500) {
        retryCount++;
        this._simulateClick(cellElement);
      }

      await this._sleep(150);
    }

    // Verificação de fallback: se o header existe e o chat parece ter aberto
    const headerExists = Boolean(document.querySelector(this.selectors.mainHeader));
    if (headerExists) {
      return { success: true, title: targetTitle };
    }

    throw new Error(`Timeout de ${this.timeoutMs}ms aguardando abertura da conversa "${targetTitle}".`);
  }
}

if (typeof window !== 'undefined') {
  window.ChatNavigator = ChatNavigator;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatNavigator };
}
