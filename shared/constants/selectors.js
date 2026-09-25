/**
 * Seletores DOM canônicos mapeados da pasta kb/ (WhatsApp Web).
 * Priorizam atributos semânticos estáveis (id, data-testid, role, aria-*)
 * para garantir resiliência frente a atualizações de classes CSS ofuscadas.
 */
export const SELECTORS = Object.freeze({
  // Indicadores de estado e painéis estruturais
  APP_ROOT: '#app',
  SIDE_PANEL: '#side',
  PANE_SIDE: '#pane-side',
  MAIN_CHAT: '#main',
  INTRO_PANEL: '[data-testid="intro-panel"]',

  // Lista lateral de conversas (#pane-side)
  CHAT_LIST_CONTAINER: '#pane-side',
  CHAT_ROW: '#pane-side [role="row"]',
  CHAT_CELL: '#pane-side [role="row"] [data-testid="cell-frame-container"]',
  ARCHIVED_BUTTON: '[data-testid="chatlist-panel-archived-button"]',
  CHAT_TITLE: '[data-testid="cell-frame-title"]',
  CHAT_LAST_MESSAGE: '[data-testid="cell-frame-secondary"]',
  CHAT_TIMESTAMP: '[data-testid="cell-frame-primary-detail"]',
  CHAT_UNREAD_COUNT: '[data-testid="icon-unread-count"]',
  CHAT_SELECTED: '[aria-selected="true"]',

  // Cabeçalho da conversa aberta (#main header)
  MAIN_HEADER: '#main header',
  MAIN_HEADER_TITLE: '#main header span[dir="auto"]',
  BTN_MORE_OPTIONS: '#main header button[aria-label="Mais opções"], #main header [role="button"][aria-label="Mais opções"]',

  // Menu suspenso ("Mais opções")
  MENU_CONTAINER: 'div[role="menu"]',
  MENU_ITEM: '[role="menuitem"]',
  MENU_ITEM_EXPORT_CHAT: 'div[role="menu"] button[role="menuitem"][aria-label="Exportar conversa"]',
  MENU_ITEM_GROUP_INFO: 'div[role="menu"] button[aria-label="Dados do grupo"]',
  MENU_ITEM_CONTACT_INFO: 'div[role="menu"] button[aria-label="Dados do contato"]',

  // Modal nativo de exportação de conversa
  EXPORT_MODAL: 'div[data-testid="export-chat-modal"]',
  EXPORT_MODAL_TITLE: '[data-testid="popup-title"]',
  EXPORT_MODAL_CONTENTS: '[data-testid="popup-contents"]',
  EXPORT_RADIO_ALL_MSGS: 'input#date-range-all',
  EXPORT_RADIO_CUSTOM_MSGS: 'input#date-range-custom',
  EXPORT_RADIO_ALL_LABEL: 'label[for="date-range-all"]',
  EXPORT_RADIO_CUSTOM_LABEL: 'label[for="date-range-custom"]',
  EXPORT_MODAL_BUTTONS: 'div[data-testid="export-chat-modal"] button',
  EXPORT_CONFIRM_TEXT: 'Exportar',
  EXPORT_CANCEL_TEXT: 'Cancelar',

  // Histórico de mensagens
  MESSAGES_CONTAINER: 'div[data-testid="conversation-panel-messages"]',
  MSG_CONTAINER: '[data-testid="msg-container"]',
  MSG_META: '[data-testid="msg-meta"]',
  MSG_TEXT_COPYABLE: 'div.copyable-text',
  LOAD_EARLIER_BTN: 'div[data-testid="conversation-panel-messages"] button'
});
