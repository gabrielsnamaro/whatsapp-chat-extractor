/**
 * Popup Script (Manifest V3)
 * Ponto de entrada da interface do popup.
 * Inicializa os controladores especializados ExtractionControls e ProgressView.
 */
import { ACTIONS } from '../shared/constants/actions.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { ProgressView } from './ui/progress-view.js';
import { ExtractionControls } from './ui/extraction-controls.js';

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('status-badge');
  const statusDetail = document.getElementById('status-detail');
  const btnOpenWa = document.getElementById('btn-open-wa');
  const btnCheckReady = document.getElementById('btn-check-ready');
  const logArea = document.getElementById('log-area');

  const progressView = new ProgressView();
  const controls = new ExtractionControls();

  function log(text) {
    if (!logArea) return;
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

  async function updateTabStatus() {
    try {
      const tab = await getWhatsAppTab();
      if (!tab) {
        statusBadge.textContent = 'Não aberto';
        statusBadge.className = 'badge disconnected';
        statusDetail.textContent = 'Nenhuma aba do WhatsApp Web aberta.';
        if (btnCheckReady) btnCheckReady.disabled = true;
        return null;
      }

      statusBadge.textContent = 'Detectado';
      statusBadge.className = 'badge connected';
      statusDetail.textContent = `Aba ativa (ID: ${tab.id})`;
      if (btnCheckReady) btnCheckReady.disabled = false;
      return tab;
    } catch (err) {
      statusBadge.textContent = 'Erro';
      statusBadge.className = 'badge disconnected';
      statusDetail.textContent = err.message;
      return null;
    }
  }

  // Carrega opções e preferências persistidas
  await controls.loadPreferences();

  // Consulta o estado atual do orquestrador no background
  try {
    const response = await chrome.runtime.sendMessage({ action: ACTIONS.GET_WORKFLOW_STATE });
    if (response && response.success && response.data) {
      const stateData = response.data;
      progressView.renderProgress(stateData);
      controls.updateUiState(stateData.state);
    }
  } catch (_) {
    controls.updateUiState(WORKFLOW_STATES.IDLE);
  }

  // Escuta atualizações de progresso emitidas pelo background em tempo real
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === ACTIONS.WORKFLOW_PROGRESS_UPDATE) {
      progressView.renderProgress(message);
      controls.updateUiState(message.state);

      if (message.currentChatTitle) {
        log(`[${message.current}/${message.total}] ${message.currentChatTitle}`);
      }
      if (message.state === WORKFLOW_STATES.COMPLETED) {
        log('🎉 Extração concluída! O download do arquivo ZIP foi iniciado.');
      } else if (message.state === WORKFLOW_STATES.FAILED) {
        log(`❌ Falha: ${message.errorMessage}`);
      }
    }
  });

  // Ação: Iniciar extração em lote
  controls.onStart(async (options) => {
    const tab = await updateTabStatus();
    if (!tab) {
      log('⚠️ Abra o WhatsApp Web antes de iniciar a extração.');
      return;
    }

    const modeText = options.downloadAll ? 'Todos os chats' : `Limite de ${options.maxChats} chats`;
    log(`Iniciando lote: ${modeText}...`);

    controls.updateUiState(WORKFLOW_STATES.SCANNING);
    progressView.renderProgress({
      state: WORKFLOW_STATES.SCANNING,
      current: 0,
      total: options.maxChats || 0,
      percentage: 0
    });

    try {
      const res = await chrome.runtime.sendMessage({
        action: ACTIONS.START_BATCH_EXTRACTION,
        maxChats: options.maxChats,
        downloadAll: options.downloadAll,
        safeDelayMs: 2000
      });

      if (!res || !res.success) {
        log(`Erro ao iniciar: ${res?.error || 'Desconhecido'}`);
        controls.updateUiState(WORKFLOW_STATES.FAILED);
      }
    } catch (err) {
      log(`Erro de comunicação com o Service Worker: ${err.message}`);
      controls.updateUiState(WORKFLOW_STATES.FAILED);
    }
  });

  // Ação: Pausar
  controls.onPause(async () => {
    log('Solicitando pausa...');
    await chrome.runtime.sendMessage({ action: ACTIONS.PAUSE_BATCH_EXTRACTION });
  });

  // Ação: Retomar
  controls.onResume(async () => {
    log('Solicitando retomada...');
    await chrome.runtime.sendMessage({ action: ACTIONS.RESUME_BATCH_EXTRACTION });
  });

  // Ação: Cancelar
  controls.onCancel(async () => {
    log('Solicitando cancelamento...');
    await chrome.runtime.sendMessage({ action: ACTIONS.CANCEL_BATCH_EXTRACTION });
  });

  // Ação: Abrir WhatsApp Web
  if (btnOpenWa) {
    btnOpenWa.addEventListener('click', async () => {
      log('Abrindo nova aba do WhatsApp Web...');
      await chrome.tabs.create({ url: 'https://web.whatsapp.com/' });
    });
  }

  // Ação: Verificar se página está pronta
  if (btnCheckReady) {
    btnCheckReady.addEventListener('click', async () => {
      const tab = await updateTabStatus();
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
  }

  // Checagem inicial da aba
  await updateTabStatus();
});
