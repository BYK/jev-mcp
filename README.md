# jev-eval-mcp

An eval-first MCP server for [TypeSafe's Jev](https://docs.typesafe.ai), a System One model that
returns typed judgments (`noul`, `choice`, `score`) with probabilities instead of generated text.

Most Jev integrations expose "ask the model a question". The hard part in practice is not asking —
it is knowing whether a question works and where to put the threshold. This server is built around
that:

| tool | use it for |
| --- | --- |
| `jev_ask` | prototype a question against one state and see the full probability distribution |
| `jev_map` | run a question set over many items, get one compact row each, filter/sort/save |
| `jev_eval` | measure question variants against labeled examples: accuracy, calibration, threshold sweep, worst misses |

`jev_map` exists because the expensive part of triaging 500 files, findings, or tickets is reading
them into the agent's context. `jev_eval` exists because a threshold picked by vibes is the usual
reason a classifier gate misbehaves in production.

## Install

Requires Node 20+ and a TypeSafe API key from https://console.typesafe.ai/settings/keys.

Register the server with your MCP client. Claude Code:

```bash
claude mcp add jev -e TYPESAFE_API_KEY=sk-... -- npx -y jev-eval-mcp
```

Or in a `mcp.json`-style config:

```json
{
  "mcpServers": {
    "jev": {
      "command": "npx",
      "args": ["-y", "jev-eval-mcp"],
      "env": { "TYPESAFE_API_KEY": "sk-..." }
    }
  }
}
```

For [opencode](https://opencode.ai), in `~/.config/opencode/opencode.json` (or a
project-level `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "jev": {
      "type": "local",
      "command": ["npx", "-y", "jev-eval-mcp"],
      "enabled": true,
      "environment": { "TYPESAFE_API_KEY": "{env:TYPESAFE_API_KEY}" }
    }
  }
}
```

From a clone, build first (`npm install && npm run build`) and point the client at
`node /path/to/jev-mcp/dist/index.js` instead.

Environment: `TYPESAFE_API_KEY` (required), `JEV_MODEL` (default `jev-latest`),
`TYPESAFE_BASE_URL` (default `https://api.typesafe.ai`).

## Questions

A question is one of three types, matching the Jev API:

```jsonc
{ "type": "noul",   "instructions": "Is this ticket urgent?" }
{ "type": "score",  "instructions": "How severe is this?", "criteria": ["trivial", "minor", "major", "critical"] }
{ "type": "choice", "instructions": "Which team owns this?", "criteria": { "billing": "payments", "platform": "availability" } }
```

Questions are keyed by an id you choose; ids are not sent to the model, so the meaning belongs in
`instructions`. All questions in one call are answered independently against the same state in a
single request, so asking several at once costs one round trip.

## Typical loop

1. `jev_ask` — try two or three wordings on a state you understand.
2. `jev_eval` — run the promising ones over labeled examples (inline, or a `.jsonl`/`.json` file of
   `{ id?, state, label? }`). Read the threshold sweep and the worst misses; pick a threshold from
   the table, not from intuition.
3. `jev_map` — apply the question you measured to the real workload, sorting or filtering by the
   answer and using `save_path` to keep the bulk out of context.

```
> jev_eval dataset_path=examples/support-tickets.jsonl variants={plain, detailed}

16 labeled items · 2 variant(s) · jev-1.13.0 · 268 ms · 4987 input tokens

| variant  | headline metrics                                                    |
| plain    | best F1 1.000 @ threshold 0.50 · AUC 1.000 · Brier 0.012 · ECE 0.097 |
| detailed | best F1 1.000 @ threshold 0.50 · AUC 1.000 · Brier 0.021 · ECE 0.095 |
```

Labels are coerced to the question type: booleans/`yes`/`no`/`1`/`0` for `noul`, the option key for
`choice`, and either a level name or its index for `score`.

Thresholds are only as good as the dataset behind them, and they are tied to a model version —
`jev_eval` reports the resolved version so a rerun after an upgrade is comparable.

## Development

```bash
npm run typecheck && npm run lint && npm test   # metrics unit tests, no network
npm run build && npm run smoke                  # live end-to-end over stdio, needs TYPESAFE_API_KEY
```

MIT licensed.
