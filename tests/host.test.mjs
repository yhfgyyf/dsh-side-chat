import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TemporaryChats } from '../src/host.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-side-chat-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const deleted = [], policies = [], contexts = [], cleared = [], warnings = [];
  const sessions = new Map(), agents = new Map();
  const originalGoal = { id: 'main-goal', revision: 5, phase: 'active' };
  let count = 0;
  const ctx = {
    logger: { warn: message => warnings.push(message) },
    agents: { get: id => agents.get(id) },
    sessions: { flush: async () => {} },
    goals: { get: () => ({ ...originalGoal }), clear: (agent, ref) => cleared.push({ id: agent.session.id, ref }) },
    sessionPersistence: {
      locate: header => ({ kind: 'jsonl', path: join(root, header.id, 'session.jsonl') }),
      list: async () => [...sessions.values()].map(header => ({ header })),
    },
    sessionController: {
      fork: async ({ sessionId }) => {
        const id = 'child-' + ++count;
        const header = { id, parentSession: sessionId };
        sessions.set(id, header);
        await mkdir(join(root, id));
        const session = { id, header, seq: 35, append() { this.seq++; } };
        agents.set(id, { session, ctx: { systemPrompt: {
          section: policy => { policies.push({ id, policy }); },
          context: context => { contexts.push({ id, context }); },
        } } });
        return { sessionId: id };
      },
      rename: async () => {},
      delete: async ({ sessionId }) => { deleted.push(sessionId); agents.delete(sessionId); sessions.delete(sessionId); await rm(join(root, sessionId), { recursive: true, force: true }); },
    },
  };
  return { ctx, root, deleted, policies, contexts, cleared, warnings, originalGoal, sessions, agents, chats: new TemporaryChats(ctx) };
}

test('each side request observes new parent events and visible streaming text without copying reasoning or changing the parent', async t => {
  const { chats, contexts, agents } = await fixture(t);
  const entry = await chats.open({ parentId: 'main', atSeq: 18 });
  const read = contexts[0].context.text;
  assert.ok(!read().includes('LATEST_MAIN_PROGRESS'));
  const parent = { id: 'main', status: 'running', session: { id: 'main', seq: 22 } };
  agents.set('main', parent);
  const updates = { seq: 20, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'LATEST_MAIN_PROGRESS {{unknown_variable}}' }] } } };
  chats.observeEvent({ id: parent.id }, updates);
  chats.observeStream(parent, { type: 'start', attemptId: 'attempt-1', revision: 1 });
  chats.observeStream(parent, { type: 'chunk', attemptId: 'attempt-1', revision: 2, chunk: { type: 'reasoning-delta', text: 'PRIVATE_REASONING' } });
  chats.observeStream(parent, { type: 'chunk', attemptId: 'attempt-1', revision: 3, chunk: { type: 'text-delta', text: 'LIVE_MAIN_PROGRESS' } });
  assert.match(read(), /LATEST_MAIN_PROGRESS/);
  assert.match(read(), /LIVE_MAIN_PROGRESS/);
  assert.ok(!read().includes('PRIVATE_REASONING'));
  assert.ok(!read().includes('{{unknown_variable}}'));
  assert.match(read(), /"throughSeq":21/);
  assert.equal(parent.status, 'running');
  assert.equal(parent.session.seq, 22);
  await chats.discard(entry);
  assert.equal(chats.progress.size, 0);
});

test('the host scopes side policy and goal clearing to the child; forged cleanup cannot delete the main chat', async t => {
  const { chats, deleted, policies, cleared, originalGoal, root } = await fixture(t);
  const entry = await chats.open({ parentId: 'main', atSeq: 18 });
  assert.equal(entry.visibleFromSeq, 36);
  assert.equal(policies[0].id, entry.childId);
  assert.match(policies[0].policy.text, /reference context only/);
  assert.deepEqual(cleared, [{ id: entry.childId, ref: { id: 'main-goal', revision: 5 } }]);
  assert.equal(originalGoal.phase, 'active');
  assert.equal(JSON.parse(await readFile(join(root, entry.childId, '.dsh-side-chat-v2.json'), 'utf8')).leaseId, entry.leaseId);
  await assert.rejects(chats.discard({ ...entry, childId: 'main' }), /不是当前/);
  await assert.rejects(chats.discard({ ...entry, leaseId: 'forged' }), /不是当前/);
  assert.deepEqual(deleted, []);
  await chats.discard(entry);
  await chats.discard(entry);
  assert.deepEqual(deleted, [entry.childId]);
});

test('ending the UI lease discards its temporary side and removes the storage marker', async t => {
  const { chats, root, deleted } = await fixture(t);
  const entry = await chats.open({ parentId: 'main', atSeq: 18 });
  const stop = new AbortController();
  const stream = chats.hold(entry, stop.signal);
  assert.deepEqual((await stream.next()).value, { held: true });
  const ending = stream.next(); stop.abort();
  assert.equal((await ending).done, true);
  assert.deepEqual(deleted, [entry.childId]);
  await assert.rejects(readFile(join(root, entry.childId, '.dsh-side-chat-v2.json')), /ENOENT/);
});

test('restart reaps only marked temporary sessions; old saved forks are preserved', async t => {
  const { chats, ctx, sessions, root, deleted } = await fixture(t);
  const entry = await chats.open({ parentId: 'main', atSeq: 18 });
  sessions.set('old-saved-fork', { id: 'old-saved-fork', parentSession: 'main' });
  await mkdir(join(root, 'old-saved-fork'));
  const restarted = new TemporaryChats(ctx);
  await restarted.reap();
  assert.deepEqual(deleted, [entry.childId]);
  assert.ok(sessions.has('old-saved-fork'));
});

test('a corrupt stored side cannot block activation, later cleanup, new sides or shutdown', async t => {
  const { chats, ctx, root, deleted, sessions, warnings } = await fixture(t);
  const corrupt = await chats.open({ parentId: 'main', atSeq: 18 });
  const healthy = await chats.open({ parentId: 'main', atSeq: 18 });
  const marker = join(root, corrupt.childId, '.dsh-side-chat-v2.json');
  const originalMarker = await readFile(marker);
  const remove = ctx.sessionController.delete;
  ctx.sessionController.delete = async request => {
    if (request.sessionId === corrupt.childId) throw new Error('SessionQueryError: stored log is corrupt: SessionFormatError: system/message requires a protected first surface head');
    return remove(request);
  };
  const restarted = new TemporaryChats(ctx);
  await restarted.reap();
  assert.deepEqual(deleted, [healthy.childId]);
  assert.ok(sessions.has(corrupt.childId));
  assert.deepEqual(await readFile(marker), originalMarker);
  assert.equal(restarted.owned.size, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes(corrupt.childId));
  assert.match(warnings[0], /protected first surface head/);
  const fresh = await restarted.open({ parentId: 'main', atSeq: 18 });
  await restarted.dispose();
  assert.deepEqual(deleted, [healthy.childId, fresh.childId]);
  assert.deepEqual(await readFile(marker), originalMarker);
});

test('malformed or mismatched markers are preserved without preventing cleanup of valid sides', async t => {
  const { chats, ctx, root, deleted, warnings } = await fixture(t);
  const malformed = await chats.open({ parentId: 'main', atSeq: 18 });
  const mismatched = await chats.open({ parentId: 'main', atSeq: 18 });
  const healthy = await chats.open({ parentId: 'main', atSeq: 18 });
  const markers = [malformed, mismatched].map(entry => join(root, entry.childId, '.dsh-side-chat-v2.json'));
  const values = ['{', JSON.stringify({ ...mismatched, childId: 'main' })];
  for (let i = 0; i < markers.length; i++) await writeFile(markers[i], values[i]);
  const restarted = new TemporaryChats(ctx);
  await restarted.reap();
  assert.deepEqual(deleted, [healthy.childId]);
  assert.equal(warnings.length, 2);
  assert.equal(restarted.owned.size, 0);
  for (let i = 0; i < markers.length; i++) assert.equal(await readFile(markers[i], 'utf8'), values[i]);
  await restarted.dispose();
});
