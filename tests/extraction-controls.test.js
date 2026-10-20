import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExtractionControls, normalizeSafeDelaySeconds, normalizeHistoryLimitSeconds } from '../popup/ui/extraction-controls.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { createFakeChrome, installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.js';

// O ExtractionControls só lê o document no construtor; depois mexe apenas nos elementos guardados

const ELEMENT_IDS = [
  'mode-all', 'mode-limit', 'max-chats-input', 'safe-delay-input', 'history-limit-input', 'line-phone-row', 'line-phone-input',
  'btn-start-batch', 'btn-pause-batch', 'btn-resume-batch', 'btn-cancel-batch'
];

function fakeElement() {
  const listeners = {};
  const classes = new Set();
  return {
    value: '',
    checked: false,
    disabled: false,
    validity: { badInput: false },
    focus() {},
    addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener); },
    dispatch: (type) => (listeners[type] ?? []).forEach((listener) => listener()),
    classList: {
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
      contains: (name) => classes.has(name)
    }
  };
}

function createControls({ storage = {} } = {}) {
  installFakeChrome(createFakeChrome({ storage }));
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, fakeElement()]));
  elements['mode-limit'].checked = true;
  elements['max-chats-input'].value = '3';
  elements['safe-delay-input'].value = '2';
  elements['history-limit-input'].value = '60';
  globalThis.document = { getElementById: (id) => elements[id] ?? null };
  try {
    return {
      controls: new ExtractionControls(),
      elements,
      delayInput: elements['safe-delay-input'],
      historyInput: elements['history-limit-input']
    };
  } finally {
    delete globalThis.document;
  }
}

async function savedConfig() {
  const { extractionConfig } = await chrome.storage.local.get('extractionConfig');
  return extractionConfig;
}

afterEach(() => {
  uninstallFakeChrome();
});

test('intervalo entre conversas: vazio volta ao padrão de 2 s; inválido ou abaixo de 1 s vai para 1 s', () => {
  assert.equal(normalizeSafeDelaySeconds(''), 2);
  assert.equal(normalizeSafeDelaySeconds('   '), 2);
  assert.equal(normalizeSafeDelaySeconds('0.5'), 1);
  assert.equal(normalizeSafeDelaySeconds('0'), 1);
  assert.equal(normalizeSafeDelaySeconds('-3'), 1);
  assert.equal(normalizeSafeDelaySeconds('abc'), 1);
  assert.equal(normalizeSafeDelaySeconds('Infinity'), 1);
  assert.equal(normalizeSafeDelaySeconds('1'), 1);
  assert.equal(normalizeSafeDelaySeconds('1.5'), 1.5);
  assert.equal(normalizeSafeDelaySeconds('10'), 10);
  // Texto que o navegador recusou chega como valor vazio, mas não é campo vazio
  assert.equal(normalizeSafeDelaySeconds('', { badInput: true }), 1);
});

test('getOptions devolve o intervalo validado em ms', () => {
  const { controls, delayInput } = createControls();

  delayInput.value = '1.5';
  assert.deepEqual(controls.getOptions(), { downloadAll: false, maxChats: 3, safeDelayMs: 1500, historyLimitMs: 60000 });

  delayInput.value = '0.5';
  assert.equal(controls.getOptions().safeDelayMs, 1000);

  delayInput.value = '';
  assert.equal(controls.getOptions().safeDelayMs, 2000);

  delayInput.validity.badInput = true;
  assert.equal(controls.getOptions().safeDelayMs, 1000);
});

test('ao sair do campo, um valor abaixo do mínimo volta para 1 no campo e é salvo em extractionConfig', async () => {
  const { delayInput } = createControls();

  delayInput.value = '0.5';
  delayInput.dispatch('change');
  // O listener não devolve a promessa da gravação
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(delayInput.value, '1');
  assert.deepEqual(await savedConfig(), { downloadAll: false, maxChats: 3, safeDelayMs: 1000, historyLimitMs: 60000 });
});

test('o intervalo salvo é restaurado ao abrir o popup, e sem preferência salva o campo mostra 2', async () => {
  const restored = createControls({ storage: { extractionConfig: { downloadAll: false, maxChats: 5, safeDelayMs: 3500 } } });
  restored.delayInput.value = '';
  await restored.controls.loadPreferences();
  assert.equal(restored.delayInput.value, '3.5');
  assert.equal(restored.controls.getOptions().safeDelayMs, 3500);
  uninstallFakeChrome();

  // Preferência gravada antes do campo existir
  const older = createControls({ storage: { extractionConfig: { downloadAll: true, maxChats: null } } });
  older.delayInput.value = '';
  await older.controls.loadPreferences();
  assert.equal(older.delayInput.value, '2');
});

test('o campo do intervalo fica desabilitado durante a execução e na pausa', () => {
  const { controls, delayInput } = createControls();

  for (const state of [WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.EXPORTING, WORKFLOW_STATES.PACKAGING, WORKFLOW_STATES.PAUSED]) {
    controls.updateUiState(state);
    assert.equal(delayInput.disabled, true, state);
  }
  for (const state of [WORKFLOW_STATES.IDLE, WORKFLOW_STATES.COMPLETED, WORKFLOW_STATES.FAILED, WORKFLOW_STATES.CANCELLED]) {
    controls.updateUiState(state);
    assert.equal(delayInput.disabled, false, state);
  }
});

// Campo do limite para carregar as mensagens mais antigas do celular

test('limite das mensagens antigas: vazio, inválido ou negativo volta ao padrão de 60 s; só o 0 desliga; acima de 180 s vai para 180; segundos inteiros', () => {
  assert.equal(normalizeHistoryLimitSeconds(''), 60);
  assert.equal(normalizeHistoryLimitSeconds('   '), 60);
  assert.equal(normalizeHistoryLimitSeconds('abc'), 60);
  assert.equal(normalizeHistoryLimitSeconds('-5'), 60);
  assert.equal(normalizeHistoryLimitSeconds('Infinity'), 60);
  assert.equal(normalizeHistoryLimitSeconds('0'), 0);
  assert.equal(normalizeHistoryLimitSeconds('30'), 30);
  assert.equal(normalizeHistoryLimitSeconds('2.4'), 2);
  // Um valor positivo nunca vira 0, que desligaria a carga
  assert.equal(normalizeHistoryLimitSeconds('0.4'), 1);
  assert.equal(normalizeHistoryLimitSeconds('180'), 180);
  assert.equal(normalizeHistoryLimitSeconds('181'), 180);
  assert.equal(normalizeHistoryLimitSeconds('6000'), 180);
  // Texto que o navegador recusou chega como valor vazio
  assert.equal(normalizeHistoryLimitSeconds('', { badInput: true }), 60);
});

test('limite das mensagens antigas: vai em ms nas opções e no início; ao sair do campo, é corrigido e salvo em extractionConfig', async () => {
  const { controls, elements, historyInput } = createControls();
  const started = [];
  controls.onStart((options) => started.push(options.historyLimitMs));

  historyInput.value = '0';
  assert.equal(controls.getOptions().historyLimitMs, 0);
  historyInput.value = '120';
  elements['btn-start-batch'].dispatch('click');
  assert.deepEqual(started, [120000]);

  historyInput.value = '9999';
  historyInput.dispatch('change');
  // O listener não devolve a promessa da gravação
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyInput.value, '180');
  assert.deepEqual(await savedConfig(), { downloadAll: false, maxChats: 3, safeDelayMs: 2000, historyLimitMs: 180000 });

  historyInput.value = '0';
  historyInput.dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(historyInput.value, '0');
  assert.equal((await savedConfig()).historyLimitMs, 0);
});

test('limite das mensagens antigas salvo é restaurado ao abrir o popup, inclusive o 0; sem ele na preferência, o campo mostra 60', async () => {
  const disabled = createControls({ storage: { extractionConfig: { downloadAll: true, maxChats: null, safeDelayMs: 2000, historyLimitMs: 0 } } });
  disabled.historyInput.value = '';
  await disabled.controls.loadPreferences();
  assert.equal(disabled.historyInput.value, '0');
  assert.equal(disabled.controls.getOptions().historyLimitMs, 0);
  uninstallFakeChrome();

  const custom = createControls({ storage: { extractionConfig: { downloadAll: true, maxChats: null, safeDelayMs: 2000, historyLimitMs: 90000 } } });
  custom.historyInput.value = '';
  await custom.controls.loadPreferences();
  assert.equal(custom.historyInput.value, '90');
  uninstallFakeChrome();

  // Preferência gravada antes do campo existir
  const older = createControls({ storage: { extractionConfig: { downloadAll: true, maxChats: null, safeDelayMs: 2000 } } });
  older.historyInput.value = '';
  await older.controls.loadPreferences();
  assert.equal(older.historyInput.value, '60');
  assert.equal(older.controls.getOptions().historyLimitMs, 60000);
});

test('o campo do limite das mensagens antigas fica desabilitado durante a execução e na pausa', () => {
  const { controls, historyInput } = createControls();

  for (const state of [WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.EXPORTING, WORKFLOW_STATES.PACKAGING, WORKFLOW_STATES.PAUSED]) {
    controls.updateUiState(state);
    assert.equal(historyInput.disabled, true, state);
  }
  for (const state of [WORKFLOW_STATES.IDLE, WORKFLOW_STATES.COMPLETED, WORKFLOW_STATES.FAILED, WORKFLOW_STATES.CANCELLED]) {
    controls.updateUiState(state);
    assert.equal(historyInput.disabled, false, state);
  }
});

test('o popup tem o campo do limite das mensagens antigas, com 60 s de padrão, de 0 a 180, e a explicação do teto e de que 0 desliga', () => {
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const input = /<input [^>]*id="history-limit-input"[^>]*>/.exec(html)?.[0];
  assert.ok(input, 'campo do limite não encontrado no popup');
  assert.match(input, /type="number"/);
  assert.match(input, /min="0"/);
  assert.match(input, /max="180"/);
  assert.match(input, /value="60"/);
  assert.match(html, /<label for="history-limit-input"[^>]*>Mensagens antigas do celular \(s\):<\/label>/);
  assert.match(html, /<p class="input-hint">[^<]*até 180 s[^<]*0 desliga\.<\/p>/);
});

// Campo "Número da linha": só aparece quando a linha da conta não é detectada na aba

const LINE_PHONE_REQUIRED_MESSAGE = 'Informe o número da linha (a conta logada no WhatsApp Web) com o DDI, ' +
  'de 10 a 15 dígitos (ex.: 5511999999999), para iniciar.';

test('número da linha com o campo escondido (linha detectada na aba): o início vai sem ele, mesmo com algo digitado', () => {
  const { controls, elements } = createControls();
  elements['line-phone-input'].value = '5511999999999';
  const started = [];
  controls.onStart((options) => started.push(options), () => assert.fail('o campo escondido não deveria ser conferido'));

  elements['btn-start-batch'].dispatch('click');

  assert.deepEqual(started, [{ downloadAll: false, maxChats: 3, safeDelayMs: 2000, historyLimitMs: 60000, linePhone: null }]);
});

test('número da linha à mostra: colado com +, espaços, parênteses e hífens, vai só com os dígitos nas opções do início', () => {
  const { controls, elements } = createControls();
  const row = elements['line-phone-row'];
  const input = elements['line-phone-input'];
  const started = [];
  controls.onStart((options) => started.push(options), () => assert.fail('um número válido não deveria ser recusado'));

  controls.setLinePhoneVisible(true);
  assert.equal(row.classList.contains('hidden'), false);
  input.value = '+55 (11) 99999-9999';
  assert.equal(controls.getStartOptions().linePhone, '5511999999999');
  // Ao sair do campo, ele fica só com os dígitos
  input.dispatch('change');
  assert.equal(input.value, '5511999999999');

  elements['btn-start-batch'].dispatch('click');
  assert.deepEqual(started, [{ downloadAll: false, maxChats: 3, safeDelayMs: 2000, historyLimitMs: 60000, linePhone: '5511999999999' }]);
  // As preferências continuam sem o número
  assert.deepEqual(controls.getOptions(), { downloadAll: false, maxChats: 3, safeDelayMs: 2000, historyLimitMs: 60000 });

  controls.setLinePhoneVisible(false);
  assert.equal(row.classList.contains('hidden'), true);
  assert.equal(controls.getStartOptions().linePhone, null);
});

test('número da linha à mostra: só inicia com 10 a 15 dígitos; vazio, curto, longo ou com letra dá o aviso e não inicia', () => {
  const { controls, elements } = createControls();
  const input = elements['line-phone-input'];
  const started = [];
  const warnings = [];
  controls.onStart((options) => started.push(options.linePhone), (message) => warnings.push(message));
  controls.setLinePhoneVisible(true);

  const invalid = ['', '   ', '99999-9999', '+999 9999 99999-9999', '551199999999O', 'Maria'];
  for (const value of invalid) {
    input.value = value;
    input.dispatch('change');
    assert.equal(input.value, value, 'um número inválido fica no campo como foi digitado');
    elements['btn-start-batch'].dispatch('click');
  }
  assert.deepEqual(started, []);
  assert.deepEqual(warnings, invalid.map(() => LINE_PHONE_REQUIRED_MESSAGE));

  for (const value of ['1199999999', '999999999999999']) {
    input.value = value;
    elements['btn-start-batch'].dispatch('click');
  }
  assert.deepEqual(started, ['1199999999', '999999999999999']);
});

test('o número da linha não é gravado em extractionConfig nem em outra chave do storage', async () => {
  const { controls, elements, delayInput } = createControls();
  const input = elements['line-phone-input'];
  controls.setLinePhoneVisible(true);
  input.value = '+55 11 99999-9999';
  input.dispatch('change');

  // Outra opção muda e as preferências são salvas, com o número no campo
  delayInput.value = '3';
  delayInput.dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  await controls.savePreferences();

  assert.deepEqual(await savedConfig(), { downloadAll: false, maxChats: 3, safeDelayMs: 3000, historyLimitMs: 60000 });
  const stored = await chrome.storage.local.get(null);
  assert.deepEqual(Object.keys(stored), ['extractionConfig']);
  assert.equal(JSON.stringify(stored).includes('5511999999999'), false);
});

test('o campo do número da linha fica desabilitado durante a execução e na pausa', () => {
  const { controls, elements } = createControls();
  const input = elements['line-phone-input'];

  for (const state of [WORKFLOW_STATES.SCANNING, WORKFLOW_STATES.EXPORTING, WORKFLOW_STATES.PACKAGING, WORKFLOW_STATES.PAUSED]) {
    controls.updateUiState(state);
    assert.equal(input.disabled, true, state);
  }
  for (const state of [WORKFLOW_STATES.IDLE, WORKFLOW_STATES.COMPLETED, WORKFLOW_STATES.FAILED, WORKFLOW_STATES.CANCELLED]) {
    controls.updateUiState(state);
    assert.equal(input.disabled, false, state);
  }
});

// Avisos fixos do popup, à vista antes de iniciar

test('o popup mostra, antes do botão de iniciar, o aviso de manter a aba do WhatsApp Web à vista, sem minimizar nem cobrir a janela, ao lado do de leitura', () => {
  const html = readFileSync(new URL('../popup/popup.html', import.meta.url), 'utf8');
  const startButtonAt = html.indexOf('id="btn-start-batch"');
  const visibilityNotice = '<p class="tab-visibility-notice">Mantenha a aba do WhatsApp Web à vista durante a extração: pode ' +
    'ser numa janela separada, mas sem minimizar e sem outra janela por cima dela. Se ela sair da tela, a extração pausa e ' +
    'continua quando ela voltar a aparecer.</p>';
  const visibilityNoticeAt = html.indexOf(visibilityNotice);
  const readReceiptNoticeAt = html.indexOf('<p class="read-receipt-notice">');

  assert.ok(startButtonAt > 0, 'botão de iniciar não encontrado no popup');
  assert.ok(visibilityNoticeAt > 0, 'aviso da aba visível não encontrado no popup');
  assert.ok(readReceiptNoticeAt > 0 && readReceiptNoticeAt < visibilityNoticeAt && visibilityNoticeAt < startButtonAt);
  // Sem classe que o esconda: o aviso fica à vista em qualquer estado da extração
  assert.equal(/<p class="tab-visibility-notice[^"]*hidden/.test(html), false);
  // O mesmo estilo do aviso de leitura
  const css = readFileSync(new URL('../popup/popup.css', import.meta.url), 'utf8');
  assert.match(css, /\.read-receipt-notice,\s*\.tab-visibility-notice\s*\{/);
});
