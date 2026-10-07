// A failing feature costs its own pane, not the whole page: the top bar, the other
// column and the status bar keep working, and the pane says what happened.
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  readonly name: string
  readonly children: ReactNode
}

export class Boundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Fleet: ${this.props.name} failed.`, error, info.componentStack)
  }

  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="empty" role="alert">
        {this.props.name} could not be shown. {this.state.error.message}
        <br />
        <button type="button" className="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    )
  }
}
