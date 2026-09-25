/**
 * ExportModalHandler
 * Responsabilidade Única: Interagir com o modal de exportação nativo do WhatsApp Web,
 * selecionar o intervalo completo de mensagens e confirmar a geração do arquivo.
 */
class ExportModalHandler {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   */
  constructor(options = {}) {
    this.selectors = {
      modal: 'div[data-testid="export-chat-modal"]',
      modalFallback: 'div[role="dialog"], div[data-animate-modal-popup="true"]',
      radioAllMsgs: 'input#date-range-all',
      radioAllLabel: 'label[for="date-range-all"]',
      modalButtons: 'button, div[role="button"]',
      confirmText: 'Exportar',
      cancelText: 'Cancelar',
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
   * Aguarda a montagem do modal de exportação no DOM (sem limite de timeout)
   * @private
   * @returns {Promise<HTMLElement>}
   */
  async _waitForModal() {
    while (true) {
      // 1. Tenta pelo seletor específico testid
      const modal = document.querySelector(this.selectors.modal);
      if (modal && modal.offsetParent !== null) {
        return modal;
      }

      // 2. Fallback: procura por diálogos que contenham o botão de exportar ou radio de data
      const dialogs = document.querySelectorAll(this.selectors.modalFallback);
      for (const dialog of dialogs) {
        if (dialog.offsetParent !== null) {
          const hasConfirm = Array.from(dialog.querySelectorAll('button, div[role="button"]'))
            .some(b => (b.textContent || '').trim().toLowerCase() === this.selectors.confirmText.toLowerCase());
          const hasRadio = dialog.querySelector(this.selectors.radioAllMsgs) || dialog.querySelector(this.selectors.radioAllLabel);
          if (hasConfirm || hasRadio) {
            return dialog;
          }
        }
      }

      await this._sleep(150);
    }
  }

  /**
   * Garante a seleção da opção "Todas as mensagens" no modal
   * @private
   * @param {HTMLElement} modal
   * @returns {Promise<void>}
   */
  async _selectAllMessagesOption(modal) {
    const radio = modal.querySelector(this.selectors.radioAllMsgs);
    const label = modal.querySelector(this.selectors.radioAllLabel);

    if (radio && !radio.checked) {
      if (label) {
        label.click();
      } else {
        radio.click();
      }
      await this._sleep(150);
    }
  }

  /**
   * Localiza o botão de confirmação ("Exportar") dentro do modal
   * @private
   * @param {HTMLElement} modal
   * @returns {HTMLElement|null}
   */
  _findConfirmButton(modal) {
    const buttons = modal.querySelectorAll(this.selectors.modalButtons);
    for (const btn of buttons) {
      const text = btn.textContent.trim();
      if (text.toLowerCase() === this.selectors.confirmText.toLowerCase()) {
        return btn;
      }
    }

    // Fallback: geralmente o botão de ação principal é o último botão do rodapé
    if (buttons.length > 0) {
      return buttons[buttons.length - 1];
    }

    return null;
  }

  /**
   * Dispara a sequência real de eventos de mouse que o React escuta no WhatsApp Web
   * @private
   * @param {HTMLElement} element
   */
  _simulateClick(element) {
    if (!element) return;
    try { element.focus(); } catch (_) {}
    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const baseInit = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    try { element.dispatchEvent(new PointerEvent('pointerdown', { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { ...baseInit, button: 0, buttons: 1 })); } catch (_) {}
    try { element.dispatchEvent(new PointerEvent('pointerup', { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { ...baseInit, button: 0, buttons: 0 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('click', { ...baseInit, button: 0, buttons: 0 })); } catch (_) {}
    try { element.click(); } catch (_) {}
  }

  /**
   * Confirma a exportação no modal (seleciona todas as mensagens e clica em Exportar)
   * @returns {Promise<{ success: boolean }>}
   */
  async confirmExport() {
    const modal = await this._waitForModal();
    await this._sleep(200);

    // Seleciona opção "Todas as mensagens"
    await this._selectAllMessagesOption(modal);

    // Localiza e clica no botão "Exportar"
    const confirmBtn = this._findConfirmButton(modal);
    if (!confirmBtn) {
      throw new Error('Botão de confirmação de exportação não encontrado no modal.');
    }

    this._simulateClick(confirmBtn);

    // Aguarda o modal fechar ou iniciar processamento
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      const currentModal = document.querySelector(this.selectors.modal);
      if (!currentModal) {
        break;
      }
      await this._sleep(150);
    }

    return { success: true };
  }

  /**
   * Cancela a operação do modal caso necessário
   * @returns {Promise<void>}
   */
  async cancelExport() {
    const modal = document.querySelector(this.selectors.modal);
    if (!modal) return;

    const buttons = modal.querySelectorAll(this.selectors.modalButtons);
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase() === this.selectors.cancelText.toLowerCase()) {
        btn.click();
        return;
      }
    }

    // Fallback com tecla Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  }
}

if (typeof window !== 'undefined') {
  window.ExportModalHandler = ExportModalHandler;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExportModalHandler };
}
