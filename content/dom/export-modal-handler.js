/**
 * ExportModalHandler
 * Responsabilidade Única: Interagir com o modal de exportação nativo do WhatsApp Web,
 * selecionar o intervalo completo de mensagens e confirmar a geração do arquivo.
 */
(function registerExportModalHandler() {
  const { SELECTORS, TIMEOUTS, waitFor, sleep, throwIfAborted, isVisible, simulateClick, pressEscape } = window.DomUtils;

  class ExportModalHandler {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita dos timeouts padrão (ms)
     */
    constructor(options = {}) {
      this.timeouts = {
        modalMs: TIMEOUTS.MODAL_MS,
        modalCloseMs: TIMEOUTS.MODAL_CLOSE_MS,
        ...options.timeouts
      };
    }

    /**
     * Localiza o modal de exportação visível. O fallback por role="dialog" só aceita
     * diálogos que contenham o rádio "Todas as mensagens", para não confundir com outros modais.
     * @returns {HTMLElement|null}
     */
    findModal() {
      const modal = document.querySelector(SELECTORS.EXPORT_MODAL);
      if (isVisible(modal)) return modal;

      for (const dialog of document.querySelectorAll(SELECTORS.EXPORT_MODAL_FALLBACK)) {
        if (isVisible(dialog) && dialog.querySelector(SELECTORS.EXPORT_RADIO_ALL_MSGS)) {
          return dialog;
        }
      }
      return null;
    }

    /**
     * Garante a seleção da opção "Todas as mensagens" no modal
     * @private
     * @param {HTMLElement} modal
     * @param {AbortSignal} [signal]
     */
    async _selectAllMessagesOption(modal, signal) {
      const radio = modal.querySelector(SELECTORS.EXPORT_RADIO_ALL_MSGS);
      if (!radio || radio.checked) return;

      const label = modal.querySelector(SELECTORS.EXPORT_RADIO_ALL_LABEL);
      (label || radio).click();
      await sleep(150, signal);

      if (!radio.checked) {
        throw new Error('Não foi possível selecionar "Todas as mensagens" no modal de exportação.');
      }
    }

    /**
     * Localiza um botão do modal pelo texto exato
     * @param {HTMLElement} modal
     * @param {string} text
     * @returns {HTMLElement|null}
     */
    findButtonByText(modal, text) {
      const wanted = text.toLowerCase();
      for (const btn of modal.querySelectorAll(SELECTORS.EXPORT_MODAL_BUTTONS)) {
        if ((btn.textContent || '').trim().toLowerCase() === wanted) {
          return btn;
        }
      }
      return null;
    }

    /**
     * Confirma a exportação no modal (seleciona todas as mensagens e clica em Exportar)
     * @param {Object} [params]
     * @param {AbortSignal} [params.signal]
     * @param {function(): Promise<void>} [params.onBeforeConfirm] Aguardado imediatamente antes do clique em
     *   "Exportar"; se falhar (ou a operação for cancelada enquanto isso), o modal é cancelado sem o clique
     *   e o erro é relançado. Depois dele o botão é localizado de novo no modal atual; se não estiver mais
     *   lá, o modal é cancelado sem o clique e a exportação falha
     * @returns {Promise<{ success: boolean }>}
     */
    async confirmExport({ signal, onBeforeConfirm } = {}) {
      const modal = await waitFor(() => this.findModal(), {
        timeoutMs: this.timeouts.modalMs,
        description: 'o modal "Exportar conversa"',
        signal
      });
      await sleep(200, signal);

      await this._selectAllMessagesOption(modal, signal);

      const confirmBtn = this.findButtonByText(modal, SELECTORS.EXPORT_CONFIRM_TEXT);
      if (!confirmBtn) {
        this.cancelExport();
        throw new Error('Botão "Exportar" não encontrado no modal de exportação.');
      }

      let buttonToClick = confirmBtn;
      if (onBeforeConfirm) {
        try {
          await onBeforeConfirm();
          throwIfAborted(signal);
        } catch (err) {
          this.cancelExport();
          throw err;
        }

        // O callback vai ao background e volta: nesse tempo o modal pode ter sido redesenhado, e um
        // clique no botão antigo, já fora da página, não exportaria nada
        const currentModal = this.findModal();
        buttonToClick = currentModal && this.findButtonByText(currentModal, SELECTORS.EXPORT_CONFIRM_TEXT);
        if (!buttonToClick) {
          this.cancelExport();
          throw new Error('Botão "Exportar" não encontrado no modal de exportação depois de armar a captura do arquivo.');
        }
      }

      // Clique único e sem retentativa: um segundo clique geraria um segundo download
      simulateClick(buttonToClick);

      // Aguarda o modal fechar; se continuar aberto, segue mesmo assim (a captura do arquivo tem timeout próprio)
      try {
        await waitFor(() => !this.findModal(), {
          timeoutMs: this.timeouts.modalCloseMs,
          description: 'o fechamento do modal de exportação',
          signal
        });
      } catch (err) {
        if (err instanceof window.DomUtils.OperationCancelledError) throw err;
      }

      return { success: true };
    }

    /**
     * Cancela a operação do modal caso necessário
     */
    cancelExport() {
      const modal = this.findModal();
      if (!modal) return;

      const cancelBtn = this.findButtonByText(modal, SELECTORS.EXPORT_CANCEL_TEXT);
      if (cancelBtn) {
        cancelBtn.click();
        return;
      }
      pressEscape();
    }
  }

  if (typeof window !== 'undefined') {
    window.ExportModalHandler = ExportModalHandler;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ExportModalHandler };
  }
})();
