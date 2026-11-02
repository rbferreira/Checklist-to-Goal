# Checklist-to-Goal

Plugin para [OpenCode](https://opencode.ai) que transforma um pedido — ou um
checklist em Markdown — em um **objetivo rastreado**, com **checklist visual na
barra lateral**, **barra de progresso** e um mecanismo que **mantém o modelo
preso na tarefa até terminar**, sem declarar conclusão sem evidência.

> Inspirado na ideia do `@prevalentware/opencode-goal-plugin`, mas com o
> checklist e as tarefas como cidadãos de primeira classe: você vê cada item,
> o progresso e a tarefa atual o tempo todo.

## O que ele faz

- **`/target <contexto>`** — pega o contexto do pedido, vira um objetivo e o
  quebra em tarefas concretas e verificáveis. Se o contexto apontar para um
  arquivo `.md` com itens `- [ ]`, ele usa esses itens como tarefas.
- **`/add_goal <tarefa>`** — acrescenta uma tarefa ao checklist ativo (aceita
  "Título - descrição"). Determinístico: não aciona o modelo.
- **`/target_cancel`** — cancela e remove o checklist ativo da sessão.
- **Checklist na barra lateral** (`sidebar_content`) — objetivo, barra de
  progresso e todos os itens com estado e cor: `✓` feito (verde), `●` em
  andamento, `○` pendente (amarelo), `✗` bloqueado. Clique num item para abrir
  ou fechar a descrição; a tarefa ativa abre sozinha.
- **Badge de progresso compacto** (`session_prompt_right`) — `C2G ██████░░ 60%`
  à direita da caixa de input, fora do indicador de "trabalhando".
- **Trava de foco** — quando a sessão fica ociosa e ainda há tarefas pendentes,
  o plugin injeta um "continue" automático para o modelo seguir, até concluir
  tudo ou atingir os limites configurados.
- **Conclusão só com evidência** — uma tarefa só é marcada como concluída pela
  tool `complete_task`, e apenas com evidência concreta (saída de comando,
  trecho de arquivo, resultado de teste, resposta real). "Feito" não basta.

## Instalação

### Local (a partir do código, sem publicar)

Referencie o diretório do pacote no array `plugin` com um spec `file:`. O
OpenCode carrega as duas metades (servidor + TUI) via os `exports` do
`package.json`, igual a um pacote npm.

```jsonc
{
  "plugin": [
    "file:C:/Claude/Checklist-to-Goal"
    // ...outros plugins
  ]
}
```

Com opções:

```jsonc
{
  "plugin": [
    ["file:C:/Claude/Checklist-to-Goal", { "max_auto_turns": 200, "max_no_progress": 8 }]
  ]
}
```

> Obs.: specs `file:` não passam pela checagem de atualização do OpenCode (um
> WARN inofensivo nos logs). Para editar e recarregar, reinicie o OpenCode.

### Publicado no npm

Depois de `npm publish`, basta o nome:

```jsonc
{ "plugin": ["checklist-to-goal"] }
```

Ou pela CLI do OpenCode:

```sh
opencode plugin add checklist-to-goal
```

> O array `plugin` resolve nomes simples **pelo registry do npm** — por isso o
> uso local precisa do prefixo `file:`. Soltar os arquivos em
> `~/.config/opencode/plugins/` também funciona, mas exige empacotar cada
> metade num arquivo único (os imports relativos não se resolvem lá); o
> `file:` evita isso.

| Opção            | Padrão | O que faz |
|------------------|:------:|-----------|
| `max_auto_turns` | `200`  | Máximo de continuações automáticas por objetivo. `null` = ilimitado. |
| `max_no_progress`| `8`    | Após N ciclos ociosos sem concluir nenhuma tarefa nova, para de auto-continuar (evita queimar turnos). |

## Como funciona (arquitetura)

O plugin tem duas metades (API V2 do OpenCode: `export default { id, setup }`),
carregadas a partir do mesmo pacote via `exports` (`.` → servidor, `./tui` →
TUI):

- **`src/server.ts`** (servidor) — no `setup(context)`:
  - `context.tool.transform` registra as tools;
  - `context.command.transform` injeta `/target` e `/add_goal`;
  - `context.session.hook("context")` injeta o checklist + regras no system
    prompt a cada turno;
  - `context.session.hook("prompt")` rastreia o agente da sessão;
  - `context.event.subscribe` escuta `session.idle` e, havendo tarefa pendente,
    chama `context.session.prompt(...)` para a continuação sintética.
- **`src/tui.ts`** (interface) — `setup(context)` registra os slots de UI
  (`context.ui.slot`) e desenha a sidebar e a barra de progresso lendo o estado
  compartilhado.

As duas metades rodam em processos diferentes, então o estado vive em um
arquivo JSON e a TUI o relê a cada 1s:

```
%APPDATA%\checklist-to-goal\state.json          (Windows)
$XDG_DATA_HOME/checklist-to-goal/state.json      (Linux/macOS)
```

Sobrescreva o caminho com a env var `CHECKLIST_TO_GOAL_STATE_PATH`.

## Tools (chamadas pelo modelo)

| Tool              | Função |
|-------------------|--------|
| `target_create`   | Cria o objetivo + tarefas (de `tasks[]` ou de um `markdownPath`). |
| `add_task`        | Acrescenta uma tarefa. |
| `complete_task`   | Conclui uma tarefa — exige `evidence` concreta. |
| `block_task`      | Marca uma tarefa como bloqueada, com motivo. |
| `get_checklist`   | Retorna o estado atual (objetivo, tarefas, IDs, progresso). |
| `clear_checklist` | Remove o checklist da sessão. |

## Notas

- **Posição do badge de progresso:** usamos o slot `session_prompt_right` (à
  direita do prompt), de propósito fora de `app_bottom` para não brigar com o
  indicador de "trabalhando". O slot é trocável em `src/tui.ts`.
- **Sem build:** o plugin é TypeScript puro; o OpenCode transpila no load.
- **Compatibilidade:** suporta as duas gerações da API de TUI do OpenCode
  (`api.slots.register` e `context.ui.slot`).

## Licença

MIT © Rafael Ferreira
