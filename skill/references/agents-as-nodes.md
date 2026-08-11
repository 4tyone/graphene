# Agents as nodes

A node's work does not have to be done by you. It can be done by **another agent
running headless** — Claude Code, Codex, Pi, Gemini, anything with a
non-interactive mode. You claim the node, shell out, and report what came back.

That is what makes a graph a multi-agent orchestration: Graphene already holds
who is doing what, what each concluded, and what nobody may start yet. Pointing a
node at a different agent changes who does the work, not how the work is tracked.

```
gr claim <node> --graph <g> --assumes <beliefs>
claude -p "<the node's prompt, plus its resolved inputs>" --output-format json
gr done <node> --graph <g> --output '{…}' --tokens <what it used>
```

## Each invocation is a fresh context

A headless run is a **new session every time**. It does not inherit your
conversation, your findings, or anything an earlier node concluded.

That is a feature and a cost.

**The feature:** it is real context isolation. A verifier that shares your
context has already read your reasoning and will agree with it. A verifier in its
own process has not, which is the whole reason the diamond in
[decomposition.md](decomposition.md) puts verification in a separate node.

**The cost:** everything the node needs must be *in the prompt*. Bindings are
where that comes from — `gr node <id>` returns `inputs_resolved`, and that is
what you pass. A node whose prompt says "continue what we discussed" gets an
agent that has no idea what you discussed.

## The session is saved, and it is worth recording

Every headless run leaves a resumable session:

```
claude -p "…" --output-format json     → {"session_id": "6f3ec106-…", "result": …}
claude -p --resume <session_id> "…"    → picks up with the full history
```

Codex is the same shape (`codex exec --json`, then `codex resume`).

**Put the session id in the node's output.** Six weeks later, "why did this node
conclude that?" is answerable by resuming the session and asking, instead of
guessing from a one-line summary. It costs one field.

```
gr done <node> --graph <g> --output '{"finding":"…","session_id":"6f3ec106-…"}' --tokens 18400
```

## What it actually costs

Get this right, because the intuition is usually wrong in both directions.

**On a Claude Pro or Max subscription, headless is not billed per token.** It
draws on the same allowance as an interactive session — Anthropic's docs are
explicit that the dollar figure Claude Code prints is computed locally at list
rates and "isn't relevant for billing purposes" for subscribers.

What it *does* consume is your **session (rolling 5-hour) and weekly limits**, and
it consumes them faster than the same work done inline:

- Every headless run reloads the system prompt, `CLAUDE.md`, and skills from
  scratch. A one-sentence prompt is not a one-sentence request.
- Separate invocations get **no cache reuse between them**. Ten nodes is ten cold
  starts.
- Each one is its own context window, so usage scales with how many you run, not
  with how much you asked for.

**Where it becomes real money:** if you have usage credits enabled and pass your
plan's allowance, further usage is charged. The cache lifetime also drops from an
hour to five minutes once you are drawing on credits, which makes everything
after that point more expensive per call. With an API key, or on Bedrock / Vertex
/ Foundry, it is billed per token from the first call.

So the honest rule is not "headless costs money." It is:

> **A fan-out of headless agents is the most allowance-expensive shape you can
> build.** Fan out where the work genuinely splits, and nowhere else — which is
> what [decomposition.md](decomposition.md) already told you, for a different
> reason.

Declare `tokens` on nodes that shell out to an agent, and report what they
actually used when you close them. That is what lets a budget stop a run before
the allowance does.

## Choosing which agent

Nothing here is Claude-specific. Reasons to point a node at a different agent:

| Reason | |
|---|---|
| **A genuinely independent opinion** | A different model is a different prior. For a verifier, that is worth more than a bigger one. |
| **Cost or allowance** | A cheaper model for mechanical work, so the expensive one keeps its allowance for the hard node. |
| **Capability** | Something the other tool does better, or has credentials for. |

Not a reason: variety for its own sake. A second agent that agrees with the first
because the task was easy has told you nothing and cost an allowance.

## What a node running an agent must still do

The rules do not relax because the work happened in another process:

- **Claim before you run it.** Otherwise two sessions fan out the same node and
  pay for it twice.
- **`--assumes` the beliefs the work rests on.** If a premise dies mid-run, the
  claim is refused and you have learned it before spending the tokens rather
  than after.
- **Validate the output.** `gr done` checks it against the declared schema and
  fails closed. An agent that returned prose where the schema wants an object is
  a failed node, not a node you paper over.
- **Record what it cost:** pass `--tokens` (and `--micros-usd` on an API key) to
  `gr done`.
- **Fail honestly.** If the nested agent errored, say so with the reason it gave:

```
gr fail <node> --graph <g> --reason "codex exec exited 1: rate limited" --retryable
```

  Mark it `--retryable` only if the cause was transient. A rate limit is; a bad
  prompt is not.

## Sandboxing

A nested agent given write access will write. Two things worth knowing before you
automate it:

- Codex refuses to run outside a trusted directory unless told otherwise, and
  defaults to `sandbox: read-only, approval: on-request`. Letting it edit needs
  an explicit flag.
- Claude Code has the same shape with `--dangerously-skip-permissions`.

**A node that both spawns an unattended agent with write access and has no human
gate downstream is the shape to be most careful about.** `gr check` cannot catch
it, because the capability it declares is whatever you wrote. If the nested agent
can do something irreversible, declare that capability on the node so the gate
rules apply to it.
