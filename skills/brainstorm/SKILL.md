---
name: brainstorm
description: Use when the user wants a new feature or behavior change in an sddx repository and no spec covers it yet. Turns the idea into a spec's Design through conversation, checked by sddx spec check.
---

# Brainstorm

Turn an idea into the `## Design` of a goal spec the user agrees with. The
conversation is open; the gate is on what it produces.

## Before asking anything

- Read what exists: the code the change touches, recent commits, and
  `.sddx/specs/` for a spec that already covers the idea. Revise it only while
  its goal has not started, that is while `sddx goal show <goal-id>` finds no
  such goal. The file name is the goal id, so a started or finished goal keeps
  its spec: write a new spec for the follow-up change.
- Check the interaction mode with `sddx config show`. In `auto` mode ask
  nothing: decide, and record each decision under Assumptions.

## The conversation

- Ask one question per message, multiple choice where you can. The user may
  answer "skip": decide yourself and record it as an assumption.
- Ask about purpose, constraints and what done looks like before how to build
  it.
- Offer two or three approaches with their trade-offs and say which you
  recommend.
- Stop asking when the design below can be written without guessing.

## Write the design

Create `.sddx/specs/<YYYY-MM-DD>-<slug>.md`. The file name is the goal id.

<!-- spec-example -->
````markdown
# Rate limiting

## Design

### Goal
Limit each API client to 100 requests per minute.

### Acceptance
- the 101st request from one client inside a minute gets status 429
- a client's count resets once its minute ends

### Non-goals
- limits shared across several server instances

### Assumptions
- in-memory counters are enough: the API runs as a single instance

### Open decisions

### Approaches considered
Token bucket over fixed windows: it smooths bursts at the window edge.
````

- **Acceptance** lines must be observable. Before you finish, check each one:
  can a command prove it, exiting 0 only when it holds? A line no command can
  prove is the one question you still owe the user. Make it testable, or move
  it to Non-goals.
- **Open decisions** must be empty. A plan cannot rest on a decision nobody
  made.
- Free sections such as Approaches considered are kept for the reader and
  ignored by the CLI.

## Gate

Run `sddx spec check <spec>`. Fix every error it lists until it reports the
spec ready. Show the user the design and get their agreement, then use the plan
skill.
