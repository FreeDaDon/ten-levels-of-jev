/**
 * Level 6, shared: the deterministic first pass for credentials.
 * Recognizing a key by its shape is a pattern job, not a judgment, so code does it over the whole text and Jev is
 * the second opinion for what no pattern names. Findings carry the kind of secret, never its value: the reason a
 * gate returns is read by the agent and written to logs.
 */

/** Values that say they are not real: masked, templated, or named like a stand in anywhere in the value. */
const PLACEHOLDER = /^(x{3,}|\*{3,}|\.{3,}|<.*>|\{.*\}|todo|none|null|undefined|test|secret|password|token|[A-Za-z_]+(\.[A-Za-z_]+)+)$|process\.env|\benv\.|environ|getenv|secrets\.|replace[-_ ]?me|change[-_ ]?me|your[-_ ]?(key|secret|token|password)|example|dummy|placeholder|redacted/i;

interface Pattern {
  name: string;
  re: RegExp;
  /** The capture group holding the value, when the whole match is not the secret. */
  group?: number;
}

const PATTERNS: Pattern[] = [
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "API key", re: /\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}/ },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "password in a connection string", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s:@/]{3,})@/i, group: 1 },
  {
    name: "credential assignment",
    re: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?([A-Za-z0-9/+_.=-]{12,})/i,
    group: 1,
  },
];

export interface SecretFinding {
  /** The kind of secret. Never the value. */
  name: string;
}

/** Every distinct kind of credential found anywhere in `text`. */
export function findSecrets(text: string): SecretFinding[] {
  const found = new Set<string>();
  for (const { name, re, group } of PATTERNS) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    for (const m of text.matchAll(new RegExp(re.source, flags))) {
      const value = group === undefined ? m[0] : m[group];
      if (group !== undefined && PLACEHOLDER.test(value ?? "")) continue;
      found.add(name);
      break;
    }
  }
  return [...found].map((name) => ({ name }));
}
