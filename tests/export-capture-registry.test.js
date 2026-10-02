import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ExportCaptureRegistry } from '../background/export-capture-registry.js';
import { ACTIONS } from '../shared/constants/actions.js';

// Testes de caracterização do registry: o que ele recusa hoje e como avisa quem espera o arquivo

const UNEXPECTED_CAPTURE = 'Captura não esperada (concluída, descartada ou de uma execução anterior).';
const encoder = new TextEncoder();

const originalLog = console.log;
before(() => { console.log = () => {}; });
after(() => { console.log = originalLog; });

function start(registry, captureId, fields = {}) {
  return registry.handleTransferMessage({
    action: ACTIONS.EXPORT_TRANSFER_START,
    captureId,
    filename: 'conversa.zip',
    mimeType: 'application/zip',
    size: 10,
    totalChunks: 1,
    ...fields
  });
}

function chunk(registry, captureId, index, bytes) {
  return registry.handleTransferMessage({
    action: ACTIONS.EXPORT_TRANSFER_CHUNK,
    captureId,
    index,
    data: Buffer.from(bytes).toString('base64')
  });
}

function end(registry, captureId) {
  return registry.handleTransferMessage({ action: ACTIONS.EXPORT_TRANSFER_END, captureId });
}

test('captura não esperada é recusada: nunca registrada, descartada ou já entregue', async () => {
  const registry = new ExportCaptureRegistry();
  assert.deepEqual(start(registry, 'nunca-registrada'), { success: false, error: UNEXPECTED_CAPTURE });

  registry.expect('descartada');
  registry.discard('descartada');
  assert.deepEqual(start(registry, 'descartada'), { success: false, error: UNEXPECTED_CAPTURE });

  registry.expect('entregue');
  const bytes = encoder.encode('olá');
  assert.equal(start(registry, 'entregue', { size: bytes.length }).success, true);
  assert.equal(chunk(registry, 'entregue', 0, bytes).success, true);
  assert.equal(end(registry, 'entregue').success, true);
  await registry.waitFor('entregue', { timeoutMs: 1000 });
  assert.deepEqual(start(registry, 'entregue', { size: bytes.length }), { success: false, error: UNEXPECTED_CAPTURE });
  assert.deepEqual(chunk(registry, 'entregue', 0, bytes), { success: false, error: UNEXPECTED_CAPTURE });
});

test('quantidade de blocos inválida é recusada sem derrubar a captura', async () => {
  const registry = new ExportCaptureRegistry();
  registry.expect('a');

  for (const totalChunks of [0, -1, 1.5, 'abc', undefined]) {
    assert.deepEqual(
      start(registry, 'a', { totalChunks }),
      { success: false, error: 'Quantidade de blocos inválida.' },
      `totalChunks = ${totalChunks}`
    );
  }

  // A captura continua esperando e aceita uma transferência válida depois
  const bytes = encoder.encode('conteúdo');
  assert.equal(start(registry, 'a', { size: bytes.length, totalChunks: '1' }).success, true);
  assert.equal(chunk(registry, 'a', 0, bytes).success, true);
  assert.equal(end(registry, 'a').success, true);
  const captured = await registry.waitFor('a', { timeoutMs: 1000 });
  assert.equal(await captured.blob.text(), 'conteúdo');
});

test('bloco fora da faixa ou antes do início é recusado, e o fim exige todos os blocos', async () => {
  const registry = new ExportCaptureRegistry();
  registry.expect('a');
  const outOfRange = { success: false, error: 'Bloco fora de ordem ou transferência não iniciada.' };

  assert.deepEqual(chunk(registry, 'a', 0, encoder.encode('x')), outOfRange);

  const bytes = encoder.encode('primeira|segunda');
  const [first, second] = [bytes.subarray(0, 9), bytes.subarray(9)];
  assert.equal(start(registry, 'a', { size: bytes.length, totalChunks: 2, mimeType: 'text/plain', filename: 'chat.txt' }).success, true);
  for (const index of [2, -1, 1.5, 'x']) {
    assert.deepEqual(chunk(registry, 'a', index, first), outOfRange, `index = ${index}`);
  }

  assert.equal(chunk(registry, 'a', 1, second).success, true);
  assert.deepEqual(end(registry, 'a'), { success: false, error: 'Transferência incompleta.' });

  // Blocos fora de ordem são aceitos dentro da faixa, e o arquivo é montado pela posição
  assert.equal(chunk(registry, 'a', 0, first).success, true);
  assert.equal(end(registry, 'a').success, true);
  const captured = await registry.waitFor('a', { timeoutMs: 1000 });
  assert.equal(captured.filename, 'chat.txt');
  assert.equal(captured.source, 'page');
  assert.equal(captured.blob.type, 'text/plain');
  assert.equal(await captured.blob.text(), 'primeira|segunda');
});

test('tamanho divergente rejeita a espera, esteja ela registrada antes ou depois', async () => {
  const registry = new ExportCaptureRegistry();
  const mismatch = { success: false, error: 'Tamanho do arquivo recebido não confere.' };
  const bytes = encoder.encode('12345');

  // Espera registrada antes da transferência (o caso comum: o arquivo chega depois do clique)
  registry.expect('antes');
  const waiting = registry.waitFor('antes', { timeoutMs: 1000 });
  start(registry, 'antes', { size: 10 });
  chunk(registry, 'antes', 0, bytes);
  assert.deepEqual(end(registry, 'antes'), mismatch);
  await assert.rejects(waiting, { message: 'Arquivo recebido com 5 bytes; esperados 10.' });

  // Arquivo entregue antes da espera: o erro fica guardado para quem chamar waitFor
  registry.expect('depois');
  start(registry, 'depois', { size: 10 });
  chunk(registry, 'depois', 0, bytes);
  assert.deepEqual(end(registry, 'depois'), mismatch);
  await assert.rejects(registry.waitFor('depois', { timeoutMs: 1000 }), { message: 'Arquivo recebido com 5 bytes; esperados 10.' });

  // Depois da falha, a captura deixa de existir
  assert.deepEqual(start(registry, 'antes', { size: 5 }), { success: false, error: UNEXPECTED_CAPTURE });
});

test('prazo esgotado sem atividade rejeita a espera e descarta a captura', async () => {
  const registry = new ExportCaptureRegistry();
  registry.expect('a');

  const startedAt = performance.now();
  // O texto arredonda o prazo para minutos: com 30 ms, a mensagem diz "0 min"
  await assert.rejects(
    registry.waitFor('a', { timeoutMs: 30 }),
    { message: 'O WhatsApp Web não entregou o arquivo exportado em 0 min.' }
  );
  assert.ok(performance.now() - startedAt >= 20, 'a espera não deveria expirar antes do prazo');
  assert.deepEqual(start(registry, 'a'), { success: false, error: UNEXPECTED_CAPTURE });
});
