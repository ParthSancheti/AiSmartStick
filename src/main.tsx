import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import './styles.css';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { BRAND_LOGO_URL } from './core/brand/BrandLogo';
import { BRAND } from './core/brand/brand';
import { applyPlatformClasses } from './util/platform';

// Platform capability flags on <html> (html.android, html.native, html.low-power) before the first
// paint, so the CSS never starts an expensive effect on a phone WebView and then removes it.
applyPlatformClasses(Capacitor.getPlatform());

// Favicon and title come from the single brand source.
document.title = BRAND.name;
const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
icon.href = BRAND_LOGO_URL;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
