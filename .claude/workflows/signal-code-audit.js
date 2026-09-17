export const meta = {
  name: 'signal-code-audit',
  description: "Code-first audit: one agent per worker/src compute file, checking it against the playbook math it implements (inverse of playbook-audit)",
}

const scope = args?.scope // filename or keyword substring, optional

log(scope ? `Scoping to files matching "${scope}"` : 'Auditing every scoring/compute file')

phase('List scoring and compute files')

const listed = await agent(
  'List every file in worker/src/compute/, plus worker/src/score.js and worker/src/verdict.js. For each, read ' +
    "its top-of-file comment/docstring and exported function names to produce a one-sentence purpose summary.",
  {
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string' }, purpose: { type: 'string' } },
          },
        },
      },
    },
  },
)

const files = scope
  ? listed.files.filter(
      f =>
        f.path.toLowerCase().includes(scope.toLowerCase()) ||
        (f.purpose ?? '').toLowerCase().includes(scope.toLowerCase()),
    )
  : listed.files

if (files.length === 0) {
  const known = listed.files.map(f => f.path).join(', ')
  throw new Error(`No files matched scope "${scope}". Known files: ${known}`)
}

phase('Audit each file against the playbook')

const findings = await pipeline(files, f =>
  agent(
    `Read ${f.path} in full (purpose: ${f.purpose}). Read this repo's CLAUDE.md in full first, especially the ` +
      '"Known limits and quirks" section — it documents many deliberate divergences from a naive playbook ' +
      'reading (rolling windows instead of anchored ranges, UTC day boundaries, proxy handling, R22/R23 tracked ' +
      "gaps, etc). Do NOT flag anything CLAUDE.md already documents as deliberate.\n\n" +
      "Then search ../trading-vault/playbook.md for the section(s) governing this file's logic (search by " +
      "concept — thresholds, formula names, the metric it computes — not just exact string matches, since the " +
      "playbook's wording won't match variable names). Compare the code's actual behavior (thresholds, " +
      'formulas, edge-case handling) to what the playbook specifies.\n\n' +
      'Classify as "matches" (correct or a documented-deliberate divergence), "diverges" (differs from the ' +
      'playbook in a way CLAUDE.md does NOT already explain — the playbook wins per this repo\'s own rule), or ' +
      '"no_playbook_basis" (this code exists for a reason the playbook doesn\'t address, e.g. display-only or ' +
      'infra concerns). Cite file:line and playbook text for every claim.',
    {
      label: f.path,
      schema: {
        type: 'object',
        required: ['path', 'status', 'summary'],
        properties: {
          path: { type: 'string' },
          status: { type: 'string', enum: ['matches', 'diverges', 'no_playbook_basis'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  ),
)

phase('Synthesize report')

const outFile = 'docs/signal-code-audit/latest.md'

const report = await agent(
  'Here are per-file audit findings, as JSON:\n\n' +
    `${JSON.stringify(findings.filter(Boolean), null, 2)}\n\n` +
    `Write a markdown report to ${outFile} (create the directory if needed). Lead with counts by status. List ` +
    'every "diverges" first (most important — these are gaps CLAUDE.md does not already explain), then ' +
    '"no_playbook_basis" as a brief list. Skip "matches" except counting them. Also return the full report text.',
  { schema: { type: 'object', required: ['report'], properties: { report: { type: 'string' } } } },
)

log(`Report written to ${outFile}`)
return report.report
