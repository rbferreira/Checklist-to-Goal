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
- **`/add_goal <tarefa>`** — acrescenta uma tarefa ao checklist ativo.
- **Checklist na barra lateral** (`sidebar_content`) — objetivo, barra de
  progresso e todos os itens com estado (`☑` feito, `▸` em andamento,
  `☐` pendente, `⚠` bloqueado).
- **Barra de progresso compacta** (`app_bottom`) — `C2G ██████░░ 60% ▸ tarefa
  atual`, abaixo da caixa de contexto.
- **Trava de foco** — quando a sessão fica ociosa e ainda há tarefas pendentes,
  o plugin injeta um "continue" automático para o modelo seguir, até concluir
  tudo ou atingir os limites configurados.
- **Conclusão só com evidência** — uma tarefa só é marcada como concluída pela
  tool `complete_task`, e apenas com evidência concreta (saída de comando,
  trecho de arquivo, resultado de teste, resposta real). "Feito" não basta.

## Instalação

Adicione ao array `plugin` do seu `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "checklist-to-goal"
    // ...outros plugins
  ]
}
```

Para ajustar limites, use a forma de tupla:

```jsonc
{
  "plugin": [
    ["checklist-to-goal", { "max_auto_turns": 200, "max_no_progress": 8 }]
  ]
}
```

| Opção            | Padrão | O que faz |
|------------------|:------:|-----------|
| `max_auto_turns` | `200`  | Máximo de continuações automáticas por objetivo. `null` = ilimitado. |
| `max_no_progress`| `8`    | Após N ciclos ociosos sem concluir nenhuma tarefa nova, para de auto-continuar (evita queimar turnos). |

## Como funciona (arquitetura)

O plugin tem duas metades, carregadas pelo OpenCode a partir do mesmo pacote:

- **`src/server.ts`** (servidor) — registra as tools, injeta os comandos via o
  hook `config`, injeta o checklist + regras no system prompt a cada turno
  (`experimental.chat.system.transform`) e, no evento `session.idle`, envia a
  continuação sintética (`client.session.promptAsync`).
- **`src/tui.ts`** (interface) — desenha a sidebar e a barra de progresso lendo
  o estado compartilhado.

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

- **Posição da barra de progresso:** usamos o slot `app_bottom`. Dependendo da
  versão do OpenCode, ele pode cair logo abaixo do prompt ou no rodapé da app.
  Se quiser em outro lugar, o slot é trocável em `src/tui.ts` (ex.:
  `session_prompt_right`).
- **Sem build:** o plugin é TypeScript puro; o OpenCode transpila no load.
- **Compatibilidade:** suporta as duas gerações da API de TUI do OpenCode
  (`api.slots.register` e `context.ui.slot`).

## Licença

MIT © Rafael Ferreira
