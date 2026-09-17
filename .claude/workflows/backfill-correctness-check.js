export const meta = {
  name: 'backfill-correctness-check',
  description: "Cross-check scripts/backfill_mfe.js and backfill_sl_counterfactual.js logic against trading-vault's own recorded mfe_R/mae_R/runner_max_R for a sample of closed trades",
}

const sampleSize = args?.sample ?? 8

log(`Sampling ${sampleSize} closed trades for backfill cross-check`)

phase('Sample closed trades with recorded outcomes')

const sampled = await agent(
  "../trading-vault/journal/outcomes.csv holds this operator's trading journal outcomes. Read it and pick up " +
    `to ${sampleSize} rows that have realized_R, mfe_R, mae_R, and runner_max_R all non-empty — prefer a spread ` +
    'across different result values (win/loss/breakeven) rather than all the same outcome. For each, also read ' +
    'the matching row in ../trading-vault/journal/trades.csv for pair, direction, entry_price, initial_sl, ' +
    'opened_at.',
  {
    schema: {
      type: 'object',
      required: ['trades'],
      properties: {
        trades: {
          type: 'array',
          items: {
            type: 'object',
            required: ['trade_id'],
            properties: {
              trade_id: { type: 'string' },
              pair: { type: 'string' },
              mfe_R: { type: 'string' },
              mae_R: { type: 'string' },
              runner_max_R: { type: 'string' },
            },
          },
        },
      },
    },
  },
)

if (sampled.trades.length === 0) {
  throw new Error(
    'trading-vault/journal/outcomes.csv has no rows with mfe_R/mae_R/runner_max_R populated to sample from',
  )
}

phase('Check backfill logic against each sampled trade')

const findings = await pipeline(sampled.trades, t =>
  agent(
    'Read scripts/backfill_mfe.js and scripts/backfill_sl_counterfactual.js in full. Read this repo\'s ' +
      "CLAUDE.md for how MFE and SL-counterfactual are defined here. Read ../trading-vault/playbook.md for its " +
      'own definition of these concepts if it has one (search for MFE, MAE, runner, R-multiple).\n\n' +
      `Trade ${t.trade_id} (${t.pair}) has recorded mfe_R=${t.mfe_R}, mae_R=${t.mae_R}, ` +
      `runner_max_R=${t.runner_max_R} in trading-vault's journal — these came from trading-vault's own ` +
      "tools/mfe_adapter.py, a SEPARATE implementation from this repo's backfill scripts. You do not need to " +
      "execute either script (they likely need live market data this environment may not have); instead, trace " +
      "through backfill_mfe.js's and backfill_sl_counterfactual.js's formulas by hand for this trade's entry/ " +
      'SL/direction and check whether the DEFINITION they implement (what counts as favorable excursion, how R ' +
      "is normalized, where the counterfactual stop is placed) is consistent with what produced this trade's " +
      "recorded numbers — not whether you can reproduce the exact number without market data.\n\n" +
      'Classify as "consistent" (same definition, no reason to expect disagreement), "inconsistent" (the two ' +
      'scripts define the metric differently in a way that would produce different numbers for the same trade), ' +
      'or "cannot_determine" (one side\'s logic isn\'t clear enough to compare).',
    {
      label: t.trade_id,
      schema: {
        type: 'object',
        required: ['trade_id', 'status', 'summary'],
        properties: {
          trade_id: { type: 'string' },
          status: { type: 'string', enum: ['consistent', 'inconsistent', 'cannot_determine'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  ),
)

phase('Synthesize report')

const outFile = 'docs/backfill-correctness-check/latest.md'

const report = await agent(
  'Here are per-trade cross-check findings, as JSON:\n\n' +
    `${JSON.stringify(findings.filter(Boolean), null, 2)}\n\n` +
    `Write a markdown report to ${outFile} (create the directory if needed). Lead with counts by status. List ` +
    'every "inconsistent" first with full evidence (these mean the two repos would disagree on a trade\'s MFE/ ' +
    'counterfactual for a real trade), then "cannot_determine". Skip "consistent" except counting them. Also ' +
    'return the full report text.',
  { schema: { type: 'object', required: ['report'], properties: { report: { type: 'string' } } } },
)

log(`Report written to ${outFile}`)
return report.report
