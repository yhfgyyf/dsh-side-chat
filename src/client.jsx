import React, { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { SideChats, sideInputSource, parseSideAddress, TAB_ID, TAB_KIND } from './controller.js';
import { sideChatRemote } from './remote.js';
import { sidePresentation, withoutSideSessions } from './presentation.js';

export const inject = ['sessions', 'resources', 'slots', 'commandUi', 'inputTriggers', 'conversation', 'sidebarRight', 'sidebarRightTabs', 'uiWorkspace', 'remote'];

const css = `
.dsh-side-chat{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-side-chat-status{padding:12px;font-size:13px}
.dsh-side-chat-open{background:transparent;border:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;color:inherit;cursor:pointer;padding:5px;border-radius:6px}
.dsh-side-chat-open:hover{background:var(--dsw-alias-interactive-bg-hover)}
`;

function SideIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M14 4v16M17 8h2m-2 4h2m-2 4h2" /></svg>;
}

function OpenSide({ sessionId, chats }) {
  if (chats.isSide(sessionId)) return null;
  return <button type="button" className="dsh-side-chat-open" aria-label="打开侧聊" title="打开侧聊 /side" onClick={() => { void chats.open(sessionId).catch(error => chats.notify(sessionId, error)); }}><SideIcon /></button>;
}

function ChatView(props) { return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>; }

function mapHook(hook, map) {
  return (selector = value => value, equal) => hook(value => selector(map(value)), equal);
}

function NativeSideChat({ native, chats, ...props }) {
  const boundary = chats.boundary(props.sessionId);
  const filtered = useMemo(() => boundary === undefined ? null : sidePresentation(boundary), [boundary]);
  const overrides = useMemo(() => filtered ? {
    useChat: mapHook(props.useChat, filtered.chat),
    useConversation: mapHook(props.useConversation, filtered.conversation),
    useSession: mapHook(props.useSession, value => ({ ...value, hasMore: false })),
    useProjection: (key, selector = value => value, equal) => props.useProjection(key, value => selector(key === 'turnOutline' ? undefined : value), equal),
  } : {}, [filtered, props.useChat, props.useConversation, props.useSession, props.useProjection]);
  return React.createElement(native, { ...props, ...overrides });
}

function NativeWorkspace({ native, chats, ...props }) {
  const snapshot = useSyncExternalStore(chats.subscribe, chats.getSnapshot);
  const filtered = useMemo(() => {
    const cache = new WeakMap();
    return value => {
      if (!cache.has(value)) cache.set(value, withoutSideSessions(value, chats.owned));
      return cache.get(value);
    };
  }, [snapshot, chats]);
  return React.createElement(native, {
    ...props, useSessions: mapHook(props.useSessions, filtered),
    searchSessions: async (...args) => {
      const result = await props.searchSessions(...args);
      return result.ok ? { ...result, value: { ...result.value, items: result.value.items.filter(item => !chats.isSide(item.sessionId)) } } : result;
    },
  });
}

function wrapNativeSlot(ctx, name, matches, component, chats) {
  const original = ctx.slots.entriesOfSlot(name).find(matches);
  if (!original) throw new Error(`DSH 原生 ${name} 界面不可用。`);
  const native = original.component;
  const wrapped = props => React.createElement(component, { ...props, native, chats });
  // Keep the native slot's existing store and child-slot authorization intact.
  original.component = wrapped;
  return () => { if (original.component === wrapped) original.component = native; };
}

function SideConversation({ useSession, useConversation, useSessions, sessionId, renderFactorySlot }) {
  const session = useSession(value => value);
  const active = useConversation(value => value).activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
  const knownBlank = useSessions(value => value.byId[sessionId]?.blank);
  const settling = !active && session.openState === 'loading' && knownBlank !== true;
  const hero = !active && (session.openState === 'open' || knownBlank === true);
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }, { slots: { views: ChatView } });
}

function SideTab({ sessionId, useTabInfo, SessionProvider, renderSlot, chats }) {
  const { tab, sidebar } = useTabInfo();
  const target = parseSideAddress(tab.contentId);
  const snapshot = useSyncExternalStore(chats.subscribe, chats.getSnapshot);
  const entry = snapshot[sessionId];
  useLayoutEffect(() => {
    if (!sidebar.expanded && !tab.visible && target?.parentId === sessionId && chats.owns(sessionId, target.childId)) {
      void chats.close(sessionId, target.childId).catch(error => chats.notify(sessionId, error));
    }
  }, [sidebar.expanded, tab.visible, sessionId, target?.parentId, target?.childId, chats]);
  useEffect(() => {
    if (target?.parentId !== sessionId) return;
    if (!chats.owns(sessionId, target.childId)) { chats.dismissStale(sessionId, target.childId); return; }
    void chats.attach(sessionId, target.childId).catch(() => {});
  }, [sessionId, target?.parentId, target?.childId, chats]);
  if (target?.parentId !== sessionId) return <p role="alert">侧聊地址与主会话不匹配。</p>;
  if (!chats.owns(sessionId, target.childId)) return null;
  return <section className="dsh-side-chat" aria-label="侧聊" data-side-chat-session={target.childId}>
    {entry?.phase === 'error' ? <p className="dsh-side-chat-status" role="alert">{entry.error}</p> : entry?.phase !== 'ready' || entry.childId !== target.childId ? <p className="dsh-side-chat-status" role="status">加载中…</p> : <SessionProvider session={entry.reference}>{renderSlot('dsh.side-chat.conversation', {})}</SessionProvider>}
  </section>;
}

export async function apply(ctx) {
  const unmount = await ctx.remote.$mount(sideChatRemote);
  ctx.inject(['remote.sideChat'], inner => mountUI(inner, unmount));
}

function mountUI(ctx, unmount) {
  const chats = new SideChats(ctx);
  ctx.effect(() => async () => { await chats.dispose(); await unmount(); }, 'side-chat: temporary Client sessions');
  ctx.effect(() => wrapNativeSlot(ctx, 'conversation.view', entry => entry.options.id === 'chat', NativeSideChat, chats), 'side-chat: separate visible transcript');
  ctx.effect(() => wrapNativeSlot(ctx, 'sidebar.workspaces', () => true, NativeWorkspace, chats), 'side-chat: temporary sessions stay out of the chat list');
  // Saved 0.1.0 branches remain ordinary records. Their old panel cannot resume
  // an ephemeral lease, so clear only the obsolete UI tabs.
  for (const parentId of ctx.sessions.list.getSnapshot().ids) {
    for (const tab of ctx.sidebarRight.tabsIn(parentId)) if (parseSideAddress(tab.contentId)) ctx.sidebarRight.closeIn(parentId, tab.id);
  }
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = css; document.head.append(style);
    return () => style.remove();
  }, 'side-chat: styles');
  ctx.effect(() => ctx.commandUi.register({
    name: 'side', label: () => '侧聊', description: () => '继承当前上下文，在右侧提问，主会话继续运行', icon: SideIcon,
    available: session => !chats.isSide(session.sessionId),
    ui: { kind: 'action', run: session => { void chats.open(session.sessionId).catch(error => chats.notify(session.sessionId, error)); } },
  }), 'side-chat: /side command');
  ctx.effect(() => ctx.inputTriggers.registerSource(sideInputSource(chats)), 'side-chat: inline question');
  ctx.effect(() => ctx.resources.register({
    protocol: 'sidechat',
    async *open(address, { signal }) {
      const target = parseSideAddress(address);
      if (!target) return;
      if (!chats.owns(target.parentId, target.childId)) { chats.dismissStale(target.parentId, target.childId); return; }
      if (signal.aborted) return;
      yield { ok: true, value: target };
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  }), 'side-chat: sidebar resource');
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: TAB_KIND, patterns: ['dsh-resource://sidechat/**'], priority: 'extension', multiple: true, keepMounted: true,
    canOpen: address => {
      const target = parseSideAddress(address);
      return target !== undefined && chats.owns(target.parentId, target.childId);
    }, title: () => '侧聊',
  }), 'side-chat: sidebar type');
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (parentId, tab) => {
    const target = parseSideAddress(tab.contentId);
    if (target?.parentId === parentId && chats.getSnapshot()[parentId]?.childId === target.childId) {
      void chats.close(parentId, target.childId).catch(error => chats.notify(parentId, error));
    }
  }), 'side-chat: sidebar close');
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: TAB_ID, inject: () => ({ chats }),
    children: { 'dsh.side-chat.conversation': { kind: 'single', scope: 'session' } },
  }, SideTab));
  ctx.slots.inject('dsh.side-chat.conversation', () => ctx.slots.register({ name: 'dsh.side-chat.conversation' }, SideConversation));
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: TAB_ID, order: 50, inject: () => ({ chats }) }, OpenSide));
}
