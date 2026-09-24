import { Logger } from '../utils/logger.js';

const log = new Logger('StorageClient');

/**
 * Cliente de persistência assíncrono para chrome.storage.local
 */
export class StorageClient {
  /**
   * Obtém um ou mais valores do storage local
   * @param {string|string[]} keys Chave ou array de chaves
   * @param {any} [defaultValue=null] Valor padrão caso a chave não exista
   * @returns {Promise<any>}
   */
  static async get(keys, defaultValue = null) {
    try {
      const result = await chrome.storage.local.get(keys);
      if (typeof keys === 'string') {
        return result[keys] !== undefined ? result[keys] : defaultValue;
      }
      return result;
    } catch (err) {
      log.error(`Erro ao obter chave(s) "${keys}":`, err);
      return defaultValue;
    }
  }

  /**
   * Grava um ou múltiplos pares chave-valor no storage local
   * @param {Object|string} keyOrObject Objeto chave-valor ou nome da chave
   * @param {any} [value] Valor caso o primeiro argumento seja uma string
   * @returns {Promise<boolean>}
   */
  static async set(keyOrObject, value) {
    try {
      const payload = typeof keyOrObject === 'string'
        ? { [keyOrObject]: value }
        : keyOrObject;
      await chrome.storage.local.set(payload);
      return true;
    } catch (err) {
      log.error('Erro ao salvar dados no storage:', err);
      return false;
    }
  }

  /**
   * Remove uma ou mais chaves do storage
   * @param {string|string[]} keys
   * @returns {Promise<boolean>}
   */
  static async remove(keys) {
    try {
      await chrome.storage.local.remove(keys);
      return true;
    } catch (err) {
      log.error(`Erro ao remover chave(s) "${keys}":`, err);
      return false;
    }
  }

  /**
   * Limpa todo o storage da extensão
   * @returns {Promise<boolean>}
   */
  static async clear() {
    try {
      await chrome.storage.local.clear();
      log.info('Storage local limpo com sucesso.');
      return true;
    } catch (err) {
      log.error('Erro ao limpar storage:', err);
      return false;
    }
  }
}
