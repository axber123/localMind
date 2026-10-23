import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Renderer error boundary', error, info)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="fatal-error">
        <AlertTriangle size={28} />
        <h1>界面遇到错误</h1>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>重新加载</button>
      </div>
    )
  }
}
