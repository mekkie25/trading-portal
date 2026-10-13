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
  errorMessage: string;
  errorStack: string;
}

class GlobalErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '', errorStack: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || String(error),
      errorStack: error?.stack || '',
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log the full details so F12 console has everything
    console.error('=== ERROR BOUNDARY CAUGHT ===');
    console.error('Message:', error?.message);
    console.error('Stack:', error?.stack);
    console.error('Component Stack:', errorInfo?.componentStack);
    console.error('=============================');
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#07090e] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="max-w-3xl w-full bg-[#0e1422] border border-[#1e273a] p-6 rounded-2xl shadow-2xl">
            <h2 className="text-lg font-bold text-rose-400 mb-2">Runtime Error Caught</h2>
            <p className="text-xs text-slate-400 mb-4">
              Copy everything below and share it to find the exact bug.
            </p>

            <div className="text-left mb-4">
              <div className="text-[10px] font-mono uppercase text-slate-500 mb-1">Error Message</div>
              <pre className="text-xs font-mono text-rose-300 bg-black/40 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-words">
{this.state.errorMessage || '(no message)'}
              </pre>
            </div>

            <div className="text-left mb-4">
              <div className="text-[10px] font-mono uppercase text-slate-500 mb-1">Stack Trace</div>
              <pre className="text-[10px] font-mono text-amber-200 bg-black/40 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-words max-h-64">
{this.state.errorStack || '(no stack)'}
              </pre>
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => {
                  const fullText = `MESSAGE:\n${this.state.errorMessage}\n\nSTACK:\n${this.state.errorStack}`;
                  navigator.clipboard.writeText(fullText).catch(() => {});
                }}
                className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-xs font-semibold text-white transition-all"
              >
                Copy Error
              </button>
              <button
                onClick={() => {
                  this.setState({ hasError: false, errorMessage: '', errorStack: '' });
                  window.location.reload();
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs font-semibold text-white transition-all"
              >
                Reload Portal
              </button>
            </div>
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