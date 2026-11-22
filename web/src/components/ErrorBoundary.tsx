import { Component, type ReactNode } from 'react';

/** If anything on the page crashes, show a way back instead of a blank white page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('MediLens page error', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card narrow crash" role="alert">
        <h2>Something went wrong</h2>
        <p className="muted">The page hit an unexpected error. Reloading usually fixes it.</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    );
  }
}
