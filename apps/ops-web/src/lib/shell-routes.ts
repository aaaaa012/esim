const SHELL_FREE_PATHS = [
  "/sign-in",
  "/staff-onboarding",
  "/staff-activate",
  "/super-admin",
  "/access-error",
  "/unauthorized",
  "/change-password",
] as const;

export const isShellFreePath = (pathname: string) =>
  SHELL_FREE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
