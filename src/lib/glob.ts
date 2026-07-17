// Minimal glob matcher for repo-relative paths: `*`, `**`, `?` only.
// No braces, no extglob, no negation — the classifier's rule sets stay auditable.

function segmentToRegex(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return out;
}

export function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/");
  let re = "^";
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    if (segments[i] === "**") {
      // trailing `x/**` requires something under x; interior `**` spans zero+ segments
      re += last ? ".+" : "(?:[^/]+/)*";
    } else {
      re += segmentToRegex(segments[i] as string) + (last ? "" : "/");
    }
  }
  return new RegExp(`${re}$`);
}

export const globMatch = (pattern: string, path: string): boolean =>
  globToRegExp(pattern).test(path);
