import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { phoneFromTitle } from '../shared/utils/phone.js';

// dom-utils.js é um content script clássico que se registra em window; as funções
// testadas aqui não tocam no DOM, então um window vazio basta
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../content/dom/dom-utils.js', import.meta.url), 'utf8'), context);
const {
  isTitleMatch, normalizeTitle, buildChatNotFoundMessage, estimateScrollStart, estimateNearbyTop, countAnimationFrames, waitFor,
  extractPhoneDigits, chooseDrawerPhone,
  classifyHistoryNotice, ERROR_CODES, LOCATE_FAILURES, TIMEOUTS, HISTORY_NOTICE_KINDS, HISTORY_LOAD_REASONS, DomAutomationError,
  OperationTimeoutError
} = context.window.DomUtils;
// Os erros são criados no contexto do vm, com o Error de lá
const ContextError = vm.runInContext('Error', context);

test('títulos parciais não casam (evita exportar a conversa errada)', () => {
  assert.equal(isTitleMatch('Mariana', 'Ana'), false);
  assert.equal(isTitleMatch('Ana Paula', 'Ana'), false);
  assert.equal(isTitleMatch('+55 11 99999-0000', '5511'), false);
});

test('igualdade tolera espaços, marcas invisíveis e seletores de variação', () => {
  assert.equal(isTitleMatch('  Ana ', 'Ana'), true);
  assert.equal(isTitleMatch('\u200EJoão\u200F', 'João'), true);
  assert.equal(isTitleMatch('Casa ☺\uFE0F', 'Casa ☺'), true);
  assert.equal(isTitleMatch('Grupo   da   Família', 'Grupo da Família'), true);
});

test('igualdade diferencia maiúsculas: "João" e "joão" são conversas diferentes', () => {
  assert.equal(isTitleMatch('joão', 'João'), false);
  assert.equal(isTitleMatch('  ana ', 'Ana'), false);
  assert.equal(isTitleMatch('Grupo da Família', 'grupo da família'), false);
  // A chave de deduplicação do scanner também mantém a caixa: as duas conversas entram na fila
  assert.notEqual(normalizeTitle('João'), normalizeTitle('joão'));
  assert.equal(normalizeTitle(' João '), 'João');
});

test('normalização NFC iguala acentos compostos e decompostos', () => {
  assert.equal(normalizeTitle('José'), normalizeTitle('José'));
  assert.equal(isTitleMatch('José', 'José'), true);
});

test('títulos vazios nunca casam', () => {
  assert.equal(isTitleMatch('', ''), false);
  assert.equal(isTitleMatch(null, 'Ana'), false);
  assert.equal(isTitleMatch('\u200B', '\u200B'), false);
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

test('mensagem "não encontrada" com a rolagem interrompida no teto de tempo ou no limite de passos', () => {
  const base = 'Conversa "Ana" não foi encontrada na lista lateral (busca: sem resultado em 8 s; rolagem: ';
  const searchFailure = { via: 'search', reason: LOCATE_FAILURES.SEARCH_NO_RESULT, timeoutMs: 8000 };
  // No teto, os passos são os da rolagem inteira (as duas descidas somadas)
  assert.equal(
    buildChatNotFoundMessage('Ana', [
      searchFailure,
      { via: 'scroll', reason: LOCATE_FAILURES.SCROLL_TIME_LIMIT, timeoutMs: TIMEOUTS.OPEN_SCROLL_MS, steps: 95 }
    ]),
    `${base}interrompida no teto de 60 s, após 95 passo(s)).`
  );
  assert.equal(
    buildChatNotFoundMessage('Ana', [searchFailure, { via: 'scroll', reason: LOCATE_FAILURES.SCROLL_STEP_LIMIT, steps: 236 }]),
    `${base}interrompida no limite de 236 passo(s), proporcional ao tamanho da lista).`
  );
  // Os motivos vão no diagnóstico da abertura, e o background os traduz pelo texto no _execucao.log
  assert.equal(LOCATE_FAILURES.SCROLL_TIME_LIMIT, 'scroll-time-limit');
  assert.equal(LOCATE_FAILURES.SCROLL_STEP_LIMIT, 'scroll-step-limit');
  assert.equal(TIMEOUTS.OPEN_SCROLL_MS, 60000);
});

test('rolagem de abertura começa uma tela acima da linha estimada, nunca antes do topo', () => {
  // Posição 100 da fila (contada do zero), linhas de 76 px (como no snapshot da lista) e 700 px de altura visível
  assert.equal(estimateScrollStart({ index: 100, rowHeight: 76, viewportHeight: 700 }), 100 * 76 - 700);
  // Conversas da primeira tela: a uma tela acima seria negativo, então fica o topo
  assert.equal(estimateScrollStart({ index: 0, rowHeight: 76, viewportHeight: 700 }), 0);
  assert.equal(estimateScrollStart({ index: 9, rowHeight: 76, viewportHeight: 700 }), 0);
  assert.equal(estimateScrollStart({ index: 10, rowHeight: 76, viewportHeight: 700 }), 60);
  // Altura medida com fração de pixel: a posição é inteira e não passa da estimativa
  assert.equal(estimateScrollStart({ index: 3, rowHeight: 72.5, viewportHeight: 100 }), 117);

  for (const params of [
    { index: -1, rowHeight: 76, viewportHeight: 700 },
    { index: Number.NaN, rowHeight: 76, viewportHeight: 700 },
    { index: 5, rowHeight: undefined, viewportHeight: 700 },
    { index: 5, rowHeight: 76, viewportHeight: Number.POSITIVE_INFINITY }
  ]) {
    assert.throws(() => estimateScrollStart(params), /^Error: Valor inválido para estimar a posição da conversa na lista: /);
  }
});

test('tentativa perto da posição estimada: a linha estimada fica as linhas pedidas abaixo do topo da tela, nunca antes do topo', () => {
  assert.equal(estimateNearbyTop({ index: 110, rowHeight: 72, rowsAbove: 1 }), 109 * 72);
  assert.equal(estimateNearbyTop({ index: 0, rowHeight: 72, rowsAbove: 1 }), 0);
  assert.equal(estimateNearbyTop({ index: 1, rowHeight: 72, rowsAbove: 1 }), 0);
  assert.equal(estimateNearbyTop({ index: 3, rowHeight: 72.5, rowsAbove: 0 }), 217);

  for (const params of [
    { index: -1, rowHeight: 72, rowsAbove: 1 },
    { index: 5, rowHeight: Number.NaN, rowsAbove: 1 },
    { index: 5, rowHeight: 72, rowsAbove: undefined }
  ]) {
    assert.throws(() => estimateNearbyTop(params), /^Error: Valor inválido para estimar a posição da conversa na lista: /);
  }
});

test('quadros desenhados: conta os do requestAnimationFrame até parar, e sem ele devolve null', () => {
  const callbacks = [];
  const withFrames = vm.createContext({ window: {}, requestAnimationFrame: (callback) => callbacks.push(callback) });
  vm.runInContext(readFileSync(new URL('../content/dom/dom-utils.js', import.meta.url), 'utf8'), withFrames);
  const stop = withFrames.window.DomUtils.countAnimationFrames();
  // Cada quadro desenhado roda o callback pendente, que pede o seguinte
  for (let frame = 0; frame < 3; frame++) callbacks.shift()();
  assert.equal(stop(), 3);
  // Depois de parar, um quadro pendente não conta nem pede outro
  callbacks.shift()();
  assert.equal(callbacks.length, 0);

  // A página que não desenha nada: nenhum quadro
  assert.equal(withFrames.window.DomUtils.countAnimationFrames()(), 0);
  // No contexto sem requestAnimationFrame
  assert.equal(countAnimationFrames()(), null);
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

// Textos fictícios nas formas do painel "Dados do contato" e dos títulos de conversa
const PHONE_TEXTS = [
  // Contato não salvo (13 dígitos) e conta comercial (12), como no painel
  ['+55 11 90000-0001', '5511900000001'],
  ['+55 11 3000-0002', '551130000002'],
  // Marcas invisíveis de direção em volta do número, espaço não separável, parênteses, pontos e hífens
  ['\u202A+55 11 90000-0001\u202C', '5511900000001'],
  ['\u200E+55 (11) 90000.0001\u200F', '5511900000001'],
  ['\u2066+55\u00A011\u00A090000-0001\u2069', '5511900000001'],
  ['  55-11-90000-0001 ', '5511900000001'],
  ['5511900000001', '5511900000001'],
  // De 10 a 15 dígitos
  ['(11) 3000-0002', '1130000002'],
  ['+999 9999 9999-9999', '999999999999999'],
  ['90000-0001', null],
  ['+55 11 90000-0001111', null],
  // Texto que não é só um telefone, mesmo com dígitos: o número no rótulo de um botão, nomes e travessão
  ['Bloquear +55 11 90000-0001', null],
  ['+55 11 90000-0001 (você)', null],
  ['Loja 2', null],
  ['~Maria', null],
  ['+55 11 90000\u20130001', null],
  ['+', null],
  ['', null],
  ['   ', null]
];

test('extractPhoneDigits: os dígitos quando o texto é só um telefone de 10 a 15 dígitos, null em qualquer outro texto', () => {
  for (const [text, digits] of PHONE_TEXTS) {
    assert.equal(extractPhoneDigits(text), digits, JSON.stringify(text));
  }
  for (const value of [null, undefined, 5511900000001, {}]) {
    assert.equal(extractPhoneDigits(value), null, String(value));
  }
});

test('extractPhoneDigits dá o mesmo resultado que phoneFromTitle, de que é espelho no content script', () => {
  for (const [text] of PHONE_TEXTS) {
    assert.equal(extractPhoneDigits(text), phoneFromTitle(text), JSON.stringify(text));
  }
});

// Escolha do telefone no painel "Dados do contato", nas formas dos snapshots contact_info_drawer: o contato não salvo tem o
// número no subtítulo, repetido nos textos dos botões "Bloquear" e "Denunciar"; a conta comercial não tem o subtítulo, e
// sim o cartão com o nome, e o número aparece duas vezes. Números fictícios
const CONTACT_PHONE = '+55 11 90000-0001';
const BUSINESS_PHONE = '+55 11 3000-0002';
const OTHER_PHONE = '+55 11 90000-0003';
const NO_SUBTITLE_NOR_BUSINESS_CARD = 'painel sem telefone no subtítulo e sem o cartão de conta comercial';

/** O resultado de chooseDrawerPhone, criado no contexto do vm, como um objeto deste arquivo, para o deepEqual */
function choose(params) {
  return { ...chooseDrawerPhone(params) };
}

test('chooseDrawerPhone: o subtítulo que é só um telefone é o número, mesmo com outro número no painel', () => {
  // Contato não salvo
  assert.deepEqual(
    choose({ subtitleText: CONTACT_PHONE, phoneTexts: [CONTACT_PHONE, CONTACT_PHONE, CONTACT_PHONE], businessCardPresent: false }),
    { phone: '5511900000001', source: 'subtitle' }
  );
  // Com as marcas de direção em volta do número, e um "Recado" com outro: o subtítulo é o WhatsApp que escreve
  assert.deepEqual(
    choose({ subtitleText: '\u202A+55 11 90000-0001\u202C', phoneTexts: [CONTACT_PHONE, OTHER_PHONE], businessCardPresent: true }),
    { phone: '5511900000001', source: 'subtitle' }
  );
});

test('chooseDrawerPhone: sem o subtítulo, o número do painel da conta comercial quando todos os textos que são só um telefone dão o mesmo', () => {
  // O número abaixo do nome e o da seção "Recado e número de telefone"
  assert.deepEqual(
    choose({ subtitleText: null, phoneTexts: [BUSINESS_PHONE, BUSINESS_PHONE], businessCardPresent: true }),
    { phone: '551130000002', source: 'business-card' }
  );
  // O mesmo número escrito de outro jeito é um número só, e um texto que não é só um telefone não conta
  assert.deepEqual(
    choose({ phoneTexts: [BUSINESS_PHONE, '55 (11) 3000.0002', 'Ligue +55 11 90000-0003', 'Loja 2'], businessCardPresent: true }),
    { phone: '551130000002', source: 'business-card' }
  );
  // Um subtítulo que não é um telefone não muda a regra
  assert.deepEqual(
    choose({ subtitleText: 'Loja de roupas', phoneTexts: [BUSINESS_PHONE], businessCardPresent: true }),
    { phone: '551130000002', source: 'business-card' }
  );
});

test('chooseDrawerPhone: dois números diferentes no painel da conta comercial não dão nenhum, com o aviso', () => {
  // Um "Recado" que é só outro número, escrito pela própria conta, daria à conversa o chat_id de outra
  assert.deepEqual(
    choose({ phoneTexts: [BUSINESS_PHONE, BUSINESS_PHONE, OTHER_PHONE], businessCardPresent: true }),
    { phone: null, reason: 'mais de um número no painel' }
  );
  assert.deepEqual(
    choose({ subtitleText: 'Loja de roupas', phoneTexts: [OTHER_PHONE, BUSINESS_PHONE], businessCardPresent: true }),
    { phone: null, reason: 'mais de um número no painel' }
  );
});

// Contato salvo (snapshot payload3.html): o subtítulo é o nome salvo, e o número é o primeiro texto logo abaixo dele
const SAVED_NAME = 'Maria Silva';

test('chooseDrawerPhone: com o nome no subtítulo, o texto logo abaixo dele que é só um telefone é o número, mesmo com outro número no painel', () => {
  assert.deepEqual(
    choose({ subtitleText: SAVED_NAME, belowSubtitleText: CONTACT_PHONE, phoneTexts: [CONTACT_PHONE], businessCardPresent: false }),
    { phone: '5511900000001', source: 'below-subtitle' }
  );
  // Com as marcas de direção em volta do número, e um "Recado" com outro: o número do topo é o WhatsApp que escreve
  assert.deepEqual(
    choose({ subtitleText: SAVED_NAME, belowSubtitleText: '\u202A+55 11 3000-0002\u202C', phoneTexts: [BUSINESS_PHONE, OTHER_PHONE] }),
    { phone: '551130000002', source: 'below-subtitle' }
  );
  // Um nome com dígitos no subtítulo continua sendo um nome
  assert.deepEqual(
    choose({ subtitleText: 'Loja 24 horas', belowSubtitleText: CONTACT_PHONE }),
    { phone: '5511900000001', source: 'below-subtitle' }
  );
});

test('chooseDrawerPhone: o texto logo abaixo do subtítulo não muda os outros casos', () => {
  // Contato não salvo: o subtítulo é o número, e logo abaixo dele vem o "~nome de perfil"; um número diferente logo abaixo
  // também não vale mais que o subtítulo
  for (const belowSubtitleText of ['~Maria', OTHER_PHONE]) {
    assert.deepEqual(
      choose({ subtitleText: CONTACT_PHONE, belowSubtitleText, phoneTexts: [CONTACT_PHONE] }),
      { phone: '5511900000001', source: 'subtitle' },
      belowSubtitleText
    );
  }
  // Logo abaixo, um texto que não é só um telefone: vale a regra da conta comercial, como antes
  assert.deepEqual(
    choose({ subtitleText: SAVED_NAME, belowSubtitleText: '~Maria', phoneTexts: [BUSINESS_PHONE], businessCardPresent: true }),
    { phone: '551130000002', source: 'business-card' }
  );
  assert.deepEqual(
    choose({ subtitleText: SAVED_NAME, belowSubtitleText: 'Ligue +55 11 90000-0003', phoneTexts: [BUSINESS_PHONE, OTHER_PHONE], businessCardPresent: true }),
    { phone: null, reason: 'mais de um número no painel' }
  );
  for (const belowSubtitleText of [null, '', '~Maria', 'Bloquear +55 11 90000-0001', '90000-0001']) {
    assert.deepEqual(
      choose({ subtitleText: SAVED_NAME, belowSubtitleText, phoneTexts: [OTHER_PHONE], businessCardPresent: false }),
      { phone: null, reason: NO_SUBTITLE_NOR_BUSINESS_CARD },
      JSON.stringify(belowSubtitleText)
    );
  }
});

test('chooseDrawerPhone: sem telefone no subtítulo e sem o cartão da conta comercial, nenhum número, com o motivo, mesmo com um número no painel', () => {
  for (const subtitleText of [null, '', '~Maria', 'Bloquear +55 11 90000-0001']) {
    assert.deepEqual(
      choose({ subtitleText, phoneTexts: [OTHER_PHONE], businessCardPresent: false }),
      { phone: null, reason: NO_SUBTITLE_NOR_BUSINESS_CARD },
      JSON.stringify(subtitleText)
    );
  }
  assert.deepEqual(choose({}), { phone: null, reason: NO_SUBTITLE_NOR_BUSINESS_CARD });
  // Conta comercial sem número nenhum no painel
  assert.deepEqual(
    choose({ phoneTexts: ['Loja 2'], businessCardPresent: true }),
    { phone: null, reason: 'nenhum número no painel da conta comercial' }
  );
});

// Aviso de mensagens mais antigas no topo do painel de mensagens (textos fixos do WhatsApp Web, como nos snapshots)

const LOAD_NOTICE = 'Clique neste aviso para carregar mensagens mais antigas do seu celular.';
const PHONE_ONLY_NOTICE = 'Use o WhatsApp no seu celular para ver mensagens enviadas e recebidas antes de 6/26/2026.';

// O resultado vem do contexto do vm: comparado pelos campos, sem o protótipo de lá
function plain(value) {
  return value === null ? null : { ...value };
}

test('classifyHistoryNotice: o aviso que carrega as mensagens mais antigas do celular', () => {
  assert.deepEqual(plain(classifyHistoryNotice(LOAD_NOTICE)), { kind: 'load' });
  assert.equal(HISTORY_NOTICE_KINDS.LOAD, 'load');
  // Espaços a mais, quebra de linha, maiúsculas e marcas invisíveis de direção do texto não mudam o reconhecimento
  assert.deepEqual(plain(classifyHistoryNotice('  \u200EClique neste aviso para\n CARREGAR mensagens mais antigas do seu celular. ')), { kind: 'load' });
});

test('classifyHistoryNotice: o aviso de que as anteriores só estão no celular, com a data como o WhatsApp Web a escreve', () => {
  assert.deepEqual(plain(classifyHistoryNotice(PHONE_ONLY_NOTICE)), { kind: 'phone-only', before: '6/26/2026' });
  assert.equal(HISTORY_NOTICE_KINDS.PHONE_ONLY, 'phone-only');
  assert.deepEqual(
    plain(classifyHistoryNotice('Use o WhatsApp no seu celular para ver mensagens enviadas e recebidas antes de 12/1/25.')),
    { kind: 'phone-only', before: '12/1/25' }
  );
  // A data cercada pelas marcas invisíveis de isolamento do texto é lida sem elas
  assert.deepEqual(
    plain(classifyHistoryNotice('Use o WhatsApp no seu celular para ver mensagens enviadas e recebidas antes de \u20686/26/2026\u2069.')),
    { kind: 'phone-only', before: '6/26/2026' }
  );
  // Sem a data no texto, o aviso é reconhecido e a data fica null
  assert.deepEqual(
    plain(classifyHistoryNotice('Use o WhatsApp no seu celular para ver mensagens mais antigas.')),
    { kind: 'phone-only', before: null }
  );
});

test('classifyHistoryNotice: outros textos não são aviso, nem o de carregamento em andamento', () => {
  for (const text of [
    '',
    '   ',
    null,
    undefined,
    42,
    'Carregando mensagens mais antigas do seu celular…',
    'Mensagens mais antigas',
    'HOJE',
    'As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.'
  ]) {
    assert.equal(classifyHistoryNotice(text), null, String(text));
  }
});

test('carga das mensagens mais antigas: motivos que vão ao background e esperas padrão', () => {
  assert.deepEqual({ ...HISTORY_LOAD_REASONS }, {
    NO_NOTICE: 'no-notice',
    PHONE_ONLY: 'phone-only',
    TIME_LIMIT: 'time-limit',
    STALLED: 'stalled'
  });
  assert.equal(TIMEOUTS.HISTORY_CLICK_WAIT_MS, 10000);
  assert.equal(TIMEOUTS.HISTORY_SCROLL_WAIT_MS, 1500);
  assert.equal(TIMEOUTS.HISTORY_SETTLE_MS, 3000);
  assert.equal(TIMEOUTS.HISTORY_POLL_MS, 200);
});
