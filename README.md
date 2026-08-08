# Graphene

**A work-graph engine for agents.** One Rust binary that holds the graph an agent
works through — what is claimable, what is blocked, what each node concluded, who
is doing what — and pushes changes to every session attached to it.

```
gr new --task "…"     plan it        gr status    → next action
gr check              validate it    gr claim     → take work
gr start              run it         gr wait      → blocks until something happens
gr ui                 watch it       gr resolve   → a human answered
```

Four things in one binary: the **CLI** the agent drives, a **WebSocket server**
for presence and push, a **read-only localhost UI**, and the **skill** that
teaches an agent to use all of it.

## Depends on nothing

One binary, one SQLite file. **No service, no database server, no account, no API
key, no network, and no dependency on any other component of this system.** If
the knowledge base or the platform are never built, Graphene loses nothing.

Ontology projection and entity fusion are absent because they sit **above** the
belief layer, not below it — an entity is a fold over the beliefs supporting it.
Beliefs alone are complete. See [`specs/00-overview.md`](specs/00-overview.md) §4.1.

## Two constraints that define everything

**Graphene never calls a model.** Planning, reviewing, deciding — all the agent's.
Graphene receives structure and enforces it.

**Graphene never executes a node.** It is a *coordinator, not an executor*. It
tracks what is ready, claimed, and done; **the agent runs the work.** No daemon,
no worker pool, no sandbox.

Together: *the agent decides and does; Graphene remembers, validates, and tells
everyone.*

## Two planes

| Plane | Holds | If it dies |
|---|---|---|
| **SQLite store** | the log and its fold | nothing works — it is the truth |
| **WebSocket server** | presence, push, fan-out, the UI stream | **work continues**, push degrades to WAL watching, no data lost |

The server exists because polling solves coordination but not **liveness**: an
idle or mid-turn agent is unreachable. `gr wait` is a blocking tool call the
server unblocks — which is how you push into an agent loop in any harness, with
no special support.

## Two kinds of node, one log

**Work nodes** — agent loop, function, retrieval, or **human**. **Belief nodes** —
claims with provenance, support, and a four-valued truth state.

They share the log, the edges, the fold, and cascade. That is what makes the two
things this is sold on possible:

> **A human node shows `why()` on its inputs.** *"Approve this email"* is
> useless. *"Approve this email, which rests on three facts, one of which went
> stale two hours ago"* is the product.

> **Cross-session divergence is detectable.** A claim declares its read-set; a
> premise that dies pushes `premise_invalidated` to whoever is standing on it —
> mid-node, not at their next poll.

## Human nodes never block the graph

A human node blocks its dependents and **nothing else**. Everything not
downstream keeps running. A graph waiting on people is `awaiting-input`, not
stalled — so a gate can *"wait three days for a human sign-off without holding a
context window hostage."*

The person answering was not in the original session. `gr node <id>` returns
everything cold: the ask, the context beliefs with their states, what is stale,
and what each answer unblocks.

## The UI is read-only

No write endpoint anywhere. The only path back is a **copy button** — copy a node
ID, paste it into a fresh agent session, and the skill's trigger does the rest.
Graph edits go through an agent, which fixes the bindings and schemas that a
direct edit would silently break.

## Specs

Read [`../specs/`](../specs/) first — contracts and invariants are shared.

| # | Spec |
|---|---|
| [00](specs/00-overview.md) | What it is, the two constraints, the two planes, scope |
| [01](specs/01-graph-model.md) | Graphs, nodes, edges, typed state, lifecycle, IDs |
| [02](specs/02-belief-layer.md) | Three axes, the truth lattice, cascade, `assumed-by` |
| [03](specs/03-store.md) | SQLite schema, the log, fold, replay, the graph library |
| [04](specs/04-execution.md) | Claims, leases, read-set assertion, human nodes, retry |
| [05](specs/05-server.md) | WebSocket protocol, `gr wait`, presence, degradation |
| [06](specs/06-check.md) | Every deterministic check — and what is deliberately not checked |
| [07](specs/07-cli.md) | The full surface, JSON contracts, exit codes |
| [08](specs/08-ui.md) | Read-only views, the human-node inbox, copy |
| [09](specs/09-skill.md) | Workflow, decomposition, review lenses, runnable examples |
| [10](specs/10-verification.md) | BMB, gates, property tests, golden logs |

**Build order:** [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — nine workstreams, one
complete v1, sequenced by dependency and not by scope.

## Do this first

**`gr bench --bmb` against the belief layer, before anything else exists.**

The [Belief Maintenance Benchmark](https://mnemebrain.github.io/mnemebrain-benchmark/)
is 48 tasks, zero LLM calls, fully deterministic, and tests exactly this layer's
job. It needs no store, no server, no agent. Graphene is a full truth-maintenance
system with four-valued states and typed edges; it should score well. **If it
does not, that is decisive — and far cheaper to learn now than after nine
workstreams.**
