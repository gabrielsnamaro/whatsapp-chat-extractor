import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// chat-navigator.js é um content script clássico que se registra em window. A lista lateral do WhatsApp Web é uma lista
// virtual: só as linhas perto da tela existem no DOM. Aqui ela é simulada (FakeSidebar) com conversas fictícias e só o
// pedaço do DOM que a abertura usa; os seletores reais são conferidos nos snapshots da kb/

const ROW_HEIGHT = 72;
// Dez linhas na tela
const VIEWPORT_HEIGHT = 720;
// Linhas desenhadas acima e abaixo da tela
const OVERSCAN_ROWS = 3;

let current = null;

class FakeKeyboardEvent {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
}

const context = vm.createContext({
  window: {},
  setTimeout,
  clearTimeout,
  KeyboardEvent: FakeKeyboardEvent,
  document: {
    querySelector: (selector) => current.querySelector(selector),
    hasFocus: () => current.focused
  },
  requestAnimationFrame: (callback) => current.requestFrame(callback)
});
for (const file of ['../content/dom/dom-utils.js', '../content/dom/chat-navigator.js']) {
  vm.runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
}
const { ChatNavigator, DomUtils: { SELECTORS } } = context.window;

/**
 * Lista lateral simulada, com as conversas na ordem da lista. Só as linhas perto da tela são desenhadas, como na lista
 * virtual. `freeze` simula o navegador que deixou de desenhar a página: as linhas na tela não mudam ao rolar, a busca
 * digitada não filtra a lista e nenhum quadro é desenhado
 */
class FakeSidebar {
  constructor(titles) {
    this.titles = [...titles];
    this.top = 0;
    this.frozenRows = null;
    this.searchText = '';
    /** Textos digitados na busca, na ordem */
    this.typed = [];
    this.activeTitle = null;
    this.focused = true;
    const sidebar = this;
    this.pane = {
      isConnected: true,
      clientHeight: VIEWPORT_HEIGHT,
      get scrollHeight() { return sidebar.titles.length * ROW_HEIGHT; },
      get scrollTop() { return sidebar.top; },
      set scrollTop(value) { sidebar.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
      querySelectorAll: (selector) => (selector === SELECTORS.CHAT_CELL ? sidebar.renderedCells() : [])
    };
    this.side = { querySelectorAll: (selector) => (selector === SELECTORS.CHAT_CELL ? sidebar.sideCells() : []) };
    // A grade da lista normal sai da tela enquanto a busca mostra os resultados
    this.grid = { isConnected: true, getClientRects: () => (sidebar.searching() ? [] : [{}]) };
    this.input = { focus() {}, dispatchEvent() {} };
    this.header = { getAttribute: (name) => (name === 'title' ? sidebar.activeTitle : null) };
  }

  get frozen() {
    return this.frozenRows !== null;
  }

  freeze() {
    this.frozenRows = this.rowsInView();
  }

  rowsInView() {
    const first = Math.max(0, Math.floor(this.top / ROW_HEIGHT) - OVERSCAN_ROWS);
    const last = Math.min(this.titles.length - 1, Math.ceil((this.top + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN_ROWS);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  }

  renderedCells() {
    return (this.frozenRows ?? this.rowsInView()).map((row) => this.cell(this.titles[row], row));
  }

  searching() {
    return Boolean(this.searchText) && !this.frozen;
  }

  sideCells() {
    if (!this.searching()) return this.renderedCells();
    return this.titles.filter((title) => title.includes(this.searchText)).map((title) => this.cell(title, null));
  }

  typeSearch(text) {
    this.searchText = text;
    if (text) this.typed.push(text);
  }

  /** Célula de uma conversa; `row` é a linha na lista, null num resultado da busca */
  cell(title, row) {
    const sidebar = this;
    return {
      isConnected: true,
      closest: (selector) => (selector === SELECTORS.CHAT_ROW ? { getBoundingClientRect: () => ({ height: ROW_HEIGHT }) } : null),
      querySelector: (selector) => (selector === SELECTORS.CHAT_TITLE ? { querySelector: () => ({ getAttribute: () => title }) } : null),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: ROW_HEIGHT }),
      focus() {},
      dispatchEvent() {},
      // Como o scrollIntoView({ block: 'center' }) da abertura: a célula fica no meio da tela
      scrollIntoView() {
        if (row !== null) sidebar.pane.scrollTop = row * ROW_HEIGHT - VIEWPORT_HEIGHT / 2;
      },
      click() {
        sidebar.activeTitle = title;
      }
    };
  }

  querySelector(selector) {
    switch (selector) {
      case SELECTORS.PANE_SIDE: return this.pane;
      case SELECTORS.SIDE_PANEL: return this.side;
      case SELECTORS.CHAT_LIST_GRID: return this.grid;
      case SELECTORS.SEARCH_INPUT: return this.input;
      case SELECTORS.MAIN_HEADER_TITLE:
      case SELECTORS.MAIN_HEADER_TITLE_FALLBACK:
        return this.activeTitle ? this.header : null;
      case SELECTORS.MAIN_HEADER: return this.activeTitle ? {} : null;
      default: return null;
    }
  }

  requestFrame(callback) {
    if (!this.frozen) setTimeout(callback, 16);
  }
}

/** A caixa de busca simulada não é um <input> deste contexto: o texto vai direto para a lista simulada */
class FakeSidebarNavigator extends ChatNavigator {
  _readSearchText() {
    return current.searchText;
  }

  _setSearchText(_input, text) {
    current.typeSearch(text);
  }
}

function createNavigator() {
  return new FakeSidebarNavigator({
    timeouts: { openChatMs: 500, searchResultsMs: 120, searchExitMs: 200, openScrollMs: 5000 },
    scrollDelayMs: 1,
    jumpRenderMs: 1
  });
}

/** Títulos fictícios, na ordem da lista */
function titles(count) {
  return Array.from({ length: count }, (_, i) => `Conversa ${String(i).padStart(3, '0')}`);
}

/** O resultado vem do contexto do vm: comparado pelos campos, sem os protótipos de lá */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('conversa fora da tela, perto de onde estava na varredura: achada na posição estimada, sem a busca, e a seguinte da fila já fica na tela', async () => {
  current = new FakeSidebar(titles(200));
  const navigator = createNavigator();

  const opened = plain(await navigator.openChat({ title: 'Conversa 110' }, { queueIndex: 110 }));

  assert.equal(opened.via, 'nearby');
  assert.deepEqual(Object.keys(opened.diagnostics), ['nearbyMs', 'nearbyFound']);
  assert.equal(opened.diagnostics.nearbyFound, true);
  assert.deepEqual(current.typed, []);
  assert.equal(current.activeTitle, 'Conversa 110');

  // A lista ficou no ponto da fila: a seguinte é achada na tela, sem a busca (antes, depois de uma abertura pela busca,
  // todas as seguintes iam para a busca)
  const next = plain(await navigator.openChat({ title: 'Conversa 111' }, { queueIndex: 111 }));
  assert.deepEqual([next.via, next.diagnostics], ['visible', null]);
  assert.deepEqual(current.typed, []);
});

test('conversa que desceu na lista desde a varredura (outras subiram para o topo): achada no passo abaixo da posição estimada', async () => {
  current = new FakeSidebar(titles(200));
  // 16 conversas de baixo receberam mensagem e subiram: a nº 110 da varredura está agora na linha 126
  current.titles.unshift(...Array.from({ length: 16 }, (_, i) => `Nova ${i}`));
  const navigator = createNavigator();

  const opened = plain(await navigator.openChat({ title: 'Conversa 110' }, { queueIndex: 110 }));

  assert.equal(opened.via, 'nearby');
  assert.equal(opened.diagnostics.nearbyFound, true);
  assert.deepEqual(current.typed, []);
});

test('conversa que subiu para o topo da lista: não está perto da posição estimada, e a busca a acha', async () => {
  current = new FakeSidebar(titles(200));
  // Recebeu mensagem durante a extração
  current.titles.unshift(...current.titles.splice(150, 1));
  current.pane.scrollTop = 80 * ROW_HEIGHT;
  const navigator = createNavigator();

  const opened = plain(await navigator.openChat({ title: 'Conversa 150' }, { queueIndex: 150 }));

  assert.equal(opened.via, 'search');
  assert.deepEqual(current.typed, ['Conversa 150']);
  assert.equal(opened.diagnostics.nearbyFound, false);
  assert.ok(opened.diagnostics.nearbyMs >= 0);
  // A busca achou: os campos da busca sem resultado não vêm
  assert.deepEqual(Object.keys(opened.diagnostics).sort(), ['nearbyFound', 'nearbyMs', 'searchCellsSeen', 'searchExited', 'searchMs']);
  assert.equal(opened.diagnostics.searchExited, true);
});

test('sem a posição na fila, a tentativa perto da posição estimada não roda', async () => {
  current = new FakeSidebar(titles(200));
  const navigator = createNavigator();

  const opened = plain(await navigator.openChat({ title: 'Conversa 120' }));

  assert.equal(opened.via, 'search');
  assert.equal('nearbyMs' in opened.diagnostics, false);
});

test('página que o navegador deixou de desenhar (como nas falhas de 16/10): a conversa não é achada, e o diagnóstico mostra o texto na caixa, a lista normal na tela, 0 quadros, a janela sem foco e os mesmos títulos durante a rolagem', async () => {
  current = new FakeSidebar(titles(400));
  current.focused = false;
  current.freeze();
  const navigator = createNavigator();

  await assert.rejects(navigator.openChat({ title: 'Conversa 300' }, { queueIndex: 300 }), (err) => {
    assert.equal(err.code, 'CHAT_NOT_FOUND');
    const diagnostics = plain(err.openDiagnostics);
    // As linhas desenhadas antes de a página parar: as dez da tela e as três abaixo dela
    const frozenRows = 10 + OVERSCAN_ROWS + 1;
    assert.deepEqual(
      {
        nearbyFound: diagnostics.nearbyFound,
        searchCellsSeen: diagnostics.searchCellsSeen,
        searchExited: diagnostics.searchExited,
        searchTyped: diagnostics.searchTyped,
        searchGridShown: diagnostics.searchGridShown,
        searchFrames: diagnostics.searchFrames,
        windowFocused: diagnostics.windowFocused,
        scrollStopReason: diagnostics.scrollStopReason,
        scrollTitlesSeen: diagnostics.scrollTitlesSeen
      },
      {
        nearbyFound: false,
        searchCellsSeen: frozenRows,
        searchExited: true,
        searchTyped: true,
        searchGridShown: true,
        searchFrames: 0,
        windowFocused: false,
        scrollStopReason: 'end-of-list',
        scrollTitlesSeen: frozenRows
      }
    );
    return true;
  });
  assert.deepEqual(current.typed, ['Conversa 300']);
});

test('busca sem resultado com a página desenhada: a lista normal sai da tela, os quadros são contados e a rolagem vê a lista inteira', async () => {
  current = new FakeSidebar(titles(60));
  const navigator = createNavigator();

  // Uma conversa que não está na lista (ex: apagada depois da varredura)
  await assert.rejects(navigator.openChat({ title: 'Conversa apagada' }, { queueIndex: 30 }), (err) => {
    const diagnostics = plain(err.openDiagnostics);
    assert.equal(err.code, 'CHAT_NOT_FOUND');
    assert.equal(diagnostics.searchTyped, true);
    assert.equal(diagnostics.searchGridShown, false);
    assert.ok(diagnostics.searchFrames > 0, `${diagnostics.searchFrames} quadro(s)`);
    assert.equal(diagnostics.windowFocused, true);
    assert.equal(diagnostics.scrollTitlesSeen, 60);
    return true;
  });
});
