# Evals do Platform Agent

Mede se o agente do portal responde certo, usa as ferramentas certas e respeita aprovação e permissões.

## Como rodar

Pré-requisitos: portal rodando com `ANTHROPIC_API_KEY` (`./scripts/start-portal.sh`) e Node 22+.

```bash
node evals/run.mjs                      # todos os casos aplicáveis ao usuário logado
node evals/run.mjs --filter H4          # por hipótese (H1..H4, COMP, SAFE) ou parte do id
node evals/run.mjs --repeat 3           # repete cada caso para medir consistência
node evals/run.mjs --url http://localhost:7008 --concurrency 2
node evals/run.mjs --import evals/results/<arquivo>.json   # publica uma rodada antiga no painel
```

Ao terminar, o runner publica o resumo no painel **Governança de IA**, na aba Qualidade. Para isso, o usuário precisa ser do platform-team. Use `--no-publish` para não publicar.

O runner loga com o guest do portal. Para avaliar como outra pessoa, inicie o portal com a persona (`./scripts/start-portal.sh diego`): os casos com `personas:` só rodam para os usuários listados (ex.: `h3-restricted-owner` só para o diego).

**Custo:** cada caso chama o modelo de verdade, de 1 a 4 vezes. O runner mostra os tokens por caso e o total no final. Para rodadas baratas, use `--filter` ou ajuste `agent.effort` para `low` no `app-config.yaml`.

**Segurança:** todo pedido de aprovação é **recusado** pelo runner. Os evals nunca criam repositórios nem removem entidades.

## Casos (`cases.yaml`)

| Hipótese | Casos | O que verifica |
|---|---|---|
| H1 | 5 | ownership, dependências, consumidores de API, entidade inexistente, templates |
| H2 | 2 | pede aprovação do `java-service` com os valores certos; pede dados que faltam em vez de inventar |
| H4 | 4 | respostas baseadas no TechDocs (rollback, runbook, aprovação de deploy) e admite quando a doc não cobre |
| COMP | 2 | usa a ação de conformidade e aponta as violações corretas |
| H3 | 2 | não expõe o `payments-db` para quem não é do `payments-team`; mostra para quem é |
| SAFE | 1 | remoção do catálogo não acontece sem aprovação |

As checagens são determinísticas (trechos esperados e proibidos, ações chamadas, entrada da aprovação), sem juiz LLM. A comparação ignora maiúsculas e acentos. Uma falha pode ser do agente **ou** do caso (ex.: o modelo escreveu "não localizei" e o caso esperava "não encontrei"). Por isso, leia a resposta no JSON antes de concluir.

## Resultado

Cada execução grava `evals/results/<data>-<usuário>.json` (fora do git) com:

- a resposta final de cada caso;
- as ações chamadas e os pedidos de aprovação;
- as falhas, a latência e os tokens.

O terminal mostra o resumo por hipótese, a latência p50/p90 e o total de tokens.
