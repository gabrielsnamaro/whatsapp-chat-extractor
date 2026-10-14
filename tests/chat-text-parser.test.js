import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatText } from '../shared/archive/chat-text-parser.js';

// A hora do texto exportado é local, sem fuso: o fuso fica fixo para o UTC esperado não depender da
// máquina. O node --test roda cada arquivo de teste num processo próprio
process.env.TZ = 'America/Sao_Paulo';

// Conversas fictícias. As linhas imitam as formas das exportações reais do WhatsApp Web: data
// "M/D/AA, H:MM:SS AM", aviso de criptografia sem data no topo, "[data] Nome: texto" e "[data] - evento".

function chatText(...lines) {
  return `${lines.join('\n')}\n`;
}

function message(fields) {
  return { kind: 'message', senderPhone: null, isOut: false, msgType: 'chat', forwarded: false, fileName: null, edited: false, ...fields };
}

function event(fields) {
  return { kind: 'event', senderName: null, senderPhone: null, isOut: null, msgType: 'system', forwarded: false, fileName: null, edited: false, ...fields };
}

const SAMPLE_LINES = [
  'As mensagens e as ligações são protegidas com a criptografia de ponta a ponta. Ninguém fora desta conversa pode ler ou ouvir o conteúdo.',
  '[8/1/26, 9:00:05 AM] - Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.',
  '[8/1/26, 9:00:05 AM] Você: Bom dia! Segue o orçamento:',
  '- item 1',
  '',
  '- item 2',
  '[8/1/26, 9:03:10 AM] +55 11 99999-9999: Obrigado!',
  '[8/1/26, 12:30:00 PM] +55 11 99999-9999:',
  'texto na linha seguinte: com dois-pontos',
  '[8/1/26, 1:05:09 PM] - [Ligação]',
  '[8/2/26, 12:15:00 AM] - Você recebeu uma mensagem no seu celular, mas ela não é compatível com sua versão do WhatsApp Web.',
  '[8/2/26, 10:00:00 AM] Você: [Encaminhada] <imagem ocultada>',
  '[8/2/26, 10:01:00 AM] Você: <documento omitido> contrato.pdf',
  '[8/2/26, 10:02:00 AM] +55 11 99999-9999: <mensagem de voz omitida>',
  ''
];

const SAMPLE_PARSED = {
  isEmpty: false,
  recognized: true,
  dateOrder: 'month-day',
  messageCount: 6,
  systemEventCount: 3,
  omittedMediaCount: 3,
  firstTimestamp: '8/1/26, 9:00:05 AM',
  lastTimestamp: '8/2/26, 10:02:00 AM',
  entries: [
    event({
      seq: 1,
      timestampRaw: '8/1/26, 9:00:05 AM',
      timestamp: '2026-08-01T12:00:05Z',
      text: 'Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.'
    }),
    message({
      seq: 2,
      timestampRaw: '8/1/26, 9:00:05 AM',
      timestamp: '2026-08-01T12:00:05Z',
      senderName: 'Você',
      isOut: true,
      text: 'Bom dia! Segue o orçamento:\n- item 1\n\n- item 2'
    }),
    message({
      seq: 3,
      timestampRaw: '8/1/26, 9:03:10 AM',
      timestamp: '2026-08-01T12:03:10Z',
      senderName: '+55 11 99999-9999',
      senderPhone: '5511999999999',
      text: 'Obrigado!'
    }),
    message({
      seq: 4,
      timestampRaw: '8/1/26, 12:30:00 PM',
      timestamp: '2026-08-01T15:30:00Z',
      senderName: '+55 11 99999-9999',
      senderPhone: '5511999999999',
      text: 'texto na linha seguinte: com dois-pontos'
    }),
    event({
      seq: 5,
      timestampRaw: '8/1/26, 1:05:09 PM',
      timestamp: '2026-08-01T16:05:09Z',
      msgType: 'call_log',
      text: '[Ligação]'
    }),
    event({
      seq: 6,
      timestampRaw: '8/2/26, 12:15:00 AM',
      timestamp: '2026-08-02T03:15:00Z',
      msgType: 'unsupported',
      text: 'Você recebeu uma mensagem no seu celular, mas ela não é compatível com sua versão do WhatsApp Web.'
    }),
    message({
      seq: 7,
      timestampRaw: '8/2/26, 10:00:00 AM',
      timestamp: '2026-08-02T13:00:00Z',
      senderName: 'Você',
      isOut: true,
      msgType: 'image',
      forwarded: true,
      text: '<imagem ocultada>'
    }),
    message({
      seq: 8,
      timestampRaw: '8/2/26, 10:01:00 AM',
      timestamp: '2026-08-02T13:01:00Z',
      senderName: 'Você',
      isOut: true,
      msgType: 'document',
      fileName: 'contrato.pdf',
      text: '<documento omitido> contrato.pdf'
    }),
    message({
      seq: 9,
      timestampRaw: '8/2/26, 10:02:00 AM',
      timestamp: '2026-08-02T13:02:00Z',
      senderName: '+55 11 99999-9999',
      senderPhone: '5511999999999',
      msgType: 'ptt',
      text: '<mensagem de voz omitida>'
    })
  ]
};

function timestampsOf(parsed) {
  return parsed.entries.map((entry) => entry.timestamp);
}

test('formato real (M/D/AA, 12 h): mensagens e eventos em ordem, com seq, data em UTC, tipo e contagens', () => {
  assert.deepEqual(parseChatText(SAMPLE_LINES.join('\n')), SAMPLE_PARSED);
});

test('preâmbulo sem data (aviso de criptografia) descartado: a primeira entrada é a primeira linha com data', () => {
  const parsed = parseChatText(chatText(
    'As mensagens e as ligações são protegidas com a criptografia de ponta a ponta.',
    'Saiba mais.',
    '[8/1/26, 9:00:00 AM] Ana: oi'
  ));
  assert.equal(parsed.entries.length, 1);
  assert.deepEqual(parsed.entries[0], message({
    seq: 1,
    timestampRaw: '8/1/26, 9:00:00 AM',
    timestamp: '2026-08-01T12:00:00Z',
    senderName: 'Ana',
    text: 'oi'
  }));
});

test('relógio de 12 h: 12 AM é meia-noite, 12 PM é meio-dia, e a tarde soma 12 horas', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 12:00:00 AM] Ana: meia-noite',
    '[8/1/26, 11:59:59 AM] Ana: antes do meio-dia',
    '[8/1/26, 12:00:00 PM] Ana: meio-dia',
    '[8/1/26, 11:59:59 PM] Ana: antes da meia-noite'
  ));
  assert.deepEqual(timestampsOf(parsed), [
    '2026-08-01T03:00:00Z',
    '2026-08-01T14:59:59Z',
    '2026-08-01T15:00:00Z',
    '2026-08-02T02:59:59Z'
  ]);
});

test('formato D/M/AAAA em 24 h: sem número acima de 12, vale dia/mês; os segundos são opcionais', () => {
  const parsed = parseChatText(chatText(
    '[01/02/2026, 09:00:00] Ana: primeiro de fevereiro',
    '[03/02/2026, 18:30] Bia: três de fevereiro, sem segundos'
  ));
  assert.equal(parsed.dateOrder, 'day-month');
  assert.deepEqual(timestampsOf(parsed), ['2026-02-01T12:00:00Z', '2026-02-03T21:30:00Z']);
});

test('ordem do mês e do dia por arquivo: sem número acima de 12, mês/dia em 12 h e dia/mês em 24 h', () => {
  const twelveHour = parseChatText(chatText('[1/2/26, 9:00:00 AM] Ana: oi'));
  assert.equal(twelveHour.dateOrder, 'month-day');
  assert.deepEqual(timestampsOf(twelveHour), ['2026-01-02T12:00:00Z']);

  const twentyFourHour = parseChatText(chatText('[1/2/2026, 09:00:00] Ana: oi'));
  assert.equal(twentyFourHour.dateOrder, 'day-month');
  assert.deepEqual(timestampsOf(twentyFourHour), ['2026-02-01T12:00:00Z']);
});

test('ordem do mês e do dia por arquivo: um 1º número acima de 12 faz o arquivo inteiro ser dia/mês, mesmo em 12 h', () => {
  const parsed = parseChatText(chatText(
    '[1/2/26, 9:00:00 AM] Ana: primeiro de fevereiro',
    '[13/2/26, 9:00:00 AM] Ana: treze de fevereiro'
  ));
  assert.equal(parsed.dateOrder, 'day-month');
  assert.deepEqual(timestampsOf(parsed), ['2026-02-01T12:00:00Z', '2026-02-13T12:00:00Z']);
});

test('ordem do mês e do dia por arquivo: um 2º número acima de 12 faz o arquivo inteiro ser mês/dia, mesmo em 24 h', () => {
  const parsed = parseChatText(chatText(
    '[1/2/2026, 10:00:00] Ana: dois de janeiro',
    '[12/25/2026, 10:00:00] Ana: Natal'
  ));
  assert.equal(parsed.dateOrder, 'month-day');
  assert.deepEqual(timestampsOf(parsed), ['2026-01-02T13:00:00Z', '2026-12-25T13:00:00Z']);
});

test('data impossível depois de decidida a ordem fica com timestamp null, e a entrada continua contada', () => {
  const parsed = parseChatText(chatText(
    '[13/1/26, 9:00:00 AM] Ana: treze de janeiro (decide dia/mês)',
    '[1/13/26, 9:00:00 AM] Ana: mês 13',
    '[30/2/26, 9:00:00 AM] Ana: 30 de fevereiro',
    '[2/1/26, 13:00:00 PM] Ana: 13 PM',
    '[2/1/2026, 24:00:00] Ana: 24 h',
    '[2/1/26, 9:60:00 AM] Ana: minuto 60',
    // Colchete sem data seguido de "Nome: ": abre uma entrada, como no inspetor, mas sem data
    '[lembrete] Ana: sem data'
  ));
  assert.deepEqual(timestampsOf(parsed), ['2026-01-13T12:00:00Z', null, null, null, null, null, null]);
  assert.equal(parsed.messageCount, 7);
  assert.equal(parsed.entries.at(-1).timestampRaw, 'lembrete');

  // Nenhuma data com a forma esperada: sem ordem decidida, e a conversa é lida mesmo assim
  const undated = parseChatText(chatText('[ontem] Ana: oi'));
  assert.equal(undated.dateOrder, null);
  assert.deepEqual(timestampsOf(undated), [null]);
  assert.equal(undated.messageCount, 1);
});

test('conversão para UTC pelas regras do fuso local no dia da mensagem (UTC−3 hoje, UTC−2 no horário de verão de 2019)', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:05 AM] Ana: agosto de 2026',
    '[1/15/19, 10:00:00 AM] Ana: janeiro de 2019, no horário de verão'
  ));
  assert.deepEqual(timestampsOf(parsed), ['2026-08-01T12:00:05Z', '2019-01-15T12:00:00Z']);
});

test('mensagem de várias linhas, com linha em branco, e "Nome:" com o texto na linha seguinte', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: primeira linha',
    'segunda linha',
    '',
    'quarta linha, depois de uma em branco',
    '[8/1/26, 9:01:00 AM] Bia:',
    'texto na linha seguinte: com dois-pontos',
    // Começa com "[" e tem "] ", mas o resto não é "Nome: ": continuação, como no inspetor
    '[lembrete] isto continua a mensagem da Bia'
  ));
  assert.deepEqual(parsed.entries.map(({ senderName, text }) => ({ senderName, text })), [
    { senderName: 'Ana', text: 'primeira linha\nsegunda linha\n\nquarta linha, depois de uma em branco' },
    { senderName: 'Bia', text: 'texto na linha seguinte: com dois-pontos\n[lembrete] isto continua a mensagem da Bia' }
  ]);
});

test('o texto de toda entrada, não só o da última, sai sem as linhas em branco e os espaços do fim', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: primeira linha',
    '  segunda linha, com espaços no começo  ',
    '',
    '   ',
    '[8/1/26, 9:01:00 AM] Bia: oi\t ',
    '',
    '[8/1/26, 9:02:00 AM] - Bia saiu',
    '',
    '[8/1/26, 9:03:00 AM] Ana: <imagem ocultada> ',
    'legenda <Mensagem editada>',
    '',
    '[8/1/26, 9:04:00 AM] Ana: até logo',
    '',
    ''
  ));
  assert.deepEqual(parsed.entries.map(({ text, msgType, edited }) => ({ text, msgType, edited })), [
    // Os espaços do começo de uma linha ficam
    { text: 'primeira linha\n  segunda linha, com espaços no começo', msgType: 'chat', edited: false },
    { text: 'oi', msgType: 'chat', edited: false },
    { text: 'Bia saiu', msgType: 'system', edited: false },
    { text: '<imagem ocultada> \nlegenda', msgType: 'image', edited: true },
    { text: 'até logo', msgType: 'chat', edited: false }
  ]);

  // A mesma mensagem seguida de linha em branco dá a mesma entrada no fim do arquivo e no meio dele
  const lines = ['[8/1/26, 9:00:00 AM] Ana: primeira linha', 'segunda linha', ''];
  const asLast = parseChatText(chatText(...lines));
  const inTheMiddle = parseChatText(chatText(...lines, '[8/1/26, 9:01:00 AM] Bia: oi'));
  assert.equal(inTheMiddle.entries[0].text, 'primeira linha\nsegunda linha');
  assert.deepEqual(inTheMiddle.entries[0], asLast.entries[0]);
});

test('eventos: [Ligação] é call_log, a mensagem não compatível é unsupported e os demais são system, sem remetente', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] - [Ligação]',
    '[8/1/26, 9:01:00 AM] - Você recebeu uma mensagem no seu celular, mas ela não é compatível com sua versão do WhatsApp Web.',
    '[8/1/26, 9:02:00 AM] - Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.',
    'Toque para saber mais.'
  ));
  assert.deepEqual(parsed.entries, [
    event({ seq: 1, timestampRaw: '8/1/26, 9:00:00 AM', timestamp: '2026-08-01T12:00:00Z', msgType: 'call_log', text: '[Ligação]' }),
    event({
      seq: 2,
      timestampRaw: '8/1/26, 9:01:00 AM',
      timestamp: '2026-08-01T12:01:00Z',
      msgType: 'unsupported',
      text: 'Você recebeu uma mensagem no seu celular, mas ela não é compatível com sua versão do WhatsApp Web.'
    }),
    event({
      seq: 3,
      timestampRaw: '8/1/26, 9:02:00 AM',
      timestamp: '2026-08-01T12:02:00Z',
      text: 'Esta empresa agora usa um serviço seguro da Meta para gerenciar esta conversa.\nToque para saber mais.'
    })
  ]);
  assert.equal(parsed.messageCount, 0);
  assert.equal(parsed.systemEventCount, 3);
});

test('"Você" é a própria conta: isOut true; outro remetente, false; evento, null', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Você: oi',
    '[8/1/26, 9:01:00 AM] Ana Souza: olá',
    // "Você" com o acento decomposto (NFD)
    '[8/1/26, 9:02:00 AM] Você: tudo bem?',
    '[8/1/26, 9:03:00 AM] - [Ligação]'
  ));
  assert.deepEqual(parsed.entries.map((entry) => entry.isOut), [true, false, true, null]);
  // O telefone da própria conta (a linha) não está no texto
  assert.equal(parsed.entries[0].senderPhone, null);
});

test('remetente que é telefone, com 12 e com 13 dígitos, ganha os dígitos em senderPhone; nome com dígitos, não', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] +55 11 9999-9999: oi',
    '[8/1/26, 9:01:00 AM] +55 11 99999-9999: oi',
    '[8/1/26, 9:02:00 AM] Oficina 1500 Norte: oi'
  ));
  assert.deepEqual(parsed.entries.map(({ senderName, senderPhone }) => ({ senderName, senderPhone })), [
    { senderName: '+55 11 9999-9999', senderPhone: '551199999999' },
    { senderName: '+55 11 99999-9999', senderPhone: '5511999999999' },
    { senderName: 'Oficina 1500 Norte', senderPhone: null }
  ]);
});

test('cada marcador de anexo, sem diferenciar maiúsculas, dá o seu msgType quando abre a mensagem', () => {
  const cases = [
    ['<imagem ocultada>', 'image'],
    ['<imagem omitida>', 'image'],
    ['<vídeo omitido>', 'video'],
    ['<GIF omitido>', 'video'],
    ['<áudio omitido>', 'audio'],
    ['<áudio ocultado>', 'audio'],
    ['<mensagem de voz omitida>', 'ptt'],
    ['<Mensagem de voz omitida>', 'ptt'],
    ['<documento omitido>', 'document'],
    ['<figurinha omitida>', 'sticker'],
    // Marcador fora do mapa e álbum
    ['<enquete omitida>', 'media'],
    ['<Mensagem de álbum>', 'media'],
    ['<Mensagem de album>', 'media'],
    // Não abre a mensagem, ou não é marcador: fica texto
    ['olha a foto <imagem ocultada>', 'chat'],
    ['<b>contrato</b>', 'chat']
  ];
  const parsed = parseChatText(chatText(...cases.map(([content], index) => `[8/1/26, 9:${String(index).padStart(2, '0')}:00 AM] Ana: ${content}`)));
  assert.deepEqual(
    parsed.entries.map((entry) => [entry.text, entry.msgType]),
    cases
  );
});

test('anexo com legenda, na mesma linha ou nas seguintes: o tipo vem do marcador e a legenda fica no texto', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: <imagem ocultada>',
    'legenda da foto',
    '[8/1/26, 9:01:00 AM] Ana: <imagem ocultada> legenda na mesma linha',
    '[8/1/26, 9:02:00 AM] Bia: <documento omitido>',
    'legenda do documento',
    '[8/1/26, 9:03:00 AM] Bia: <documento omitido> contrato.pdf',
    'segue o contrato',
    '[8/1/26, 9:04:00 AM] Ana: [Encaminhada] <vídeo omitido>',
    'legenda do vídeo <Mensagem editada>'
  ));
  assert.deepEqual(parsed.entries.map(({ msgType, fileName, forwarded, edited, text }) => ({ msgType, fileName, forwarded, edited, text })), [
    { msgType: 'image', fileName: null, forwarded: false, edited: false, text: '<imagem ocultada>\nlegenda da foto' },
    { msgType: 'image', fileName: null, forwarded: false, edited: false, text: '<imagem ocultada> legenda na mesma linha' },
    { msgType: 'document', fileName: null, forwarded: false, edited: false, text: '<documento omitido>\nlegenda do documento' },
    { msgType: 'document', fileName: 'contrato.pdf', forwarded: false, edited: false, text: '<documento omitido> contrato.pdf\nsegue o contrato' },
    { msgType: 'video', fileName: null, forwarded: true, edited: true, text: '<vídeo omitido>\nlegenda do vídeo' }
  ]);
  // Um marcador por mensagem de anexo: a contagem de anexos omitidos bate com os tipos
  assert.equal(parsed.omittedMediaCount, 5);
});

test('[Encaminhada] no começo: forwarded true, e o prefixo sai do texto', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: [Encaminhada] Promoção válida até sexta',
    '[8/1/26, 9:01:00 AM] Ana: [Encaminhada] <imagem ocultada>',
    '[8/1/26, 9:02:00 AM] Ana: [Encaminhada] <documento omitido> boleto.pdf',
    '[8/1/26, 9:03:00 AM] Ana: o [Encaminhada] no meio do texto não conta'
  ));
  assert.deepEqual(parsed.entries.map(({ forwarded, msgType, fileName, text }) => ({ forwarded, msgType, fileName, text })), [
    { forwarded: true, msgType: 'chat', fileName: null, text: 'Promoção válida até sexta' },
    { forwarded: true, msgType: 'image', fileName: null, text: '<imagem ocultada>' },
    { forwarded: true, msgType: 'document', fileName: 'boleto.pdf', text: '<documento omitido> boleto.pdf' },
    { forwarded: false, msgType: 'chat', fileName: null, text: 'o [Encaminhada] no meio do texto não conta' }
  ]);
});

test('documento: o nome do arquivo escrito depois do marcador vai para fileName', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: <documento omitido> contrato.pdf',
    '[8/1/26, 9:01:00 AM] Ana: <documento omitido> Proposta comercial v2.pdf',
    '[8/1/26, 9:02:00 AM] Ana: <documento omitido>'
  ));
  assert.deepEqual(parsed.entries.map(({ msgType, fileName }) => ({ msgType, fileName })), [
    { msgType: 'document', fileName: 'contrato.pdf' },
    { msgType: 'document', fileName: 'Proposta comercial v2.pdf' },
    { msgType: 'document', fileName: null }
  ]);
});

test('mensagem apagada dá revoked', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: Mensagem apagada',
    '[8/1/26, 9:01:00 AM] Ana: Esta mensagem foi apagada',
    '[8/1/26, 9:02:00 AM] Você: Você apagou esta mensagem',
    '[8/1/26, 9:03:00 AM] Ana: a mensagem apagada era sobre o boleto'
  ));
  assert.deepEqual(parsed.entries.map((entry) => entry.msgType), ['revoked', 'revoked', 'revoked', 'chat']);
});

test('mensagem editada: edited true, e o marcador sai do texto', () => {
  const parsed = parseChatText(chatText(
    '[8/1/26, 9:00:00 AM] Ana: Reunião às 15h <Mensagem editada>',
    '[8/1/26, 9:01:00 AM] Ana: primeira linha',
    'segunda linha <Mensagem editada>',
    '[8/1/26, 9:02:00 AM] Ana: sem edição'
  ));
  assert.deepEqual(parsed.entries.map(({ edited, text }) => ({ edited, text })), [
    { edited: true, text: 'Reunião às 15h' },
    { edited: true, text: 'primeira linha\nsegunda linha' },
    { edited: false, text: 'sem edição' }
  ]);
});

test('linhas com CRLF dão o mesmo resultado, sem \\r no texto', () => {
  const parsed = parseChatText(SAMPLE_LINES.join('\r\n'));
  assert.deepEqual(parsed, SAMPLE_PARSED);
  assert.ok(parsed.entries.every((entry) => !entry.text.includes('\r')));
});

test('formato não reconhecido: sem nenhuma linha "[data] ...", nenhuma entrada e contagens em null', () => {
  // Formato de outra plataforma (data sem colchetes), mesmo com um marcador de anexo no meio
  const parsed = parseChatText(chatText(
    '01/02/2026 09:01 - Ana: Bom dia!',
    '01/02/2026 09:02 - Bia: <imagem ocultada>',
    '[sem data]'
  ));
  assert.deepEqual(parsed, {
    isEmpty: false,
    recognized: false,
    dateOrder: null,
    entries: [],
    messageCount: null,
    systemEventCount: null,
    omittedMediaCount: null,
    firstTimestamp: null,
    lastTimestamp: null
  });
});

test('texto em branco: vazio, com as contagens zeradas e nenhuma entrada', () => {
  assert.deepEqual(parseChatText(' \n\t\r\n'), {
    isEmpty: true,
    recognized: false,
    dateOrder: null,
    entries: [],
    messageCount: 0,
    systemEventCount: 0,
    omittedMediaCount: 0,
    firstTimestamp: null,
    lastTimestamp: null
  });
});
