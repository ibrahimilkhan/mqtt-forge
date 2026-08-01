import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { hub } from './realtime/hub';
import { startApplyingAppearance } from './features/appearance/applyAppearance';
import './styles/global.css';

const queryClient = new QueryClient();

// Before the first render: the stored font and size must be in place by the time React
// paints, otherwise the app flashes in the default type for a frame.
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
