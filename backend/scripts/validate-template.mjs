// Minimal template.yaml syntax check used when the SAM CLI is not installed.
// If the YAML parses and the key sections exist, we treat the template as valid;
// full resource-level validation still needs `sam validate` on a machine with SAM.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

// SAM templates use CloudFormation intrinsic tags (!Ref, !Sub, !GetAtt) that
// plain YAML parsers reject. This js-yaml build has no usable Type/Schema tag
// API, so pre-process: rewrite each short tag into a plain quoted string that
// encodes the tag name, e.g. `!Ref Stage` -> "CF::Ref Stage". We only need the
// structure, not semantically-correct intrinsics.
function stripCfTags(src) {
  return src
    // 1) Stash ${...} so the YAML flow parser sees no open brace: `${Stage}` -> `<__SUB__Stage>`
    .replace(/\$\{([^}]*)\}/g, '<__SUB__$1>')
    // 2) Per line, turn `!Tag <value>` into a plain quoted string (flow-closing brace kept outside)
    .split('\n').map((line) => {
      if (!line.includes('!')) return line;
      // Block form: `key: !Tag value [
      const m = line.match(/^(\s*(?:-\s*)?[A-Za-z0-9_]+:\s*)!([A-Za-z]+)(\s+)(.*?)(\s*\}\s*)?$/);
      // Flow form: `- Key: { Inner: !Tag value }` (the `!` is NOT right after the outer key)
      if (!m) {
        const f = line.match(/^(.*?)(!([A-Za-z]+)(\s+)([^\n{}]*?))(\s*\}\s*)?$/);
        if (!f) return line;
        const [, pre, , ftag, , fval, fbrace = ''] = f;
        return `${pre}${JSON.stringify(`CF::${ftag} ${fval.trim()}`)}${fbrace}`;
      }
      const [, prefix, tag, , value, brace = ''] = m;
      return `${prefix}${JSON.stringify(`CF::${tag} ${value.trim()}`)}${brace}`;
    }).join('\n');
}
const doc = yaml.load(stripCfTags(readFileSync(new URL('../template.yaml', import.meta.url), 'utf8')));
if (!doc) throw new Error('template.yaml parsed to empty document');

const problems = [];
function must(cond, msg) { if (!cond) problems.push(msg); }

must(['AWSTemplateFormatVersion', 'Transform', 'Parameters', 'Resources'].every(k => k in doc), 'missing top-level keys');
// Only secret-looking params must be NoEcho; Stage is a plain name, not a secret.
const secretParams = ['OpenAQApiKey', 'TelegramBotToken', 'TelegramWebhookSecret'];
for (const p of secretParams) {
  must(doc.Parameters?.[p]?.NoEcho === true, `Parameter ${p} must be NoEcho`);
}
const res = doc.Resources ?? {};
const names = Object.keys(res);

// --- What the citizen bot needs (Phase 9R scope) ---------------------------------
const mustTables = ['SubscribersTable'];
for (const t of mustTables) must(res[t]?.Type === 'AWS::DynamoDB::Table', `missing table ${t}`);
for (const t of mustTables) {
  const tpl = res[t]?.Properties?.TableName ?? '';
  // stripCfTags stashed `${Stage}` as `<__SUB__Stage>`; accept either form.
  must(tpl.includes('Stage') && (tpl.includes('<__SUB__Stage>') || tpl.includes('${Stage}')), `${t} TableName must include Stage`);
}
must(res.SubscribersTable?.Properties?.KeySchema?.[0]?.AttributeName === 'chatId', 'SubscribersTable PK must be chatId');
must(res.FetchAndEvaluateFunction?.Type === 'AWS::Serverless::Function', 'missing fetchAndEvaluate function');
must(res.TelegramWebhookFunction?.Type === 'AWS::Serverless::Function', 'missing telegramWebhook function');
must(res.HttpApi?.Type === 'AWS::Serverless::HttpApi', 'missing HttpApi');
must(res.FetchScheduleRule?.Type === 'AWS::Events::Rule', 'missing schedule rule');

// Telegram must be able to reach the webhook: a POST route on the HTTP API.
const route = JSON.stringify(res.TelegramWebhookFunction?.Properties?.Events ?? {});
must(route.includes('/telegram/webhook'), 'telegramWebhook must be routed on POST /telegram/webhook');
must(route.includes('HttpApi'), 'telegramWebhook route must use the shared HttpApi');

// TypeScript handlers need the esbuild build method, or `sam build` ships
// index.ts while Handler: index.handler looks for index.js. This is exactly the
// bug that hid until cfn-lint was run (found after task 9R.11), so check it here.
for (const fn of ['FetchAndEvaluateFunction', 'TelegramWebhookFunction']) {
  const meta = res[fn]?.Metadata;
  must(meta?.BuildMethod === 'esbuild', `${fn} needs Metadata.BuildMethod: esbuild (TypeScript source)`);
  const entryPoints = meta?.BuildProperties?.EntryPoints ?? [];
  must(entryPoints.includes('index.ts'), `${fn} BuildProperties.EntryPoints must include index.ts`);
  // Metadata is a CFN resource attribute: inside Properties it is invalid.
  must(!('Metadata' in (res[fn]?.Properties ?? {})), `${fn} has Metadata nested inside Properties (must be a sibling)`);
}

// Neither Lambda may hold table names it does not use: least privilege.
const envOf = (fn) => res[fn]?.Properties?.Environment?.Variables ?? {};
for (const fn of ['FetchAndEvaluateFunction', 'TelegramWebhookFunction']) {
  must(typeof envOf(fn).SUBSCRIBERS_TABLE === 'string' && envOf(fn).SUBSCRIBERS_TABLE.includes('SubscribersTable'), `${fn} must get SUBSCRIBERS_TABLE`);
}

// --- What must not come back ------------------------------------------------------
// The product is one Telegram bot. A dashboard's air-quality tables, an email topic
// or a REST API Lambda would mean deleted scope had crept back into the template.
const bannedResources = ['SchoolsTable', 'ReadingsTable', 'AdvisoryCacheTable', 'AlertsTable', 'ApiFunction', 'AirAlertsTopic'];
for (const gone of bannedResources) {
  must(!names.includes(gone), `${gone} belongs to removed scope and must not come back`);
}
const bannedEnvVars = ['SCHOOLS_TABLE', 'READINGS_TABLE', 'ADVISORY_TABLE', 'ALERTS_TABLE', 'ALERT_TOPIC_ARN'];
for (const banned of bannedEnvVars) {
  must(!JSON.stringify(res).includes(banned), `stale env var ${banned} still referenced`);
}

// Global env must carry the new secrets through NoEcho parameters.
const glob = doc.Globals?.Function?.Environment?.Variables ?? {};
must(glob.TELEGRAM_BOT_TOKEN === '{Ref:TelegramBotToken}' || (glob.TELEGRAM_BOT_TOKEN ?? '').length > 0, 'Globals env missing TELEGRAM_BOT_TOKEN');
must((glob.TELEGRAM_WEBHOOK_SECRET ?? '').length > 0, 'Globals env missing TELEGRAM_WEBHOOK_SECRET');

if (problems.length) {
  console.error('template.yaml INVALID:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('template.yaml OK: YAML parses, NoEcho params + core resources present');
