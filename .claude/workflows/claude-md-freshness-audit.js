export const meta = {
  name: 'claude-md-freshness-audit',
  description: 'Check every claim in CLAUDE.md against the actual current code and flag stale sections',
}

phase('Chunk CLAUDE.md into checkable sections')

const listed = await agent(
  'Read CLAUDE.md in full. Break it into checkable units: each top-level "## " heading is one unit, EXCEPT ' +
    '"## Known limits and quirks", which is long — split its bullet list into groups of about 6 consecutive ' +
    'bullets each, naming them "Known limits and quirks (1/N)", "(2/N)", etc. For each unit, give a one-sentence ' +
    'summary of what it claims about the code.',
  {
    schema: {
      type: 'object',
      required: ['units'],
      properties: {
        units: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' }, summary: { type: 'string' } },
          },
        },
      },
    },
  },
)

if (listed.units.length === 0) {
  throw new Error('Could not find any checkable sections in CLAUDE.md')
}

phase('Check each unit against current code')

const findings = await pipeline(listed.units, u =>
  agent(
    `Re-read the "${u.name}" unit of CLAUDE.md in full (summary: ${u.summary}). For every concrete, checkable ` +
      "claim it makes about the code (a file existing at a path, a function's behavior, a threshold, a design " +
      "rule) — verify it against the actual current source. A claim about intent/history/rationale that isn't " +
      'independently checkable in code is not stale by definition; only flag claims that code contradicts.\n\n' +
      'Classify as "fresh" (every checkable claim still holds), "stale" (something changed and the doc no ' +
      'longer matches — quote the doc text and the contradicting code), or "unverifiable" (nothing concrete to ' +
      'check, e.g. pure rationale/history).',
    {
      label: u.name,
      schema: {
        type: 'object',
        required: ['name', 'status', 'summary'],
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: ['fresh', 'stale', 'unverifiable'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
  ),
)

phase('Synthesize report')

const outFile = 'docs/claude-md-freshness-audit/latest.md'

const report = await agent(
  'Here are per-section freshness findings, as JSON:\n\n' +
    `${JSON.stringify(findings.filter(Boolean), null, 2)}\n\n` +
    `Write a markdown report to ${outFile} (create the directory if needed). Lead with counts by status. List ` +
    'every "stale" section first with the exact doc text vs. the contradicting code (file:line). Skip "fresh" ' +
    'and "unverifiable" except counting them. Also return the full report text.',
  { schema: { type: 'object', required: ['report'], properties: { report: { type: 'string' } } } },
)

log(`Report written to ${outFile}`)
return report.report
