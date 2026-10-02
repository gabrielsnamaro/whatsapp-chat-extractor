/**
 * ExportModalHandler
 * Responsabilidade Única: Interagir com o modal de exportação nativo do WhatsApp Web,
 * selecionar o intervalo completo de mensagens e confirmar a geração do arquivo.
 */
(function registerExportModalHandler() {
  const {
    SELECTORS, TIMEOUTS, ERROR_CODES, DomAutomationError, OperationTimeoutError, waitFor, sleep, throwIfAborted, isVisible,
    simulateClick, pressEscape
  } = window.DomUtils;

  class ExportModalHandler {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita dos timeouts padrão (ms)
     */
    constructor(options = {}) {
      this.timeouts = {
        modalMs: TIMEOUTS.MODAL_MS,
        confirmButtonMs: TIMEOUTS.MODAL_CONFIRM_BUTTON_MS,
        modalCloseMs: TIMEOUTS.MODAL_CLOSE_MS,
        ...options.timeouts
      };
    }

    /**
     * Localiza o modal de exportação visível. O fallback por role="dialog" só aceita diálogos com um
     * rádio de intervalo de datas ou o botão "Exportar", para não confundir com outros modais e ainda
     * achar o de exportação se o WhatsApp tirar o data-testid ou o rádio "Todas as mensagens".
     * @returns {HTMLElement|null}
     */
    findModal() {
      const modal = document.querySelector(SELECTORS.EXPORT_MODAL);
      if (isVisible(modal)) return modal;

      for (const dialog of document.querySelectorAll(SELECTORS.EXPORT_MODAL_FALLBACK)) {
        if (!isVisible(dialog)) continue;
        if (dialog.querySelector(SELECTORS.EXPORT_DATE_RANGE_RADIOS) || this.findButtonByText(dialog, SELECTORS.EXPORT_CONFIRM_TEXT)) {
          return dialog;
        }
      }
      return null;
    }

    /**
     * Garante a seleção da opção "Todas as mensagens" no modal. Sem o rádio dela, um outro intervalo
     * marcado exportaria só parte da conversa: o modal é cancelado e a conversa falha. Sem nenhum
     * intervalo marcado, a exportação segue, mas sem a confirmação de que vem completa.
     * @private
     * @param {HTMLElement} modal
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>} Se "Todas as mensagens" ficou confirmada
     */
    async _selectAllMessagesOption(modal, signal) {
      const radio = modal.querySelector(SELECTORS.EXPORT_RADIO_ALL_MSGS);
      if (!radio) {
        const otherRangeChecked = [...modal.querySelectorAll(SELECTORS.EXPORT_DATE_RANGE_RADIOS)].some((input) => input.checked);
        if (otherRangeChecked) {
          this.cancelExport();
          throw new DomAutomationError(
            ERROR_CODES.DATE_RANGE_NOT_ALL,
            'O modal de exportação não oferece "Todas as mensagens" e está com outro intervalo de datas marcado; a conversa não foi exportada para não sair incompleta.'
          );
        }
        return false;
      }
      if (radio.checked) return true;

      const label = modal.querySelector(SELECTORS.EXPORT_RADIO_ALL_LABEL);
      (label || radio).click();
      await sleep(150, signal);

      if (!radio.checked) {
        throw new Error('Não foi possível selecionar "Todas as mensagens" no modal de exportação.');
      }
      return true;
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
     * @returns {Promise<{ success: boolean, allMessagesConfirmed: boolean }>} `allMessagesConfirmed` é false
     *   quando o modal não tinha a opção "Todas as mensagens" nem outro intervalo marcado
     */
    async confirmExport({ signal, onBeforeConfirm } = {}) {
      const modal = await waitFor(() => this.findModal(), {
        timeoutMs: this.timeouts.modalMs,
        description: 'o modal "Exportar conversa"',
        signal
      });

      // Esperar o botão, e não um tempo fixo, garante que o conteúdo do modal (rádios e botões) já renderizou
      let confirmBtn;
      try {
        confirmBtn = await waitFor(() => this.findButtonByText(modal, SELECTORS.EXPORT_CONFIRM_TEXT), {
          timeoutMs: this.timeouts.confirmButtonMs,
          description: 'o botão "Exportar" no modal de exportação',
          signal
        });
      } catch (err) {
        if (!(err instanceof OperationTimeoutError)) throw err;
        this.cancelExport();
        throw new Error('Botão "Exportar" não encontrado no modal de exportação.');
      }

      const allMessagesConfirmed = await this._selectAllMessagesOption(modal, signal);

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

      return { success: true, allMessagesConfirmed };
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
