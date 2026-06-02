import type { IStaticMethods } from "preline";

// Declare types for our window exports used by Preline
declare global {
  const __WORKTREE_APP_NAME__: string;
  const __WORKTREE_APP_TITLE__: string;
  const __WORKTREE_APP_VERSION__: string;
  const __WORKTREE_APP_LICENSE__: string;
  const __WORKTREE_APP_COPYRIGHT__: string;
  const __WORKTREE_DASHBOARD_API_BASE__: string;
  const __WORKTREE_API_BASE__: string;

  interface Window {
    // Preline UI
    HSStaticMethods: IStaticMethods;
  }
}
