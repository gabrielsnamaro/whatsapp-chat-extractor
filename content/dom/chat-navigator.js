/**
 * ChatNavigator
 * Responsabilidade Única: Localizar e selecionar uma conversa específica na lista
 * lateral e aguardar a renderização e confirmação do cabeçalho da conversa aberta.
 */
(function registerChatNavigator() {
  const {
    SELECTORS, TIMEOUTS, ERROR_CODES, LOCATE_FAILURES, OperationTimeoutError, DomAutomationError,
    buildChatNotFoundMessage, estimateScrollStart, estimateNearbyTop, countAnimationFrames, waitFor, sleep, throwIfAborted,
    simulateClick, pressEscape, isVisible, readTextWithEmojis, readCellTitle, normalizeTitle, isTitleMatch
  } = window.DomUtils;

  // Motivo da parada da rolagem de abertura que achou a conversa, no diagnóstico, ao lado dos
  // LOCATE_FAILURES da rolagem; o background traduz os dois (background/extraction-orchestrator.js)
  const SCROLL_FOUND = 'found';

  const SCROLL_LIMITS = new Set([LOCATE_FAILURES.SCROLL_TIME_LIMIT, LOCATE_FAILURES.SCROLL_STEP_LIMIT]);

  // Folga do limite de passos da rolagem de abertura, além das duas descidas pela lista inteira: cobre o
  // arredondamento de cada descida e a lista que muda um pouco durante a rolagem (~4 s com a espera de 200 ms)
  const OPEN_SCROLL_STEP_SLACK = 20;

  // Tentativa perto da posição estimada, antes da busca: a linha estimada fica uma linha abaixo do topo da tela, e, sem
  // achar a conversa ali, a lista desce mais um passo (estimateNearbyTop)
  const NEARBY_ROWS_ABOVE = 1;
  const NEARBY_EXTRA_STEPS = 1;

  /**
   * @typedef {Object} OpenDiagnostics Como foi uma abertura que precisou da posição estimada, da busca e/ou da rolagem; só
   *   traz os campos da fase que rodou
   * @property {number} [nearbyMs] Da ida à posição estimada da conversa na lista até achá-la, ou até desistir dela
   * @property {boolean} [nearbyFound] A conversa estava perto da posição estimada
   * @property {number} [searchMs] Da busca digitada até a conversa aparecer, ou até o prazo esgotar
   * @property {number} [searchCellsSeen] Células de conversa na lista lateral nesse momento
   * @property {boolean} [searchExited] A lista normal voltou depois de sair da busca (exitSearch)
   * @property {boolean} [searchTyped] Só na busca sem resultado: a caixa tinha o título digitado quando o prazo esgotou
   * @property {boolean} [searchGridShown] Só na busca sem resultado: a grade da lista normal continuava na tela, como se
   *   a busca não tivesse começado
   * @property {number} [searchFrames] Só na busca sem resultado: quadros que a página desenhou durante a espera (0 quando o
   *   navegador deixou de desenhá-la); ausente sem requestAnimationFrame
   * @property {boolean} [windowFocused] Só na busca sem resultado: a janela da aba tinha o foco quando o prazo esgotou
   * @property {number} [scrollSteps] Passos em que a lista andou, nas duas descidas somadas
   * @property {number} [scrollMs] Duração da rolagem inteira
   * @property {boolean} [scrollHeightGrew] A altura da lista aumentou durante a rolagem
   * @property {string} [scrollStopReason] SCROLL_FOUND ou o LOCATE_FAILURES da rolagem
   * @property {number} [scrollTitlesSeen] Títulos diferentes que passaram pela lista durante a rolagem: perto do número de
   *   linhas de uma tela quando a lista virtual não redesenhou as linhas ao rolar
   */

  class ChatNavigator {
    /**
     * @param {Object} [options]
     * @param {Object} [options.timeouts] Sobrescrita dos timeouts padrão (ms): `openChatMs`, `searchResultsMs`,
     *   `openScrollMs` (teto da rolagem de abertura) e `searchExitMs` (espera da lista normal depois da busca)
     * @param {number} [options.scrollDelayMs=200] Espera de renderização da lista virtual a cada passo
     * @param {number} [options.jumpRenderMs=300] Espera de renderização da lista virtual depois de um salto da rolagem
     */
    constructor(options = {}) {
      this.timeouts = {
        openChatMs: TIMEOUTS.OPEN_CHAT_MS,
        searchResultsMs: TIMEOUTS.SEARCH_RESULTS_MS,
        openScrollMs: TIMEOUTS.OPEN_SCROLL_MS,
        searchExitMs: TIMEOUTS.SEARCH_EXIT_MS,
        ...options.timeouts
      };
      this.scrollDelayMs = options.scrollDelayMs ?? 200;
      this.jumpRenderMs = options.jumpRenderMs ?? 300;
    }

    /**
     * Retorna o título da conversa atualmente aberta no #main header
     * @returns {string|null}
     */
    getActiveChatTitle() {
      const headerTitleEl = document.querySelector(SELECTORS.MAIN_HEADER_TITLE) ||
                            document.querySelector(SELECTORS.MAIN_HEADER_TITLE_FALLBACK);
      if (!headerTitleEl) return null;
      return (headerTitleEl.getAttribute('title') || readTextWithEmojis(headerTitleEl)).trim() || null;
    }

    /**
     * Lista as células com título exato dentro de um contêiner
     * @private
     * @param {Element|null} root
     * @param {string} targetTitle
     * @returns {HTMLElement[]}
     */
    _findMatchingCells(root, targetTitle) {
      if (!root) return [];
      const matches = [];
      for (const cell of root.querySelectorAll(SELECTORS.CHAT_CELL)) {
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) continue;
        if (isTitleMatch(readCellTitle(cell), targetTitle)) {
          matches.push(cell);
        }
      }
      return matches;
    }

    /**
     * Procura no DOM visível da lista a célula correspondente ao título.
     * Duas células com o mesmo título ao mesmo tempo indicam homônimos: sem como
     * saber qual é a pedida, falha em vez de escolher uma arbitrariamente.
     * @param {string} targetTitle
     * @returns {HTMLElement|null}
     */
    findVisibleCellByTitle(targetTitle) {
      const matches = this._findMatchingCells(document.querySelector(SELECTORS.PANE_SIDE), targetTitle);
      if (matches.length > 1) {
        throw new DomAutomationError(
          ERROR_CODES.AMBIGUOUS_TITLE,
          `Há mais de uma conversa chamada "${targetTitle}"; não é possível escolher com segurança.`
        );
      }
      return matches[0] || null;
    }

    /**
     * @private
     * @returns {HTMLInputElement|HTMLElement|null}
     */
    _findSearchInput() {
      return document.querySelector(SELECTORS.SEARCH_INPUT);
    }

    /**
     * @private
     * @param {HTMLInputElement|HTMLElement} input
     * @returns {string}
     */
    _readSearchText(input) {
      return input instanceof HTMLInputElement ? input.value : input.textContent;
    }

    /**
     * Preenche a caixa de busca de forma que o React perceba a alteração
     * @private
     * @param {HTMLInputElement|HTMLElement} input
     * @param {string} text
     */
    _setSearchText(input, text) {
      input.focus();
      if (input instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
      // Versões antigas usavam um contenteditable no lugar do <input>
      document.execCommand('selectAll', false, null);
      document.execCommand(text ? 'insertText' : 'delete', false, text || null);
    }

    /**
     * Limpa a busca para devolver a lista lateral ao estado normal
     */
    clearSearch() {
      const input = this._findSearchInput();
      if (!input) return;
      if (this._readSearchText(input)) {
        this._setSearchText(input, '');
      }
    }

    /**
     * Células de conversa na lista lateral agora (a lista normal ou os resultados da busca), sem a pasta "Arquivadas"
     * @private
     * @returns {number}
     */
    _countSideCells() {
      const side = document.querySelector(SELECTORS.SIDE_PANEL);
      if (!side) return 0;
      return [...side.querySelectorAll(SELECTORS.CHAT_CELL)].filter((cell) => !cell.closest(SELECTORS.ARCHIVED_BUTTON)).length;
    }

    /**
     * A lista lateral voltou ao normal: caixa de busca vazia e a grade da lista de conversas na tela
     * @private
     * @returns {boolean}
     */
    _isNormalListShown() {
      const input = this._findSearchInput();
      if (input && this._readSearchText(input)) return false;
      return isVisible(document.querySelector(SELECTORS.CHAT_LIST_GRID));
    }

    /**
     * Sai do modo de busca da lista lateral: Escape com o foco na caixa de busca (só quando nenhuma conversa
     * acabou de ser aberta pela busca), o texto limpo e a espera da lista normal voltar (caixa vazia e a grade
     * da lista de conversas na tela).
     * Antes só se limpava o texto, e na execução de 06/10/2026 as quatro aberturas por rolagem que levaram
     * 47 min vieram logo depois de uma conversa aberta pela busca; a hipótese é que a lista lateral ficava no
     * modo de busca. Uma lista que não volta no prazo não é erro: quem chama segue, e o diagnóstico registra.
     * @param {Object} [params]
     * @param {AbortSignal} [params.signal]
     * @param {boolean} [params.pressEscapeKey=true] Falso logo depois de abrir a conversa pela busca
     * @returns {Promise<boolean>} Se a lista normal voltou no prazo
     */
    async exitSearch({ signal, pressEscapeKey = true } = {}) {
      const input = this._findSearchInput();
      if (input) {
        input.focus();
        // Na caixa, e não no foco atual. Depois de abrir a conversa pela busca o Escape fica de fora: no
        // WhatsApp real ele pode fechar a conversa recém-aberta, e o teto da rolagem já limita o custo
        if (pressEscapeKey) pressEscape(input);
        if (this._readSearchText(input)) this._setSearchText(input, '');
      }
      try {
        await waitFor(() => this._isNormalListShown(), {
          timeoutMs: this.timeouts.searchExitMs,
          description: 'a lista de conversas voltar depois de sair da busca',
          intervalMs: 100,
          signal
        });
        return true;
      } catch (err) {
        if (err instanceof OperationTimeoutError) return false;
        throw err;
      }
    }

    /**
     * Devolve a lista lateral ao estado do início da execução antes da repescagem: uma falha anterior
     * pode ter deixado a busca preenchida, um menu ou modal aberto, ou a lista rolada até o meio
     */
    resetSidebar() {
      // Escape antes: um menu ou modal aberto ficaria por cima da busca que vai ser limpa
      pressEscape();
      this.clearSearch();
      const pane = document.querySelector(SELECTORS.PANE_SIDE);
      if (!pane) {
        throw new Error('Lista lateral (#pane-side) não encontrada para voltar ao topo.');
      }
      pane.scrollTop = 0;
    }

    /**
     * Localiza a conversa pela caixa de busca da lista lateral. Os resultados podem incluir
     * a seção de mensagens com o mesmo título; a seção de conversas vem primeiro, então usa a primeira.
     * Sem resultado no prazo, sai da busca (exitSearch) antes de devolver.
     * @private
     * @param {string} targetTitle
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ cell: HTMLElement|null, failure: Object|null, diagnostics: OpenDiagnostics|null }>}
     *   `failure` diz por que a célula não foi achada; `diagnostics` traz a busca (null sem a caixa de busca)
     */
    async _locateCellViaSearch(targetTitle, signal) {
      const input = this._findSearchInput();
      if (!input) {
        return { cell: null, failure: { via: 'search', reason: LOCATE_FAILURES.SEARCH_INPUT_MISSING }, diagnostics: null };
      }

      // Uma busca que tenha ficado na caixa (saída não confirmada) é limpa antes: com o mesmo texto, o React
      // não veria mudança e não refaria a busca
      if (this._readSearchText(input)) this._setSearchText(input, '');
      const startedAt = Date.now();
      const stopFrameCount = countAnimationFrames();
      this._setSearchText(input, targetTitle);
      const measure = () => ({ searchMs: Date.now() - startedAt, searchCellsSeen: this._countSideCells() });
      try {
        const cell = await waitFor(
          () => this._findMatchingCells(document.querySelector(SELECTORS.SIDE_PANEL), targetTitle)[0] || null,
          {
            timeoutMs: this.timeouts.searchResultsMs,
            description: `resultados da busca por "${targetTitle}"`,
            signal
          }
        );
        stopFrameCount();
        return { cell, failure: null, diagnostics: measure() };
      } catch (err) {
        const frames = stopFrameCount();
        if (!(err instanceof OperationTimeoutError)) throw err;
        // O que separa as causas de uma busca sem resultado: o texto não chegou à caixa, a busca não começou (a lista normal
        // continuou na tela) ou o navegador deixou de desenhar a página
        const diagnostics = { ...measure(), ...this._describeStalledSearch(targetTitle), ...(frames === null ? {} : { searchFrames: frames }) };
        // Antes da rolagem: no modo de busca, ela rolaria os resultados, e não a lista de conversas
        diagnostics.searchExited = await this.exitSearch({ signal });
        return {
          cell: null,
          failure: { via: 'search', reason: LOCATE_FAILURES.SEARCH_NO_RESULT, timeoutMs: this.timeouts.searchResultsMs },
          diagnostics
        };
      }
    }

    /**
     * Estado da lista lateral quando a busca esgota o prazo sem resultado
     * @private
     * @param {string} targetTitle
     * @returns {{ searchTyped: boolean, searchGridShown: boolean, windowFocused: boolean }}
     */
    _describeStalledSearch(targetTitle) {
      const input = this._findSearchInput();
      return {
        searchTyped: Boolean(input) && normalizeTitle(this._readSearchText(input)) === normalizeTitle(targetTitle),
        searchGridShown: isVisible(document.querySelector(SELECTORS.CHAT_LIST_GRID)),
        windowFocused: document.hasFocus()
      };
    }

    /**
     * Tenta achar a conversa perto de onde ela estava na varredura, antes da busca: leva a lista até a posição estimada
     * (posição na fila × altura de uma linha; estimateNearbyTop) e, sem achar ali, desce mais um passo. Depois de uma
     * abertura pela busca, a lista lateral volta ao topo, e sem isto todas as conversas seguintes da fila, que já não
     * estavam na tela, iam para a busca (+0,8 s cada; na execução de 16/10/2026, da nº 111 até a última). A conversa achada
     * aqui deixa a lista no ponto da fila, e as seguintes voltam a ser achadas na tela.
     * @private
     * @param {string} targetTitle
     * @param {Object} [params]
     * @param {number} [params.queueIndex] Posição da conversa na fila da varredura
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ cell: HTMLElement|null, diagnostics: OpenDiagnostics }|null>} null quando a tentativa não roda:
     *   sem a posição na fila, sem a lista ou sem uma linha com altura para medir
     */
    async _locateCellNearEstimate(targetTitle, { queueIndex, signal } = {}) {
      if (!Number.isInteger(queueIndex) || queueIndex < 0) return null;
      const pane = document.querySelector(SELECTORS.PANE_SIDE);
      if (!pane) return null;
      const rowHeight = this._measureRowHeight(pane);
      if (!(rowHeight > 0)) return null;

      const startedAt = Date.now();
      pane.scrollTop = estimateNearbyTop({ index: queueIndex, rowHeight, rowsAbove: NEARBY_ROWS_ABOVE });
      await sleep(this.jumpRenderMs, signal);
      let cell = this.findVisibleCellByTitle(targetTitle);
      for (let step = 0; !cell && step < NEARBY_EXTRA_STEPS; step++) {
        const previousTop = pane.scrollTop;
        pane.scrollTop += this._scrollStepOf(pane);
        // No fim da lista não há mais o que descer
        if (pane.scrollTop === previousTop) break;
        await sleep(this.scrollDelayMs, signal);
        cell = this.findVisibleCellByTitle(targetTitle);
      }
      return { cell, diagnostics: { nearbyMs: Date.now() - startedAt, nearbyFound: Boolean(cell) } };
    }

    /**
     * Altura de uma linha da lista, medida na primeira conversa renderizada (a pasta "Arquivadas" fica
     * fora da grade e não conta)
     * @private
     * @param {HTMLElement} pane
     * @returns {number} 0 se nenhuma linha tiver altura
     */
    _measureRowHeight(pane) {
      for (const cell of pane.querySelectorAll(SELECTORS.CHAT_CELL)) {
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) continue;
        const height = cell.closest(SELECTORS.CHAT_ROW)?.getBoundingClientRect().height;
        if (height > 0) return height;
      }
      return 0;
    }

    /**
     * Junta os títulos das conversas desenhadas agora na lista, para o diagnóstico da rolagem
     * @private
     * @param {HTMLElement} pane
     * @param {Set<string>} titles Atualizado aqui, com os títulos normalizados
     */
    _collectTitles(pane, titles) {
      for (const cell of pane.querySelectorAll(SELECTORS.CHAT_CELL)) {
        if (cell.closest(SELECTORS.ARCHIVED_BUTTON)) continue;
        const title = normalizeTitle(readCellTitle(cell));
        if (title) titles.add(title);
      }
    }

    /**
     * Passo da rolagem de abertura: menor que a altura visível, para nenhuma linha da lista virtual ser pulada
     * @private
     * @param {HTMLElement} pane
     * @returns {number}
     */
    _scrollStepOf(pane) {
      return Math.max(100, Math.floor(pane.clientHeight * 0.7));
    }

    /**
     * Procura a conversa rolando a lista. Começa uma tela acima de onde ela estava na varredura (posição
     * na fila × altura de uma linha) e desce até o fim; sem achar ali (ela subiu na lista, por exemplo
     * ao receber uma mensagem) ou sem estimativa, varre a lista inteira a partir do topo.
     * As duas descidas somadas têm dois tetos: o tempo (`openScrollMs`) e um limite de passos proporcional
     * ao tamanho da lista, medido na entrada: os passos de duas descidas pela lista inteira, mais uma folga.
     * Uma lista normal termina as duas descidas antes deles; uma que não chega ao fim (cresce sem parar, ou
     * volta o scrollTop) é interrompida, e a conversa falha como não encontrada.
     * @private
     * @param {string} targetTitle
     * @param {Object} [params]
     * @param {number} [params.queueIndex] Posição da conversa na fila da varredura
     * @param {AbortSignal} [params.signal]
     * @returns {Promise<{ cell: HTMLElement|null, failure: Object|null, diagnostics: OpenDiagnostics }>} `failure` diz
     *   por que a célula não foi achada: um dos tetos ou o fim da varredura a partir do topo
     */
    async _locateCellWithScroll(targetTitle, { queueIndex, signal } = {}) {
      const startedAt = Date.now();
      const pane = document.querySelector(SELECTORS.PANE_SIDE);
      if (!pane) {
        return {
          cell: null,
          failure: { via: 'scroll', reason: LOCATE_FAILURES.LIST_MISSING },
          diagnostics: { scrollSteps: 0, scrollMs: 0, scrollHeightGrew: false, scrollStopReason: LOCATE_FAILURES.LIST_MISSING }
        };
      }

      const initialScrollHeight = pane.scrollHeight;
      // Medido na entrada, e não a cada passo: numa lista que cresce sem parar, o limite cresceria junto
      const budget = {
        deadline: startedAt + this.timeouts.openScrollMs,
        maxSteps: 2 * Math.ceil(initialScrollHeight / this._scrollStepOf(pane)) + OPEN_SCROLL_STEP_SLACK,
        steps: 0,
        maxScrollHeight: initialScrollHeight,
        titlesSeen: new Set()
      };
      const finish = ({ cell, failure }) => ({
        cell,
        failure,
        diagnostics: {
          scrollSteps: budget.steps,
          scrollMs: Date.now() - startedAt,
          scrollHeightGrew: budget.maxScrollHeight > initialScrollHeight,
          scrollStopReason: cell ? SCROLL_FOUND : failure.reason,
          scrollTitlesSeen: budget.titlesSeen.size
        }
      });

      const rowHeight = Number.isInteger(queueIndex) && queueIndex > 0 ? this._measureRowHeight(pane) : 0;
      const estimatedTop = rowHeight > 0
        ? estimateScrollStart({ index: queueIndex, rowHeight, viewportHeight: pane.clientHeight })
        : 0;
      if (estimatedTop > 0) {
        const nearby = await this._scrollDownFrom(pane, estimatedTop, targetTitle, budget, signal);
        // Os tetos valem para as duas descidas somadas: estourados na primeira, a segunda não começa
        if (nearby.cell || SCROLL_LIMITS.has(nearby.failure?.reason)) return finish(nearby);
      }
      return finish(await this._scrollDownFrom(pane, 0, targetTitle, budget, signal));
    }

    /**
     * Desce a lista a partir de `startTop` até o fim, ou até um dos tetos da rolagem. Passos menores que a
     * altura visível garantem que nenhuma linha da lista virtual seja pulada.
     * @private
     * @param {HTMLElement} pane
     * @param {number} startTop
     * @param {string} targetTitle
     * @param {{ deadline: number, maxSteps: number, steps: number, maxScrollHeight: number, titlesSeen: Set<string> }} budget
     *   Tetos e contagem da rolagem inteira (as duas descidas), atualizada aqui
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ cell: HTMLElement|null, failure: Object|null }>}
     */
    async _scrollDownFrom(pane, startTop, targetTitle, budget, signal) {
      pane.scrollTop = startTop;
      await sleep(this.jumpRenderMs, signal);
      budget.maxScrollHeight = Math.max(budget.maxScrollHeight, pane.scrollHeight);

      const step = this._scrollStepOf(pane);
      let consecutiveStall = 0;
      let steps = 0;

      while (true) {
        throwIfAborted(signal);
        this._collectTitles(pane, budget.titlesSeen);
        const cell = this.findVisibleCellByTitle(targetTitle);
        if (cell) return { cell, failure: null };

        if (Date.now() >= budget.deadline) {
          return {
            cell: null,
            failure: { via: 'scroll', reason: LOCATE_FAILURES.SCROLL_TIME_LIMIT, timeoutMs: this.timeouts.openScrollMs, steps: budget.steps }
          };
        }
        if (budget.steps >= budget.maxSteps) {
          return { cell: null, failure: { via: 'scroll', reason: LOCATE_FAILURES.SCROLL_STEP_LIMIT, steps: budget.steps } };
        }

        const previousTop = pane.scrollTop;
        pane.scrollTop += step;
        await sleep(this.scrollDelayMs, signal);
        budget.maxScrollHeight = Math.max(budget.maxScrollHeight, pane.scrollHeight);
        // Só conta o passo em que a lista andou: as tentativas paradas no fim não são rolagem
        if (pane.scrollTop !== previousTop) {
          steps++;
          budget.steps++;
        }

        const isAtBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 5;
        consecutiveStall = pane.scrollTop === previousTop || isAtBottom ? consecutiveStall + 1 : 0;
        if (consecutiveStall >= 3) {
          const lastCell = this.findVisibleCellByTitle(targetTitle);
          if (lastCell) return { cell: lastCell, failure: null };
          // A rolagem também para quando o scrollTop deixa de mudar antes do fim da lista
          const reason = isAtBottom ? LOCATE_FAILURES.END_OF_LIST : LOCATE_FAILURES.SCROLL_STALLED;
          return { cell: null, failure: { via: 'scroll', reason, steps } };
        }
      }
    }

    /**
     * Abre a conversa especificada e aguarda a confirmação visual no cabeçalho. Quando a busca ou a rolagem
     * rodam, `diagnostics` diz como foram; uma falha depois delas leva o mesmo objeto em
     * `error.openDiagnostics`, para a resposta ao background.
     * @param {Object|string} chat Info da conversa ou string do título
     * @param {string} [chat.title]
     * @param {Object} [params]
     * @param {AbortSignal} [params.signal]
     * @param {number} [params.queueIndex] Posição da conversa na fila da varredura, para procurá-la perto de onde ela
     *   estava, antes da busca, e para a rolagem começar perto dela
     * @returns {Promise<{ success: boolean, title: string, via: 'already-open'|'visible'|'nearby'|'search'|'scroll', diagnostics: OpenDiagnostics|null }>}
     */
    async openChat(chat, { signal, queueIndex } = {}) {
      const targetTitle = typeof chat === 'string' ? chat : chat?.title;
      if (!targetTitle) {
        throw new Error('Título da conversa não fornecido ao ChatNavigator.');
      }

      // 1. Fecha qualquer menu ou modal residual antes de navegar
      if (document.querySelector(SELECTORS.EXPORT_MODAL) || document.querySelector(SELECTORS.MENU_CONTAINER)) {
        pressEscape();
        await sleep(250, signal);
      }

      // 2. A conversa desejada já está aberta
      if (isTitleMatch(this.getActiveChatTitle(), targetTitle)) {
        return { success: true, title: targetTitle, via: 'already-open', diagnostics: null };
      }

      // 3. Localiza a célula: visível agora → perto da posição estimada → busca → rolagem da lista (a partir de uma tela
      // acima da posição estimada, depois inteira)
      let via = 'visible';
      /** @type {OpenDiagnostics} */
      const diagnostics = {};
      // A busca que achou a conversa só é desfeita depois do clique, que é numa célula dos resultados dela
      let exitSearchAfterOpen = false;
      try {
        let cellElement = this.findVisibleCellByTitle(targetTitle);
        const failedAttempts = [];
        if (!cellElement) {
          const nearby = await this._locateCellNearEstimate(targetTitle, { queueIndex, signal });
          if (nearby) {
            Object.assign(diagnostics, nearby.diagnostics);
            if (nearby.cell) {
              via = 'nearby';
              cellElement = nearby.cell;
            }
          }
        }
        if (!cellElement) {
          via = 'search';
          const search = await this._locateCellViaSearch(targetTitle, signal);
          cellElement = search.cell;
          exitSearchAfterOpen = Boolean(search.cell);
          Object.assign(diagnostics, search.diagnostics);
          if (search.failure) failedAttempts.push(search.failure);
        }
        if (!cellElement) {
          via = 'scroll';
          const scroll = await this._locateCellWithScroll(targetTitle, { queueIndex, signal });
          cellElement = scroll.cell;
          Object.assign(diagnostics, scroll.diagnostics);
          if (scroll.failure) failedAttempts.push(scroll.failure);
        }
        if (!cellElement) {
          throw new DomAutomationError(ERROR_CODES.CHAT_NOT_FOUND, buildChatNotFoundMessage(targetTitle, failedAttempts));
        }

        cellElement.scrollIntoView({ behavior: 'auto', block: 'center' });
        await sleep(150, signal);
        const previousHeaderTitle = this.getActiveChatTitle();
        simulateClick(cellElement);

        // 4. Aguarda o cabeçalho mostrar a conversa; re-tenta o clique a cada 2s (abrir chat é idempotente)
        let lastClickAt = Date.now();
        await waitFor(() => {
          if (isTitleMatch(this.getActiveChatTitle(), targetTitle)) return true;
          // A célula clicada tem título exato; se ela ficou selecionada, o chat aberto é ela. Mas só depois
          // que o cabeçalho deixar de mostrar a conversa anterior: sem isso, "Mais opções" seria clicado
          // no cabeçalho antigo e a conversa errada seria exportada com o nome desta
          const isSelected = cellElement.isConnected && cellElement.closest('[aria-selected="true"]') !== null;
          const headerTitle = this.getActiveChatTitle();
          const headerChanged = Boolean(headerTitle) && headerTitle !== previousHeaderTitle;
          return isSelected && headerChanged && Boolean(document.querySelector(SELECTORS.MAIN_HEADER));
        }, {
          timeoutMs: this.timeouts.openChatMs,
          description: `a abertura da conversa "${targetTitle}"`,
          signal,
          onTick: () => {
            if (Date.now() - lastClickAt > 2000 && cellElement.isConnected) {
              simulateClick(cellElement);
              lastClickAt = Date.now();
            }
          }
        });

        // Sem espera de estabilização: a etapa seguinte já espera o botão "Mais opções" aparecer
        return { success: true, title: targetTitle, via, diagnostics: Object.keys(diagnostics).length ? diagnostics : null };
      } catch (err) {
        if (Object.keys(diagnostics).length) err.openDiagnostics = diagnostics;
        throw err;
      } finally {
        // O resultado de exitSearch entra no mesmo objeto devolvido ou levado pelo erro
        if (exitSearchAfterOpen) diagnostics.searchExited = await this.exitSearch({ signal, pressEscapeKey: false });
      }
    }
  }

  if (typeof window !== 'undefined') {
    window.ChatNavigator = ChatNavigator;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ChatNavigator };
  }
})();
