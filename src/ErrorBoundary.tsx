import React from 'react';

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, color: '#ff4444', background: '#111', minHeight: '100vh', width: '100vw', zIndex: 99999, position: 'absolute', top: 0, left: 0 }}>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>React Runtime Error</h1>
          <p>Please share this error message with the developer:</p>
          <pre style={{ marginTop: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', background: '#222', padding: 10 }}>
            {this.state.error?.stack || this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
