import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// dom-utils.js é um content script clássico que se registra em window; as funções
// testadas aqui não tocam no DOM, então um window vazio basta
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../content/dom/dom-utils.js', import.meta.url), 'utf8'), context);
const {
  isTitleMatch, normalizeTitle, buildChatNotFoundMessage, waitFor,
  ERROR_CODES, LOCATE_FAILURES, DomAutomationError, OperationTimeoutError
} = context.window.DomUtils;
// Os erros são criados no contexto do vm, com o Error de lá
const ContextError = vm.runInContext('Error', context);

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

test('mensagem "não encontrada" traz o motivo de cada tentativa, na ordem em que rodaram', () => {
  const base = 'Conversa "Ana" não foi encontrada na lista lateral';
  assert.equal(
    buildChatNotFoundMessage('Ana', [
      { via: 'search', reason: LOCATE_FAILURES.SEARCH_NO_RESULT, timeoutMs: 8000 },
      { via: 'scroll', reason: LOCATE_FAILURES.END_OF_LIST, steps: 12 }
    ]),
    `${base} (busca: sem resultado em 8 s; rolagem: 12 passo(s) até o fim da lista).`
  );
  assert.equal(
    buildChatNotFoundMessage('Ana', [
      { via: 'search', reason: LOCATE_FAILURES.SEARCH_INPUT_MISSING },
      { via: 'scroll', reason: LOCATE_FAILURES.SCROLL_STALLED, steps: 3 }
    ]),
    `${base} (busca: campo de busca não encontrado; rolagem: parou após 3 passo(s), antes do fim da lista).`
  );
  assert.equal(
    buildChatNotFoundMessage('Ana', [
      { via: 'search', reason: LOCATE_FAILURES.SEARCH_NO_RESULT, timeoutMs: 1500 },
      { via: 'scroll', reason: LOCATE_FAILURES.LIST_MISSING }
    ]),
    `${base} (busca: sem resultado em 1.5 s; rolagem: lista lateral não encontrada).`
  );
  assert.equal(buildChatNotFoundMessage('Ana', []), `${base}.`);
});

test('motivo ou tentativa desconhecidos lançam erro em vez de sair na mensagem', () => {
  assert.throws(
    () => buildChatNotFoundMessage('Ana', [{ via: 'search', reason: 'outro' }]),
    { message: 'Motivo de tentativa desconhecido: outro' }
  );
  assert.throws(
    () => buildChatNotFoundMessage('Ana', [{ via: 'visible', reason: LOCATE_FAILURES.END_OF_LIST, steps: 1 }]),
    { message: 'Tentativa de localização desconhecida: visible' }
  );
});

test('DomAutomationError leva código e mensagem; o timeout das esperas tem código TIMEOUT', async () => {
  // Os códigos são o contrato com o background, que compara o texto (não importa este arquivo)
  assert.deepEqual({ ...ERROR_CODES }, {
    CHAT_NOT_FOUND: 'CHAT_NOT_FOUND',
    AMBIGUOUS_TITLE: 'AMBIGUOUS_TITLE',
    EXPORT_OPTION_UNAVAILABLE: 'EXPORT_OPTION_UNAVAILABLE',
    DATE_RANGE_NOT_ALL: 'DATE_RANGE_NOT_ALL',
    TIMEOUT: 'TIMEOUT'
  });

  const err = new DomAutomationError(ERROR_CODES.EXPORT_OPTION_UNAVAILABLE, 'Opção indisponível.');
  assert.ok(err instanceof ContextError);
  assert.equal(err.name, 'DomAutomationError');
  assert.equal(err.code, 'EXPORT_OPTION_UNAVAILABLE');
  assert.equal(err.message, 'Opção indisponível.');

  // Prazo zero: a primeira sondagem falha e a espera expira sem chegar a agendar timer
  await assert.rejects(waitFor(() => null, { timeoutMs: 0, description: 'o botão' }), (thrown) => {
    assert.ok(thrown instanceof OperationTimeoutError);
    assert.equal(thrown.code, 'TIMEOUT');
    assert.equal(thrown.message, 'Timeout de 0s aguardando o botão.');
    return true;
  });
});
