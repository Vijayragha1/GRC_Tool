// Anthropic Claude integration. Deliberately mirrors lib/email.js: a thin
// raw-fetch wrapper over a single HTTP API, no SDK, no build step. Everything
// degrades gracefully when ANTHROPIC_API_KEY is unset so the app, and the
// guided risk assessment, still work without AI (the consultant just fills
// the cards in by hand).
//
// Why forced tool-use instead of free-text JSON: asking the model to "return
// JSON" is unreliable; declaring a tool and forcing tool_choice gives us a
// validated argument object back every time. We still re-validate server-side.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Opus 4.8 is the default: most capable, best for audit-grade reasoning.
// Override with ANTHROPIC_MODEL (e.g. claude-sonnet-4-6) to trade some quality
// for lower cost / latency.
function model() {
  return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Low-level call to the Messages API. Returns the parsed response object or
// throws an Error with a human-readable message. A 90s abort guards against a
// hung request blocking the Express worker.
async function callMessages(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('AI is not configured (ANTHROPIC_API_KEY is not set).');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: model(), ...body }),
      signal: controller.signal
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (json && json.error && json.error.message) || `HTTP ${r.status}`;
      throw new Error(`Claude API error: ${msg}`);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Claude took too long to respond - try again.');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Pull the input object out of the first tool_use block in a response.
function extractToolInput(resp, toolName) {
  const blocks = (resp && resp.content) || [];
  const block = blocks.find(b => b.type === 'tool_use' && (!toolName || b.name === toolName));
  if (!block) throw new Error('Claude did not return structured output.');
  return block.input || {};
}

// Render the active methodology's scales as plain text the model can reason
// over. Keeps the prompt anchored to THIS workspace's matrix, not a generic 5x5.
function methodologyText(methodology) {
  const l = methodology.likelihood_scale.map(s => `  ${s.value} = ${s.label}${s.description ? ' (' + s.description + ')' : ''}`).join('\n');
  const i = methodology.impact_scale.map(s => `  ${s.value} = ${s.label}${s.description ? ' (' + s.description + ')' : ''}`).join('\n');
  return `Likelihood scale (use these integer values only):\n${l}\n\nImpact scale (use these integer values only):\n${i}`;
}

// ============ Guided risk assessment ============
// Given the client's context + the active methodology + the Annex A catalogue,
// propose tailored, audit-grade risk scenarios. Each carries the reasoning a
// junior consultant needs to defend it in front of an auditor.
async function suggestRisks({ context, methodology, controlCatalog, count = 12, existingTitles = [] }) {
  const lMax = methodology.likelihood_scale.length;
  const iMax = methodology.impact_scale.length;

  const catalogText = controlCatalog
    .map(c => `${c.id}: ${c.title.replace(/^A\.[0-9.]+\s*/, '')}`)
    .join('\n');

  const system = [
    'You are a senior ISO/IEC 27001:2022 lead risk consultant. You are helping a junior colleague run their first information-security risk assessment at a client site.',
    'Produce specific, audit-grade risk scenarios tailored to THIS client - not generic boilerplate. Every scenario must be defensible in a Stage 2 certification audit.',
    '',
    'For every risk you propose:',
    '- Write a clear risk title in the form "<unwanted outcome> due to <cause>".',
    '- Name the threat (threat source/event) and the vulnerability (the weakness it exploits) separately.',
    '- Score likelihood and impact using ONLY the integer values from the scales given, and justify each score in one sentence grounded in the client\'s actual situation.',
    '- Explain, in plain English a junior can repeat to the client, WHY this risk matters for this organisation.',
    '- Map the risk to 1-4 relevant Annex A controls, using ONLY control IDs from the provided catalogue. Never invent an ID.',
    '- Pick the most appropriate treatment: modify (apply controls), retain (accept), avoid (eliminate the activity), or share (transfer/insure).',
    '- Tag which of Confidentiality, Integrity, Availability are at stake.',
    '',
    'Favour the risks that genuinely matter for this client\'s sector, technology, and crown-jewel assets over filler. Quality over quantity.'
  ].join('\n');

  const userParts = [
    'CLIENT CONTEXT',
    '--------------',
    context && context.trim() ? context.trim() : '(Limited context provided - infer sensibly from the sector and ask nothing; make reasonable, clearly-applicable assumptions.)',
    '',
    'RISK METHODOLOGY',
    '----------------',
    methodologyText(methodology),
    '',
    'ANNEX A CONTROL CATALOGUE (use these IDs only)',
    '----------------------------------------------',
    catalogText
  ];
  if (existingTitles.length) {
    userParts.push('', 'ALREADY IN THE REGISTER (do not duplicate these)', '------------------------------------------------', existingTitles.slice(0, 100).map(t => '- ' + t).join('\n'));
  }
  userParts.push('', `Propose ${count} risk scenarios. Call the record_risks tool with your results.`);

  const tool = {
    name: 'record_risks',
    description: 'Record the proposed risk scenarios for the consultant to review.',
    input_schema: {
      type: 'object',
      properties: {
        risks: {
          type: 'array',
          description: 'The proposed risk scenarios.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Risk title, e.g. "Customer data exposed due to missing MFA on admin accounts".' },
              threat: { type: 'string', description: 'The threat source or event.' },
              vulnerability: { type: 'string', description: 'The weakness the threat exploits.' },
              description: { type: 'string', description: '1-3 sentence scenario description.' },
              likelihood: { type: 'integer', description: `Likelihood score from 1 to ${lMax}.` },
              impact: { type: 'integer', description: `Impact score from 1 to ${iMax}.` },
              likelihood_rationale: { type: 'string', description: 'One sentence justifying the likelihood score.' },
              impact_rationale: { type: 'string', description: 'One sentence justifying the impact score.' },
              why_it_matters: { type: 'string', description: 'Plain-English explanation for a junior consultant of why this risk matters to this client.' },
              cia: { type: 'array', items: { type: 'string', enum: ['Confidentiality', 'Integrity', 'Availability'] }, description: 'Which security properties are affected.' },
              treatment: { type: 'string', enum: ['modify', 'retain', 'avoid', 'share'], description: 'Recommended risk treatment option.' },
              suggested_controls: { type: 'array', items: { type: 'string' }, description: 'Annex A control IDs from the catalogue, e.g. ["annex-a.5.15","annex-a.8.5"].' }
            },
            required: ['title', 'threat', 'vulnerability', 'likelihood', 'impact', 'why_it_matters', 'treatment', 'suggested_controls']
          }
        }
      },
      required: ['risks']
    }
  };

  const resp = await callMessages({
    max_tokens: 8000,
    system,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'record_risks' },
    messages: [{ role: 'user', content: userParts.join('\n') }]
  });

  const input = extractToolInput(resp, 'record_risks');
  if (!Array.isArray(input.risks)) throw new Error('Claude returned no risks.');
  return input.risks;
}

module.exports = { isConfigured, model, callMessages, suggestRisks };
