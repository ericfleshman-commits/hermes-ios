import { registerRootComponent } from 'expo';
import App from './src/App';
import { ErrorBoundary } from './src/ErrorBoundary';

function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

registerRootComponent(Root);
