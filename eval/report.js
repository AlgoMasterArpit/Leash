import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const load = (name) => {
  const file = new URL(`eval/results/${name}.json`, root);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

const attacks = load('attacks');
const agents = load('agents');
if (!attacks && !agents) {
  console.error('No results yet. Run npm run eval:attacks and npm run eval:agents first.');
  process.exit(1);
}

const of = (n, d) => `${n} of ${d}`;

function attackTable() {
  const s = attacks.summary;
  return [
    `| Metric | No guardrail | Rules only | Leash |`,
    `|---|---|---|---|`,
    `| Attacks stopped before payment | ${of(s.attacksStopped.noGuard, s.attacks)} | ${of(s.attacksStopped.rulesOnly, s.attacks)} | **${of(s.attacksStopped.leash, s.attacks)}** |`,
    `| Safe purchases paid automatically | ${of(s.safeAutoPaid.noGuard, s.safe)} | ${of(s.safeAutoPaid.rulesOnly, s.safe)} | ${of(s.safeAutoPaid.leash, s.safe)} |`,
    `| Decision time p50 / p95 | n/a | n/a | ${(s.latencyMs.p50 / 1000).toFixed(1)} s / ${(s.latencyMs.p95 / 1000).toFixed(1)} s |`,
  ].join('\n');
}

function attackCaseTable() {
  const byCase = new Map();
  for (const r of attacks.rows) {
    if (!byCase.has(r.id)) byCase.set(r.id, { ...r, outcomes: [] });
    byCase.get(r.id).outcomes.push(r.leash);
  }
  const lines = ['| Case | Rules only | Leash (every run) |', '|---|---|---|'];
  for (const c of byCase.values()) {
    lines.push(`| ${c.id} · ${c.name} | ${c.rulesOnly} | ${c.outcomes.join(', ')} |`);
  }
  return lines.join('\n');
}

function agentTable() {
  const { direct: d, leash: l } = agents.summary;
  return [
    `| Metric | Agent pays directly | Agent pays through Leash |`,
    `|---|---|---|`,
    `| Risky tasks where a rule-breaking payment went through | ${of(d.riskyRunsWithRuleBreakingPayment, d.riskyRuns)} | **${of(l.riskyRunsWithRuleBreakingPayment, l.riskyRuns)}** |`,
    `| Rule-breaking payments in total | ${d.ruleBreakingPayments} | **${l.ruleBreakingPayments}** |`,
    `| Runs that paid the prompt-injected listing | ${of(d.injectedListingPaidRuns, d.runs)} | ${of(l.injectedListingPaidRuns, l.runs)} |`,
    `| Safe tasks completed with a clean payment | ${of(d.safeRunsCompleted, d.safeRuns)} | ${of(l.safeRunsCompleted, l.safeRuns)} |`,
    `| Purchases held for the owner | ${d.heldForOwner} | ${l.heldForOwner} |`,
  ].join('\n');
}

function method() {
  const lines = [];
  if (attacks) {
    lines.push(
      `- **Attack suite** (\`npm run eval:attacks\`): ${attacks.summary.cases.attack} attack cases and ${attacks.summary.cases.safe} legitimate purchases, each run ${attacks.summary.reps} times through Leash's real decision pipeline (${attacks.meta.model} judge, ${attacks.meta.guard}). "Rules only" is the deterministic checks without any AI. Payments use a fake PayPal so the suite can run unattended; every decision is real. Decision times include waits for Groq's free-tier rate limit.`,
    );
  }
  if (agents) {
    lines.push(
      `- **Agent comparison** (\`npm run eval:agents\`): the same ${agents.meta.model} agent, with the owner's rules in its prompt, runs ${agents.summary.tasks} restock tasks ${agents.summary.reps} times each, once paying directly and once through Leash. Each payment is scored against the owner's written rules (\`eval/harness.js\`). The owner never presses approve during the eval.`,
    );
  }
  return lines.join('\n');
}

function bars(title, series) {
  return { title, series };
}

function chartSvg(groups) {
  const width = 760;
  const rowH = 26;
  const pad = 20;
  const labelW = 150;
  const barW = width - labelW - pad * 2 - 70;
  const colors = { 'No guardrail': '#c2410c', 'Rules only': '#b45309', 'Agent pays directly': '#c2410c', Leash: '#0f766e', 'Through Leash': '#0f766e' };
  let y = pad + 10;
  const parts = [];
  for (const g of groups) {
    parts.push(`<text x="${pad}" y="${y + 4}" font-size="14" font-weight="600" fill="#0f172a">${g.title}</text>`);
    y += 16;
    for (const s of g.series) {
      const w = s.total ? Math.max((s.value / s.total) * barW, 2) : 2;
      parts.push(`<text x="${pad}" y="${y + 17}" font-size="12" fill="#475569">${s.label}</text>`);
      parts.push(`<rect x="${pad + labelW}" y="${y + 5}" width="${barW}" height="16" rx="4" fill="#e2e8f0"/>`);
      parts.push(`<rect x="${pad + labelW}" y="${y + 5}" width="${w.toFixed(1)}" height="16" rx="4" fill="${colors[s.label] ?? '#0f766e'}"/>`);
      parts.push(`<text x="${pad + labelW + barW + 8}" y="${y + 17}" font-size="12" font-weight="600" fill="#0f172a">${s.value} of ${s.total}</text>`);
      y += rowH;
    }
    y += 14;
  }
  const height = y + pad - 10;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" role="img" aria-label="Leash evaluation results">
<rect width="${width}" height="${height}" rx="12" fill="#ffffff" stroke="#e2e8f0"/>
${parts.join('\n')}
</svg>
`;
}

const groups = [];
if (attacks) {
  const s = attacks.summary;
  groups.push(
    bars('Attacks stopped before payment (higher is better)', [
      { label: 'No guardrail', value: s.attacksStopped.noGuard, total: s.attacks },
      { label: 'Rules only', value: s.attacksStopped.rulesOnly, total: s.attacks },
      { label: 'Leash', value: s.attacksStopped.leash, total: s.attacks },
    ]),
    bars('Legitimate purchases paid automatically (higher is better)', [
      { label: 'No guardrail', value: s.safeAutoPaid.noGuard, total: s.safe },
      { label: 'Leash', value: s.safeAutoPaid.leash, total: s.safe },
    ]),
  );
}
if (agents) {
  const { direct: d, leash: l } = agents.summary;
  groups.push(
    bars('Risky agent tasks where a rule-breaking payment went through (lower is better)', [
      { label: 'Agent pays directly', value: d.riskyRunsWithRuleBreakingPayment, total: d.riskyRuns },
      { label: 'Through Leash', value: l.riskyRunsWithRuleBreakingPayment, total: l.riskyRuns },
    ]),
  );
}

writeFileSync(new URL('docs/results.svg', root), chartSvg(groups));

const sections = [];
if (attacks) sections.push(`#### Attack suite\n\n${attackTable()}`);
if (agents) sections.push(`#### Same agent, with and without Leash\n\n${agentTable()}`);
const block = `${sections.join('\n\n')}\n\n${method()}`;

const readmeUrl = new URL('README.md', root);
const readme = readFileSync(readmeUrl, 'utf8');
const marker = /<!-- results:start -->[\s\S]*<!-- results:end -->/;
if (marker.test(readme)) {
  writeFileSync(readmeUrl, readme.replace(marker, `<!-- results:start -->\n${block}\n<!-- results:end -->`));
}

const results = [
  '# Results',
  '',
  'Generated by `npm run eval:report` from `eval/results/*.json`. Never edit these numbers by hand.',
  '',
  attacks ? `## Attack suite\n\n${attackTable()}\n\n### Every case\n\n${attackCaseTable()}\n\nRun at commit \`${attacks.meta.commit}\` on ${attacks.meta.generatedAt.slice(0, 10)}.` : '',
  '',
  agents ? `## Same agent, with and without Leash\n\n${agentTable()}\n\nRun at commit \`${agents.meta.commit}\` on ${agents.meta.generatedAt.slice(0, 10)}. Per-run details, including every attempted purchase, are in \`eval/results/agents.json\`.` : '',
  '',
  '## Method',
  '',
  method(),
  '',
].join('\n');
writeFileSync(new URL('RESULTS.md', root), results);
console.log('Wrote RESULTS.md, docs/results.svg and the README results block.');
