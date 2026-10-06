// The modal registry: which component draws each modal kind. AppShell mounts the
// one for `state.modal` (at most one), inside Suspense, and unmounts it on close.
// Each component renders its own <Dialog> (components/Dialog.tsx) with the backdrop
// id below, so the opener's aria-controls points at it.
import { type ComponentType, type LazyExoticComponent, lazy } from 'react'
import type { ModalKind, ModalState } from './state'

export interface ModalProps<K extends ModalKind = ModalKind> {
  /** The open modal, with its payload (connections: managedId; clear-worktree: path). */
  readonly modal: Extract<ModalState, { kind: K }>
  /** Close this modal. Wire it to the Dialog's onClose. */
  readonly onClose: () => void
}

/** Backdrop ids, as the legacy page had them; openers name them in aria-controls. */
export const MODAL_IDS: Readonly<Record<ModalKind, string>> = {
  launch: 'launch-backdrop',
  search: 'ask-backdrop',
  connections: 'connections-backdrop',
  settings: 'settings-backdrop',
  'clear-worktree': 'worktree-clear-backdrop',
}

type Registry = { readonly [K in ModalKind]: LazyExoticComponent<ComponentType<ModalProps<K>>> }

const named = <K extends ModalKind, N extends string>(
  load: () => Promise<Record<N, ComponentType<ModalProps<K>>>>,
  name: N,
) => lazy(() => load().then(module => ({ default: module[name] })))

export const MODALS: Registry = {
  launch: named<'launch', 'LaunchDialog'>(() => import('../features/launch/LaunchDialog'), 'LaunchDialog'),
  search: named<'search', 'SearchDialog'>(() => import('../features/search/SearchDialog'), 'SearchDialog'),
  connections: named<'connections', 'ConnectionsDialog'>(() => import('../features/connections/ConnectionsDialog'), 'ConnectionsDialog'),
  settings: named<'settings', 'SettingsDialog'>(() => import('../features/settings/SettingsDialog'), 'SettingsDialog'),
  'clear-worktree': named<'clear-worktree', 'ClearWorktreeDialog'>(
    () => import('../features/worktrees/ClearWorktreeDialog'),
    'ClearWorktreeDialog',
  ),
}
