import test from 'node:test';
import assert from 'node:assert/strict';
import { SideChats, sideInputSource, sideAddress } from '../src/controller.js';

function fixture() {
  const calls = { fork: [], send: [], discard: [], open: [], released: [], notices: [] };
  const bindings = new Map();
  const options = { events: [{ type: 'event', event: { seq: 18 } }, { type: 'transient', event: { seq: 19 } }], tabs: [] };
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { parent: { displayTitle: '主任务', running: true } } }) },
      scope: id => ({ sessionId: id }),
      retain(id) {
        if (!bindings.has(id)) bindings.set(id, {
          eventSource: { getSnapshot: () => ({ entries: options.events }) },
          session: {
            prompt: async content => { calls.send.push({ id, text: content[0].text }); if (options.sendError) throw options.sendError; return { ok: true }; },
          },
        });
        let released = false;
        const binding = bindings.get(id);
        return { sessionId: id, binding, ready: Promise.resolve(binding), release() { if (!released) { calls.released.push(id); released = true; } } };
      },
    },
    sidebarRight: { tabsIn: () => options.tabs, openResourceIn: (...args) => { calls.open.push(args); }, closeIn() {} },
    conversation: { input: { for: scope => ({ notify: (level, text) => calls.notices.push({ id: scope.sessionId, level, text }) }) } },
    remote: { sideChat: {
      open: async request => {
        calls.fork.push(request);
        if (options.forkGate) await options.forkGate;
        if (options.forkError) return { ok: false, error: options.forkError };
        const childId = calls.fork.length === 1 ? 'child' : 'child-' + calls.fork.length;
        return { ok: true, value: { ...request, childId, leaseId: 'lease-' + childId, visibleFromSeq: 24 } };
      },
      hold: () => {
        let stop;
        const ended = new Promise(resolve => { stop = resolve; });
        return { async *[Symbol.asyncIterator]() { yield { held: true }; await ended; }, dispose: () => stop() };
      },
      discard: async request => {
        calls.discard.push(request);
        return options.discardError ? { ok: false, error: options.discardError } : { ok: true, value: { discarded: true } };
      },
    } },
  };
  return { ctx, calls, options, chats: new SideChats(ctx) };
}

test('side question forks the latest durable context while the parent runs; all mutations address the child', async () => {
  const { chats, calls } = fixture();
  await chats.ask('parent', '解释当前实现');
  assert.deepEqual(calls.fork, [{ parentId: 'parent', atSeq: 18 }]);
  assert.deepEqual(calls.send, [{ id: 'child', text: '解释当前实现' }]);
  assert.equal(chats.boundary('child'), 24);
  assert.equal(calls.open[0][0], 'parent');
  assert.equal(calls.open[0][1], sideAddress('parent', 'child'));
  assert.match(calls.open[0][1], /^dsh-resource:\/\/sidechat\/session\//);
  assert.deepEqual(calls.released, ['parent']);
  await chats.dispose();
});

test('concurrent opens share one fork; later questions reuse the same independently addressed chat', async () => {
  const { chats, calls, options } = fixture();
  let proceed;
  options.forkGate = new Promise(resolve => { proceed = resolve; });
  const first = chats.open('parent'), second = chats.open('parent');
  proceed();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.childId, b.childId);
  await chats.ask('parent', '追问');
  assert.equal(calls.fork.length, 1);
  assert.deepEqual(calls.send, [{ id: 'child', text: '追问' }]);
  await assert.rejects(chats.open('child'), /不能再开启/);
  await chats.dispose();
});

test('closing discards only an owned side; a cleanup failure retains ownership for retry', async () => {
  const { chats, calls, options } = fixture();
  await chats.open('parent');
  options.discardError = new Error('offline');
  await assert.rejects(chats.close('parent', 'child'), /offline/);
  assert.equal(chats.getSnapshot().parent.childId, 'child');
  assert.ok(!calls.released.includes('child'));
  options.discardError = undefined;
  await chats.close('parent', 'child');
  assert.equal(chats.getSnapshot().parent, undefined);
  assert.deepEqual(calls.discard.map(call => call.childId), ['child', 'child']);
  assert.equal(calls.discard[1].leaseId, 'lease-child');
  await assert.rejects(chats.close('parent', 'parent'), /不是当前/);
  await assert.rejects(chats.attach('parent', 'another-existing-chat'), /不是当前/);
  assert.equal(calls.discard.length, 2);
});

test('plugin disposal discards its side; reopening after reload starts a fresh side', async () => {
  const { ctx, chats, calls, options } = fixture();
  await chats.open('parent');
  await chats.dispose();
  options.tabs = [{ contentId: sideAddress('parent', 'child') }];
  const reloaded = new SideChats(ctx);
  const restored = await reloaded.open('parent');
  assert.equal(restored.childId, 'child-2');
  assert.equal(calls.fork.length, 2);
  assert.equal(calls.discard.length, 1);
  assert.ok(!reloaded.isSide('child'));
  await reloaded.dispose();
});

test('a fork finishing after plugin disposal discards its new side and releases the parent', async () => {
  const { chats, calls, options } = fixture();
  let proceed;
  options.forkGate = new Promise(resolve => { proceed = resolve; });
  const opening = chats.open('parent');
  const disposed = chats.dispose(); proceed();
  await assert.rejects(opening, /已停用/);
  await disposed;
  assert.deepEqual(calls.discard.map(call => call.childId), ['child']);
  assert.deepEqual(calls.released, ['parent']);
  assert.equal(calls.open.length, 0);
});

test('/side with text is claimed; attachments and failures never submit the draft to the parent', async () => {
  const { chats, calls, options } = fixture();
  const source = sideInputSource(chats);
  const session = { sessionId: 'parent' };
  assert.equal(await source.matchEnter(session, '/sideways hello', null, { attachments: 0 }), undefined);
  await assert.rejects(source.matchEnter(session, '/side 解释附件', null, { attachments: 1 }), /附件已保留/);
  assert.equal(calls.fork.length, 0);
  options.forkError = new Error('fork denied');
  const outcome = await source.matchEnter(session, '/side 问题', null, { attachments: 0 });
  assert.deepEqual(await outcome.claim.submit('问题'), { kind: 'error', text: 'fork denied' });
  assert.equal(calls.send.length, 0);
  options.forkError = undefined;
  options.sendError = new Error('send denied');
  assert.deepEqual(await outcome.claim.submit('问题'), { kind: 'error', text: 'send denied' });
  assert.deepEqual(calls.send, [{ id: 'child-2', text: '问题' }]);
  await chats.dispose();
});
