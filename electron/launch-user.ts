import type { AuthUserRecord } from "./db";

/**
 * Who is using Pipper when sign-in is turned off (CLERK_ENABLED in contracts/features.ts). Never
 * stored and never sent to analytics: every install would share this id, so
 * identifying it would merge all users into one person.
 */
export const LOCAL_USER: Readonly<AuthUserRecord> = Object.freeze({
  provider: "local",
  provider_user_id: "local",
  email: null,
  name: null,
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
  last_seen_at: 0,
});

/**
 * The user the launch flow and project actions run as. With sign-in on, only
 * a completed sign-in counts; with it off, everyone is the local user, even
 * on installs that signed in before.
 */
export function resolveLaunchUser(
  signInEnabled: boolean,
  stored: AuthUserRecord | null,
): AuthUserRecord | null {
  if (!signInEnabled) return LOCAL_USER;
  if (!stored?.provider_user_id || !stored.email) return null;
  return stored;
}

/** Only real sign-ins are identified in analytics; the local user stays anonymous. */
export function isIdentifiableUser(user: AuthUserRecord | null): user is AuthUserRecord {
  return user !== null && user.provider !== LOCAL_USER.provider;
}
