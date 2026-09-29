# WhatsApp Web Extraction Extension (Chrome Manifest V3)

Extensão do Google Chrome (Manifest V3) desenvolvida para interagir diretamente com a interface web do WhatsApp (`https://web.whatsapp.com/`), permitindo extração de conversas em lote, retenção temporária via IndexedDB e consolidação em um único arquivo ZIP master baixado no computador do usuário.

Projetada com **Orientação a Objetivos** e aderência estrita ao **Princípio de Responsabilidade Única (SRP)**, onde cada módulo ou classe responde por exatamente uma responsabilidade na cadeia de automação.

---

## 🚀 Como Carregar no Chrome (Modo Desenvolvedor)

1. Abra o Google Chrome e navegue até `chrome://extensions/`.
2. No canto superior direito, ative o botão **Modo do desenvolvedor** (*Developer mode*).
3. Clique em **Carregar sem compactação** (*Load unpacked*).
4. Selecione esta pasta raiz da extensão.
5. A extensão **WhatsApp Web Data Extractor** será carregada com sucesso.

Depois de recarregar a extensão, não é preciso recarregar a aba do WhatsApp: ao iniciar uma extração, o content script é reinjetado se estiver ausente.

---

## ⚡ Fluxo de Extração Local em Lote

1. O usuário abre o WhatsApp Web e faz login normalmente.
2. No popup da extensão, o usuário escolhe entre:
   - **Todos os chats da conta**: para extração completa.
   - **Limitar quantidade (modo teste)**: ex: 3 conversas, para testes e validações rápidas.
3. Ao clicar em **"Iniciar Extração em Lote"**:
   - O `ChatListScanner` faz a varredura progressiva por scroll virtual no `#pane-side` respeitando o limite (conversas arquivadas não entram).
   - Para cada conversa da fila:
     - O `ChatNavigator` abre a conversa por **título exato** (pela lista visível, pela caixa de busca ou varrendo a lista inteira) e confirma o cabeçalho.
     - O `ChatOptionsMenu` aciona o menu e clica em "Exportar conversa".
     - O `ExportModalHandler` seleciona "Todas as mensagens" e confirma o modal.
     - O arquivo gerado pelo WhatsApp é capturado por uma de duas fontes: o clique no `<a download>` interceptado pelo content script ou, se o link não passar pelo documento, o `chrome.downloads` (o download é pausado e lido pela aba). Os bytes seguem ao background em blocos base64 de 8 MiB e o `StagingRepository` os salva no IndexedDB (`whatsapp_staging_db`).
     - É aplicado um intervalo entre conversas (2 s + variação aleatória de até 50%).
   - Ao final da fila, um **offscreen document** monta o ZIP master (`whatsapp_backup_YYYY-MM-DD.zip`) lendo o staging um registro por vez — as entradas dos ZIPs nativos (exportações com mídia) são copiadas sem descompactar — e o download é disparado por URL de Blob.
   - O ZIP traz um `_relatorio.txt` na raiz com o status de cada conversa.
   - O staging só é limpo depois que o download termina. Se o "Salvar como" for cancelado, a extração fica pausada e **Retomar** gera o download de novo.

### Pausa, cancelamento e interrupções

- **Pausar** para ao fim da conversa atual; **Cancelar** interrompe inclusive a etapa em andamento na aba.
- Cada etapa tem timeout (30 s para abrir a conversa, o botão de opções e o modal; 15 s para o menu; 10 min para o WhatsApp entregar o arquivo, contados da última atividade).
- O estado da execução é persistido a cada conversa. Se o Chrome encerrar o service worker no meio da extração, ela volta como **pausada** e **Retomar** continua de onde parou.

---

## 📁 Estrutura de Arquivos e Responsabilidade dos Módulos

```text
whatsapp-extraction-extension/
├── manifest.json                       # Configuração Manifest V3 (permissões, scripts, popup, ícones)
├── icons/                              # Ícones da extensão (16, 32, 48, 128px)
├── background/
│   ├── service-worker.js               # Service Worker: ciclo de vida e roteador de mensagens
│   ├── extraction-orchestrator.js      # SRP: Máquina de estados, fila, pausa/retomada, persistência e relatório
│   ├── export-capture-registry.js      # SRP: Recepção em blocos do arquivo exportado de cada conversa
│   ├── download-interceptor.js         # SRP: Captura via chrome.downloads quando o clique não passa pelo DOM
│   └── archive-downloader.js           # SRP: Pede o ZIP ao offscreen document e acompanha o download
├── content/
│   ├── content.js                      # SRP: Mediador de mensagens, cancelamento e transferência do arquivo
│   └── dom/
│       ├── dom-utils.js                # Seletores, timeouts, esperas canceláveis, clique e títulos (carregado primeiro)
│       ├── chat-list-scanner.js        # SRP: Scroll virtual no #pane-side e descoberta de chats
│       ├── chat-navigator.js           # SRP: Abertura da conversa por título exato e confirmação do cabeçalho
│       ├── chat-options-menu.js        # SRP: Acionamento do botão 'Mais opções' e 'Exportar conversa'
│       └── export-modal-handler.js     # SRP: Gestão do modal 'Exportar conversa' (Todas as mensagens)
├── offscreen/
│   ├── offscreen.html                  # Documento offscreen (reason BLOBS)
│   └── offscreen.js                    # Monta o ZIP master e expõe a URL de Blob para o download
├── popup/
│   ├── popup.html                      # Interface do popup (modo todos vs limite, progresso e logs)
│   ├── popup.css                       # Estilização escura no padrão WhatsApp Web
│   ├── popup.js                        # Ponto de entrada da interface do popup
│   └── ui/
│       ├── progress-view.js            # SRP: Renderização visual da barra de progresso e métricas
│       └── extraction-controls.js      # SRP: Gestão do formulário de limites e eventos dos botões
├── shared/                             # Módulos compartilhados e utilitários
│   ├── archive/
│   │   ├── zip-builder.js              # SRP: ZipWriter incremental (Blobs, ZIP64, store para mídia)
│   │   ├── zip-reader.js               # SRP: Leitura de ZIPs, inclusive das entradas ainda comprimidas
│   │   └── archive-packager.js         # SRP: Consolidação do staging em um ZIP com uma pasta por conversa
│   ├── storage/
│   │   └── staging-repository.js       # SRP: Repositório temporário isolado em IndexedDB para blobs
│   ├── constants/
│   │   ├── actions.js                  # Contrato padronizado de mensagens entre contextos
│   │   └── workflow-states.js          # Enum de estados da máquina de fluxo de extração
│   ├── clients/                        # Clientes modulares (rede, storage, backend) — backend/BigQuery ainda sem uso no fluxo
│   │   ├── http-client.js
│   │   ├── storage-client.js
│   │   ├── backend-client.js
│   │   └── bigquery/
│   └── utils/
│       ├── logger.js                   # Logger padronizado com timestamps
│       └── whatsapp-tab.js             # Localização da aba do WhatsApp Web (ativa/mais recente)
├── tests/                              # Testes node:test (npm test)
├── kb/                                 # Base de conhecimento do DOM (fora do git)
├── package.json
└── README.md
```

---

## 🧪 Testes

```bash
npm test
```

Roda com `node:test` (Node 18+), sem dependências. Cobre o ZIP (ida e volta, ZIP64, cópia de entradas brutas, CRC32, sanitização de caminhos) e a normalização de títulos. Com `python3` disponível, os ZIPs gerados também são validados pelo `zipfile` do Python.

A automação do DOM depende do WhatsApp Web real e não tem teste automatizado no repositório; os snapshots em `kb/page_payloads/` servem de referência para validá-la localmente.

---

## 🔒 Permissões Configuradas

| Permissão | Finalidade |
| :--- | :--- |
| `host_permissions: ["https://web.whatsapp.com/*"]` | Injeção autorizada de scripts no domínio oficial do WhatsApp Web. |
| `downloads` | Captura do arquivo exportado quando ele não passa pelo DOM e download do ZIP consolidado final. |
| `storage` | Preferências do popup e estado persistido da execução (retomada após reinício do service worker). |
| `tabs` | Localização da aba do WhatsApp Web aberta. |
| `scripting` | Reinjeção do content script na aba já aberta depois que a extensão é recarregada. |
| `offscreen` | Documento offscreen que monta o ZIP e gera a URL de Blob do download. |

---

## ⚠️ Limitações Conhecidas

- **Homônimos:** duas conversas com o mesmo nome visíveis ao mesmo tempo são recusadas (falha registrada); homônimos distantes na lista não são detectáveis, e só um deles é exportado (o relatório avisa quando o scanner detectou a duplicidade).
- **Conversas arquivadas** não entram na varredura.
- Se o Chrome estiver configurado para perguntar onde salvar cada download, a captura via `chrome.downloads` pode exibir a janela de "Salvar como" para cada conversa.
- Automatizar o WhatsApp Web contraria os termos de uso do serviço e pode levar a restrições da conta; use intervalos conservadores.
