// Checklist-to-Goal — server half.
//
// Responsibilities:
//  1. Register the tools the model uses to drive a checklist
//     (target_create, add_task, complete_task, block_task, get_checklist,
//     clear_checklist).
//  2. Inject the `/target` and `/add_goal` slash commands via the config hook.
//  3. Inject the checklist + rules into the system prompt every turn.
//  4. Keep the model locked on the task: when the session goes idle with work
//     left, send a synthetic "continue" turn (bounded by maxAutoTurns and a
//     no-progress guard).
//
// Authored as raw TypeScript; OpenCode transpiles it at load time, so there is
// no build step. Only *type* imports come from @opencode-ai/plugin; zod is a
// real runtime dependency of this package.

import type { Hooks, Plugin, PluginInput, PluginOptions, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"

import {
  type Checklist,
  type Task,
  deleteChecklist,
  findTask,
  getChecklist,
  newTask,
  nextPending,
  progress,
  saveChecklist,
} from "./state"
import { buildContinuation, buildSystemRules, renderChecklistText } from "./messages"
import { parseMarkdownChecklist } from "./parse"

const DEFAULT_MAX_AUTO_TURNS = 200
const DEFAULT_MAX_NO_PROGRESS = 8
const CONTINUATION_DEBOUNCE_MS = 1500

// Reject "evidence" that is really just an assertion of completion.
const WEAK_EVIDENCE =
  /^(ok|done|feito|pronto|conclu[ií]do|conclu[ií]da|sim|yes|yep|terminei|finalizado|finalizada|pode marcar)\.?$/i
const MIN_EVIDENCE_LEN = 12

// In-memory, per-process bookkeeping (not persisted; safe to lose on restart).
const lastAgentBySession = new Map<string, string>()
const continuationInFlight = new Set<string>()

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function optionalNum(value: unknown, fallback: number | null): number | null {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function toolResult(cl: Checklist | null, extra: Record<string, unknown> = {}): ToolResult {
  const p = cl ? progress(cl) : { done: 0, total: 0 }
  return {
    title: cl ? `Checklist ${p.done}/${p.total}` : "Checklist",
    output: JSON.stringify({ checklist: cl, ...extra }, null, 2),
    metadata: { checklist: cl },
  }
}

async function sendContinuation(
  client: PluginInput["client"],
  sessionID: string,
  prompt: string,
  agent?: string,
): Promise<void> {
  const call = client.session.promptAsync as (input: unknown) => Promise<unknown>
  await call({
    path: { id: sessionID },
    body: {
      ...(agent ? { agent } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  })
}

const plugin: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const client = input.client
  const maxAutoTurns = optionalNum(options?.max_auto_turns, DEFAULT_MAX_AUTO_TURNS)
  const maxNoProgress = num(options?.max_no_progress, DEFAULT_MAX_NO_PROGRESS)

  // Tool definitions. Built with this package's zod; the whole map is cast to
  // the host's expected shape at the boundary (the two zod copies are the same
  // major but nominally distinct types, so a direct structural check fails even
  // though they are runtime-compatible).
  const tools = {
    target_create: {
      description:
        "Cria um objetivo rastreado por checklist para a sessão atual. Informe `objective` + `tasks` (lista de tarefas concretas e verificáveis em ordem), OU `markdownPath` apontando para um arquivo .md com itens de checklist ('- [ ] ...'). Substitui qualquer checklist anterior da sessão.",
      args: {
        objective: z.string().describe("Objetivo final, claro e único.").optional(),
        tasks: z.array(z.string()).describe("Tarefas concretas e verificáveis, na ordem de execução.").optional(),
        markdownPath: z.string().describe("Caminho de um .md com itens '- [ ]' para usar como tarefas.").optional(),
      },
      async execute(
        args: { objective?: string; tasks?: string[]; markdownPath?: string },
        ctx: ToolContext,
      ): Promise<ToolResult | string> {
        let objective = (args.objective ?? "").trim()
        let taskTexts = (args.tasks ?? []).map((t) => t.trim()).filter(Boolean)
        let source: Checklist["source"] = "context"

        if (args.markdownPath) {
          const { readFile } = await import("node:fs/promises")
          const { resolve, isAbsolute } = await import("node:path")
          const base = ctx.directory || input.directory || process.cwd()
          const abs = isAbsolute(args.markdownPath) ? args.markdownPath : resolve(base, args.markdownPath)
          const md = await readFile(abs, "utf8")
          const parsed = parseMarkdownChecklist(md)
          if (parsed.length) {
            taskTexts = parsed
            source = "markdown"
          }
          if (!objective) objective = `Concluir checklist de ${args.markdownPath}`
        }

        if (!objective) objective = "Objetivo sem título"
        if (taskTexts.length === 0) {
          return "Nenhuma tarefa fornecida. Passe `tasks` (lista) ou um `markdownPath` válido com itens '- [ ]'."
        }

        const nowTs = Date.now()
        const tasks: Task[] = taskTexts.map(newTask)
        if (tasks[0]) tasks[0].status = "active"
        const cl: Checklist = {
          sessionID: ctx.sessionID,
          objective,
          source,
          tasks,
          status: "active",
          createdAt: nowTs,
          updatedAt: nowTs,
          autoTurns: 0,
          maxAutoTurns,
          noProgressTurns: 0,
          lastDoneCount: 0,
          lastContinuationAt: null,
          lastAgent: lastAgentBySession.get(ctx.sessionID) ?? ctx.agent ?? null,
        }
        await saveChecklist(cl)
        return toolResult(cl, {
          message: `Checklist criado com ${tasks.length} tarefa(s). Comece pela primeira: "${tasks[0]?.text}".`,
        })
      },
    },

    add_task: {
      description: "Adiciona uma nova tarefa ao final do checklist ativo da sessão.",
      args: {
        text: z.string().describe("Descrição da tarefa, concreta e verificável."),
      },
      async execute(args: { text: string }, ctx: ToolContext): Promise<ToolResult | string> {
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return "Nenhum checklist ativo nesta sessão. Crie um com target_create."
        const t = newTask(args.text)
        const hasOpen = cl.tasks.some((x) => x.status === "active" || x.status === "pending")
        if (!hasOpen) t.status = "active"
        cl.tasks.push(t)
        if (cl.status === "complete") cl.status = "active"
        await saveChecklist(cl)
        return toolResult(cl, { message: `Tarefa adicionada [${t.id}]: ${t.text}` })
      },
    },

    complete_task: {
      description:
        "Marca uma tarefa como concluída. EXIGE evidência concreta e verificável (saída de comando, trecho de arquivo, resultado de teste, resposta real). Sem evidência suficiente, a conclusão é recusada.",
      args: {
        id: z.string().describe("ID da tarefa (ex.: t1a2b3c4) ou a posição (ex.: '3'). Use get_checklist se não souber."),
        evidence: z.string().describe("Evidência concreta e verificável da conclusão."),
      },
      async execute(args: { id: string; evidence: string }, ctx: ToolContext): Promise<ToolResult | string> {
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return "Nenhum checklist ativo nesta sessão. Crie um com target_create."
        const task = findTask(cl, args.id)
        if (!task) return `Tarefa "${args.id}" não encontrada. Chame get_checklist para ver os IDs.`
        const ev = (args.evidence ?? "").trim()
        if (ev.length < MIN_EVIDENCE_LEN || WEAK_EVIDENCE.test(ev)) {
          return `Evidência insuficiente para concluir "${task.text}". Forneça prova concreta (saída de comando, trecho de arquivo, resultado de teste ou resposta real) — não apenas "feito".`
        }
        task.status = "done"
        task.evidence = ev
        task.completedAt = Date.now()
        task.blocker = undefined
        const nextPend = cl.tasks.find((t) => t.status === "pending")
        if (nextPend) nextPend.status = "active"
        if (cl.tasks.every((t) => t.status === "done")) cl.status = "complete"
        await saveChecklist(cl)
        return toolResult(
          cl,
          cl.status === "complete"
            ? { message: "🎉 Todas as tarefas concluídas com evidência. Objetivo alcançado." }
            : { message: "Tarefa concluída. Siga para a próxima pendente." },
        )
      },
    },

    block_task: {
      description:
        "Marca uma tarefa como bloqueada, com o motivo. NÃO conta como concluída; use quando a tarefa não puder avançar agora.",
      args: {
        id: z.string().describe("ID da tarefa ou sua posição."),
        reason: z.string().describe("Motivo do bloqueio."),
      },
      async execute(args: { id: string; reason: string }, ctx: ToolContext): Promise<ToolResult | string> {
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return "Nenhum checklist ativo nesta sessão."
        const task = findTask(cl, args.id)
        if (!task) return `Tarefa "${args.id}" não encontrada.`
        task.status = "blocked"
        task.blocker = args.reason.trim()
        const nextPend = cl.tasks.find((t) => t.status === "pending")
        if (nextPend) nextPend.status = "active"
        await saveChecklist(cl)
        return toolResult(cl, { message: `Tarefa [${task.id}] marcada como bloqueada.` })
      },
    },

    get_checklist: {
      description: "Retorna o checklist atual da sessão (objetivo, tarefas, IDs, progresso).",
      args: {},
      async execute(_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult | string> {
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return "Nenhum checklist ativo nesta sessão."
        return toolResult(cl, { rendered: renderChecklistText(cl) })
      },
    },

    clear_checklist: {
      description: "Remove o checklist da sessão atual (encerra o acompanhamento).",
      args: {},
      async execute(_args: Record<string, never>, ctx: ToolContext): Promise<ToolResult | string> {
        await deleteChecklist(ctx.sessionID)
        return "Checklist removido desta sessão."
      },
    },
  }

  const hooks: Hooks = {
    // ---- Slash commands -----------------------------------------------------
    async config(config) {
      const c = config as typeof config & {
        command?: Record<string, { template: string; description?: string }>
      }
      c.command ??= {}
      if (!c.command.target) {
        c.command.target = {
          description: "Transforma um pedido (ou um checklist .md) em objetivo rastreado com tarefas",
          template: [
            "O usuário quer iniciar um objetivo rastreado por checklist. Contexto do pedido:",
            "",
            "$ARGUMENTS",
            "",
            "Faça AGORA, nesta ordem:",
            "1. Se o contexto apontar para um arquivo de checklist Markdown (um caminho .md, ou itens no formato \"- [ ]\"), chame a tool `target_create` passando `markdownPath` com o caminho desse arquivo (e, se útil, um `objective`).",
            "2. Caso contrário, derive um `objective` claro e único e quebre-o em `tasks`: uma lista de tarefas concretas e VERIFICÁVEIS, cada uma com critério objetivo de conclusão, na ordem de execução. Chame `target_create` com `objective` e `tasks`.",
            "",
            "Depois de criar o checklist, comece imediatamente a executar a primeira tarefa. Lembre: cada tarefa só se conclui via `complete_task` com evidência concreta.",
          ].join("\n"),
        }
      }
      if (!c.command.add_goal) {
        c.command.add_goal = {
          description: "Adiciona uma tarefa ao checklist ativo",
          template: [
            "Adicione uma nova tarefa ao checklist ativo chamando a tool `add_task` com o texto abaixo (não reinicie o objetivo, apenas acrescente ao final):",
            "",
            "$ARGUMENTS",
          ].join("\n"),
        }
      }
    },

    // ---- Per-turn system prompt injection -----------------------------------
    async "experimental.chat.system.transform"(inp, out) {
      const sessionID = inp.sessionID
      if (!sessionID) return
      const cl = await getChecklist(sessionID)
      if (cl && cl.status === "active") out.system.push(buildSystemRules(cl))
    },

    // ---- Track owning agent, to keep continuations on the same agent --------
    async "chat.message"(inp) {
      if (inp.sessionID && inp.agent) lastAgentBySession.set(inp.sessionID, inp.agent)
    },

    // ---- The lock: drive the model on idle until the checklist is done ------
    async event({ event }) {
      try {
        const e = event as { type?: string; properties?: Record<string, unknown> }
        const type = e.type
        const props = e.properties ?? {}
        const status = props.status as { type?: string } | undefined
        const isIdle = type === "session.idle" || (type === "session.status" && status?.type === "idle")
        if (!isIdle) return

        const sessionID =
          (props.sessionID as string | undefined) ??
          (props.sessionId as string | undefined) ??
          (props.session as { id?: string } | undefined)?.id
        if (typeof sessionID !== "string") return
        if (continuationInFlight.has(sessionID)) return

        const cl = await getChecklist(sessionID)
        if (!cl || cl.status !== "active") return
        const next = nextPending(cl)
        if (!next) return
        if (typeof cl.maxAutoTurns === "number" && cl.autoTurns >= cl.maxAutoTurns) return

        const now = Date.now()
        if (cl.lastContinuationAt && now - cl.lastContinuationAt < CONTINUATION_DEBOUNCE_MS) return

        // No-progress guard: if completed count hasn't moved since last cycle,
        // count it; after too many, stop auto-driving to avoid burning turns.
        const doneNow = progress(cl).done
        if (cl.autoTurns > 0 && doneNow === cl.lastDoneCount) cl.noProgressTurns += 1
        else cl.noProgressTurns = 0
        cl.lastDoneCount = doneNow
        if (cl.noProgressTurns >= maxNoProgress) {
          await saveChecklist(cl)
          return
        }

        cl.autoTurns += 1
        cl.lastContinuationAt = now
        await saveChecklist(cl)

        continuationInFlight.add(sessionID)
        try {
          const agent = cl.lastAgent ?? lastAgentBySession.get(sessionID) ?? undefined
          await sendContinuation(client, sessionID, buildContinuation(cl), agent)
        } finally {
          continuationInFlight.delete(sessionID)
        }
      } catch {
        // Never let bookkeeping throw into the host event loop.
      }
    },

    // ---- Tools (cast at the boundary; see note above) -----------------------
    tool: tools as unknown as Hooks["tool"],
  }

  return hooks
}

export default plugin
