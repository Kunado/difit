import React from 'react';
import ReactDOM from 'react-dom/client';
import { HotkeysProvider } from 'react-hotkeys-hook';

import App from './App';
import './styles/global.css';
import { installSessionApiRouting } from './utils/sessionApi';

installSessionApiRouting();

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <HotkeysProvider initiallyActiveScopes={['navigation']}>
      <App />
    </HotkeysProvider>
  </React.StrictMode>,
);
