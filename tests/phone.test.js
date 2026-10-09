import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneDigits, phoneFromTitle } from '../shared/utils/phone.js';

// Números fictícios

test('normalizePhoneDigits: só os dígitos, sem acrescentar nem tirar o DDI ou o 9º dígito', () => {
  assert.equal(normalizePhoneDigits('+55 (11) 99999-9999'), '5511999999999');
  assert.equal(normalizePhoneDigits('+55 11 9999-9999'), '551199999999');
  assert.equal(normalizePhoneDigits(551199999999), '551199999999');
});

test('normalizePhoneDigits: sem nenhum dígito devolve null', () => {
  assert.equal(normalizePhoneDigits('Maria'), null);
  assert.equal(normalizePhoneDigits(''), null);
  assert.equal(normalizePhoneDigits(null), null);
  assert.equal(normalizePhoneDigits(undefined), null);
});

test('phoneFromTitle: título que é só um telefone, com 12 e com 13 dígitos', () => {
  assert.equal(phoneFromTitle('+55 11 9999-9999'), '551199999999');
  assert.equal(phoneFromTitle('+55 11 99999-9999'), '5511999999999');
});

test('phoneFromTitle: aceita parênteses, pontos, espaços nas pontas e marcas invisíveis de direção', () => {
  assert.equal(phoneFromTitle('(11) 99999.9999'), '11999999999');
  assert.equal(phoneFromTitle('  +55 11 99999-9999 '), '5511999999999');
  assert.equal(phoneFromTitle('\u202A+55 11 99999-9999\u202C'), '5511999999999');
  assert.equal(phoneFromTitle('\u200E+55 11 9999-9999\u200F'), '551199999999');
  assert.equal(phoneFromTitle('\u2066+55 11 9999-9999\u2069'), '551199999999');
});

test('phoneFromTitle: nome, mesmo com dígitos ou com um telefone dentro, não é telefone', () => {
  assert.equal(phoneFromTitle('Maria'), null);
  assert.equal(phoneFromTitle('Oficina 1500 Norte'), null);
  // Forma de nome com dígitos vista nos títulos reais: nome, número e sigla
  assert.equal(phoneFromTitle('Fulano 1234 AB'), null);
  assert.equal(phoneFromTitle('Ana +55 11 99999-9999'), null);
  assert.equal(phoneFromTitle('+55 11 99999-9999 (casa)'), null);
  // O "+" só vale no começo
  assert.equal(phoneFromTitle('55+11 99999-9999'), null);
});

test('phoneFromTitle: número da linha digitado no popup, só com os dígitos ou colado com a formatação; uma letra no lugar de um dígito invalida', () => {
  assert.equal(phoneFromTitle('5511999999999'), '5511999999999');
  assert.equal(phoneFromTitle('+55 (11) 99999-9999'), '5511999999999');
  assert.equal(phoneFromTitle('55 11 99999 9999'), '5511999999999');
  assert.equal(phoneFromTitle('551199999999O'), null);
});

test('phoneFromTitle: só de 10 a 15 dígitos', () => {
  assert.equal(phoneFromTitle('99999-9999'), null);
  assert.equal(phoneFromTitle('11 9999-9999'), '1199999999');
  assert.equal(phoneFromTitle('+999 999 99999-9999'), '999999999999999');
  assert.equal(phoneFromTitle('+9999 999 99999-9999'), null);
});

test('phoneFromTitle: texto vazio, só pontuação ou valor que não é texto devolve null', () => {
  assert.equal(phoneFromTitle(''), null);
  assert.equal(phoneFromTitle('+'), null);
  assert.equal(phoneFromTitle('(--)'), null);
  assert.equal(phoneFromTitle(null), null);
  assert.equal(phoneFromTitle(undefined), null);
  assert.equal(phoneFromTitle(5511999999999), null);
});
