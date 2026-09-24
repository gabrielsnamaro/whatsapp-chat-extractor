# WhatsApp Web Extraction Extension (Chrome Manifest V3)

Extensão do Google Chrome (Manifest V3) desenvolvida para interagir diretamente com a interface web do WhatsApp (`https://web.whatsapp.com/`), permitindo extração de dados e conversas em lote, retenção temporária via IndexedDB e consolidação em um único arquivo ZIP master baixado no computador do usuário.

Projetada com **Orientação a Objetivos** e aderência estrita ao **Princípio de Responsabilidade Única (SRP)**, onde cada módulo ou classe responde por exatamente uma responsabilidade na cadeia de automação.

---

## 🚀 Como Carregar no Chrome (Modo Desenvolvedor)

1. Abra o Google Chrome e navegue até `chrome://extensions/`.
2. No canto superior direito, ative o botão **Modo do desenvolvedor** (*Developer mode*).
3. Clique em **Carregar sem compactação** (*Load unpacked*).
4. Selecione esta pasta raiz da extensão.
5. A extensão **WhatsApp Web Data Extractor** será carregada com sucesso.

---

## ⚡ Fluxo de Extração Local em Lote

1. O usuário abre o WhatsApp Web e faz login normalmente.
2. No popup da extensão, o usuário escolhe entre:
   - **Todos os chats da conta**: para extração completa.
   - **Limitar quantidade (modo teste)**: ex: 3 conversas, para testes e validações rápidas.
3. Ao clicar em **"Iniciar Extração em Lote"**:
   - O `ExtractionOrchestrator` ativa o `DownloadInterceptor` para silenciar downloads nativos no disco.
   - O `ChatListScanner` faz a varredura progressiva por scroll virtual no `#pane-side` respeitando o limite.
   - Para cada conversa da fila:
     - O `ChatNavigator` abre a conversa e confirma o cabeçalho.
     - O `ChatOptionsMenu` aciona o menu e clica em "Exportar conversa".
     - O `ExportModalHandler` seleciona "Todas as mensagens" e confirma o modal.
     - O `DownloadInterceptor` captura a carga binária do arquivo exportado e o `StagingRepository` o salva no IndexedDB (`whatsapp_staging_db`).
     - É aplicado um delay de segurança configurável entre cada conversa para prevenir sobrecarga.
   - Ao final da fila, o `ZipBuilder` lê todos os arquivos armazenados no IndexedDB, empacota todas as conversas em um único arquivo compactado (`whatsapp_backup_YYYY-MM-DD.zip`) e aciona um único download no navegador.
   - O banco temporário no IndexedDB é automaticamente limpo.

---

## 📁 Estrutura de Arquivos e Responsabilidade dos Módulos

```text
whatsapp-extraction-extension/
├── manifest.json                       # Configuração Manifest V3 (permissões, scripts, popup, ícones)
├── icons/                              # Ícones da extensão (16, 32, 48, 128px)
├── background/
│   ├── service-worker.js               # Service Worker: ciclo de vida e roteador de mensagens
│   ├── download-interceptor.js         # SRP: Interceptação silenciosa de downloads nativos do WhatsApp
│   └── extraction-orchestrator.js      # SRP: Máquina de estados, fila, limites de chats e ZIP final
├── content/
│   ├── content.js                      # SRP: Mediador de mensagens entre background e controladores DOM
│   └── dom/
│       ├── chat-list-scanner.js        # SRP: Scroll virtual no #pane-side e descoberta de chats
│       ├── chat-navigator.js           # SRP: Navegação e confirmação visual de abertura do chat
│       ├── chat-options-menu.js        # SRP: Acionamento do botão 'Mais opções' e 'Exportar conversa'
│       └── export-modal-handler.js     # SRP: Gestão do modal 'Exportar conversa' (Todas as mensagens)
├── popup/
│   ├── popup.html                      # Interface do popup (modo todos vs limite, progresso e logs)
│   ├── popup.css                       # Estilização escura no padrão WhatsApp Web
│   ├── popup.js                        # Ponto de entrada da interface do popup
│   └── ui/
│       ├── progress-view.js            # SRP: Renderização visual da barra de progresso e métricas
│       └── extraction-controls.js      # SRP: Gestão do formulário de limites e eventos dos botões
├── shared/                             # Módulos compartilhados e utilitários
│   ├── archive/
│   │   └── zip-builder.js              # SRP: Compilação de múltiplos arquivos em arquivo .zip (zero dependências)
│   ├── storage/
│   │   └── staging-repository.js       # SRP: Repositório temporário isolado em IndexedDB para blobs
│   ├── constants/
│   │   ├── actions.js                  # Contrato padronizado de mensagens entre contextos
│   │   ├── selectors.js                # Seletores DOM canônicos mapeados da engenharia reversa
│   │   └── workflow-states.js          # Enum de estados da máquina de fluxo de extração
│   ├── clients/                        # Clientes modulares (rede, storage, backend)
│   │   ├── http-client.js              # Cliente HTTP base com retry e timeout
│   │   ├── storage-client.js           # Abstração de persistência (chrome.storage)
│   │   ├── backend-client.js           # Cliente base de sincronização externa
│   │   └── bigquery/                   # Estrutura modular reservada para BigQuery
│   │       ├── bigquery-client.js
│   │       ├── chat-persistence-client.js
│   │       └── index.js
│   └── utils/
│       └── logger.js                   # Logger padronizado com timestamps
├── kb/                                 # Base de conhecimento de engenharia reversa do DOM
├── package.json                        # Metadados do projeto (type: module)
└── README.md                           # Esta documentação
```

---

## 🔒 Permissões Configuradas

| Permissão | Finalidade |
| :--- | :--- |
| `host_permissions: ["https://web.whatsapp.com/*"]` | Acesso de rede e injeção autorizada de scripts no domínio oficial do WhatsApp Web. |
| `downloads` | Interceptação de arquivos exportados pelo WhatsApp e download do arquivo ZIP consolidado final. |
| `storage` | Persistência local segura de configurações, preferências de limite e estados da extensão. |
| `tabs` | Identificação e consulta do status das abas abertas em `https://web.whatsapp.com/*`. |
| `scripting` | Execução programática de scripts na página ativa quando necessário. |
| `activeTab` | Acesso temporário à aba ativa durante a interação com o popup. |
