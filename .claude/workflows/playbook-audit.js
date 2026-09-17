export const meta = {
  name: 'playbook-audit',
  description: "Audit this dashboard's implementation against trading-vault/playbook.md and report every divergence",
}

const scope = args?.scope
const dateLabel = args?.date

log(scope ? `Scoping to sections matching "${scope}"` : 'Auditing the full playbook')

phase('List playbook sections')

const listed = await agent(
  'Read ../trading-vault/playbook.md in full. List every top-level (§-numbered or ##/###) section heading ' +
    'in the document, in order, with a one-sentence description of what it covers. The playbook\'s own headings ' +
    'are often not what this dashboard repo calls the section elsewhere — also grep this repo\'s CLAUDE.md for ' +
    'phrases like "§<number>" or "playbook §<number>" next to a short label (e.g. CLAUDE.md might call §VII ' +
    '"Scoring" even though the playbook itself titles it "PERP PULSE DASHBOARD ENGINE SPECIFICATIONS") and list ' +
    'every such alias you find for each section.',
  {
    schema: {
      type: 'object',
      required: ['sections'],
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['heading'],
            properties: {
              heading: { type: 'string' },
              description: { type: 'string' },
              number: { type: 'string', description: 'the § number/roman numeral, e.g. "VII"' },
              aliases: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
)

const matchesScope = (s, needle) => {
  const haystack = [s.heading, s.description, s.number, ...(s.aliases ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle.toLowerCase())
}

const sections = scope ? listed.sections.filter(s => matchesScope(s, scope)) : listed.sections

if (sections.length === 0) {
  const known = listed.sections.map(s => s.heading).join(', ')
  throw new Error(`No playbook sections matched scope "${scope}". Known headings: ${known}`)
}

phase('Audit dashboard against each section')

const findings = await pipeline(sections, section =>
  agent(
    `Read the "${section.heading}" section of ../trading-vault/playbook.md in full (re-read the file and locate ` +
      'that section). Then search this repo\'s src/ and worker/ directories for code implementing the rules, ' +
      'thresholds, or logic described in that section. Also check this repo\'s CLAUDE.md for any note that the ' +
      'gap is already known and tracked (e.g. as an R-item in the playbook repo) — if so, say so explicitly ' +
      'instead of presenting it as a fresh finding.\n\n' +
      'Compare the implementation to the playbook text and classify the section as one of:\n' +
      '- "matches": implementation agrees with the playbook\n' +
      '- "diverges": implementation exists but disagrees with the playbook (the playbook wins, per this repo\'s ' +
      'CLAUDE.md)\n' +
      '- "not_implemented": playbook describes something with no dashboard counterpart yet\n' +
      '- "not_applicable": this section is not the kind of thing the dashboard implements (e.g. trading ' +
      'psychology notes, journaling process)\n\n' +
      'For "diverges" and "not_implemented", cite the specific playbook text and, where relevant, the file:line ' +
      'in this repo. Be concrete — no vague summaries.',
    {
      label: section.heading,
      schema: {
        type: 'object',
        required: ['heading', 'status', 'summary'],
        properties: {
          heading: { type: 'string' },
          status: { type: 'string', enum: ['matches', 'diverges', 'not_implemented', 'not_applicable'] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          already_tracked: { type: 'boolean' },
        },
      },
    },
  ),
)

phase('Synthesize report')

const outFile = dateLabel ? `docs/playbook-audit/${dateLabel}.md` : 'docs/playbook-audit/latest.md'

const report = await agent(
  'Here are per-section audit findings comparing this dashboard\'s implementation to trading-vault/playbook.md, ' +
    `as JSON:\n\n${JSON.stringify(findings.filter(Boolean), null, 2)}\n\n` +
    `Write a markdown report to ${outFile} in this repo (create the directory if it doesn't exist). Lead with a ` +
    'short summary (counts by status). Then list every "diverges" finding first (most important — the playbook ' +
    'is the source of truth), then "not_implemented" (splitting out ones already tracked as R-items from fresh ' +
    'ones), then a brief one-line-each list of "not_applicable" sections at the end. Skip "matches" entries ' +
    'except counting them in the summary. For each listed finding, include the section heading, the summary, ' +
    'and the evidence. Also return the full report text.',
  {
    schema: {
      type: 'object',
      required: ['report'],
      properties: { report: { type: 'string' } },
    },
  },
)

log(`Report written to ${outFile}`)

return report.report
