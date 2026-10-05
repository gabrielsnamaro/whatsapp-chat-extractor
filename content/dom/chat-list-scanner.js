/**
 * ChatListScanner
 * Responsabilidade Única: Rolar o painel lateral (#pane-side) e identificar
 * a lista de conversas disponíveis com suporte a limites e desduplicação.
 */
(function registerChatListScanner() {
  const { SELECTORS, sleep, throwIfAborted, readCellTitle, normalizeTitle } = window.DomUtils;

  /**
   * Por que a varredura parou. Vão nas estatísticas da resposta ao background, que traduz cada código
   * na linha da varredura do relatório (background/extraction-orchestrator.js).
   */
  const STOP_REASONS = Object.freeze({
    END_OF_LIST: 'end-of-list',
    SCROLL_STALLED: 'scroll-stalled',
    LIMIT_REACHED: 'limit-reached',
    TIME_LIMIT: 'time-limit'
  });

  // O background espera a varredura numa única chamada à aba, e o Chrome encerra o service worker
  // quando uma chamada passa de 5 min
  const MAX_DURATION_MS = 4 * 60 * 1000;

  class ChatListScanner {
    /**
     * @param {Object} [options]
     * @param {number} [options.scrollDelayMs=250] Tempo de espera para renderização virtual a cada passo
     * @param {number} [options.initialRenderDelayMs=500] Espera depois de voltar a lista ao topo, antes da 1ª leitura
     * @param {number} [options.settleMs=2500] Tempo no fim da lista sem conversa nova, ou com a rolagem travada, para encerrar
     * @param {number} [options.maxDurationMs=240000] Teto de duração da varredura inteira
     * @param {number} [options.progressIntervalMs=500] Intervalo mínimo entre dois avisos de progresso
     */
    constructor(options = {}) {
      this.scrollDelayMs = options.scrollDelayMs ?? 250;
      this.initialRenderDelayMs = options.initialRenderDelayMs ?? 500;
      // No fim da lista o WhatsApp ainda pode estar carregando as conversas mais antigas, e ~1 s sem
      // novidade (o critério anterior, 4 passos de 250 ms) podia encerrar antes de elas aparecerem
      this.settleMs = options.settleMs ?? 2500;
      this.maxDurationMs = options.maxDurationMs ?? MAX_DURATION_MS;
      this.progressIntervalMs = options.progressIntervalMs ?? 500;
    }

    /**
     * Obtém o elemento do container lateral #pane-side
     * @returns {HTMLElement|null}
     */
    getPaneElement() {
      return document.querySelector(SELECTORS.PANE_SIDE);
    }

    /**
     * Extrai os dados das conversas que estão visíveis no DOM no momento
     * @returns {Array<{ id: string, title: string, unread: string|null, timestamp: string|null }>}
     */
    getVisibleChats() {
      const pane = this.getPaneElement();
      if (!pane) return [];

      const chats = [];
      pane.querySelectorAll(SELECTORS.CHAT_CELL).forEach((cell) => {
        // Ignora botões/pastas fora da grade virtual de conversas (ex: Arquivadas)
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) return;

        const title = readCellTitle(cell);
        if (!title) return;

        // Conversas reais possuem histórico/prévia ou marcação de tempo
        const timestampEl = cell.querySelector(SELECTORS.CHAT_TIMESTAMP);
        if (!cell.querySelector(SELECTORS.CHAT_LAST_MESSAGE) && !timestampEl) return;

        const unreadEl = cell.querySelector(SELECTORS.CHAT_UNREAD_COUNT);
        chats.push({
          id: `chat_${title.replace(/\s+/g, '_')}`,
          title,
          unread: unreadEl ? unreadEl.textContent.trim() : null,
          timestamp: timestampEl ? timestampEl.textContent.trim() : null
        });
      });

      return chats;
    }

    /**
     * Data/hora exibida na conversa mais abaixo na tela entre as já lidas. No fim da lista é a da
     * última conversa (a mais antiga), que mostra no relatório até onde a varredura chegou.
     * @private
     * @param {HTMLElement} pane
     * @param {Set<string>} collectedKeys Títulos normalizados das conversas lidas
     * @returns {string|null}
     */
    _readLastChatTimestamp(pane, collectedKeys) {
      let last = null;
      for (const cell of pane.querySelectorAll(SELECTORS.CHAT_CELL)) {
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) continue;
        if (!collectedKeys.has(normalizeTitle(readCellTitle(cell)))) continue;
        // A posição na tela, e não a ordem no DOM: a lista virtual reaproveita as linhas fora de ordem
        const top = cell.getBoundingClientRect().top;
        if (!last || top >= last.top) last = { top, cell };
      }
      return last?.cell.querySelector(SELECTORS.CHAT_TIMESTAMP)?.textContent.trim() || null;
    }

    /**
     * Varre a lista do topo ao fim por scroll virtual no #pane-side, ou até o maxLimit. Para depois de
     * `settleMs` no fim da lista sem conversa nova, ou com a rolagem travada antes do fim, ou ao atingir
     * `maxDurationMs`.
     *
     * Títulos repetidos na mesma tela são homônimos (contatos diferentes com o mesmo nome)
     * e voltam marcados com `duplicateTitle: true`. Homônimos distantes na lista não são
     * detectáveis por aqui: a lista reordena durante a varredura e não expõe um id estável.
     *
     * @param {Object} [params]
     * @param {number|null} [params.maxLimit=null] Número máximo de conversas desejado
     * @param {function(number): void} [params.onProgress=null] Recebe o total encontrado até agora, no
     *   máximo uma vez a cada `progressIntervalMs` e sempre uma vez no fim
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{
     *   chats: Array<{ id: string, title: string, unread: string|null, timestamp: string|null, duplicateTitle: boolean }>,
     *   stats: { steps: number, durationMs: number, stopReason: string, lastChatTimestamp: string|null }
     * }>} `steps` conta só os passos em que a lista andou; `stopReason` é um dos STOP_REASONS
     */
    async scanAllChats({ maxLimit = null, onProgress = null, signal } = {}) {
      const pane = this.getPaneElement();
      if (!pane) {
        throw new Error(`Painel de conversas (${SELECTORS.PANE_SIDE}) não encontrado no DOM.`);
      }

      const startedAt = Date.now();
      const chatsMap = new Map();
      const duplicateKeys = new Set();
      const isLimitReached = () => Boolean(maxLimit) && chatsMap.size >= maxLimit;

      const collectCurrent = () => {
        let addedAny = false;
        const seenInSnapshot = new Set();

        for (const item of this.getVisibleChats()) {
          const key = normalizeTitle(item.title);
          if (seenInSnapshot.has(key)) duplicateKeys.add(key);
          seenInSnapshot.add(key);

          if (!chatsMap.has(key) && !isLimitReached()) {
            chatsMap.set(key, item);
            addedAny = true;
          }
        }
        return addedAny;
      };

      let lastProgressAt = -Infinity;
      let reportedCount = 0;
      const reportProgress = ({ final = false } = {}) => {
        if (typeof onProgress !== 'function') return;
        const now = Date.now();
        if (!final && (chatsMap.size === reportedCount || now - lastProgressAt < this.progressIntervalMs)) return;
        lastProgressAt = now;
        reportedCount = chatsMap.size;
        onProgress(chatsMap.size);
      };

      let steps = 0;
      let stopReason;
      let lastChatTimestamp;
      try {
        // A lista pode estar rolada até o meio (pelo usuário ou por uma execução anterior), e as
        // conversas acima de onde ela está ficariam de fora
        pane.scrollTop = 0;
        await sleep(this.initialRenderDelayMs, signal);
        collectCurrent();
        reportProgress();

        let idleSince = null;
        while (true) {
          throwIfAborted(signal);
          // Recalculado a cada passo: se a área visível encolher no meio (ex: DevTools aberto embaixo),
          // um passo fixo ficaria maior que a tela e pularia linhas da lista virtual sem aviso
          const step = Math.max(100, Math.floor(pane.clientHeight * 0.7));
          if (isLimitReached()) {
            stopReason = STOP_REASONS.LIMIT_REACHED;
            break;
          }
          if (Date.now() - startedAt >= this.maxDurationMs) {
            stopReason = STOP_REASONS.TIME_LIMIT;
            break;
          }

          const previousTop = pane.scrollTop;
          pane.scrollTop = previousTop + step;
          await sleep(this.scrollDelayMs, signal);
          const moved = pane.scrollTop !== previousTop;
          if (moved) steps++;

          const added = collectCurrent();
          reportProgress();

          const isAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5;
          if (added || (moved && !isAtBottom)) {
            idleSince = null;
            continue;
          }
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= this.settleMs) {
            stopReason = isAtBottom ? STOP_REASONS.END_OF_LIST : STOP_REASONS.SCROLL_STALLED;
            break;
          }
        }

        lastChatTimestamp = this._readLastChatTimestamp(pane, new Set(chatsMap.keys()));
      } finally {
        // Restaura o scroll para o topo para manter o estado visual
        pane.scrollTop = 0;
      }

      reportProgress({ final: true });
      const chats = Array.from(chatsMap.entries())
        .map(([key, item]) => ({ ...item, duplicateTitle: duplicateKeys.has(key) }));
      return {
        chats,
        stats: { steps, durationMs: Date.now() - startedAt, stopReason, lastChatTimestamp }
      };
    }
  }

  if (typeof window !== 'undefined') {
    window.ChatListScanner = ChatListScanner;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChatListScanner };
  }
})();
