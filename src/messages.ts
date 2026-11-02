// User-facing strings (pt-BR) and the two prompt builders that do the real
// behavioural work: the per-turn system rules and the idle "continue" nudge.

import type { Checklist, Task } from "./state"
import { nextPending, progress, progressBar } from "./state"

export const MESSAGES = {
  sidebarTitle: "Checklist",
  noActive: "Nenhum checklist ativo",
  objective: "Objetivo",
  complete: "✓ Objetivo concluído",
  cancelled: "Checklist cancelado",
  showCommandTitle: "Checklist: mostrar",
  showCommandDesc: "Mostra o checklist atual da sessão",
}

const SYMBOL: Record<Task["status"], string> = {
  done: "☑",
  active: "▸",
  pending: "☐",
  blocked: "⚠",
}

export function taskSymbol(status: Task["status"]): string {
  return SYMBOL[status] ?? "☐"
}

/** Multi-line plain-text rendering of the whole checklist (used in prompts). */
export function renderChecklistText(cl: Checklist): string {
  const { done, total, pct } = progress(cl)
  const lines = [
    `${MESSAGES.objective}: ${cl.objective}`,
    `Progresso: ${progressBar(progress(cl).ratio)} ${done}/${total} (${pct}%)`,
    ...cl.tasks.map((t, i) => {
      const extra =
        t.status === "blocked" && t.blocker ? ` — bloqueio: ${t.blocker}` : ""
      return `  ${taskSymbol(t.status)} ${i + 1}. [${t.id}] ${t.text}${extra}`
    }),
  ]
  return lines.join("\n")
}

/**
 * Injected into the system prompt on every turn while a checklist is active.
 * This is what keeps the model on-task and honest about completion.
 */
export function buildSystemRules(cl: Checklist): string {
  return [
    "[CHECKLIST ATIVO — Checklist-to-Goal]",
    renderChecklistText(cl),
    "",
    "Regras obrigatórias enquanto este checklist estiver ativo:",
    "- Trabalhe UMA tarefa por vez, na ordem, começando pela primeira pendente (▸ ou ☐).",
    "- Uma tarefa só é dada como concluída chamando a tool `complete_task`, e SOMENTE com evidência concreta e verificável (saída de comando, trecho de arquivo, resultado de teste, resposta HTTP real). Afirmar \"feito\"/\"pronto\" NÃO é evidência.",
    "- NÃO declare o objetivo final terminado enquanto houver qualquer tarefa pendente.",
    "- Se uma tarefa estiver realmente bloqueada, chame `block_task` com o motivo e siga para a próxima possível — não a marque como concluída.",
    "- Se descobrir trabalho novo necessário, chame `add_task` em vez de ignorá-lo.",
    "- Use `get_checklist` sempre que precisar reconferir o estado e os IDs das tarefas.",
  ].join("\n")
}

/** Sent as a synthetic user turn when the session goes idle with work left. */
export function buildContinuation(cl: Checklist): string {
  const next = nextPending(cl)
  const { done, total } = progress(cl)
  if (!next) {
    return "[continuar checklist] Revise se todas as tarefas têm evidência registrada e finalize o objetivo."
  }
  return [
    `[continuar checklist — ${done}/${total} concluídas]`,
    "Ainda há tarefas pendentes; não pare agora.",
    `Próxima tarefa [${next.id}]: "${next.text}".`,
    "Execute-a agora. Quando tiver evidência concreta, chame complete_task(id, evidence).",
    "Se estiver bloqueada, chame block_task(id, reason) e siga para a próxima.",
  ].join(" ")
}
