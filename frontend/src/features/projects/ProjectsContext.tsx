// What the Projects page keeps across redraws and project switches: text typed in a
// field (a comment, the question, the new-project form) and which task rows are open.
// The legacy page restored these from the DOM after every redraw; here the page owns
// them and server updates never touch them.
import { type ChangeEvent, type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

export interface ProjectsMemory {
  readonly drafts: Map<string, string>
  readonly openTasks: ReadonlySet<string>
  setTaskOpen(key: string, open: boolean): void
}

const MemoryContext = createContext<ProjectsMemory | null>(null)

export function ProjectsMemoryProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, string>()).current
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(() => new Set())
  const setTaskOpen = useCallback((key: string, open: boolean) => {
    setOpenTasks(previous => {
      if (previous.has(key) === open) return previous
      const next = new Set(previous)
      if (open) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const value = useMemo(() => ({ drafts, openTasks, setTaskOpen }), [drafts, openTasks, setTaskOpen])
  return <MemoryContext.Provider value={value}>{children}</MemoryContext.Provider>
}

export function useProjectsMemory(): ProjectsMemory {
  const memory = useContext(MemoryContext)
  if (!memory) throw new Error('Projects components need a ProjectsMemoryProvider above them.')
  return memory
}

/** A text field whose value outlives the component (a project switch, a refresh). */
export function useDraft(key: string): {
  value: string
  onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void
  clear: () => void
} {
  const { drafts } = useProjectsMemory()
  const [value, setValue] = useState(() => drafts.get(key) ?? '')
  const onChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      drafts.set(key, event.target.value)
      setValue(event.target.value)
    },
    [drafts, key],
  )
  const clear = useCallback(() => {
    drafts.delete(key)
    setValue('')
  }, [drafts, key])
  return { value, onChange, clear }
}
