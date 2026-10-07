// The view registry: what each tab of the top bar shows. AppShell draws the
// workspace from this table and nothing else, so a feature plugs in by replacing the
// placeholder its entry points at, never by editing the shell.
//
// A view is a pane (left, or the whole workspace) and, for split views, a detail
// column (`aside#detail`) with the resizable divider between them. The shell owns the
// containers (their ids and legacy classes) and the divider; the feature component
// renders what goes inside. Only the active view is mounted.
import { type ComponentType, type FunctionComponent, createElement, lazy, useState } from 'react'
import type { SplitPreference } from '../components/SplitPane'
import { VIEWS, type View } from './preferences'

export interface SplitDefinition {
  readonly preference: SplitPreference
  readonly cssVar: string
  readonly defaultValue: number
  readonly bounds: (width: number) => readonly [number, number]
}

export interface ViewDefinition {
  readonly id: View
  /** The tab's text, and the workspace's accessible name. */
  readonly label: string
  /** The tab's tooltip. */
  readonly title?: string | undefined
  /** The pane container the shell renders around `Pane`. */
  readonly pane: { readonly id: string; readonly className: string; readonly element: 'div' | 'section' }
  readonly Pane: ViewPart
  /** Rendered inside aside#detail; null for full-width views (Progress, Worktrees). */
  readonly Detail: ViewPart | null
  readonly split: SplitDefinition | null
}

// The session list beside the conversation and inspector: 240px minimum, at most
// 380px (300px under 1200px), and the detail column keeps 480px.
const LIST_SPLIT: SplitDefinition = {
  preference: 'split',
  cssVar: '--split',
  defaultValue: 22,
  bounds: width => [(240 / width) * 100, (Math.min(width <= 1199 ? 300 : 380, width - 480) / width) * 100],
}
// Today and Projects are a working pane beside a console, sharing one divider.
const BOARD_SPLIT: SplitDefinition = {
  preference: 'todaySplit',
  cssVar: '--today-split',
  defaultValue: 56,
  bounds: width => [(420 / width) * 100, ((width - 380) / width) * 100],
}

/** A view's pane or detail: its code loads on first use, or earlier through `preload`. */
export interface ViewPart extends FunctionComponent {
  preload(): Promise<unknown>
}

// Code that is already in renders straight away, without suspending: a Suspense
// fallback makes React hold the real content back for up to 300 ms (its reveal
// throttle), which at startup is most of the time to a usable page. Each mounted part
// keeps the form it started with, so a load finishing later never remounts it.
const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): ViewPart => {
  let loaded: ComponentType | null = null
  let pending: Promise<ComponentType> | null = null
  const preload = () => {
    pending ??= load().then(module => {
      loaded = module[name]
      return loaded
    })
    return pending
  }
  const Lazy = lazy(() => preload().then(component => ({ default: component })))
  function Part() {
    const [Use] = useState<ComponentType>(() => loaded ?? Lazy)
    return createElement(Use)
  }
  return Object.assign(Part, { preload })
}

/** Load a view's code ahead of its first render (main.tsx, for the view the page opens on). */
export const preloadView = (view: View): Promise<unknown> => {
  const { Pane, Detail } = VIEW_DEFINITIONS[view]
  return Promise.all([Pane.preload(), Detail?.preload()])
}

export const VIEW_DEFINITIONS: Readonly<Record<View, ViewDefinition>> = {
  today: {
    id: 'today',
    label: 'Today',
    title: 'Your day: what needs you, in one plan',
    pane: { id: 'today-pane', className: 'sessions-pane today-pane', element: 'section' },
    Pane: named(() => import('../features/today/TodayPane'), 'TodayPane'),
    Detail: named(() => import('../features/today/DayConsole'), 'DayConsole'),
    split: BOARD_SPLIT,
  },
  projects: {
    id: 'projects',
    label: 'Projects',
    title: 'Your projects: deliverables, sessions and a manager to ask',
    pane: { id: 'projects-pane', className: 'sessions-pane today-pane projects-pane', element: 'section' },
    Pane: named(() => import('../features/projects/ProjectsPane'), 'ProjectsPane'),
    Detail: named(() => import('../features/projects/ProjectConsole'), 'ProjectConsole'),
    split: BOARD_SPLIT,
  },
  sessions: {
    id: 'sessions',
    label: 'Sessions',
    pane: { id: 'sessions-pane', className: 'sessions-pane', element: 'div' },
    Pane: named(() => import('../features/sessions/SessionsPane'), 'SessionsPane'),
    Detail: named(() => import('../features/inspector/SessionDetail'), 'SessionDetail'),
    split: LIST_SPLIT,
  },
  progress: {
    id: 'progress',
    label: 'Progress',
    title: 'This week: what shipped, what stalled, what ran',
    pane: { id: 'progress-pane', className: 'sessions-pane today-pane progress-pane', element: 'section' },
    Pane: named(() => import('../features/progress/ProgressPage'), 'ProgressPage'),
    Detail: null,
    split: null,
  },
  worktrees: {
    id: 'worktrees',
    label: 'Worktrees',
    title: "Every session's branch and worktree, and which ones can be cleared",
    pane: { id: 'worktrees-pane', className: 'sessions-pane today-pane worktrees-pane', element: 'section' },
    Pane: named(() => import('../features/worktrees/WorktreesPage'), 'WorktreesPage'),
    Detail: null,
    split: null,
  },
}

/** Tab order in the top bar. */
export const VIEW_ORDER: readonly View[] = VIEWS
