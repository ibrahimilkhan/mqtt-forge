import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /**
   * What to show instead, for a boundary around a part that knows what failing means for it. Left
   * out, the notice that stands in for the whole console.
   */
  fallback?: (error: Error) => ReactNode;
};
type State = { error: Error | null };

// Class syntax required: React has no hook equivalent for catching render errors.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('MQTTForge crashed while rendering', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error);

    return (
      <div style={{ padding: '40px 20px' }}>
        <h2>Something went wrong</h2>
        <p>{this.state.error.message}</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
