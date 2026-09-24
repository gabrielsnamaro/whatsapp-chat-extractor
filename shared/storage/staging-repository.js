import { Logger } from '../utils/logger.js';

const log = new Logger('StagingRepository');
const DB_NAME = 'whatsapp_staging_db';
const DB_VERSION = 1;
const STORE_NAME = 'staged_chats';

/**
 * Repositório isolado para retenção temporária de arquivos exportados no IndexedDB.
 * Permite armazenar blobs grandes sem sobrecarregar a memória RAM do Service Worker.
 */
export class StagingRepository {
  /**
   * Abre e inicializa a conexão com o IndexedDB
   * @private
   * @returns {Promise<IDBDatabase>}
   */
  static _openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'chatId' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        log.error('Falha ao abrir IndexedDB:', request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Salva ou atualiza um arquivo de exportação de chat no IndexedDB
   * @param {Object} entry
   * @param {string} entry.chatId Identificador do chat
   * @param {string} entry.chatTitle Título ou nome do contato/grupo
   * @param {string} entry.filename Nome do arquivo original (ex: conversa.txt ou chat.zip)
   * @param {Blob|ArrayBuffer} entry.blob Conteúdo binário
   * @returns {Promise<boolean>}
   */
  static async saveChatFile({ chatId, chatTitle, filename, blob }) {
    try {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);

        const record = {
          chatId,
          chatTitle: chatTitle || chatId,
          filename: filename || `${chatId}.txt`,
          blob,
          size: blob.size || (blob.byteLength ?? 0),
          createdAt: new Date().toISOString()
        };

        const req = store.put(record);
        req.onsuccess = () => {
          log.info(`Chat "${record.chatTitle}" (${(record.size / 1024).toFixed(1)} KB) armazenado no staging.`);
          resolve(true);
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (err) {
      log.error(`Erro ao salvar arquivo do chat ${chatId}:`, err);
      return false;
    }
  }

  /**
   * Retorna todos os arquivos armazenados no staging
   * @returns {Promise<Array<Object>>}
   */
  static async getAllFiles() {
    try {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (err) {
      log.error('Erro ao listar arquivos do staging:', err);
      return [];
    }
  }

  /**
   * Retorna a quantidade total de chats armazenados no staging
   * @returns {Promise<number>}
   */
  static async count() {
    try {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.count();

        req.onsuccess = () => resolve(req.result || 0);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (err) {
      log.error('Erro ao contar itens no staging:', err);
      return 0;
    }
  }

  /**
   * Limpa todo o repositório temporário de staging
   * @returns {Promise<boolean>}
   */
  static async clear() {
    try {
      const db = await this._openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.clear();

        req.onsuccess = () => {
          log.info('Repositório de staging limpo com sucesso.');
          resolve(true);
        };
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (err) {
      log.error('Erro ao limpar staging:', err);
      return false;
    }
  }
}
