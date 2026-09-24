/**
 * Ações padronizadas para troca de mensagens entre:
 * - background (service-worker)
 * - content script (injetado na aba)
 * - popup (interface da extensão)
 */
export const ACTIONS = Object.freeze({
  // Comunicação básica / Saúde
  PING: 'PING',
  GET_STATUS: 'GET_STATUS',
  FIND_WHATSAPP_TAB: 'FIND_WHATSAPP_TAB',

  // Diagnóstico e detecção de prontidão
  CHECK_PAGE_READY: 'CHECK_PAGE_READY',
  PAGE_READY_STATUS: 'PAGE_READY_STATUS',

  // Extração e sincronização
  EXTRACT_CHAT_METADATA: 'EXTRACT_CHAT_METADATA',
  EXTRACT_ACTIVE_CHAT: 'EXTRACT_ACTIVE_CHAT',
  TRIGGER_CHAT_EXPORT: 'TRIGGER_CHAT_EXPORT',
  EXPORT_PROGRESS: 'EXPORT_PROGRESS',
  EXPORT_COMPLETED: 'EXPORT_COMPLETED',
  EXPORT_FAILED: 'EXPORT_FAILED',

  // Sincronização externa / Backend
  SYNC_TO_BACKEND: 'SYNC_TO_BACKEND',
  SYNC_STATUS_UPDATE: 'SYNC_STATUS_UPDATE'
});
