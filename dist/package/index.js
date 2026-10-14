import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { TemporaryChats } from './host.js';
import { sideChatRemote } from './remote.js';

export const inject = ['sessionController', 'sessions', 'agents', 'sessionPersistence', 'goals', 'typert'];

export async function apply(ctx) {
  const chats = new TemporaryChats(ctx);
  ctx.effect(() => () => chats.dispose(), 'side-chat: temporary Host sessions');
  await chats.reap();
  class SideChatHost extends TypertRemoteService {
    constructor(inner) { super(inner, 'sideChatHost', { namespace: 'sideChat' }); }
    open(request) { return chats.open(request); }
    discard(request) { return chats.discard(request); }
    hold(request, signal) { return chats.hold(request, signal); }
  }
  ctx.plugin(SideChatHost);
  ctx.effect(() => ctx.typert.register({
    package: sideChatRemote.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: sideChatRemote.descriptors,
  }), 'side-chat: Host RPC');
}
