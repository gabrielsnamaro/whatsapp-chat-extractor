const WHATSAPP_URL_PATTERN = '*://web.whatsapp.com/*';

/**
 * Localiza a aba do WhatsApp Web. Com várias abas abertas, prioriza a indicada,
 * depois a ativa e por fim a usada mais recentemente.
 * @param {Object} [params]
 * @param {number|null} [params.preferredTabId=null]
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function findWhatsAppTab({ preferredTabId = null } = {}) {
  const tabs = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  if (!tabs || tabs.length === 0) return null;

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
  const tabs = await chrome.tabs.query({ url: WHATSAPP_URL_PATTERN });
  return tabs?.length || 0;
}
