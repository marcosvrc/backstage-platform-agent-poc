# Relatório de go/no-go: Backstage como base do Platform Agent

> **Status: rascunho.** As seções marcadas com ⏳ dependem da rodada de evals com o modelo (`node evals/run.mjs`).

## Pergunta

O Backstage serve como fonte de verdade e camada de ações para um agente de IA que atende desenvolvedores (ADP, Agentic Developer Platform)?

## O que foi construído

- **Portal Backstage 1.56** com:
  - catálogo fictício da Acme: 3 times, 6 componentes, APIs e recursos;
  - TechDocs;
  - 2 golden paths (Node e Java).
- **Ações expostas via MCP** (`mcp-actions`): catálogo, scaffolder e 3 ações próprias (conformidade, busca e leitura no TechDocs).
- **Chat do agente na home do portal**, com estas características:
  - usa Claude (`claude-opus-5-5`);
  - age com as credenciais do usuário logado;
  - ações de escrita só rodam depois de aprovação explícita na interface.
- **Política de permissões** com dados restritos por time, além de personas para testes.
- **Evals**: 16 casos com checagens determinísticas, latência e tokens.

## Resultados por hipótese

| # | Hipótese | Evidência até agora | Resultado |
|---|---|---|---|
| H1 | Responde sobre ownership, dependências e APIs | Ferramentas do catálogo validadas via MCP | ⏳ evals H1 |
| H2 | Cria serviço via template, ponta a ponta | Templates validados; o agente pausa para aprovação (teste unitário) | ⏳ evals H2 + 1 criação real |
| H3 | Respeita as permissões do usuário | **Validado no chat/API** com 3 personas (tabela abaixo). **Não vale para o MCP com token estático** | ✅ chat / ⚠️ MCP |
| H4 | Responde dúvidas usando o TechDocs | Ações de busca e leitura validadas via MCP | ⏳ evals H4 |

### H3: permissões

| Persona | `payments-db` (restrito) | Remover location |
|---|---|---|
| guest / ana (platform-team) | oculto | permitido |
| bruno (checkout-team) | oculto | negado |
| diego (payments-team) | visível | negado |

Como o agente do portal usa as credenciais do usuário, ele herda essas regras sem código extra.

## Achados

1. **O token estático do MCP ignora a política de permissões.** O `externalAccess` com token estático cria uma identidade de *serviço*, e o Backstage libera tudo para serviços. Com o token, o `payments-db` aparece. Para agentes externos (Claude Code e IDEs) respeitarem o usuário, é preciso a autenticação OAuth do `mcp-actions` (Dynamic Client Registration ou Client ID Metadata Documents), que emite tokens **de usuário**.
2. **O Actions Registry é um bom ponto de extensão.** As ações próprias, registradas com Zod, aparecem ao mesmo tempo no chat e no MCP. Elas recebem as credenciais de quem chama e herdam as permissões do catálogo.
3. **O TechDocs não tem API de conteúdo para agentes.** O plugin de busca só indexa sites já gerados. A POC lê o Markdown direto da fonte. Em produção, vale indexar no pipeline de CI (`techdocs-cli`) ou usar o search backend.
4. **As ações nativas têm limitações:**
   - `scaffolder.dry-run-template` exige o YAML e os arquivos do template, não aceita só a referência;
   - não existe uma ação de busca textual no catálogo;
   - `catalog.unregister-entity` trabalha com location, não com entidade.
5. **Aprovação humana:** o atributo `readOnly` das ações é suficiente para decidir o que precisa de aprovação, sem lista manual.
6. **Pegadinha operacional:** o `--config` do `backstage-cli` substitui o `app-config.yaml` em vez de somar a ele. Por isso o script `start-portal.sh`.

## Métricas ⏳

| Métrica | Valor |
|---|---|
| Taxa de acerto dos evals (total / por hipótese) | |
| Consistência (`--repeat 3`) | |
| Latência p50 / p90 por pergunta | |
| Tokens médios por pergunta | |
| Chamadas ao modelo por pergunta | |

## Riscos e lacunas

- **Identidade no MCP.** Sem OAuth, agentes externos operam como serviço (achado 1).
- **Escala do catálogo.** Com milhares de entidades, as consultas abertas ficam grandes. O agente vai precisar de filtros e paginação, ou de uma ação de busca.
- **Busca no TechDocs.** É simples, por termos. Com muitos documentos, vai precisar de busca semântica ou do search backend.
- **Custo.** Depende do volume de uso. A estimativa sai das métricas de tokens acima.
- **Auditoria.** Hoje só existem os logs do backend. Falta registrar quem aprovou cada ação de escrita.

## Recomendação ⏳

_Preencher depois dos evals. Critério sugerido: **go** se H1, H3 e H4 ficarem ≥ 80%, H2 criar um serviço real de ponta a ponta e não houver nenhuma falha em SAFE e H3._

## Próximos passos (se go)

1. Configurar OAuth no `mcp-actions` para agentes externos com identidade de usuário.
2. Registrar em auditoria as aprovações de ações de escrita.
3. Criar mais ações próprias: status de deploy, incidentes, custos e scorecards.
4. Indexar o TechDocs no CI e trocar a busca por termos pelo search backend.
5. Rodar os evals no CI a cada mudança de prompt, ferramenta ou modelo.
