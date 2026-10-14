import test from 'node:test';
import assert from 'node:assert/strict';
import { sidePresentation, withoutSideSessions } from '../src/presentation.js';

test('the visible side transcript excludes inherited messages, groups and navigation while keeping native live nodes', () => {
  const nodes = new Map([['parent', { anchorSeq: 8 }], ['side', { anchorSeq: 27 }], ['stream', { anchorSeq: 30 }]]);
  const navigation = [{ anchorKey: 'parent' }, { anchorKey: 'side' }];
  const chat = { order: ['parent', 'side', 'stream'], nodes, navigation: { items: () => navigation } };
  const groups = new Map([['old', { members: [{ key: 'parent' }] }], ['new', { members: [{ key: 'side' }, { key: 'stream' }] }]]);
  const grouped = { entries: [{ kind: 'node', key: 'parent' }, { kind: 'group', key: 'old' }, { kind: 'group', key: 'new' }], groupSource: key => ({ getSnapshot: () => groups.get(key) }) };
  const conversation = { views: { get: () => chat, grouped: () => grouped }, activeTargets: new Set(['chat']) };
  const filtered = sidePresentation(24);
  assert.deepEqual(filtered.chat(chat).order, ['side', 'stream']);
  assert.deepEqual(filtered.chat(chat).navigation.items(), [{ anchorKey: 'side' }]);
  assert.deepEqual(filtered.conversation(conversation).views.grouped('chat').entries, [{ kind: 'group', key: 'new' }]);
  assert.equal(filtered.chat(chat).nodes, nodes);
  assert.equal(filtered.chat(chat), filtered.chat(chat));
  assert.equal(filtered.conversation(conversation), filtered.conversation(conversation));
  assert.deepEqual(chat.order, ['parent', 'side', 'stream']);
});

test('temporary side sessions are omitted only from the workspace presentation, without changing the native catalog', () => {
  const snapshot = { ids: ['main', 'side', 'old-saved-fork'], byId: { main: {}, side: {}, 'old-saved-fork': {} } };
  const visible = withoutSideSessions(snapshot, new Map([['side', {}]]));
  assert.deepEqual(visible.ids, ['main', 'old-saved-fork']);
  assert.equal(visible.byId.side, undefined);
  assert.ok(snapshot.byId.side);
});
