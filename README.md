# pi-explore-subagent

`pi-explore-subagent` adds:
- one Pi tool: `explore_subagent`

It is meant for **reconnaissance**: finding the right files, tracing behavior, and gathering evidence before deciding what to change.

## What this is for

Use `explore_subagent` when you want Pi to:
- inspect an unfamiliar area of a codebase
- find the files and symbols that matter
- trace behavior across multiple files
- return evidence and next reads
- do this in an **isolated subagent** instead of mixing everything into the main session

This tool is for **discovery only**.
It does **not** edit files.

## Important behavior

The subagent is **isolated**.
It does **not** inherit:
- the parent agent's conversation
- the parent agent's plan
- unstated context in the current session

So the task you send must be a **complete standalone brief**.

## Modes

### `shallow`
Use this for **narrow, bounded recon**.

Best for:
- locating the right files
- finding entry points
- identifying immediate relationships
- getting the best next files to read

Not for:
- repo-wide surveys
- ranking or triage across many candidates
- tasks likely to revisit lots of files

`shallow` should stop early once it has found the likely hotspots.

### `deep`
Use this for **wide or open-ended recon**.

Best for:
- following call paths across files
- understanding configuration and scripts
- tracing supporting code and boundaries
- building a more complete system map before editing
- repo surveys, triage, and compare/rank/select work

## Default config

Edit `config.json` if you want to change models or thinking levels:

```json
{
  "shallow": {
    "model": "openai-codex/gpt-5.3-codex-spark",
    "thinking": "medium"
  },
  "deep": {
    "model": "openai-codex/gpt-5.4-mini",
    "thinking": "low"
  }
}
```

## Install

Add this directory to your Pi extensions:

```json
{
  "extensions": [
    "/home/igorw/Work/pi-explore-subagent"
  ]
}
```

Then reload or restart Pi.

## How to use it

`explore_subagent` accepts:
- `task` — the reconnaissance brief
- `mode` — required: `shallow` or `deep`
- `cwd` — optional working directory

In normal use, you usually just ask Pi naturally and let it decide when to call the tool.

## How to write a good task

Because the subagent is isolated, good tasks matter a lot.

A good task should include:
- the background
- the exact question
- relevant files, directories, or symbols
- constraints
- the kind of evidence you want back

Good example:

> Project: `/home/igorw/Work/howcode`.
> Inspect how the diff panel uses `@pierre/diffs`.
> Find the entry points, the main rendering path, and any files that transform diff data before rendering.
> Stay in discovery mode only.
> Return file paths, line ranges, and the best next reads.

Better `deep` example:

> Project: `/home/igorw/Work/howcode`.
> Trace the full flow from diff data creation to diff panel rendering.
> Include relevant config, adapter layers, and any code that changes the shape of the diff data.
> Stay in discovery mode only.
> Return a system map with evidence by file and line range.

## When to choose each mode

Choose `shallow` when you want:
- the right starting points
- likely hotspots
- quick orientation
- a smaller, more bounded scan

Choose `deep` when you want:
- a wide or open-ended scan
- triage or comparison across many candidates
- stronger cross-file synthesis

## Best practices

For best results:
- use `explore_subagent` for **net-new reconnaissance**
- give it the full brief up front
- prefer `shallow` when the search frontier is small
- prefer `deep` when the task is broad, comparative, or likely to revisit lots of context
- avoid asking it to repeat file reads the parent agent already completed

## Troubleshooting

### The results feel vague
Your task probably needs more context.
Add:
- the project path
- the exact symbol, feature, or behavior
- what kind of evidence you want

### It explores too much
Use `mode: "shallow"` and phrase the task as a surface scan.
Ask for:
- likely hotspots
- immediate relationships
- best next reads

If the task is simple but broad (for example triage or quick-win selection across many issues), use `deep`.

### You see `context_length_exceeded`
Try one or more of these:
- shorten the task brief
- narrow the scope to one subsystem or one question
- use `deep` if the investigation is inherently large
- ask for a `shallow` pass first, then a focused `deep` pass

## Summary

`explore_subagent` is best when you want Pi to do isolated evidence gathering before implementation.

- `shallow` = bounded surface scan
- `deep` = wide/open-ended recon
- always provide a full standalone brief
- use it for discovery, not editing
