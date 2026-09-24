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

  // Descoberta de conversas (DOM Scanner)
  SCAN_CHATS_REQUEST: 'SCAN_CHATS_REQUEST',
  SCAN_CHATS_RESPONSE: 'SCAN_CHATS_RESPONSE',

  // Exportação individual de conversa (DOM Automator)
  EXPORT_CHAT_REQUEST: 'EXPORT_CHAT_REQUEST',
  EXPORT_CHAT_RESPONSE: 'EXPORT_CHAT_RESPONSE',

  // Controle de fluxo de lote (Popup -> Background)
  START_BATCH_EXTRACTION: 'START_BATCH_EXTRACTION',
  PAUSE_BATCH_EXTRACTION: 'PAUSE_BATCH_EXTRACTION',
  RESUME_BATCH_EXTRACTION: 'RESUME_BATCH_EXTRACTION',
  CANCEL_BATCH_EXTRACTION: 'CANCEL_BATCH_EXTRACTION',

  // Eventos de progresso e estado (Background -> Popup)
  WORKFLOW_STATUS_CHANGED: 'WORKFLOW_STATUS_CHANGED',
  WORKFLOW_PROGRESS_UPDATE: 'WORKFLOW_PROGRESS_UPDATE',

  // Interceptação de downloads e transporte de blobs
  DOWNLOAD_INTERCEPTED: 'DOWNLOAD_INTERCEPTED',
  BLOB_CAPTURED_FROM_PAGE: 'BLOB_CAPTURED_FROM_PAGE',
  FETCH_BLOB_REQUEST: 'FETCH_BLOB_REQUEST',
  GET_WORKFLOW_STATE: 'GET_WORKFLOW_STATE',

  // Sincronização externa / Backend
  SYNC_TO_BACKEND: 'SYNC_TO_BACKEND',
  SYNC_STATUS_UPDATE: 'SYNC_STATUS_UPDATE'
});
