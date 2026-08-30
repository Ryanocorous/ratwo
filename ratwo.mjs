// Going to try to stick to mjs/py to port it then improve/optimise

import { readFile, writeFile, rename } from '';

import { readFile, writeFile, rename } from 'node:fs/promises';

const words = s => (String(s).toLowerCase().match(/[a-z0-9_]+/g) || []);
const clip = (s, n = 120) => {};
const schemaText = s => {};
const doc = x => {};
const glob = (id, p) => {};
const cosine = (a, b) => {};

function check(v, s, p = '$') {}
function bm25(items, q, k = 5) {}

const SEARCH = {};
const INVOKE = {};
const SKILL = {};

export class Ratel {
  constructor(options = {}) {}
}

export class MemoryStore {
  constructor(file = null) {}
  memory_remember = a => {};
  memory_recall = a => {};
  memory_forget = a => {};

  async load() {}
  async _save() {}
  async remember({ content, tags }) {}
  async recall({ query, limit }) {}
  async forget({ id }) {}
}
export const ratel = o => {};

// testing logic
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv.includes('--self-test')) {}
