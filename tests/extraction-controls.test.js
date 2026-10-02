import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ExtractionControls, normalizeSafeDelaySeconds } from '../popup/ui/extraction-controls.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';
import { createFakeChrome, installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.js';

// O ExtractionControls só lê o document no construtor; depois mexe apenas nos elementos guardados

const ELEMENT_IDS = [
  'mode-all', 'mode-limit', 'max-chats-input', 'safe-delay-input',
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
    classList: { toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)) }
  };
}

function createControls({ storage = {} } = {}) {
  installFakeChrome(createFakeChrome({ storage }));
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, fakeElement()]));
  elements['mode-limit'].checked = true;
  elements['max-chats-input'].value = '3';
  elements['safe-delay-input'].value = '2';
  globalThis.document = { getElementById: (id) => elements[id] ?? null };
  try {
    return { controls: new ExtractionControls(), elements, delayInput: elements['safe-delay-input'] };
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
  assert.deepEqual(controls.getOptions(), { downloadAll: false, maxChats: 3, safeDelayMs: 1500 });

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
  assert.deepEqual(await savedConfig(), { downloadAll: false, maxChats: 3, safeDelayMs: 1000 });
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
