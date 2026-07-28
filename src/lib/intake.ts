// The intake role's question batch. Human-mode intake gets ONE round of at most
// three questions, and the cap is enforced here rather than in the agent's
// prompt: in a project whose thesis is that prompt instructions do not hold, a
// cap enforced only by prompt is not a cap. Over the cap is a rejection naming
// it, never a silent truncation — truncating discards the question intake
// judged most important, and does it invisibly.
import { parse } from "yaml";

/** At most this many questions per dispatch. One batch, then planning proceeds. */
export const QUESTION_CAP = 3;

export interface IntakeQuestion {
  id: string;
  question: string;
  /** What changes depending on the answer. A question that cannot answer this
   * is not material, and immaterial questions are not asked. */
  why: string;
  /** The safe choice, when one exists. */
  default?: string;
}

export function parseQuestionBatch(yamlText: string): {
  questions?: IntakeQuestion[];
  errors: string[];
} {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    return { errors: [`invalid YAML: ${(e as Error).message}`] };
  }
  // Asking nothing is the expected outcome for a well-specified goal, so an
  // absent or empty batch is a success, not a missing value.
  if (raw === null || raw === undefined) return { questions: [], errors: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: ["question batch must be a YAML mapping with a `questions` list"] };
  }
  const r = raw as Record<string, unknown>;
  // A mapping that carries other keys but no `questions` is not an empty batch —
  // it is a different file (the graph header is the one that gets written here
  // by mistake), and passing it as "0 questions" sends an unreviewed plan past
  // the one round of questions, which is exactly what the caller refuses to do
  // for a batch it cannot read.
  if (!("questions" in r)) {
    if (Object.keys(r).length > 0) {
      return { errors: ["question batch must be a YAML mapping with a `questions` list"] };
    }
    return { questions: [], errors: [] };
  }
  if (r.questions === undefined || r.questions === null) return { questions: [], errors: [] };
  if (!Array.isArray(r.questions)) {
    return { errors: ["questions: must be a list"] };
  }
  if (r.questions.length > QUESTION_CAP) {
    return {
      errors: [
        `questions: ${r.questions.length} returned, over the cap of ${QUESTION_CAP} per dispatch — ask the ${QUESTION_CAP} that can change scope, behavior, safety, an oracle, or the plan, and resolve the rest as assumptions`,
      ],
    };
  }

  const errors: string[] = [];
  const out: IntakeQuestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < r.questions.length; i++) {
    const e = r.questions[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      errors.push(`questions[${i}]: must be a mapping with id, question and why`);
      continue;
    }
    const q = e as Record<string, unknown>;
    const field = (name: string): string => {
      const v = q[name];
      if (typeof v !== "string" || v.trim() === "") {
        errors.push(`questions[${i}]: missing "${name}"`);
        return "";
      }
      return v.trim();
    };
    const id = field("id");
    const question = field("question");
    const why = field("why");
    if (id !== "") {
      if (seen.has(id)) errors.push(`questions[${i}]: duplicate question id "${id}"`);
      else seen.add(id);
    }
    const dflt = typeof q.default === "string" ? q.default.trim() : undefined;
    out.push({ id, question, why, ...(dflt ? { default: dflt } : {}) });
  }
  if (errors.length > 0) return { errors };
  return { questions: out, errors: [] };
}
