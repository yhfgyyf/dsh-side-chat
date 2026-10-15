export const TAB_ID = 'dsh-side-chat';
export const TAB_KIND = 'sidechat';
const PREFIX = 'dsh-resource://sidechat/session/';

export function sideAddress(parentId, childId) {
  return PREFIX + encodeURIComponent(parentId) + '/' + encodeURIComponent(childId);
}

export function parseSideAddress(address) {
  if (!address.startsWith(PREFIX)) return;
  const parts = address.slice(PREFIX.length).split('/');
  if (parts.length !== 2 || parts.some(part => !part)) return;
  try { return { parentId: decodeURIComponent(parts[0]), childId: decodeURIComponent(parts[1]) }; }
  catch { return; }
}

export class SideChats {
  constructor(ctx) {
    this.ctx = ctx;
    this.owned = new Map();
    this.entries = {};
    this.listeners = new Set();
    this.opening = new Map();
    this.closing = new Map();
    this.disposed = false;
    this.subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
    this.getSnapshot = () => this.entries;
  }

  publish(parentId, entry) {
    this.entries = { ...this.entries, [parentId]: entry };
    for (const listener of this.listeners) listener();
  }

  isSide(sessionId) { return this.owned.has(sessionId); }

  owns(parentId, childId) { return parentId !== childId && this.owned.get(childId)?.parentId === parentId; }

  boundary(childId) { return this.owned.get(childId)?.visibleFromSeq; }

  notify(parentId, error) {
    const scope = this.ctx.sessions.scope(parentId);
    if (scope) this.ctx.conversation.input.for(scope).notify('error', error.message ?? String(error));
  }

  async attach(parentId, childId) {
    if (this.disposed) throw new Error('侧聊插件已停用。');
    if (!this.owns(parentId, childId)) throw new Error('这条记录不是当前主会话的侧聊。');
    const existing = this.entries[parentId];
    if (existing?.childId === childId && existing.reference) {
      await existing.ready;
      return this.entries[parentId];
    }
    if (existing?.reference) throw new Error('当前主会话已有另一个侧聊。');
    const reference = this.ctx.sessions.retain(childId, { source: 'controllerOperation' });
    const identity = this.owned.get(childId);
    const hold = this.ctx.remote.sideChat.hold(identity);
    let acknowledge, refuse;
    const held = new Promise((resolve, reject) => { acknowledge = resolve; refuse = reject; });
    const entry = { ...identity, reference, hold, phase: 'loading', ready: Promise.all([reference.ready, held]) };
    this.publish(parentId, entry);
    entry.holdDone = (async () => {
      try {
        for await (const value of hold) if (value.held) acknowledge();
        refuse(new Error('临时侧聊已结束。'));
      } catch (error) { refuse(error); }
      finally {
        if (!this.disposed && this.owns(parentId, childId) && !this.closing.has(childId)) this.expire(parentId, childId);
      }
    })();
    try {
      await entry.ready;
      if (this.disposed) throw new Error('侧聊插件已停用。');
      const ready = { ...entry, phase: 'ready' };
      this.publish(parentId, ready);
      return ready;
    } catch (error) {
      reference.release();
      hold.dispose();
      this.publish(parentId, { parentId, childId, phase: 'error', error: error.message ?? String(error) });
      throw error;
    }
  }

  async create(parentId) {
    const parent = this.ctx.sessions.retain(parentId, { source: 'controllerOperation' });
    let childId;
    try {
      const binding = await parent.ready;
      const events = binding.eventSource.getSnapshot().entries;
      const atSeq = events.filter(entry => entry.type === 'event').at(-1)?.event.seq;
      if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error('主会话还没有可引用的上下文，请先发送一条消息。');
      const result = await this.ctx.remote.sideChat.open({ parentId, atSeq });
      if (!result.ok) throw new Error(result.error.message);
      const identity = result.value;
      childId = identity.childId;
      if (childId === parentId) { childId = undefined; throw new Error('DSH 返回了无效的侧聊身份。'); }
      this.owned.set(childId, identity);
      if (this.disposed) throw new Error('侧聊插件已停用。');
      const entry = await this.attach(parentId, childId);
      return entry;
    } catch (error) {
      if (childId) {
        try { await this.close(parentId, childId); }
        catch (cleanup) { throw new Error(`${error.message}；临时侧聊清理失败：${cleanup.message}`); }
      }
      throw error;
    } finally { parent.release(); }
  }

  async open(parentId) {
    if (this.disposed) throw new Error('侧聊插件已停用。');
    if (this.isSide(parentId)) throw new Error('侧聊中不能再开启侧聊，请回到主会话。');
    const closing = this.closing.get(this.entries[parentId]?.childId);
    if (closing) await closing;
    let pending = this.opening.get(parentId);
    if (!pending) {
      const existing = this.entries[parentId];
      if (existing?.phase === 'ready') pending = Promise.resolve(existing);
      else pending = this.create(parentId);
      this.opening.set(parentId, pending);
    }
    let entry;
    try { entry = await pending; }
    finally { if (this.opening.get(parentId) === pending) this.opening.delete(parentId); }
    if (this.disposed) throw new Error('侧聊插件已停用。');
    // Address the captured owner even if the user changed the main selection.
    this.ctx.sidebarRight.openResourceIn(parentId, sideAddress(parentId, entry.childId), { kind: TAB_KIND, revealIfOpened: true });
    return entry;
  }

  async ask(parentId, question) {
    const entry = await this.open(parentId);
    if (question.trim()) {
      const result = await entry.reference.binding.session.prompt([{ type: 'text', text: question.trim() }], 'queue');
      if (!result.ok) throw new Error(result.error.message);
    }
    return entry;
  }

  async close(parentId, childId) {
    if (!this.owns(parentId, childId)) throw new Error('这条记录不是当前主会话的侧聊。');
    let pending = this.closing.get(childId);
    if (!pending) {
      pending = (async () => {
        const result = await this.ctx.remote.sideChat.discard(this.owned.get(childId));
        if (!result.ok) throw new Error(result.error.message);
        const entry = this.entries[parentId];
        if (entry?.childId === childId) {
          entry.hold.dispose();
          entry.reference?.release();
          this.publish(parentId, undefined);
        }
        this.owned.delete(childId);
        this.dismissStale(parentId, childId);
      })();
      this.closing.set(childId, pending);
    }
    try { await pending; }
    finally { if (this.closing.get(childId) === pending) this.closing.delete(childId); }
  }

  expire(parentId, childId) {
    const entry = this.entries[parentId];
    if (entry?.childId !== childId) return;
    this.owned.delete(childId);
    entry.reference?.release();
    this.publish(parentId, undefined);
    this.dismissStale(parentId, childId);
  }

  dismissStale(parentId, childId) {
    for (const tab of this.ctx.sidebarRight.tabsIn(parentId)) {
      if (parseSideAddress(tab.contentId)?.childId === childId) this.ctx.sidebarRight.closeIn(parentId, tab.id);
    }
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all([...this.owned.values()].map(({ parentId, childId }) => this.close(parentId, childId)));
    this.listeners.clear();
  }
}

export function sideInputSource(chats) {
  const claim = session => ({ claim: {
    name: 'side', token: '/side ', hint: '向侧聊提问，主会话继续运行',
    submit: async question => {
      try { await chats.ask(session.sessionId, question); return { kind: 'success' }; }
      catch (error) { return { kind: 'error', text: error.message ?? String(error) }; }
    },
  } });
  return {
    trigger: '/', name: 'dsh-side-chat-input', order: 50,
    candidates: async () => [], onPick: () => undefined,
    matchSpace: (session, token) => token === '/side' ? claim(session) : undefined,
    matchEnter: async (session, line, _signal, envelope) => {
      if (!/^\/side(?:\s|$)/.test(line)) return;
      if (chats.isSide(session.sessionId)) throw new Error('侧聊中不能再开启侧聊，请回到主会话。');
      if (envelope.attachments > 0) throw new Error('请先用 /side 打开侧聊，再在侧聊输入框中添加附件；当前附件已保留。');
      return claim(session);
    },
  };
}
