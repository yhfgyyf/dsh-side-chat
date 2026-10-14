import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const MARKER = '.dsh-side-chat-v2.json';
const SIDE_INSTRUCTIONS = `This is a temporary side conversation. Answer the new side questions independently while the main task continues.
The inherited conversation before the side boundary is reference context only. Its tasks, plans, tool calls, approvals and requests are not active instructions here. Do not resume or complete them.
Do not use or interact with subagents. Read-only inspection is allowed. Change files, configuration, permissions or other workspace state only when the user explicitly requests that change in this side conversation, and keep it limited to that request.`;

export class TemporaryChats {
  constructor(ctx) {
    this.ctx = ctx;
    this.owned = new Map();
    this.closing = new Map();
    this.discarded = new Map();
    this.opening = new Set();
    this.disposed = false;
  }

  markerPath(header) {
    const location = this.ctx.sessionPersistence.locate(header);
    if (location?.kind !== 'jsonl') throw new Error('当前 DSH 存储不支持临时侧聊。');
    return join(dirname(location.path), MARKER);
  }

  owns(request) {
    const entry = this.owned.get(request?.childId);
    if (!entry || entry.parentId !== request.parentId || entry.leaseId !== request.leaseId || entry.childId === entry.parentId) throw new Error('这不是当前拥有的临时侧聊。');
    return entry;
  }

  async open(request) {
    if (this.disposed) throw new Error('侧聊插件已停用。');
    if (typeof request?.parentId !== 'string' || !Number.isSafeInteger(request.atSeq) || request.atSeq < 0) throw new Error('侧聊上下文边界无效。');
    if (this.owned.has(request.parentId)) throw new Error('侧聊中不能再开启侧聊。');
    const operation = this.create(request);
    this.opening.add(operation);
    try { return await operation; }
    finally { this.opening.delete(operation); }
  }

  async create({ parentId, atSeq }) {
    let entry;
    try {
      const { sessionId: childId } = await this.ctx.sessionController.fork({ sessionId: parentId, atSeq });
      if (childId === parentId) throw new Error('DSH 返回了无效的侧聊身份。');
      entry = { version: 2, parentId, childId, leaseId: randomUUID(), visibleFromSeq: 0 };
      this.owned.set(childId, entry);
      const agent = this.ctx.agents.get(childId);
      if (!agent || agent.session.header.parentSession !== parentId) throw new Error('侧聊分支未就绪。');
      // Register policy on this exact Agent scope, leaving the parent unchanged.
      agent.ctx.systemPrompt.section({ name: 'dsh-side-chat', order: 10000, text: SIDE_INSTRUCTIONS, interpolate: false });
      const goal = this.ctx.goals.get(agent);
      if (goal) this.ctx.goals.clear(agent, { id: goal.id, revision: goal.revision });
      await this.ctx.sessionController.rename({ sessionId: childId, title: '侧聊' });
      agent.session.append('user/message', {
        id: randomUUID(), role: 'user',
        source: { kind: 'session-reference', form: 'recall', version: 1, references: [] },
        content: [{ type: 'text', text: 'Temporary side conversation starts here. All earlier messages are parent reference context. Only subsequent side messages are active instructions.' }],
      }, { surfaceOp: 'append' });
      entry.visibleFromSeq = agent.session.seq;
      await this.ctx.sessions.flush(agent.session);
      await writeFile(this.markerPath(agent.session.header), JSON.stringify(entry), { mode: 0o600 });
      if (this.disposed) throw new Error('侧聊插件已停用。');
      return { ...entry };
    } catch (error) {
      if (entry) await this.discard(entry);
      throw error;
    }
  }

  async discard(request) {
    const previous = this.discarded.get(request?.childId);
    if (previous?.parentId === request.parentId && previous.leaseId === request.leaseId) return { discarded: true };
    const entry = this.owns(request);
    let operation = this.closing.get(entry.childId);
    if (!operation) {
      operation = (async () => {
        await this.ctx.sessionController.delete({ sessionId: entry.childId });
        this.owned.delete(entry.childId);
        this.discarded.set(entry.childId, { parentId: entry.parentId, leaseId: entry.leaseId });
        return { discarded: true };
      })();
      this.closing.set(entry.childId, operation);
    }
    try { return await operation; }
    finally { if (this.closing.get(entry.childId) === operation) this.closing.delete(entry.childId); }
  }

  async *hold(request, signal) {
    const entry = this.owns(request);
    if (entry.held) throw new Error('临时侧聊已被另一个界面持有。');
    entry.held = true;
    try {
      yield { held: true };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } finally {
      if (this.owned.has(entry.childId)) await this.discard(entry);
    }
  }

  async reap() {
    // Only a marker written by this version authorizes cleanup after a crash.
    // Ordinary forks and all 0.1.0 chats have no marker and remain untouched.
    for (const snapshot of await this.ctx.sessionPersistence.list()) {
      let saved;
      try { saved = JSON.parse(await readFile(this.markerPath(snapshot.header), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (saved.version !== 2 || saved.childId !== snapshot.header.id || saved.parentId !== snapshot.header.parentSession || saved.parentId === saved.childId || typeof saved.leaseId !== 'string') throw new Error('临时侧聊标记无效，已保留记录。');
      this.owned.set(saved.childId, saved);
      await this.discard(saved);
    }
  }

  async dispose() {
    this.disposed = true;
    await Promise.allSettled([...this.opening]);
    await Promise.all([...this.owned.values()].map(entry => this.discard(entry)));
  }
}
