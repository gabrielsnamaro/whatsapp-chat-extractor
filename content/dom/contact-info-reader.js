/**
 * ContactInfoReader
 * Responsabilidade Única: Ler o telefone do contato no painel "Dados do contato" da conversa aberta: abre o
 * painel pelo cabeçalho da conversa, lê o número e fecha o painel.
 */
(function registerContactInfoReader() {
  const {
    SELECTORS, TIMEOUTS, CHAT_KINDS, DRAWER_PHONE_SOURCES, OperationCancelledError, OperationTimeoutError, formatSeconds,
    extractPhoneDigits, chooseDrawerPhone, waitFor, sleep, isVisible, simulateClick, pressEscape
  } = window.DomUtils;

  // Intervalo entre duas leituras do painel enquanto o conteúdo dele carrega
  const CONTENT_POLL_MS = 150;

  // Aviso da leitura que deu certo com o painel ainda aberto: os botões do cabeçalho da conversa continuam acessíveis
  // com ele aberto (snapshots contact_info_drawer), então a exportação segue
  const DRAWER_NOT_CLOSED_WARNING = 'o painel não fechou';

  /**
   * @typedef {Object} ContactInfo Leitura do painel
   * @property {'chat'|'group'|null} kind Pelo título do painel; null quando ele não é nenhum dos dois esperados
   * @property {string|null} phone Só os dígitos; null num grupo e quando o painel não dá um número
   * @property {string} [reason] Por que uma conversa individual ficou sem o número: o título do painel não é o esperado,
   *   ou a escolha do telefone (DomUtils.chooseDrawerPhone) não deu nenhum
   */

  /**
   * @typedef {ContactInfo & { source?: string }} DrawerInspection Leitura do painel com a origem do telefone escolhido
   *   (DomUtils.DRAWER_PHONE_SOURCES), que decide quando a releitura para
   */

  /**
   * @param {DrawerInspection} inspection
   * @returns {ContactInfo} A leitura sem a origem do telefone, que não vai ao background
   */
  function toContactInfo({ kind, phone, reason }) {
    return reason ? { kind, phone, reason } : { kind, phone };
  }

  /**
   * A leitura do painel não muda mais: é de grupo, o telefone veio do subtítulo, ou veio da conta comercial e é o mesmo
   * da leitura anterior. Os números fora do subtítulo podem aparecer aos poucos, e um que chegue depois muda a escolha
   * @param {DrawerInspection} current
   * @param {DrawerInspection|null} previous
   * @returns {boolean}
   */
  function isSettledInspection(current, previous) {
    if (current.kind === CHAT_KINDS.GROUP || current.source === DRAWER_PHONE_SOURCES.SUBTITLE) return true;
    return current.source === DRAWER_PHONE_SOURCES.BUSINESS_CARD &&
      previous?.source === DRAWER_PHONE_SOURCES.BUSINESS_CARD &&
      previous.phone === current.phone;
  }

  class ContactInfoReader {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita dos timeouts padrão (ms): `openMs` (o painel aparecer depois do
     *   clique no cabeçalho), `contentMs` (a releitura do painel já aberto enquanto o conteúdo dele carrega) e `closeMs`
     *   (o painel sumir depois de "Fechar")
     */
    constructor(options = {}) {
      this.timeouts = {
        openMs: TIMEOUTS.CONTACT_INFO_OPEN_MS,
        contentMs: TIMEOUTS.CONTACT_INFO_CONTENT_MS,
        closeMs: TIMEOUTS.CONTACT_INFO_CLOSE_MS,
        ...options.timeouts
      };
    }

    /**
     * @returns {HTMLElement|null} O painel aberto e visível
     */
    findDrawer() {
      const drawer = document.querySelector(SELECTORS.CONTACT_INFO_DRAWER);
      return isVisible(drawer) ? drawer : null;
    }

    /**
     * @param {HTMLElement} drawer
     * @returns {HTMLElement|null} O botão "Fechar" do cabeçalho do painel
     */
    findCloseButton(drawer) {
      return drawer.querySelector(SELECTORS.CONTACT_INFO_CLOSE_BUTTON);
    }

    /**
     * Lê o tipo e o telefone de um painel já aberto, sem clique nem espera. O número sai da escolha do
     * DomUtils.chooseDrawerPhone: o subtítulo, quando ele é só um telefone (contato não salvo), ou, no painel de uma
     * conta comercial, o número que todos os textos do painel que são só um telefone dão. Atributos não são lidos: o
     * "Bloquear +55 …" e o "Denunciar +55 …" ficam no aria-label dos botões.
     * @param {HTMLElement} drawer `[data-testid="chat-info-drawer"]`
     * @returns {ContactInfo}
     */
    readDrawer(drawer) {
      return toContactInfo(this._inspectDrawer(drawer));
    }

    /**
     * @private
     * @param {HTMLElement} drawer
     * @returns {DrawerInspection}
     */
    _inspectDrawer(drawer) {
      const title = (drawer.querySelector(SELECTORS.CONTACT_INFO_HEADER_TITLE)?.textContent ?? '').trim();
      // O painel de um grupo lista os números dos participantes, que não são o contato da conversa
      if (title === SELECTORS.CONTACT_INFO_GROUP_TEXT) return { kind: CHAT_KINDS.GROUP, phone: null };
      if (title !== SELECTORS.CONTACT_INFO_CHAT_TEXT) {
        return {
          kind: null,
          phone: null,
          reason: title ? `título do painel não reconhecido: "${title}"` : 'título do painel não encontrado'
        };
      }

      const choice = chooseDrawerPhone({
        subtitleText: drawer.querySelector(SELECTORS.CONTACT_INFO_SUBTITLE)?.textContent ?? null,
        phoneTexts: this._findPhoneTexts(drawer),
        businessCardPresent: Boolean(drawer.querySelector(SELECTORS.CONTACT_INFO_BUSINESS_CARD))
      });
      return { kind: CHAT_KINDS.CHAT, ...choice };
    }

    /**
     * @private
     * @param {HTMLElement} drawer
     * @returns {string[]} Os nós de texto do painel que são só um telefone, na ordem do documento
     */
    _findPhoneTexts(drawer) {
      const phoneTexts = [];
      const walker = drawer.ownerDocument.createTreeWalker(drawer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (extractPhoneDigits(node.nodeValue)) phoneTexts.push(node.nodeValue);
      }
      return phoneTexts;
    }

    /**
     * Abre o painel pelo cabeçalho da conversa aberta, lê o tipo e o telefone (readDrawer) e fecha o painel. Um
     * painel que já estava aberto é fechado antes, porque pode ser de outra conversa.
     * @param {Object} [params]
     * @param {AbortSignal} [params.signal] O cancelamento interrompe a leitura e tenta fechar o painel
     * @returns {Promise<ContactInfo & { ms: number, warning?: string }>} `ms` é o tempo da leitura inteira, com a
     *   abertura e o fechamento; `warning`, quando o painel não fechou
     * @throws {Error} Painel que não abriu, cabeçalho da conversa não encontrado ou painel anterior que não fechou
     */
    async read({ signal } = {}) {
      const startedAt = Date.now();
      try {
        if (this.findDrawer() && !(await this._close(signal))) {
          throw new Error("um painel 'Dados do contato' já estava aberto e não fechou");
        }

        const header = document.querySelector(SELECTORS.CONVERSATION_INFO_HEADER);
        if (!header) {
          throw new Error("o cabeçalho da conversa, que abre o painel 'Dados do contato', não foi encontrado");
        }
        simulateClick(header);

        let drawer;
        try {
          drawer = await waitFor(() => this.findDrawer(), {
            timeoutMs: this.timeouts.openMs,
            description: "a abertura do painel 'Dados do contato'",
            signal
          });
        } catch (err) {
          if (!(err instanceof OperationTimeoutError)) throw err;
          throw new OperationTimeoutError(`o painel 'Dados do contato' não abriu em ${formatSeconds(this.timeouts.openMs)}`);
        }

        const info = await this._readWhenLoaded(drawer, signal);
        const closed = await this._close(signal);
        return { ...info, ms: Date.now() - startedAt, ...(closed ? {} : { warning: DRAWER_NOT_CLOSED_WARNING }) };
      } catch (err) {
        if (err instanceof OperationCancelledError) this._closeWithoutWaiting();
        throw err;
      }
    }

    /**
     * Relê o painel até `contentMs` e fica com a última leitura. Para antes quando ela não muda mais
     * (isSettledInspection): o tipo de grupo, o telefone do subtítulo, ou o da conta comercial em duas leituras seguidas
     * iguais
     * @private
     * @param {HTMLElement} drawer
     * @param {AbortSignal} [signal]
     * @returns {Promise<ContactInfo>}
     */
    async _readWhenLoaded(drawer, signal) {
      const deadline = Date.now() + this.timeouts.contentMs;
      let previous = null;
      let current = this._inspectDrawer(drawer);
      while (!isSettledInspection(current, previous) && Date.now() < deadline) {
        await sleep(CONTENT_POLL_MS, signal);
        previous = current;
        current = this._inspectDrawer(this.findDrawer() ?? drawer);
      }
      return toContactInfo(current);
    }

    /**
     * Fecha o painel pelo botão "Fechar". Sem Escape quando ele falha: no WhatsApp real o Escape pode fechar a
     * própria conversa, e a exportação seguinte falharia; com o painel aberto, ela segue (aviso DRAWER_NOT_CLOSED_WARNING)
     * @private
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>} Se o painel fechou
     */
    async _close(signal) {
      const drawer = this.findDrawer();
      if (!drawer) return true;

      const closeButton = this.findCloseButton(drawer);
      if (!closeButton) return false;
      simulateClick(closeButton);
      return this._waitUntilClosed(signal);
    }

    /**
     * @private
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>} false quando o painel continua aberto no fim do prazo
     */
    async _waitUntilClosed(signal) {
      try {
        await waitFor(() => !this.findDrawer(), {
          timeoutMs: this.timeouts.closeMs,
          description: "o fechamento do painel 'Dados do contato'",
          signal
        });
        return true;
      } catch (err) {
        if (err instanceof OperationTimeoutError) return false;
        throw err;
      }
    }

    /**
     * Na leitura cancelada, o painel não fica aberto atrás da próxima conversa; sem esperar, porque o cancelamento
     * interrompe as esperas
     * @private
     */
    _closeWithoutWaiting() {
      const drawer = this.findDrawer();
      if (!drawer) return;
      const closeButton = this.findCloseButton(drawer);
      if (closeButton) simulateClick(closeButton);
      else pressEscape();
    }
  }

  if (typeof window !== 'undefined') {
    window.ContactInfoReader = ContactInfoReader;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ContactInfoReader };
  }
})();
