/**
 * ChatOptionsMenu
 * Responsabilidade Única: Interagir com o menu contextual do cabeçalho da conversa aberta
 * e acionar a opção nativa "Exportar conversa".
 */
class ChatOptionsMenu {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   * @param {number} [options.timeoutMs=5000] Timeout máximo para abertura do menu
   */
  constructor(options = {}) {
    this.selectors = {
      mainHeader: '#main header',
      btnMoreOptions: '#main header button[aria-label="Mais opções"], #main header [role="button"][aria-label="Mais opções"]',
      menuContainer: 'div[role="menu"]',
      menuItemExport: 'div[role="menu"] button[role="menuitem"][aria-label="Exportar conversa"]',
      exportActionText: 'Exportar conversa',
      ...options.selectors
    };

    this.timeoutMs = options.timeoutMs ?? 5000;
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
   * Localiza o botão "Mais opções" no cabeçalho atual
   * @private
   * @returns {HTMLElement|null}
   */
  _findMoreOptionsButton() {
    return document.querySelector(this.selectors.btnMoreOptions);
  }

  /**
   * Aguarda a renderização do menu suspenso no DOM
   * @private
   * @returns {Promise<HTMLElement>}
   */
  async _waitForMenu() {
    const startTime = Date.now();
    while (Date.now() - startTime < this.timeoutMs) {
      const menu = document.querySelector(this.selectors.menuContainer);
      if (menu && menu.offsetParent !== null) {
        return menu;
      }
      await this._sleep(100);
    }
    throw new Error(`Timeout de ${this.timeoutMs}ms aguardando abertura do menu de opções.`);
  }

  /**
   * Localiza o item de exportação dentro do menu
   * @private
   * @param {HTMLElement} menu
   * @returns {HTMLElement|null}
   */
  _findExportMenuItem(menu) {
    // 1. Tenta por seletor semântico com aria-label
    let item = menu.querySelector(this.selectors.menuItemExport);
    if (item) return item;

    // 2. Busca por texto dentro dos itens de menu disponíveis
    const items = menu.querySelectorAll('[role="menuitem"], button');
    for (const el of items) {
      if (el.textContent.includes(this.selectors.exportActionText) || el.getAttribute('aria-label') === this.selectors.exportActionText) {
        return el;
      }
    }

    return null;
  }

  /**
   * Fecha o menu suspenso caso ele esteja aberto
   * @returns {void}
   */
  closeMenu() {
    const menu = document.querySelector(this.selectors.menuContainer);
    if (menu) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
  }

  /**
   * Clica no botão de opções e seleciona "Exportar conversa"
   * @returns {Promise<{ success: boolean }>}
   */
  async triggerExportOption() {
    const btn = this._findMoreOptionsButton();
    if (!btn) {
      throw new Error('Botão "Mais opções" não encontrado no cabeçalho da conversa.');
    }

    // Abre o menu de opções
    btn.click();

    // Aguarda o menu aparecer
    const menu = await this._waitForMenu();
    await this._sleep(150);

    // Localiza a opção de exportação
    const exportItem = this._findExportMenuItem(menu);
    if (!exportItem) {
      this.closeMenu();
      throw new Error('Opção "Exportar conversa" não disponível para esta conversa (ex: chat de avisos ou restrito).');
    }

    // Dispara clique na opção de exportação
    exportItem.click();
    await this._sleep(200);

    return { success: true };
  }
}

if (typeof window !== 'undefined') {
  window.ChatOptionsMenu = ChatOptionsMenu;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatOptionsMenu };
}
