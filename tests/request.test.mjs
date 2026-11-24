// Run: node test.mjs /absolute/path/to/pi-coding-agent
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [, , piRoot] = process.argv;
assert.ok(piRoot, 'Pass the absolute path to the installed Pi package');
const extension = fileURLToPath(new URL('../extensions/model-prompts.ts', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'pi-model-prompts-test-'));
process.env.HOME = scratch;
process.env.PI_CODING_AGENT_DIR = scratch;
process.env.PI_OFFLINE = '1';

const requests = [];
const warnings = [];
const originalWarn = console.warn;
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const payload = JSON.parse(body);
  const prompt = payload.messages.filter(({ role }) => ['system', 'developer'].includes(role));
  requests.push(prompt.map(({ content }) => content).join('\n'));
  const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: payload.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
  const provider = 'offline-model-prompts';
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const api = 'openai-completions';
  const models = ['fixture-alpha', 'other'].map((id) => ({
    id, name: id, provider, baseUrl, api, input: ['text'], reasoning: false,
    contextWindow: 100_000, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(scratch, 'auth.json'), modelsPath: join(scratch, 'models.json'),
  });
  runtime.registerProvider(provider, { baseUrl, api, apiKey: 'fixture-only', models });
  await runtime.setRuntimeApiKey(provider, 'fixture-only');
  writeFileSync(join(scratch, 'settings.json'), JSON.stringify({ packages: [extension], cacheWarming: 'off' }));
  writeFileSync(join(scratch, 'alpha.md'), 'MODEL_LAYER\n');
  const config = join(scratch, 'model-prompts.json');
  const rules = [
    { match: 'FIXTURE-*', prompt: 'CORE_LAYER' },
    { match: 'fixture-*', scope: 'main', prompt: 'MAIN_LAYER' },
    { match: `${provider}/fixture-alpha`, promptFile: 'alpha.md' },
  ];
  const setRules = (entries) => writeFileSync(config, JSON.stringify({ rules: entries }));
  console.warn = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('model-prompts:')) warnings.push(args[0]);
    else originalWarn(...args);
  };

  async function start(customPrompt) {
    const settingsManager = sdk.SettingsManager.create(scratch, scratch, { projectTrusted: false });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: scratch, agentDir: scratch, settingsManager,
      ...(customPrompt ? { systemPromptOverride: () => customPrompt } : {}) });
    await resourceLoader.reload();
    const { session, extensionsResult } = await sdk.createAgentSession({
      cwd: scratch, agentDir: scratch, settingsManager, resourceLoader, model: models[0],
      modelRuntime: runtime, sessionManager: sdk.SessionManager.inMemory(scratch),
    });
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({ mode: 'print' });
    return session;
  }
  async function ask(session) {
    const count = requests.length;
    await session.prompt('Fixture request');
    assert.equal(requests.length, count + 1);
    return requests.at(-1);
  }

  const main = await start();
  try {
    assert.doesNotMatch(await ask(main), /<model_instructions>/);
    assert.deepEqual(warnings, [], 'a missing optional config is silent');
    setRules(rules);
    assert.match(await ask(main), /<model_instructions>\s*CORE_LAYER\s*MAIN_LAYER\s*MODEL_LAYER\s*<\/model_instructions>/);
    await main.setModel(models[1]);
    assert.doesNotMatch(await ask(main), /<model_instructions>/, 'a nonmatching model clears the previous section');
    await main.setModel(models[0]);
    const badRules = [
      ...rules, { match: '*', scope: 'parent', prompt: 'MUST_NOT_WIDEN' },
      { match: '*', promptFile: 'missing.md' },
    ];
    setRules(badRules);
    for (let i = 0; i < 2; i++) {
      const prompt = await ask(main);
      assert.match(prompt, /CORE_LAYER\s*MAIN_LAYER\s*MODEL_LAYER/);
      assert.doesNotMatch(prompt, /MUST_NOT_WIDEN/);
    }
    assert.equal(warnings.length, 2, 'each invalid rule is reported once');
    assert.match(warnings[0], /unsupported "scope"/);
    assert.match(warnings[1], /missing\.md.*does not exist/);

    const child = await start('<active_agent name="Fixture"/>');
    try {
      const prompt = await ask(child);
      assert.match(prompt, /CORE_LAYER\s*MODEL_LAYER/);
      assert.doesNotMatch(prompt, /MAIN_LAYER|MUST_NOT_WIDEN/);
    } finally { child.dispose(); }

    const priorWarnings = warnings.length;
    writeFileSync(config, '{ malformed');
    assert.doesNotMatch(await ask(main), /<model_instructions>/);
    assert.doesNotMatch(await ask(main), /<model_instructions>/);
    assert.equal(warnings.length, priorWarnings + 1);
    assert.match(warnings.at(-1), /not valid JSON/);
  } finally { main.dispose(); }
  console.log('PASS: model switching, main and child scopes, missing config, bad rules, malformed config, and warning deduplication');
} finally {
  console.warn = originalWarn;
  server.closeAllConnections();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
