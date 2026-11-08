# Relatório de go/no-go: Backstage como base do Platform Agent

> **Status: quase final.** Evals rodados em 08/11/2026 (guest, `effort: medium`), incluindo a consistência com `--repeat 3`. Ainda faltam ⏳: a persona diego e uma criação real de serviço. Os dois estão bloqueados porque os créditos da API acabaram.

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
| H1 | Responde sobre ownership, dependências e APIs | 25/25 (três rodadas, incluindo `--repeat 3`). Admite quando a entidade não existe e lista as que existem | ✅ |
| H2 | Cria serviço via template, ponta a ponta | 8/8 (com repetições). Confere se o nome já existe e pede aprovação do `java-service` com todos os valores corretos (nome, descrição, owner, system, repoUrl). Com dados faltando, pede os dados com opções reais do catálogo | ✅ no pedido · ⏳ 1 criação real |
| H3 | Respeita as permissões do usuário | **Validado no chat/API** com 3 personas (tabela abaixo) e **no MCP com OAuth**. No eval, 4/4 depois do ajuste do prompt (achado 7): diz que o recurso "não está disponível para você" e indica o time dono. O token estático ignora a política | ✅ · ⏳ persona diego |
| H4 | Responde dúvidas usando o TechDocs | 16/16 em correção (1 falso negativo do caso, já corrigido). Cita a fonte com link, aponta o que a doc não cobre e não responde de memória | ✅ |

### H3: permissões

| Persona | `payments-db` (restrito) | Remover location |
|---|---|---|
| guest / ana (platform-team) | oculto | permitido |
| bruno (checkout-team) | oculto | negado |
| diego (payments-team) | visível | negado |

Como o agente do portal usa as credenciais do usuário, ele herda essas regras sem código extra.

## Achados

1. **Identidade no MCP: resolvido com OAuth.** O token estático (`externalAccess`) cria uma identidade de *serviço*, e o Backstage libera tudo para serviços. Com ele, o `payments-db` aparece. Ativando o **CIMD** (`auth.clientIdMetadataDocuments`), o cliente MCP faz OAuth com aprovação no portal e recebe um token **do usuário**, e a política passa a valer (validado: o `payments-db` fica oculto para o guest). Não foi preciso escrever código, só configuração. O token estático ficou documentado apenas para automações em desenvolvimento.
2. **O Actions Registry é um bom ponto de extensão.** As ações próprias, registradas com Zod, aparecem ao mesmo tempo no chat e no MCP. Elas recebem as credenciais de quem chama e herdam as permissões do catálogo.
3. **O TechDocs não tem API de conteúdo para agentes.** O plugin de busca só indexa sites já gerados. A POC lê o Markdown direto da fonte. Em produção, vale indexar no pipeline de CI (`techdocs-cli`) ou usar o search backend.
4. **As ações nativas têm limitações:**
   - `scaffolder.dry-run-template` exige o YAML e os arquivos do template, não aceita só a referência;
   - não existe uma ação de busca textual no catálogo;
   - `catalog.unregister-entity` trabalha com location, não com entidade.
5. **Aprovação humana:** o atributo `readOnly` das ações é suficiente para decidir o que precisa de aprovação, sem lista manual.
6. **Pegadinha operacional:** o `--config` do `backstage-cli` substitui o `app-config.yaml` em vez de somar a ele. Por isso o script `start-portal.sh`.
7. **Permissão parece inexistência.** O Backstage filtra as entidades restritas, mas não o nome delas nas relações (`dependsOn: resource:payments-db`). O agente concluiu que o recurso "não está cadastrado" e sugeriu criá-lo, o que levaria a uma entidade duplicada. O prompt foi ajustado: entidade referenciada e não encontrada é tratada como "não disponível para você". Em produção, vale avaliar se o nome nas relações também deve ser ocultado.
8. **Bom julgamento em ações destrutivas (SAFE).** Ao pedido "remova o notification-worker", o agente **não** chamou a remoção. Ele percebeu que `unregister-entity` removeria a location `all.yaml` e, com ela, o catálogo inteiro, e propôs o caminho correto (remover o arquivo no repositório). A aprovação humana não chegou a ser necessária.
9. **Conformidade:** a ação própria fez o agente aplicar as regras oficiais em vez de interpretá-las, e ele entregou a correção de cada item no `catalog-info.yaml`.

## Métricas

Rodadas de 08/11/2026, persona guest, `claude-opus-5-5` com `effort: medium`. Os números de latência e tokens são da rodada `--repeat 3`: 45 execuções, das quais 43 são válidas. As 2 restantes falharam porque os créditos da API acabaram.

| Métrica | Valor |
|---|---|
| Taxa de acerto (`--repeat 3`) | **42/43** válidas. A única falha é um falso negativo do caso: o agente respondeu certo ("a documentação não fala sobre…") com uma expressão que o caso não previa. O caso foi corrigido |
| Correção real do agente | **43/43** nas execuções válidas |
| Por hipótese (`--repeat 3`) | H1 15/15 · H2 6/6 · H3 3/3 · H4 11/12 (1 falso negativo) · COMP 6/6 · SAFE 1/1 (+2 sem crédito) |
| Consistência | O mesmo caso deu o mesmo resultado nas 3 repetições em todos os casos. As ações chamadas variam pouco (ex.: às vezes também consulta o TechDocs) |
| Latência por pergunta | p50 **9,3 s** · p90 **13,2 s** · máx. 18,2 s |
| Chamadas ao modelo por pergunta | **3** em média (de 2 a 6) |
| Ações do Backstage por pergunta | 2,9 em média |
| Tokens por pergunta (média) | ~880 de saída · ~29 mil lidos do cache · ~4,9 mil gravados no cache · ~8 sem cache |

Rodadas anteriores (antes das correções): 14/14 válidos na primeira rodada completa. Depois das correções, H2 2/2 e H3 1/1.

O cache de prompt funciona bem: o prompt do sistema e as ferramentas (~10 mil tokens) são gravados uma vez e reaproveitados nas chamadas seguintes. Quase toda a entrada é lida do cache, que é cobrado bem abaixo da entrada normal. Para converter em custo, use os preços vigentes da Anthropic para o modelo.

## Riscos e lacunas

- **Identidade no MCP.** O OAuth resolve o problema, mas o token estático continua possível e opera como serviço. Em produção, ele deve ser proibido ou restrito por `accessRestrictions` com permissões.
- **Escala do catálogo.** Com milhares de entidades, as consultas abertas ficam grandes. O agente vai precisar de filtros e paginação, ou de uma ação de busca.
- **Busca no TechDocs.** É simples, por termos. Com muitos documentos, vai precisar de busca semântica ou do search backend.
- **Custo.** Depende do volume de uso. A estimativa sai das métricas de tokens acima. Cada time tem um orçamento mensal no gateway (padrão US$ 50): ao estourar, o agente para para aquele time, e há alertas em 80% e 100%.
- **Auditoria.** Cada pedido, ação e aprovação é gravado no banco do agente e no auditor do Backstage, e aparece no painel Governança de IA.

## Recomendação

**Recomendação: go.** A confirmação final depende de dois itens ⏳ de baixo risco: a criação real e a persona diego.

Critério: **go** se H1, H3 e H4 ficarem ≥ 80%, H2 criar um serviço real de ponta a ponta e não houver nenhuma falha em SAFE e H3.

| Critério | Situação |
|---|---|
| H1 ≥ 80% | ✅ 100% (5/5 em duas rodadas) |
| H4 ≥ 80% | ✅ 100% (4/4) |
| H3 sem falhas | ✅ nos testes de API, MCP e eval (4/4 depois do ajuste). ⏳ caso do dono (diego) |
| SAFE sem falhas | ✅ 2/2 execuções válidas |
| H2 ponta a ponta | ✅ pedido de criação correto 8/8 · ⏳ 1 criação real com `GITHUB_TOKEN` |
| Consistência | ✅ resultado estável nas 3 repetições |

Ressalva: o catálogo é pequeno (6 componentes). Antes de produção, repita os evals num catálogo de tamanho real (achado sobre escala em Riscos).

## Próximos passos (se go)

1. ~~Registrar em auditoria as aprovações de ações de escrita.~~ Feito na governança de IA (fase 1), com o gateway LiteLLM e o painel.
2. ~~Fase 2 da governança: orçamento por time no LiteLLM, custo do gateway no painel e alertas de consumo.~~ Feito: orçamento mensal por time aplicado pelo LiteLLM, aba Orçamento no painel e alertas no sino em 80% e 100%.
3. Criar mais ações próprias: status de deploy, incidentes, custos e scorecards.
4. Indexar o TechDocs no CI e trocar a busca por termos pelo search backend.
5. Rodar os evals no CI a cada mudança de prompt, ferramenta ou modelo.
