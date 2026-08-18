import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import { ToastProvider } from './components/toast.js';
import { I18nProvider } from './i18n/index.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <I18nProvider>
            <ToastProvider>
                <App />
            </ToastProvider>
        </I18nProvider>
    </React.StrictMode>
);
