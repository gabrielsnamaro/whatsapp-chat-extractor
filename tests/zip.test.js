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
});
