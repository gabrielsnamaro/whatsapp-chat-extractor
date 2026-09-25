/**
 * ChatHistoryLoader
 * Responsabilidade Única: Rolar progressivamente o painel de mensagens do chat ativo (#main)
 * até o topo para forçar o carregamento sob demanda (lazy loading) de todo o histórico prévio
 * antes de acionar a exportação nativa.
 * 
 * Interrompe a rolagem quando:
 * 1. O banner de limite do WhatsApp Web aparece no topo:
 *    "Use o WhatsApp no seu celular para abrir mensagens mais antigas."
 * 2. O início absoluto da conversa (dia 1) for alcançado (banner de criptografia inicial sem botão de carregar mais).
 * 3. Estagnação confirmada após múltiplas tentativas consecutivas sem novas mensagens, botões ou spinners ativos.
 */
class ChatHistoryLoader {
  /**
   * @param {Object} [options]
   * @param {Object} [options.selectors] Sobrescrita de seletores CSS
   */
  constructor(options = {}) {
    this.selectors = {
      messagesContainer: 'div[data-testid="conversation-panel-messages"], div[data-scrolltracepolicy*="conversation.messages"]',
      messageItem: '[data-testid="msg-container"], div.message-in, div.message-out',
      loadMoreButtons: 'div[data-testid="conversation-panel-messages"] button, #main button',
      ...options.selectors
    };

    // Regex exata para detecção do banner de limite no celular exibido no topo do histórico
    this.phoneLimitRegex = /(?:use|abra|open|usa)\s+(?:o\s+)?whatsapp\s+(?:no\s+(?:seu\s+)?celular|on\s+your\s+phone|en\s+tu\s+(?:tel[eé]fono|celular))\s+(?:para\s+(?:abrir|ver|visualizar)(?:\s+(?:mais|mensagens|as\s+mensagens|mensajes))?(?:\s+m[aá]s\s+antigu[ao]s?)?|to\s+(?:open|see|view)\s+older\s+messages)/i;

    // Regex para detecção do início absoluto de conversas curtas/recentes (dia 1 da conversa)
    this.beginningOfChatRegex = /mensagens e as chamadas são protegidas com a criptografia de ponta a ponta|messages and calls are end-to-end encrypted/i;
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
   * Dispara clique com suporte completo a eventos de ponteiro do React
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
   * Localiza o elemento contêiner rolável do histórico de mensagens
   * @returns {HTMLElement|null}
   */
  getMessagesContainer() {
    let container = document.querySelector(this.selectors.messagesContainer);
    if (container) return container;

    // Fallback: procura por qualquer contêiner rolável dentro de #main que contenha mensagens
    const candidates = document.querySelectorAll('#main div');
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
        if (el.querySelector(this.selectors.messageItem)) {
          return el;
        }
      }
    }
    return null;
  }

  /**
   * Verifica se o banner informando para abrir no celular apareceu no topo do histórico
   * Exemplo: "Use o WhatsApp no seu celular para abrir mensagens mais antigas."
   * @param {HTMLElement} container
   * @returns {boolean}
   */
  hasReachedPhoneLimit(container) {
    if (!container) return false;

    const root = document.querySelector('#main') || container;

    // 1. Procura em elementos específicos de texto dentro de #main
    const candidates = root.querySelectorAll('div, span, p');
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const text = (el.textContent || '').trim();
      if (text.length > 10 && text.length < 250) {
        if (this.phoneLimitRegex.test(text)) {
          return true;
        }
      }
    }

    // 2. Fallback: analisa os primeiros 2500 caracteres textuais do contêiner
    const topText = (container.innerText || container.textContent || '').slice(0, 2500);
    return this.phoneLimitRegex.test(topText);
  }

  /**
   * Verifica se o início absoluto (dia 1) da conversa foi alcançado
   * @param {HTMLElement} container
   * @returns {boolean}
   */
  hasReachedBeginningOfChat(container) {
    if (!container) return false;

    // Só é válido se o scroll estiver no topo absoluto
    if (container.scrollTop > 20) return false;

    // Se houver botão de carregar mais ou spinner ativo, ainda NÃO é o início
    if (this._findLoadEarlierButton(container) || this._isLoading(container)) {
      return false;
    }

    const topText = (container.innerText || container.textContent || '').slice(0, 2000);
    return this.beginningOfChatRegex.test(topText);
  }

  /**
   * Verifica se o WhatsApp Web está com spinner/indicador de carregamento ativo no topo
   * @private
   * @param {HTMLElement} container
   * @returns {boolean}
   */
  _isLoading(container) {
    if (!container) return false;
    const root = document.querySelector('#main') || container;
    const spinner = root.querySelector('[data-testid="spinner"], [role="progressbar"], svg[data-icon="tail-spin"], [data-testid="ring-indicator"]');
    if (spinner && spinner.offsetParent !== null) {
      const rect = spinner.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.6) {
        return true;
      }
    }
    return false;
  }

  /**
   * Localiza botão explícito de "Carregar mais mensagens" / "Carregar anteriores" no topo
   * @private
   * @param {HTMLElement} container
   * @returns {HTMLElement|null}
   */
  _findLoadEarlierButton(container) {
    if (!container) return null;
    const root = document.querySelector('#main') || container;
    const buttons = root.querySelectorAll('button, div[role="button"]');
    for (const btn of buttons) {
      // Ignora botões de controle, menu, anexar ou áudio
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (
        ariaLabel.includes('opções') || ariaLabel.includes('options') || 
        ariaLabel.includes('menu') || ariaLabel.includes('anexar') ||
        ariaLabel.includes('pesquisar') || ariaLabel.includes('search') ||
        ariaLabel.includes('gravar') || ariaLabel.includes('áudio')
      ) {
        continue;
      }

      const text = (btn.textContent || '').toLowerCase().trim();
      if (
        (text.includes('carregar') && (text.includes('mais') || text.includes('anteriores') || text.includes('mensagens') || text.includes('histórico'))) ||
        (text.includes('load') && (text.includes('more') || text.includes('earlier') || text.includes('messages') || text.includes('history'))) ||
        text === 'carregar mais' ||
        text === 'load more'
      ) {
        // Garante que o botão está localizado na metade superior da área de visualização
        const rect = btn.getBoundingClientRect();
        if (rect.height > 0 && rect.top < window.innerHeight * 0.55) {
          return btn;
        }
      }
    }
    return null;
  }

  /**
   * Rola o histórico de mensagens progressivamente até o topo antes de exportar
   * Ilimitado por padrão: rola até alcançar o banner de limite ("Use o WhatsApp no seu celular...")
   * ou o início absoluto da conversa (dia 1).
   * @param {Object} [options]
   * @param {number} [options.maxScrollCycles=Infinity] Número máximo de ciclos de rolagem (Infinity = ilimitado)
   * @param {number} [options.cycleDelayMs=450] Intervalo de espera para carregamento entre rolagens
   * @param {number} [options.timeoutMs=Infinity] Timeout máximo total da operação (Infinity = ilimitado)
   * @param {Function} [options.onProgress] Callback com contagem de mensagens carregadas
   * @returns {Promise<{ success: boolean, initialCount: number, finalCount: number, cycles: number, reachedBeginning: boolean }>}
   */
  async preloadFullHistory(options = {}) {
    const maxScrollCycles = options.maxScrollCycles ?? Infinity;
    const cycleDelayMs = options.cycleDelayMs ?? 450;
    const timeoutMs = options.timeoutMs ?? Infinity;
    const onProgress = options.onProgress ?? null;

    const container = this.getMessagesContainer();
    if (!container) {
      console.warn('[WhatsApp Extractor :: ChatHistoryLoader] Contêiner de mensagens não encontrado; prosseguindo sem pré-rolagem.');
      return { success: false, initialCount: 0, finalCount: 0, cycles: 0, reachedBeginning: false };
    }

    const initialCount = document.querySelectorAll(this.selectors.messageItem).length;
    console.log(`[WhatsApp Extractor :: ChatHistoryLoader] Iniciando pré-carregamento do histórico ilimitado (${initialCount} msgs em tela)...`);

    const startTime = Date.now();
    let consecutiveUnchanged = 0;
    let lastMsgCount = initialCount;
    let lastScrollHeight = container.scrollHeight;
    let cycles = 0;
    let reachedBeginning = false;

    while (cycles < maxScrollCycles && (timeoutMs === Infinity || Date.now() - startTime < timeoutMs)) {
      cycles++;

      // Salvaguarda: se o contêiner foi desmontado do DOM
      if (!document.contains(container)) {
        console.warn('[WhatsApp Extractor :: ChatHistoryLoader] Contêiner foi desmontado do DOM. Finalizando pré-carregamento.');
        break;
      }

      // 1. Verifica se a mensagem explícita de limite já apareceu no topo
      if (this.hasReachedPhoneLimit(container)) {
        console.log('[WhatsApp Extractor :: ChatHistoryLoader] ✅ Mensagem de limite alcançada: "Use o WhatsApp no celular para abrir mensagens mais antigas". Parando rolagem.');
        reachedBeginning = true;
        break;
      }

      // 2. Verifica se o início absoluto (dia 1) foi alcançado
      if (this.hasReachedBeginningOfChat(container)) {
        console.log('[WhatsApp Extractor :: ChatHistoryLoader] ✅ Início absoluto da conversa alcançado (criptografia de ponta a ponta sem mensagens anteriores).');
        reachedBeginning = true;
        break;
      }

      // 3. Procura botão explícito de "Carregar mais mensagens"
      const loadBtn = this._findLoadEarlierButton(container);
      if (loadBtn && loadBtn.offsetParent !== null) {
        console.log('[WhatsApp Extractor :: ChatHistoryLoader] 🖱️ Botão "Carregar mais" localizado no topo. Clicando...');
        this._simulateClick(loadBtn);
        consecutiveUnchanged = 0;
        await this._sleep(cycleDelayMs);
      }

      // 4. Se estiver com spinner ativo carregando, aguarda sem avançar estagnação
      if (this._isLoading(container)) {
        console.log('[WhatsApp Extractor :: ChatHistoryLoader] ⏳ Aguardando requisição de mensagens antigas...');
        consecutiveUnchanged = 0;
        await this._sleep(cycleDelayMs);
      }

      // 5. Rola o contêiner para o topo absoluto
      // Oscilação inicial para disparar ouvintes de scroll do React 18
      container.scrollTop = 25;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await this._sleep(30);

      try {
        container.scrollTo({ top: 0, behavior: 'instant' });
      } catch (_) {
        container.scrollTop = 0;
      }
      container.dispatchEvent(new Event('scroll', { bubbles: true }));

      try {
        container.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -500,
          view: window
        }));
      } catch (_) {}

      // 6. Aguarda o tempo necessário para o WhatsApp Web processar a requisição e renderizar
      await this._sleep(cycleDelayMs);

      // 7. Checagem imediata após o scroll
      if (this.hasReachedPhoneLimit(container)) {
        console.log('[WhatsApp Extractor :: ChatHistoryLoader] ✅ Mensagem de limite alcançada após rolagem: "Use o WhatsApp no celular para abrir mensagens mais antigas".');
        reachedBeginning = true;
        break;
      }

      if (this.hasReachedBeginningOfChat(container)) {
        console.log('[WhatsApp Extractor :: ChatHistoryLoader] ✅ Início absoluto da conversa confirmado após rolagem.');
        reachedBeginning = true;
        break;
      }

      // 8. Medição de progresso
      const currentCount = document.querySelectorAll(this.selectors.messageItem).length;
      const currentHeight = container.scrollHeight;

      if (onProgress && typeof onProgress === 'function') {
        onProgress(currentCount);
      }

      if (currentCount > lastMsgCount || currentHeight > lastScrollHeight) {
        consecutiveUnchanged = 0;
        console.log(`[WhatsApp Extractor :: ChatHistoryLoader] [Ciclo ${cycles}] Histórico expandido: ${currentCount} mensagens carregadas.`);
      } else {
        // Se houver botão ou spinner visível, não conta como estagnação
        if (this._findLoadEarlierButton(container) || this._isLoading(container)) {
          consecutiveUnchanged = 0;
        } else if (container.scrollTop <= 20) {
          consecutiveUnchanged++;
          // Se após 8 tentativas consecutivas (aproximadamente 4 a 5 segundos de silêncio absoluto) nada mudou
          if (consecutiveUnchanged >= 8) {
            console.log('[WhatsApp Extractor :: ChatHistoryLoader] Estagnação de mensagens detectada após 8 ciclos sem novos dados ou botões.');
            break;
          }
        }
      }

      lastMsgCount = currentCount;
      lastScrollHeight = currentHeight;
    }

    const finalCount = document.querySelectorAll(this.selectors.messageItem).length;
    console.log(`[WhatsApp Extractor :: ChatHistoryLoader] Pré-carregamento finalizado em ${cycles} ciclos: de ${initialCount} para ${finalCount} mensagens (alcançou limite: ${reachedBeginning}).`);

    // Pequena pausa final para estabilização
    await this._sleep(300);

    return {
      success: true,
      initialCount,
      finalCount,
      cycles,
      reachedBeginning
    };
  }
}

if (typeof window !== 'undefined') {
  window.ChatHistoryLoader = ChatHistoryLoader;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatHistoryLoader };
}
