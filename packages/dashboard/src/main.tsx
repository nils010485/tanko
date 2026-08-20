import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { ToastProvider } from './components/toast.js';
import { I18nProvider } from './i18n/index.js';
import './index.css';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

ReactDOM.createRoot(container).render(
    <React.StrictMode>
        <I18nProvider>
            <ToastProvider>
                <App />
            </ToastProvider>
        </I18nProvider>
    </React.StrictMode>
);
