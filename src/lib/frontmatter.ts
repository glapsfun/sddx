// The YAML frontmatter of a skill or agent file, read the same way by session
// start (which strips it from the router it injects) and by the token budget
// (which measures what is left). Line endings are normalized first, so a file
// saved with CRLF is read like one saved with LF.

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

const lf = (markdown: string): string => markdown.replace(/\r\n?/g, "\n");

/** A frontmatter key's value, including a `>` or `|` block scalar's indented lines. */
export function frontmatterValue(markdown: string, key: string): string | null {
  const fm = FRONTMATTER.exec(lf(markdown))?.[1];
  if (fm === undefined) return null;
  const lines = fm.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (i === -1) return null;
  const inline = (lines[i] as string).slice(key.length + 1).trim();
  if (!/^[>|][-+]?$/.test(inline)) return inline;
  const block: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (!/^\s+\S/.test(l)) break;
    block.push(l.trim());
  }
  return block.join(inline.startsWith(">") ? " " : "\n");
}

export const withoutFrontmatter = (markdown: string): string =>
  lf(markdown).replace(FRONTMATTER, "").trim();
