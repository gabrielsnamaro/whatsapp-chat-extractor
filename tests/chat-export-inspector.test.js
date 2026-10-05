import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZipBuilder } from '../shared/archive/zip-builder.js';
import { ZipReader } from '../shared/archive/zip-reader.js';
import { inspectChatExport } from '../shared/archive/chat-export-inspector.js';

// Conversas fictícias. O formato das linhas imita o da exportação do WhatsApp Web
// ("[data] Nome: texto", "[data] - evento"), mas o inspetor não interpreta a data.

const encoder = new TextEncoder();
const CHAT_MD = '# Conversa fictícia\n';

const CHAT_LINES = [
  // Aviso de criptografia no topo do arquivo, sem data: continuação
  'As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.',
  '[01/02/2026, 09:00:00] - Ana criou o grupo "Família"',
  '[01/02/2026, 09:01:00] Ana: Bom dia!',
  '[01/02/2026, 09:02:00] Bia: Tudo bem?',
  'segunda linha da mensagem da Bia',
  // Começa com "[" e tem "] ", mas o resto não é "Nome: ": continuação
  '[lembrete] isto continua a mensagem anterior',
  // Sem "] ": continuação
  '[sem espaço depois]do colchete',
  // "Nome:" sozinho, com o texto na linha seguinte
  '[01/02/2026, 09:03:00] Caio:',
  'texto na linha seguinte: com dois-pontos',
  '[01/02/2026, 09:04:00] - Caio saiu',
  '[01/02/2026, 09:05:00] Ana: Até logo',
  'e boa semana',
  ''
];
const CHAT_TEXT = CHAT_LINES.join('\n');

const CHAT_INSPECTION = {
  isEmpty: false,
  textBytes: encoder.encode(CHAT_TEXT).length,
  omittedMediaCount: 0,
  messageCount: 4,
  systemEventCount: 2,
  firstTimestamp: '01/02/2026, 09:00:00',
  lastTimestamp: '01/02/2026, 09:05:00'
};

function exportZip(files) {
  return ZipBuilder.buildArchive(Object.entries(files).map(([path, content]) => ({ path, content })));
}

test('ZIP nativo: conta mensagens e eventos do _chat.txt, ignora as continuações e guarda as datas brutas', async () => {
  const zip = await exportZip({ '_chat.txt': CHAT_TEXT, 'chat.md': CHAT_MD });

  // O texto vai comprimido, então a inspeção passa pela descompactação de uma entrada só
  const raw = await ZipReader.readRawEntries(zip);
  assert.equal(raw.find((entry) => entry.path === '_chat.txt').method, 8);

  assert.deepEqual(await inspectChatExport(zip), CHAT_INSPECTION);
});

test('ZIP com chat.txt (sem sublinhado) e texto gravado sem compressão', async () => {
  const text = '[01/02/2026, 09:01:00] Ana: oi\n';
  const zip = await exportZip({ 'chat.md': CHAT_MD, 'chat.txt': text });
  assert.equal((await ZipReader.readRawEntries(zip)).find((entry) => entry.path === 'chat.txt').method, 0);

  assert.deepEqual(await inspectChatExport(zip), {
    isEmpty: false,
    textBytes: encoder.encode(text).length,
    omittedMediaCount: 0,
    messageCount: 1,
    systemEventCount: 0,
    firstTimestamp: '01/02/2026, 09:01:00',
    lastTimestamp: '01/02/2026, 09:01:00'
  });
});

test('exportação vazia: _chat.txt só com uma quebra de linha, ao lado do chat.md', async () => {
  const zip = await exportZip({ '_chat.txt': '\n', 'chat.md': CHAT_MD });
  assert.deepEqual(await inspectChatExport(zip), {
    isEmpty: true,
    textBytes: 1,
    omittedMediaCount: 0,
    messageCount: 0,
    systemEventCount: 0,
    firstTimestamp: null,
    lastTimestamp: null
  });
});

test('texto só com espaços, tabulações e quebras de linha também é vazio', async () => {
  const text = '  \n\t \r\n   ';
  const zip = await exportZip({ '_chat.txt': text, 'chat.md': CHAT_MD });
  const result = await inspectChatExport(zip);
  assert.equal(result.isEmpty, true);
  assert.equal(result.textBytes, encoder.encode(text).length);
  assert.equal(result.messageCount, 0);
});

test('marcadores de anexo: os cinco tipos desta execução, outras mídias e o que não é marcador', async () => {
  const text = [
    '[01/02/2026, 10:00:00] Ana: <documento omitido>',
    '[01/02/2026, 10:01:00] Bia: <imagem ocultada>',
    '[01/02/2026, 10:02:00] Ana: <mensagem de voz omitida>',
    '[01/02/2026, 10:03:00] Bia: <áudio omitido>',
    '[01/02/2026, 10:04:00] Ana: <Mensagem de album>',
    // Com acento, e duas mídias na mesma linha
    '[01/02/2026, 10:05:00] Bia: <Mensagem de álbum>',
    '[01/02/2026, 10:06:00] Ana: <vídeo omitido> <figurinha omitida>',
    // Não são marcadores: a palavra sem os sinais, e outra marcação entre < >
    '[01/02/2026, 10:07:00] Bia: o documento omitido era o <b>contrato</b>',
    ''
  ].join('\n');
  const zip = await exportZip({ '_chat.txt': text, 'chat.md': CHAT_MD });

  const result = await inspectChatExport(zip);
  assert.equal(result.omittedMediaCount, 8);
  assert.equal(result.messageCount, 8);
  assert.equal(result.systemEventCount, 0);
});

test('texto puro (não ZIP): o arquivo inteiro é o texto da conversa', async () => {
  const blob = new Blob([CHAT_TEXT], { type: 'text/plain' });
  assert.equal(await ZipReader.isZipBlob(blob), false);
  assert.deepEqual(await inspectChatExport(blob), CHAT_INSPECTION);
});

test('linhas com CRLF: "Nome:" no fim da linha continua sendo mensagem', async () => {
  const blob = new Blob([CHAT_LINES.join('\r\n')]);
  const result = await inspectChatExport(blob);
  assert.deepEqual(
    { ...result, textBytes: null },
    { ...CHAT_INSPECTION, textBytes: null }
  );
});

test('ZIP sem _chat.txt: a inspeção falha com o motivo, em vez de afirmar uma conversa vazia', async () => {
  const zip = await exportZip({ 'chat.md': CHAT_MD });
  await assert.rejects(inspectChatExport(zip), { message: 'O ZIP exportado não contém o texto da conversa (_chat.txt).' });
});

test('ZIP truncado: a inspeção falha dizendo que o ZIP está ilegível e qual entrada está truncada', async () => {
  const zip = new Uint8Array(await (await exportZip({ '_chat.txt': CHAT_TEXT.repeat(20), 'chat.md': CHAT_MD })).arrayBuffer());
  // Cabeçalho local (30 bytes + nome) e só o começo dos dados comprimidos
  const truncated = new Blob([zip.subarray(0, 30 + '_chat.txt'.length + 10)]);
  assert.equal(await ZipReader.isZipBlob(truncated), true);
  // A leitura recusa a entrada que declara mais bytes do que o arquivo tem, antes de tentar descompactá-la
  await assert.rejects(inspectChatExport(truncated), /^Error: O ZIP exportado está ilegível \(A entrada "_chat\.txt" está truncada: .+\)\.$/);
});

test('formato não reconhecido: texto sem nenhuma linha "[data] ..." deixa contagens e datas em null', async () => {
  // Formato de outra plataforma (data sem colchetes), mesmo com um marcador de anexo no meio
  const text = [
    '01/02/2026 09:01 - Ana: Bom dia!',
    '01/02/2026 09:02 - Bia: <imagem ocultada>',
    '[sem data]',
    ''
  ].join('\n');
  assert.deepEqual(await inspectChatExport(new Blob([text])), {
    isEmpty: false,
    textBytes: encoder.encode(text).length,
    omittedMediaCount: null,
    messageCount: null,
    systemEventCount: null,
    firstTimestamp: null,
    lastTimestamp: null
  });
});
