/**
 * Estados da máquina de estados do orquestrador de extração.
 */
export const WORKFLOW_STATES = Object.freeze({
  IDLE: 'IDLE',               // Parado / Pronto para iniciar
  SCANNING: 'SCANNING',       // Descobrindo conversas no #pane-side
  EXPORTING: 'EXPORTING',     // Processando e exportando conversa atual
  WAITING_DOWNLOAD: 'WAITING_DOWNLOAD', // Aguardando download gerado pelo WhatsApp
  PAUSED: 'PAUSED',           // Pausado pelo usuário
  PACKAGING: 'PACKAGING',     // Compilando o arquivo ZIP consolidado
  COMPLETED: 'COMPLETED',     // Concluído com sucesso
  FAILED: 'FAILED',           // Falhou com erro
  CANCELLED: 'CANCELLED'      // Cancelado pelo usuário
});
