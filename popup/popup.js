/**
 * Popup Script (Manifest V3)
 * Ponto de entrada da interface do popup.
 * Inicializa os controladores especializados ExtractionControls e ProgressView.
 */
import { ACTIONS } from '../shared/constants/actions.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { ProgressView } from './ui/progress-view.js';
import { ExtractionControls } from './ui/extraction-controls.js';
import { findWhatsAppTab, countWhatsAppTabs } from '../shared/utils/whatsapp-tab.js';

document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('status-badge');
  const statusDetail = document.getElementById('status-detail');
  const btnOpenWa = document.getElementById('btn-open-wa');
  const btnCheckReady = document.getElementById('btn-check-ready');
  const logArea = document.getElementById('log-area');

  const progressView = new ProgressView();
  const controls = new ExtractionControls();

  /**
   * @param {string} text
   * @param {'info'|'warning'|'error'|'success'} [level='info']
   */
  function log(text, level = 'info') {
    if (!logArea) return;
    const entry = document.createElement('p');
    entry.className = level === 'info' ? 'log-entry' : `log-entry log-${level}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logArea.appendChild(entry);
    logArea.scrollTop = logArea.scrollHeight;
  }

  async function updateTabStatus() {
    try {
      const tab = await findWhatsAppTab();
      if (!tab) {
        statusBadge.textContent = 'Não aberto';
        statusBadge.className = 'badge disconnected';
        statusDetail.textContent = 'Nenhuma aba do WhatsApp Web aberta.';
        if (btnCheckReady) btnCheckReady.disabled = true;
        return null;
      }

      statusBadge.textContent = 'Detectado';
      statusBadge.className = 'badge connected';
      const tabCount = await countWhatsAppTabs();
      statusDetail.textContent = tabCount > 1
        ? `${tabCount} abas do WhatsApp Web abertas; será usada a ativa/mais recente (ID: ${tab.id}).`
        : `Aba ativa (ID: ${tab.id})`;
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

  /** Sincroniza a interface com o estado atual do orquestrador no background */
  async function refreshWorkflowState() {
    try {
      const response = await chrome.runtime.sendMessage({ action: ACTIONS.GET_WORKFLOW_STATE });
      if (response?.success && response.data) {
        progressView.renderProgress(response.data);
        controls.updateUiState(response.data.state);
        return response.data;
      }
    } catch (_) {}
    controls.updateUiState(WORKFLOW_STATES.IDLE);
    return null;
  }

  const initialState = await refreshWorkflowState();
  if (initialState?.statusMessage) {
    log(initialState.statusMessage, initialState.state === WORKFLOW_STATES.PAUSED ? 'warning' : 'info');
  }

  // Evita repetir no log a mesma conversa e o mesmo estado final a cada atualização
  let lastLoggedChat = null;
  let lastLoggedFinalState = null;

  // Escuta atualizações de progresso emitidas pelo background em tempo real
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action !== ACTIONS.WORKFLOW_PROGRESS_UPDATE) return;

    progressView.renderProgress(message);
    controls.updateUiState(message.state);

    // Na repescagem a posição é a da rodada: com a da fila, uma conversa repescada teria a mesma chave da
    // 1ª tentativa e não apareceria no log
    const position = message.retry
      ? `Repescagem ${message.retry.current}/${message.retry.total}`
      : `${message.current}/${message.total}`;
    const chatKey = `${position}:${message.currentChatTitle}`;
    if (message.currentChatTitle && message.state === WORKFLOW_STATES.EXPORTING && chatKey !== lastLoggedChat) {
      lastLoggedChat = chatKey;
      log(`[${position}] Exportando "${message.currentChatTitle}"...`);
    }
    if (message.warningMessage) log(message.warningMessage, 'warning');
    if (message.infoMessage) log(message.infoMessage, message.state === WORKFLOW_STATES.COMPLETED ? 'success' : 'info');

    if (message.state !== lastLoggedFinalState) {
      if (message.state === WORKFLOW_STATES.FAILED) log(`❌ Falha: ${message.errorMessage}`, 'error');
      if (message.state === WORKFLOW_STATES.CANCELLED) log('Extração cancelada.', 'warning');
      lastLoggedFinalState = message.state;
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
        safeDelayMs: options.safeDelayMs
      });

      if (!res || !res.success) {
        log(`Erro ao iniciar: ${res?.error || 'Desconhecido'}`, 'error');
        await refreshWorkflowState();
      }
    } catch (err) {
      log(`Erro de comunicação com o Service Worker: ${err.message}`, 'error');
      controls.updateUiState(WORKFLOW_STATES.FAILED);
    }
  });

  // Ação: Pausar
  controls.onPause(async () => {
    log('Solicitando pausa...');
    const res = await chrome.runtime.sendMessage({ action: ACTIONS.PAUSE_BATCH_EXTRACTION });
    if (!res?.success) log('Não há etapa pausável no momento.', 'warning');
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
        log('⚠️ Falha ao comunicar com a página. Recarregue a aba do WhatsApp Web ou inicie a extração (o script é reinjetado).', 'warning');
      }
    });
  }

  // Checagem inicial da aba
  await updateTabStatus();
});
