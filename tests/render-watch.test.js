import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// render-watch.js é um content script clássico que se registra em window. O relógio, os quadros (requestAnimationFrame),
// os temporizadores e a visibilidade da aba são simulados aqui, como no navegador
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../content/dom/render-watch.js', import.meta.url), 'utf8'), context);
const { RenderWatch } = context.window;

/**
 * Página simulada: `advance(ms, fps)` anda o relógio desenhando `fps` quadros por segundo (0: a página não é desenhada,
 * como a janela minimizada ou coberta no Wayland) e rodando os temporizadores na hora deles
 */
function createPage() {
  const env = { t: 0, frameRequests: [], intervals: new Map(), nextId: 1, visible: true, changes: [], requested: 0 };
  const watch = new RenderWatch({
    onChange: (stalled) => env.changes.push(stalled),
    options: {
      now: () => env.t,
      requestFrame: (callback) => {
        env.requested++;
        env.frameRequests.push(callback);
      },
      isDocumentVisible: () => env.visible,
      setInterval: (callback, ms) => {
        const id = env.nextId++;
        env.intervals.set(id, { callback, ms, next: env.t + ms });
        return id;
      },
      clearInterval: (id) => env.intervals.delete(id)
    }
  });
  function advance(ms, fps) {
    const end = env.t + ms;
    const frameEvery = fps > 0 ? 1000 / fps : Infinity;
    let nextFrame = env.t + frameEvery;
    while (env.t < end) {
      const nextTimer = Math.min(Infinity, ...[...env.intervals.values()].map((timer) => timer.next));
      env.t = Math.min(nextFrame, nextTimer, end);
      if (env.t === nextFrame) {
        // Como o navegador: cada quadro roda os callbacks pedidos até ali, e um pedido feito dentro deles fica para o seguinte
        env.frameRequests.splice(0).forEach((callback) => callback());
        nextFrame += frameEvery;
      }
      for (const timer of [...env.intervals.values()]) {
        if (timer.next <= env.t) {
          timer.next += timer.ms;
          timer.callback();
        }
      }
    }
  }
  return { env, watch, advance };
}

test('página desenhada normalmente: nunca é tida como parada, mesmo num desenho lento de 10 quadros por segundo', () => {
  const { env, watch, advance } = createPage();
  watch.start();
  advance(20000, 60);
  advance(20000, 10);
  assert.deepEqual(env.changes, []);
  assert.equal(watch.stalled, false);
});

test('página sem desenho por 3 s com a aba tida como visível (janela minimizada ou coberta): avisa uma vez, e de novo quando ela volta', () => {
  const { env, watch, advance } = createPage();
  watch.start();
  advance(5000, 60);
  advance(2500, 0);
  assert.deepEqual(env.changes, []);
  advance(1500, 0);
  assert.deepEqual(env.changes, [true]);
  assert.equal(watch.stalled, true);
  // Continua parada: nenhum aviso repetido
  advance(30000, 0);
  assert.deepEqual(env.changes, [true]);
  // A janela volta: dois quadros a menos de 0,5 s um do outro bastam
  advance(100, 60);
  assert.deepEqual(env.changes, [true, false]);
  assert.equal(watch.stalled, false);
  advance(10000, 60);
  assert.deepEqual(env.changes, [true, false]);
});

test('desenho de vez em quando (1 quadro por segundo) também conta como parada, e só volta com o desenho normal', () => {
  const { env, watch, advance } = createPage();
  watch.start();
  advance(2000, 60);
  advance(6000, 1);
  assert.deepEqual(env.changes, [true]);
  advance(5000, 1);
  assert.deepEqual(env.changes, [true]);
  advance(1000, 30);
  assert.deepEqual(env.changes, [true, false]);
});

test('aba oculta (visibilitychange já avisa): sem aviso de página parada, e a contagem recomeça quando ela volta', () => {
  const { env, watch, advance } = createPage();
  watch.start();
  advance(2000, 60);
  env.visible = false;
  advance(10000, 0);
  env.visible = true;
  // Logo depois de voltar, os quadros que faltaram enquanto ela estava oculta não contam
  advance(1500, 60);
  advance(10000, 60);
  assert.deepEqual(env.changes, []);
});

test('checagem atrasada (temporizadores estrangulados na aba oculta ou uma tarefa longa da página): a contagem recomeça, sem aviso falso', () => {
  const { env, watch, advance } = createPage();
  watch.start();
  advance(5000, 60);
  // A aba fica oculta, e o Chrome segura os temporizadores dela: nenhuma checagem por 60 s, nenhum quadro
  env.visible = false;
  const [timer] = env.intervals.values();
  timer.next = env.t + 60000;
  advance(59000, 0);
  // A aba volta, e a checagem atrasada roda antes do primeiro quadro
  env.visible = true;
  advance(1000, 0);
  assert.deepEqual(env.changes, []);
  advance(10000, 60);
  assert.deepEqual(env.changes, []);
  // Uma tarefa longa da página, de 4 s, segura os quadros e os temporizadores juntos
  timer.next = env.t + 4000;
  advance(4000, 0);
  advance(5000, 60);
  assert.deepEqual(env.changes, []);
});

test('fora da varredura e da exportação, os quadros não são pedidos; parada, a página espera o quadro que encerra isso', () => {
  const { env, watch, advance } = createPage();
  watch.start();
  advance(1000, 60);
  watch.stop();
  advance(1000, 60);
  const requestedAfterStop = env.requested;
  advance(10000, 60);
  assert.equal(env.requested, requestedAfterStop);
  assert.equal(env.intervals.size, 0);
  assert.deepEqual(env.changes, []);

  // Parada durante uma operação que termina: o aviso da volta ainda chega, e depois tudo para
  watch.start();
  advance(1000, 60);
  advance(4000, 0);
  assert.deepEqual(env.changes, [true]);
  watch.stop();
  advance(20000, 0);
  advance(200, 60);
  assert.deepEqual(env.changes, [true, false]);
  assert.equal(env.intervals.size, 0);
  const requestedAfterRecovery = env.requested;
  advance(5000, 60);
  assert.equal(env.requested, requestedAfterRecovery);
});

test('start repetido não cria outro temporizador nem pede quadro a mais', () => {
  const { env, watch } = createPage();
  watch.start();
  watch.start();
  assert.equal(env.intervals.size, 1);
  assert.equal(env.requested, 1);
});
