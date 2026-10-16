import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// history-loader.js é um content script clássico que se registra em window. O laço da carga só fala com a página pelos
// métodos findPanel, readTop, markerOf, scrollToTop e click, que aqui são trocados por uma página simulada, com mensagens
// fictícias. A leitura do DOM de verdade (o topo do painel e o botão do aviso) é conferida nos snapshots da kb/
const context = vm.createContext({ window: {}, setTimeout, clearTimeout });
for (const file of ['../content/dom/dom-utils.js', '../content/dom/history-loader.js']) {
  vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
}
const { HistoryLoader } = context.window;

// Esperas curtas: o laço é o mesmo, e a suíte não espera as de produção
const TIMEOUTS = { clickWaitMs: 150, scrollWaitMs: 60, settleMs: 300, pollMs: 5 };
const CLICKABLE = 'botão do aviso';
const PHONE_ONLY_DATE = '6/26/2026';

/**
 * Painel de mensagens simulado: as mensagens, da mais antiga para a mais nova, e o topo, com o aviso que carrega as mais
 * antigas ('load'), o de que as anteriores só estão no celular ('phone-only'), o indicador de carregamento ('busy') ou nada
 * (null). `onClick` é a reação da página ao clique no aviso, com o número do clique
 */
class FakePanel {
  constructor({ messages = 3, top = 'load', present = true } = {}) {
    this.present = present;
    this.top = top;
    this.messages = [];
    this.nextOlder = 1000;
    this.nextNewer = 2000;
    this.clicks = 0;
    this.scrolls = 0;
    this.onClick = () => {};
    this.addOlder(messages);
  }

  addOlder(count) {
    for (let i = 0; i < count; i++) this.messages.unshift(`conv-msg-FAKE${this.nextOlder--}`);
  }

  addNewer(count) {
    for (let i = 0; i < count; i++) this.messages.push(`conv-msg-FAKE${this.nextNewer++}`);
  }
}

class SimulatedLoader extends HistoryLoader {
  constructor(panel, timeouts = TIMEOUTS) {
    super({ timeouts });
    this.panel = panel;
  }

  findPanel() {
    return this.panel.present ? this.panel : null;
  }

  readTop() {
    const { top } = this.panel;
    if (top === 'load') return { kind: 'load', clickable: CLICKABLE, before: null, busy: false };
    if (top === 'phone-only') return { kind: 'phone-only', clickable: null, before: PHONE_ONLY_DATE, busy: false };
    return { kind: null, clickable: null, before: null, busy: top === 'busy' };
  }

  markerOf() {
    return this.panel.messages[0] ?? '';
  }

  scrollToTop() {
    this.panel.scrolls++;
  }

  click(element) {
    assert.equal(element, CLICKABLE);
    this.panel.clicks++;
    this.panel.onClick(this.panel.clicks);
  }
}

/** O resultado vem do contexto do vm: comparado pelos campos, sem o protótipo de lá */
async function load(panel, { limitMs = 5000, signal } = {}) {
  const result = await new SimulatedLoader(panel).load({ limitMs, signal });
  return { ...result };
}

test('sem o aviso no topo: sai depois de o painel ficar desenhado, sem rolar nem clicar', async () => {
  const panel = new FakePanel({ top: null });

  const result = await load(panel);

  assert.deepEqual({ ...result, ms: undefined }, { clicks: 0, ms: undefined, reason: 'no-notice' });
  assert.ok(result.ms < TIMEOUTS.settleMs, `${result.ms} ms`);
  assert.deepEqual([panel.clicks, panel.scrolls], [0, 0]);
});

test('aviso de que as anteriores só estão no celular: sai na hora, com a data, sem clicar', async () => {
  const panel = new FakePanel({ top: 'phone-only' });

  const result = await load(panel);

  assert.equal(result.reason, 'phone-only');
  assert.equal(result.before, PHONE_ONLY_DATE);
  assert.deepEqual([result.clicks, panel.clicks, panel.scrolls], [0, 0, 0]);
});

test('painel desenhado depois da abertura: o aviso que chega com as mensagens é visto, e a carga começa', async () => {
  // A abertura termina quando o cabeçalho muda: o painel vem vazio, e as mensagens e o aviso chegam depois
  const panel = new FakePanel({ messages: 0, top: null, present: false });
  setTimeout(() => { panel.present = true; }, 20);
  setTimeout(() => { panel.addOlder(3); panel.top = 'load'; }, 60);
  panel.onClick = () => setTimeout(() => { panel.addOlder(5); panel.top = null; }, 10);

  const result = await load(panel);

  assert.equal(result.reason, 'no-notice');
  assert.equal(result.clicks, 1);
  assert.equal(panel.messages.length, 8);
});

test('cada clique traz mensagens mais antigas até o WhatsApp avisar que as anteriores só estão no celular', async () => {
  const panel = new FakePanel();
  panel.onClick = (click) => setTimeout(() => {
    panel.addOlder(5);
    panel.top = click >= 3 ? 'phone-only' : 'load';
  }, 20);

  const result = await load(panel);

  assert.equal(result.reason, 'phone-only');
  assert.equal(result.before, PHONE_ONLY_DATE);
  assert.equal(result.clicks, 3);
  assert.equal(panel.messages.length, 18);
});

test('o aviso some junto com as mensagens novas: o painel vai ao topo mais uma vez, e a carga termina sem o aviso', async () => {
  const panel = new FakePanel();
  panel.onClick = () => setTimeout(() => { panel.addOlder(5); panel.top = null; }, 20);

  const result = await load(panel);

  assert.equal(result.reason, 'no-notice');
  assert.equal(result.clicks, 1);
  // Uma vez antes do clique e outra para conferir se ainda faltava alguma mensagem
  assert.equal(panel.scrolls, 2);
});

test('celular sem resposta, com o aviso no topo: para depois de dois cliques, sem dar a carga como terminada', async () => {
  const panel = new FakePanel();

  const result = await load(panel);

  assert.equal(result.reason, 'stalled');
  assert.equal(result.clicks, 2);
  assert.ok(result.ms >= 2 * TIMEOUTS.clickWaitMs, `${result.ms} ms`);
});

test('o aviso que some sem trazer mensagens não encerra a carga: sem resposta, ela para como sem resposta do celular', async () => {
  const panel = new FakePanel();
  panel.onClick = () => { panel.top = null; };

  const result = await load(panel);

  assert.equal(result.reason, 'stalled');
  assert.equal(result.clicks, 1);
  // Depois do clique sem resposta, a rodada seguinte esperou o celular, não só a rolagem
  assert.ok(result.ms >= 2 * TIMEOUTS.clickWaitMs, `${result.ms} ms`);
});

test('o aviso que some e as mensagens que chegam depois da espera do clique: a carga espera mais uma rodada e segue', async () => {
  const panel = new FakePanel();
  panel.onClick = () => {
    panel.top = null;
    setTimeout(() => { panel.addOlder(4); panel.top = null; }, TIMEOUTS.clickWaitMs + 50);
  };

  const result = await load(panel);

  assert.equal(result.reason, 'no-notice');
  assert.equal(result.clicks, 1);
  assert.equal(panel.messages.length, 7);
});

test('indicador de carregamento por mais tempo que a espera do clique: a carga espera o celular e continua', async () => {
  const panel = new FakePanel();
  panel.onClick = (click) => {
    panel.top = 'busy';
    setTimeout(() => {
      panel.addOlder(4);
      panel.top = click >= 2 ? null : 'load';
    }, TIMEOUTS.clickWaitMs + 50);
  };

  const result = await load(panel);

  assert.equal(result.reason, 'no-notice');
  assert.equal(result.clicks, 2);
  assert.equal(panel.messages.length, 11);
});

test('mensagens que chegam em partes: com o indicador de carregamento no topo depois da primeira, a carga espera o celular', async () => {
  // Espera do clique maior que nos outros testes, para separar as duas esperas com folga
  const timeouts = { ...TIMEOUTS, clickWaitMs: 300 };
  const panel = new FakePanel();
  panel.onClick = () => setTimeout(() => {
    panel.addOlder(3);
    panel.top = 'busy';
    // A segunda parte chega depois de uma espera da rolagem mais uma do celular, e antes de duas do celular
    setTimeout(() => { panel.addOlder(3); panel.top = null; }, 480);
  }, 20);

  const result = { ...(await new SimulatedLoader(panel, timeouts).load({ limitMs: 5000 })) };

  assert.equal(result.reason, 'no-notice');
  assert.equal(result.clicks, 1);
  assert.equal(panel.messages.length, 9);
});

test('mensagens que chegam embaixo, numa conversa ativa, não contam como resposta do celular', async () => {
  const panel = new FakePanel();
  const newer = setInterval(() => panel.addNewer(1), 20);
  try {
    const result = await load(panel);

    assert.equal(result.reason, 'stalled');
    assert.equal(result.clicks, 2);
  } finally {
    clearInterval(newer);
  }
});

test('o limite de tempo interrompe a carga com o aviso ainda no topo', async () => {
  const panel = new FakePanel();
  panel.onClick = () => setTimeout(() => panel.addOlder(1), 10);

  const result = await load(panel, { limitMs: 200 });

  assert.equal(result.reason, 'time-limit');
  assert.ok(result.clicks >= 3, `${result.clicks} clique(s)`);
  assert.ok(result.ms >= 200 && result.ms < 400, `${result.ms} ms`);
});

test('a página que responde no mesmo instante do clique não prende a aba: cada rodada cede a vez aos temporizadores', async () => {
  const panel = new FakePanel();
  panel.onClick = () => panel.addOlder(1);
  let timerRan = false;
  setTimeout(() => { timerRan = true; }, 1);

  const result = await load(panel, { limitMs: 100 });

  assert.equal(result.reason, 'time-limit');
  assert.equal(timerRan, true);
});

test('o cancelamento interrompe a carga no meio da espera', async () => {
  const panel = new FakePanel();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  await assert.rejects(load(panel, { signal: controller.signal }), { name: 'OperationCancelledError' });
  assert.equal(panel.clicks, 1);
});

test('sem o painel de mensagens: falha com o motivo depois da espera pelo painel', async () => {
  const panel = new FakePanel({ present: false });

  const startedAt = Date.now();
  await assert.rejects(load(panel), { message: 'o painel de mensagens da conversa não foi encontrado' });
  assert.ok(Date.now() - startedAt >= TIMEOUTS.settleMs);
  assert.equal(panel.clicks, 0);
});

test('limite inválido: falha sem tocar na página', async () => {
  for (const limitMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000', undefined]) {
    const panel = new FakePanel();
    await assert.rejects(
      new SimulatedLoader(panel).load({ limitMs }),
      { message: `limite inválido para carregar as mensagens mais antigas: ${String(limitMs)}` }
    );
    assert.deepEqual([panel.clicks, panel.scrolls], [0, 0]);
  }
});
