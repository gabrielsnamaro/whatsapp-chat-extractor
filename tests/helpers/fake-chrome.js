import { readFileSync } from 'node:fs';
import { ACTIONS } from '../../shared/constants/actions.js';
import { StagingRepository } from '../../shared/storage/staging-repository.js';
import { ArchiveDownloader } from '../../background/archive-downloader.js';

// Os testes rodam fora do Chrome: este módulo simula só o que o background usa da API chrome,
// o content script da aba do WhatsApp e os dois pontos que dependem de IndexedDB/offscreen
// (StagingRepository e ArchiveDownloader). Não é um arquivo de teste: o runner só executa *.test.js.

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

export const WHATSAPP_TAB_ID = 7;
const WHATSAPP_URL = 'https://web.whatsapp.com/';
const NO_RECEIVER_ERROR = 'Could not establish connection. Receiving end does not exist.';

function createEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (listener) => { listeners.add(listener); },
    removeListener: (listener) => { listeners.delete(listener); },
    hasListener: (listener) => listeners.has(listener),
    dispatch: (...args) => listeners.forEach((listener) => listener(...args))
  };
}

function urlPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Content script simulado da aba do WhatsApp. Por padrão responde sucesso ao
 * EXPORT_CHAT_REQUEST sem entregar arquivo nenhum (como se o WhatsApp não gerasse o download);
 * cada cenário define `onExport` para entregar o arquivo (deliverFile) ou falhar (resposta de falha
 * ou exceção; um `code` em texto na exceção vai na resposta, como no content real).
 */
function createFakeContent({ chats, ready }) {
  const content = {
    present: true,
    injected: false,
    ready,
    chats,
    readyChecks: 0,
    received: [],
    exportRequests: [],
    /** @type {null|function(Object): (Object|Promise<Object>)} */
    onExport: null,

    async handle(message) {
      switch (message.action) {
        case ACTIONS.CHECK_PAGE_READY:
          content.readyChecks++;
          return { success: true, ready: content.ready, url: WHATSAPP_URL };

        case ACTIONS.SCAN_CHATS_REQUEST: {
          const found = structuredClone(content.chats);
          return { success: true, chats: message.maxLimit ? found.slice(0, message.maxLimit) : found };
        }

        case ACTIONS.EXPORT_CHAT_REQUEST:
          content.exportRequests.push({ ...message, receivedAt: performance.now() });
          if (!content.onExport) return { success: true, triggered: true };
          // Como o content real: um erro na página vira resposta de falha, com o código dele, não exceção
          try {
            return await content.onExport(message);
          } catch (err) {
            return { success: false, cancelled: false, error: err.message, code: typeof err.code === 'string' ? err.code : null };
          }

        case ACTIONS.DISARM_EXPORT_CAPTURE:
        case ACTIONS.CANCEL_CURRENT_OPERATION:
          return { success: true };

        default:
          return { success: false, error: `Ação não reconhecida no content script: ${message.action}` };
      }
    }
  };
  return content;
}

/**
 * API chrome falsa. Os métodos assíncronos no Chrome devolvem Promise, porque o background encadeia
 * .then/.catch em chamadas "dispara e esquece"; getManifest, getURL e add/removeListener são síncronos, como no Chrome. O storage clona no set e no get: o orquestrador grava
 * `...this.run` vivo, e guardar a referência faria o snapshot mudar junto com a execução.
 * @param {Object} [options]
 * @param {Array<{ id: string, title: string, duplicateTitle?: boolean }>} [options.chats]
 * @param {boolean} [options.ready=true] Resposta do CHECK_PAGE_READY
 * @param {Object} [options.storage] Conteúdo inicial do chrome.storage.local (clonado)
 */
export function createFakeChrome({ chats = [], ready = true, storage = {} } = {}) {
  const store = new Map(Object.entries(structuredClone(storage)));
  const tabs = [{ id: WHATSAPP_TAB_ID, url: WHATSAPP_URL, active: true, lastAccessed: 1 }];
  const content = createFakeContent({ chats, ready });
  const runtimeMessages = [];
  const injections = [];
  const downloadCalls = [];

  const keysOf = (keys) => {
    if (keys == null) return [...store.keys()];
    if (typeof keys === 'string') return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys);
  };

  const recordDownloadCall = (method) => async (...args) => {
    downloadCalls.push({ method, args: structuredClone(args) });
    return method === 'search' ? [] : undefined;
  };

  const api = {
    runtime: {
      id: 'fake-extension-id',
      getManifest: () => structuredClone(manifest),
      getURL: (path) => `chrome-extension://fake-extension-id/${path}`,
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
      sendMessage: async (message) => {
        runtimeMessages.push(structuredClone(message));
      },
      onMessage: createEvent()
    },

    storage: {
      local: {
        get: async (keys) => {
          const result = {};
          for (const key of keysOf(keys)) {
            if (store.has(key)) result[key] = structuredClone(store.get(key));
            else if (keys && typeof keys === 'object' && !Array.isArray(keys)) result[key] = keys[key];
          }
          return result;
        },
        set: async (items) => {
          for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value));
        },
        remove: async (keys) => {
          for (const key of keysOf(keys)) store.delete(key);
        },
        clear: async () => { store.clear(); }
      }
    },

    tabs: {
      query: async ({ url } = {}) => {
        const pattern = url ? urlPatternToRegExp(url) : null;
        return structuredClone(tabs.filter((tab) => !pattern || pattern.test(tab.url)));
      },
      sendMessage: async (tabId, message) => {
        if (!tabs.some((tab) => tab.id === tabId) || !content.present) {
          throw new Error(NO_RECEIVER_ERROR);
        }
        const copy = structuredClone(message);
        content.received.push(copy);
        return content.handle(copy);
      }
    },

    scripting: {
      executeScript: async ({ target, files }) => {
        injections.push(structuredClone({ target, files }));
        content.present = true;
        content.injected = true;
        return [{ frameId: 0, result: undefined }];
      }
    },

    downloads: {
      onCreated: createEvent(),
      onChanged: createEvent(),
      download: recordDownloadCall('download'),
      search: recordDownloadCall('search'),
      pause: recordDownloadCall('pause'),
      resume: recordDownloadCall('resume'),
      cancel: recordDownloadCall('cancel'),
      erase: recordDownloadCall('erase'),
      removeFile: recordDownloadCall('removeFile')
    }
  };

  return {
    api,
    content,
    tabs,
    runtimeMessages,
    injections,
    downloadCalls,
    /** Cópia do chrome.storage.local, para simular o que sobrevive a um reinício do service worker */
    snapshotStorage: () => structuredClone(Object.fromEntries(store)),
    /** Valor gravado numa chave, clonado */
    readStorage: (key) => structuredClone(store.get(key)),
    /** Mensagens WORKFLOW_PROGRESS_UPDATE enviadas ao popup */
    progressUpdates: () => runtimeMessages.filter((m) => m.action === ACTIONS.WORKFLOW_PROGRESS_UPDATE),
    /** Ações recebidas pela aba, na ordem */
    receivedActions: () => content.received.map((m) => m.action)
  };
}

/**
 * Instala a API falsa em globalThis.chrome. O import dos módulos do background não toca em
 * chrome; só as chamadas, então basta instalar antes de usar o orquestrador.
 */
export function installFakeChrome(fake) {
  globalThis.chrome = fake.api;
}

export function uninstallFakeChrome() {
  delete globalThis.chrome;
}

/**
 * Entrega o arquivo de uma captura como o content script faz: START, blocos base64 e END,
 * direto no registry do orquestrador (no Chrome, o service worker roteia essas mensagens para lá).
 * Como o content real, lança erro se o background recusar alguma mensagem.
 * @param {import('../../background/extraction-orchestrator.js').ExtractionOrchestrator} orch
 * @param {string} captureId
 * @param {Uint8Array|string} bytes
 * @param {Object} [options]
 * @param {string} [options.filename='conversa.zip']
 * @param {string} [options.mimeType='application/zip']
 * @param {number} [options.chunkBytes] Tamanho de cada bloco (padrão: um bloco só)
 * @param {'page'|'download'} [options.source='page']
 * @returns {Array<Object>} Respostas do registry, na ordem
 */
export function deliverFile(orch, captureId, bytes, {
  filename = 'conversa.zip',
  mimeType = 'application/zip',
  chunkBytes,
  source = 'page'
} = {}) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  const size = new Blob([data]).size;
  const chunkSize = chunkBytes || Math.max(1, data.length);
  const totalChunks = Math.max(1, Math.ceil(data.length / chunkSize));

  const messages = [{ action: ACTIONS.EXPORT_TRANSFER_START, captureId, filename, mimeType, size, totalChunks, source }];
  for (let index = 0; index < totalChunks; index++) {
    const chunk = data.subarray(index * chunkSize, (index + 1) * chunkSize);
    messages.push({ action: ACTIONS.EXPORT_TRANSFER_CHUNK, captureId, index, data: Buffer.from(chunk).toString('base64') });
  }
  messages.push({ action: ACTIONS.EXPORT_TRANSFER_END, captureId });

  return messages.map((message) => {
    const response = orch.captures.handleTransferMessage(message);
    if (!response?.success) {
      throw new Error(response?.error || `O background recusou ${message.action}.`);
    }
    return response;
  });
}

/**
 * Troca o StagingRepository (IndexedDB, que não existe no Node) por um Map por chatId.
 * Os métodos estáticos são trocados por atribuição: o binding do import é o mesmo objeto.
 * `saves` guarda toda gravação, inclusive as que o clear() do fim da execução apaga de `files`.
 * @returns {{ files: Map<string, Object>, saves: Array<Object>, restore: function(): void }}
 */
export function stubStaging() {
  const files = new Map();
  const saves = [];
  const original = {
    saveChatFile: StagingRepository.saveChatFile,
    listKeys: StagingRepository.listKeys,
    getFile: StagingRepository.getFile,
    clear: StagingRepository.clear
  };

  StagingRepository.saveChatFile = async ({ chatId, chatTitle, filename, blob }) => {
    const record = { chatId, chatTitle, filename, blob, size: blob.size };
    files.set(chatId, record);
    saves.push(record);
  };
  StagingRepository.listKeys = async () => [...files.keys()].sort();
  StagingRepository.getFile = async (chatId) => files.get(chatId);
  StagingRepository.clear = async () => { files.clear(); };

  return {
    files,
    saves,
    restore: () => { Object.assign(StagingRepository, original); }
  };
}

/**
 * Troca o ArchiveDownloader.buildAndDownload (offscreen document + chrome.downloads) por um
 * stub que guarda o que recebeu e o que havia no staging naquele momento.
 * @param {Object} [options]
 * @param {{ files: Map<string, Object> }} [options.staging]
 * @param {Object} [options.outcome] Resposta fixa; por padrão, download concluído
 * @returns {{ calls: Array<{ archiveFilename: string, report: string, stagedKeys: string[] }>, restore: function(): void }}
 */
export function stubArchiveDownloader({ staging, outcome } = {}) {
  const original = ArchiveDownloader.buildAndDownload;
  const calls = [];

  ArchiveDownloader.buildAndDownload = async ({ archiveFilename, report }) => {
    const stagedKeys = staging ? [...staging.files.keys()].sort() : [];
    calls.push({ archiveFilename, report, stagedKeys });
    return outcome ?? { completed: true, size: 2048, chatCount: stagedKeys.length };
  };

  return {
    calls,
    restore: () => { ArchiveDownloader.buildAndDownload = original; }
  };
}

/**
 * Espera uma condição ficar verdadeira, conferindo a cada poucos milissegundos
 * @param {function(): boolean} predicate
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=2000]
 * @param {string} [options.description]
 */
export async function waitUntil(predicate, { timeoutMs = 2000, description = 'condição' } = {}) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) {
      throw new Error(`Tempo esgotado esperando: ${description}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
