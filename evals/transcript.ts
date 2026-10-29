// Reads a headless session's transcript for the two things graders may use: the
// shell commands the agent ran, and its final reply. Claude Code writes
// `stream-json` (one event per line, a `result` event last); Codex writes
// `exec --json` (thread, turn and item events). A transcript that is not that
// shape throws, and the runner records the session as an error.
import type { Command, Transcript } from "./types";

type Json = Record<string, unknown>;

function events(text: string): Json[] {
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as Json);
    } catch {
      throw new Error(`transcript line is not JSON: ${line.slice(0, 80)}`);
    }
  }
  return out;
}

const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

export function readClaudeTranscript(text: string): Transcript {
  const commands: Command[] = [];
  const byId = new Map<string, Command>();
  let model: string | undefined;
  let result: Json | undefined;
  for (const e of events(text)) {
    if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") model = e.model;
    const content = obj(e.message).content;
    if (!Array.isArray(content)) {
      if (e.type === "result") result = e;
      continue;
    }
    for (const block of content.map(obj)) {
      if (e.type === "assistant" && block.type === "tool_use" && block.name === "Bash") {
        const c: Command = { command: String(obj(block.input).command ?? "") };
        commands.push(c);
        byId.set(String(block.id), c);
      } else if (e.type === "user" && block.type === "tool_result") {
        const c = byId.get(String(block.tool_use_id));
        if (c) c.failed = block.is_error === true;
      }
    }
  }
  if (!result) throw new Error("Claude Code transcript has no result event");
  const usage = obj(result.usage);
  return {
    commands,
    reply: typeof result.result === "string" ? result.result : "",
    ...(model ? { model } : {}),
    tokens: {
      input:
        num(usage.input_tokens) +
        num(usage.cache_read_input_tokens) +
        num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
    },
  };
}

/** `zsh -lc 'cmd'` as Codex reports a command, back to `cmd`. */
export function unwrapShell(command: string): string {
  const m = /^\S*sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (!m) return command;
  const body = m[2] as string;
  return m[1] === "'" ? body.replaceAll(`'\\''`, "'") : body.replace(/\\(["\\$`])/g, "$1");
}

export function readCodexTranscript(text: string): Transcript {
  const commands: Command[] = [];
  let reply = "";
  let started = false;
  const tokens = { input: 0, output: 0 };
  for (const e of events(text)) {
    if (typeof e.type === "string" && /^(thread|turn)\./.test(e.type)) started = true;
    if (e.type === "turn.failed") {
      throw new Error(`Codex turn failed: ${JSON.stringify(e.error ?? {}).slice(0, 200)}`);
    }
    if (e.type === "turn.completed") {
      const u = obj(e.usage);
      tokens.input += num(u.input_tokens);
      tokens.output += num(u.output_tokens);
    }
    if (e.type !== "item.completed") continue;
    const item = obj(e.item);
    if (item.type === "command_execution") {
      const c: Command = { command: unwrapShell(String(item.command ?? "")) };
      if (typeof item.exit_code === "number") c.exit = item.exit_code;
      c.failed = item.status === "failed" || (c.exit ?? 0) !== 0;
      commands.push(c);
    } else if (item.type === "agent_message" && typeof item.text === "string") {
      reply = item.text;
    }
  }
  if (!started) throw new Error("Codex transcript has no thread or turn events");
  return { commands, reply, tokens };
}

/** A command that ran sddx: plain `sddx`, or any path ending in `/sddx`. */
export const runsSddx = (command: string): boolean =>
  /(^|[\s;&|(/'"])sddx['"]?(\s|$)/.test(command);
