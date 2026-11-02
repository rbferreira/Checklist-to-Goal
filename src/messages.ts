// User-facing strings (pt-BR) and the two prompt builders that do the real
// behavioural work: the per-turn system rules and the idle "continue" nudge.

import type { Checklist, Task } from "./state"
import { nextPending, progress, progressBar, taskDescription, taskTitle } from "./state"

export const MESSAGES = {
  sidebarTitle: "Checklist",
  noActive: "Nenhum checklist ativo",
  objective: "Objetivo",
  complete: "✓ Objetivo concluído",
  cancelled: "Checklist cancelado",
  showCommandTitle: "Checklist: mostrar",
  showCommandDesc: "Mostra o checklist atual da sessão",
}

// Single-width glyphs: wide glyphs (☑/⚠) visually swallow the following space,
// and `▸` collided with the expand arrow. ✓ ● ○ ✗ stay one cell wide.
const SYMBOL: Record<Task["status"], string> = {
  done: "✓",
  active: "●",
  pending: "○",
  blocked: "✗",
}

export function taskSymbol(status: Task["status"]): string {
  return SYMBOL[status] ?? "☐"
}

/** Collapse whitespace and cut to `max` chars with an ellipsis. */
export function truncate(raw: string, max: number): string {
  const t = raw.trim().replace(/\s+/g, " ")
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t
}

/**
 * A short, sidebar-friendly task title. Models tend to cram the whole
 * acceptance criteria into the task text ("t1: Do X - Completion: ... Evidence:
 * ..."); the sidebar only needs the title. Strips a redundant "tN:" / "1." lead
 * and cuts at the first criteria/evidence marker or newline, then truncates.
 */
export function shortTitle(raw: string, max = 44): string {
  let s = raw.trim().replace(/^t?\d+\s*[:.)\-]\s*/i, "")
  const markers = [" - Completion", " — Completion", " Completion:", " - Evidence", " — Evidence", " Evidence:", "\n"]
  let cut = s.length
  for (const m of markers) {
    const i = s.indexOf(m)
    if (i >= 0 && i < cut) cut = i
  }
  s = s.slice(0, cut)
  return truncate(s, max)
}

/** Multi-line plain-text rendering of the whole checklist (used in prompts). */
export function renderChecklistText(cl: Checklist): string {
  const { done, total, pct } = progress(cl)
  const lines = [
    `${MESSAGES.objective}: ${cl.objective}`,
    `Progresso: ${progressBar(progress(cl).ratio)} ${done}/${total} (${pct}%)`,
    ...cl.tasks.map((t, i) => {
      const d = taskDescription(t)
      const detail = d ? ` — ${d}` : ""
      const block = t.status === "blocked" && t.blocker ? ` [bloqueio: ${t.blocker}]` : ""
      return `  ${taskSymbol(t.status)} ${i + 1}. [${t.id}] ${taskTitle(t)}${detail}${block}`
    }),
  ]
  return lines.join("\n")
}

/**
 * Injected into the system prompt on every turn while a checklist is active.
 * This is what keeps the model on-task and honest about completion.
 */
export function buildSystemRules(cl: Checklist): string {
  const active = nextPending(cl)
  const activeDesc = active ? taskDescription(active) : undefined
  return [
    "[CHECKLIST ATIVO — Checklist-to-Goal]",
    renderChecklistText(cl),
    "",
    ...(active
      ? [
          `➤ Tarefa atual [${active.id}]: ${taskTitle(active)}${activeDesc ? ` — ${activeDesc}` : ""}`,
          "Ao concluí-la com evidência concreta, chame `complete_task` e PASSE para a próxima tarefa. Não pare enquanto houver tarefas pendentes.",
          "",
        ]
      : []),
    "Regras obrigatórias enquanto este checklist estiver ativo:",
    "- Trabalhe UMA tarefa por vez, na ordem, começando pela primeira pendente (▸ ou ☐).",
    "- Uma tarefa só é dada como concluída chamando a tool `complete_task`, e SOMENTE com evidência concreta e verificável (saída de comando, trecho de arquivo, resultado de teste, resposta HTTP real). Afirmar \"feito\"/\"pronto\" NÃO é evidência.",
    "- A `evidence` deve ser UMA linha curta (até ~160 caracteres), não um parágrafo: só o fato que comprova. O detalhamento vai na resposta ao usuário, não dentro da tool.",
    "- NÃO declare o objetivo final terminado enquanto houver qualquer tarefa pendente.",
    "- Se uma tarefa estiver realmente bloqueada, chame `block_task` com o motivo e siga para a próxima possível — não a marque como concluída.",
    "- Se descobrir trabalho novo necessário, chame `add_task` em vez de ignorá-lo.",
    "- Use `get_checklist` sempre que precisar reconferir o estado e os IDs das tarefas.",
  ].join("\n")
}

/**
 * Injected into the system prompt (NOT the chat) right after `/target`, while
 * the session still has no checklist. Keeps the "how" out of the visible
 * conversation: the user only sees their own request, the model reads this.
 */
export function buildTargetKickoff(): string {
  return [
    "[Checklist-to-Goal — AÇÃO OBRIGATÓRIA ANTES DE QUALQUER RESPOSTA]",
    "O usuário acionou /target na última mensagem. Sua PRÓXIMA AÇÃO, antes de escrever qualquer resposta ao pedido, DEVE ser chamar a tool `target_create`.",
    "",
    "NÃO execute a tarefa solicitada pelo usuário antes de chamar `target_create`. Começar a executar o pedido sem antes criar o checklist é uma violação desta regra.",
    "",
    "Faça exatamente isto, nesta ordem:",
    "1. Quebre o pedido da última mensagem em tarefas curtas, concretas e verificáveis, em ordem.",
    "2. Chame `target_create` com `objective` + `tasks` (cada tarefa com `title` curto e `description` objetiva). Se o pedido apontar para um arquivo .md com itens \"- [ ]\", passe `markdownPath` no lugar de `tasks`.",
    "3. Só depois do checklist criado, comece a executar a primeira tarefa. Não declare o objetivo concluído enquanto houver tarefas pendentes.",
  ].join("\n")
}

/** Sent as a synthetic user turn when the session goes idle with work left. */
export function buildContinuation(cl: Checklist): string {
  const next = nextPending(cl)
  if (!next) return "Revise se todas as tarefas têm evidência registrada e finalize o objetivo."
  return (
    `Continue o objetivo — próxima tarefa pendente: "${truncate(taskTitle(next), 80)}". ` +
    "Execute-a e, com evidência concreta, chame complete_task (ou block_task se estiver travada). " +
    "Não pare enquanto houver pendências."
  )
}
