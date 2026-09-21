import { MSG } from "./messages";

/**
 * The backend's whole password policy (packages/auth/accounts.py
 * `password_problem`): at least 8 characters and at most 72 UTF-8 bytes,
 * bcrypt's limit. Checked here first so the visitor gets a Thai message that
 * names the actual problem instead of a generic 422. Thai letters take 3 bytes
 * each, so a Thai-only password tops out at 24 characters.
 */
export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_BYTES = 72;

export function passwordProblem(password: string): string | null {
  // Count code points, as Python's len() does (an emoji is one, not two).
  if ([...password].length < PASSWORD_MIN_CHARS) return MSG.passwordRule;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return MSG.passwordTooLong;
  return null;
}
