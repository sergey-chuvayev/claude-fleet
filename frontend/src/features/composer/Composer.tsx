// The managed session's composer (F10, F11): text with Enter to send and Shift+Enter
// for a new line (never during IME composition), autosize, `/` commands and skills,
// `@` session references as chips, pasted and dropped images as thumbnails, pending
// and failed sends, and Queue instead of Send while the agent works or another
// program holds the session.
//
// Everything typed lives in the draft store under this conversation's key, so the
// draft survives switching sessions and a late answer clears only what it sent (see
// drafts.ts). The pickers only ever change the draft; nothing runs until Send.
import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useActions } from '../../app/AppStore'
import { selectionOf } from '../../app/state'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/Toast'
import type { Command, Holder, SessionSummary } from '../../transport/contracts'
import { useFleetClient, useResource } from '../../transport/hooks'
import { failureText, sessionCommand } from '../session-header/mutations'
import { commandsResource } from '../session-header/reads'
import { heldText } from '../session-header/status'
import { type PendingImage, type PendingReference, useDraft, useDraftStore } from './drafts'
import { readImages, wireImage } from './images'
import {
  type Caret,
  MAX_REFERENCES,
  insertCommand,
  matchCommands,
  matchReferences,
  mentionQuery,
  referenceCandidates,
  referenceIdOf,
  referenceState,
  referenceTitle,
  removeMention,
  slashQuery,
} from './picker'
import { useLazyResource } from './useLazyResource'

export interface ComposerProps {
  readonly managedId: string
  /** The draft key: the session list's key for this conversation. */
  readonly draftKey: string
  /** Runtime transcript id, so this conversation cannot reference itself by it. */
  readonly transcriptId: string | null
  readonly engine: 'claude' | 'codex'
  readonly working: boolean
  readonly holder: Holder | null
  readonly placeholder: string
  /** The Stop / Cancel queued task button, drawn in the footer before Send. */
  readonly stop?: ReactNode
  readonly formRef?: RefObject<HTMLFormElement | null>
}

type Entry = { readonly kind: 'command'; readonly command: Command } | { readonly kind: 'reference'; readonly row: SessionSummary }

interface PickerState {
  readonly mode: 'slash' | 'mention'
  readonly query: string
}

const caretOf = (box: HTMLTextAreaElement): Caret => ({ value: box.value, selectionStart: box.selectionStart, selectionEnd: box.selectionEnd })

/** The text box takes the height of its text, within the CSS limits. */
function fit(box: HTMLTextAreaElement | null) {
  if (!box) return
  box.style.height = 'auto'
  box.style.height = `${box.scrollHeight}px`
}

export function Composer(props: ComposerProps) {
  const { managedId, draftKey, transcriptId, engine, working, holder, placeholder, stop, formRef } = props
  const client = useFleetClient()
  const toast = useToast()
  const { select } = useActions()
  const store = useDraftStore()
  const draft = useDraft(draftKey)
  const control = useResource(client.resources.control)
  const snapshot = useResource(client.resources.sessions)
  const referencesAvailable = control.data?.supportsSessionReferences === true
  const box = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [picked, setPicked] = useState(0)
  const [wantCatalog, setWantCatalog] = useState(false)
  const [dropping, setDropping] = useState(false)
  const catalog = useLazyResource(commandsResource(client, managedId), wantCatalog)
  const sending = !!draft.sending

  // ── Picker contents ────────────────────────────────────────────────────────
  const candidates = useMemo(
    () => referenceCandidates(snapshot.data?.sessions ?? [], { managedId, transcriptId }),
    [snapshot.data?.sessions, managedId, transcriptId],
  )
  const attached = useMemo(() => new Set(draft.references.map(r => r.id)), [draft.references])
  const entries: Entry[] = useMemo(() => {
    if (!picker) return []
    if (picker.mode === 'slash') return matchCommands(catalog.data ?? [], picker.query).map(command => ({ kind: 'command', command }))
    if (!referencesAvailable) return []
    return matchReferences(candidates, attached, picker.query).map(row => ({ kind: 'reference', row }))
  }, [picker, catalog.data, referencesAvailable, candidates, attached])
  // A slash picker with nothing to offer stays closed; a mention picker explains itself.
  const open = !!picker && (picker.mode === 'mention' || entries.length > 0)
  const active = entries.length ? Math.min(picked, entries.length - 1) : -1

  useEffect(() => {
    if (active < 0) return
    document.getElementById(`slash-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  // ── Layout ─────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    fit(box.current)
    if (pendingCaret.current !== null && box.current) {
      box.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
      pendingCaret.current = null
    }
  }, [draft.text, draft.images.length, draft.references.length])

  const setText = (text: string, caret?: number) => {
    if (caret !== undefined) pendingCaret.current = caret
    store.edit(draftKey, { text })
  }

  const refreshPicker = (input: Caret) => {
    const mention = mentionQuery(input)
    if (mention !== null) {
      setPicked(0)
      setPicker({ mode: 'mention', query: mention })
      return
    }
    const slash = slashQuery(input)
    if (slash === null) {
      setPicker(null)
      return
    }
    setPicked(0)
    setWantCatalog(true)
    setPicker({ mode: 'slash', query: slash })
  }

  // ── References ─────────────────────────────────────────────────────────────
  const addReference = (row: SessionSummary): boolean => {
    if (!referencesAvailable) {
      toast('Restart Fleet after your current agents finish to enable references.')
      return false
    }
    if (sending) return false
    const id = referenceIdOf(row)
    if (!id || !candidates.includes(row as (typeof candidates)[number])) {
      toast('Choose another available session.')
      return false
    }
    const list = store.get(draftKey).references
    if (list.some(r => r.id === id)) return true
    if (list.length >= MAX_REFERENCES) {
      toast(`You can reference up to ${MAX_REFERENCES} sessions per message.`)
      return false
    }
    const reference: PendingReference = { id, title: referenceTitle(row), state: referenceState(row) }
    store.edit(draftKey, { references: [...list, reference] })
    return true
  }
  const removeReference = (id: string) => {
    if (sending) return
    store.edit(draftKey, { references: store.get(draftKey).references.filter(r => r.id !== id) })
    box.current?.focus()
  }
  const openReference = (id: string) => {
    const row = snapshot.data?.sessions.find(s => referenceIdOf(s) === id)
    if (!row) {
      toast('This session is no longer available.')
      return
    }
    select(selectionOf(row), { reveal: true })
  }

  const insert = (index: number) => {
    const entry = entries[index]
    const input = box.current
    if (!entry || !input) return
    const caret = caretOf(input)
    if (entry.kind === 'reference') {
      if (!addReference(entry.row)) return
      const next = removeMention(caret)
      setText(next.value, next.caret)
    } else {
      const next = insertCommand(caret, entry.command.name)
      setText(next.value, next.caret)
    }
    setPicker(null)
    input.focus()
  }

  // ── Images ─────────────────────────────────────────────────────────────────
  const attach = async (files: File[]) => {
    if (!files.length) return
    const added = await readImages(files, store.get(draftKey).images.length, toast)
    if (added.length) store.edit(draftKey, { images: [...store.get(draftKey).images, ...added] })
    box.current?.focus()
  }
  const removeImage = (image: PendingImage) => {
    store.edit(draftKey, { images: store.get(draftKey).images.filter(i => i.id !== image.id) })
  }
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => !!file)
    if (!files.length) return // an ordinary text paste proceeds untouched
    event.preventDefault()
    void attach(files)
  }
  const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files')
  const onDragOver = (event: DragEvent<HTMLFormElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDropping(true)
  }
  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    setDropping(false)
    void attach([...(event.dataTransfer?.files ?? [])].filter(file => file.type.startsWith('image/')))
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  const send = async () => {
    const current = store.get(draftKey)
    if (current.sending || (!current.text.trim() && !current.images.length)) return
    const snap = store.begin(draftKey)
    if (!snap) return
    const message = snap.text.trim()
    const body = {
      message,
      ...(snap.images.length ? { images: snap.images.map(wireImage) } : {}),
      ...(snap.references.length ? { references: snap.references.map(r => r.id) } : {}),
      requestId: snap.requestId,
    }
    try {
      await sessionCommand(client, managedId, 'messages', body)
      store.accepted(draftKey, snap)
    } catch (error) {
      store.failed(draftKey, snap, failureText(error))
    }
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void send()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (open) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setPicker(null)
        return
      }
      if (entries.length) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setPicked((active + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length)
          return
        }
        if ((event.key === 'Enter' && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
          event.preventDefault()
          insert(active)
          return
        }
      } else if (event.key === 'Enter') {
        // An open picker with nothing to choose swallows Enter rather than sending.
        event.preventDefault()
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (!sending) void send()
    }
  }

  // ── What the footer says ───────────────────────────────────────────────────
  const held = heldText(holder)
  const agent = engine === 'codex' ? 'Codex' : 'Claude'
  const images = draft.images.length
  const hint =
    held ||
    (working
      ? `${agent} is still working. This joins the queue and sends the moment it’s free.`
      : images
        ? `${images} image${images === 1 ? '' : 's'} attached · Enter to send`
        : 'Enter to send · Shift + Enter for a new line')

  return (
    <form
      ref={formRef}
      id="composer"
      className={`composer${dropping ? ' is-dropping' : ''}`}
      onSubmit={submit}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <label className="sr-only" htmlFor="message-input">
        Message this agent
      </label>
      <ul id="slash-picker" className="slash-picker" role="listbox" aria-label={picker?.mode === 'mention' ? 'Reference a session' : 'Commands and skills'} hidden={!open}>
        {open ? <PickerItems entries={entries} active={active} mode={picker.mode} available={referencesAvailable} onPick={insert} /> : null}
      </ul>
      <ReferenceTray references={draft.references} onOpen={openReference} onRemove={removeReference} />
      <AttachTray images={draft.images} onRemove={removeImage} />
      <textarea
        ref={box}
        id="message-input"
        rows={3}
        maxLength={16000}
        placeholder={placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls="slash-picker"
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `slash-${active}` : undefined}
        value={draft.text}
        onChange={event => {
          const input = event.currentTarget
          store.edit(draftKey, { text: input.value })
          refreshPicker(caretOf(input))
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => setTimeout(() => setPicker(null), 120)}
      />
      <div className="composer-footer">
        <span id="composer-hint" className={`note${held ? ' is-held' : ''}`}>
          {hint}
        </span>
        {stop}
        <button id="send-message" className="button resume" type="submit" disabled={sending}>
          {working || holder ? 'Queue' : 'Send'} <Icon name="arrow" />
        </button>
      </div>
      <p id="send-error" className="form-error" role="alert" hidden={!draft.error}>
        {draft.error}
      </p>
    </form>
  )
}

function PickerItems({
  entries,
  active,
  mode,
  available,
  onPick,
}: {
  entries: readonly Entry[]
  active: number
  mode: 'slash' | 'mention'
  available: boolean
  onPick: (index: number) => void
}) {
  if (mode === 'mention' && !available) {
    return (
      <li className="reference-empty" role="presentation">
        Restart Fleet after your current agents finish to enable session references.
      </li>
    )
  }
  if (!entries.length) {
    return (
      <li className="reference-empty" role="presentation">
        No matching sessions. Try another name or project.
      </li>
    )
  }
  return entries.map((entry, index) => (
    <li
      key={entry.kind === 'command' ? `c:${entry.command.scope ?? ''}:${entry.command.name}` : `r:${referenceIdOf(entry.row)}`}
      id={`slash-${index}`}
      role="option"
      aria-selected={index === active}
      className={index === active ? 'is-picked' : undefined}
      data-index={index}
      // mousedown, not click: the text box keeps focus and its caret.
      onMouseDown={event => {
        event.preventDefault()
        onPick(index)
      }}
    >
      {entry.kind === 'command' ? <CommandItem command={entry.command} /> : <ReferenceItem row={entry.row} />}
    </li>
  ))
}

const SCOPE_LABEL: Readonly<Record<string, string>> = { project: 'project', user: 'user', plugin: 'plugin' }

function CommandItem({ command }: { command: Command }) {
  return (
    <>
      <span className="slash-name">/{command.name}</span>
      <span className="slash-kind">
        {command.kind === 'skill' ? '◆' : '›'} {SCOPE_LABEL[command.scope ?? ''] ?? ''}
      </span>
      {command.hint ? <span className="slash-hint">{command.hint}</span> : null}
      <span className="slash-desc">{command.description ?? ''}</span>
    </>
  )
}

function ReferenceItem({ row }: { row: SessionSummary }) {
  const prompt = typeof row.lastPrompt === 'string' ? row.lastPrompt : ''
  return (
    <>
      <span className="slash-name">✳ {referenceTitle(row)}</span>
      <span className="slash-kind">{referenceState(row)}</span>
      <span className="slash-desc">
        {row.cwd?.split('/').pop() || 'No project'} · {prompt || 'Include recent conversation and activity'}
      </span>
    </>
  )
}

function ReferenceTray({
  references,
  onOpen,
  onRemove,
}: {
  references: readonly PendingReference[]
  onOpen: (id: string) => void
  onRemove: (id: string) => void
}) {
  return (
    <div id="reference-tray" className="reference-tray" aria-label="Referenced sessions" hidden={!references.length}>
      {references.map(r => (
        <span key={r.id} className="reference-chip">
          <button type="button" title={`Open ${r.title}`} onClick={() => onOpen(r.id)}>
            ✳ {r.title} <span className="reference-state">· {r.state}</span>
          </button>
          <button type="button" aria-label={`Remove reference to ${r.title}`} onClick={() => onRemove(r.id)}>
            ×
          </button>
        </span>
      ))}
      {references.length ? <span className="reference-note">Recent context included when you send</span> : null}
    </div>
  )
}

function AttachTray({ images, onRemove }: { images: readonly PendingImage[]; onRemove: (image: PendingImage) => void }) {
  return (
    <div id="attach-tray" className="attach-tray" hidden={!images.length}>
      {images.map(image => (
        <figure key={image.id} className="attach-thumb">
          <img src={image.dataUrl} alt={image.name} />
          <figcaption>
            {image.name} · {Math.round(image.bytes / 1024)} KB
          </figcaption>
          <button type="button" className="attach-remove" aria-label={`Remove ${image.name}`} onClick={() => onRemove(image)}>
            ×
          </button>
        </figure>
      ))}
    </div>
  )
}
