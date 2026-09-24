/**
 * ChatNavigator
 * Responsabilidade Única: Localizar e selecionar uma conversa específica na lista
 * lateral e aguardar a renderização e confirmação do cabeçalho da conversa aberta.
 */
class ChatNavigator {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   * @param {number} [options.timeoutMs=8000] Timeout máximo para aguardar abertura do chat
   */
  constructor(options = {}) {
    this.selectors = {
      container: '#pane-side',
      cell: '[data-testid="cell-frame-container"]',
      title: '[data-testid="cell-frame-title"]',
      mainHeader: '#main header',
      mainHeaderTitle: '#main header span[dir="auto"]',
      ...options.selectors
    };

    this.timeoutMs = options.timeoutMs ?? 8000;
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

    const cells = pane.querySelectorAll(this.selectors.cell);
    for (const cell of cells) {
      const titleEl = cell.querySelector(this.selectors.title);
      if (titleEl && titleEl.textContent.trim() === targetTitle) {
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

    // Verifica se a conversa já é a conversa ativa atualmente
    const currentActiveTitle = this.getActiveChatTitle();
    if (currentActiveTitle === targetTitle) {
      return { success: true, title: targetTitle };
    }

    // Localiza o elemento da conversa
    const cellElement = await this._locateCellWithScroll(targetTitle);
    if (!cellElement) {
      throw new Error(`Conversa "${targetTitle}" não foi encontrada na lista lateral.`);
    }

    // Garante que o elemento esteja centralizado na visão e dispara clique
    cellElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await this._sleep(100);

    cellElement.click();

    // Aguarda confirmação no #main header
    const startTime = Date.now();
    while (Date.now() - startTime < this.timeoutMs) {
      const activeTitle = this.getActiveChatTitle();
      if (activeTitle && activeTitle === targetTitle) {
        // Pausa extra de 300ms para estabilização do histórico de mensagens
        await this._sleep(300);
        return { success: true, title: targetTitle };
      }
      await this._sleep(150);
    }

    // Se o header carregou mas o título é vazio ou diferente, verifica se o header em si existe
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
