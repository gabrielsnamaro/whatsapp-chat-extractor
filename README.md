# WhatsApp Web Extraction Extension (Chrome Manifest V3)

Extensão do Google Chrome (Manifest V3) desenvolvida para interagir diretamente com a interface web do WhatsApp (`https://web.whatsapp.com/`), permitindo extração de metadados, sincronização de chats e coleta de dados direto da sessão ativa do usuário.

---

## 🚀 Como Carregar no Chrome (Modo Desenvolvedor)

1. Abra o Google Chrome e navegue até `chrome://extensions/`.
2. No canto superior direito, ative o botão **Modo do desenvolvedor** (*Developer mode*).
3. Clique em **Carregar sem compactação** (*Load unpacked*).
4. Selecione esta pasta:
   ```text
   projects/whatsapp-web-extraction-extension/
   ```
5. A extensão **WhatsApp Web Data Extractor** será carregada com sucesso.

---

## 📁 Estrutura de Arquivos

```text
projects/whatsapp-web-extraction-extension/
├── manifest.json              # Configuração do Manifest V3 (permissões, scripts, popup, ícones)
├── icons/                     # Ícones da extensão (16, 32, 48, 128px)
├── background/
│   └── service-worker.js      # Service Worker de ciclo de vida e coordenação
├── content/
│   └── content.js             # Content script injetado em https://web.whatsapp.com/*
├── popup/
│   ├── popup.html             # Interface do popup (sem scripts inline, em conformidade com CSP)
│   ├── popup.css              # Estilos escuros no padrão WhatsApp
│   └── popup.js               # Lógica de controle e comunicação com abas
├── shared/                    # Módulos compartilhados e clients reutilizáveis
│   ├── clients/               # Clientes de rede, storage e backend
│   │   ├── http-client.js     # Cliente HTTP base com retry e timeout
│   │   ├── storage-client.js  # Abstração de persistência (chrome.storage)
│   │   ├── backend-client.js  # Cliente de integração com endpoints da API
│   │   └── bigquery/          # Módulo de persistência direta no Google BigQuery
│   │       ├── bigquery-client.js        # Cliente genérico (REST API v2)
│   │       ├── chat-persistence-client.js # Persistência de conversas e mensagens
│   │       └── index.js                  # Barrel export do módulo
│   ├── constants/             # Constantes compartilhadas
│   │   ├── actions.js         # Tipos de mensagens e ações entre contextos
│   │   └── selectors.js       # Seletores DOM canônicos do WhatsApp Web
│   └── utils/
│       └── logger.js          # Utilitário de log formatado com timestamps
├── kb/                        # Base de conhecimento de engenharia reversa do DOM
├── package.json               # Metadados do subprojeto (type: module)
└── README.md                  # Esta documentação
```

---

## 🔒 Permissões Configuradas

| Permissão | Finalidade |
| :--- | :--- |
| `host_permissions: ["https://web.whatsapp.com/*"]` | Acesso de rede e injeção autorizada de scripts no domínio oficial do WhatsApp Web. |
| `storage` | Persistência local segura de configurações, estados de extração e logs temporários. |
| `tabs` | Identificação e consulta do status das abas abertas em `https://web.whatsapp.com/*`. |
| `scripting` | Execução programática de scripts na página ativa quando necessário. |
| `activeTab` | Acesso temporário à aba ativa durante a interação com o popup. |
