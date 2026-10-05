import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ArchivePackager, REPORT_FILENAME } from '../shared/archive/archive-packager.js';
import { ZipBuilder } from '../shared/archive/zip-builder.js';
import { ZipReader } from '../shared/archive/zip-reader.js';
import { StagingRepository } from '../shared/storage/staging-repository.js';
import { stubStaging } from './helpers/fake-chrome.js';

// O staging (IndexedDB, que não existe no Node) é trocado por um Map por chatId, e o ZIP montado é lido
// de volta com o ZipReader. Conversas fictícias.

const decoder = new TextDecoder();
const REPORT = 'Relatório de extração - WhatsApp Web Extractor\n';

let staging = null;
const originalConsole = { log: console.log, warn: console.warn };

before(() => {
  // O packager avisa no log cada ZIP nativo ilegível, e o ZipWriter registra cada ZIP montado
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

/** ZIP como o que o WhatsApp Web exporta: o texto em _chat.txt e um chat.md ao lado */
async function nativeExportZip(chatText) {
  const blob = await ZipBuilder.buildArchive([
    { path: '_chat.txt', content: chatText },
    { path: 'chat.md', content: '# Conversa fictícia\n' }
  ]);
  return new Uint8Array(await blob.arrayBuffer());
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

test('sem divergência: a Conferência do ZIP vem no fim do relatório e fecha a conta', async () => {
  staging = stubStaging();
  await stage('000000', 'Ana', await nativeExportZip('[01/02/2026, 09:00:00] Ana: Bom dia!\n'), 'conversa.zip');
  await stage('000001', 'Bia', '[01/02/2026, 10:00:00] Bia: oi\n', 'conversa.txt');

  const { blob, chatCount, check } = await ArchivePackager.build({ report: REPORT, expectedKeys: ['000000', '000001'] });

  assert.equal(chatCount, 2);
  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: [], unexpected: [] });
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
  assert.deepEqual(check, { expected: 4, packed: 3, missingKeys: ['000001', '000003'], unreadable: [], unexpected: ['000004'] });
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
  assert.deepEqual(check, { expected: 2, packed: 2, missingKeys: [], unreadable: ['000000'], unexpected: [] });
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
    '- O "no ZIP" do cabeçalho conta as conversas salvas durante a extração; o que de fato está no ZIP é o total empacotado acima.',
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
