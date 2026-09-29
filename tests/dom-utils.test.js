import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// dom-utils.js é um content script clássico que se registra em window; as funções
// de título não tocam no DOM, então um window vazio basta
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../content/dom/dom-utils.js', import.meta.url), 'utf8'), context);
const { isTitleMatch, normalizeTitle } = context.window.DomUtils;

test('títulos parciais não casam (evita exportar a conversa errada)', () => {
  assert.equal(isTitleMatch('Mariana', 'Ana'), false);
  assert.equal(isTitleMatch('Ana Paula', 'Ana'), false);
  assert.equal(isTitleMatch('+55 11 99999-0000', '5511'), false);
});

test('igualdade tolera caixa, espaços, marcas invisíveis e seletores de variação', () => {
  assert.equal(isTitleMatch('  ana ', 'Ana'), true);
  assert.equal(isTitleMatch('‎João‏', 'João'), true);
  assert.equal(isTitleMatch('Casa ☺️', 'Casa ☺'), true);
  assert.equal(isTitleMatch('Grupo   da   Família', 'grupo da família'), true);
});

test('normalização NFC iguala acentos compostos e decompostos', () => {
  assert.equal(normalizeTitle('José'), normalizeTitle('José'));
  assert.equal(isTitleMatch('José', 'José'), true);
});

test('títulos vazios nunca casam', () => {
  assert.equal(isTitleMatch('', ''), false);
  assert.equal(isTitleMatch(null, 'Ana'), false);
  assert.equal(isTitleMatch('​', '​'), false);
});
