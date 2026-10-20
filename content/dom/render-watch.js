/**
 * RenderWatch
 * Responsabilidade Única: Perceber quando a página do WhatsApp Web deixa de ser desenhada com a aba tida como visível.
 *
 * No Linux com Wayland (o GNOME, por exemplo), o Chrome não fica sabendo que a janela foi minimizada ou coberta por outra:
 * `document.visibilityState` continua 'visible', mas o sistema para de pedir quadros e a página não é mais desenhada. A
 * lista virtual de conversas e a busca da lista lateral dependem do desenho para mudar na tela, e as conversas deixavam de
 * ser achadas (as 15 não encontradas em bloco de 16/10/2026). Os quadros são contados pelo requestAnimationFrame; com
 * menos de `minFrames` em `stallMs`, a página é tratada como oculta, e volta a ser visível quando dois quadros seguidos
 * chegam a menos de `recoverGapMs` um do outro. A contagem só roda enquanto alguém a pede (start), porque pedir um quadro
 * a cada desenho mantém a página sendo desenhada; parada com a página sem desenho, ela espera o quadro que encerra isso.
 */
(function registerRenderWatch() {
  // Menos de 6 quadros em 3 s (menos de 2 por segundo): nenhum, ou como numa janela que o sistema só desenha de vez em
  // quando. Desenhada, a página dá dezenas por segundo enquanto os quadros são pedidos
  const STALL_MS = 3000;
  const MIN_FRAMES = 6;
  // Dois quadros a até 0,5 s um do outro (2 por segundo ou mais): a página voltou a ser desenhada de verdade
  const RECOVER_GAP_MS = 500;
  const CHECK_INTERVAL_MS = 1000;

  class RenderWatch {
    /**
     * @param {Object} params
     * @param {function(boolean): void} params.onChange Recebe true quando a página deixa de ser desenhada e false quando
     *   ela volta
     * @param {Object} [params.options] Os prazos (`stallMs`, `minFrames`, `recoverGapMs`, `checkIntervalMs`) e o que toca no
     *   navegador (`now`, `requestFrame`, `isDocumentVisible`, `setInterval`, `clearInterval`); os testes trocam todos
     */
    constructor({ onChange, options = {} }) {
      this.onChange = onChange;
      this.stallMs = options.stallMs ?? STALL_MS;
      this.minFrames = options.minFrames ?? MIN_FRAMES;
      this.recoverGapMs = options.recoverGapMs ?? RECOVER_GAP_MS;
      this.checkIntervalMs = options.checkIntervalMs ?? CHECK_INTERVAL_MS;
      this.now = options.now ?? (() => performance.now());
      this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
      this.isDocumentVisible = options.isDocumentVisible ?? (() => document.visibilityState === 'visible');
      this.setIntervalFn = options.setInterval ?? ((callback, ms) => setInterval(callback, ms));
      this.clearIntervalFn = options.clearInterval ?? ((timer) => clearInterval(timer));

      /** A página deixou de ser desenhada (e ainda não voltou) */
      this.stalled = false;
      this._active = false;
      this._frameRequested = false;
      this._frameTimes = [];
      this._watchingSince = 0;
      this._lastCheckAt = 0;
      this._timer = null;
    }

    /** Começa (ou continua) a contar os quadros */
    start() {
      if (this._active) return;
      this._active = true;
      this._watchingSince = this.now();
      this._lastCheckAt = this._watchingSince;
      this._frameTimes = [];
      this._request();
      if (this._timer === null) this._timer = this.setIntervalFn(() => this._check(), this.checkIntervalMs);
    }

    /**
     * Para de contar. Com a página sem desenho, o quadro já pedido continua pendente: quando ele chegar, a página volta a
     * ser tida como visível (a volta é percebida pelo quadro, e não pelo temporizador)
     */
    stop() {
      this._active = false;
      this._clearTimer();
      if (!this.stalled) this._frameTimes = [];
    }

    /** @private */
    _request() {
      if (this._frameRequested) return;
      this._frameRequested = true;
      this.requestFrame(() => this._onFrame());
    }

    /** @private */
    _onFrame() {
      this._frameRequested = false;
      const at = this.now();
      const previous = this._frameTimes.at(-1);
      this._frameTimes.push(at);
      if (this.stalled) {
        if (previous !== undefined && at - previous <= this.recoverGapMs) {
          this.stalled = false;
          this._frameTimes = [at];
          this._watchingSince = at;
          this.onChange(false);
        }
        // Parada, cada quadro pede o seguinte, até a volta; depois dela, só com a contagem ativa
        if (this.stalled || this._active) this._request();
        return;
      }
      if (this._active) this._request();
    }

    /** @private */
    _check() {
      if (this.stalled || !this._active) return;
      const now = this.now();
      const sinceLastCheck = now - this._lastCheckAt;
      this._lastCheckAt = now;
      // Com a aba oculta, o visibilitychange já avisa, e nenhum quadro é desenhado de qualquer jeito: a contagem recomeça
      // quando ela volta, para os quadros que faltaram enquanto ela estava oculta não contarem. Uma checagem atrasada (o
      // Chrome estrangula os temporizadores da aba oculta, e uma tarefa longa da página segura todos eles) também recomeça
      // a contagem: os quadros que faltaram nesse intervalo não dizem que a página parou de ser desenhada
      if (!this.isDocumentVisible() || sinceLastCheck > 2 * this.checkIntervalMs) {
        this._watchingSince = now;
        this._frameTimes = [];
        return;
      }
      if (now - this._watchingSince < this.stallMs) return;
      this._frameTimes = this._frameTimes.filter((at) => now - at < this.stallMs);
      if (this._frameTimes.length >= this.minFrames) return;
      this.stalled = true;
      this.onChange(true);
    }

    /** @private */
    _clearTimer() {
      if (this._timer === null) return;
      this.clearIntervalFn(this._timer);
      this._timer = null;
    }
  }

  if (typeof window !== 'undefined') {
    window.RenderWatch = RenderWatch;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RenderWatch };
  }
})();
