import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipBuilder, ZipWriter, sanitizeZipPath, calculateCrc32 } from '../shared/archive/zip-builder.js';
import { ZipReader } from '../shared/archive/zip-reader.js';
import { buildUniqueFolderName, normalizeInnerEntryName } from '../shared/archive/archive-packager.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function hasPython() {
  try { execFileSync('python3', ['--version']); return true; } catch { return false; }
}

/** Valida o ZIP com um leitor independente (zipfile do Python): CRCs e conteúdo */
async function inspectWithPython(blob) {
  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  const file = join(dir, 'archive.zip');
  writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    bad = z.testzip()
    print(json.dumps({"bad": bad, "entries": {i.filename: {"size": i.file_size, "date": list(i.date_time), "text": z.read(i).decode("utf-8", "replace")[:200]} for i in z.infolist()}}))
`;
  return JSON.parse(execFileSync('python3', ['-c', script, file]).toString());
}

const sampleText = 'Olá, João! 🤓\n'.repeat(500);
const fakeJpeg = new Uint8Array(4096).map((_, i) => (i * 37) % 251);

test('ida e volta: ZipBuilder → ZipReader preserva conteúdo', async () => {
  const blob = await ZipBuilder.buildArchive([
    { path: 'João/conversa.txt', content: sampleText },
    { path: 'João/IMG-001.jpg', content: fakeJpeg }
  ]);
  const entries = await ZipReader.extractEntries(new Uint8Array(await blob.arrayBuffer()));
  assert.equal(entries.length, 2);
  assert.equal(decoder.decode(entries[0].content), sampleText);
  assert.deepEqual(entries[1].content, fakeJpeg);
});

test('texto é comprimido e mídia é gravada sem recompressão', async () => {
  const blob = await ZipBuilder.buildArchive([
    { path: 'a/conversa.txt', content: sampleText },
    { path: 'a/foto.jpg', content: fakeJpeg }
  ]);
  const raw = await ZipReader.readRawEntries(await blob.arrayBuffer());
  assert.equal(raw[0].method, 8);
  assert.ok(raw[0].compressedSize < raw[0].uncompressedSize);
  assert.equal(raw[1].method, 0);
});

test('validação externa (Python zipfile), incluindo datas reais', { skip: !hasPython() }, async () => {
  const blob = await ZipBuilder.buildArchive([
    { path: 'Casa Silva 🤓/conversa.txt', content: sampleText },
    { path: 'Casa Silva 🤓/foto.jpg', content: fakeJpeg }
  ]);
  const result = await inspectWithPython(blob);
  assert.equal(result.bad, null);
  assert.equal(result.entries['Casa Silva 🤓/conversa.txt'].size, encoder.encode(sampleText).length);
  assert.ok(result.entries['Casa Silva 🤓/conversa.txt'].date[0] >= 2024, 'data DOS não deve ficar em 1980');
});

test('ZIP64 forçado é lido por leitor externo', { skip: !hasPython() }, async () => {
  const blob = await ZipBuilder.buildArchive([
    { path: 'x/conversa.txt', content: sampleText },
    { path: 'x/foto.jpg', content: fakeJpeg }
  ], { forceZip64: true });
  const result = await inspectWithPython(blob);
  assert.equal(result.bad, null);
  assert.equal(Object.keys(result.entries).length, 2);
  assert.ok(result.entries['x/conversa.txt'].text.startsWith('Olá, João!'));
});

test('cópia de entradas brutas de um ZIP nativo mantém CRC e conteúdo', { skip: !hasPython() }, async () => {
  const inner = await ZipBuilder.buildArchive([
    { path: '_chat.txt', content: sampleText },
    { path: 'PTT-20260101-WA0001.opus', content: fakeJpeg }
  ]);
  const writer = new ZipWriter();
  for (const entry of await ZipReader.readRawEntries(inner)) {
    writer.addRawEntry({ ...entry, path: `Grupo/${normalizeInnerEntryName(entry.path)}` });
  }
  const result = await inspectWithPython(writer.finish());
  assert.equal(result.bad, null);
  assert.deepEqual(Object.keys(result.entries).sort(), ['Grupo/PTT-20260101-WA0001.opus', 'Grupo/conversa.txt']);
});

test('CRC32 confere com valor de referência', () => {
  assert.equal(calculateCrc32(encoder.encode('123456789')), 0xCBF43926);
});

test('sanitizeZipPath remove raiz, ".." e caracteres inválidos', () => {
  assert.equal(sanitizeZipPath('/../a:b/./c?.txt'), 'a_b/c_.txt');
  assert.equal(sanitizeZipPath('pasta\\arquivo.txt'), 'pasta/arquivo.txt');
  assert.equal(sanitizeZipPath(''), 'arquivo.txt');
});

test('nomes de pasta únicos, sem diferenciar maiúsculas, e seguros no Windows', () => {
  const used = new Set();
  assert.equal(buildUniqueFolderName('Ana', used), 'Ana');
  assert.equal(buildUniqueFolderName('ana', used), 'ana_1');
  assert.equal(buildUniqueFolderName('Pai/Mãe: casa.', used), 'Pai_Mãe_ casa');
  assert.equal(buildUniqueFolderName('', used), 'conversa');
  // Nomes de dispositivo do Windows, sozinhos ou antes de uma extensão, ganham um "_" logo depois deles: "NUL.txt" e
  // "Aux. Administrativo" também seriam o dispositivo. Os que só começam por um deles ficam
  assert.equal(buildUniqueFolderName('CON', used), 'CON_');
  assert.equal(buildUniqueFolderName('nul.txt', used), 'nul_.txt');
  assert.equal(buildUniqueFolderName('nul .txt', used), 'nul_ .txt');
  assert.equal(buildUniqueFolderName('Aux. Administrativo', used), 'Aux_. Administrativo');
  assert.equal(buildUniqueFolderName('Com1', used), 'Com1_');
  assert.equal(buildUniqueFolderName('LPT\u00B9', used), 'LPT\u00B9_');
  assert.equal(buildUniqueFolderName('aux.', used), 'aux_');
  assert.equal(buildUniqueFolderName('CONSOLE', used), 'CONSOLE');
  assert.equal(buildUniqueFolderName('CON Fiscal', used), 'CON Fiscal');
  assert.equal(buildUniqueFolderName('Com10', used), 'Com10');
  // Marcas invisíveis de direção do texto saem do nome: com elas, o nome apareceria em outra ordem no explorador de arquivos
  assert.equal(buildUniqueFolderName('\u202A+55 11 98765-4321\u202C', used), '+55 11 98765-4321');
  assert.equal(buildUniqueFolderName('foto\u202Egpj.exe', used), 'fotogpj.exe');
  // Sem as marcas, é a mesma "Ana" de antes ("Ana" e "ana_1" já usados)
  assert.equal(buildUniqueFolderName('\u2068Ana\u2069', used), 'Ana_2');
});

/** Posição no arquivo de cada entrada do diretório central (ZIP sem comentário e sem ZIP64) */
function centralEntryOffsets(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  const offsets = [];
  let cursor = view.getUint32(eocd + 16, true);
  for (let i = 0; i < view.getUint16(eocd + 10, true); i++) {
    offsets.push(cursor);
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return offsets;
}

test('entrada truncada lança erro na leitura, pelo diretório central e pelos cabeçalhos locais', async () => {
  const bytes = new Uint8Array(await (await ZipBuilder.buildArchive([
    { path: 'Grupo/conversa.txt', content: sampleText },
    { path: 'Grupo/foto.jpg', content: fakeJpeg }
  ])).arrayBuffer());
  assert.equal((await ZipReader.readRawEntries(bytes)).length, 2);
  const [, photoCentral] = centralEntryOffsets(bytes);
  const photoLocal = new DataView(bytes.buffer).getUint32(photoCentral + 42, true);
  const photoDataStart = photoLocal + 30 + encoder.encode('Grupo/foto.jpg').length;

  // Com o diretório central: ele declara para a foto mais bytes do que o arquivo tem depois dela
  const declaredTooLong = bytes.slice();
  new DataView(declaredTooLong.buffer).setUint32(photoCentral + 20, bytes.length, true);
  await assert.rejects(ZipReader.readRawEntries(declaredTooLong), {
    message: `A entrada "Grupo/foto.jpg" está truncada: declara ${bytes.length} byte(s) de dados a partir do byte ${photoDataStart}, ` +
      `mas o ZIP tem ${bytes.length} byte(s).`
  });

  // Sem o diretório central (download cortado no meio da foto): a leitura cai nos cabeçalhos locais
  const cut = bytes.slice(0, photoDataStart + 100);
  await assert.rejects(ZipReader.extractEntries(cut), {
    message: `A entrada "Grupo/foto.jpg" está truncada: declara ${fakeJpeg.length} byte(s) de dados a partir do byte ${photoDataStart}, ` +
      `mas o ZIP tem ${cut.length} byte(s).`
  });
});

test('sem o diretório central, entrada com tamanho só no diretório central (bit 3) lança erro em vez de virar conversa vazia', async () => {
  const bytes = new Uint8Array(await (await ZipBuilder.buildArchive([
    { path: '_chat.txt', content: sampleText }
  ])).arrayBuffer());
  const withDescriptorFlag = bytes.slice();
  const view = new DataView(withDescriptorFlag.buffer);
  view.setUint16(6, view.getUint16(6, true) | 0x0008, true);
  view.setUint32(18, 0, true);
  // Download cortado antes do diretório central: a leitura cai nos cabeçalhos locais
  const cut = withDescriptorFlag.slice(0, 30 + '_chat.txt'.length + 5);
  await assert.rejects(ZipReader.readRawEntries(cut), {
    message: 'A entrada "_chat.txt" guarda o tamanho só no diretório central, que não existe neste ZIP: o arquivo está truncado.'
  });
});

test('addRawEntry recusa dados de tamanho diferente do declarado, antes de gravar qualquer parte da entrada', async () => {
  const writer = new ZipWriter();
  const text = encoder.encode('oi');
  const entry = { path: 'Grupo/conversa.txt', method: 0, crc32: calculateCrc32(text), compressedSize: text.length, uncompressedSize: text.length };

  // Como a cópia de uma entrada truncada (menos bytes) ou de dados de outra entrada (mais bytes)
  assert.throws(() => writer.addRawEntry({ ...entry, data: text.subarray(0, 1) }), {
    message: 'A entrada "Grupo/conversa.txt" foi recusada: o tamanho comprimido declarado é 2 byte(s), mas os dados têm 1 byte(s).'
  });
  assert.throws(() => writer.addRawEntry({ ...entry, data: new Blob([encoder.encode('oi!')]) }), {
    message: 'A entrada "Grupo/conversa.txt" foi recusada: o tamanho comprimido declarado é 2 byte(s), mas os dados têm 3 byte(s).'
  });
  assert.equal(writer.entryCount, 0);

  // Sem nada da entrada recusada no arquivo, a entrada válida seguinte e o diretório central ficam no lugar certo
  writer.addRawEntry({ ...entry, data: text });
  const entries = await ZipReader.extractEntries(writer.finish());
  assert.deepEqual(entries.map(({ path, content }) => [path, decoder.decode(content)]), [['Grupo/conversa.txt', 'oi']]);
});
