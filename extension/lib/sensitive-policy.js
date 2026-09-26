// ScreenPilot — Sensitive-data policy
//
// A fixed, deterministic table: what each SensitiveType means for (a) text that
// leaves the device and (b) the on-screen guidance for a field of that type.
// No model ever decides sensitivity or handling — this table does.
//
// ScreenPilot is GUIDE-ONLY: it highlights a field and waits; it never clicks
// or types. `autonomousFill` is therefore `false` for every type and is
// asserted by tests, so a future change cannot silently loosen that.
//
//  • outbound 'placeholder' — reversible per-task token ([EMAIL_1]) that the
//    model can reason about; the real value stays in the local PiiVault.
//  • outbound 'redact'      — irreversibly replaced ([REDACTED]); never enters
//    the vault, so it can never be restored or sent anywhere.

import { SensitiveType as T } from './pii-detector.js';

export const Outbound = Object.freeze({
  PLACEHOLDER: 'placeholder',
  REDACT:      'redact'
});

function entry(outbound, noun) {
  return Object.freeze({ outbound, noun, guidance: 'user_enters', autonomousFill: false });
}

const POLICY = Object.freeze({
  [T.PASSWORD]:      entry(Outbound.REDACT,      'password'),
  [T.OTP]:           entry(Outbound.REDACT,      'one-time code'),
  [T.CREDIT_CARD]:   entry(Outbound.REDACT,      'card details'),
  [T.SSN]:           entry(Outbound.REDACT,      'Social Security number'),
  [T.BANK_ACCOUNT]:  entry(Outbound.REDACT,      'bank account details'),
  [T.ADDRESS]:       entry(Outbound.REDACT,      'address'),
  [T.DATE_OF_BIRTH]: entry(Outbound.REDACT,      'date of birth'),
  [T.JWT]:           entry(Outbound.REDACT,      'access token'),
  [T.API_KEY]:       entry(Outbound.REDACT,      'API key'),
  [T.SECRET]:        entry(Outbound.REDACT,      'secret value'),
  // Contact details are useful for the model to reason about ("send to
  // [EMAIL_1]"), so they get reversible placeholders instead of a hard redact.
  [T.EMAIL]:         entry(Outbound.PLACEHOLDER, 'email address'),
  [T.PHONE]:         entry(Outbound.PLACEHOLDER, 'phone number')
});

/** @returns {Readonly<{outbound:string, noun:string, guidance:string, autonomousFill:false}>|null} */
export function getPolicy(type) {
  return POLICY[type] ?? null;
}

/** How a detected value of `type` must be treated before leaving the device. Unknown types fail closed. */
export function outboundHandling(type) {
  return POLICY[type]?.outbound ?? Outbound.REDACT;
}

/** Always false: ScreenPilot never fills sensitive (or any) fields on the user's behalf. */
export function allowsAutonomousFill(type) {
  return POLICY[type]?.autonomousFill === true;
}

/**
 * On-screen instruction for a highlighted field of a sensitive type. Contains
 * no value and no page text — only the policy noun.
 * @returns {string|null} null when `type` is not a known sensitive type
 */
export function fieldInstruction(type) {
  const p = POLICY[type];
  if (!p) return null;
  return `Enter your ${p.noun} in the highlighted field yourself — ScreenPilot never reads, stores, or types it.`;
}

export const POLICY_TYPES = Object.freeze(Object.keys(POLICY));
