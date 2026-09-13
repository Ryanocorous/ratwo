import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SYNONYM_GROUPS = [
  'execute run launch activate initiate invoke perform conduct administer send execution exe enact render implement utilise call trigger do start dispatch fire apply operate act',
  'search lookup grep find look match seek replace discover pattern regex locate obtain scan query get retrieve hunt filter',
  'compute calculate math addition sum algorithm',
].map(group => group.split(/\s+/));

const SYNONYMS = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const term of group) SYNONYMS.set(term, group.filter(x => x !== term));
}

const TOKEN_RE = /[a-z0-9_]+/g;

export function words(value, { expand = true } = {}) {
  const base = String(value ?? '').toLowerCase().match(TOKEN_RE) || [];
  if (!expand) return base;
  const out = [];
  for (const term of base) {
    out.push(term);
    const related = SYNONYMS.get(term);
    if (related) out.push(...related);
  }
  return out;
}

export function clip(value, n = 120) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (text.length <= n) return text;
  const head = text.slice(0, Math.max(0, n - 1));
  const boundary = head.replace(/\s+\S*$/, '');
  return `${boundary || head}…`;
}

export function schemaText(schema) {
  if (!schema || typeof schema !== 'object') return '';
  const parts = [];
  const visit = (node, key = '') => {
    if (!node || typeof node !== 'object') return;
    if (key) parts.push(key);
    if (node.description) parts.push(node.description);
    if (Array.isArray(node.enum)) parts.push(...node.enum.map(String));
    if (node.const !== undefined) parts.push(String(node.const));
    for (const [name, child] of Object.entries(node.properties || {})) visit(child, name);
    if (node.items) visit(node.items);
    for (const branch of [...(node.anyOf || []), ...(node.oneOf || []), ...(node.allOf || [])]) visit(branch);
  };
  visit(schema);
  return parts.join(' ');
}

export const documentText = item =>
  `${item.id || ''} ${item.name || ''} ${item.description || ''} ${schemaText(item.inputSchema)}`.trim();

export const glob = (id, pattern) =>
  pattern.endsWith('*') ? id.startsWith(pattern.slice(0, -1)) : id === pattern;

export function cosine(a, b) {
  const n = Math.min(a?.length || 0, b?.length || 0);
  let dot = 0;
  let ax = 0;
  let bx = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    ax += a[i] * a[i];
    bx += b[i] * b[i];
  }
  return ax && bx ? dot / Math.sqrt(ax * bx) : 0;
}

const TOOL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const deepEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

function schemaBranchMatches(value, schema, path) {
  try { check(value, schema, path); return true; } catch { return false; }
}

export function check(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  if (schema.const !== undefined && !deepEqual(value, schema.const)) throw new Error(`${path}: expected const value`);
  if (schema.enum && !schema.enum.some(item => deepEqual(item, value))) throw new Error(`${path}: invalid enum`);
  if (schema.anyOf && !schema.anyOf.some(branch => schemaBranchMatches(value, branch, path))) throw new Error(`${path}: no anyOf branch matched`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch => schemaBranchMatches(value, branch, path)).length;
    if (matches !== 1) throw new Error(`${path}: expected exactly one oneOf branch, got ${matches}`);
  }
  if (schema.allOf) for (const branch of schema.allOf) check(value, branch, path);

  const typeMatches = type =>
    (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (type === 'integer' && Number.isInteger(value)) ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'null' && value === null);
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length && !types.some(typeMatches)) throw new Error(`${path}: expected ${types.join('|')}`);

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${path}: minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${path}: maxLength ${schema.maxLength}`);
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern).test(value))) throw new Error(`${path}: pattern mismatch`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${path}: minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${path}: maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new Error(`${path}: exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) throw new Error(`${path}: exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) throw new Error(`${path}: minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${path}: maxItems ${schema.maxItems}`);
    if (schema.uniqueItems) {
      const encoded = value.map(item => JSON.stringify(item));
      if (new Set(encoded).size !== encoded.length) throw new Error(`${path}: duplicate array items`);
    }
    for (let i = 0; i < value.length; i += 1) check(value[i], schema.items, `${path}[${i}]`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) throw new Error(`${path}: minProperties ${schema.minProperties}`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) throw new Error(`${path}: maxProperties ${schema.maxProperties}`);
    for (const key of schema.required || []) if (value[key] === undefined) throw new Error(`${path}.${key}: required`);
    const properties = schema.properties || {};
    for (const [key, child] of Object.entries(properties)) if (value[key] !== undefined) check(value[key], child, `${path}.${key}`);
    if (schema.additionalProperties === false) {
      const unknown = keys.filter(key => !(key in properties));
      if (unknown.length) throw new Error(`${path}: additional properties not allowed: ${unknown.join(', ')}`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of keys) if (!(key in properties)) check(value[key], schema.additionalProperties, `${path}.${key}`);
    }
  }
}


export class BM25Index {
  constructor(items = []) { this.rebuild(items); }

  rebuild(items = []) {
    this.items = [...items];
    this.docs = this.items.map(item => words(item._doc || documentText(item), { expand: false }));
    this.termFreqs = this.docs.map(tokens => {
      const tf = new Map();
      for (const term of tokens) tf.set(term, (tf.get(term) || 0) + 1);
      return tf;
    });
    this.count = this.docs.length || 1;
    this.avgLength = this.docs.reduce((sum, tokens) => sum + tokens.length, 0) / this.count || 1;
    this.df = new Map();
    for (const tokens of this.docs) {
      for (const term of new Set(tokens)) this.df.set(term, (this.df.get(term) || 0) + 1);
    }
    return this;
  }

  search(query, k = 5) {
    const queryTerms = words(query);
    if (!queryTerms.length || !this.items.length) return [];
    const scored = this.items.map((item, index) => {
      const tokens = this.docs[index];
      const tf = this.termFreqs[index];
      let score = 0;
      for (const term of queryTerms) {
        const frequency = tf.get(term) || 0;
        if (!frequency) continue;
        const documentFrequency = this.df.get(term) || 0;
        const idf = Math.log(1 + (this.count - documentFrequency + 0.5) / (documentFrequency + 0.5));
        score += idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * tokens.length / this.avgLength));
      }
      const normalizedQuery = String(query).trim().toLowerCase();
      if (normalizedQuery && String(item.id || '').toLowerCase() === normalizedQuery) score += 3;
      else if (normalizedQuery && String(item.name || '').toLowerCase() === normalizedQuery) score += 2;
      return [item, score];
    });
    return scored.filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).slice(0, k);
  }
}

export function bm25(items, query, k = 5) {
  return new BM25Index(items).search(query, k);
}

const SEARCH = {
  id: 'search_capabilities', name: 'search_capabilities',
  description: 'Find hidden tools/skills. Search before invoking.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'integer' } }, required: ['query'] },
};
const INVOKE = {
  id: 'invoke_tool', name: 'invoke_tool',
  description: 'Run a hidden tool returned by search_capabilities.',
  inputSchema: { type: 'object', properties: { toolId: { type: 'string' }, args: { type: 'object' } }, required: ['toolId', 'args'] },
};
const SKILL = {
  id: 'get_skill_content', name: 'get_skill_content',
  description: 'Load a skill playbook returned by search_capabilities.',
  inputSchema: { type: 'object', properties: { skillId: { type: 'string' } }, required: ['skillId'] },
};

class Semaphore {
  constructor(limit = Infinity) {
    this.limit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Infinity;
    this.active = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.limit === Infinity || this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise(resolve => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.queue.shift()?.();
  }
}

export class Ratwo {
  constructor({ directTools = ['memory_*'], topK = 5, embed = null, hybrid = 0.7, onEvent = null, validateOutputs = false, timeoutMs = 30_000, maxConcurrency = Infinity } = {}) {
    this.tools = new Map();
    this.skills = new Map();
    this.facts = new Map();
    this.direct = [...directTools];
    this.topK = topK;
    this.embed = embed;
    this.hybrid = Math.max(0, Math.min(1, hybrid));
    this.onEvent = onEvent;
    this.validateOutputs = Boolean(validateOutputs);
    this.timeoutMs = Math.max(0, Number(timeoutMs) || 0);
    this.maxConcurrency = Number.isFinite(maxConcurrency) ? Math.max(1, Math.floor(maxConcurrency)) : Infinity;
    this._semaphore = new Semaphore(this.maxConcurrency);
    this._stats = new Map();
    this._toolIndex = new BM25Index();
    this._skillIndex = new BM25Index();
    this._factIndex = new BM25Index();
    this._dirty = { tools: true, skills: true, facts: true };
  }

  isDirect(id) { return this.direct.some(pattern => glob(id, pattern)); }
  emit(type, data = {}) {
    try { this.onEvent?.({ type, at: Date.now(), ...data }); } catch { /* telemetry must not break execution */ }
  }

  _invalidate(kind) { this._dirty[kind] = true; }
  _index(kind) {
    if (!this._dirty[kind]) return this[`_${kind.slice(0, -1)}Index`];
    const items = kind === 'tools'
      ? [...this.tools.values()].filter(tool => !this.isDirect(tool.id))
      : kind === 'skills' ? [...this.skills.values()] : [...this.facts.values()];
    const index = this[`_${kind.slice(0, -1)}Index`];
    index.rebuild(items);
    this._dirty[kind] = false;
    return index;
  }

  setDirectTools(patterns = []) {
    this.direct = [...patterns];
    this._invalidate('tools');
    this.emit('direct.update', { patterns: [...this.direct] });
    return this;
  }

  unregister(...ids) {
    let deleted = 0;
    for (const id of ids.flat()) deleted += this.tools.delete(id) ? 1 : 0;
    if (deleted) this._invalidate('tools');
    return deleted;
  }

  unregisterSkill(...ids) {
    let deleted = 0;
    for (const id of ids.flat()) deleted += this.skills.delete(id) ? 1 : 0;
    if (deleted) this._invalidate('skills');
    return deleted;
  }

  unregisterFact(...ids) {
    let deleted = 0;
    for (const id of ids.flat()) deleted += this.facts.delete(id) ? 1 : 0;
    if (deleted) this._invalidate('facts');
    return deleted;
  }

  async register(...values) {
    for (const source of values.flat()) {
      const id = source.id || source.name;
      const execute = source.execute || source.run || source.handler;
      if (!id || typeof execute !== 'function') throw new Error('tool needs id/name + execute');
      if (!TOOL_ID_RE.test(id)) throw new Error(`invalid tool id: ${id}`);
      const publicName = source.name || id;
      if (!TOOL_ID_RE.test(publicName)) throw new Error(`invalid tool name: ${publicName}`);
      if ([SEARCH.id, INVOKE.id, SKILL.id].includes(id)) throw new Error(`reserved tool id: ${id}`);
      const tool = {
        ...source,
        id,
        name: publicName,
        description: clip(source.description),
        inputSchema: source.inputSchema || source.parameters || { type: 'object' },
        outputSchema: source.outputSchema || {},
        execute,
      };
      tool._doc = documentText(tool);
      if (this.embed) tool._vec = await this.embed(tool._doc);
      this.tools.set(id, tool);
      this._invalidate('tools');
      this.emit('tool.register', { id, direct: this.isDirect(id) });
    }
    return this;
  }

  registerSkill(...values) {
    for (const source of values.flat()) {
      if (!source?.id) throw new Error('skill needs id');
      const skill = { ...source, name: source.name || source.id, description: clip(source.description), tools: source.tools || [], body: source.body || source.content || '' };
      skill._doc = `${documentText(skill)} ${skill.tools.join(' ')}`;
      this.skills.set(skill.id, skill);
      this._invalidate('skills');
    }
    return this;
  }

  registerFact(...values) {
    for (const source of values.flat()) {
      const id = source?.id || `fact_${this.facts.size + 1}`;
      const fact = { ...source, id, name: source.name || id, description: clip(source.description || source.content), content: source.content || source.value || '' };
      fact._doc = `${documentText(fact)} ${fact.content}`;
      this.facts.set(id, fact);
      this._invalidate('facts');
    }
    return this;
  }

  async _rank(index, query, k) {
    const items = index.items;
    const base = index.search(query, Math.max(k * 3, k));
    if (!this.embed) return base.slice(0, k);
    const queryVector = await this.embed(query);
    const maxLexical = Math.max(...base.map(([, score]) => score), 1e-9);
    const lexical = new Map(base.map(([item, score]) => [item.id, score / maxLexical]));
    for (const item of items) if (!item._vec) item._vec = await this.embed(item._doc || (item._doc = documentText(item)));
    return items
      .map(item => [item, this.hybrid * (lexical.get(item.id) || 0) + (1 - this.hybrid) * cosine(queryVector, item._vec)])
      .filter(([, score]) => score > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, k);
  }

  async searchCapabilities(query, { topK = this.topK } = {}) {
    const k = Math.max(1, Math.min(20, Number(topK) | 0 || this.topK));
    const toolIndex = this._index('tools');
    const skillIndex = this._index('skills');
    const [toolHits, skillHits] = await Promise.all([this._rank(toolIndex, query, k), this._rank(skillIndex, query, k)]);
    const out = {
      tools: toolHits.map(([tool, score]) => ({ id: tool.id, name: tool.name, description: clip(tool.description), inputSchema: tool.inputSchema, score: +score.toFixed(4) })),
      skills: skillHits.map(([skill, score]) => ({ id: skill.id, name: skill.name, description: clip(skill.description), tools: skill.tools, score: +score.toFixed(4) })),
    };
    this.emit('search', { query: clip(query, 200), toolHits: out.tools.length, skillHits: out.skills.length });
    return out;
  }

  _recordStat(id, { ok, ms, timedOut = false }) {
    const stat = this._stats.get(id) || { calls: 0, ok: 0, errors: 0, timeouts: 0, totalMs: 0, maxMs: 0 };
    stat.calls += 1;
    stat.ok += ok ? 1 : 0;
    stat.errors += ok ? 0 : 1;
    stat.timeouts += timedOut ? 1 : 0;
    stat.totalMs += ms;
    stat.maxMs = Math.max(stat.maxMs, ms);
    this._stats.set(id, stat);
  }

  async _run(tool, args, ctx, origin = 'direct') {
    check(args, tool.inputSchema);
    const queuedAt = Date.now();
    await this._semaphore.acquire();
    const started = Date.now();
    const timeoutMs = Math.max(0, Number(tool.timeoutMs ?? tool.timeout_ms ?? this.timeoutMs) || 0);
    const controller = new AbortController();
    const externalSignal = ctx && typeof ctx === 'object' ? ctx.signal : null;
    const onAbort = () => controller.abort(externalSignal.reason || new Error('cancelled'));
    if (externalSignal) {
      if (externalSignal.aborted) onAbort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    const runCtx = ctx && typeof ctx === 'object' ? { ...ctx, signal: controller.signal } : { signal: controller.signal };
    let timer = null;
    let timedOut = false;
    this.emit('invoke.start', { id: tool.id, origin, queueMs: started - queuedAt, timeoutMs });
    try {
      const execution = Promise.resolve().then(() => tool.execute(args, runCtx));
      const result = timeoutMs > 0
        ? await Promise.race([
            execution,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                const error = new Error(`tool timeout after ${timeoutMs}ms: ${tool.id}`);
                error.code = 'ETIMEDOUT';
                controller.abort(error);
                reject(error);
              }, timeoutMs);
            }),
          ])
        : await execution;
      if (this.validateOutputs && tool.outputSchema && Object.keys(tool.outputSchema).length) check(result, tool.outputSchema, '$return');
      const ms = Date.now() - started;
      this._recordStat(tool.id, { ok: true, ms });
      this.emit('invoke', { id: tool.id, origin, ms, queueMs: started - queuedAt, ok: true });
      return result;
    } catch (error) {
      const ms = Date.now() - started;
      this._recordStat(tool.id, { ok: false, ms, timedOut });
      this.emit('invoke', { id: tool.id, origin, ms, queueMs: started - queuedAt, ok: false, timedOut, error: String(error?.message || error) });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener?.('abort', onAbort);
      this._semaphore.release();
    }
  }

  async invokeTool(toolId, args = {}, ctx) {
    const tool = this.tools.get(toolId);
    if (!tool) throw new Error(`unknown tool: ${toolId}`);
    if (this.isDirect(toolId)) throw new Error(`${toolId} is direct; call it by its literal name`);
    return this._run(tool, args, ctx, 'invoke');
  }

  getSkillContent(skillId) {
    const skill = this.skills.get(skillId);
    if (!skill) throw new Error(`unknown skill: ${skillId}`);
    return { skillId, body: skill.body, tools: skill.tools };
  }

  async ground(text, { topK = 3 } = {}) {
    return this._index('facts').search(text, topK)
      .map(([fact]) => fact.content)
      .filter(content => content && !String(text).includes(content))
      .join('\n');
  }

  async recall(query, options) { return (await this.searchCapabilities(query, options)).tools; }

  stats() {
    return Object.fromEntries([...this._stats.entries()].map(([id, stat]) => [id, {
      ...stat,
      avgMs: stat.calls ? +(stat.totalMs / stat.calls).toFixed(3) : 0,
    }]));
  }

  snapshot() {
    const publicTool = tool => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      direct: this.isDirect(tool.id),
      timeoutMs: tool.timeoutMs ?? tool.timeout_ms ?? this.timeoutMs,
    });
    return {
      tools: [...this.tools.values()].map(publicTool),
      skills: [...this.skills.values()].map(skill => ({ id: skill.id, name: skill.name, description: skill.description, tools: [...skill.tools] })),
      facts: [...this.facts.values()].map(fact => ({ id: fact.id, name: fact.name, description: fact.description })),
      directTools: [...this.direct],
      stats: this.stats(),
    };
  }

  health() {
    return {
      ok: true,
      tools: this.tools.size,
      skills: this.skills.size,
      facts: this.facts.size,
      directTools: [...this.direct],
      timeoutMs: this.timeoutMs,
      maxConcurrency: Number.isFinite(this.maxConcurrency) ? this.maxConcurrency : null,
      indexesDirty: { ...this._dirty },
    };
  }

  modelTools() {
    const expose = tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, execute: (args, ctx) => this._run(tool, args, ctx, 'direct') });
    const out = {
      [SEARCH.id]: { ...SEARCH, execute: args => this.searchCapabilities(args.query, { topK: args.topK }) },
      [INVOKE.id]: { ...INVOKE, execute: (args, ctx) => this.invokeTool(args.toolId, args.args, ctx) },
      [SKILL.id]: { ...SKILL, execute: args => this.getSkillContent(args.skillId) },
    };
    for (const tool of this.tools.values()) if (this.isDirect(tool.id)) out[tool.id] = expose(tool);
    return out;
  }

  openAITools() {
    return Object.values(this.modelTools()).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  }

  async handleToolCall(name, args = {}, ctx) {
    const tool = this.modelTools()[name];
    if (!tool) throw new Error(`model cannot call: ${name}`);
    return tool.execute(typeof args === 'string' ? JSON.parse(args) : args, ctx);
  }

  async handleOpenAIToolCall(call, ctx) {
    const fn = call?.function || call;
    if (!fn?.name) throw new Error('tool call missing function.name');
    return this.handleToolCall(fn.name, fn.arguments ?? {}, ctx);
  }

  async useMemory(memory, { recall = true, forget = true } = {}) {
    const directRemember = typeof memory?.memory_remember === 'function' ? memory.memory_remember.bind(memory) : null;
    const remember = directRemember || (typeof memory?.remember === 'function' ? memory.remember.bind(memory) : null);
    if (!remember) throw new Error('memory plugin needs remember()/memory_remember()');
    const tools = [{
      id: 'memory_remember', description: 'Store durable memory.',
      inputSchema: { type: 'object', properties: { content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['content'] },
      execute: args => directRemember ? directRemember(args) : remember(args.content, args.tags || []),
    }];
    const directRecall = typeof memory?.memory_recall === 'function' ? memory.memory_recall.bind(memory) : null;
    const recallFn = directRecall || (typeof memory?.recall === 'function' ? memory.recall.bind(memory) : null);
    if (recall && recallFn) tools.push({
      id: 'memory_recall', description: 'Recall relevant durable memories.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
      execute: args => directRecall ? directRecall(args) : recallFn(args.query, args.limit || 5),
    });
    const directForget = typeof memory?.memory_forget === 'function' ? memory.memory_forget.bind(memory) : null;
    const forgetFn = directForget || (typeof memory?.forget === 'function' ? memory.forget.bind(memory) : null);
    if (forget && forgetFn) tools.push({
      id: 'memory_forget', description: 'Delete a durable memory by id.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute: args => directForget ? directForget(args) : forgetFn(args.id),
    });
    return this.register(tools);
  }
}

export class MemoryStore {
  constructor(file = null, { maxItems = 10_000, ttlMs = null } = {}) {
    this.file = file;
    this.items = [];
    this.maxItems = Math.max(1, Number(maxItems) | 0 || 10_000);
    this.ttlMs = ttlMs == null ? null : Math.max(1, Number(ttlMs) || 1);
    this._index = new BM25Index();
    this._dirty = true;
    this._saveTail = Promise.resolve();
  }

  memory_remember = args => this.remember(args);
  memory_recall = args => this.recall(args);
  memory_forget = args => this.forget(args);

  _invalidate() { this._dirty = true; }

  _prune(now = Date.now()) {
    let changed = false;
    if (this.ttlMs != null) {
      const before = this.items.length;
      this.items = this.items.filter(item => now - (item.updatedAt || item.createdAt || now) <= this.ttlMs);
      changed ||= before !== this.items.length;
    }
    if (this.items.length > this.maxItems) {
      this.items.sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0));
      this.items.splice(0, this.items.length - this.maxItems);
      changed = true;
    }
    if (changed) this._invalidate();
    return changed;
  }

  _memoryIndex() {
    if (this._dirty) {
      this._index.rebuild(this.items.map(item => ({ ...item, _doc: `${item.content} ${(item.tags || []).join(' ')}` })));
      this._dirty = false;
    }
    return this._index;
  }

  async load() {
    if (!this.file) return this;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.items = parsed;
      else if (parsed && parsed.schema === 1 && Array.isArray(parsed.items)) this.items = parsed.items;
      else throw new Error('unsupported memory file format');
      this._prune();
      this._invalidate();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async _writeSnapshot(payload) {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, payload, 'utf8');
    try {
      await rename(tmp, this.file);
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
      await rm(this.file, { force: true });
      await rename(tmp, this.file);
    }
  }

  async _save() {
    if (!this.file) return;
    const payload = JSON.stringify({ schema: 1, items: this.items });
    const write = () => this._writeSnapshot(payload);
    const next = this._saveTail.then(write, write);
    this._saveTail = next.catch(() => {});
    return next;
  }

  async remember(input, tags = []) {
    const args = typeof input === 'object' && input !== null ? input : { content: input, tags };
    const content = String(args.content || '').trim();
    const normalizedTags = [...new Set((args.tags || []).map(tag => String(tag).trim()).filter(Boolean))];
    if (!content) throw new Error('content required');
    const now = Date.now();
    this._prune(now);
    let item = this.items.find(entry => entry.content === content);
    if (item) {
      item.tags = [...new Set([...(item.tags || []), ...normalizedTags])];
      item.updatedAt = now;
    } else {
      item = { id: `m_${now.toString(36)}_${Math.random().toString(36).slice(2, 9)}`, content, tags: normalizedTags, createdAt: now };
      this.items.push(item);
    }
    this._prune(now);
    this._invalidate();
    await this._save();
    return { id: item.id, stored: true };
  }

  async recall(input, limit = 5) {
    const args = typeof input === 'object' && input !== null ? input : { query: input, limit };
    if (this._prune()) await this._save();
    return this._memoryIndex()
      .search(args.query, Math.max(1, Math.min(20, Number(args.limit || 5) | 0)))
      .map(([item, score]) => { const { _doc, ...clean } = item; return { ...clean, score: +score.toFixed(4) }; });
  }

  async forget(input) {
    const id = typeof input === 'object' && input !== null ? input.id : input;
    const before = this.items.length;
    this.items = this.items.filter(item => item.id !== id);
    if (this.items.length !== before) {
      this._invalidate();
      await this._save();
    }
    return { deleted: before - this.items.length };
  }


  list() { return this.items.map(item => ({ ...item, tags: [...(item.tags || [])] })); }

  async flush() { await this._saveTail; }
}

export const ratwo = options => new Ratwo(options);

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--self-test')) {
  const router = ratwo();
  let remembered = '';
  await router.register(
    { id: 'sum', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }, execute: ({ a, b }) => a + b },
    { id: 'memory_remember', description: 'remember', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }, execute: ({ content }) => (remembered = content, { ok: true }) },
  );
  if (!router.modelTools().memory_remember || router.modelTools().sum) throw new Error('direct exposure failed');
  if (!(await router.searchCapabilities('calculate numbers')).tools.some(x => x.id === 'sum')) throw new Error('synonym search failed');
  await router.handleToolCall('memory_remember', { content: 'x' });
  if (remembered !== 'x') throw new Error('memory failed');
  try { await router.invokeTool('memory_remember', { content: 'bad' }); throw new Error('direct proxy not blocked'); }
  catch (error) { if (!String(error.message).includes('direct')) throw error; }
  const timeoutRouter = ratwo({ timeoutMs: 5 });
  await timeoutRouter.register({ id: 'slow', description: 'slow test', execute: async () => new Promise(resolve => setTimeout(resolve, 25)) });
  try { await timeoutRouter.invokeTool('slow', {}); throw new Error('timeout failed'); }
  catch (error) { if (error.code !== 'ETIMEDOUT') throw error; }
  check({ mode: 'fast' }, { type: 'object', properties: { mode: { enum: ['fast', 'slow'] } }, required: ['mode'], additionalProperties: false });
  try { check({ mode: 'fast', stray: 1 }, { type: 'object', properties: { mode: { type: 'string' } }, additionalProperties: false }); throw new Error('schema strictness failed'); }
  catch (error) { if (!String(error.message).includes('additional')) throw error; }
  const memory = new MemoryStore(null, { maxItems: 2 });
  await memory.remember({ content: 'launch service', tags: ['ops', 'ops'] });
  await memory.remember({ content: 'find record', tags: ['search'] });
  if (!(await memory.recall({ query: 'execute', limit: 1 }))[0]?.content.includes('launch')) throw new Error('memory synonym recall failed');
  console.log('ratwo.mjs self-test: ok');
}
