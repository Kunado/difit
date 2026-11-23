import React from 'react';
import ReactDOM from 'react-dom/client';
import { HotkeysProvider } from 'react-hotkeys-hook';

import App from './App';
import { SessionList } from './components/SessionList';
import './styles/global.css';
import { chooseRootView } from './utils/rootView';
import { installSessionApiRouting } from './utils/sessionApi';

installSessionApiRouting();

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

const root = ReactDOM.createRoot(rootElement);

void chooseRootView().then((view) => {
  root.render(
    <React.StrictMode>
      {view === 'session-list' ? (
        <SessionList />
      ) : (
        <HotkeysProvider initiallyActiveScopes={['navigation']}>
          <App />
        </HotkeysProvider>
      )}
    </React.StrictMode>,
  );
});
