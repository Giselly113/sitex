# SiteForge AI — SaaS pago de criação de sites com IA

Projeto inicial completo de um SaaS próprio, inspirado na categoria de construtores de sites com IA.

## Incluído
- Cadastro e login
- Sessão autenticada
- Dashboard
- Planos Free / Pro / Business
- Controle de créditos de IA
- Geração de site com IA
- Editor por blocos
- Comandos para editar com IA
- Salvar projetos
- Publicar projeto
- Subdomínio local `/site/:slug`
- Exportar HTML
- Área de assinatura
- Checkout Mercado Pago (quando as credenciais estiverem configuradas)
- Webhook de pagamento
- Painel administrativo
- SQLite local

## Instalação
Node.js 18+ recomendado.

```bash
npm install
```

Copie `.env.example` para `.env` e preencha:

```env
SESSION_SECRET=uma-chave-secreta
OPENAI_API_KEY=sua-chave
APP_URL=http://localhost:3000
MERCADOPAGO_ACCESS_TOKEN=seu-token
```

Depois:

```bash
npm start
```

Abra:
http://localhost:3000

## Pagamento
A integração está preparada para Mercado Pago. Para usar pagamentos reais:
1. Crie uma aplicação no Mercado Pago.
2. Coloque o Access Token no `.env`.
3. Em produção, use HTTPS e defina APP_URL para seu domínio.
4. Configure a URL de webhook para:
`https://SEU-DOMINIO.com/api/payments/webhook`

Durante o teste, sem token do Mercado Pago, o botão de assinatura informa que o checkout precisa ser configurado.

## Segurança
- Nunca coloque OPENAI_API_KEY ou MERCADOPAGO_ACCESS_TOKEN no frontend.
- Troque SESSION_SECRET antes de publicar.
- Use HTTPS em produção.
- Para produção em escala, migre SQLite para PostgreSQL e use armazenamento de objetos para imagens.

## Planos
Os preços podem ser alterados em `server.js`, no objeto PLANS.
