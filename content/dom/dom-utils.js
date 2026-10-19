/**
 * DomUtils
 * Responsabilidade Única: Utilitários compartilhados pelas classes de automação DOM
 * (seletores, códigos de erro, esperas com timeout/cancelamento, clique simulado, leitura de títulos, telefones e do aviso
 * de mensagens mais antigas, e a contagem dos quadros que a página desenha).
 *
 * Content scripts clássicos não importam módulos ES, por isso o compartilhamento é via window.
 * Deve ser o primeiro arquivo da lista de content scripts no manifest.
 */
(function registerDomUtils() {
  /**
   * Seletores DOM canônicos mapeados da pasta kb/ (WhatsApp Web).
   * Priorizam atributos semânticos estáveis (id, data-testid, role, aria-*).
   */
  const SELECTORS = Object.freeze({
    // Indicadores de estado e painéis estruturais
    APP_ROOT: '#app',
    SIDE_PANEL: '#side',
    PANE_SIDE: '#pane-side',
    MAIN_CHAT: '#main',

    // Lista lateral de conversas (#pane-side)
    // A grade da lista normal, nos snapshots da kb/ (com e sem conversa aberta, menu e modal). Os
    // snapshots não têm a tela de resultados da busca; a saída da busca espera esta grade voltar
    CHAT_LIST_GRID: '#pane-side [data-testid="chat-list"] [role="grid"][aria-label="Lista de conversas"]',
    CHAT_ROW: '[role="row"]',
    CHAT_CELL: '[role="row"] [data-testid="cell-frame-container"]',
    ARCHIVED_BUTTON: '[data-testid="chatlist-panel-archived-button"]',
    CHAT_TITLE: '[data-testid="cell-frame-title"]',
    CHAT_LAST_MESSAGE: '[data-testid="cell-frame-secondary"]',
    CHAT_TIMESTAMP: '[data-testid="cell-frame-primary-detail"]',
    CHAT_UNREAD_COUNT: '[data-testid="icon-unread-count"]',
    SEARCH_INPUT: '#side input[data-tab="3"], #side input[role="textbox"], #side div[contenteditable="true"][data-tab="3"]',

    // Cabeçalho da conversa aberta (#main header)
    MAIN_HEADER: '#main header',
    MAIN_HEADER_TITLE: '#main header [data-testid="conversation-info-header-chat-title"]',
    MAIN_HEADER_TITLE_FALLBACK: '#main header span[dir="auto"]',
    BTN_MORE_OPTIONS: '#main header button[aria-label="Mais opções"], #main header [role="button"][aria-label="Mais opções"]',
    // O clique nele abre o painel "Dados do contato" (ou "Dados do grupo")
    CONVERSATION_INFO_HEADER: '#main header [data-testid="conversation-info-header"]',

    // Painel de mensagens da conversa aberta. Nos snapshots, o topo dele, antes da lista de mensagens, tem o aviso de
    // mensagens mais antigas: um <button> com "Clique neste aviso para carregar mensagens mais antigas do seu celular."
    // (initial_page, chat_options_selected e contact_info_drawer) ou, sem botão, "Use o WhatsApp no seu celular para ver
    // mensagens enviadas e recebidas antes de <data>." (chatopen_options e chat_export_modal). Nenhum dos dois tem
    // data-testid próprio: são achados pelo texto (classifyHistoryNotice)
    CONVERSATION_MESSAGES_PANEL: '#main [data-testid="conversation-panel-messages"]',
    // Uma mensagem do painel ("conv-msg-<id da mensagem>")
    CONVERSATION_MESSAGE: '[data-testid^="conv-msg-"]',
    HISTORY_NOTICE_BUTTON: 'button, [role="button"]',

    // Menu suspenso ("Mais opções")
    MENU_CONTAINER: 'div[role="menu"]',
    MENU_ITEM: '[role="menuitem"]',
    MENU_ITEM_EXPORT_CHAT: 'div[role="menu"] button[role="menuitem"][aria-label="Exportar conversa"]',
    EXPORT_MENU_TEXT: 'Exportar conversa',
    // Dizem o tipo da conversa: "Dados do contato" numa individual (snapshot chatopen_options) e "Dados do
    // grupo" num grupo (chat_options_selected)
    MENU_ITEM_CONTACT_INFO: 'div[role="menu"] [aria-label="Dados do contato"]',
    MENU_ITEM_GROUP_INFO: 'div[role="menu"] [aria-label="Dados do grupo"]',

    // Painel "Dados do contato", à direita da conversa (snapshots contact_info_drawer). Não há snapshot do painel
    // de um grupo: o título "Dados do grupo" é presumido pelo item do menu
    CONTACT_INFO_DRAWER: '[data-testid="chat-info-drawer"]',
    CONTACT_INFO_HEADER_TITLE: '[data-testid="contact-info-header"] h2',
    CONTACT_INFO_CHAT_TEXT: 'Dados do contato',
    CONTACT_INFO_GROUP_TEXT: 'Dados do grupo',
    // O atributo é "contact-info-subtitle selectable-text"; o contato não salvo tem o número nele, o contato salvo tem o
    // nome, e a conta comercial não tem o subtítulo
    CONTACT_INFO_SUBTITLE: '[data-testid^="contact-info-subtitle"]',
    // Só o primeiro deles logo depois do subtítulo é lido: nos layouts vistos, é o número do contato salvo (snapshot
    // payload3.html) ou o "~nome de perfil" do contato não salvo (payload.html). Os seguintes, como o "Recado", que também é
    // um deles, são escritos pelo próprio contato. Atributo exato, para não pegar o subtítulo nem o campo de notas
    CONTACT_INFO_SELECTABLE_TEXT: '[data-testid="selectable-text"]',
    // Nome da conta comercial no topo do painel (snapshot payload2.html): só com ele os números fora do subtítulo valem
    CONTACT_INFO_BUSINESS_CARD: '[data-testid="business-top-card-name-title"]',
    // Procurado dentro do painel: o cabeçalho dele tem só este botão
    CONTACT_INFO_CLOSE_BUTTON: 'header button[aria-label="Fechar"]',

    // Modal nativo de exportação de conversa
    EXPORT_MODAL: 'div[data-testid="export-chat-modal"]',
    EXPORT_MODAL_FALLBACK: 'div[role="dialog"]',
    EXPORT_RADIO_ALL_MSGS: 'input#date-range-all',
    EXPORT_RADIO_ALL_LABEL: 'label[for="date-range-all"]',
    EXPORT_DATE_RANGE_RADIOS: 'input[name="date-range"]',
    EXPORT_MODAL_BUTTONS: 'button, div[role="button"]',
    EXPORT_CONFIRM_TEXT: 'Exportar',
    EXPORT_CANCEL_TEXT: 'Cancelar'
  });

  /**
   * Timeouts padrão por etapa. São generosos de propósito: os timeouts curtos
   * anteriores (5–10s) estouravam em máquinas lentas e em contas grandes.
   */
  const TIMEOUTS = Object.freeze({
    OPEN_CHAT_MS: 30000,
    MORE_OPTIONS_BUTTON_MS: 30000,
    MENU_MS: 15000,
    // Curto de propósito: o menu já abriu, e um menu sem o item é uma conversa não exportável
    MENU_ITEM_MS: 1500,
    MODAL_MS: 30000,
    // O modal já abriu: o botão "Exportar" faz parte dele e só demora o tempo de renderizar
    MODAL_CONFIRM_BUTTON_MS: 3000,
    SEARCH_RESULTS_MS: 8000,
    // Teto da rolagem de abertura inteira (as duas descidas somadas). Uma descida pela lista inteira de
    // ~500 conversas leva ~40 s; sem teto, uma rolagem que não chegava ao fim levou 36 min em 06/10/2026
    OPEN_SCROLL_MS: 60000,
    // Curto: sair da busca só devolve a lista que já existe, e sem confirmação a abertura segue mesmo assim
    SEARCH_EXIT_MS: 3000,
    MODAL_CLOSE_MS: 5000,
    // Curtos: o painel "Dados do contato" é aberto em toda conversa com nome, e uma falha nele vira só um aviso
    CONTACT_INFO_OPEN_MS: 5000,
    CONTACT_INFO_CLOSE_MS: 3000,
    // O painel aparece antes do conteúdo: o cartão de uma conta comercial pode chegar depois do resto
    CONTACT_INFO_CONTENT_MS: 1500,
    // Cada clique no aviso de mensagens mais antigas pede as mensagens ao celular, que precisa estar online
    HISTORY_CLICK_WAIT_MS: 10000,
    // Depois de levar o painel de mensagens ao topo: as mensagens que o navegador já tem aparecem logo
    HISTORY_SCROLL_WAIT_MS: 1500,
    // Teto da espera pelo painel de mensagens da conversa recém-aberta, antes de procurar o aviso
    HISTORY_SETTLE_MS: 3000,
    // Intervalo entre duas leituras do painel de mensagens durante a carga
    HISTORY_POLL_MS: 200
  });

  /** Tipo da conversa, como vai ao background (`chatKind` do menu e `kind` do painel "Dados do contato") */
  const CHAT_KINDS = Object.freeze({ CHAT: 'chat', GROUP: 'group' });

  /** De onde saiu o telefone escolhido no painel "Dados do contato" (chooseDrawerPhone) */
  const DRAWER_PHONE_SOURCES = Object.freeze({
    SUBTITLE: 'subtitle',
    BELOW_SUBTITLE: 'below-subtitle',
    BUSINESS_CARD: 'business-card'
  });

  // Por que o painel de uma conversa individual não deu o telefone: vão ao background, que os põe no aviso do relatório e
  // no _execucao.log
  const DRAWER_PHONE_REASONS = Object.freeze({
    CONFLICT: 'mais de um número no painel',
    NO_SUBTITLE_NOR_BUSINESS_CARD: 'painel sem telefone no subtítulo e sem o cartão de conta comercial',
    BUSINESS_CARD_WITHOUT_PHONE: 'nenhum número no painel da conta comercial'
  });

  /** Aviso do topo do painel de mensagens (classifyHistoryNotice) */
  const HISTORY_NOTICE_KINDS = Object.freeze({ LOAD: 'load', PHONE_ONLY: 'phone-only' });

  // Como terminou a carga das mensagens mais antigas (HistoryLoader.load): sem o aviso no topo (não estava lá ou sumiu
  // depois de mensagens novas), com o aviso de que as anteriores só estão no celular, no limite de tempo ou sem resposta do
  // celular. Vão ao background, que marca no relatório as conversas que pararam nos dois últimos
  const HISTORY_LOAD_REASONS = Object.freeze({
    NO_NOTICE: 'no-notice',
    PHONE_ONLY: 'phone-only',
    TIME_LIMIT: 'time-limit',
    STALLED: 'stalled'
  });

  // Textos dos avisos do topo do painel de mensagens. A data do "só no celular" vem como o WhatsApp Web a escreve, com o
  // mês primeiro (ex: "6/26/2026"), como no texto exportado
  const HISTORY_LOAD_NOTICE_PATTERN = /carregar mensagens mais antigas/i;
  const HISTORY_PHONE_ONLY_NOTICE_PATTERN = /use o whatsapp no seu celular para ver mensagens/i;
  const HISTORY_PHONE_ONLY_DATE_PATTERN = /antes de (\d{1,2}\/\d{1,2}\/\d{2,4})/i;

  // Espelho de phoneFromTitle (shared/utils/phone.js), que o content script não importa por ser módulo ES: as marcas
  // invisíveis de direção do texto, a forma de um número formatado e os limites de 10 a 15 dígitos
  const PHONE_DIRECTION_MARKS_PATTERN = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
  const PHONE_TEXT_PATTERN = /^\+?[\d\s().-]+$/;
  const PHONE_MIN_DIGITS = 10;
  const PHONE_MAX_DIGITS = 15;

  /**
   * Códigos de erro da automação DOM. Vão na resposta ao background, que classifica o resultado
   * da conversa por eles (ex: uma conversa não exportável é contada à parte das falhas).
   */
  const ERROR_CODES = Object.freeze({
    CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
    AMBIGUOUS_TITLE: 'AMBIGUOUS_TITLE',
    EXPORT_OPTION_UNAVAILABLE: 'EXPORT_OPTION_UNAVAILABLE',
    DATE_RANGE_NOT_ALL: 'DATE_RANGE_NOT_ALL',
    TIMEOUT: 'TIMEOUT'
  });

  /** Por que uma tentativa de localizar a conversa na lista lateral não achou a célula */
  const LOCATE_FAILURES = Object.freeze({
    SEARCH_INPUT_MISSING: 'search-input-missing',
    SEARCH_NO_RESULT: 'search-no-result',
    LIST_MISSING: 'list-missing',
    END_OF_LIST: 'end-of-list',
    SCROLL_STALLED: 'scroll-stalled',
    SCROLL_TIME_LIMIT: 'scroll-time-limit',
    SCROLL_STEP_LIMIT: 'scroll-step-limit'
  });

  const LOCATE_VIA_LABELS = Object.freeze({ search: 'busca', scroll: 'rolagem' });

  class OperationCancelledError extends Error {
    constructor(message = 'Operação cancelada.') {
      super(message);
      this.name = 'OperationCancelledError';
    }
  }

  class OperationTimeoutError extends Error {
    constructor(message) {
      super(message);
      this.name = 'OperationTimeoutError';
      this.code = ERROR_CODES.TIMEOUT;
    }
  }

  class DomAutomationError extends Error {
    /**
     * @param {string} code Um dos ERROR_CODES
     * @param {string} message Texto exibido no relatório da extração
     */
    constructor(code, message) {
      super(message);
      this.name = 'DomAutomationError';
      this.code = code;
    }
  }

  function formatSeconds(ms) {
    return `${Number((ms / 1000).toFixed(2))} s`;
  }

  /**
   * Os dígitos quando o texto é só um telefone, como "+55 11 99999-9999"; null quando é outra coisa, mesmo com
   * dígitos ("Bloquear +55 …"). Não toca no DOM, para ser testada no Node.
   * @param {string|null|undefined} text
   * @returns {string|null}
   */
  function extractPhoneDigits(text) {
    if (typeof text !== 'string') return null;
    const clean = text.replace(PHONE_DIRECTION_MARKS_PATTERN, '').trim();
    if (!PHONE_TEXT_PATTERN.test(clean)) return null;
    const digits = clean.replace(/\D/g, '');
    return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS ? digits : null;
  }

  /**
   * Escolhe o telefone do contato entre os textos do painel "Dados do contato". O subtítulo que é só um telefone é o
   * número (contato não salvo). Sem ele, o texto logo abaixo do subtítulo que é só um telefone é o número (contato salvo,
   * cujo subtítulo é o nome). Sem nenhum dos dois, os outros textos só valem no painel de uma conta comercial, e só quando
   * todos dão o mesmo número: o "Recado" e a descrição da conta são escritos pelo próprio contato e podem trazer outro
   * número, que daria à conversa o chat_id de outra. Não toca no DOM, para ser testada no Node.
   * @param {Object} params
   * @param {string|null} [params.subtitleText] Texto do subtítulo do painel; null sem subtítulo
   * @param {string|null} [params.belowSubtitleText] Texto do primeiro `[data-testid="selectable-text"]` logo depois do
   *   subtítulo; null sem subtítulo ou sem esse elemento
   * @param {string[]} [params.phoneTexts] Textos do painel que são só um telefone (os outros são ignorados)
   * @param {boolean} [params.businessCardPresent] O cartão da conta comercial está no painel
   * @returns {{ phone: string, source: string }|{ phone: null, reason: string }} `source` é um dos DRAWER_PHONE_SOURCES;
   *   `reason`, por que nenhum número foi escolhido
   */
  function chooseDrawerPhone({ subtitleText = null, belowSubtitleText = null, phoneTexts = [], businessCardPresent = false } = {}) {
    const subtitlePhone = extractPhoneDigits(subtitleText);
    if (subtitlePhone) return { phone: subtitlePhone, source: DRAWER_PHONE_SOURCES.SUBTITLE };
    // Como o subtítulo, o número logo abaixo dele é o WhatsApp que escreve, e outro número no painel não muda a escolha
    const belowSubtitlePhone = extractPhoneDigits(belowSubtitleText);
    if (belowSubtitlePhone) return { phone: belowSubtitlePhone, source: DRAWER_PHONE_SOURCES.BELOW_SUBTITLE };
    if (!businessCardPresent) return { phone: null, reason: DRAWER_PHONE_REASONS.NO_SUBTITLE_NOR_BUSINESS_CARD };

    const phones = new Set(phoneTexts.map((text) => extractPhoneDigits(text)).filter(Boolean));
    if (phones.size > 1) return { phone: null, reason: DRAWER_PHONE_REASONS.CONFLICT };
    const [phone] = phones;
    return phone
      ? { phone, source: DRAWER_PHONE_SOURCES.BUSINESS_CARD }
      : { phone: null, reason: DRAWER_PHONE_REASONS.BUSINESS_CARD_WITHOUT_PHONE };
  }

  /**
   * Reconhece o aviso de mensagens mais antigas pelo texto de um elemento do topo do painel de mensagens, sem as marcas
   * invisíveis de direção do texto (inclusive as de isolamento, que podem cercar a data) e com a normalização dos títulos
   * (normalizeTitle). Não toca no DOM, para ser testada no Node.
   * @param {string|null|undefined} text
   * @returns {{ kind: 'load' }|{ kind: 'phone-only', before: string|null }|null} `load`: o aviso que, a cada clique, pede
   *   ao celular as mensagens anteriores às do painel; `phone-only`: o WhatsApp Web não carrega as anteriores a `before`
   *   (a data como o aviso a escreve; null quando ele não traz uma); null: nenhum dos dois
   */
  function classifyHistoryNotice(text) {
    if (typeof text !== 'string') return null;
    const clean = normalizeTitle(text.replace(PHONE_DIRECTION_MARKS_PATTERN, ''));
    if (HISTORY_PHONE_ONLY_NOTICE_PATTERN.test(clean)) {
      return { kind: HISTORY_NOTICE_KINDS.PHONE_ONLY, before: HISTORY_PHONE_ONLY_DATE_PATTERN.exec(clean)?.[1] ?? null };
    }
    return HISTORY_LOAD_NOTICE_PATTERN.test(clean) ? { kind: HISTORY_NOTICE_KINDS.LOAD } : null;
  }

  /**
   * @param {{ via: string, reason: string, timeoutMs?: number, steps?: number }} attempt `timeoutMs` é o prazo
   *   da busca ou o teto da rolagem; `steps`, os passos da descida a partir do topo ou, nos tetos, os da
   *   rolagem inteira
   * @returns {string}
   */
  function describeFailedAttempt({ via, reason, timeoutMs, steps }) {
    const label = LOCATE_VIA_LABELS[via];
    if (!label) throw new Error(`Tentativa de localização desconhecida: ${via}`);

    switch (reason) {
      case LOCATE_FAILURES.SEARCH_INPUT_MISSING:
        return `${label}: campo de busca não encontrado`;
      case LOCATE_FAILURES.SEARCH_NO_RESULT:
        return `${label}: sem resultado em ${formatSeconds(timeoutMs)}`;
      case LOCATE_FAILURES.LIST_MISSING:
        return `${label}: lista lateral não encontrada`;
      case LOCATE_FAILURES.END_OF_LIST:
        return `${label}: ${steps} passo(s) até o fim da lista`;
      case LOCATE_FAILURES.SCROLL_STALLED:
        return `${label}: parou após ${steps} passo(s), antes do fim da lista`;
      case LOCATE_FAILURES.SCROLL_TIME_LIMIT:
        return `${label}: interrompida no teto de ${formatSeconds(timeoutMs)}, após ${steps} passo(s)`;
      case LOCATE_FAILURES.SCROLL_STEP_LIMIT:
        return `${label}: interrompida no limite de ${steps} passo(s), proporcional ao tamanho da lista`;
      default:
        throw new Error(`Motivo de tentativa desconhecido: ${reason}`);
    }
  }

  /**
   * Mensagem de conversa não encontrada com o motivo de cada tentativa (busca, rolagem).
   * Não toca no DOM, para ser testada no Node.
   * @param {string} targetTitle
   * @param {Array<{ via: 'search'|'scroll', reason: string, timeoutMs?: number, steps?: number }>} failedAttempts
   * @returns {string}
   */
  function buildChatNotFoundMessage(targetTitle, failedAttempts) {
    const base = `Conversa "${targetTitle}" não foi encontrada na lista lateral`;
    if (!failedAttempts.length) return `${base}.`;
    return `${base} (${failedAttempts.map(describeFailedAttempt).join('; ')}).`;
  }

  /**
   * Posição da lista lateral em que a varredura de abertura começa: uma tela acima da linha estimada
   * da conversa (posição na fila × altura de uma linha). A tela de folga cobre a conversa que subiu um
   * pouco desde a varredura e a pasta "Arquivadas" acima da grade; a que desceu é achada na descida.
   * Não toca no DOM, para ser testada no Node.
   * @param {{ index: number, rowHeight: number, viewportHeight: number }} params
   * @returns {number} scrollTop inicial, nunca negativo
   */
  function estimateScrollStart({ index, rowHeight, viewportHeight }) {
    for (const [name, value] of Object.entries({ index, rowHeight, viewportHeight })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Valor inválido para estimar a posição da conversa na lista: ${name} = ${String(value)}`);
      }
    }
    return Math.max(0, Math.floor(index * rowHeight - viewportHeight));
  }

  /**
   * Posição da lista lateral para a tentativa de achar a conversa perto de onde ela estava na varredura, antes da busca: a
   * linha estimada (posição na fila × altura de uma linha) fica `rowsAbove` linhas abaixo do topo da tela. A folga é
   * pequena porque, durante a extração, a conversa tende a descer na lista (cada conversa de baixo que recebe mensagem sobe
   * para o topo e a empurra uma linha), e quase nunca a subir. Não toca no DOM, para ser testada no Node.
   * @param {{ index: number, rowHeight: number, rowsAbove: number }} params
   * @returns {number} scrollTop, nunca negativo
   */
  function estimateNearbyTop({ index, rowHeight, rowsAbove }) {
    for (const [name, value] of Object.entries({ index, rowHeight, rowsAbove })) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`Valor inválido para estimar a posição da conversa na lista: ${name} = ${String(value)}`);
      }
    }
    return Math.max(0, Math.floor((index - rowsAbove) * rowHeight));
  }

  /**
   * Conta os quadros que a página desenha (requestAnimationFrame) a partir de agora. Com a aba oculta, ou quando o
   * navegador deixa de desenhar a página por outro motivo, nenhum quadro é contado: a lista virtual e a busca da lista
   * lateral dependem do desenho para mudar na tela
   * @returns {function(): (number|null)} Para a contagem e devolve os quadros contados; null sem requestAnimationFrame
   */
  function countAnimationFrames() {
    if (typeof requestAnimationFrame !== 'function') return () => null;
    let frames = 0;
    let counting = true;
    const tick = () => {
      if (!counting) return;
      frames++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      counting = false;
      return frames;
    };
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw new OperationCancelledError();
  }

  /**
   * Pausa assíncrona interrompível por AbortSignal
   * @param {number} ms
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   */
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new OperationCancelledError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new OperationCancelledError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Aguarda até que `probe()` retorne um valor verdadeiro, respeitando timeout e cancelamento
   * @param {function(): any} probe
   * @param {Object} options
   * @param {number} options.timeoutMs
   * @param {string} options.description Texto usado na mensagem de timeout
   * @param {number} [options.intervalMs=150]
   * @param {AbortSignal} [options.signal]
   * @param {function(number): void} [options.onTick] Invocado a cada tentativa sem sucesso com o tempo decorrido
   * @returns {Promise<any>}
   */
  async function waitFor(probe, { timeoutMs, description, intervalMs = 150, signal, onTick } = {}) {
    const startedAt = Date.now();
    while (true) {
      throwIfAborted(signal);
      const result = probe();
      if (result) return result;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new OperationTimeoutError(`Timeout de ${Math.round(timeoutMs / 1000)}s aguardando ${description}.`);
      }
      if (onTick) onTick(elapsed);
      await sleep(intervalMs, signal);
    }
  }

  /**
   * Considera visível qualquer elemento com caixa renderizada. Ao contrário de
   * offsetParent, funciona para menus e modais com position: fixed.
   * @param {Element|null} element
   * @returns {boolean}
   */
  function isVisible(element) {
    return Boolean(element) && element.isConnected && element.getClientRects().length > 0;
  }

  /**
   * Dispara um único clique com a sequência de eventos de ponteiro que o React escuta.
   * element.click() já emite o evento click; emitir outro MouseEvent('click') fazia
   * cada clique contar duas vezes (menus abriam e fechavam, "Exportar" disparava duas vezes).
   * @param {HTMLElement} element
   */
  function simulateClick(element) {
    if (!element) return;
    try { element.focus({ preventScroll: true }); } catch (_) {}

    const rect = element.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const baseInit = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
    const pointerInit = { ...baseInit, pointerId: 1, pointerType: 'mouse', isPrimary: true };

    try { element.dispatchEvent(new PointerEvent('pointerdown', { ...pointerInit, buttons: 1 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mousedown', { ...baseInit, buttons: 1 })); } catch (_) {}
    try { element.dispatchEvent(new PointerEvent('pointerup', { ...pointerInit, buttons: 0 })); } catch (_) {}
    try { element.dispatchEvent(new MouseEvent('mouseup', { ...baseInit, buttons: 0 })); } catch (_) {}
    element.click();
  }

  /**
   * @param {Element} [target] Quem recebe a tecla; sem ele, o elemento com o foco
   */
  function pressEscape(target = document.activeElement || document.body) {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /**
   * Lê o texto visível de um elemento incluindo emojis, que o WhatsApp Web
   * renderiza como <img alt="🤓"> e por isso somem do textContent
   * @param {Element|null} element
   * @returns {string}
   */
  function readTextWithEmojis(element) {
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
   * Título de uma célula da lista: atributo title (preserva emojis) com fallback para o texto
   * @param {Element} cell
   * @returns {string}
   */
  function readCellTitle(cell) {
    const titleEl = cell?.querySelector(SELECTORS.CHAT_TITLE);
    if (!titleEl) return '';
    const spanWithTitle = titleEl.querySelector('span[title]');
    return (spanWithTitle?.getAttribute('title') || readTextWithEmojis(titleEl)).trim();
  }

  /**
   * Normaliza títulos para comparação exata: forma NFC, sem caracteres invisíveis
   * (inclusive seletores de variação de emoji) e espaços colapsados. A caixa é mantida:
   * "João" e "joão" são conversas diferentes, e igualá-las fazia o scanner guardar só uma
   * e a abertura poder pegar uma no lugar da outra.
   * @param {string} str
   * @returns {string}
   */
  function normalizeTitle(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .normalize('NFC')
      .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\uFE0E\uFE0F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Igualdade exata após normalização. Comparação parcial foi descartada porque fazia
   * "Ana" casar com "Mariana" e exportar a conversa errada sob o nome da esperada.
   * @param {string} candidateTitle
   * @param {string} targetTitle
   * @returns {boolean}
   */
  function isTitleMatch(candidateTitle, targetTitle) {
    const cleanCand = normalizeTitle(candidateTitle);
    return Boolean(cleanCand) && cleanCand === normalizeTitle(targetTitle);
  }

  const DomUtils = Object.freeze({
    SELECTORS,
    TIMEOUTS,
    ERROR_CODES,
    LOCATE_FAILURES,
    CHAT_KINDS,
    DRAWER_PHONE_SOURCES,
    HISTORY_NOTICE_KINDS,
    HISTORY_LOAD_REASONS,
    OperationCancelledError,
    OperationTimeoutError,
    DomAutomationError,
    formatSeconds,
    extractPhoneDigits,
    chooseDrawerPhone,
    classifyHistoryNotice,
    buildChatNotFoundMessage,
    estimateScrollStart,
    estimateNearbyTop,
    countAnimationFrames,
    throwIfAborted,
    sleep,
    waitFor,
    isVisible,
    simulateClick,
    pressEscape,
    readTextWithEmojis,
    readCellTitle,
    normalizeTitle,
    isTitleMatch
  });

  if (typeof window !== 'undefined') {
    window.DomUtils = DomUtils;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DomUtils };
  }
})();
