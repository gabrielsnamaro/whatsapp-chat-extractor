/**
 * Ações padronizadas para troca de mensagens entre:
 * - background (service-worker)
 * - content script (injetado na aba; usa as mesmas strings literais, pois não importa módulos ES)
 * - popup (interface da extensão)
 * - offscreen document (empacotamento do ZIP)
 */
export const ACTIONS = Object.freeze({
  // Saúde e diagnóstico
  PING: 'PING',
  CHECK_PAGE_READY: 'CHECK_PAGE_READY',

  // Automação DOM (Background -> Content Script)
  SCAN_CHATS_REQUEST: 'SCAN_CHATS_REQUEST',
  EXPORT_CHAT_REQUEST: 'EXPORT_CHAT_REQUEST',
  CANCEL_CURRENT_OPERATION: 'CANCEL_CURRENT_OPERATION',
  DISARM_EXPORT_CAPTURE: 'DISARM_EXPORT_CAPTURE',
  FETCH_BLOB_REQUEST: 'FETCH_BLOB_REQUEST',
  RESET_SIDEBAR: 'RESET_SIDEBAR',

  // Transferência em blocos do arquivo exportado (Content Script -> Background)
  EXPORT_TRANSFER_START: 'EXPORT_TRANSFER_START',
  EXPORT_TRANSFER_CHUNK: 'EXPORT_TRANSFER_CHUNK',
  EXPORT_TRANSFER_END: 'EXPORT_TRANSFER_END',
  EXPORT_TRANSFER_FAILED: 'EXPORT_TRANSFER_FAILED',

  // Captura do arquivo exportado (Content Script -> Background)
  EXPORT_CAPTURE_ARMED: 'EXPORT_CAPTURE_ARMED',
  EXPORT_UNEXPECTED_FILE: 'EXPORT_UNEXPECTED_FILE',

  // Andamento da varredura da lista lateral (Content Script -> Background)
  SCAN_PROGRESS: 'SCAN_PROGRESS',

  // A aba do WhatsApp Web ficou oculta ou voltou a ficar visível (Content Script -> Background)
  TAB_VISIBILITY_CHANGED: 'TAB_VISIBILITY_CHANGED',

  // Controle de fluxo de lote (Popup -> Background)
  START_BATCH_EXTRACTION: 'START_BATCH_EXTRACTION',
  PAUSE_BATCH_EXTRACTION: 'PAUSE_BATCH_EXTRACTION',
  RESUME_BATCH_EXTRACTION: 'RESUME_BATCH_EXTRACTION',
  CANCEL_BATCH_EXTRACTION: 'CANCEL_BATCH_EXTRACTION',
  GET_WORKFLOW_STATE: 'GET_WORKFLOW_STATE',

  // Eventos de progresso e estado (Background -> Popup)
  WORKFLOW_PROGRESS_UPDATE: 'WORKFLOW_PROGRESS_UPDATE'
});

/** Destino das mensagens tratadas pelo offscreen document */
export const OFFSCREEN_TARGET = 'offscreen';

export const OFFSCREEN_ACTIONS = Object.freeze({
  BUILD_ARCHIVE: 'BUILD_ARCHIVE',
  REVOKE_ARCHIVE_URL: 'REVOKE_ARCHIVE_URL'
});
