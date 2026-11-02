// Checklist-to-Goal — TUI half.
//
// Renders two things from the shared state file (polled every second):
//   * sidebar_content : the full checklist (objective, progress bar, every task)
//   * app_bottom       : a compact progress bar + current task, under the prompt
//
// Supports both TUI plugin-API generations the way the goal plugin does:
//   * V1: `tui` export -> api.slots.register(...) with snake_case slot names
//   * V2: `setup` export -> context.ui.slot(...) with dotted slot names
//
// Rendering uses OpenTUI's imperative element API (createElement/insert/setProp),
// not JSX, so no JSX build config is needed.

import type { TuiCommand, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"

import { type Checklist, getChecklist, nextPending, progress, progressBar } from "./state"
import { MESSAGES, taskSymbol } from "./messages"

type ElementChild = string | number | boolean | null | undefined | object | (() => ElementChild)

function element(tag: string, props: Record<string, unknown>, children: ElementChild[] = []) {
  const node = createElement(tag)
  for (const [key, value] of Object.entries(props)) if (value !== undefined) setProp(node, key, value)
  for (const child of children) if (child !== null && child !== undefined && child !== false) insert(node, child)
  return node
}

function text(props: Record<string, unknown>, children: ElementChild[]) {
  return element("text", props, children)
}

function box(props: Record<string, unknown>, children: ElementChild[] = []) {
  return element("box", props, children)
}

// --- Shared state polling ----------------------------------------------------

/** Reactive signal that re-reads the checklist for a session every second. */
function usePolledChecklist(sessionID: string | undefined) {
  const [cl, setCl] = createSignal<Checklist | null>(null)
  let disposed = false
  const refresh = async () => {
    const c = sessionID ? await getChecklist(sessionID) : null
    if (!disposed) setCl(() => c)
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 1000)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })
  return cl
}

/** Reactive signal that re-derives the *current* session + its checklist. */
function usePolledCurrentChecklist(getSessionID: () => string | undefined) {
  const [cl, setCl] = createSignal<Checklist | null>(null)
  let disposed = false
  const refresh = async () => {
    const sid = getSessionID()
    const c = sid ? await getChecklist(sid) : null
    if (!disposed) setCl(() => c)
  }
  void refresh()
  const timer = setInterval(() => void refresh(), 1000)
  onCleanup(() => {
    disposed = true
    clearInterval(timer)
  })
  return cl
}

// --- V1 TUI (api.slots.register) --------------------------------------------

function currentSessionIDV1(api: TuiPluginApi): string | undefined {
  const route = api.route?.current
  if (!route || route.name !== "session") return undefined
  const sid = (route.params as { sessionID?: unknown } | undefined)?.sessionID
  return typeof sid === "string" ? sid : undefined
}

function ChecklistSidebarV1(api: TuiPluginApi, sessionID: string) {
  const theme = api.theme.current
  const cl = usePolledChecklist(sessionID)
  return box({}, [
    () => {
      const c = cl()
      if (!c) return null
      const { done, total, ratio, pct } = progress(c)
      const headColor =
        c.status === "complete" ? theme.success : c.status === "cancelled" ? theme.textMuted : theme.text
      const children: ElementChild[] = [
        text({ fg: headColor }, [MESSAGES.sidebarTitle]),
        text({ fg: c.status === "complete" ? theme.success : theme.primary }, [
          `${progressBar(ratio)} ${done}/${total} · ${pct}%`,
        ]),
        text({ fg: theme.textMuted }, [c.objective]),
      ]
      for (let i = 0; i < c.tasks.length; i++) {
        const t = c.tasks[i]
        const fg =
          t.status === "done"
            ? theme.textMuted
            : t.status === "active"
              ? theme.primary
              : t.status === "blocked"
                ? theme.warning
                : theme.text
        children.push(text({ fg }, [`${taskSymbol(t.status)} ${i + 1}. ${t.text}`]))
      }
      return box({}, children)
    },
  ])
}

function ProgressBadgeV1(api: TuiPluginApi) {
  const theme = api.theme.current
  const cl = usePolledCurrentChecklist(() => currentSessionIDV1(api))
  return box({}, [
    () => {
      const c = cl()
      if (!c || (c.status !== "active" && c.status !== "complete")) return null
      const { ratio, pct } = progress(c)
      const next = nextPending(c)
      const label = c.status === "complete" ? MESSAGES.complete : next ? next.text : ""
      return text({ fg: c.status === "complete" ? theme.success : theme.primary }, [
        `C2G ${progressBar(ratio, 10)} ${pct}%${label ? ` ▸ ${label}` : ""}`,
      ])
    },
  ])
}

function registerCommandV1(api: TuiPluginApi, command: TuiCommand) {
  const modern = api as TuiPluginApi & {
    keymap?: {
      registerLayer?: (layer: {
        commands: { namespace: string; name: string; title: string; desc?: string; category?: string; run?: () => void }[]
        bindings?: unknown[]
      }) => () => void
    }
  }
  if (modern.keymap?.registerLayer) {
    modern.keymap.registerLayer({
      commands: [
        {
          namespace: "palette",
          name: command.value,
          title: command.title,
          desc: command.description,
          category: command.category,
          run: command.onSelect as (() => void) | undefined,
        },
      ],
      bindings: [],
    })
    return
  }
  api.command?.register(() => [command])
}

const tui: TuiPlugin = async (api) => {
  const slots = api.slots as unknown as {
    register?: (plugin: { order?: number; slots: Record<string, (ctx: unknown, props: Record<string, unknown>) => unknown> }) => unknown
  }
  slots.register?.({
    order: 130,
    slots: {
      sidebar_content(_ctx, props) {
        const sid = (props as { session_id?: string }).session_id
        if (!sid) return null
        return ChecklistSidebarV1(api, sid)
      },
      app_bottom() {
        return ProgressBadgeV1(api)
      },
    },
  })

  registerCommandV1(api, {
    title: MESSAGES.showCommandTitle,
    value: "checklist.show",
    category: MESSAGES.sidebarTitle,
    description: MESSAGES.showCommandDesc,
    onSelect: () => {
      const sid = currentSessionIDV1(api)
      void (async () => {
        const c = sid ? await getChecklist(sid) : null
        if (!c) {
          api.ui.toast({ title: MESSAGES.sidebarTitle, message: MESSAGES.noActive, variant: "info" })
          return
        }
        const { done, total, pct } = progress(c)
        api.ui.toast({
          title: MESSAGES.sidebarTitle,
          message: `${c.objective} — ${done}/${total} (${pct}%)`,
          variant: c.status === "complete" ? "success" : "info",
          duration: 4000,
        })
      })()
    },
  })
}

// --- V2 TUI (context.ui.slot) ------------------------------------------------

interface TuiV2Context {
  theme: unknown
  options?: Record<string, unknown>
  ui: {
    slot: (...args: unknown[]) => unknown
    router: { current: () => { type: string; sessionID?: string } }
  }
}

type SlotDispose = () => void
const noopDispose: SlotDispose = () => {}

/**
 * Registers a V2 slot across preview shapes: some expose `ui.slot(name, render)`,
 * others `ui.slot({ append, render })`. Branch on arity so either host works.
 */
function registerSlotV2(context: TuiV2Context, name: string, render: (props: { sessionID: string }) => unknown): SlotDispose {
  const slot = context.ui.slot
  const dispose = slot.length <= 1 ? slot({ append: name, render }) : slot(name, render)
  return typeof dispose === "function" ? (dispose as SlotDispose) : noopDispose
}

/** Resolve a theme color, tolerating V2's nested theme shapes. */
function themeColorV2(theme: unknown, ...paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    let cursor: unknown = theme
    for (const key of path) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (cursor !== null && typeof cursor === "object") {
      if ("base" in cursor) cursor = (cursor as { base: unknown }).base
      else if ("default" in cursor) cursor = (cursor as { default: unknown }).default
    }
    if (cursor !== undefined && cursor !== null) return cursor
  }
  return undefined
}

function colorsV2(theme: unknown) {
  return {
    text: themeColorV2(theme, ["text", "base"], ["text", "default"], ["text"]),
    muted: themeColorV2(theme, ["text", "muted"], ["text", "subdued"], ["textMuted"]),
    primary: themeColorV2(theme, ["primary"], ["accent"], ["text", "base"], ["text"]),
    success: themeColorV2(theme, ["text", "feedback", "success"], ["success"], ["primary"], ["text"]),
    warning: themeColorV2(theme, ["text", "feedback", "warning"], ["warning"], ["text", "muted"], ["textMuted"]),
  }
}

function ChecklistSidebarV2(context: TuiV2Context, sessionID: string) {
  const c0 = colorsV2(context.theme)
  const cl = usePolledChecklist(sessionID)
  return box({}, [
    () => {
      const c = cl()
      if (!c) return null
      const { done, total, ratio, pct } = progress(c)
      const children: ElementChild[] = [
        text({ fg: c.status === "complete" ? c0.success : c0.text }, [MESSAGES.sidebarTitle]),
        text({ fg: c.status === "complete" ? c0.success : c0.primary }, [`${progressBar(ratio)} ${done}/${total} · ${pct}%`]),
        text({ fg: c0.muted }, [c.objective]),
      ]
      for (let i = 0; i < c.tasks.length; i++) {
        const t = c.tasks[i]
        const fg =
          t.status === "done" ? c0.muted : t.status === "active" ? c0.primary : t.status === "blocked" ? c0.warning : c0.text
        children.push(text({ fg }, [`${taskSymbol(t.status)} ${i + 1}. ${t.text}`]))
      }
      return box({}, children)
    },
  ])
}

function ProgressBadgeV2(context: TuiV2Context) {
  const c0 = colorsV2(context.theme)
  const cl = usePolledCurrentChecklist(() => {
    const r = context.ui.router.current()
    return r.type === "session" ? r.sessionID : undefined
  })
  return box({}, [
    () => {
      const c = cl()
      if (!c || (c.status !== "active" && c.status !== "complete")) return null
      const { ratio, pct } = progress(c)
      const next = nextPending(c)
      const label = c.status === "complete" ? MESSAGES.complete : next ? next.text : ""
      return text({ fg: c.status === "complete" ? c0.success : c0.primary }, [
        `C2G ${progressBar(ratio, 10)} ${pct}%${label ? ` ▸ ${label}` : ""}`,
      ])
    },
  ])
}

export function setupTuiV2(context: TuiV2Context): SlotDispose {
  const offSidebar = registerSlotV2(context, "sidebar.content", (props) => ChecklistSidebarV2(context, props.sessionID))
  const offBottom = registerSlotV2(context, "app.bottom", () => ProgressBadgeV2(context))
  return () => {
    offSidebar()
    offBottom()
  }
}

// --- Module export (both generations) ---------------------------------------

const plugin = {
  id: "local.checklist-to-goal.tui",
  tui,
  setup: setupTuiV2,
}

export default plugin
