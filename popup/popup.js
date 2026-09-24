/**
 * Popup Script (Manifest V3)
 * Coordena ações de interface do usuário, verificação de abas e acionamento de extração.
 */
import { ACTIONS } from '../shared/constants/actions.js';

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('status-badge');
  const statusDetail = document.getElementById('status-detail');
  const btnOpenWa = document.getElementById('btn-open-wa');
  const btnCheckReady = document.getElementById('btn-check-ready');
  const logArea = document.getElementById('log-area');

  function log(text) {
    const entry = document.createElement('p');
    entry.className = 'log-entry';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;
  }

  async function getWhatsAppTab() {
    const tabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
    return tabs && tabs.length > 0 ? tabs[0] : null;
  }

  async function updateStatus() {
    try {
      const tab = await getWhatsAppTab();
      if (!tab) {
        statusBadge.textContent = 'Não aberto';
        statusBadge.className = 'badge disconnected';
        statusDetail.textContent = 'Nenhuma aba do WhatsApp Web aberta.';
        btnCheckReady.disabled = true;
        return null;
      }

      statusBadge.textContent = 'Detectado';
      statusBadge.className = 'badge connected';
      statusDetail.textContent = `Aba ativa (ID: ${tab.id})`;
      btnCheckReady.disabled = false;
      return tab;
    } catch (err) {
      statusBadge.textContent = 'Erro';
      statusBadge.className = 'badge disconnected';
      statusDetail.textContent = err.message;
      return null;
    }
  }

  // Ação: Abrir WhatsApp Web
  btnOpenWa.addEventListener('click', async () => {
    log('Abrindo nova aba do WhatsApp Web...');
    await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
    window.close();
  });

  // Ação: Verificar se página está pronta
  btnCheckReady.addEventListener('click', async () => {
    const tab = await getWhatsAppTab();
    if (!tab) {
      log('WhatsApp Web não encontrado.');
      return;
    }

    log('Consultando status do WhatsApp Web...');
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: ACTIONS.CHECK_PAGE_READY });
      if (response && response.ready) {
        log('✅ WhatsApp Web carregado e pronto para extração!');
      } else {
        log('⏳ WhatsApp Web ainda carregando ou no QR Code.');
      }
    } catch (err) {
      log('⚠️ Falha ao comunicar com a página. Recarregue a aba do WhatsApp Web.');
    }
  });

  // Checagem inicial
  await updateStatus();
});
