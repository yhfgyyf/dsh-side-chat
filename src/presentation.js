export function sidePresentation(boundary) {
  const chatCache = new WeakMap(), conversationCache = new WeakMap();
  const visible = (chat, key) => (chat.nodes.get(key)?.anchorSeq ?? -1) >= boundary;
  const chat = snapshot => {
    const navigation = snapshot.navigation.items();
    const cached = chatCache.get(snapshot);
    if (cached?.navigation === navigation) return cached.value;
    const order = snapshot.order.filter(key => visible(snapshot, key));
    const items = navigation.filter(item => visible(snapshot, item.anchorKey));
    const filtered = { ...snapshot, order, navigation: { items: () => items } };
    chatCache.set(snapshot, { navigation, value: filtered });
    return filtered;
  };
  const conversation = snapshot => {
    const target = snapshot.views.get('chat');
    const grouped = snapshot.views.grouped('chat');
    const cached = conversationCache.get(snapshot);
    if (cached?.target === target && cached.entries === grouped?.entries) return cached.value;
    const entries = grouped?.entries.filter(entry => target && (entry.kind === 'node'
      ? visible(target, entry.key)
      : grouped.groupSource(entry.key).getSnapshot()?.members.some(member => visible(target, member.key))));
    const filtered = { ...snapshot, views: {
      get: key => key === 'chat' && target ? chat(target) : snapshot.views.get(key),
      grouped: key => key === 'chat' && grouped ? { entries, groupSource: value => grouped.groupSource(value) } : snapshot.views.grouped(key),
    } };
    conversationCache.set(snapshot, { target, entries: grouped?.entries, value: filtered });
    return filtered;
  };
  return { chat, conversation };
}

export function withoutSideSessions(snapshot, owned) {
  const ids = snapshot.ids.filter(id => !owned.has(id));
  const byId = Object.fromEntries(Object.entries(snapshot.byId).filter(([id]) => !owned.has(id)));
  return { ...snapshot, ids, byId };
}
