import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressView } from '../popup/ui/progress-view.js';
import { WORKFLOW_STATES } from '../shared/constants/workflow-states.js';

// O ProgressView só lê o document no construtor; depois mexe apenas nos elementos guardados

function fakeElement() {
  const classes = new Set();
  return {
    textContent: '',
    className: '',
    style: {},
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) }
  };
}

function createView() {
  const elements = Object.fromEntries(
    ['progress-container', 'progress-bar-fill', 'progress-label', 'progress-detail', 'progress-state-badge'].map((id) => [id, fakeElement()])
  );
  globalThis.document = { getElementById: (id) => elements[id] ?? null };
  try {
    return { view: new ProgressView(), elements };
  } finally {
    delete globalThis.document;
  }
}

const SUMMARY = { saved: 3, empty: 0, savedToDisk: 0, notExportable: 0, failed: 1 };

test('na repescagem o rótulo mostra a posição na rodada, e não a da fila com 100%', () => {
  const { view, elements } = createView();
  view.renderProgress({
    state: WORKFLOW_STATES.EXPORTING,
    current: 4,
    total: 5,
    percentage: 50,
    retry: { current: 2, total: 2 },
    currentChatTitle: 'Davi',
    summary: SUMMARY
  });

  assert.equal(elements['progress-label'].textContent, 'Repescagem 2 de 2 (50%) · 1 falha(s)');
  assert.equal(elements['progress-bar-fill'].style.width, '50%');
  assert.equal(elements['progress-detail'].textContent, 'Chat: Davi');
});

test('durante a espera antes da repescagem, o detalhe mostra a mensagem de espera', () => {
  const { view, elements } = createView();
  view.renderProgress({
    state: WORKFLOW_STATES.EXPORTING,
    current: 5,
    total: 5,
    percentage: 0,
    retry: { current: 1, total: 1 },
    statusMessage: 'Aguardando 60 s antes da repescagem de 1 conversa(s).',
    summary: SUMMARY
  });

  assert.equal(elements['progress-label'].textContent, 'Repescagem 1 de 1 (0%) · 1 falha(s)');
  assert.equal(elements['progress-detail'].textContent, 'Aguardando 60 s antes da repescagem de 1 conversa(s).');
});

test('durante a varredura o rótulo mostra quantas conversas já foram encontradas', () => {
  const { view, elements } = createView();
  view.renderProgress({ state: WORKFLOW_STATES.SCANNING, current: 0, total: 0, percentage: 0, scanFound: 0 });
  assert.equal(elements['progress-label'].textContent, 'Buscando lista de chats...');

  view.renderProgress({ state: WORKFLOW_STATES.SCANNING, current: 0, total: 0, percentage: 0, scanFound: 137 });
  assert.equal(elements['progress-label'].textContent, '137 conversa(s) encontrada(s)');
  assert.equal(elements['progress-detail'].textContent, 'Descobrindo conversas...');
});

test('fora da repescagem o rótulo continua o da fila', () => {
  const { view, elements } = createView();
  view.renderProgress({ state: WORKFLOW_STATES.EXPORTING, current: 3, total: 5, percentage: 40, retry: null, currentChatTitle: 'Caio', summary: SUMMARY });

  assert.equal(elements['progress-label'].textContent, '3 de 5 (40%) · 1 falha(s)');
});
