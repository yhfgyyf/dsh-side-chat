// Both halves use the existing DSH authenticated RPC and stream carrier.
const strict = (name, parse) => ({ mode: 'strict', typeSymbol: 'dsh-side-chat#' + name, create: () => ({ parse }) });
function identity(value) {
  if (!value || ['parentId', 'childId', 'leaseId'].some(key => typeof value[key] !== 'string' || !value[key])) throw new Error('侧聊身份无效。');
  return { parentId: value.parentId, childId: value.childId, leaseId: value.leaseId };
}
const openRequest = strict('OpenRequest', value => {
  if (!value || typeof value.parentId !== 'string' || !value.parentId || !Number.isSafeInteger(value.atSeq) || value.atSeq < 0) throw new Error('侧聊上下文边界无效。');
  return { parentId: value.parentId, atSeq: value.atSeq };
});
const leaseRequest = strict('LeaseRequest', identity);
const openResult = strict('OpenResult', value => {
  const ids = identity(value);
  if (!Number.isSafeInteger(value.visibleFromSeq) || value.visibleFromSeq < 0) throw new Error('侧聊显示边界无效。');
  return { ...ids, visibleFromSeq: value.visibleFromSeq };
});
const heldResult = strict('HeldResult', value => {
  if (value?.held !== true) throw new Error('侧聊未就绪。');
  return { held: true };
});
const discardResult = strict('DiscardResult', value => {
  if (value?.discarded !== true) throw new Error('侧聊未清理。');
  return { discarded: true };
});
export const sideChatRemote = {
  package: 'dsh-side-chat',
  descriptors: ['open', 'discard', 'hold'].map(method => ({
    id: `dsh-side-chat#sideChat/${method}`,
    service: 'sideChatHost', namespace: 'sideChat', method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: method === 'open' ? openRequest : leaseRequest }],
    result: method === 'open' ? openResult : method === 'hold' ? heldResult : discardResult,
    ...(method === 'hold' ? { mode: 'stream', cancellation: { parameter: 'signal' } } : {}),
  })),
};
