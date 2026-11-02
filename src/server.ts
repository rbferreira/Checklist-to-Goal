// Checklist-to-Goal — server half (OpenCode V2 plugin API).
//
// Exports the V2 definition `{ id, setup }`. `setup(context)` registers
// everything through the V2 context domains:
//   * context.tool.transform    -> register the checklist tools
//   * context.command.transform  -> inject /target and /add_goal
//   * context.session.hook("context") -> inject checklist + rules into the
//     system prompt each turn
//   * context.session.hook("prompt")  -> track the owning agent
//   * context.event.subscribe    -> on session.idle, drive a continuation so
//     the model stays on the checklist until it is done
//   * context.session.prompt     -> send the synthetic continuation turn
//
// State is shared with the TUI half through the on-disk state file (see
// state.ts). Raw TypeScript; OpenCode transpiles at load, no build step.

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

const WEAK_EVIDENCE =
  /^(ok|done|feito|pronto|conclu[ií]do|conclu[ií]da|sim|yes|yep|terminei|finalizado|finalizada|pode marcar)\.?$/i
const MIN_EVIDENCE_LEN = 12

// ---- Minimal structural types for the V2 plugin context --------------------
// The shipped @opencode-ai/plugin type defs lag the runtime, so we type only
// the surface we use, matching @prevalentware/opencode-goal-plugin's usage.

interface ToolExecCtx {
  sessionID: string
  directory?: string
}
interface ToolDef {
  name: string
  description: string
  input: unknown
  options?: { codemode?: boolean }
  execute: (args: Record<string, unknown>, ctx: ToolExecCtx) => Promise<{ content: string }>
}
interface CommandInput {
  sessionID: string
  prompt?: { text?: string }
  delivery?: unknown
}
interface CommandDef {
  name: string
  description?: string
  execute: (input: CommandInput, execution?: unknown) => Promise<void>
}
interface SessionContextArg {
  sessionID?: string
  system: { type: string; text: string }[]
}
interface PromptHookInput {
  sessionID?: string
  prompt?: { text?: string; agents?: { name?: string }[] }
}
interface V2Event {
  type?: string
  data?: { sessionID?: string; status?: { type?: string }; session?: { id?: string } }
  properties?: { sessionID?: string; status?: { type?: string } }
}
interface V2Context {
  options?: Record<string, unknown>
  directory?: string
  tool: { transform: (fn: (draft: { add: (t: ToolDef) => void }) => void) => Promise<unknown> }
  command: {
    list?: () => Promise<{ data: { name: string }[] }>
    transform: (fn: (draft: { add: (c: CommandDef) => void }) => void) => Promise<unknown>
  }
  session: {
    hook: (name: string, cb: (arg: never) => void | Promise<void>) => Promise<unknown>
    prompt: (input: { sessionID: string; text: string; agents?: { name: string }[]; delivery?: unknown }) => Promise<unknown>
  }
  event: { subscribe: (opts: { signal: AbortSignal }) => AsyncIterable<unknown> }
}

// ---- Helpers ---------------------------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
function optionalNum(value: unknown, fallback: number | null): number | null {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

/** Build a JSON-Schema object (the shape V2 tools expect for `input`). */
function obj(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required, additionalProperties: false }
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === "string" ? v : undefined
}

function jsonContent(cl: Checklist | null, extra: Record<string, unknown> = {}): { content: string } {
  return { content: JSON.stringify({ checklist: cl, ...extra }, null, 2) }
}

// ---- Command templates -----------------------------------------------------

const TEMPLATE_TARGET = [
  "O usuário quer iniciar um objetivo rastreado por checklist. Contexto do pedido:",
  "",
  "$ARGUMENTS",
  "",
  "Faça AGORA, nesta ordem:",
  "1. Se o contexto apontar para um arquivo de checklist Markdown (um caminho .md, ou itens no formato \"- [ ]\"), chame a tool `target_create` passando `markdownPath` com o caminho desse arquivo (e, se útil, um `objective`).",
  "2. Caso contrário, derive um `objective` claro e único e quebre-o em `tasks`: uma lista de tarefas concretas e VERIFICÁVEIS, cada uma com critério objetivo de conclusão, na ordem de execução. Chame `target_create` com `objective` e `tasks`.",
  "",
  "Depois de criar o checklist, comece imediatamente a executar a primeira tarefa. Lembre: cada tarefa só se conclui via `complete_task` com evidência concreta.",
].join("\n")

const TEMPLATE_ADD_GOAL = [
  "Adicione uma nova tarefa ao checklist ativo chamando a tool `add_task` com o texto abaixo (não reinicie o objetivo, apenas acrescente ao final):",
  "",
  "$ARGUMENTS",
].join("\n")

// ---- Tools -----------------------------------------------------------------

function buildTools(
  defaults: { maxAutoTurns: number | null },
  lastAgentBySession: Map<string, string>,
): ToolDef[] {
  return [
    {
      name: "target_create",
      description:
        "Cria um objetivo rastreado por checklist para a sessão atual. Informe `objective` + `tasks` (lista de tarefas concretas e verificáveis em ordem), OU `markdownPath` apontando para um arquivo .md com itens de checklist ('- [ ] ...'). Substitui qualquer checklist anterior da sessão.",
      input: obj({
        objective: { type: "string", description: "Objetivo final, claro e único." },
        tasks: { type: "array", items: { type: "string" }, description: "Tarefas concretas e verificáveis, na ordem de execução." },
        markdownPath: { type: "string", description: "Caminho de um .md com itens '- [ ]' para usar como tarefas." },
      }),
      options: { codemode: false },
      async execute(args, ctx) {
        let objective = (str(args, "objective") ?? "").trim()
        const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
        let taskTexts = rawTasks.map((t) => String(t).trim()).filter(Boolean)
        let source: Checklist["source"] = "context"
        const markdownPath = str(args, "markdownPath")

        if (markdownPath) {
          const { readFile } = await import("node:fs/promises")
          const { resolve, isAbsolute } = await import("node:path")
          const base = ctx.directory || process.cwd()
          const abs = isAbsolute(markdownPath) ? markdownPath : resolve(base, markdownPath)
          const md = await readFile(abs, "utf8")
          const parsed = parseMarkdownChecklist(md)
          if (parsed.length) {
            taskTexts = parsed
            source = "markdown"
          }
          if (!objective) objective = `Concluir checklist de ${markdownPath}`
        }

        if (!objective) objective = "Objetivo sem título"
        if (taskTexts.length === 0) {
          return { content: "Nenhuma tarefa fornecida. Passe `tasks` (lista) ou um `markdownPath` válido com itens '- [ ]'." }
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
          maxAutoTurns: defaults.maxAutoTurns,
          noProgressTurns: 0,
          lastDoneCount: 0,
          lastContinuationAt: null,
          lastAgent: lastAgentBySession.get(ctx.sessionID) ?? null,
        }
        await saveChecklist(cl)
        return jsonContent(cl, {
          message: `Checklist criado com ${tasks.length} tarefa(s). Comece pela primeira: "${tasks[0]?.text}".`,
        })
      },
    },

    {
      name: "add_task",
      description: "Adiciona uma nova tarefa ao final do checklist ativo da sessão.",
      input: obj({ text: { type: "string", description: "Descrição da tarefa, concreta e verificável." } }, ["text"]),
      options: { codemode: false },
      async execute(args, ctx) {
        const text = str(args, "text") ?? ""
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return { content: "Nenhum checklist ativo nesta sessão. Crie um com target_create." }
        const t = newTask(text)
        const hasOpen = cl.tasks.some((x) => x.status === "active" || x.status === "pending")
        if (!hasOpen) t.status = "active"
        cl.tasks.push(t)
        if (cl.status === "complete") cl.status = "active"
        await saveChecklist(cl)
        return jsonContent(cl, { message: `Tarefa adicionada [${t.id}]: ${t.text}` })
      },
    },

    {
      name: "complete_task",
      description:
        "Marca uma tarefa como concluída. EXIGE evidência concreta e verificável (saída de comando, trecho de arquivo, resultado de teste, resposta real). Sem evidência suficiente, a conclusão é recusada.",
      input: obj(
        {
          id: { type: "string", description: "ID da tarefa (ex.: t1a2b3c4) ou a posição (ex.: '3'). Use get_checklist se não souber." },
          evidence: { type: "string", description: "Evidência concreta e verificável da conclusão." },
        },
        ["id", "evidence"],
      ),
      options: { codemode: false },
      async execute(args, ctx) {
        const id = str(args, "id") ?? ""
        const evidence = str(args, "evidence") ?? ""
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return { content: "Nenhum checklist ativo nesta sessão. Crie um com target_create." }
        const task = findTask(cl, id)
        if (!task) return { content: `Tarefa "${id}" não encontrada. Chame get_checklist para ver os IDs.` }
        const ev = evidence.trim()
        if (ev.length < MIN_EVIDENCE_LEN || WEAK_EVIDENCE.test(ev)) {
          return {
            content: `Evidência insuficiente para concluir "${task.text}". Forneça prova concreta (saída de comando, trecho de arquivo, resultado de teste ou resposta real) — não apenas "feito".`,
          }
        }
        task.status = "done"
        task.evidence = ev
        task.completedAt = Date.now()
        task.blocker = undefined
        const nextPend = cl.tasks.find((t) => t.status === "pending")
        if (nextPend) nextPend.status = "active"
        if (cl.tasks.every((t) => t.status === "done")) cl.status = "complete"
        await saveChecklist(cl)
        return jsonContent(cl, {
          message:
            cl.status === "complete"
              ? "🎉 Todas as tarefas concluídas com evidência. Objetivo alcançado."
              : "Tarefa concluída. Siga para a próxima pendente.",
        })
      },
    },

    {
      name: "block_task",
      description:
        "Marca uma tarefa como bloqueada, com o motivo. NÃO conta como concluída; use quando a tarefa não puder avançar agora.",
      input: obj(
        { id: { type: "string", description: "ID da tarefa ou sua posição." }, reason: { type: "string", description: "Motivo do bloqueio." } },
        ["id", "reason"],
      ),
      options: { codemode: false },
      async execute(args, ctx) {
        const id = str(args, "id") ?? ""
        const reason = str(args, "reason") ?? ""
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return { content: "Nenhum checklist ativo nesta sessão." }
        const task = findTask(cl, id)
        if (!task) return { content: `Tarefa "${id}" não encontrada.` }
        task.status = "blocked"
        task.blocker = reason.trim()
        const nextPend = cl.tasks.find((t) => t.status === "pending")
        if (nextPend) nextPend.status = "active"
        await saveChecklist(cl)
        return jsonContent(cl, { message: `Tarefa [${task.id}] marcada como bloqueada.` })
      },
    },

    {
      name: "get_checklist",
      description: "Retorna o checklist atual da sessão (objetivo, tarefas, IDs, progresso).",
      input: obj({}),
      options: { codemode: false },
      async execute(_args, ctx) {
        const cl = await getChecklist(ctx.sessionID)
        if (!cl) return { content: "Nenhum checklist ativo nesta sessão." }
        return jsonContent(cl, { rendered: renderChecklistText(cl) })
      },
    },

    {
      name: "clear_checklist",
      description: "Remove o checklist da sessão atual (encerra o acompanhamento).",
      input: obj({}),
      options: { codemode: false },
      async execute(_args, ctx) {
        await deleteChecklist(ctx.sessionID)
        return { content: "Checklist removido desta sessão." }
      },
    },
  ]
}

// ---- Setup -----------------------------------------------------------------

async function setup(context: V2Context): Promise<() => Promise<void>> {
  const options = context.options ?? {}
  const maxAutoTurns = optionalNum(options.max_auto_turns, DEFAULT_MAX_AUTO_TURNS)
  const maxNoProgress = num(options.max_no_progress, DEFAULT_MAX_NO_PROGRESS)

  const lastAgentBySession = new Map<string, string>()
  const continuationInFlight = new Set<string>()
  let disposed = false

  // Tools
  await context.tool.transform((draft) => {
    for (const t of buildTools({ maxAutoTurns }, lastAgentBySession)) draft.add(t)
  })

  // Commands (/target, /add_goal) — skip names already defined elsewhere.
  let existing = new Set<string>()
  try {
    if (context.command.list) existing = new Set((await context.command.list()).data.map((c) => c.name))
  } catch {
    /* ignore */
  }
  await context.command.transform((draft) => {
    const defs: { name: string; description: string; template: string }[] = [
      { name: "target", description: "Transforma um pedido (ou um checklist .md) em objetivo rastreado com tarefas", template: TEMPLATE_TARGET },
      { name: "add_goal", description: "Adiciona uma tarefa ao checklist ativo", template: TEMPLATE_ADD_GOAL },
    ]
    for (const def of defs) {
      if (existing.has(def.name)) continue
      draft.add({
        name: def.name,
        description: def.description,
        execute: async (input) => {
          const args = (input.prompt?.text ?? "").trim()
          await context.session.prompt({
            sessionID: input.sessionID,
            text: def.template.replaceAll("$ARGUMENTS", args),
            delivery: input.delivery,
          })
        },
      })
    }
  })

  // Inject checklist + rules into the system prompt each turn.
  await context.session.hook("context", (async (sc: SessionContextArg) => {
    const sid = sc.sessionID
    if (!sid || !Array.isArray(sc.system)) return
    const cl = await getChecklist(sid)
    if (cl && cl.status === "active") sc.system.push({ type: "text", text: buildSystemRules(cl) })
  }) as (arg: never) => Promise<void>)

  // Track the owning agent so continuations stay on the same agent.
  await context.session.hook("prompt", (async (input: PromptHookInput) => {
    const sid = input.sessionID
    const agent = input.prompt?.agents?.[0]?.name
    if (sid && typeof agent === "string") lastAgentBySession.set(sid, agent)
  }) as (arg: never) => Promise<void>)

  // The lock: drive a continuation when the session goes idle with work left.
  async function maybeContinue(sessionID: string): Promise<void> {
    if (continuationInFlight.has(sessionID)) return
    const cl = await getChecklist(sessionID)
    if (!cl || cl.status !== "active") return
    const next = nextPending(cl)
    if (!next) return
    if (typeof cl.maxAutoTurns === "number" && cl.autoTurns >= cl.maxAutoTurns) return
    const now = Date.now()
    if (cl.lastContinuationAt && now - cl.lastContinuationAt < CONTINUATION_DEBOUNCE_MS) return

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
      const agent = cl.lastAgent ?? lastAgentBySession.get(sessionID)
      await context.session.prompt({
        sessionID,
        text: buildContinuation(cl),
        ...(agent ? { agents: [{ name: agent }] } : {}),
      })
    } finally {
      continuationInFlight.delete(sessionID)
    }
  }

  const abort = new AbortController()
  void (async () => {
    try {
      for await (const value of context.event.subscribe({ signal: abort.signal })) {
        if (disposed) break
        const ev = value as V2Event
        const type = ev.type
        const data: { sessionID?: string; status?: { type?: string }; session?: { id?: string } } =
          ev.data ?? ev.properties ?? {}
        const sid =
          typeof data.sessionID === "string"
            ? data.sessionID
            : typeof data.session?.id === "string"
              ? data.session.id
              : undefined
        const isIdle = type === "session.idle" || (type === "session.status" && data.status?.type === "idle")
        if (!isIdle || !sid) continue
        try {
          await maybeContinue(sid)
        } catch {
          /* never throw into the event loop */
        }
      }
    } catch {
      /* subscription ended / aborted */
    }
  })()

  return async () => {
    disposed = true
    abort.abort()
  }
}

const plugin = {
  id: "local.checklist-to-goal.server",
  setup,
}

export default plugin
