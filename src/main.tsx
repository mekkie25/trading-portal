import { StrictMode, Component, ReactNode, ErrorInfo } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Safely catch cross-origin script errors from external embedded widgets
window.addEventListener('error', (event) => {
  if (event.message === 'Script error.' || !event.filename) {
    event.preventDefault();
    return true;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  if (
    event.reason && 
    (event.reason.message === 'Script error.' || String(event.reason).includes('TradingView') || String(event.reason).includes('blocked'))
  ) {
    event.preventDefault();
  }
});

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.warn('ErrorBoundary handled runtime error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#07090e] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="max-w-md bg-[#0e1422] border border-[#1e273a] p-6 rounded-2xl shadow-2xl">
            <h2 className="text-lg font-bold text-white mb-2">Portal Interface Reconnecting</h2>
            <p className="text-xs text-slate-400 mb-4">
              A temporary runtime issue occurred. State is preserved.
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false });
                window.location.reload();
              }}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-semibold text-white transition-all shadow-[0_0_15px_rgba(59,130,246,0.4)]"
            >
              Reload Portal Workspace
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>,
);

