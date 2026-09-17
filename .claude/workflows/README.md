# Saved Claude Code workflows

Run any of these as `/<name>` from a Claude Code CLI session in this repo.
The CLI's own `/workflows` command also lists them (with these same
descriptions) and shows progress/history of past runs.

| Workflow | What it does |
|---|---|
| `/playbook-audit` | Fan out one agent per `../trading-vault/playbook.md` section, check this repo's implementation against it. Optional `args.scope` (matches heading/description/§-number/CLAUDE.md alias), `args.date`. |
| `/signal-code-audit` | The inverse: one agent per `worker/src/compute/*` file (+ score.js/verdict.js), checks it against whichever playbook section governs it. Skips anything CLAUDE.md already documents as deliberate. Optional `args.scope`. |
| `/backfill-correctness-check` | Cross-checks `scripts/backfill_mfe.js` / `backfill_sl_counterfactual.js` against trading-vault's independently-computed `mfe_R`/`mae_R`/`runner_max_R` for a sample of closed trades. Optional `args.sample` (default 8). |
| `/claude-md-freshness-audit` | Chunks CLAUDE.md into sections (splitting "Known limits and quirks" into groups), checks every concrete claim against current code, flags what's gone stale. |

Trading-vault's own journal/chart-read/lessons workflows (`batch-trade-audit`,
`chart-read-calibration`, `lessons-mining`, `mentor-triage`,
`trade-completeness-audit`, `migration-verify`) live in the sibling
`trading-vault` repo instead.

Each workflow here writes its report to `docs/<workflow-name>/latest.md` in
this repo.
