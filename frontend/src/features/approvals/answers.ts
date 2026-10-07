// Answer drafts for AskUserQuestion, keyed by session and approval id, outside React:
// a partly answered question keeps its picks and typed text through every refresh of
// the session, and through switching to another session and back. Cleared once the
// answer is accepted. One store per FleetClient.
import { useCallback, useSyncExternalStore } from 'react'
import type { FleetClient } from '../../transport/client'
import { useFleetClient } from '../../transport/hooks'

export interface AnswerDraft {
  /** Picked option labels per question index. */
  readonly choices: Readonly<Record<number, readonly string[]>>
  /** "Or type your own answer" per question index. */
  readonly other: Readonly<Record<number, string>>
}

const EMPTY: AnswerDraft = Object.freeze({ choices: {}, other: {} })

type Listener = () => void

export class AnswerStore {
  private readonly drafts = new Map<string, AnswerDraft>()
  private readonly listeners = new Set<Listener>()

  get(key: string): AnswerDraft {
    return this.drafts.get(key) ?? EMPTY
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  pick(key: string, question: number, label: string, multi: boolean, on: boolean): void {
    const current = this.get(key)
    const was = current.choices[question] ?? []
    const next = multi ? (on ? [...was.filter(l => l !== label), label] : was.filter(l => l !== label)) : on ? [label] : []
    this.put(key, { ...current, choices: { ...current.choices, [question]: next } })
  }

  type(key: string, question: number, text: string): void {
    const current = this.get(key)
    this.put(key, { ...current, other: { ...current.other, [question]: text } })
  }

  clear(key: string): void {
    if (!this.drafts.delete(key)) return
    this.emit()
  }

  private put(key: string, draft: AnswerDraft): void {
    this.drafts.set(key, draft)
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

const stores = new WeakMap<FleetClient, AnswerStore>()

export function answerStoreFor(client: FleetClient): AnswerStore {
  let store = stores.get(client)
  if (!store) {
    store = new AnswerStore()
    stores.set(client, store)
  }
  return store
}

export function useAnswerDraft(key: string): [AnswerDraft, AnswerStore] {
  const store = answerStoreFor(useFleetClient())
  const read = useCallback(() => store.get(key), [store, key])
  return [useSyncExternalStore(store.subscribe, read, read), store]
}
