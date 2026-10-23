/** The app shell's scroll container: the page itself never scrolls (see app/layout.tsx). */
export const SCROLL_ROOT_ID = 'app-scroll';

export function scrollShellToTop(): void {
  document.getElementById(SCROLL_ROOT_ID)?.scrollTo({ top: 0 });
}
