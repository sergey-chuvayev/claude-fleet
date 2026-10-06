// The application shell (F01, F26): top bar, banner, workspace, status bar and the
// one modal layer. It draws the workspace from the view registry (views.tsx), the
// open modal from the modal registry (modals.tsx) and the controllers that run on
// every view from the background registry (background.tsx); features plug into
// those, so this file rarely changes. Same DOM, ids and classes as the legacy page.
import { type ComponentType, Suspense, createElement, useRef } from 'react'
import { SplitPane } from '../components/SplitPane'
import { useActions, useModal, useView } from './AppStore'
import { Background } from './background'
import { Banner } from './Banner'
import { Boundary } from './Boundary'
import { MODALS, type ModalProps } from './modals'
import { Navigation } from './Navigation'
import { useGlobalShortcuts } from './shortcuts'
import type { ModalKind } from './state'
import { StatusBar } from './StatusBar'
import { VIEW_DEFINITIONS } from './views'

export function AppShell() {
  useGlobalShortcuts()
  return (
    <>
      <Navigation />
      <main>
        <Banner />
        <Workspace />
      </main>
      <StatusBar />
      <ModalLayer />
      <Background />
    </>
  )
}

function Workspace() {
  const view = useView()
  const definition = VIEW_DEFINITIONS[view]
  const workspace = useRef<HTMLElement>(null)
  const { Pane, Detail, split, pane } = definition
  return (
    <section ref={workspace} className="workspace" data-view={view} aria-label={definition.label}>
      {createElement(
        pane.element,
        // Unnamed: the workspace around it is already the region named after the view,
        // and two landmarks with one name read as a duplicate (axe landmark-unique).
        { id: pane.id, className: pane.className },
        <Boundary key={view} name={definition.label}>
          <Suspense fallback={null}>
            <Pane />
          </Suspense>
        </Boundary>,
      )}
      {split ? (
        <SplitPane
          // Sessions and the board views remember separate positions.
          key={split.preference}
          id="splitter"
          containerRef={workspace}
          preference={split.preference}
          cssVar={split.cssVar}
          defaultValue={split.defaultValue}
          bounds={split.bounds}
          label="Resize the session inspector"
        />
      ) : null}
      {Detail ? (
        <aside id="detail" className="detail" aria-label="Session details">
          <Boundary key={view} name="The detail column">
            <Suspense fallback={null}>
              <Detail />
            </Suspense>
          </Boundary>
        </aside>
      ) : null}
    </section>
  )
}

function ModalLayer() {
  const modal = useModal()
  const { closeModal } = useActions()
  if (!modal) return null
  const kind: ModalKind = modal.kind
  const Modal = MODALS[kind] as ComponentType<ModalProps>
  // Keyed by kind above the Suspense boundary: a modal replacing another (Cmd+N over
  // Search) while its code loads must not keep the old one mounted, hidden, as
  // Suspense does with children that suspend in place.
  return (
    <Boundary key={kind} name="This dialog">
      <Suspense fallback={null}>
        <Modal modal={modal} onClose={() => closeModal(kind)} />
      </Suspense>
    </Boundary>
  )
}
