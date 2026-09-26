// ScreenPilot — Deterministic PII / secret detector
//
// Pure, dependency-free, network-free. Sensitivity is decided ONLY by the
// fixed rules below (DOM metadata + regex/checksum patterns) — never by an LLM.
// Shared by PrivacySanitizer (page-state elements), PiiVault (outgoing text)
// and the sensitive-field guard (live DOM elements).
//
// Nothing here ever returns, stores or logs a matched value: detection results
// are { type, start, end } spans, and callers slice the text themselves.

export const SensitiveType = Object.freeze({
  PASSWORD:      'password',
  OTP:           'otp',
  EMAIL:         'email',
  PHONE:         'phone',
  CREDIT_CARD:   'credit_card',
  SSN:           'ssn',
  BANK_ACCOUNT:  'bank_account',
  ADDRESS:       'address',
  DATE_OF_BIRTH: 'date_of_birth',
  JWT:           'jwt',
  API_KEY:       'api_key',
  SECRET:        'secret'
});
const T = SensitiveType;

// ── DOM metadata rules ───────────────────────────────────────────────────────

const INPUT_TYPE_MAP = {
  password: T.PASSWORD,
  email:    T.EMAIL,
  tel:      T.PHONE
};

// WHATWG autofill tokens.
const AUTOCOMPLETE_MAP = {
  'current-password': T.PASSWORD,
  'new-password':     T.PASSWORD,
  'one-time-code':    T.OTP,
  'cc-number':        T.CREDIT_CARD,
  'cc-csc':           T.CREDIT_CARD,
  'cc-exp':           T.CREDIT_CARD,
  'cc-exp-month':     T.CREDIT_CARD,
  'cc-exp-year':      T.CREDIT_CARD,
  'cc-name':          T.CREDIT_CARD,
  'email':            T.EMAIL,
  'tel':              T.PHONE,
  'tel-national':     T.PHONE,
  'street-address':   T.ADDRESS,
  'address-line1':    T.ADDRESS,
  'address-line2':    T.ADDRESS,
  'postal-code':      T.ADDRESS,
  'bday':             T.DATE_OF_BIRTH,
  'ssn':              T.SSN
};

// Label / placeholder / aria-label / name / id keywords. Whole-word matches
// (after `_`/`-` are turned into spaces) so unrelated text that merely contains
// a substring does not trigger. Order matters: first match wins.
const LABEL_RULES = [
  [/\b(?:password|passcode)\b/i,                                            T.PASSWORD],
  [/\b(?:otp|one[- ]time[- ]code)\b/i,                                      T.OTP],
  [/\b(?:cvv|cvc|security\s*code|card\s*number|credit\s*card|debit\s*card)\b/i, T.CREDIT_CARD],
  [/\b(?:ssn|social\s*security)\b/i,                                        T.SSN],
  [/\b(?:routing\s*number|account\s*number|iban)\b/i,                       T.BANK_ACCOUNT],
  [/\b(?:api\s*key|secret\s*key|private\s*key|client\s*secret)\b/i,         T.API_KEY],
  [/\b(?:auth\s*token|access\s*token|pin\s*code)\b/i,                       T.SECRET]
];

function byInputType(type) {
  return INPUT_TYPE_MAP[String(type || '').toLowerCase()] ?? null;
}

function byAutocomplete(autocomplete) {
  return AUTOCOMPLETE_MAP[String(autocomplete || '').toLowerCase()] ?? null;
}

function byLabel(...strings) {
  for (const raw of strings) {
    if (typeof raw !== 'string' || !raw) continue;
    const s = raw.replace(/[_-]+/g, ' ');
    for (const [re, type] of LABEL_RULES) {
      if (re.test(s)) return type;
    }
  }
  return null;
}

// ── Content patterns ─────────────────────────────────────────────────────────

const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;

// Well-known credential shapes. Every pattern requires a distinctive prefix, so
// ordinary hyphenated words/slugs do not match.
const API_KEY_RES = [
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,           // OpenAI / OpenRouter / Anthropic style
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                              // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,                         // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                         // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                          // AWS access key id
  /\bglpat-[A-Za-z0-9_-]{20,}/g,                             // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g,                                // npm
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g                     // Authorization header value
];
const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

// `password=…`, `api_key: …`, `token = …` — only the VALUE is the sensitive
// span, so the key name stays readable. Uses hasIndices to find the value.
const ASSIGNMENT_RE = /\b(pass(?:word|wd)?|pwd|secret|client[_-]?secret|api[_-]?key|(?:access|auth|refresh|id)[_-]?token|token)\b\s*[:=]\s*["']?([^\s"'&;,<>]{6,})/gid;
// "my password is hunter2"
const SPOKEN_PASSWORD_RE = /\b(password|passcode|passwd)\s+is\s+["']?([^\s"'&;,<>]{4,})/gid;

const CARD_RE  = /\b\d(?:[ -]?\d){12,18}\b/g;
const SSN_RE   = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// NANP-style / bare 10-digit numbers (incl. an optional 1–2 digit country
// prefix such as "+91 9876543210"), and generic E.164-ish "+…" numbers.
const PHONE_RES = [
  /(?<![\w])(?:\+?\d{1,2}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}(?!\d)/g,
  /(?<![\w])\+\d[\d ()-]{7,15}\d(?!\d)/g
];

/** Luhn checksum — separates real card numbers from arbitrary long digit runs. */
export function isLuhnValid(digits) {
  const s = String(digits).replace(/\D/g, '');
  if (s.length < 13 || s.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = s.charCodeAt(i) - 48;
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function assignmentType(keyName) {
  if (/pass|pwd/i.test(keyName)) return T.PASSWORD;
  if (/key/i.test(keyName)) return T.API_KEY;
  return T.SECRET;
}

/**
 * Find sensitive spans in free text. Non-overlapping, sorted by position.
 * Earlier rules win overlaps (secrets before contact details).
 *
 * @param {string} text
 * @returns {{type: string, start: number, end: number}[]}
 */
export function findPII(text) {
  if (typeof text !== 'string' || !text) return [];
  const spans = [];

  const overlaps = (s, e) => spans.some((x) => s < x.end && e > x.start);
  const add = (type, start, end) => {
    if (end > start && !overlaps(start, end)) spans.push({ type, start, end });
  };
  const scan = (re, type, accept) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (!accept || accept(m[0])) add(type, m.index, m.index + m[0].length);
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  const scanAssignments = (re, typeOf) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const [start, end] = m.indices[2];
      add(typeOf(m[1]), start, end);
    }
  };

  scan(PRIVATE_KEY_RE, T.SECRET);
  scan(JWT_RE, T.JWT);
  API_KEY_RES.forEach((re) => scan(re, T.API_KEY));
  scanAssignments(ASSIGNMENT_RE, assignmentType);
  scanAssignments(SPOKEN_PASSWORD_RE, () => T.PASSWORD);
  scan(CARD_RE, T.CREDIT_CARD, isLuhnValid);
  scan(SSN_RE, T.SSN);
  scan(EMAIL_RE, T.EMAIL);
  PHONE_RES.forEach((re) => scan(re, T.PHONE));

  return spans.sort((a, b) => a.start - b.start);
}

/** Type of the first sensitive span in `text`, or null. */
export function detectType(text) {
  const spans = findPII(text);
  return spans.length ? spans[0].type : null;
}

/** Irreversibly replace every sensitive span — for logs and debug output. */
export function redactText(text, replacement = '[REDACTED]') {
  if (typeof text !== 'string' || !text) return text;
  const spans = findPII(text);
  if (!spans.length) return text;
  let out = '';
  let last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start) + replacement;
    last = s.end;
  }
  return out + text.slice(last);
}

/**
 * Classify a normalized page-state element (see page-state-service.js) or a
 * plain descriptor built from a live DOM element's attributes.
 * Rule order: input type → autocomplete → label keywords → field content.
 *
 * @param {{type?:string, autocomplete?:string, placeholder?:string, ariaLabel?:string,
 *          name?:string, id?:string, label?:string, value?:string, text?:string}} el
 * @returns {string|null} a SensitiveType, or null when nothing sensitive is detected
 */
export function classifyElement(el) {
  if (!el) return null;
  return (
    byInputType(el.type) ||
    byAutocomplete(el.autocomplete) ||
    byLabel(el.placeholder, el.ariaLabel, el.name, el.id, el.label) ||
    detectType(el.value) ||
    detectType(el.text) ||
    null
  );
}

// ── URL / key-name helpers (used by PiiVault's URL sanitizer) ────────────────

// Query/fragment parameter names whose VALUE is credential-like or personal,
// regardless of what the value looks like.
const SENSITIVE_PARAM_RE = /^(?:token|access[_-]?token|id[_-]?token|refresh[_-]?token|api[_-]?key|apikey|key|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|session|session[_-]?id|sessionid|sid|code|otp|signature|sig|jwt|bearer|ticket|email|e-?mail|phone|mobile|tel)$/i;

// Object KEY names (in structured payloads) that denote a credential. Narrower
// than the URL list: email/phone values are handled by content detection.
const SENSITIVE_KEY_RE = /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|bearer|jwt|private[_-]?key|client[_-]?secret)$/i;

export function isSensitiveParamName(name) {
  return SENSITIVE_PARAM_RE.test(String(name || ''));
}

export function isSensitiveKeyName(name) {
  return SENSITIVE_KEY_RE.test(String(name || ''));
}
