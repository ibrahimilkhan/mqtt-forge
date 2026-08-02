import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { hub } from './realtime/hub';
import { startApplyingAppearance } from './features/appearance/applyAppearance';
import './styles/global.css';

const queryClient = new QueryClient();

// Applies the stored font/size before React paints, to avoid a flash of default type.
startApplyingAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App hub={hub} />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
