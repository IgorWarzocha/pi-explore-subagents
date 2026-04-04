# pi-explore-subagent

A tiny Pi extension that exposes one tool: `explore_subagent`.

It supports two modes:
- `shallow` - do a bounded surface scan of likely hotspots, entry points, and immediate relationships
- `deep` - trace behavior more thoroughly across modules, config, scripts, and call paths

It launches an isolated `pi` subprocess with:
- `--no-session`
- inherited extensions enabled (this tool disables itself in child runs to avoid recursion)
- `--no-skills`
- no forced tool allowlist

## Config

Edit `config.json`:

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

Notes:
- `shallow` is the bounded surface-scan mode.
- `deep` uses `openai-codex/gpt-5.4-mini` with `low` thinking by default.
- Clean cut: only the `shallow` and `deep` config keys are supported.

## Tool behavior

`explore_subagent` accepts:
- `task` - the reconnaissance task
- `mode` - optional, `shallow` or `deep` (`shallow` by default)
- `cwd` - optional working directory

## Global wiring

Your global Pi settings should include this directory in `extensions`:

```json
{
  "extensions": [
    "/home/igorw/Work/pi-explore-subagent"
  ]
}
```
