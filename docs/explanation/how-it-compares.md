# How sddx compares

sddx borrows deliberately from several existing agentic-dev frameworks. This
page names what came from where, so the design choices read as informed
rather than arbitrary.

| Framework       | What sddx takes                                                                 |
| ---------------- | ---------------------------------------------------------------------------------|
| **Superpowers**  | The skills-library ambition and subagent-driven development model — sddx keeps the ambition, cuts the weight (measured token budget, hard-block hooks instead of prompted discipline). |
| **Blueprint**    | Process-over-intelligence as a design stance, and the loop-primitive shape (task-to-PR, multitask orchestration). |
| **GoalBuddy**    | The oracle principle itself — no goal is valid without an observable success signal — plus local boards and cross-harness state formats. |
| **gsd-core**     | The planner/executor/verifier subagent hierarchy for small, ad-hoc tasks with quality guarantees. |
| **BMAD-METHOD**  | The developer-workflow integration mindset — meeting an existing team's git/PR habits rather than replacing them. |

None of these are dependencies or forks — sddx is a from-scratch
implementation that reuses their *ideas*, adapted to a hook-enforced,
receipt-audited loop. See [design-principles.md](design-principles.md) for
how those ideas resolve into sddx's own tie-breakers, and
[architecture.md](architecture.md) for where they land in the codebase.
