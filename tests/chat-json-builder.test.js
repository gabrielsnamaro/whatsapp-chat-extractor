import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildChatRecord, buildMessageRecords } from '../shared/archive/chat-json-builder.js';
import { parseChatText } from '../shared/archive/chat-text-parser.js';

// A hora do texto exportado é local, sem fuso: o fuso fica fixo para o UTC esperado não depender da máquina. O node
// --test roda cada arquivo de teste num processo próprio
process.env.TZ = 'America/Sao_Paulo';

// Números, nomes e conversas fictícios. O texto imita as formas das exportações reais (data "M/D/AA, H:MM:SS AM").

const LINE_PHONE = '5511900000000';
const CONTACT_PHONE = '5511911111111';
const RUN_META = { runId: 'mux6ft32', linePhone: LINE_PHONE, extensionVersion: '1.0.0' };
const TIME_ZONE = 'America/Sao_Paulo';

// Nomes e ordem dos campos da conversa, como no formato descrito no README
const CHAT_FIELDS = [
  'chat_id', 'source', 'line_phone', 'wa_chat_id', 'kind', 'name', 'contact_phone', 'contact_phone_source', 'order', 'folder',
  'export_status', 'error_code', 'message_count', 'system_event_count', 'omitted_media_count', 'first_message_at',
  'last_message_at', 'run_id', 'exported_at', 'time_zone', 'parse_error', 'extension_version'
];
const MESSAGE_FIELDS = [
  'message_id', 'chat_id', 'line_phone', 'seq', 'timestamp', 'timestamp_raw', 'sender_name', 'sender_phone', 'is_out',
  'msg_type', 'text', 'forwarded', 'file_name', 'edited'
];

/** SHA-256 em hexadecimal, pelo node:crypto: uma implementação independente da do builder (WebCrypto) */
function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** chat_id de uma conversa sem telefone: o prefixo da linha e os 16 primeiros caracteres do hash do título normalizado */
function titleChatId(prefix, normalizedTitle) {
  return `${prefix}_t${sha256Hex(normalizedTitle).slice(0, 16)}`;
}

/** message_id como o contrato descreve */
function expectedMessageId(chatId, timestampRaw, senderName, text, occurrence) {
  return sha256Hex(JSON.stringify([chatId, timestampRaw, senderName, text, occurrence])).slice(0, 32);
}

function chatText(...lines) {
  return `${lines.join('\n')}\n`;
}

/** Linha do índice como o orquestrador monta; o builder usa a parte dela que vai para o JSON */
function indexRow(fields) {
  return {
    chatId: '000000',
    order: 1,
    title: 'Maria Silva',
    status: 'OK',
    exportStatus: 'saved',
    code: null,
    attempts: 1,
    bytes: 1024,
    messageCount: null,
    systemEventCount: null,
    omittedMediaCount: null,
    firstTimestamp: null,
    lastTimestamp: null,
    durationMs: 3000,
    via: 'lista visível',
    kind: 'chat',
    contactPhone: CONTACT_PHONE,
    contactPhoneSource: 'contact_info',
    exportedAt: '2026-10-06T21:20:31.123Z',
    ...fields
  };
}

/** Conversa com arquivo no ZIP, a partir do texto exportado */
function chatWithText(text, { row = {}, runMeta = RUN_META, chatMarkdown = null } = {}) {
  return buildChatRecord({
    row: indexRow(row),
    runMeta,
    timeZone: TIME_ZONE,
    folder: indexRow(row).title,
    parsed: parseChatText(text),
    chatMarkdown
  });
}

test('conversa individual com telefone: chat_id e wa_chat_id pelo telefone do contato, campos na ordem do contrato e datas em UTC sem milissegundos', async () => {
  const text = chatText(
    'As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.',
    // Entradas com data impossível (31 de fevereiro), sem timestamp, no começo e no fim: a 1ª e a última data são as das
    // outras
    '[2/31/26, 9:00:00 AM] Maria Silva: entrada sem timestamp no começo',
    '[8/1/26, 9:00:05 AM] Maria Silva: Bom dia',
    '[8/1/26, 9:01:00 AM] Você: <imagem ocultada>',
    '[10/1/26, 3:50:12 PM] Maria Silva: Até logo',
    '[2/31/26, 9:00:00 AM] Maria Silva: entrada sem timestamp no fim'
  );

  const chat = await chatWithText(text, { row: { order: 12 } });

  assert.deepEqual(Object.keys(chat), CHAT_FIELDS);
  assert.deepEqual(chat, {
    chat_id: `${LINE_PHONE}_${CONTACT_PHONE}`,
    source: 'WhatsAppWeb',
    line_phone: LINE_PHONE,
    wa_chat_id: CONTACT_PHONE,
    kind: 'chat',
    name: 'Maria Silva',
    contact_phone: CONTACT_PHONE,
    contact_phone_source: 'contact_info',
    order: 12,
    folder: 'Maria Silva',
    export_status: 'saved',
    error_code: null,
    message_count: 5,
    system_event_count: 0,
    omitted_media_count: 1,
    first_message_at: '2026-08-01T12:00:05Z',
    last_message_at: '2026-10-01T18:50:12Z',
    run_id: 'mux6ft32',
    exported_at: '2026-10-06T21:20:31Z',
    time_zone: TIME_ZONE,
    parse_error: null,
    extension_version: '1.0.0'
  });
});

test('grupo: chat_id pelo hash do título normalizado (NFC, sem caracteres invisíveis, espaços colapsados), sem telefone do contato', async () => {
  const text = chatText('[8/1/26, 9:00:00 AM] Ana: oi');
  // "í" decomposto (NFD), marca de direção, seletor de variação e espaços sobrando: o mesmo título de "Família Silva"
  const messyTitle = '  Fami\u0301lia \u200E Silva\uFE0F ';
  const group = { kind: 'group', contactPhone: null, contactPhoneSource: null };

  const messy = await chatWithText(text, { row: { ...group, title: messyTitle } });
  const clean = await chatWithText(text, { row: { ...group, title: 'Família Silva' } });

  assert.equal(messy.chat_id, titleChatId(LINE_PHONE, 'Família Silva'));
  assert.equal(clean.chat_id, messy.chat_id);
  // O nome fica como veio da lista
  assert.equal(messy.name, messyTitle);
  assert.deepEqual(
    [messy.kind, messy.wa_chat_id, messy.contact_phone, messy.contact_phone_source],
    ['group', null, null, null]
  );
  // Outro título, outro chat_id
  const other = await chatWithText(text, { row: { ...group, title: 'Família Souza' } });
  assert.notEqual(other.chat_id, messy.chat_id);
});

test('sem a linha (execução iniciada por uma versão anterior): line_phone null e o prefixo sem-linha no chat_id; a mensagem de "Você" fica sem telefone', async () => {
  const runMeta = { ...RUN_META, linePhone: null };
  const text = chatText('[8/1/26, 9:00:00 AM] Você: oi', '[8/1/26, 9:01:00 AM] Maria Silva: olá');

  const withPhone = await chatWithText(text, { runMeta });
  const withoutPhone = await chatWithText(text, { runMeta, row: { kind: null, contactPhone: null, contactPhoneSource: null } });

  assert.deepEqual([withPhone.chat_id, withPhone.line_phone], [`sem-linha_${CONTACT_PHONE}`, null]);
  assert.deepEqual([withoutPhone.chat_id, withoutPhone.line_phone], [titleChatId('sem-linha', 'Maria Silva'), null]);
  const messages = await buildMessageRecords(withPhone, parseChatText(text).entries);
  assert.deepEqual(messages.map(({ line_phone, sender_phone }) => [line_phone, sender_phone]), [[null, null], [null, CONTACT_PHONE]]);
});

test('telefone de reserva (export), só na conversa individual: do cabeçalho do chat.md e, sem ele, do único remetente além de "Você" quando o nome dele é um telefone', async () => {
  const noPhone = { contactPhone: null, contactPhoneSource: null };
  const byName = chatText('[8/1/26, 9:00:00 AM] Loja Fictícia: Bom dia', '[8/1/26, 9:01:00 AM] Você: oi');
  const byPhone = chatText(
    '[8/1/26, 9:00:00 AM] +55 11 95555-5555: Bom dia',
    '[8/1/26, 9:01:00 AM] Você: oi',
    '[8/1/26, 9:02:00 AM] +55 11 95555-5555: tudo bem?'
  );
  const phoneHeader = '# Histórico de conversas do WhatsApp: +55 11 94444-4444\r\n\nData de exportação: 06/10/2026\n';
  const nameHeader = '# Histórico de conversas do WhatsApp: Loja Fictícia\n';

  // Cabeçalho do chat.md com o telefone (o título e o remetente são o nome)
  const fromHeader = await chatWithText(byName, { row: { ...noPhone, title: 'Loja Fictícia' }, chatMarkdown: phoneHeader });
  assert.deepEqual(
    [fromHeader.chat_id, fromHeader.wa_chat_id, fromHeader.contact_phone, fromHeader.contact_phone_source],
    [`${LINE_PHONE}_5511944444444`, '5511944444444', '5511944444444', 'export']
  );

  // Cabeçalho com o nome, e o único remetente além de "Você" é um telefone; também sem o chat.md (texto puro)
  for (const chatMarkdown of [nameHeader, null]) {
    const fromSender = await chatWithText(byPhone, { row: { ...noPhone, title: 'Loja Fictícia' }, chatMarkdown });
    assert.deepEqual(
      [fromSender.chat_id, fromSender.contact_phone, fromSender.contact_phone_source],
      [`${LINE_PHONE}_5511955555555`, '5511955555555', 'export'],
      String(chatMarkdown)
    );
  }

  // Tipo desconhecido não recebe a reserva: pode ser um grupo com um só remetente com nome de telefone, e o chat_id ficaria
  // igual ao da conversa individual desse membro. A mensagem dele leva o telefone do nome, como num grupo
  const unknownKind = await chatWithText(byPhone, { row: { ...noPhone, kind: null }, chatMarkdown: phoneHeader });
  assert.deepEqual(
    [unknownKind.chat_id, unknownKind.wa_chat_id, unknownKind.contact_phone, unknownKind.contact_phone_source],
    [titleChatId(LINE_PHONE, 'Maria Silva'), null, null, null]
  );
  const unknownKindMessages = await buildMessageRecords(unknownKind, parseChatText(byPhone).entries);
  assert.deepEqual(unknownKindMessages.map((message) => message.sender_phone), ['5511955555555', LINE_PHONE, '5511955555555']);

  // Sem reserva: o remetente é um nome, há dois remetentes diferentes, ou a conversa é um grupo
  const twoSenders = chatText('[8/1/26, 9:00:00 AM] +55 11 95555-5555: oi', '[8/1/26, 9:01:00 AM] +55 11 96666-6666: oi');
  const withoutFallback = [
    await chatWithText(byName, { row: noPhone, chatMarkdown: nameHeader }),
    await chatWithText(twoSenders, { row: noPhone }),
    await chatWithText(byPhone, { row: { ...noPhone, kind: 'group' }, chatMarkdown: phoneHeader })
  ];
  assert.deepEqual(
    withoutFallback.map(({ chat_id, wa_chat_id, contact_phone, contact_phone_source }) => [chat_id, wa_chat_id, contact_phone, contact_phone_source]),
    [
      [titleChatId(LINE_PHONE, 'Maria Silva'), null, null, null],
      [titleChatId(LINE_PHONE, 'Maria Silva'), null, null, null],
      [titleChatId(LINE_PHONE, 'Maria Silva'), null, null, null]
    ]
  );

  // Com o telefone do título ou do painel, a reserva não é usada
  const fromTitle = await chatWithText(byPhone, {
    row: { title: '+55 11 97777-7777', contactPhone: '5511977777777', contactPhoneSource: 'title' },
    chatMarkdown: phoneHeader
  });
  assert.deepEqual([fromTitle.contact_phone, fromTitle.contact_phone_source], ['5511977777777', 'title']);

  // Sem arquivo no ZIP não há texto para a reserva
  const noFile = await buildChatRecord({ row: indexRow({ ...noPhone, chatId: null, exportStatus: 'failed' }), runMeta: RUN_META, timeZone: TIME_ZONE });
  assert.deepEqual([noFile.contact_phone, noFile.contact_phone_source], [null, null]);
});

test('message_id: estável entre duas montagens, único na conversa, diferente para duas mensagens idênticas no mesmo segundo, e calculado pelo contrato', async () => {
  const text = chatText(
    '[8/1/26, 9:00:00 AM] Maria Silva: ok',
    '[8/1/26, 9:00:00 AM] Maria Silva: ok',
    // O mesmo texto em outro segundo e de outro remetente
    '[8/1/26, 9:00:01 AM] Maria Silva: ok',
    '[8/1/26, 9:00:00 AM] Você: ok',
    '[8/1/26, 9:00:00 AM] - [Ligação]'
  );
  const { entries } = parseChatText(text);
  const chat = await chatWithText(text);

  const first = await buildMessageRecords(chat, entries);
  const second = await buildMessageRecords(chat, entries);

  const ids = first.map((message) => message.message_id);
  assert.deepEqual(second.map((message) => message.message_id), ids);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[0-9a-f]{32}$/.test(id)), ids.join(', '));
  // As duas idênticas no mesmo segundo diferem só pela ocorrência
  const chatId = `${LINE_PHONE}_${CONTACT_PHONE}`;
  assert.deepEqual(ids, [
    expectedMessageId(chatId, '8/1/26, 9:00:00 AM', 'Maria Silva', 'ok', 0),
    expectedMessageId(chatId, '8/1/26, 9:00:00 AM', 'Maria Silva', 'ok', 1),
    expectedMessageId(chatId, '8/1/26, 9:00:01 AM', 'Maria Silva', 'ok', 0),
    expectedMessageId(chatId, '8/1/26, 9:00:00 AM', 'Você', 'ok', 0),
    expectedMessageId(chatId, '8/1/26, 9:00:00 AM', null, '[Ligação]', 0)
  ]);

  // O mesmo conteúdo em outra conversa dá outros ids
  const otherChat = await chatWithText(text, { row: { contactPhone: '5511922222222' } });
  const otherIds = (await buildMessageRecords(otherChat, entries)).map((message) => message.message_id);
  assert.equal(otherIds.some((id) => ids.includes(id)), false);
});

test('message_id não muda quando a mensagem deixa de ser a última do arquivo, mesmo seguida de linha em branco', async () => {
  const lastLines = ['[8/1/26, 9:00:00 AM] Maria Silva: primeira linha', 'segunda linha', '', ''];
  const asLast = chatText(...lastLines);
  const inTheMiddle = chatText(...lastLines, '[8/1/26, 9:05:00 AM] Você: resposta');
  const chat = await chatWithText(asLast);

  const [lastMessage] = await buildMessageRecords(chat, parseChatText(asLast).entries);
  const [middleMessage] = await buildMessageRecords(chat, parseChatText(inTheMiddle).entries);

  assert.equal(middleMessage.text, 'primeira linha\nsegunda linha');
  assert.deepEqual(middleMessage, lastMessage);
});

test('sender_phone: "Você" é a linha; evento, null; conversa individual, o telefone do contato; grupo ou tipo desconhecido, o do remetente quando o nome dele é um telefone', async () => {
  const text = chatText(
    '[8/1/26, 9:00:00 AM] Você: oi',
    '[8/1/26, 9:01:00 AM] +55 11 93333-3333: olá',
    '[8/1/26, 9:02:00 AM] Ana Souza: bom dia',
    '[8/1/26, 9:03:00 AM] - Ana Souza saiu'
  );
  const { entries } = parseChatText(text);
  const senderPhones = async (row) => (await buildMessageRecords(await chatWithText(text, { row }), entries)).map((message) => message.sender_phone);

  // Na conversa individual, quem não é "Você" é o contato, mesmo com outro nome no texto
  assert.deepEqual(await senderPhones({}), [LINE_PHONE, CONTACT_PHONE, CONTACT_PHONE, null]);
  assert.deepEqual(await senderPhones({ kind: 'group', contactPhone: null, contactPhoneSource: null }), [LINE_PHONE, '5511933333333', null, null]);
  assert.deepEqual(await senderPhones({ kind: null }), [LINE_PHONE, '5511933333333', null, null]);
});

test('mensagens: campos na ordem do contrato, data em UTC sem milissegundos, data bruta, remetente, tipo, encaminhada, nome do documento e editada', async () => {
  const text = chatText(
    '[8/1/26, 9:00:05 AM] - Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.',
    '[8/1/26, 9:00:05 AM] Maria Silva: [Encaminhada] <documento omitido> contrato.pdf',
    '[8/1/26, 12:30:00 PM] Você: Reunião às 15h <Mensagem editada>'
  );
  const chat = await chatWithText(text);
  const chatId = `${LINE_PHONE}_${CONTACT_PHONE}`;

  const messages = await buildMessageRecords(chat, parseChatText(text).entries);

  messages.forEach((message) => assert.deepEqual(Object.keys(message), MESSAGE_FIELDS));
  const metaService = 'Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.';
  assert.deepEqual(messages, [
    {
      message_id: expectedMessageId(chatId, '8/1/26, 9:00:05 AM', null, metaService, 0),
      chat_id: chatId,
      line_phone: LINE_PHONE,
      seq: 1,
      timestamp: '2026-08-01T12:00:05Z',
      timestamp_raw: '8/1/26, 9:00:05 AM',
      sender_name: null,
      sender_phone: null,
      is_out: null,
      msg_type: 'system',
      text: metaService,
      forwarded: false,
      file_name: null,
      edited: false
    },
    {
      message_id: expectedMessageId(chatId, '8/1/26, 9:00:05 AM', 'Maria Silva', '<documento omitido> contrato.pdf', 0),
      chat_id: chatId,
      line_phone: LINE_PHONE,
      seq: 2,
      timestamp: '2026-08-01T12:00:05Z',
      timestamp_raw: '8/1/26, 9:00:05 AM',
      sender_name: 'Maria Silva',
      sender_phone: CONTACT_PHONE,
      is_out: false,
      msg_type: 'document',
      text: '<documento omitido> contrato.pdf',
      forwarded: true,
      file_name: 'contrato.pdf',
      edited: false
    },
    {
      message_id: expectedMessageId(chatId, '8/1/26, 12:30:00 PM', 'Você', 'Reunião às 15h', 0),
      chat_id: chatId,
      line_phone: LINE_PHONE,
      seq: 3,
      timestamp: '2026-08-01T15:30:00Z',
      timestamp_raw: '8/1/26, 12:30:00 PM',
      sender_name: 'Você',
      sender_phone: LINE_PHONE,
      is_out: true,
      msg_type: 'chat',
      text: 'Reunião às 15h',
      forwarded: false,
      file_name: null,
      edited: true
    }
  ]);
});

test('conversa sem arquivo no ZIP (falha, não exportável, pasta Downloads, não processada): sem pasta, contagens e datas; exported_at sem os milissegundos', async () => {
  const noFile = (row) => buildChatRecord({ row: indexRow({ chatId: null, ...row }), runMeta: RUN_META, timeZone: TIME_ZONE });

  const failed = await noFile({ exportStatus: 'failed', status: 'FALHA', code: 'TIMEOUT', kind: null, contactPhone: null, contactPhoneSource: null, exportedAt: null });
  const toDisk = await noFile({ exportStatus: 'saved_to_disk', status: 'NA PASTA DOWNLOADS', exportedAt: '2026-10-06T21:20:31.999Z' });

  assert.deepEqual(Object.keys(failed), CHAT_FIELDS);
  assert.deepEqual(failed, {
    chat_id: titleChatId(LINE_PHONE, 'Maria Silva'),
    source: 'WhatsAppWeb',
    line_phone: LINE_PHONE,
    wa_chat_id: null,
    kind: null,
    name: 'Maria Silva',
    contact_phone: null,
    contact_phone_source: null,
    order: 1,
    folder: null,
    export_status: 'failed',
    error_code: 'TIMEOUT',
    message_count: null,
    system_event_count: null,
    omitted_media_count: null,
    first_message_at: null,
    last_message_at: null,
    run_id: 'mux6ft32',
    exported_at: null,
    time_zone: TIME_ZONE,
    parse_error: null,
    extension_version: '1.0.0'
  });
  // Os milissegundos são cortados, não arredondados
  assert.deepEqual(
    [toDisk.chat_id, toDisk.folder, toDisk.export_status, toDisk.message_count, toDisk.exported_at],
    [`${LINE_PHONE}_${CONTACT_PHONE}`, null, 'saved_to_disk', null, '2026-10-06T21:20:31Z']
  );
});

test('texto em branco não é erro: contagens zeradas, sem datas e sem parse_error; o parse_error que o empacotamento manda vai como veio', async () => {
  const empty = await chatWithText('\n', { row: { exportStatus: 'empty', status: 'OK – VAZIA' } });
  assert.deepEqual(
    [empty.export_status, empty.message_count, empty.system_event_count, empty.omitted_media_count, empty.first_message_at, empty.parse_error],
    ['empty', 0, 0, 0, null, null]
  );

  const reason = 'O ZIP exportado não contém o texto da conversa (_chat.txt).';
  const unparsed = await buildChatRecord({ row: indexRow(), runMeta: RUN_META, timeZone: TIME_ZONE, folder: 'Maria Silva', parseError: reason });
  assert.deepEqual(
    [unparsed.folder, unparsed.message_count, unparsed.last_message_at, unparsed.parse_error],
    ['Maria Silva', null, null, reason]
  );
});

test('extension_version: a versão do runMeta, por último, com arquivo, sem arquivo e com parse_error; null quando o runMeta não a traz', async () => {
  const runMeta = { ...RUN_META, extensionVersion: '2.3.4' };
  const text = chatText('[8/1/26, 9:00:00 AM] Maria Silva: oi');
  const records = [
    await chatWithText(text, { runMeta }),
    await buildChatRecord({ row: indexRow({ chatId: null, exportStatus: 'failed' }), runMeta, timeZone: TIME_ZONE }),
    await buildChatRecord({ row: indexRow(), runMeta, timeZone: TIME_ZONE, folder: 'Maria Silva', parseError: 'erro interno ao montar o JSON: falha' })
  ];

  assert.deepEqual(records.map((record) => Object.keys(record).at(-1)), ['extension_version', 'extension_version', 'extension_version']);
  assert.deepEqual(records.map((record) => record.extension_version), ['2.3.4', '2.3.4', '2.3.4']);
  const withoutVersion = await chatWithText(text, { runMeta: { runId: RUN_META.runId, linePhone: LINE_PHONE } });
  assert.equal(withoutVersion.extension_version, null);
  // As mensagens não levam a versão
  const [message] = await buildMessageRecords(records[0], parseChatText(text).entries);
  assert.equal('extension_version' in message, false);
});
