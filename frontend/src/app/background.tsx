// The background registry: controllers that render nothing and run whatever view is
// open (the session tones, Today's report-backs). AppShell mounts each once, under
// the providers, so they see every snapshot and announce on any view. A controller
// that throws is logged and dropped; it never takes a pane with it.
import { Component, type ComponentType, type ErrorInfo, type ReactNode, Suspense, lazy } from 'react'

const named = <N extends string>(load: () => Promise<Record<N, ComponentType>>, name: N) =>
  lazy(() => load().then(module => ({ default: module[name] })))

export const BACKGROUND: ReadonlyArray<readonly [string, ComponentType]> = [
  ['sounds', named(() => import('../features/sounds/SoundController'), 'SoundController')],
  ['report-back', named(() => import('../features/today/ReportBack'), 'ReportBack')],
]

class Silent extends Component<{ readonly name: string; readonly children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Fleet: the ${this.props.name} controller failed.`, error, info.componentStack)
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}

export function Background() {
  return (
    <>
      {BACKGROUND.map(([name, Controller]) => (
        <Silent key={name} name={name}>
          <Suspense fallback={null}>
            <Controller />
          </Suspense>
        </Silent>
      ))}
    </>
  )
}
