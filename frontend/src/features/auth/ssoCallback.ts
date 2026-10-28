/**
 * Results the single sign-on callback hands back to the SPA as query params
 * (`/?sso_mfa=`, `/?sso_link=`, `/?sso_email=`, `/?sso_error=`). They are read
 * once at startup and stripped from the URL straight away.
 */

export type SsoMfaStep = "challenge" | "setup";
export type SsoNotice = { tone: "success" | "error"; message: string };
export type SsoCallback = {
  /** The callback needs the NetMap 2FA code (or 2FA setup) before it issues a session. */
  mfa: SsoMfaStep | null;
  /** Outcome to show: on the sign-in screen when signed out, on Profile when signed in. */
  notice: SsoNotice | null;
};

const TOKEN_ERROR = "Your identity provider's response couldn't be verified. Please try again or contact your administrator.";
const PROVIDER_SETUP_ERROR = "Single sign-on isn't set up correctly. Contact your administrator.";

const SSO_ERROR_MESSAGES: Record<string, string> = {
  reauth_required: "Sign in again at your identity provider to confirm this change. Nothing was changed, so please try again.",
  reauth_mismatch: "That sign-in doesn't match the identity linked to your account, so nothing was changed.",
  identity_in_use: "That identity is already linked to another NetMap account.",
  already_linked: "Single sign-on is already linked to your account.",
  account_not_linked: "This sign-in isn't linked to a NetMap account. If you already have an account, sign in with your password and link single sign-on from your Profile.",
  invalid_state: "The sign-in attempt expired or was invalid. Please try again.",
  account_disabled: "This account is disabled. Contact your administrator.",
  provider_denied: "Sign-in was cancelled or denied at the identity provider.",
  provider_error: "The identity provider returned an error. Please try again.",
  provider_unreachable: "Could not reach the identity provider. Try again or contact your administrator.",
  sso_disabled: "Single sign-on is not enabled on this server.",
  email_unverified: "Your email address is not verified with the identity provider.",
  email_domain_denied: "Your email domain is not allowed to sign in here.",
  email_missing: "The identity provider did not supply an email address for your account.",
  token_exchange_failed: TOKEN_ERROR,
  id_token_invalid: TOKEN_ERROR,
  id_token_expired: TOKEN_ERROR,
  nonce_mismatch: TOKEN_ERROR,
  audience_mismatch: TOKEN_ERROR,
  issuer_mismatch: TOKEN_ERROR,
  jwks_invalid: TOKEN_ERROR,
  provider_invalid_response: PROVIDER_SETUP_ERROR,
  provider_metadata_invalid: PROVIDER_SETUP_ERROR,
  insecure_provider_url: PROVIDER_SETUP_ERROR,
};

export function ssoErrorMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(SSO_ERROR_MESSAGES, code)
    ? SSO_ERROR_MESSAGES[code]
    : "Single sign-on didn't complete. Please try again or contact your administrator.";
}

const PARAMS = ["sso_mfa", "sso_link", "sso_email", "sso_error"] as const;

let consumed: SsoCallback | null = null;
let profileNotice: SsoNotice | null = null;

function readParams(): SsoCallback {
  const params = new URLSearchParams(window.location.search);
  const mfaParam = params.get("sso_mfa");
  const mfa: SsoMfaStep | null = mfaParam === "challenge" || mfaParam === "setup" ? mfaParam : null;
  const error = params.get("sso_error");
  let notice: SsoNotice | null = null;
  if (error) notice = { tone: "error", message: ssoErrorMessage(error) };
  else if (params.get("sso_link") === "linked") notice = { tone: "success", message: "Single sign-on is now linked to your account." };
  else if (params.get("sso_email") === "changed") notice = { tone: "success", message: "Your email address has been changed." };

  if (PARAMS.some((name) => params.has(name))) {
    PARAMS.forEach((name) => params.delete(name));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
  }
  return { mfa, notice };
}

/** Reads and strips the callback params; later calls return the same result. */
export function consumeSsoCallback(): SsoCallback {
  if (!consumed) {
    consumed = readParams();
    profileNotice = consumed.notice;
  }
  return consumed;
}

/** The callback outcome for Profile, handed out once. */
export function takeSsoProfileNotice(): SsoNotice | null {
  const notice = profileNotice;
  profileNotice = null;
  return notice;
}

/** Drop the Profile notice (the user is signed out and saw it on the sign-in screen). */
export function discardSsoProfileNotice() {
  profileNotice = null;
}
