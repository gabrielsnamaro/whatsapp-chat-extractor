/**
 * ChatNavigator
 * Responsabilidade Única: Localizar e selecionar uma conversa específica na lista
 * lateral e aguardar a renderização e confirmação do cabeçalho da conversa aberta.
 */
class ChatNavigator {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   */
  constructor(options = {}) {
    this.selectors = {
      container: '#pane-side',
      row: '[role="row"]',
      cell: '[role="row"] [data-testid="cell-frame-container"]',
      archivedButton: '[data-testid="chatlist-panel-archived-button"]',
      title: '[data-testid="cell-frame-title"]',
      mainHeader: '#main header',
      mainHeaderTitle: '#main header [data-testid="conversation-info-header-chat-title"]',
      mainHeaderTitleFallback: '#main header span[dir="auto"]',
      ...options.selectors
    };
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
   * Normaliza títulos para comparação exata: forma NFC, sem caracteres invisíveis
   * (inclusive seletores de variação de emoji), espaços colapsados e caixa baixa
   * @private
   * @param {string} str
   * @returns {string}
   */
  _normalizeTitle(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .normalize('NFC')
      .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\uFE0E\uFE0F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /**
   * Compara dois títulos por igualdade exata após normalização.
   * Comparação parcial foi descartada porque fazia "Ana" casar com "Mariana"
   * e exportar a conversa errada sob o nome da esperada.
   * @private
   * @param {string} candidateTitle
   * @param {string} targetTitle
   * @returns {boolean}
   */
  _isTitleMatch(candidateTitle, targetTitle) {
    const cleanCand = this._normalizeTitle(candidateTitle);
    const cleanTarg = this._normalizeTitle(targetTitle);
    return Boolean(cleanCand) && cleanCand === cleanTarg;
  }

  /**
   * Lê o texto visível de um elemento incluindo emojis, que o WhatsApp Web
   * renderiza como <img alt="🤓"> e por isso somem do textContent
   * @private
   * @param {HTMLElement} element
   * @returns {string}
   */
  _readTextWithEmojis(element) {
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
   * Retorna o título da conversa atualmente aberta no #main header
   * @returns {string|null}
   */
  getActiveChatTitle() {
    const headerTitleEl = document.querySelector(this.selectors.mainHeaderTitle) ||
                          document.querySelector(this.selectors.mainHeaderTitleFallback);
    if (!headerTitleEl) return null;
    return (headerTitleEl.getAttribute('title') || this._readTextWithEmojis(headerTitleEl)).trim() || null;
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

    const cells = pane.querySelectorAll(this.selectors.cell);
    for (const cell of cells) {
      if (!cell.closest(this.selectors.row)) continue;
      if (cell.closest(this.selectors.archivedButton)) continue;

      const titleEl = cell.querySelector(this.selectors.title);
      if (!titleEl) continue;

      // Mesma fonte usada pelo ChatListScanner: atributo title, com fallback para o texto com emojis
      const spanWithTitle = titleEl.querySelector('span[title]');
      const cellTitle = spanWithTitle?.getAttribute('title') || this._readTextWithEmojis(titleEl);

      if (this._isTitleMatch(cellTitle, targetTitle)) {
        return cell;
      }
    }
    return null;
  }

  /**
   * Localiza a célula da conversa no #pane-side com rolagem suave e limitada
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

    // 2. Volta ao topo inicial e aguarda renderização dos primeiros chats no DOM
    pane.scrollTop = 0;
    await this._sleep(300);

    // Checagem imediata após voltar ao topo (casos dos chats 1, 2, 3...)
    cell = this._findVisibleCellByTitle(targetTitle);
    if (cell) return cell;

    // 3. Busca progressiva com passos curtos (100px = ~1,3 linhas) para não pular nenhum chat
    const step = 100;
    const maxSearchSteps = 45; // Máximo de ~4500px de profundidade (evita qualquer loop infinito)
    let steps = 0;
    let lastScrollTop = -1;
    let consecutiveStall = 0;

    while (steps < maxSearchSteps) {
      steps++;
      pane.scrollTop += step;
      await this._sleep(150);

      cell = this._findVisibleCellByTitle(targetTitle);
      if (cell) return cell;

      if (pane.scrollTop === lastScrollTop) {
        consecutiveStall++;
        if (consecutiveStall >= 3) break;
      } else {
        consecutiveStall = 0;
      }
      lastScrollTop = pane.scrollTop;
    }

    // Sem fallback por posição: a lista é virtualizada e reordena com mensagens novas,
    // então clicar na N-ésima linha exportaria outra conversa sob o nome desta.
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

    // 1. Limpa qualquer menu ou modal aberto residualmente antes de navegar
    const openModal = document.querySelector('div[data-testid="export-chat-modal"]');
    const openMenu = document.querySelector('div[role="menu"]');
    if (openModal || openMenu) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await this._sleep(250);
    }

    // 2. Verifica se a conversa desejada já é a ativa atualmente
    const currentActiveTitle = this.getActiveChatTitle();
    if (currentActiveTitle && this._isTitleMatch(currentActiveTitle, targetTitle)) {
      return { success: true, title: targetTitle };
    }

    // 3. Localiza a célula da conversa no #pane-side por título exato
    const cellElement = await this._locateCellWithScroll(targetTitle);
    if (!cellElement) {
      throw new Error(`Conversa "${targetTitle}" não foi encontrada na lista lateral.`);
    }

    // 4. Centraliza o elemento de forma imediata (sem animação assíncrona)
    cellElement.scrollIntoView({ behavior: 'auto', block: 'center' });
    await this._sleep(150);

    // 5. Dispara clique simulado com coordenadas e foco
    this._simulateClick(cellElement);

    // 6. Aguarda confirmação no #main header (sem limite de timeout)
    let lastClickTime = Date.now();
    let attempts = 0;

    while (true) {
      attempts++;
      const activeTitle = this.getActiveChatTitle();

      if (activeTitle && this._isTitleMatch(activeTitle, targetTitle)) {
        // Aguarda renderização e estabilização do histórico da nova conversa no DOM
        await this._sleep(500);
        return { success: true, title: targetTitle };
      }

      // Se passou mais de 1.8s sem o cabeçalho atualizar para a nova conversa, re-tenta o clique
      if (Date.now() - lastClickTime > 1800) {
        this._simulateClick(cellElement);
        lastClickTime = Date.now();
      }

      // Fallback: se a célula já está selecionada nativamente e o cabeçalho existe após várias tentativas
      if (attempts > 25) {
        const header = document.querySelector(this.selectors.mainHeader);
        const isSelected = cellElement.getAttribute('aria-selected') === 'true' ||
                           cellElement.closest('[aria-selected="true"]') !== null;
        if (header && isSelected) {
          await this._sleep(500);
          return { success: true, title: targetTitle };
        }
      }

      await this._sleep(150);
    }
  }
}

if (typeof window !== 'undefined') {
  window.ChatNavigator = ChatNavigator;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatNavigator };
}
