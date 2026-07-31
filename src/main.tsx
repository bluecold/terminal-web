import { Component, type ReactNode, type ErrorInfo, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Terminal Lite ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    localStorage.clear();
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
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
          <h2 style={{ fontSize: '1.4rem', marginBottom: '12px', color: '#f43f5e' }}>⚠️ Se requiere actualizar la caché local</h2>
          <p style={{ color: '#9ca3af', fontSize: '0.85rem', marginBottom: '24px', maxWidth: '420px', lineHeight: '1.5' }}>
            Hubo un conflicto con datos de alertas guardados en una versión previa. Limpiá la caché local para restaurar la interfaz.
          </p>
          <button
            onClick={this.handleReset}
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
            🔄 Restablecer Caché y Recargar Terminal
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
