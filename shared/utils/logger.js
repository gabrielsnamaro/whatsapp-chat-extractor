/**
 * Logger utilitário modular para background, popup e clients.
 */
export class Logger {
  /**
   * @param {string} moduleName Nome do módulo ou client emissor
   */
  constructor(moduleName = 'App') {
    this.prefix = `[WhatsApp Extractor :: ${moduleName}]`;
  }

  _formatMessage(message) {
    const timestamp = new Date().toLocaleTimeString();
    return `${this.prefix} [${timestamp}] ${message}`;
  }

  info(message, ...args) {
    console.log(this._formatMessage(message), ...args);
  }

  warn(message, ...args) {
    console.warn(this._formatMessage(message), ...args);
  }

  error(message, ...args) {
    console.error(this._formatMessage(message), ...args);
  }

  debug(message, ...args) {
    console.debug(this._formatMessage(message), ...args);
  }
}
