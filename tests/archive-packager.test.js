import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArchivePackager, REPORT_FILENAME, INDEX_FILENAME, CHATS_JSON_FILENAME, MESSAGES_JSON_FILENAME
} from '../shared/archive/archive-packager.js';
import { ZipBuilder, ZipWriter, calculateCrc32 } from '../shared/archive/zip-builder.js';
import { ZipReader } from '../shared/archive/zip-reader.js';
import { StagingRepository } from '../shared/storage/staging-repository.js';
import { stubStaging } from './helpers/fake-chrome.js';

// O staging (IndexedDB, que não existe no Node) é trocado por um Map por chatId, e o ZIP montado é lido
// de volta com o ZipReader. Conversas fictícias.

// A hora do texto exportado é local, sem fuso: o fuso fica fixo para as datas em UTC do JSON não dependerem da máquina.
// O node --test roda cada arquivo de teste num processo próprio
process.env.TZ = 'America/Sao_Paulo';

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

// JSON no ZIP (_conversas.jsonl e _mensagens.jsonl). Números, nomes e conversas fictícios; o texto imita as formas das
// exportações reais (data "M/D/AA, H:MM:SS AM", aviso de criptografia sem data no topo)

const LINE_PHONE = '5511900000000';
const RUN_META = { runId: 'mux6ft32', linePhone: LINE_PHONE, extensionVersion: '1.0.0' };
const TIME_ZONE = 'America/Sao_Paulo';
const MISSING_CHAT_TEXT = 'O ZIP exportado não contém o texto da conversa (_chat.txt).';
const UNRECOGNIZED_FORMAT = 'Formato do texto não reconhecido: nenhuma linha segue a forma "[data] Nome: texto" ou "[data] - evento".';

/** SHA-256 em hexadecimal, pelo node:crypto: uma implementação independente da do empacotamento (WebCrypto) */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** chat_id de uma conversa sem telefone */
function titleChatId(title) {
  return `${LINE_PHONE}_t${sha256Hex(title).slice(0, 16)}`;
}

/** message_id como o contrato descreve */
function expectedMessageId(chatId, timestampRaw, senderName, text, occurrence) {
  return sha256Hex(JSON.stringify([chatId, timestampRaw, senderName, text, occurrence])).slice(0, 32);
}

/** Linha do índice como o orquestrador monta, com o que vai para o JSON */
function indexRow(fields) {
  return {
    chatId: null, order: 1, title: '', status: 'OK', exportStatus: 'saved', code: null, attempts: 1, bytes: null, messageCount: null,
    systemEventCount: null, omittedMediaCount: null, firstTimestamp: null, lastTimestamp: null, durationMs: null, via: null,
    kind: null, contactPhone: null, contactPhoneSource: null, exportedAt: null, ...fields
  };
}

/** Conversa esperada no _conversas.jsonl, com os campos na ordem do contrato, mais parse_error e extension_version */
function expectedChat(fields) {
  return {
    chat_id: null, source: 'WhatsAppWeb', line_phone: LINE_PHONE, wa_chat_id: null, kind: null, name: null, contact_phone: null,
    contact_phone_source: null, order: null, folder: null, export_status: 'saved', error_code: null, message_count: null,
    system_event_count: null, omitted_media_count: null, first_message_at: null, last_message_at: null, run_id: RUN_META.runId,
    exported_at: null, time_zone: TIME_ZONE, parse_error: null, extension_version: RUN_META.extensionVersion, ...fields
  };
}

/** Objetos de um arquivo JSON Lines, conferindo que é UTF-8 sem BOM, com LF no fim de cada linha, inclusive a última */
function readJsonLines(bytes) {
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'JSON Lines com BOM');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text === '') return [];
  assert.ok(text.endsWith('\n'), 'a última linha não termina em \\n');
  assert.equal(text.includes('\r'), false, 'linha terminada em CRLF');
  return text.slice(0, -1).split('\n').map((line) => JSON.parse(line));
}

/** Conteúdo descompactado de uma entrada do ZIP, lida com readRawZip */
async function entryText(entry) {
  return decoder.decode(await ZipReader.decompressEntry(entry));
}

/** ZIP com as entradas comprimidas quando o deflate reduz, como um ZIP nativo que já viesse com o texto comprimido */
async function compressedExportZip(files) {
  const blob = await ZipBuilder.buildArchive(files.map(([path, content]) => ({ path, content })));
  return new Uint8Array(await blob.arrayBuffer());
}

/** chat.md como o WhatsApp grava: o cabeçalho com o nome ou o telefone, a data de exportação e as mensagens */
function chatMarkdown(name, body = '') {
  return `# Histórico de conversas do WhatsApp: ${name}\n\nData de exportação: 06/10/2026\n${body}`;
}

const META_SERVICE = 'Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.';
const QUESTION = 'Oi, tudo bem? Pode me mandar o orçamento?';
const ANA_TEXT = [
  'As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.',
  `[8/1/26, 9:00:05 AM] - ${META_SERVICE}`,
  '[8/1/26, 9:00:05 AM] Ana Souza: Bom dia!',
  '[8/1/26, 9:01:10 AM] Você: Bom dia, Ana. Segue o orçamento:',
  '- item 1',
  '',
  '[8/1/26, 9:02:00 AM] Você: <documento omitido> orcamento.pdf',
  ''
].join('\n');
// Duas mensagens idênticas no mesmo segundo
const UNSAVED_TEXT = [
  `[8/2/26, 10:00:00 AM] +55 11 92222-2222: ${QUESTION}`,
  `[8/2/26, 10:00:00 AM] +55 11 92222-2222: ${QUESTION}`,
  '[8/2/26, 10:05:00 AM] Você: Tudo, e você? Mando já o orçamento.',
  ''
].join('\n');
const GROUP_TEXT = [
  '[8/3/26, 8:00:00 PM] - Ana Souza criou o grupo "Família"',
  '[8/3/26, 8:01:00 PM] Ana Souza: Oi, gente',
  '[8/3/26, 8:02:00 PM] +55 11 93333-3333: <imagem ocultada>',
  '[8/3/26, 8:03:00 PM] Você: [Encaminhada] Olá! <Mensagem editada>',
  ''
].join('\n');
const SAMPLE_KEYS = ['000000', '000001', '000002', '000007'];

/**
 * Grava no staging trocado as conversas com arquivo de uma execução de 8 conversas e devolve as linhas do índice dela,
 * uma por conversa da fila: contato salvo (telefone do painel), contato não salvo (telefone do título, com o texto já
 * comprimido no ZIP nativo), grupo (arquivo que não é ZIP), pasta Downloads, não exportável, falha, não processada e
 * exportação vazia
 */
async function stageSampleRun() {
  await stage('000000', 'Ana Souza', await storedExportZip([['_chat.txt', ANA_TEXT], ['chat.md', chatMarkdown('Ana Souza')]]), 'conversa.zip');
  const unsavedZip = await compressedExportZip([['_chat.txt', UNSAVED_TEXT], ['chat.md', chatMarkdown('+55 11 92222-2222')]]);
  assert.equal((await readRawZip(unsavedZip)).get('_chat.txt').method, 8);
  await stage('000001', '+55 11 92222-2222', unsavedZip, 'conversa.zip');
  await stage('000002', 'Família', GROUP_TEXT, 'conversa.txt');
  await stage('000007', 'Hugo', await storedExportZip([['_chat.txt', '\n'], ['chat.md', chatMarkdown('Hugo')]]), 'conversa.zip');
  return [
    indexRow({
      chatId: '000000', order: 1, title: 'Ana Souza', kind: 'chat', contactPhone: '5511911111111', contactPhoneSource: 'contact_info',
      exportedAt: '2026-10-06T21:20:31.123Z'
    }),
    indexRow({
      chatId: '000001', order: 2, title: '+55 11 92222-2222', kind: 'chat', contactPhone: '5511922222222', contactPhoneSource: 'title',
      exportedAt: '2026-10-06T21:21:00.456Z'
    }),
    indexRow({ chatId: '000002', order: 3, title: 'Família', kind: 'group', exportedAt: '2026-10-06T21:22:00.000Z' }),
    indexRow({ order: 4, title: 'Davi', status: 'NA PASTA DOWNLOADS', exportStatus: 'saved_to_disk', kind: 'chat', exportedAt: '2026-10-06T21:23:00.000Z' }),
    indexRow({
      order: 5, title: 'Eva', status: 'NÃO EXPORTÁVEL', exportStatus: 'not_exportable', code: 'EXPORT_OPTION_UNAVAILABLE', kind: 'chat',
      contactPhone: '5511955555555', contactPhoneSource: 'contact_info'
    }),
    indexRow({ order: 6, title: 'Fabi', status: 'FALHA', exportStatus: 'failed', code: 'TIMEOUT', attempts: 2 }),
    indexRow({ order: 7, title: 'Gil', status: 'NÃO PROCESSADA', exportStatus: 'not_processed', attempts: null }),
    indexRow({
      chatId: '000007', order: 8, title: 'Hugo', status: 'OK – VAZIA', exportStatus: 'empty', kind: 'chat', contactPhone: '5511988888888',
      contactPhoneSource: 'contact_info', exportedAt: '2026-10-06T21:24:00.000Z'
    })
  ];
}

test('JSON no ZIP: _conversas.jsonl com uma conversa por linha do índice, inclusive as sem arquivo, e _mensagens.jsonl só com as das conversas com arquivo, na ordem da fila e do seq, com as datas em UTC', async () => {
  staging = stubStaging();
  const indexRows = await stageSampleRun();

  const { blob, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: SAMPLE_KEYS, indexRows, runMeta: RUN_META });

  assert.deepEqual(check, { expected: 4, packed: 4, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: [], jsonUnparsed: [] });
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], [
    'Ana Souza/conversa.txt', 'Ana Souza/chat.md', '+55 11 92222-2222/conversa.txt', '+55 11 92222-2222/chat.md', 'Família/conversa.txt',
    'Hugo/conversa.txt', 'Hugo/chat.md', REPORT_FILENAME, INDEX_FILENAME, CHATS_JSON_FILENAME, MESSAGES_JSON_FILENAME
  ]);
  // Texto comprimido, como o resto do texto do ZIP
  const raw = await readRawZip(blob);
  assert.deepEqual([raw.get(CHATS_JSON_FILENAME).method, raw.get(MESSAGES_JSON_FILENAME).method], [8, 8]);

  const anaId = `${LINE_PHONE}_5511911111111`;
  const unsavedId = `${LINE_PHONE}_5511922222222`;
  const groupId = titleChatId('Família');
  const noFile = { folder: null, message_count: null, system_event_count: null, omitted_media_count: null };
  const expectedChats = [
    expectedChat({
      chat_id: anaId, wa_chat_id: '5511911111111', kind: 'chat', name: 'Ana Souza', contact_phone: '5511911111111',
      contact_phone_source: 'contact_info', order: 1, folder: 'Ana Souza', message_count: 3, system_event_count: 1, omitted_media_count: 1,
      first_message_at: '2026-08-01T12:00:05Z', last_message_at: '2026-08-01T12:02:00Z', exported_at: '2026-10-06T21:20:31Z'
    }),
    expectedChat({
      chat_id: unsavedId, wa_chat_id: '5511922222222', kind: 'chat', name: '+55 11 92222-2222', contact_phone: '5511922222222',
      contact_phone_source: 'title', order: 2, folder: '+55 11 92222-2222', message_count: 3, system_event_count: 0, omitted_media_count: 0,
      first_message_at: '2026-08-02T13:00:00Z', last_message_at: '2026-08-02T13:05:00Z', exported_at: '2026-10-06T21:21:00Z'
    }),
    expectedChat({
      chat_id: groupId, kind: 'group', name: 'Família', order: 3, folder: 'Família', message_count: 3, system_event_count: 1,
      omitted_media_count: 1, first_message_at: '2026-08-03T23:00:00Z', last_message_at: '2026-08-03T23:03:00Z', exported_at: '2026-10-06T21:22:00Z'
    }),
    expectedChat({
      chat_id: titleChatId('Davi'), kind: 'chat', name: 'Davi', order: 4, ...noFile, export_status: 'saved_to_disk', exported_at: '2026-10-06T21:23:00Z'
    }),
    expectedChat({
      chat_id: `${LINE_PHONE}_5511955555555`, wa_chat_id: '5511955555555', kind: 'chat', name: 'Eva', contact_phone: '5511955555555',
      contact_phone_source: 'contact_info', order: 5, ...noFile, export_status: 'not_exportable', error_code: 'EXPORT_OPTION_UNAVAILABLE'
    }),
    expectedChat({ chat_id: titleChatId('Fabi'), name: 'Fabi', order: 6, ...noFile, export_status: 'failed', error_code: 'TIMEOUT' }),
    expectedChat({ chat_id: titleChatId('Gil'), name: 'Gil', order: 7, ...noFile, export_status: 'not_processed' }),
    // Exportação vazia: está no ZIP, sem mensagens, e não é erro
    expectedChat({
      chat_id: `${LINE_PHONE}_5511988888888`, wa_chat_id: '5511988888888', kind: 'chat', name: 'Hugo', contact_phone: '5511988888888',
      contact_phone_source: 'contact_info', order: 8, folder: 'Hugo', export_status: 'empty', message_count: 0, system_event_count: 0,
      omitted_media_count: 0, exported_at: '2026-10-06T21:24:00Z'
    })
  ];
  assert.deepEqual(readJsonLines(files.get(CHATS_JSON_FILENAME)), expectedChats);
  // Um objeto por linha, com os campos na ordem do contrato
  assert.equal(decoder.decode(files.get(CHATS_JSON_FILENAME)), expectedChats.map((chat) => `${JSON.stringify(chat)}\n`).join(''));

  // Só das conversas com arquivo no ZIP, na ordem da fila e do seq; "Você" leva a linha, a conversa individual o telefone
  // do contato, e o grupo o do remetente quando o nome dele é um telefone
  const messages = readJsonLines(files.get(MESSAGES_JSON_FILENAME));
  assert.deepEqual(
    messages.map(({ chat_id, seq, timestamp, sender_name, sender_phone, is_out, msg_type, text }) => (
      [chat_id, seq, timestamp, sender_name, sender_phone, is_out, msg_type, text]
    )),
    [
      [anaId, 1, '2026-08-01T12:00:05Z', null, null, null, 'system', META_SERVICE],
      [anaId, 2, '2026-08-01T12:00:05Z', 'Ana Souza', '5511911111111', false, 'chat', 'Bom dia!'],
      [anaId, 3, '2026-08-01T12:01:10Z', 'Você', LINE_PHONE, true, 'chat', 'Bom dia, Ana. Segue o orçamento:\n- item 1'],
      [anaId, 4, '2026-08-01T12:02:00Z', 'Você', LINE_PHONE, true, 'document', '<documento omitido> orcamento.pdf'],
      [unsavedId, 1, '2026-08-02T13:00:00Z', '+55 11 92222-2222', '5511922222222', false, 'chat', QUESTION],
      [unsavedId, 2, '2026-08-02T13:00:00Z', '+55 11 92222-2222', '5511922222222', false, 'chat', QUESTION],
      [unsavedId, 3, '2026-08-02T13:05:00Z', 'Você', LINE_PHONE, true, 'chat', 'Tudo, e você? Mando já o orçamento.'],
      [groupId, 1, '2026-08-03T23:00:00Z', null, null, null, 'system', 'Ana Souza criou o grupo "Família"'],
      [groupId, 2, '2026-08-03T23:01:00Z', 'Ana Souza', null, false, 'chat', 'Oi, gente'],
      [groupId, 3, '2026-08-03T23:02:00Z', '+55 11 93333-3333', '5511933333333', false, 'image', '<imagem ocultada>'],
      [groupId, 4, '2026-08-03T23:03:00Z', 'Você', LINE_PHONE, true, 'chat', 'Olá!']
    ]
  );
  const lastMessage = {
    message_id: expectedMessageId(groupId, '8/3/26, 8:03:00 PM', 'Você', 'Olá!', 0),
    chat_id: groupId,
    line_phone: LINE_PHONE,
    seq: 4,
    timestamp: '2026-08-03T23:03:00Z',
    timestamp_raw: '8/3/26, 8:03:00 PM',
    sender_name: 'Você',
    sender_phone: LINE_PHONE,
    is_out: true,
    msg_type: 'chat',
    text: 'Olá!',
    forwarded: true,
    file_name: null,
    edited: true
  };
  assert.equal(decoder.decode(files.get(MESSAGES_JSON_FILENAME)).split('\n').at(-2), JSON.stringify(lastMessage));

  assert.equal(decoder.decode(files.get(REPORT_FILENAME)), [
    REPORT,
    'Conferência do ZIP: 4 conversa(s) esperada(s), 4 empacotada(s); sem divergência.',
    'JSON: 8 conversa(s) em _conversas.jsonl; 9 mensagem(ns) e 2 evento(s) em _mensagens.jsonl.',
    ''
  ].join('\n'));
  // O _indice.csv continua com as mesmas colunas
  const csvLines = new TextDecoder('utf-8', { ignoreBOM: true }).decode(files.get(INDEX_FILENAME)).split('\r\n');
  assert.equal(csvLines[0].replace('\uFEFF', ''), 'Ordem;Título;Pasta;Status;Código;Tentativas;Bytes;Mensagens;Eventos de sistema;Anexos omitidos;Primeira data;Última data;Duração (s);Abertura');
  assert.equal(csvLines.length, 1 + indexRows.length + 1);
  assert.ok(csvLines.slice(1, -1).every((line) => line.split(';').length === 14), csvLines.join('\n'));
});

test('JSON no ZIP: chat_id e message_id iguais em dois empacotamentos do mesmo staging e únicos no ZIP; duas mensagens idênticas no mesmo segundo com ids diferentes', async () => {
  staging = stubStaging();
  const indexRows = await stageSampleRun();
  const pack = async () => readZip((await ArchivePackager.build({ report: REPORT, expectedKeys: SAMPLE_KEYS, indexRows, runMeta: RUN_META })).blob);

  const first = await pack();
  const second = await pack();

  // Os dois arquivos saem iguais, byte a byte
  assert.deepEqual(second.get(CHATS_JSON_FILENAME), first.get(CHATS_JSON_FILENAME));
  assert.deepEqual(second.get(MESSAGES_JSON_FILENAME), first.get(MESSAGES_JSON_FILENAME));
  const chatIds = readJsonLines(first.get(CHATS_JSON_FILENAME)).map((chat) => chat.chat_id);
  const messages = readJsonLines(first.get(MESSAGES_JSON_FILENAME));
  const messageIds = messages.map((message) => message.message_id);
  assert.equal(new Set(chatIds).size, chatIds.length);
  assert.equal(new Set(messageIds).size, messageIds.length);
  assert.ok(messageIds.every((id) => /^[0-9a-f]{32}$/.test(id)), messageIds.join(', '));
  // Toda mensagem aponta para uma conversa do _conversas.jsonl
  assert.ok(messages.every((message) => chatIds.includes(message.chat_id)));

  // As duas perguntas idênticas do mesmo segundo diferem só pela ocorrência
  const unsavedId = `${LINE_PHONE}_5511922222222`;
  const repeated = messages.filter((message) => message.chat_id === unsavedId && message.text === QUESTION);
  assert.deepEqual(repeated.map((message) => message.message_id), [
    expectedMessageId(unsavedId, '8/2/26, 10:00:00 AM', '+55 11 92222-2222', QUESTION, 0),
    expectedMessageId(unsavedId, '8/2/26, 10:00:00 AM', '+55 11 92222-2222', QUESTION, 1)
  ]);
});

test('JSON no ZIP: conversa sem _chat.txt, com formato não reconhecido, com o ZIP ou o texto ilegível fica com o parse_error e sem mensagens, na Conferência do ZIP e em check; as outras saem inteiras, e o CRC divergente não impede ler o texto', async () => {
  staging = stubStaging();
  await stage('000000', 'Ana', '[8/1/26, 9:00:00 AM] Ana: oi\n', 'conversa.txt');
  await stage('000001', 'Bia', await storedExportZip([['chat.md', chatMarkdown('Bia')]]), 'conversa.zip');
  await stage('000002', 'Caio', await storedExportZip([
    ['_chat.txt', 'texto sem nenhuma linha de mensagem reconhecível\n'], ['chat.md', chatMarkdown('Caio')]
  ]), 'conversa.zip');
  // Download cortado no meio do _chat.txt comprimido
  const fullZip = await nativeExportZip('[8/1/26, 9:03:00 AM] Davi: Bom dia!\n'.repeat(40));
  const [daviEntry] = await ZipReader.readRawEntries(fullZip);
  const dataStart = 30 + '_chat.txt'.length;
  const truncatedZip = fullZip.slice(0, dataStart + 10);
  await stage('000003', 'Davi', truncatedZip, 'Conversa do WhatsApp com Davi.zip');
  // Texto que chegou com o CRC errado: vai para o ZIP como estava, e é lido assim mesmo
  const evaText = encoder.encode('[8/1/26, 9:04:00 AM] Eva: mensagem que chegou com o CRC errado\n');
  const evaWriter = new ZipWriter();
  evaWriter.addRawEntry({
    path: '_chat.txt', method: 0, crc32: (calculateCrc32(evaText) ^ 0x1) >>> 0, compressedSize: evaText.length, uncompressedSize: evaText.length, data: evaText
  });
  await stage('000004', 'Eva', new Uint8Array(await evaWriter.finish().arrayBuffer()), 'conversa.zip');
  // Texto comprimido com dados que o deflate não lê
  const fabiWriter = new ZipWriter();
  fabiWriter.addRawEntry({ path: '_chat.txt', method: 8, crc32: 0, compressedSize: 4, uncompressedSize: 64, data: new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]) });
  await stage('000005', 'Fabi', new Uint8Array(await fabiWriter.finish().arrayBuffer()), 'conversa.zip');
  const titles = ['Ana', 'Bia', 'Caio', 'Davi', 'Eva', 'Fabi'];
  const keys = titles.map((_, index) => `00000${index}`);
  const phoneOf = (index) => `551191000000${index}`;
  const indexRows = titles.map((title, index) => indexRow({
    chatId: keys[index], order: index + 1, title, kind: 'chat', contactPhone: phoneOf(index), contactPhoneSource: 'contact_info'
  }));

  const { blob, chatCount, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: keys, indexRows, runMeta: RUN_META });

  assert.equal(chatCount, 6);
  // A lista do JSON é completa, com o ZIP ilegível também (000003); o aviso do popup não conta essa conversa duas vezes
  // (describeCheckDivergence, no orquestrador)
  assert.deepEqual(check, {
    expected: 6, packed: 6, missingKeys: [], unreadable: ['000003'], unexpected: [], crcMismatch: ['000004'],
    jsonUnparsed: ['000001', '000002', '000003', '000005']
  });
  // Toda conversa continua no ZIP, como estava
  const raw = await readRawZip(blob);
  assert.deepEqual([...raw.keys()], [
    'Ana/conversa.txt', 'Bia/chat.md', 'Caio/conversa.txt', 'Caio/chat.md', 'Davi/Conversa do WhatsApp com Davi.zip', 'Eva/conversa.txt',
    'Fabi/conversa.txt', REPORT_FILENAME, INDEX_FILENAME, CHATS_JSON_FILENAME, MESSAGES_JSON_FILENAME
  ]);

  const chats = readJsonLines(await ZipReader.decompressEntry(raw.get(CHATS_JSON_FILENAME)));
  const truncated = `A entrada "_chat.txt" está truncada: declara ${daviEntry.compressedSize} byte(s) de dados a partir do byte ${dataStart}, ` +
    `mas o ZIP tem ${truncatedZip.length} byte(s).`;
  const fabiError = chats[5].parse_error;
  assert.match(fabiError, /^O texto da conversa \(_chat\.txt\) está ilegível no ZIP exportado \(.+\)\.$/);
  assert.deepEqual(chats.map(({ chat_id, folder, message_count, system_event_count, first_message_at, parse_error }) => (
    [chat_id, folder, message_count, system_event_count, first_message_at, parse_error]
  )), [
    [`${LINE_PHONE}_${phoneOf(0)}`, 'Ana', 1, 0, '2026-08-01T12:00:00Z', null],
    [`${LINE_PHONE}_${phoneOf(1)}`, 'Bia', null, null, null, MISSING_CHAT_TEXT],
    [`${LINE_PHONE}_${phoneOf(2)}`, 'Caio', null, null, null, UNRECOGNIZED_FORMAT],
    [`${LINE_PHONE}_${phoneOf(3)}`, 'Davi', null, null, null, `O ZIP exportado está ilegível (${truncated}).`],
    [`${LINE_PHONE}_${phoneOf(4)}`, 'Eva', 1, 0, '2026-08-01T12:04:00Z', null],
    [`${LINE_PHONE}_${phoneOf(5)}`, 'Fabi', null, null, null, fabiError]
  ]);
  const messages = readJsonLines(await ZipReader.decompressEntry(raw.get(MESSAGES_JSON_FILENAME)));
  assert.deepEqual(messages.map(({ chat_id, seq, text }) => [chat_id, seq, text]), [
    [`${LINE_PHONE}_${phoneOf(0)}`, 1, 'oi'],
    [`${LINE_PHONE}_${phoneOf(4)}`, 1, 'mensagem que chegou com o CRC errado']
  ]);

  const unparsedLine = (position, key, title, reason) => (
    `- Texto da conversa não interpretado, sem as mensagens no _mensagens.jsonl: nº ${position} (${key}) "${title}". Motivo: ${reason}`
  );
  assert.equal(await entryText(raw.get(REPORT_FILENAME)), [
    REPORT,
    'Conferência do ZIP: 6 conversa(s) esperada(s), 6 empacotada(s).',
    `- ZIP nativo ilegível, gravado como o arquivo original na pasta da conversa: nº 4 (000003) "Davi". Motivo: ${truncated}`,
    '- Texto com CRC que não confere com o conteúdo, copiado do ZIP nativo como estava, sem compressão (pode ter chegado corrompido): ' +
      'nº 5 (000004) "Eva". Arquivo(s) no ZIP: "Eva/conversa.txt".',
    'JSON: 6 conversa(s) em _conversas.jsonl; 2 mensagem(ns) e 0 evento(s) em _mensagens.jsonl.',
    unparsedLine(2, '000001', 'Bia', MISSING_CHAT_TEXT),
    unparsedLine(3, '000002', 'Caio', UNRECOGNIZED_FORMAT),
    unparsedLine(4, '000003', 'Davi', `O ZIP exportado está ilegível (${truncated}).`),
    unparsedLine(6, '000005', 'Fabi', fabiError),
    ''
  ].join('\n'));
});

test('JSON no ZIP: erro inesperado ao montar o JSON de uma conversa não derruba o ZIP nem as outras; ela fica com o parse_error, sem mensagens, na Conferência do ZIP e em check, e o erro vai para o log', async () => {
  staging = stubStaging();
  // A falha simulada é no hash das mensagens de Bia; o chat_id dela sai do telefone, sem hash
  const brokenText = 'mensagem que quebra o hash';
  const biaText = `[8/1/26, 9:01:00 AM] Bia: ${brokenText}\n`;
  await stage('000000', 'Ana', '[8/1/26, 9:00:00 AM] Ana: oi\n', 'conversa.txt');
  await stage('000001', 'Bia', await storedExportZip([['_chat.txt', biaText], ['chat.md', chatMarkdown('Bia')]]), 'conversa.zip');
  await stage('000002', 'Caio', '[8/1/26, 9:02:00 AM] Caio: tudo bem?\n[8/1/26, 9:03:00 AM] - [Ligação]\n', 'conversa.txt');
  const titles = ['Ana', 'Bia', 'Caio'];
  const keys = titles.map((_, index) => `00000${index}`);
  const phoneOf = (index) => `551192000000${index}`;
  const indexRows = titles.map((title, index) => indexRow({
    chatId: keys[index], order: index + 1, title, kind: 'chat', contactPhone: phoneOf(index), contactPhoneSource: 'contact_info'
  }));
  const realDigest = crypto.subtle.digest;
  crypto.subtle.digest = async function digestFailingOnBrokenText(algorithm, data) {
    if (decoder.decode(data).includes(brokenText)) throw new Error('falha simulada no hash');
    return realDigest.call(this, algorithm, data);
  };
  const warnings = [];
  const silencedWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  let built;
  try {
    built = await ArchivePackager.build({ report: REPORT, expectedKeys: keys, indexRows, runMeta: RUN_META });
  } finally {
    delete crypto.subtle.digest;
    console.warn = silencedWarn;
  }

  const { blob, chatCount, check } = built;
  assert.equal(chatCount, 3);
  assert.deepEqual(check, { expected: 3, packed: 3, missingKeys: [], unreadable: [], unexpected: [], crcMismatch: [], jsonUnparsed: ['000001'] });
  // O arquivo de Bia está no ZIP como chegou
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], [
    'Ana/conversa.txt', 'Bia/conversa.txt', 'Bia/chat.md', 'Caio/conversa.txt', REPORT_FILENAME, INDEX_FILENAME, CHATS_JSON_FILENAME, MESSAGES_JSON_FILENAME
  ]);
  assert.equal(decoder.decode(files.get('Bia/conversa.txt')), biaText);

  const internalError = 'erro interno ao montar o JSON: falha simulada no hash';
  const chats = readJsonLines(files.get(CHATS_JSON_FILENAME));
  assert.deepEqual(chats.map(({ chat_id, folder, message_count, system_event_count, parse_error }) => (
    [chat_id, folder, message_count, system_event_count, parse_error]
  )), [
    [`${LINE_PHONE}_${phoneOf(0)}`, 'Ana', 1, 0, null],
    [`${LINE_PHONE}_${phoneOf(1)}`, 'Bia', null, null, internalError],
    [`${LINE_PHONE}_${phoneOf(2)}`, 'Caio', 1, 1, null]
  ]);
  // A conversa montada depois do erro também leva a versão da extensão, por último
  assert.deepEqual(Object.keys(chats[1]), Object.keys(chats[0]));
  assert.deepEqual(chats.map((chat) => chat.extension_version), ['1.0.0', '1.0.0', '1.0.0']);
  assert.deepEqual(readJsonLines(files.get(MESSAGES_JSON_FILENAME)).map(({ chat_id, seq, text }) => [chat_id, seq, text]), [
    [`${LINE_PHONE}_${phoneOf(0)}`, 1, 'oi'],
    [`${LINE_PHONE}_${phoneOf(2)}`, 1, 'tudo bem?'],
    [`${LINE_PHONE}_${phoneOf(2)}`, 2, '[Ligação]']
  ]);
  assert.equal(decoder.decode(files.get(REPORT_FILENAME)), [
    REPORT,
    'Conferência do ZIP: 3 conversa(s) esperada(s), 3 empacotada(s).',
    'JSON: 3 conversa(s) em _conversas.jsonl; 2 mensagem(ns) e 1 evento(s) em _mensagens.jsonl.',
    `- Texto da conversa não interpretado, sem as mensagens no _mensagens.jsonl: nº 2 (000001) "Bia". Motivo: ${internalError}`,
    ''
  ].join('\n'));
  // O erro vai para o log com o objeto original, não só a mensagem
  const jsonWarnings = warnings.filter(([message]) => String(message).includes('erro interno ao montar o JSON da conversa'));
  assert.equal(jsonWarnings.length, 1);
  assert.ok(String(jsonWarnings[0][0]).includes('"Bia"'));
  assert.equal(jsonWarnings[0][1]?.message, 'falha simulada no hash');
});

test('JSON no ZIP: conversa individual sem o telefone do título nem do painel recebe o do texto exportado (export), pelo cabeçalho do chat.md ou pelo remetente', async () => {
  staging = stubStaging();
  // O título e o remetente são o nome, e o cabeçalho do chat.md (comprimido no ZIP nativo) traz o telefone
  const shopZip = await compressedExportZip([
    ['_chat.txt', '[8/1/26, 9:00:00 AM] Loja Fictícia: Bom dia\n[8/1/26, 9:01:00 AM] Você: oi\n'],
    ['chat.md', chatMarkdown('+55 11 94444-4444', '\n## 01/08/2026\n\n[09:00] **Loja Fictícia:** Bom dia\n'.repeat(5))]
  ]);
  assert.equal((await readRawZip(shopZip)).get('chat.md').method, 8);
  await stage('000000', 'Loja Fictícia', shopZip, 'conversa.zip');
  // O cabeçalho é o nome, e o único remetente além de "Você" é o telefone
  await stage('000001', 'Oficina Central', await storedExportZip([
    ['_chat.txt', '[8/1/26, 9:00:00 AM] +55 11 95555-5555: Bom dia\n[8/1/26, 9:01:00 AM] Você: oi\n'],
    ['chat.md', chatMarkdown('Oficina Central')]
  ]), 'conversa.zip');
  // Painel que não deu o número
  const noPhone = { kind: 'chat', contactPhone: null, contactPhoneSource: null };
  const indexRows = [
    indexRow({ chatId: '000000', order: 1, title: 'Loja Fictícia', ...noPhone }),
    indexRow({ chatId: '000001', order: 2, title: 'Oficina Central', ...noPhone })
  ];

  const { blob } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'], indexRows, runMeta: RUN_META });

  const files = await readZip(blob);
  const chats = readJsonLines(files.get(CHATS_JSON_FILENAME));
  assert.deepEqual(chats.map(({ chat_id, wa_chat_id, contact_phone, contact_phone_source }) => [chat_id, wa_chat_id, contact_phone, contact_phone_source]), [
    [`${LINE_PHONE}_5511944444444`, '5511944444444', '5511944444444', 'export'],
    [`${LINE_PHONE}_5511955555555`, '5511955555555', '5511955555555', 'export']
  ]);
  // O remetente que não é "Você" é o contato
  const messages = readJsonLines(files.get(MESSAGES_JSON_FILENAME));
  assert.deepEqual(messages.map(({ chat_id, sender_name, sender_phone }) => [chat_id, sender_name, sender_phone]), [
    [`${LINE_PHONE}_5511944444444`, 'Loja Fictícia', '5511944444444'],
    [`${LINE_PHONE}_5511944444444`, 'Você', LINE_PHONE],
    [`${LINE_PHONE}_5511955555555`, '+55 11 95555-5555', '5511955555555'],
    [`${LINE_PHONE}_5511955555555`, 'Você', LINE_PHONE]
  ]);
});

test('JSON no ZIP: sem nenhuma mensagem, o _mensagens.jsonl existe e fica vazio; uma conversa chamada _conversas.jsonl ou _mensagens.jsonl, em qualquer caixa, vai para outra pasta', async () => {
  staging = stubStaging();
  await stage('000000', '_conversas.jsonl', await storedExportZip([['_chat.txt', '\n'], ['chat.md', chatMarkdown('_conversas.jsonl')]]), 'conversa.zip');
  await stage('000001', '_MENSAGENS.JSONL', '  \n', 'conversa.txt');
  const emptyExport = { status: 'OK – VAZIA', exportStatus: 'empty' };
  const indexRows = [
    indexRow({ chatId: '000000', order: 1, title: '_conversas.jsonl', ...emptyExport }),
    indexRow({ chatId: '000001', order: 2, title: '_MENSAGENS.JSONL', ...emptyExport }),
    indexRow({ order: 3, title: 'Caio', status: 'FALHA', exportStatus: 'failed', code: 'TIMEOUT' })
  ];

  const { blob, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'], indexRows, runMeta: RUN_META });

  assert.deepEqual(check.jsonUnparsed, []);
  const files = await readZip(blob);
  assert.deepEqual([...files.keys()], [
    '_conversas.jsonl_1/conversa.txt', '_conversas.jsonl_1/chat.md', '_MENSAGENS.JSONL_1/conversa.txt',
    REPORT_FILENAME, INDEX_FILENAME, CHATS_JSON_FILENAME, MESSAGES_JSON_FILENAME
  ]);
  assert.equal(files.get(MESSAGES_JSON_FILENAME).length, 0);
  assert.deepEqual(
    readJsonLines(files.get(CHATS_JSON_FILENAME)).map(({ name, folder, export_status, message_count, parse_error }) => (
      [name, folder, export_status, message_count, parse_error]
    )),
    [
      ['_conversas.jsonl', '_conversas.jsonl_1', 'empty', 0, null],
      ['_MENSAGENS.JSONL', '_MENSAGENS.JSONL_1', 'empty', 0, null],
      ['Caio', null, 'failed', null, null]
    ]
  );
  assert.equal(
    decoder.decode(files.get(REPORT_FILENAME)).split('\n').at(-2),
    'JSON: 3 conversa(s) em _conversas.jsonl; 0 mensagem(ns) e 0 evento(s) em _mensagens.jsonl.'
  );
});

// Título e texto com U+2028, U+2029 e U+0085: o JSON os aceita sem escape dentro de um texto, e o splitlines() do Python
// os trata como quebra de linha
const LINE_BREAKS_TITLE = 'Loja\u2028Fictícia';
const LINE_BREAKS_TEXT = 'primeira linha\u2028mesma mensagem\u2029parágrafo\u0085fim';

/** Grava no staging trocado uma conversa com as quebras de linha do Unicode no título e no texto e devolve a linha do índice dela */
async function stageUnicodeLineBreaksChat(key, order) {
  const text = `[8/4/26, 9:00:00 AM] Ana: ${LINE_BREAKS_TEXT}\n[8/4/26, 9:01:00 AM] Você: ok\n`;
  await stage(key, LINE_BREAKS_TITLE, await storedExportZip([['_chat.txt', text], ['chat.md', chatMarkdown(LINE_BREAKS_TITLE)]]), 'conversa.zip');
  return indexRow({
    chatId: key, order, title: LINE_BREAKS_TITLE, kind: 'chat', contactPhone: '5511977777777', contactPhoneSource: 'contact_info'
  });
}

/** Linhas pelas quebras que o str.splitlines() do Python reconhece, sem a vazia depois da última quebra */
function splitUnicodeLines(text) {
  const lines = text.split(/\r\n|[\n\r\v\f\x1C-\x1E\x85\u2028\u2029]/);
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

test('JSON no ZIP: U+2028, U+2029 e U+0085 de um texto saem escapados nos dois arquivos, uma linha por registro, e o valor lido de volta é o mesmo', async () => {
  staging = stubStaging();
  const row = await stageUnicodeLineBreaksChat('000000', 1);

  const { blob } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000'], indexRows: [row], runMeta: RUN_META });

  const files = await readZip(blob);
  const chatsText = decoder.decode(files.get(CHATS_JSON_FILENAME));
  const messagesText = decoder.decode(files.get(MESSAGES_JSON_FILENAME));
  for (const text of [chatsText, messagesText]) {
    assert.equal(/[\u2028\u2029\u0085]/.test(text), false, text);
  }
  assert.ok(chatsText.includes('"name":"Loja\\u2028Fictícia"'), chatsText);
  assert.ok(chatsText.includes('"folder":"Loja\\u2028Fictícia"'), chatsText);
  assert.ok(
    messagesText.includes('"text":"primeira linha\\u2028mesma mensagem\\u2029parágrafo\\u0085fim"'),
    messagesText
  );
  assert.equal(splitUnicodeLines(chatsText).length, 1);
  assert.equal(splitUnicodeLines(messagesText).length, 2);

  // Lido de volta, o valor é o original; o message_id é o da receita, calculado sobre o texto sem o escape
  const [chat] = readJsonLines(files.get(CHATS_JSON_FILENAME));
  assert.deepEqual([chat.chat_id, chat.name, chat.folder], [`${LINE_PHONE}_5511977777777`, LINE_BREAKS_TITLE, LINE_BREAKS_TITLE]);
  const messages = readJsonLines(files.get(MESSAGES_JSON_FILENAME));
  assert.deepEqual(messages.map(({ text }) => text), [LINE_BREAKS_TEXT, 'ok']);
  assert.equal(messages[0].message_id, expectedMessageId(chat.chat_id, '8/4/26, 9:00:00 AM', 'Ana', LINE_BREAKS_TEXT, 0));
});

test('JSON no ZIP: sem os dados da execução ou sem as linhas do índice, o ZIP sai sem o JSON; com os dados sem o id da execução, o empacotamento falha', async () => {
  staging = stubStaging();
  const indexRows = await stageSampleRun();

  const withoutRunMeta = await ArchivePackager.build({ report: REPORT, expectedKeys: SAMPLE_KEYS, indexRows });
  const withoutIndexRows = await ArchivePackager.build({ report: REPORT, expectedKeys: SAMPLE_KEYS, runMeta: RUN_META });

  for (const { blob, check } of [withoutRunMeta, withoutIndexRows]) {
    const names = [...(await readZip(blob)).keys()];
    assert.equal(names.includes(CHATS_JSON_FILENAME) || names.includes(MESSAGES_JSON_FILENAME), false, names.join(', '));
    assert.equal('jsonUnparsed' in check, false);
  }
  await assert.rejects(
    ArchivePackager.build({ report: REPORT, expectedKeys: SAMPLE_KEYS, indexRows, runMeta: { ...RUN_META, runId: '' } }),
    { message: 'O empacotamento recebeu os dados da execução sem o id dela (runMeta.runId).' }
  );
});

function hasPython() {
  try { execFileSync('python3', ['--version']); return true; } catch { return false; }
}

/**
 * Confere o JSON do ZIP com leitores independentes (zipfile e json do Python): o ZIP íntegro, UTF-8 sem BOM, cada linha
 * um objeto JSON (sem linha em branco e sem NaN/Infinity), LF no fim, ids únicos, toda mensagem ligada a uma conversa e
 * uma linha por registro também para o splitlines(), que quebra a linha em mais caracteres que o LF
 */
async function inspectJsonWithPython(blob) {
  const dir = mkdtempSync(join(tmpdir(), 'zip-json-test-'));
  try {
    const file = join(dir, 'archive.zip');
    writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    const script = String.raw`
import json, sys, zipfile

def reject_constant(name):
    raise ValueError("constante fora do JSON: " + name)

def read_objects(z, name):
    data = z.read(name)
    text = data.decode("utf-8")
    lines = text.split("\n")
    if lines[-1] != "":
        raise ValueError(name + ": a última linha não termina em LF")
    objects = []
    for line in lines[:-1]:
        value = json.loads(line, parse_constant=reject_constant)
        if not isinstance(value, dict):
            raise ValueError(name + ": linha que não é um objeto JSON")
        objects.append(value)
    return {
        "bom": data.startswith(b"\xef\xbb\xbf"),
        "crlf": b"\r" in data,
        "objects": objects,
        "split_lines_match": len(text.splitlines()) == len(objects)
    }

with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    chats = read_objects(z, "_conversas.jsonl")
    messages = read_objects(z, "_mensagens.jsonl")
    chat_ids = [chat["chat_id"] for chat in chats["objects"]]
    message_ids = [message["message_id"] for message in messages["objects"]]
    print(json.dumps({
        "bad": bad,
        "chats": len(chat_ids),
        "messages": len(message_ids),
        "unique_chat_ids": len(set(chat_ids)) == len(chat_ids),
        "unique_message_ids": len(set(message_ids)) == len(message_ids),
        "orphan_messages": [message["message_id"] for message in messages["objects"] if message["chat_id"] not in set(chat_ids)],
        "bom": chats["bom"] or messages["bom"],
        "crlf": chats["crlf"] or messages["crlf"],
        "split_lines_match": chats["split_lines_match"] and messages["split_lines_match"]
    }))
`;
    return JSON.parse(execFileSync('python3', ['-I', '-c', script, file]).toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('JSON no ZIP: validação externa (Python zipfile e json), cada item é um objeto JSON válido, os ids são únicos e o splitlines() dá uma linha por registro, mesmo com U+2028, U+2029 e U+0085 no texto', { skip: !hasPython() }, async () => {
  staging = stubStaging();
  const indexRows = [...await stageSampleRun(), await stageUnicodeLineBreaksChat('000008', 9)];

  const { blob } = await ArchivePackager.build({ report: REPORT, expectedKeys: [...SAMPLE_KEYS, '000008'], indexRows, runMeta: RUN_META });

  assert.deepEqual(await inspectJsonWithPython(blob), {
    bad: null,
    chats: 9,
    messages: 13,
    unique_chat_ids: true,
    unique_message_ids: true,
    orphan_messages: [],
    bom: false,
    crlf: false,
    split_lines_match: true
  });
});
