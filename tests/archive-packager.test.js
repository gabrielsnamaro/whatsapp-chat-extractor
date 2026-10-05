import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ArchivePackager, REPORT_FILENAME, INDEX_FILENAME } from '../shared/archive/archive-packager.js';
import { ZipBuilder, ZipWriter, calculateCrc32 } from '../shared/archive/zip-builder.js';
import { ZipReader } from '../shared/archive/zip-reader.js';
import { StagingRepository } from '../shared/storage/staging-repository.js';
import { stubStaging } from './helpers/fake-chrome.js';

// O staging (IndexedDB, que não existe no Node) é trocado por um Map por chatId, e o ZIP montado é lido
// de volta com o ZipReader. Conversas fictícias.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const REPORT = 'Relatório de extração - WhatsApp Web Extractor\n';
// Texto que o deflate reduz, como o de uma conversa de verdade
const CHAT_TEXT = '[01/02/2026, 09:00:00] Ana: Bom dia! Tudo certo para amanhã?\n'.repeat(60);
const CHAT_MD = `# Conversa fictícia\n\n${'- [01/02/2026, 09:00:00] Ana: Bom dia!\n'.repeat(60)}`;

let staging = null;
const originalConsole = { log: console.log, warn: console.warn };

before(() => {
  // O packager avisa no log cada ZIP nativo ilegível e cada texto com CRC divergente, e o ZipWriter registra cada ZIP montado
  console.log = () => {};
  console.warn = () => {};
});

after(() => {
  Object.assign(console, originalConsole);
});

afterEach(() => {
  staging?.restore();
  staging = null;
});

/** ZIP com as entradas do que o WhatsApp Web exporta (o texto em _chat.txt e um chat.md ao lado), comprimidas quando o deflate reduz */
async function nativeExportZip(chatText) {
  const blob = await ZipBuilder.buildArchive([
    { path: '_chat.txt', content: chatText },
    { path: 'chat.md', content: '# Conversa fictícia\n' }
  ]);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * ZIP como o que o WhatsApp Web exporta de fato: as entradas gravadas sem compressão (method 0)
 * @param {Array<[string, string|Uint8Array]>} files Caminho e conteúdo de cada entrada
 */
async function storedExportZip(files) {
  const writer = new ZipWriter();
  for (const [path, content] of files) await writer.addFile(path, content, { compress: false });
  return new Uint8Array(await writer.finish().arrayBuffer());
}

/** Grava no staging trocado, como o orquestrador faz com o arquivo capturado */
function stage(chatId, chatTitle, content, filename) {
  return StagingRepository.saveChatFile({ chatId, chatTitle, filename, blob: new Blob([content]) });
}

/** Conteúdo de cada entrada do ZIP, por caminho, na ordem do arquivo */
async function readZip(blob) {
  const entries = await ZipReader.extractEntries(blob);
  return new Map(entries.map(({ path, content }) => [path, content]));
}

/** Entradas do ZIP ainda comprimidas, por caminho */
async function readRawZip(zipData) {
  return new Map((await ZipReader.readRawEntries(zipData)).map((entry) => [entry.path, entry]));
}

/** Como a entrada está gravada no ZIP: método, CRC, tamanhos e os bytes como estão */
function storedForm({ method, crc32, compressedSize, uncompressedSize, data }) {
  return { method, crc32, compressedSize, uncompressedSize, data };
}

test('sem divergência: a Conferência do ZIP vem no fim do relatório e fecha a conta', async () => {
  staging = stubStaging();
  await stage('000000', 'Ana', await nativeExportZip('[01/02/2026, 09:00:00] Ana: Bom dia!\n'), 'conversa.zip');
  await stage('000001', 'Bia', '[01/02/2026, 10:00:00] Bia: oi\n', 'conversa.txt');

  const { blob, chatCount, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'] });

  assert.equal(chatCount, 2);
  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: [] });
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], ['Ana/conversa.txt', 'Ana/chat.md', 'Bia/conversa.txt', REPORT_FILENAME]);
  assert.equal(
    decoder.decode(files.get(REPORT_FILENAME)),
    `${REPORT}\nConferência do ZIP: 2 conversa(s) esperada(s), 2 empacotada(s); sem divergência.\n`
  );
});

test('chave esperada ausente do staging aparece na Conferência do ZIP, e a que não era esperada entra no ZIP e também aparece', async () => {
  staging = stubStaging();
  await stage('000000', 'Ana', '[01/02/2026, 09:00:00] Ana: oi\n', 'conversa.txt');
  await stage('000002', 'Caio', '[01/02/2026, 11:00:00] Caio: oi\n', 'conversa.txt');
  await stage('000004', 'Eva', '[01/02/2026, 12:00:00] Eva: oi\n', 'conversa.txt');

  // Bia (000001) e Davi (000003) eram esperadas, mas não estão no staging (ex: limpo pelo Chrome sob
  // pressão de espaço); Eva (000004) está no staging sem ser esperada
  const { blob, chatCount, check } = await ArchivePackager.build({
    report: REPORT,
    expectedKeys: ['000000', '000001', '000002', '000003']
  });

  assert.equal(chatCount, 3);
  assert.deepEqual(check, { expected: 4, packed: 3, missingKeys: ['000001', '000003'], unreadable: [], unexpected: ['000004'], crcMismatch: [] });
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], ['Ana/conversa.txt', 'Caio/conversa.txt', 'Eva/conversa.txt', REPORT_FILENAME]);
  assert.equal(decoder.decode(files.get(REPORT_FILENAME)), [
    REPORT,
    'Conferência do ZIP: 4 conversa(s) esperada(s), 3 empacotada(s).',
    '- Esperada(s) e ausente(s) do staging, fora do ZIP (2): nº 2 (000001), nº 4 (000003).',
    '- No staging sem constar entre as esperadas, incluída(s) no ZIP mesmo assim (1): nº 5 (000004) "Eva".',
    '- O "no ZIP" do cabeçalho conta as conversas salvas durante a extração; o que de fato está no ZIP é o total empacotado acima.',
    ''
  ].join('\n'));
});

test('ZIP nativo ilegível (entrada truncada) vai para a pasta da conversa como o arquivo original e entra em unreadable; o ZIP montado continua legível', async () => {
  staging = stubStaging();
  const fullZip = await nativeExportZip('[01/02/2026, 09:01:00] Bia: Bom dia!\n'.repeat(40));
  const [chatEntry] = await ZipReader.readRawEntries(fullZip);
  // Download cortado: o cabeçalho local e só o começo dos dados comprimidos do _chat.txt
  const dataStart = 30 + '_chat.txt'.length;
  const truncatedZip = fullZip.slice(0, dataStart + 10);
  await stage('000000', 'Bia', truncatedZip, 'Conversa do WhatsApp com Bia.zip');
  await stage('000001', 'Ana', await nativeExportZip('[01/02/2026, 09:00:00] Ana: oi\n'), 'conversa.zip');

  const { blob, chatCount, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'] });

  assert.equal(chatCount, 2);
  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: ['000000'], unexpected: [], crcMismatch: [] });
  // As entradas depois da conversa ilegível são lidas inteiras: o ZIP montado não ficou desalinhado
  const files = await readZip(blob);
  assert.deepEqual(
    [...files.keys()],
    ['Bia/Conversa do WhatsApp com Bia.zip', 'Ana/conversa.txt', 'Ana/chat.md', REPORT_FILENAME]
  );
  assert.deepEqual(files.get('Bia/Conversa do WhatsApp com Bia.zip'), truncatedZip);
  assert.equal(decoder.decode(files.get('Ana/conversa.txt')), '[01/02/2026, 09:00:00] Ana: oi\n');
  assert.equal(decoder.decode(files.get(REPORT_FILENAME)), [
    REPORT,
    'Conferência do ZIP: 2 conversa(s) esperada(s), 2 empacotada(s).',
    '- ZIP nativo ilegível, gravado como o arquivo original na pasta da conversa: nº 1 (000000) "Bia". ' +
      `Motivo: A entrada "_chat.txt" está truncada: declara ${chatEntry.compressedSize} byte(s) de dados a partir do byte ${dataStart}, ` +
      `mas o ZIP tem ${truncatedZip.length} byte(s).`,
    ''
  ].join('\n'));
});

test('_execucao.log vai para a raiz do ZIP, e uma conversa chamada _execucao.log, em qualquer caixa, vai para outra pasta', async () => {
  staging = stubStaging();
  await stage('000000', '_execucao.log', '[01/02/2026, 09:00:00] Ana: oi\n', 'conversa.txt');
  await stage('000001', '_EXECUCAO.LOG', '[01/02/2026, 10:00:00] Bia: oi\n', 'conversa.txt');
  const executionLog = 'Log da execução - WhatsApp Web Extractor\n\n09:00:00 nº 1 "_execucao.log" | tentativa 1 | 4.2 s | abertura: busca | OK\n';

  const { blob, chatCount, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'], executionLog });

  assert.equal(chatCount, 2);
  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: [] });
  const files = await readZip(blob);
  assert.deepEqual(
    [...files.keys()],
    ['_execucao.log_1/conversa.txt', '_EXECUCAO.LOG_2/conversa.txt', REPORT_FILENAME, '_execucao.log']
  );
  assert.equal(decoder.decode(files.get('_execucao.log')), executionLog);
  assert.equal(decoder.decode(files.get('_execucao.log_1/conversa.txt')), '[01/02/2026, 09:00:00] Ana: oi\n');
});

test('_indice.csv na raiz: BOM, ";", cabeçalho, pasta de cada conversa (vazia sem staging), apóstrofo antes de +, =, - e @ e aspas no campo com ";" ou aspas; uma conversa chamada _indice.csv vai para outra pasta', async () => {
  staging = stubStaging();
  await stage('000000', '+55 11 98765-4321', '[01/02/2026, 09:00:00] +55 11 98765-4321: oi\n', 'conversa.txt');
  await stage('000001', 'Ana; Bia "amigas"', '\n', 'conversa.txt');
  await stage('000003', '_indice.csv', '[06/02/2026, 08:00:00] Davi: oi\n', 'conversa.txt');
  // Como o orquestrador monta: uma linha por conversa da fila, com a chave do staging só nas que têm arquivo nele
  const row = (fields) => ({
    chatId: null, code: null, attempts: 1, bytes: null, messageCount: null, systemEventCount: null, omittedMediaCount: null,
    firstTimestamp: null, lastTimestamp: null, durationMs: null, via: null, ...fields
  });
  const indexRows = [
    row({
      chatId: '000000', order: 1, title: '+55 11 98765-4321', status: 'OK', bytes: 2048, messageCount: 12, systemEventCount: 1,
      omittedMediaCount: 3, firstTimestamp: '01/02/2026, 09:00:00', lastTimestamp: '03/02/2026, 18:30:00', durationMs: 4249, via: 'busca'
    }),
    row({
      chatId: '000001', order: 2, title: 'Ana; Bia "amigas"', status: 'OK – VAZIA', bytes: 512, messageCount: 0, systemEventCount: 0,
      omittedMediaCount: 0, durationMs: 3000, via: 'lista visível'
    }),
    row({ order: 3, title: '-Caio-', status: 'FALHA', code: 'CHAT_NOT_FOUND', attempts: 2, durationMs: 12340 }),
    row({
      chatId: '000003', order: 4, title: '_indice.csv', status: 'OK', bytes: 256, messageCount: 1, systemEventCount: 0, omittedMediaCount: 0,
      firstTimestamp: '06/02/2026, 08:00:00', lastTimestamp: '06/02/2026, 08:00:00', durationMs: 2500, via: 'rolagem da lista'
    }),
    row({ order: 5, title: '=SOMA(1;2)', status: 'NA PASTA DOWNLOADS', durationMs: 5100, via: 'lista visível' }),
    row({ order: 6, title: '@Loja', status: 'NÃO EXPORTÁVEL', code: 'EXPORT_OPTION_UNAVAILABLE', durationMs: 1000 })
  ];

  const { blob, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001', '000003'], indexRows });

  assert.deepEqual(check, { expected: 3, packed: 3, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: [] });
  const files = await readZip(blob);
  assert.deepEqual(
    [...files.keys()],
    ['+55 11 98765-4321/conversa.txt', 'Ana; Bia _amigas_/conversa.txt', '_indice.csv_1/conversa.txt', REPORT_FILENAME, INDEX_FILENAME]
  );
  const csv = files.get(INDEX_FILENAME);
  // O BOM UTF-8 faz o Excel ler os acentos certos; o TextDecoder padrão o descartaria
  assert.deepEqual([...csv.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
  // A duração vai em segundos com vírgula decimal, que o Excel em português lê como número
  assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(csv), `\uFEFF${[
    'Ordem;Título;Pasta;Status;Código;Tentativas;Bytes;Mensagens;Eventos de sistema;Anexos omitidos;Primeira data;Última data;Duração (s);Abertura',
    "1;'+55 11 98765-4321;'+55 11 98765-4321;OK;;1;2048;12;1;3;01/02/2026, 09:00:00;03/02/2026, 18:30:00;4,2;busca",
    '2;"Ana; Bia ""amigas""";"Ana; Bia _amigas_";OK – VAZIA;;1;512;0;0;0;;;3;lista visível',
    "3;'-Caio-;;FALHA;CHAT_NOT_FOUND;2;;;;;;;12,3;",
    '4;_indice.csv;_indice.csv_1;OK;;1;256;1;0;0;06/02/2026, 08:00:00;06/02/2026, 08:00:00;2,5;rolagem da lista',
    `5;"'=SOMA(1;2)";;NA PASTA DOWNLOADS;;1;;;;;;;5,1;lista visível`,
    "6;'@Loja;;NÃO EXPORTÁVEL;EXPORT_OPTION_UNAVAILABLE;1;;;;;;;1;",
    ''
  ].join('\r\n')}`);
  assert.equal(decoder.decode(files.get('_indice.csv_1/conversa.txt')), '[06/02/2026, 08:00:00] Davi: oi\n');
});

test('texto que o ZIP nativo grava sem compressão (.txt e .md) sai comprimido, com o mesmo conteúdo e o CRC original; mídia e texto já comprimido vão como estavam', async () => {
  staging = stubStaging();
  const photo = new Uint8Array(4096).map((_, i) => (i * 37) % 251);
  const anaZip = await storedExportZip([['_chat.txt', CHAT_TEXT], ['chat.md', CHAT_MD], ['foto.jpg', photo]]);
  // Bia: um ZIP nativo com o texto já comprimido (method 8)
  const biaZip = await nativeExportZip(CHAT_TEXT);
  await stage('000000', 'Ana', anaZip, 'conversa.zip');
  await stage('000001', 'Bia', biaZip, 'conversa.zip');
  const ana = await readRawZip(anaZip);
  const bia = await readRawZip(biaZip);
  assert.deepEqual([...ana.values()].map((entry) => entry.method), [0, 0, 0]);
  assert.equal(bia.get('_chat.txt').method, 8);

  const { blob, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'] });

  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: [] });
  const packed = await readRawZip(blob);
  assert.deepEqual([...packed.keys()], ['Ana/conversa.txt', 'Ana/chat.md', 'Ana/foto.jpg', 'Bia/conversa.txt', 'Bia/chat.md', REPORT_FILENAME]);
  for (const [packedPath, nativePath] of [['Ana/conversa.txt', '_chat.txt'], ['Ana/chat.md', 'chat.md']]) {
    const entry = packed.get(packedPath);
    const original = ana.get(nativePath);
    assert.equal(entry.method, 8, `${packedPath} deveria sair comprimido`);
    assert.ok(entry.compressedSize < original.compressedSize, `${packedPath}: ${entry.compressedSize} bytes comprimido, contra ${original.compressedSize}`);
    assert.equal(entry.crc32, original.crc32);
    assert.equal(entry.uncompressedSize, original.uncompressedSize);
    const content = await ZipReader.decompressEntry(entry);
    assert.deepEqual(content, original.data);
    // O CRC original confere com o conteúdo comprimido
    assert.equal(calculateCrc32(content), entry.crc32);
  }
  assert.deepEqual(storedForm(packed.get('Ana/foto.jpg')), storedForm(ana.get('foto.jpg')));
  assert.deepEqual(storedForm(packed.get('Bia/conversa.txt')), storedForm(bia.get('_chat.txt')));
  assert.equal(decoder.decode(await ZipReader.decompressEntry(packed.get('Bia/conversa.txt'))), CHAT_TEXT);
});

test('texto do ZIP nativo com CRC que não confere vai como estava, sem compressão, e aparece na Conferência do ZIP', async () => {
  staging = stubStaging();
  const chatText = encoder.encode(CHAT_TEXT);
  // Como um texto que chegou corrompido: o CRC gravado no ZIP do WhatsApp não é o dos dados
  const wrongCrc = (calculateCrc32(chatText) ^ 0x1) >>> 0;
  const writer = new ZipWriter();
  writer.addRawEntry({ path: '_chat.txt', method: 0, crc32: wrongCrc, compressedSize: chatText.length, uncompressedSize: chatText.length, data: chatText });
  await writer.addFile('chat.md', CHAT_MD, { compress: false });
  await stage('000000', 'Ana', '[01/02/2026, 09:00:00] Ana: oi\n', 'conversa.txt');
  await stage('000001', 'Bia', new Uint8Array(await writer.finish().arrayBuffer()), 'conversa.zip');

  const { blob, chatCount, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'] });

  assert.equal(chatCount, 2);
  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: ['000001'] });
  const packed = await readRawZip(blob);
  // Byte a byte como estava, com o CRC que tinha; a outra entrada da conversa, que confere, sai comprimida
  assert.deepEqual(storedForm(packed.get('Bia/conversa.txt')), {
    method: 0, crc32: wrongCrc, compressedSize: chatText.length, uncompressedSize: chatText.length, data: chatText
  });
  assert.equal(packed.get('Bia/chat.md').method, 8);
  const files = await readZip(blob);
  assert.equal(decoder.decode(files.get(REPORT_FILENAME)), [
    REPORT,
    'Conferência do ZIP: 2 conversa(s) esperada(s), 2 empacotada(s).',
    '- Texto com CRC que não confere com o conteúdo, copiado do ZIP nativo como estava, sem compressão (pode ter chegado corrompido): ' +
      'nº 2 (000001) "Bia". Arquivo(s) no ZIP: "Bia/conversa.txt".',
    ''
  ].join('\n'));
});

test('sem a lista das conversas esperadas, o empacotamento falha em vez de montar o ZIP sem conferência', async () => {
  staging = stubStaging();
  await stage('000000', 'Ana', '[01/02/2026, 09:00:00] Ana: oi\n', 'conversa.txt');

  await assert.rejects(ArchivePackager.build({ report: REPORT }), {
    message: 'O empacotamento não recebeu a lista das conversas esperadas no ZIP (expectedKeys).'
  });
});
