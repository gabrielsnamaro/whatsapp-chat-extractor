import { WORKFLOW_STATES } from '../../shared/constants/workflow-states.js';

/**
 * ProgressView
 * Responsabilidade Única: Renderizar e atualizar os elementos visuais de progresso
 * (barra percentual, contadores numéricos, título do chat atual e estados textuais).
 */
export class ProgressView {
  constructor() {
    this.container = document.getElementById('progress-container');
    this.barFill = document.getElementById('progress-bar-fill');
    this.label = document.getElementById('progress-label');
    this.detail = document.getElementById('progress-detail');
    this.stateBadge = document.getElementById('progress-state-badge');
  }

  /**
   * Mapeamento de descrições amigáveis por estado
   * @private
   */
  _getStateLabel(state) {
    switch (state) {
      case WORKFLOW_STATES.SCANNING:
        return 'Descobrindo conversas...';
      case WORKFLOW_STATES.EXPORTING:
        return 'Exportando conversas...';
      case WORKFLOW_STATES.WAITING_DOWNLOAD:
        return 'Aguardando download...';
      case WORKFLOW_STATES.PAUSED:
        return 'Em pausa';
      case WORKFLOW_STATES.PACKAGING:
        return 'Compactando arquivo ZIP...';
      case WORKFLOW_STATES.COMPLETED:
        return 'Concluído com sucesso!';
      case WORKFLOW_STATES.FAILED:
        return 'Falha na extração';
      case WORKFLOW_STATES.CANCELLED:
        return 'Operação cancelada';
      default:
        return 'Pronto';
    }
  }

  /**
   * Renderiza a visualização atual de progresso
   * @param {Object} data
   * @param {string} data.state
   * @param {number} [data.current=0]
   * @param {number} [data.total=0]
   * @param {number} [data.percentage=0]
   * @param {string} [data.currentChatTitle='']
   * @param {string} [data.errorMessage=null]
   * @param {string} [data.statusMessage=null] Mensagem de estado (ex: execução interrompida, download não concluído)
   * @param {{ saved: number, empty: number, savedToDisk: number, notExportable: number, failed: number }} [data.summary]
   *   `empty` são as exportações vazias, já contadas em `saved`
   * @param {{ current: number, total: number }|null} [data.retry] Andamento da repescagem, enquanto ela
   *   tem conversas por exportar; aí `percentage` é o da rodada, e não o da fila
   * @param {number} [data.scanFound=0] Conversas encontradas até agora pela varredura da lista
   */
  renderProgress({ state, current = 0, total = 0, percentage = 0, currentChatTitle = '', errorMessage = null, statusMessage = null, summary = null, retry = null, scanFound = 0 }) {
    if (!this.container) return;

    if (state === WORKFLOW_STATES.IDLE && current === 0) {
      this.container.classList.add('hidden');
      return;
    }

    this.container.classList.remove('hidden');

    // Atualiza largura da barra
    const validPercent = Math.min(100, Math.max(0, percentage || 0));
    if (this.barFill) {
      this.barFill.style.width = `${validPercent}%`;
    }

    // Atualiza label percentual e contagem
    if (this.label) {
      const failures = summary?.failed ? ` · ${summary.failed} falha(s)` : '';
      const notExportable = summary?.notExportable ? ` · ${summary.notExportable} não exportável(is)` : '';
      const empty = summary?.empty ? ` · ${summary.empty} vazia(s)` : '';
      if (state === WORKFLOW_STATES.SCANNING) {
        this.label.textContent = scanFound > 0 ? `${scanFound} conversa(s) encontrada(s)` : 'Buscando lista de chats...';
      } else if (retry) {
        this.label.textContent = `Repescagem ${retry.current} de ${retry.total} (${validPercent}%)${failures}${notExportable}${empty}`;
      } else if (total > 0) {
        this.label.textContent = `${current} de ${total} (${validPercent}%)${failures}${notExportable}${empty}`;
      } else {
        this.label.textContent = `${validPercent}%`;
      }
    }

    // Atualiza detalhe da ação atual
    if (this.detail) {
      if (errorMessage) {
        this.detail.textContent = `Erro: ${errorMessage}`;
        this.detail.className = 'progress-detail text-error';
      } else if (statusMessage) {
        this.detail.textContent = statusMessage;
        this.detail.className = 'progress-detail';
      } else if (currentChatTitle) {
        this.detail.textContent = `Chat: ${currentChatTitle}`;
        this.detail.className = 'progress-detail';
      } else {
        this.detail.textContent = this._getStateLabel(state);
        this.detail.className = 'progress-detail';
      }
    }

    // Atualiza badge de estado
    if (this.stateBadge) {
      this.stateBadge.textContent = this._getStateLabel(state);
      this.stateBadge.className = `badge badge-${state.toLowerCase()}`;
    }
  }

  /**
   * Reseta os elementos para o estado inicial limpo
   */
  reset() {
    if (this.barFill) this.barFill.style.width = '0%';
    if (this.label) this.label.textContent = '0%';
    if (this.detail) this.detail.textContent = 'Aguardando início...';
    if (this.container) this.container.classList.add('hidden');
  }
}
