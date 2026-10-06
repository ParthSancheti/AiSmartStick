import { useEffect } from 'react';
import { useUI } from '../core/store/ui';
import { useSession } from '../core/store/session';

/** Screens worth reopening after the app was closed or the process was recreated. */
const PAGES = ['mapOpen', 'batteryPage', 'stickPage', 'healthOpen', 'liveAiOpen', 'audioOpen', 'userSettings'] as const;
type Page = (typeof PAGES)[number];

/**
 * Persists the last meaningful Home sub-page (session.lastSubPage, local storage) and reopens it on
 * the next launch, so an Android process kill or activity recreation does not dump the user on
 * Home in the middle of a walk.
 */
export function useResumeLastPage(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const last = useSession.getState().lastSubPage as Page | undefined;
    if (last && (PAGES as readonly string[]).includes(last)) useUI.setState({ [last]: true } as Partial<Record<Page, boolean>>);
    return useUI.subscribe((s, prev) => {
      if (PAGES.every((p) => s[p] === prev[p])) return;
      const open = PAGES.find((p) => s[p]);
      useSession.setState({ lastSubPage: open ?? undefined });
    });
  }, [enabled]);
}
