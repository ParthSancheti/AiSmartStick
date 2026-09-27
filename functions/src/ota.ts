import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { CALLABLE, requireAuth, db } from './common';

const REPO_OWNER = 'project-owner'; // In a real app, this comes from config
const REPO_NAME = 'ai-smart-stick';

export const getLatestFirmwareRelease = onCall({ ...CALLABLE, timeoutSeconds: 30, memory: '256MiB' }, async (request) => {
  requireAuth(request);
  
  // Try cache first
  const cacheRef = db.collection('system').doc('otaCache');
  const cache = await cacheRef.get();
  if (cache.exists) {
    const data = cache.data()!;
    if (Date.now() - data.updatedAt < 3600000) {
      return data.release;
    }
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, {
      headers: {
        'User-Agent': 'AI-Smart-Stick-Backend'
      }
    });

    if (!res.ok) {
      if (res.status === 404) return null; // No releases yet
      throw new Error(`GitHub API returned ${res.status}`);
    }

    const release = (await res.json()) as any;
    const manifestAsset = release.assets?.find((a: any) => a.name === 'firmware-manifest.json');
    if (!manifestAsset) return null;

    const manifestRes = await fetch(manifestAsset.browser_download_url);
    if (!manifestRes.ok) throw new Error('Failed to fetch manifest');
    
    const manifest = await manifestRes.json();
    
    // Store in cache
    await cacheRef.set({
      updatedAt: Date.now(),
      release: manifest
    });

    return manifest;
  } catch (error) {
    console.error('OTA fetch error:', error);
    // On error, fallback to cache if available
    if (cache.exists) return cache.data()!.release;
    throw new HttpsError('internal', 'Could not check for updates');
  }
});
