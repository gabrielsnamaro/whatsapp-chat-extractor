// O padrão da permissão de host: sem a permissão `tabs`, o Chrome só mostra a URL das abas que ela cobre
const WHATSAPP_URL_PATTERN = 'https://web.whatsapp.com/*';
const WHATSAPP_URL_PREFIX = 'https://web.whatsapp.com/';

/**
 * Abas do WhatsApp Web. A URL de cada uma é conferida aqui também: o filtro `url` do chrome.tabs.query depende das
 * permissões, e uma aba de outro site nunca pode ser tomada pela do WhatsApp Web
 * @returns {Promise<chrome.tabs.Tab[]>}
 */
async function queryWhatsAppTabs() {
  const tabs = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  return (tabs ?? []).filter((tab) => typeof tab.url === 'string' && tab.url.startsWith(WHATSAPP_URL_PREFIX));
}

/**
 * Localiza a aba do WhatsApp Web. Com várias abas abertas, prioriza a indicada,
 * depois a ativa e por fim a usada mais recentemente.
 * @param {Object} [params]
 * @param {number|null} [params.preferredTabId=null]
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function findWhatsAppTab({ preferredTabId = null } = {}) {
  const tabs = await queryWhatsAppTabs();
  if (tabs.length === 0) return null;

  if (preferredTabId != null) {
    const preferred = tabs.find((tab) => tab.id === preferredTabId);
    if (preferred) return preferred;
  }

  return [...tabs].sort((a, b) =>
    Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0)
  )[0];
}

/**
 * Quantidade de abas do WhatsApp Web abertas
 * @returns {Promise<number>}
 */
export async function countWhatsAppTabs() {
  return (await queryWhatsAppTabs()).length;
}
