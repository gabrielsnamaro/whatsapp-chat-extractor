import { Logger } from '../utils/logger.js';

const log = new Logger('HttpClient');

/**
 * Cliente HTTP base para comunicação de rede no background
 */
export class HttpClient {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.baseUrl=''] URL base para as requisições
   * @param {Record<string, string>} [options.headers={}] Cabeçalhos padrão
   * @param {number} [options.timeoutMs=15000] Timeout padrão em milissegundos
   * @param {number} [options.maxRetries=2] Número máximo de retentativas
   */
  constructor({ baseUrl = '', headers = {}, timeoutMs = 15000, maxRetries = 2 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
  }

  /**
   * Executa requisição com suporte a timeout e retries
   * @param {string} endpoint Caminho ou URL completa
   * @param {RequestInit} [options={}] Opções do fetch
   * @param {number} [retryCount=0] Contador de retentativas atual
   * @returns {Promise<any>}
   */
  async request(endpoint, options = {}, retryCount = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}/${endpoint.replace(/^\//, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.defaultHeaders,
          ...(options.headers || {})
        },
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} (${response.statusText}): ${errorText}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } catch (err) {
      clearTimeout(timer);

      const isTimeout = err.name === 'AbortError';
      const isNetworkError = isTimeout || err.message.includes('Failed to fetch');

      if (isNetworkError && retryCount < this.maxRetries) {
        const delay = Math.pow(2, retryCount) * 1000;
        log.warn(`Falha na requisição para ${url}. Tentando novamente em ${delay}ms... (Tentativa ${retryCount + 1}/${this.maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        return this.request(endpoint, options, retryCount + 1);
      }

      log.error(`Erro ao executar requisição para ${url}:`, err);
      throw err;
    }
  }

  get(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'GET' });
  }

  post(endpoint, body, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
  }

  put(endpoint, body, options = {}) {
    return this.request(endpoint, {
      ...options,
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });
  }

  delete(endpoint, options = {}) {
    return this.request(endpoint, { ...options, method: 'DELETE' });
  }
}
