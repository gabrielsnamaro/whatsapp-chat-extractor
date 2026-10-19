const WHATSAPP_URL_PREFIX = 'https://web.whatsapp.com/';

/**
 * A mensagem veio do content script da aba do WhatsApp Web: só ela manda o arquivo exportado, o andamento da varredura e a
 * visibilidade da aba. A URL é a do frame que mandou (`sender.url`) ou, sem ela, a da aba; sem a permissão `tabs`, a da aba
 * vem porque a extensão tem a permissão de host do WhatsApp Web
 * @param {chrome.runtime.MessageSender|undefined} sender
 * @returns {boolean}
 */
export function isFromWhatsAppTab(sender) {
  return Boolean(sender?.tab) && (sender.url ?? sender.tab.url ?? '').startsWith(WHATSAPP_URL_PREFIX);
}

/**
 * A mensagem veio de uma página da própria extensão (o popup, o service worker), e não de um content script: os comandos
 * da extração e o empacotamento só valem vindos dela. Um content script tem a aba no remetente e a URL da página; o popup
 * aberto numa aba, a aba e a URL da extensão
 * @param {chrome.runtime.MessageSender|undefined} sender
 * @returns {boolean}
 */
export function isFromExtensionPage(sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  return !sender.tab || (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
}
