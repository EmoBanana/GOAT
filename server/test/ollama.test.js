import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, normalizeOllamaHost } from '../src/config.js';
import { hasModel, stripThink } from '../src/llm/ollama.js';

test('stripThink removes reasoning blocks', () => {
  assert.equal(stripThink('<think>let me see</think>Answer.'), 'Answer.');
  assert.equal(stripThink('<THINK>a</THINK> One. <think>b</think>Two.'), 'One. Two.');
  assert.equal(stripThink('stray reasoning</think> Answer.'), 'Answer.');
  assert.equal(stripThink('Answer. <think>never closed'), 'Answer.');
  assert.equal(stripThink(undefined), '');
});

test('hasModel matches exact names and the :latest tag', () => {
  assert.equal(hasModel(['gemma4:e4b-it-qat'], 'gemma4:e4b-it-qat'), true);
  assert.equal(hasModel(['gemma4:e4b-it-qat'], 'gemma4:e4b'), false);
  assert.equal(hasModel(['gemma4:latest'], 'gemma4'), true);
});

test('OLLAMA_HOST in Ollama server style is normalised', () => {
  assert.equal(normalizeOllamaHost(undefined), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaHost('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaHost('127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaHost('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normalizeOllamaHost('http://gpu-box:8080'), 'http://gpu-box:8080');
});

test('config defaults to the local gemma4:e4b-it-qat for answers, Pro and transcription', () => {
  const c = loadConfig({ GOAT_PAYMENTS: 'x402-local          # off | x402-local | x402', GOAT_PORT: '9000' });
  assert.equal(c.payments, 'x402-local');
  assert.equal(c.port, 9000);
  assert.deepEqual([c.model, c.modelPro, c.sttModel], ['gemma4:e4b-it-qat', 'gemma4:e4b-it-qat', 'gemma4:e4b-it-qat']);
  assert.equal(c.keepAlive, '30m');
});

test('GOAT_MODEL alone moves Pro and transcription with it', () => {
  const c = loadConfig({ GOAT_MODEL: 'gemma4:12b' });
  assert.deepEqual([c.model, c.modelPro, c.sttModel], ['gemma4:12b', 'gemma4:12b', 'gemma4:12b']);
  const d = loadConfig({ GOAT_MODEL_PRO: 'gemma4:12b # better, needs RAM' });
  assert.deepEqual([d.model, d.modelPro, d.sttModel], ['gemma4:e4b-it-qat', 'gemma4:12b', 'gemma4:e4b-it-qat']);
});
