// Shared state model for Checklist-to-Goal.
//
// The *server* half (server.ts) owns and mutates this state; the *TUI* half
// (tui.ts) only reads it. They run in different processes, so the single
// source of truth is a JSON file on disk, re-read by the TUI every second.
// This mirrors how @prevalentware/opencode-goal-plugin bridges server <-> TUI.

import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"

export type TaskStatus = "pending" | "active" | "done" | "blocked"

export interface Task {
  id: string
  text: string
  status: TaskStatus
  /** Concrete, verifiable proof the task is done. Required to mark `done`. */
  evidence?: string
  /** Reason the task is blocked (when status === "blocked"). */
  blocker?: string
  completedAt?: number
}

export type ChecklistStatus = "active" | "complete" | "cancelled"

export interface Checklist {
  sessionID: string
  objective: string
  source: "context" | "markdown"
  tasks: Task[]
  status: ChecklistStatus
  createdAt: number
  updatedAt: number
  /** How many synthetic "continue" turns the server has injected so far. */
  autoTurns: number
  /** Hard cap on auto-continuations; null = unlimited. */
  maxAutoTurns: number | null
  /** Consecutive idle cycles with no newly-completed task. */
  noProgressTurns: number
  /** Snapshot of completed-task count at the last idle cycle. */
  lastDoneCount: number
  lastContinuationAt: number | null
  /** Agent that owns the session, so continuations keep the same agent. */
  lastAgent?: string | null
}

export interface StateFile {
  version: 1
  checklists: Record<string, Checklist>
}

/** Absolute path to the shared state file (overridable for tests). */
export function statePath(): string {
  if (process.env.CHECKLIST_TO_GOAL_STATE_PATH) return process.env.CHECKLIST_TO_GOAL_STATE_PATH
  const dataHome =
    process.env.XDG_DATA_HOME ||
    (process.platform === "win32" && process.env.APPDATA
      ? process.env.APPDATA
      : join(homedir(), ".local", "share"))
  return join(dataHome, "checklist-to-goal", "state.json")
}

export async function readState(): Promise<StateFile> {
  try {
    const raw = await readFile(statePath(), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as StateFile).version === 1 &&
      typeof (parsed as StateFile).checklists === "object"
    ) {
      return parsed as StateFile
    }
    return { version: 1, checklists: {} }
  } catch {
    return { version: 1, checklists: {} }
  }
}

export async function writeState(state: StateFile): Promise<void> {
  const file = statePath()
  await mkdir(dirname(file), { recursive: true })
  // Atomic write: temp file + rename, so a concurrent reader never sees a
  // half-written file.
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8")
  await rename(tmp, file)
}

export async function getChecklist(sessionID: string): Promise<Checklist | null> {
  const state = await readState()
  return state.checklists[sessionID] ?? null
}

export async function saveChecklist(cl: Checklist): Promise<void> {
  const state = await readState()
  cl.updatedAt = Date.now()
  state.checklists[cl.sessionID] = cl
  await writeState(state)
}

export async function deleteChecklist(sessionID: string): Promise<void> {
  const state = await readState()
  delete state.checklists[sessionID]
  await writeState(state)
}

export function newTask(text: string): Task {
  return { id: `t${randomUUID().slice(0, 8)}`, text: text.trim(), status: "pending" }
}

export interface Progress {
  done: number
  total: number
  ratio: number
  pct: number
}

export function progress(cl: Checklist): Progress {
  const total = cl.tasks.length
  const done = cl.tasks.filter((t) => t.status === "done").length
  const ratio = total ? done / total : 0
  return { done, total, ratio, pct: Math.round(ratio * 100) }
}

/** The task the model should be working on: the active one, else first pending. */
export function nextPending(cl: Checklist): Task | undefined {
  return cl.tasks.find((t) => t.status === "active") ?? cl.tasks.find((t) => t.status === "pending")
}

/** Resolve a task by its id, or by its 1-based position as a fallback. */
export function findTask(cl: Checklist, idOrIndex: string): Task | undefined {
  return (
    cl.tasks.find((t) => t.id === idOrIndex) ??
    cl.tasks.find((_t, i) => `${i + 1}` === idOrIndex.trim())
  )
}

/** A text-mode progress bar, e.g. "██████░░░░░░░░". */
export function progressBar(ratio: number, width = 14): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)))
  return "█".repeat(filled) + "░".repeat(width - filled)
}
