import { BigQueryClient } from './bigquery-client.js';

/**
 * Cliente de persistência especializado para WhatsApp no BigQuery.
 * Utiliza internamente a instância do BigQueryClient genérico para gravar
 * conversas, mensagens, mídias e metadados nas tabelas de histórico.
 */
export class ChatPersistenceClient {
  /**
   * @param {Object} [config={}]
   * @param {BigQueryClient} [config.bigQueryClient] Instância pré-configurada do cliente BigQuery
   * @param {string} [config.chatsTable='chats'] Nome da tabela de conversas
   * @param {string} [config.messagesTable='messages'] Nome da tabela de mensagens
   */
  constructor({ bigQueryClient = null, chatsTable = 'chats', messagesTable = 'messages' } = {}) {
    this.bq = bigQueryClient || new BigQueryClient();
    this.chatsTable = chatsTable;
    this.messagesTable = messagesTable;
  }

  /**
   * Salva ou atualiza os metadados de uma conversa no BigQuery
   * @param {Object} chat Objeto de conversa (id, title, isGroup, unreadCount, lastMessageAt, etc.)
   * @returns {Promise<any>}
   */
  async saveChat(chat) {
    // TODO: Mapear para o schema da tabela de chats e chamar this.bq.insertAll()
    throw new Error('Método ChatPersistenceClient.saveChat() ainda não implementado.');
  }

  /**
   * Salva em lote múltiplas conversas
   * @param {Array<Object>} chats Lista de conversas
   * @returns {Promise<any>}
   */
  async saveChats(chats) {
    // TODO: Mapear lote de chats e chamar this.bq.insertAll()
    throw new Error('Método ChatPersistenceClient.saveChats() ainda não implementado.');
  }

  /**
   * Salva o histórico de mensagens de uma conversa
   * @param {string} chatId Identificador único do chat/conversa
   * @param {Array<Object>} messages Lista de mensagens normalizadas
   * @returns {Promise<any>}
   */
  async saveMessages(chatId, messages) {
    // TODO: Mapear mensagens para o schema de mensagens e chamar this.bq.insertAll()
    throw new Error('Método ChatPersistenceClient.saveMessages() ainda não implementado.');
  }

  /**
   * Consulta a data/timestamp da última mensagem sincronizada para evitar duplicações
   * @param {string} chatId Identificador único do chat
   * @returns {Promise<string|null>} ISO string da última mensagem ou null
   */
  async getLastMessageTimestamp(chatId) {
    // TODO: Executar query SQL via this.bq.query() para obter MAX(timestamp)
    throw new Error('Método ChatPersistenceClient.getLastMessageTimestamp() ainda não implementado.');
  }
}
