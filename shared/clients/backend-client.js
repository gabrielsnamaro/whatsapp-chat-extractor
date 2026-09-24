import { HttpClient } from './http-client.js';
import { StorageClient } from './storage-client.js';
import { Logger } from '../utils/logger.js';

const log = new Logger('BackendClient');

/**
 * Cliente de alto nível para integração com APIs e backends externos.
 * Deve ser instanciado e consumido preferencialmente no background (service-worker).
 */
export class BackendClient {
  /**
   * @param {Object} [config={}]
   * @param {string} [config.baseUrl] URL base da API
   * @param {string} [config.apiKey] Token ou chave de API de autenticação
   */
  constructor({ baseUrl = '', apiKey = '' } = {}) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.http = new HttpClient({
      baseUrl: this.baseUrl,
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
    });
  }

  /**
   * Inicializa o cliente carregando credenciais previamente salvas no storage
   * @returns {Promise<BackendClient>}
   */
  static async fromStorage() {
    const config = await StorageClient.get(['backendApiUrl', 'backendApiKey'], {});
    return new BackendClient({
      baseUrl: config.backendApiUrl || '',
      apiKey: config.backendApiKey || ''
    });
  }

  /**
   * Atualiza as credenciais ativas do cliente
   * @param {string} baseUrl
   * @param {string} apiKey
   */
  setCredentials(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.http = new HttpClient({
      baseUrl: this.baseUrl,
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}
    });
  }

  /**
   * Verifica a conectividade com o backend
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    if (!this.baseUrl) {
      log.warn('Nenhuma URL de backend configurada.');
      return false;
    }
    try {
      const response = await this.http.get('/health', { timeoutMs: 5000 });
      log.info('Health check do backend bem-sucedido:', response);
      return true;
    } catch (err) {
      log.error('Falha ao verificar saúde do backend:', err.message);
      return false;
    }
  }

  /**
   * Envia lote de metadados de conversas extraídas
   * @param {Array<Object>} chats
   * @returns {Promise<any>}
   */
  async syncChats(chats) {
    log.info(`Enviando ${chats.length} conversas para o backend...`);
    return this.http.post('/api/chats/sync', {
      timestamp: new Date().toISOString(),
      chats
    });
  }

  /**
   * Envia histórico de mensagens de uma conversa específica
   * @param {string} chatId Identificador da conversa
   * @param {Array<Object>} messages Lista de mensagens
   * @returns {Promise<any>}
   */
  async syncMessages(chatId, messages) {
    log.info(`Enviando ${messages.length} mensagens do chat "${chatId}"...`);
    return this.http.post(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      timestamp: new Date().toISOString(),
      chatId,
      messages
    });
  }
}
