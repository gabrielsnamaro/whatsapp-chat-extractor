// Marcas invisíveis de direção do texto, que podem vir em volta de um número exibido pelo WhatsApp Web; não
// fazem parte do telefone
const DIRECTION_MARKS_PATTERN = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// "+" opcional no começo e, depois, só dígitos e a pontuação com que um número aparece formatado
const PHONE_TEXT_PATTERN = /^\+?[\d\s().-]+$/;

// Menos de 10 dígitos não chega a ser DDD + número; mais de 15 passa do máximo do padrão E.164
const MIN_PHONE_DIGITS = 10;
const MAX_PHONE_DIGITS = 15;

/**
 * Só os dígitos de um telefone, sem acrescentar nem tirar nenhum (nem DDI, nem o 9º dígito)
 * @param {string|number|null|undefined} value
 * @returns {string|null} null quando não há nenhum dígito
 */
export function normalizePhoneDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits || null;
}

/**
 * Os dígitos do telefone quando o texto (o título de uma conversa ou o nome de um remetente) é só um
 * telefone, como "+55 11 99999-9999"; null quando é um nome, mesmo que tenha dígitos
 * @param {string|null|undefined} title
 * @returns {string|null}
 */
export function phoneFromTitle(title) {
  if (typeof title !== 'string') return null;
  const text = title.replace(DIRECTION_MARKS_PATTERN, '').trim();
  if (!PHONE_TEXT_PATTERN.test(text)) return null;
  const digits = normalizePhoneDigits(text);
  if (!digits || digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) return null;
  return digits;
}
