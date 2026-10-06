// The composer draft store (plan section 4, state category 2). One draft per
// conversation, keyed by the session list's engine-qualified key (`managed:<id>`,
// `claude:<transcript>`, `codex:<transcript>`), so switching sessions never shows or
// clears another session's words, images or references.
//
// Every edit bumps the draft's revision and gives it a new request id; a send takes a
// snapshot of both. Only an accepted answer for the snapshot's revision clears the
// draft: text typed while the request was out survives it, and a late answer for a
// session the operator has left clears that session's draft and nothing else. A
// failed send keeps the draft and its request id, so a deliberate retry of the same
// words is deduplicated by the server (requestId) rather than sent twice.
//
// Drafts survive switching and dismissal, not a page reload (as legacy). One store per
// FleetClient, so tests get a fresh one with each client.
import { useCallback, useSyncExternalStore } from 'react'
import type { FleetClient } from '../../transport/client'
import { useFleetClient } from '../../transport/hooks'

export interface PendingImage {
  /** Local identity for keys and removal; never sent. */
  readonly id: string
  readonly mediaType: string
  /** A data: URL for the thumbnail; the base64 part is what is sent. */
  readonly dataUrl: string
  readonly bytes: number
  readonly name: string
}

export interface PendingReference {
  /** The source's managed id, or its transcript id for an external session. */
  readonly id: string
  readonly title: string
  readonly state: string
}

export interface SendSnapshot {
  readonly revision: number
  readonly requestId: string
  readonly text: string
  readonly images: readonly PendingImage[]
  readonly references: readonly PendingReference[]
}

export interface Draft {
  readonly text: string
  readonly images: readonly PendingImage[]
  readonly references: readonly PendingReference[]
  readonly revision: number
  readonly requestId: string
  /** The send in flight, if any. */
  readonly sending: SendSnapshot | null
  /** Why the last send failed; cleared by the next send. */
  readonly error: string | null
}

export type DraftEdit = Partial<Pick<Draft, 'text' | 'images' | 'references'>>

type Listener = () => void

export class DraftStore {
  private readonly drafts = new Map<string, Draft>()
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly empty: Draft

  constructor(private readonly newId: () => string = () => globalThis.crypto.randomUUID()) {
    this.empty = Object.freeze({ text: '', images: [], references: [], revision: 0, requestId: '', sending: null, error: null })
  }

  /** The draft for a key; the same object until it changes. */
  get(key: string): Draft {
    return this.drafts.get(key) ?? this.empty
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (!set.size) this.listeners.delete(key)
    }
  }

  /** The operator changed the draft: a new revision with a new request id. */
  edit(key: string, change: DraftEdit): Draft {
    const current = this.get(key)
    const next: Draft = { ...current, ...change, revision: current.revision + 1, requestId: this.newId() }
    this.put(key, next)
    return next
  }

  /**
   * Start sending what is in the draft now. Returns null when a send for this key is
   * already out (the button is disabled then too; this is the guard behind it).
   */
  begin(key: string): SendSnapshot | null {
    const current = this.get(key)
    if (current.sending) return null
    // A draft never edited (an image-only send right after a clear, say) still needs an id.
    const base = current.requestId ? current : { ...current, requestId: this.newId() }
    const snapshot: SendSnapshot = {
      revision: base.revision,
      requestId: base.requestId,
      text: base.text,
      images: base.images,
      references: base.references,
    }
    this.put(key, { ...base, sending: snapshot, error: null })
    return snapshot
  }

  /** The server accepted the snapshot. Clears the draft only if nothing changed since. */
  accepted(key: string, snapshot: SendSnapshot): void {
    const current = this.get(key)
    if (current.sending?.requestId !== snapshot.requestId) return
    if (current.revision !== snapshot.revision) {
      this.put(key, { ...current, sending: null })
      return
    }
    this.put(key, { text: '', images: [], references: [], revision: current.revision + 1, requestId: '', sending: null, error: null })
  }

  /** The send failed: the draft and its request id stay for a deliberate retry. */
  failed(key: string, snapshot: SendSnapshot, error: string): void {
    const current = this.get(key)
    if (current.sending?.requestId !== snapshot.requestId) return
    this.put(key, { ...current, sending: null, error })
  }

  /** Hide the last failure without touching the draft. */
  clearError(key: string): void {
    const current = this.get(key)
    if (current.error) this.put(key, { ...current, error: null })
  }

  private put(key: string, draft: Draft): void {
    this.drafts.set(key, draft)
    for (const listener of [...(this.listeners.get(key) ?? [])]) listener()
  }
}

const stores = new WeakMap<FleetClient, DraftStore>()

/** The one draft store of this client. */
export function draftStoreFor(client: FleetClient): DraftStore {
  let store = stores.get(client)
  if (!store) {
    store = new DraftStore()
    stores.set(client, store)
  }
  return store
}

export function useDraftStore(): DraftStore {
  return draftStoreFor(useFleetClient())
}

/** One conversation's draft, re-rendering only when that draft changes. */
export function useDraft(key: string): Draft {
  const store = useDraftStore()
  const subscribe = useCallback((listener: Listener) => store.subscribe(key, listener), [store, key])
  const read = useCallback(() => store.get(key), [store, key])
  return useSyncExternalStore(subscribe, read, read)
}
