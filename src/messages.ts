// User- and model-facing strings, bilingual (English default, pt-BR opt-in).
//
// Everything a human or the model ever reads lives here, keyed by language:
//   * UI[lang]        — sidebar / command-palette / render labels (TUI)
//   * TOOLS[lang]     — tool + command descriptions, tool-call headers, and the
//                       messages the tools return to the model (server)
//   * the builders    — the per-turn system rules, the /target kickoff and the
//                       idle "continue" nudge, which do the real behavioural work
//
// The active language comes from the plugin option `language` ("en" | "pt"),
// resolved with resolveLang(); the server also stores it on the checklist
// (state.ts `lang`) so the TUI renders in the same language.

import type { Checklist, Lang, Task } from "./state"
import { nextPending, progress, progressBar, taskDescription, taskTitle } from "./state"

/** Resolve a free-form option value to a supported language. Default: English. */
export function resolveLang(value: unknown): Lang {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (v.startsWith("pt")) return "pt"
    if (v.startsWith("en")) return "en"
  }
  return "en"
}

// ---- UI labels (TUI: sidebar, progress render, command palette) ------------

interface UiStrings {
  sidebarTitle: string
  noActive: string
  objective: string
  progress: string
  complete: string
  cancelled: string
  showCommandTitle: string
  showCommandDesc: string
  blockedTag: (reason: string) => string
}

const UI: Record<Lang, UiStrings> = {
  en: {
    sidebarTitle: "Checklist",
    noActive: "No active checklist",
    objective: "Objective",
    progress: "Progress",
    complete: "✓ Objective complete",
    cancelled: "Checklist cancelled",
    showCommandTitle: "Checklist: show",
    showCommandDesc: "Show the session's current checklist",
    blockedTag: (reason) => ` [blocked: ${reason}]`,
  },
  pt: {
    sidebarTitle: "Checklist",
    noActive: "Nenhum checklist ativo",
    objective: "Objetivo",
    progress: "Progresso",
    complete: "✓ Objetivo concluído",
    cancelled: "Checklist cancelado",
    showCommandTitle: "Checklist: mostrar",
    showCommandDesc: "Mostra o checklist atual da sessão",
    blockedTag: (reason) => ` [bloqueio: ${reason}]`,
  },
}

/** UI string bundle for a language. */
export function ui(lang: Lang): UiStrings {
  return UI[lang]
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
export function renderChecklistText(cl: Checklist, lang: Lang): string {
  const u = UI[lang]
  const { done, total, pct } = progress(cl)
  const lines = [
    `${u.objective}: ${cl.objective}`,
    `${u.progress}: ${progressBar(progress(cl).ratio)} ${done}/${total} (${pct}%)`,
    ...cl.tasks.map((t, i) => {
      const d = taskDescription(t)
      const detail = d ? ` — ${d}` : ""
      const block = t.status === "blocked" && t.blocker ? u.blockedTag(t.blocker) : ""
      return `  ${taskSymbol(t.status)} ${i + 1}. [${t.id}] ${taskTitle(t)}${detail}${block}`
    }),
  ]
  return lines.join("\n")
}

// ---- Behavioural prompt builders -------------------------------------------

/**
 * Injected into the system prompt on every turn while a checklist is active.
 * This is what keeps the model on-task and honest about completion.
 */
export function buildSystemRules(cl: Checklist, lang: Lang): string {
  const active = nextPending(cl)
  const activeDesc = active ? taskDescription(active) : undefined
  const body = renderChecklistText(cl, lang)
  if (lang === "pt") {
    return [
      "[CHECKLIST ATIVO — Checklist-to-Goal]",
      body,
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
  return [
    "[ACTIVE CHECKLIST — Checklist-to-Goal]",
    body,
    "",
    ...(active
      ? [
          `➤ Current task [${active.id}]: ${taskTitle(active)}${activeDesc ? ` — ${activeDesc}` : ""}`,
          "Once it is done with concrete evidence, call `complete_task` and MOVE ON to the next task. Do not stop while there are pending tasks.",
          "",
        ]
      : []),
    "Mandatory rules while this checklist is active:",
    "- Work on ONE task at a time, in order, starting with the first pending one (▸ or ☐).",
    "- A task is only considered done by calling the `complete_task` tool, and ONLY with concrete, verifiable evidence (command output, file excerpt, test result, real HTTP response). Claiming \"done\"/\"finished\" is NOT evidence.",
    "- `evidence` must be ONE short line (up to ~160 characters), not a paragraph: just the fact that proves it. The detail goes in your reply to the user, not inside the tool.",
    "- Do NOT declare the final objective finished while any task is still pending.",
    "- If a task is genuinely blocked, call `block_task` with the reason and move on to the next possible one — do not mark it done.",
    "- If you discover new work that is needed, call `add_task` instead of ignoring it.",
    "- Use `get_checklist` whenever you need to re-check the state and the task IDs.",
  ].join("\n")
}

/**
 * Injected into the system prompt (NOT the chat) right after `/target`, while
 * the session still has no checklist. Keeps the "how" out of the visible
 * conversation: the user only sees their own request, the model reads this.
 */
export function buildTargetKickoff(lang: Lang): string {
  if (lang === "pt") {
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
  return [
    "[Checklist-to-Goal — MANDATORY ACTION BEFORE ANY RESPONSE]",
    "The user triggered /target in the last message. Your NEXT ACTION, before writing any response to the request, MUST be to call the `target_create` tool.",
    "",
    "Do NOT carry out the task the user asked for before calling `target_create`. Starting to execute the request without first creating the checklist is a violation of this rule.",
    "",
    "Do exactly this, in this order:",
    "1. Break the request in the last message into short, concrete, verifiable tasks, in order.",
    "2. Call `target_create` with `objective` + `tasks` (each task with a short `title` and an objective `description`). If the request points to a .md file with \"- [ ]\" items, pass `markdownPath` instead of `tasks`.",
    "3. Only after the checklist is created, start executing the first task. Do not declare the objective done while there are pending tasks.",
  ].join("\n")
}

/** Sent as a synthetic user turn when the session goes idle with work left. */
export function buildContinuation(cl: Checklist, lang: Lang): string {
  const next = nextPending(cl)
  if (lang === "pt") {
    if (!next) return "Revise se todas as tarefas têm evidência registrada e finalize o objetivo."
    return (
      `Continue o objetivo — próxima tarefa pendente: "${truncate(taskTitle(next), 80)}". ` +
      "Execute-a e, com evidência concreta, chame complete_task (ou block_task se estiver travada). " +
      "Não pare enquanto houver pendências."
    )
  }
  if (!next) return "Review whether every task has evidence recorded and finish the objective."
  return (
    `Continue the objective — next pending task: "${truncate(taskTitle(next), 80)}". ` +
    "Carry it out and, with concrete evidence, call complete_task (or block_task if it is stuck). " +
    "Do not stop while there are pending items."
  )
}

// ---- Tool- and command-facing strings (server) -----------------------------

export interface ToolStrings {
  // Tool descriptions + JSON-Schema param descriptions
  targetCreateDesc: string
  objectiveParam: string
  tasksParam: string
  taskTitleParam: string
  taskDescParam: string
  markdownPathParam: string
  addTaskDesc: string
  addTaskTextParam: string
  completeTaskDesc: string
  completeIdParam: string
  evidenceParam: string
  blockTaskDesc: string
  blockIdParam: string
  blockReasonParam: string
  getChecklistDesc: string
  clearChecklistDesc: string
  // Command descriptions
  cmdTarget: string
  cmdAddGoal: string
  cmdTargetCancel: string
  // Compact chat headers for our tool calls (execute.after hook)
  titles: Record<string, string>
  // Return messages (some interpolate)
  noTasks: string
  untitledObjective: string
  markdownObjective: (path: string) => string
  created: (n: number, firstTitle: string) => string
  noChecklistHint: string
  noChecklist: string
  taskAdded: (id: string, title: string) => string
  taskNotFoundHint: (id: string) => string
  taskNotFound: (id: string) => string
  weakEvidence: (title: string) => string
  allDone: string
  completedNext: (nextTitle: string) => string
  blocked: (id: string) => string
  removed: string
}

const TOOLS: Record<Lang, ToolStrings> = {
  en: {
    targetCreateDesc:
      "Create a checklist-tracked goal for the current session. Provide `objective` + `tasks` (each task with a short `title` and an objective `description`, in order), OR `markdownPath` pointing to a .md file with checklist items ('- [ ] ...'). Replaces any previous checklist for the session.",
    objectiveParam: "The single, clear final objective.",
    tasksParam: "Tasks in execution order; each with a short title and an objective description.",
    taskTitleParam: "Short, imperative title (≤ ~6 words).",
    taskDescParam: "What to do / the objective completion criterion (concise).",
    markdownPathParam: "Path to a .md file with '- [ ]' items to use as tasks.",
    addTaskDesc: "Append a new task to the end of the session's active checklist.",
    addTaskTextParam: "Task description — concrete and verifiable.",
    completeTaskDesc:
      "Mark a task as done. REQUIRES concrete, verifiable evidence (command output, file excerpt, test result, real response). Without sufficient evidence, completion is refused.",
    completeIdParam: "Task ID (e.g. t1a2b3c4) or its position (e.g. '3'). Use get_checklist if unsure.",
    evidenceParam:
      "Concrete, verifiable evidence in ONE short, objective line (up to ~160 characters): the fact that proves completion (command output, file path+excerpt, test result, real response). Do not write paragraphs or repeat the plan.",
    blockTaskDesc:
      "Mark a task as blocked, with the reason. Does NOT count as done; use when the task cannot move forward now.",
    blockIdParam: "Task ID or its position.",
    blockReasonParam: "Reason for the block.",
    getChecklistDesc: "Return the session's current checklist (objective, tasks, IDs, progress).",
    clearChecklistDesc: "Remove the current session's checklist (stop tracking).",
    cmdTarget: "Turn a request (or a .md checklist) into a tracked goal",
    cmdAddGoal: "Add a task to the active checklist (updates the sidebar; does not invoke the model)",
    cmdTargetCancel: "Cancel and remove the session's active checklist (does not invoke the model)",
    titles: {
      target_create: "🎯 Checklist created",
      add_task: "＋ Task added",
      complete_task: "✓ Task done",
      block_task: "✗ Task blocked",
      get_checklist: "☰ Checklist",
      clear_checklist: "✗ Checklist removed",
    },
    noTasks: "No tasks provided. Pass `tasks` (with title/description) or a valid `markdownPath` with '- [ ]' items.",
    untitledObjective: "Untitled objective",
    markdownObjective: (path) => `Complete checklist from ${path}`,
    created: (n, first) => `Checklist created with ${n} task(s). Start with the first one: "${first}".`,
    noChecklistHint: "No active checklist in this session. Create one with target_create.",
    noChecklist: "No active checklist in this session.",
    taskAdded: (id, title) => `Task added [${id}]: ${title}`,
    taskNotFoundHint: (id) => `Task "${id}" not found. Call get_checklist to see the IDs.`,
    taskNotFound: (id) => `Task "${id}" not found.`,
    weakEvidence: (title) =>
      `Insufficient evidence to complete "${title}". Provide concrete proof (command output, file excerpt, test result or real response) — not just "done".`,
    allDone: "🎉 All tasks completed with evidence. Objective achieved.",
    completedNext: (next) => `Task done. Next: "${next}". Continue now.`,
    blocked: (id) => `Task [${id}] marked as blocked.`,
    removed: "Checklist removed from this session.",
  },
  pt: {
    targetCreateDesc:
      "Cria um objetivo rastreado por checklist para a sessão atual. Informe `objective` + `tasks` (cada tarefa com um `title` curto e uma `description` objetiva, em ordem), OU `markdownPath` apontando para um arquivo .md com itens de checklist ('- [ ] ...'). Substitui qualquer checklist anterior da sessão.",
    objectiveParam: "Objetivo final, claro e único.",
    tasksParam: "Tarefas em ordem de execução; cada uma com um título curto e uma descrição objetiva.",
    taskTitleParam: "Título curto e imperativo (≤ ~6 palavras).",
    taskDescParam: "O que fazer / critério objetivo de conclusão (conciso).",
    markdownPathParam: "Caminho de um .md com itens '- [ ]' para usar como tarefas.",
    addTaskDesc: "Adiciona uma nova tarefa ao final do checklist ativo da sessão.",
    addTaskTextParam: "Descrição da tarefa, concreta e verificável.",
    completeTaskDesc:
      "Marca uma tarefa como concluída. EXIGE evidência concreta e verificável (saída de comando, trecho de arquivo, resultado de teste, resposta real). Sem evidência suficiente, a conclusão é recusada.",
    completeIdParam: "ID da tarefa (ex.: t1a2b3c4) ou a posição (ex.: '3'). Use get_checklist se não souber.",
    evidenceParam:
      "Evidência concreta e verificável em UMA linha curta e objetiva (até ~160 caracteres): o fato que comprova a conclusão (saída de comando, caminho+trecho de arquivo, resultado de teste, resposta real). Não escreva parágrafos nem repita o plano.",
    blockTaskDesc:
      "Marca uma tarefa como bloqueada, com o motivo. NÃO conta como concluída; use quando a tarefa não puder avançar agora.",
    blockIdParam: "ID da tarefa ou sua posição.",
    blockReasonParam: "Motivo do bloqueio.",
    getChecklistDesc: "Retorna o checklist atual da sessão (objetivo, tarefas, IDs, progresso).",
    clearChecklistDesc: "Remove o checklist da sessão atual (encerra o acompanhamento).",
    cmdTarget: "Transforma um pedido (ou um checklist .md) em objetivo rastreado",
    cmdAddGoal: "Adiciona uma tarefa ao checklist ativo (atualiza a sidebar; não aciona o modelo)",
    cmdTargetCancel: "Cancela e remove o checklist ativo da sessão (não aciona o modelo)",
    titles: {
      target_create: "🎯 Checklist criado",
      add_task: "＋ Tarefa adicionada",
      complete_task: "✓ Tarefa concluída",
      block_task: "✗ Tarefa bloqueada",
      get_checklist: "☰ Checklist",
      clear_checklist: "✗ Checklist removido",
    },
    noTasks: "Nenhuma tarefa fornecida. Passe `tasks` (com title/description) ou um `markdownPath` válido com itens '- [ ]'.",
    untitledObjective: "Objetivo sem título",
    markdownObjective: (path) => `Concluir checklist de ${path}`,
    created: (n, first) => `Checklist criado com ${n} tarefa(s). Comece pela primeira: "${first}".`,
    noChecklistHint: "Nenhum checklist ativo nesta sessão. Crie um com target_create.",
    noChecklist: "Nenhum checklist ativo nesta sessão.",
    taskAdded: (id, title) => `Tarefa adicionada [${id}]: ${title}`,
    taskNotFoundHint: (id) => `Tarefa "${id}" não encontrada. Chame get_checklist para ver os IDs.`,
    taskNotFound: (id) => `Tarefa "${id}" não encontrada.`,
    weakEvidence: (title) =>
      `Evidência insuficiente para concluir "${title}". Forneça prova concreta (saída de comando, trecho de arquivo, resultado de teste ou resposta real) — não apenas "feito".`,
    allDone: "🎉 Todas as tarefas concluídas com evidência. Objetivo alcançado.",
    completedNext: (next) => `Tarefa concluída. Próxima: "${next}". Continue agora.`,
    blocked: (id) => `Tarefa [${id}] marcada como bloqueada.`,
    removed: "Checklist removido desta sessão.",
  },
}

/** Tool/command string bundle for a language. */
export function toolStrings(lang: Lang): ToolStrings {
  return TOOLS[lang]
}
