import * as React from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export default class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, errorMessage: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Terminal Lite ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReload = () => {
    // Recovery must never erase watchlists, alerts or user preferences.
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          backgroundColor: '#0a0a0c',
          color: '#fff',
          fontFamily: 'Inter, sans-serif',
          textAlign: 'center',
          padding: '24px'
        }}>
          <h2 style={{ fontSize: '1.4rem', marginBottom: '12px', color: '#f43f5e' }}>⚠️ La interfaz encontró un error</h2>
          <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '24px', maxWidth: '420px', lineHeight: '1.5' }}>
            Podés recargar la aplicación sin borrar tus papeles, alertas ni configuraciones. Si el error se repite, compartí el detalle técnico.
          </p>
          <details style={{ maxWidth: '640px', marginBottom: '24px', textAlign: 'left' }}>
            <summary>Detalle técnico</summary>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '0.8rem' }}>{this.state.errorMessage}</pre>
          </details>
          <button
            onClick={this.handleReload}
            style={{
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              padding: '10px 24px',
              fontSize: '0.85rem',
              fontWeight: 'bold',
              cursor: 'pointer',
              boxShadow: '0 0 12px rgba(59, 130, 246, 0.3)'
            }}
          >
            🔄 Recargar sin borrar datos
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
