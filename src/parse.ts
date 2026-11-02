// Parse a Markdown document into a list of checklist task strings.

/**
 * Extracts task texts from Markdown.
 *
 * Primary: GitHub-style task-list items — `- [ ] text`, `* [x] text`,
 * `1. [ ] text`. Both checked and unchecked are taken (the point is to seed the
 * checklist; the user can already have ticked some).
 *
 * Fallback: if there are no task-list items at all, treat plain bullet or
 * numbered list items as tasks (headings and blank lines are ignored).
 */
export function parseMarkdownChecklist(markdown: string): string[] {
  const tasks: string[] = []

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    const m = line.match(/^(?:[-*+]|\d+[.)])\s+\[(?: |x|X)\]\s+(.*\S)\s*$/)
    if (m) tasks.push(m[1].trim())
  }
  if (tasks.length > 0) return tasks

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (/^#{1,6}\s/.test(line)) continue
    const m = line.match(/^(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/)
    if (m) tasks.push(m[1].trim())
  }
  return tasks
}
