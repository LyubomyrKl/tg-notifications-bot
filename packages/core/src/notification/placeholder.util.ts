/**
 * Placeholder engine for notification templates. A placeholder is `{name}` with
 * an alphanumeric/underscore name. Parsing is cached on write; rendering rejects
 * any unfilled placeholder so a broadcast can never go out half-templated.
 */
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/** Extract unique placeholder names from a template body, in first-seen order. */
export function parsePlaceholders(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

export class UnfilledPlaceholdersError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Cannot render: missing value(s) for placeholder(s): ${missing
        .map((m) => `{${m}}`)
        .join(', ')}`,
    );
    this.name = 'UnfilledPlaceholdersError';
  }
}

/**
 * Substitute placeholder values into a body. Throws
 * {@link UnfilledPlaceholdersError} when any required placeholder has no
 * (non-empty) value — the "publishing with unfilled placeholders is rejected"
 * rule, enforced in one place for both preview and broadcast.
 */
export function renderTemplate(
  body: string,
  values: Record<string, string>,
): string {
  const required = parsePlaceholders(body);
  const missing = required.filter(
    (name) => values[name] === undefined || values[name] === '',
  );
  if (missing.length > 0) {
    throw new UnfilledPlaceholdersError(missing);
  }
  return body.replace(PLACEHOLDER_RE, (_, name: string) => values[name]);
}
