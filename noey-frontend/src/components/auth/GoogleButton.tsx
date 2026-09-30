import { Google_Sans } from "next/font/google";
import type { ButtonHTMLAttributes } from "react";

/**
 * The "Sign in with Google" button, drawn to Google's branding guidelines
 * for a custom button (fetched 2026-09-30):
 *   https://developers.google.com/identity/branding-guidelines
 *   assets: https://developers.google.com/static/identity/images/signin-assets.zip
 *
 *  - Light theme: fill #FFFFFF, 1px inside stroke #747775, text #1F1F1F.
 *    Dark theme: fill #131314, stroke #8E918F, text #E3E3E3 (follows the
 *    site theme, see .gsi-button in globals.css).
 *  - Google Sans Medium 14/20. Thai glyphs fall back to the site's Noto Sans
 *    Thai; the guidelines allow a localized call to action.
 *  - Web padding: 12px before the logo, 10px logo-to-text, 12px after the text.
 *    40px tall, pill shape, 20×20 standard-colour "G" (the size in the
 *    official Android + Web assets). The logo is never recoloured or resized.
 *
 * Google Sans is self-hosted by next/font (no request to Google at runtime)
 * and only on pages that render this button.
 */
const googleSans = Google_Sans({ weight: "500", subsets: ["latin"], display: "swap", preload: false, variable: "--font-google-sans", adjustFontFallback: false });

/** The standard-colour Google "G" (four fixed brand colours; do not restyle). */
export function GoogleG() {
  return (
    <svg className="gsi-button__logo" width="20" height="20" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** A submit button; the enclosing form decides what it does. */
export function GoogleButton({
  label,
  block = false,
  className,
  ...rest
}: { label: string; block?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const classes = ["gsi-button", googleSans.variable, block ? "gsi-button--block" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button type="submit" className={classes} {...rest}>
      <GoogleG />
      <span className="gsi-button__label">{label}</span>
    </button>
  );
}
