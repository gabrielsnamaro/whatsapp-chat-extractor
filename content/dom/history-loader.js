/**
 * HistoryLoader
 * Responsabilidade Única: Carregar as mensagens mais antigas da conversa aberta antes da exportação, pelo aviso "Clique
 * neste aviso para carregar mensagens mais antigas do seu celular." do topo do painel de mensagens.
 *
 * A exportação do WhatsApp Web leva só as mensagens que o navegador já tem, e cada clique no aviso pede ao celular, que
 * precisa estar online, as anteriores às do painel. Sem o aviso no topo da conversa aberta, nada é feito.
 *
 * Os métodos que tocam na página (findPanel, readTop, markerOf, scrollToTop e click) ficam separados do laço da carga,
 * que os testes rodam com uma página simulada.
 */
(function registerHistoryLoader() {
  const {
    SELECTORS, TIMEOUTS, HISTORY_NOTICE_KINDS, HISTORY_LOAD_REASONS, classifyHistoryNotice, sleep, throwIfAborted, simulateClick
  } = window.DomUtils;

  // Rodadas seguidas sem resposta do celular antes de desistir: dois cliques no aviso, ou um clique e mais uma espera
  // com o indicador de carregamento no topo
  const MAX_ROUNDS_WITHOUT_PROGRESS = 2;
  // Leituras seguidas com a mesma primeira mensagem para o painel de uma conversa recém-aberta ser dado como desenhado:
  // a abertura termina quando o cabeçalho muda, e as mensagens e o aviso podem chegar depois
  const SETTLED_PANEL_READS = 2;

  /**
   * @typedef {Object} HistoryLoad Resultado da carga, como vai ao background
   * @property {number} clicks Cliques no aviso, cada um pedindo ao celular as mensagens anteriores às do painel
   * @property {number} ms Tempo da carga inteira
   * @property {string} reason Como ela terminou: um dos DomUtils.HISTORY_LOAD_REASONS
   * @property {string} [before] Com o reason 'phone-only' e a data no aviso: as mensagens anteriores a ela só estão no
   *   celular (a data como o WhatsApp Web a escreve, com o dia ou o mês primeiro)
   */

  /**
   * @typedef {Object} TopState O topo do painel de mensagens
   * @property {'load'|'phone-only'|null} kind O aviso de mensagens mais antigas (classifyHistoryNotice); null sem ele
   * @property {Element|null} clickable Onde clicar, no aviso 'load'
   * @property {string|null} before A data do aviso 'phone-only'
   * @property {boolean} busy Há outro texto ou um ícone no topo, sem nenhum dos avisos: o indicador de carregamento, que
   *   os snapshots não mostram
   */

  /**
   * Os elementos do topo do painel: os filhos dele antes do primeiro que é ou tem uma mensagem. Nos snapshots, um div vazio
   * e o do aviso; a lista de mensagens vem depois
   * @param {HTMLElement} panel
   * @returns {Element[]}
   */
  function topAreaOf(panel) {
    const area = [];
    for (const child of panel.children) {
      if (child.matches(SELECTORS.CONVERSATION_MESSAGE) || child.querySelector(SELECTORS.CONVERSATION_MESSAGE)) break;
      area.push(child);
    }
    return area;
  }

  /**
   * O elemento que rola o painel de mensagens: o próprio painel ou o ancestral mais próximo dele, até #main, com rolagem
   * vertical e conteúdo maior que ele. Os snapshots não trazem o CSS, então ele é procurado na página
   * @param {HTMLElement} panel
   * @returns {HTMLElement} O painel, quando nenhum rola
   */
  function findScroller(panel) {
    for (let element = panel; element; element = element.parentElement) {
      const { overflowY } = getComputedStyle(element);
      if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) return element;
      if (element.matches(SELECTORS.MAIN_CHAT)) break;
    }
    return panel;
  }

  class HistoryLoader {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita das esperas padrão (ms): `clickWaitMs` (resposta do celular depois de
     *   um clique no aviso), `scrollWaitMs` (mensagens ou aviso depois de levar o painel ao topo), `settleMs` (o painel da
     *   conversa recém-aberta ser desenhado) e `pollMs` (intervalo entre duas leituras do painel)
     */
    constructor(options = {}) {
      this.timeouts = {
        clickWaitMs: TIMEOUTS.HISTORY_CLICK_WAIT_MS,
        scrollWaitMs: TIMEOUTS.HISTORY_SCROLL_WAIT_MS,
        settleMs: TIMEOUTS.HISTORY_SETTLE_MS,
        pollMs: TIMEOUTS.HISTORY_POLL_MS,
        ...options.timeouts
      };
    }

    /**
     * @returns {HTMLElement|null} O painel de mensagens da conversa aberta
     */
    findPanel() {
      return document.querySelector(SELECTORS.CONVERSATION_MESSAGES_PANEL);
    }

    /**
     * Lê o topo do painel, sem clique nem espera
     * @param {HTMLElement} panel
     * @returns {TopState}
     */
    readTop(panel) {
      const area = topAreaOf(panel);
      for (const element of area) {
        const notice = classifyHistoryNotice(element.textContent);
        if (!notice) continue;
        const isLoad = notice.kind === HISTORY_NOTICE_KINDS.LOAD;
        return {
          kind: notice.kind,
          // O <button> dentro do elemento do aviso; o próprio elemento, quando ele mesmo é o botão
          clickable: isLoad ? (element.querySelector(SELECTORS.HISTORY_NOTICE_BUTTON) ?? element) : null,
          before: notice.before ?? null,
          busy: false
        };
      }
      const busy = area.some((element) => element.textContent.trim() !== '' || element.querySelector('svg, [role="progressbar"]'));
      return { kind: null, clickable: null, before: null, busy };
    }

    /**
     * A primeira mensagem do painel: muda quando mensagens mais antigas entram no topo. As que chegam embaixo, numa
     * conversa ativa, não a mudam
     * @param {HTMLElement} panel
     * @returns {string} O data-testid dela; vazio sem mensagem
     */
    markerOf(panel) {
      return panel.querySelector(SELECTORS.CONVERSATION_MESSAGE)?.getAttribute('data-testid') ?? '';
    }

    /**
     * @param {HTMLElement} panel
     */
    scrollToTop(panel) {
      findScroller(panel).scrollTop = 0;
    }

    /**
     * @param {Element} element
     */
    click(element) {
      simulateClick(element);
    }

    /**
     * Carrega as mensagens mais antigas da conversa aberta, só quando o aviso que as carrega está no topo do painel depois
     * de ele ser desenhado. Leva o painel ao topo, clica no aviso, espera as mensagens novas e repete até o aviso sumir
     * depois de mensagens novas, o WhatsApp Web avisar que as anteriores só estão no celular, o celular não responder em
     * duas rodadas seguidas ou `limitMs` estourar. Depois de mensagens novas sem o aviso de volta, o painel vai ao topo de
     * novo, para as que ainda faltam aparecerem. O aviso que some sem mensagens novas não encerra a carga: o pedido ainda
     * pode estar em andamento. Sem Escape: no WhatsApp real ele pode fechar a conversa.
     * @param {Object} params
     * @param {number} params.limitMs Limite da carga inteira, com a espera do painel (> 0)
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<HistoryLoad>}
     * @throws {Error} Limite inválido, ou painel de mensagens não encontrado
     */
    async load({ limitMs, signal } = {}) {
      if (typeof limitMs !== 'number' || !Number.isFinite(limitMs) || limitMs <= 0) {
        throw new Error(`limite inválido para carregar as mensagens mais antigas: ${String(limitMs)}`);
      }
      const startedAt = Date.now();
      const deadline = startedAt + limitMs;
      let clicks = 0;
      const finish = (reason, before = null) => ({
        clicks,
        ms: Date.now() - startedAt,
        reason,
        ...(reason === HISTORY_LOAD_REASONS.PHONE_ONLY && before ? { before } : {})
      });

      const settled = await this._waitForSettledPanel(deadline, signal);
      if (!settled) throw new Error('o painel de mensagens da conversa não foi encontrado');
      let { panel, top } = settled;
      if (top.kind === HISTORY_NOTICE_KINDS.PHONE_ONLY) return finish(HISTORY_LOAD_REASONS.PHONE_ONLY, top.before);
      if (top.kind !== HISTORY_NOTICE_KINDS.LOAD) return finish(HISTORY_LOAD_REASONS.NO_NOTICE);

      let roundsWithoutProgress = 0;
      while (true) {
        throwIfAborted(signal);
        if (top.kind === HISTORY_NOTICE_KINDS.PHONE_ONLY) return finish(HISTORY_LOAD_REASONS.PHONE_ONLY, top.before);
        if (Date.now() >= deadline) return finish(HISTORY_LOAD_REASONS.TIME_LIMIT);

        const startKind = top.kind;
        // Com o clique, o indicador de carregamento no topo ou uma rodada sem resposta antes, um pedido ao celular pode
        // estar em andamento, e a espera é a dele. Sem nada disso, a rolagem só espera as mensagens que o navegador já tem
        const waitingPhone = startKind === HISTORY_NOTICE_KINDS.LOAD || top.busy || roundsWithoutProgress > 0;
        const marker = this.markerOf(panel);
        this.scrollToTop(panel);
        if (startKind === HISTORY_NOTICE_KINDS.LOAD) {
          this.click(top.clickable);
          clicks++;
        }
        const waitMs = Math.min(waitingPhone ? this.timeouts.clickWaitMs : this.timeouts.scrollWaitMs, deadline - Date.now());
        const progressed = await this._waitForProgress(marker, startKind, waitMs, signal);
        panel = this.findPanel() ?? panel;
        top = this.readTop(panel);
        if (progressed) {
          roundsWithoutProgress = 0;
          continue;
        }
        // A rolagem depois de mensagens novas não trouxe mais nada, e o topo está vazio: as anteriores estão todas no painel
        if (!waitingPhone && !top.kind && !top.busy) return finish(HISTORY_LOAD_REASONS.NO_NOTICE);
        if (Date.now() >= deadline) return finish(HISTORY_LOAD_REASONS.TIME_LIMIT);
        if (++roundsWithoutProgress >= MAX_ROUNDS_WITHOUT_PROGRESS) return finish(HISTORY_LOAD_REASONS.STALLED);
      }
    }

    /**
     * Espera o painel da conversa recém-aberta ser desenhado: para assim que um dos avisos aparece no topo, quando a
     * primeira mensagem não muda em SETTLED_PANEL_READS releituras seguidas, ou em `settleMs` (sem passar de `deadline`)
     * @private
     * @param {number} deadline Fim do limite da carga
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ panel: HTMLElement, top: TopState }|null>} null quando o painel não apareceu
     */
    async _waitForSettledPanel(deadline, signal) {
      const settleDeadline = Math.min(Date.now() + this.timeouts.settleMs, deadline);
      let previousMarker = null;
      let stableReads = 0;
      while (true) {
        throwIfAborted(signal);
        const panel = this.findPanel();
        if (panel) {
          const top = this.readTop(panel);
          if (top.kind) return { panel, top };
          const marker = this.markerOf(panel);
          stableReads = marker && marker === previousMarker ? stableReads + 1 : 0;
          if (stableReads >= SETTLED_PANEL_READS) return { panel, top };
          previousMarker = marker;
          if (Date.now() >= settleDeadline) return { panel, top };
        } else if (Date.now() >= settleDeadline) {
          return null;
        }
        await sleep(this.timeouts.pollMs, signal);
      }
    }

    /**
     * Espera mensagens mais antigas no topo do painel ou um aviso diferente do de antes: o "só no celular" depois de um
     * clique, ou qualquer aviso no topo que estava sem ele. O aviso que só some depois de um clique não conta. A primeira
     * leitura vem depois de uma pausa, para a página reagir ao clique ou à rolagem
     * @private
     * @param {string} marker markerOf antes do clique ou da rolagem
     * @param {'load'|null} startKind O aviso do topo antes do clique ou da rolagem
     * @param {number} waitMs
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>} false quando nada mudou em `waitMs`
     */
    async _waitForProgress(marker, startKind, waitMs, signal) {
      const deadline = Date.now() + Math.max(0, waitMs);
      while (true) {
        await sleep(Math.max(0, Math.min(this.timeouts.pollMs, deadline - Date.now())), signal);
        const panel = this.findPanel();
        if (panel) {
          if (this.markerOf(panel) !== marker) return true;
          const { kind } = this.readTop(panel);
          if (kind && kind !== startKind) return true;
        }
        if (Date.now() >= deadline) return false;
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.HistoryLoader = HistoryLoader;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { HistoryLoader };
  }
})();
