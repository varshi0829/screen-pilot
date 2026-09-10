// ScreenPilot v3 — Local Privacy Sanitizer (privacy-vision Phase 1)
//
// Detects and redacts sensitive DOM field content entirely locally, before a
// page state (or any bounding box derived from it) is eligible to leave the
// device in a cloud request. Small, dependency-free, and reusable by both
// PageStateService (text/value redaction) and ScreenshotService (pixel
// region redaction — see getSensitiveRegions).
//
// Detection only ever inspects local, already-extracted DOM signals (input
// type, autocomplete, label/placeholder/aria-label text, and the field's own
// text/value content) — nothing here makes a network call or depends on one.

export const REDACTED = '[REDACTED]';

// HTML input types that are inherently sensitive regardless of content.
const SENSITIVE_INPUT_TYPES = new Set(['password', 'email', 'tel']);

// autocomplete tokens (WHATWG autofill spec) that flag a field as sensitive
// even when its input `type` is generic (e.g. type="text" autocomplete="cc-number").
const SENSITIVE_AUTOCOMPLETE = new Set([
  'current-password', 'new-password', 'one-time-code',
  'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-name',
  'email', 'tel', 'tel-national',
  'street-address', 'address-line1', 'address-line2', 'postal-code',
  'bday', 'ssn'
]);

// Label/placeholder/aria-label keyword signals — whole-word matches so we
// don't over-trigger on unrelated text that happens to contain a substring.
const SENSITIVE_LABEL_PATTERN = new RegExp(
  '\\b(' + [
    'password', 'passcode', 'pin\\s*code', 'otp', 'one[- ]time[- ]code',
    'cvv', 'cvc', 'security\\s*code', 'card\\s*number', 'credit\\s*card',
    'ssn', 'social\\s*security', 'routing\\s*number', 'account\\s*number',
    'api\\s*key', 'secret\\s*key', 'auth\\s*token'
  ].join('|') + ')\\b',
  'i'
);

// Obvious PII patterns matched against a field's own rendered/typed content,
// independent of what kind of field it is.
const PII_PATTERNS = [
  { name: 'email',       re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: 'ssn',         re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'phone',       re: /\b(?:\+?\d{1,2}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}\b/ },
];

function isSensitiveInputType(type) {
  return SENSITIVE_INPUT_TYPES.has(String(type || '').toLowerCase());
}

function isSensitiveAutocomplete(autocomplete) {
  return SENSITIVE_AUTOCOMPLETE.has(String(autocomplete || '').toLowerCase());
}

function hasSensitiveLabelSignal(...strings) {
  return strings.some((s) => typeof s === 'string' && s && SENSITIVE_LABEL_PATTERN.test(s));
}

function containsPII(text) {
  if (!text || typeof text !== 'string') return false;
  return PII_PATTERNS.some((p) => p.re.test(text));
}

/**
 * Decide whether a normalized page-state element (see page-state-service.js)
 * carries, or is structurally likely to carry, sensitive content that must
 * not leave the device.
 *
 * @param {object} el - normalized element ({ type, autocomplete, placeholder, ariaLabel, text, value, ... })
 * @returns {boolean}
 */
function isSensitiveElement(el) {
  if (!el) return false;
  if (isSensitiveInputType(el.type)) return true;
  if (isSensitiveAutocomplete(el.autocomplete)) return true;
  if (hasSensitiveLabelSignal(el.placeholder, el.ariaLabel)) return true;
  if (containsPII(el.value) || containsPII(el.text)) return true;
  return false;
}

/**
 * Return a redacted copy of a normalized element. Grounding metadata that is
 * not itself sensitive content (role, tag, id, region, bbox, visible,
 * enabled, placeholder, ariaLabel — i.e. what the field *is*, not what was
 * typed into it) is preserved unchanged; only `text`/`value` content is
 * replaced. Non-sensitive elements are returned as-is.
 *
 * @param {object} el
 * @returns {object}
 */
function sanitizeElement(el) {
  if (!isSensitiveElement(el)) return el;
  return {
    ...el,
    text:  el.text  ? REDACTED : el.text,
    value: el.value ? REDACTED : el.value,
    sensitive: true
  };
}

/**
 * Sanitize a full elements array. Returns a new array; the input is left
 * untouched.
 *
 * @param {object[]} elements
 * @returns {object[]}
 */
function sanitizeElements(elements) {
  if (!Array.isArray(elements)) return elements;
  return elements.map(sanitizeElement);
}

/**
 * Collect the bounding boxes of sensitive elements, for masking the matching
 * regions of a screenshot before it is compressed/encoded.
 *
 * @param {object[]} elements
 * @returns {{x:number,y:number,width:number,height:number}[]}
 */
function getSensitiveRegions(elements) {
  if (!Array.isArray(elements)) return [];
  return elements
    .filter(isSensitiveElement)
    .map((el) => el.bbox)
    .filter((bbox) => bbox && bbox.width > 0 && bbox.height > 0);
}

export const PrivacySanitizer = {
  REDACTED,
  isSensitiveElement,
  sanitizeElement,
  sanitizeElements,
  getSensitiveRegions
};

if (typeof globalThis !== 'undefined' && globalThis.module) {
  globalThis.module.exports = PrivacySanitizer;
}
