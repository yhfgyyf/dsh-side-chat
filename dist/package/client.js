window.__ModuleLoader__.load({
	id: "dsh-side-chat",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/controller.js
		var TAB_ID = "dsh-side-chat";
		var TAB_KIND = "sidechat";
		var PREFIX = "dsh-resource://sidechat/session/";
		function sideAddress(parentId, childId) {
			return PREFIX + encodeURIComponent(parentId) + "/" + encodeURIComponent(childId);
		}
		function parseSideAddress(address) {
			if (!address.startsWith(PREFIX)) return;
			const parts = address.slice(32).split("/");
			if (parts.length !== 2 || parts.some((part) => !part)) return;
			try {
				return {
					parentId: decodeURIComponent(parts[0]),
					childId: decodeURIComponent(parts[1])
				};
			} catch {
				return;
			}
		}
		var SideChats = class {
			constructor(ctx) {
				this.ctx = ctx;
				this.owned = /* @__PURE__ */ new Map();
				this.entries = {};
				this.listeners = /* @__PURE__ */ new Set();
				this.opening = /* @__PURE__ */ new Map();
				this.closing = /* @__PURE__ */ new Map();
				this.disposed = false;
				this.subscribe = (listener) => {
					this.listeners.add(listener);
					return () => this.listeners.delete(listener);
				};
				this.getSnapshot = () => this.entries;
			}
			publish(parentId, entry) {
				this.entries = {
					...this.entries,
					[parentId]: entry
				};
				for (const listener of this.listeners) listener();
			}
			isSide(sessionId) {
				return this.owned.has(sessionId);
			}
			owns(parentId, childId) {
				return parentId !== childId && this.owned.get(childId)?.parentId === parentId;
			}
			boundary(childId) {
				return this.owned.get(childId)?.visibleFromSeq;
			}
			notify(parentId, error) {
				const scope = this.ctx.sessions.scope(parentId);
				if (scope) this.ctx.conversation.input.for(scope).notify("error", error.message ?? String(error));
			}
			async attach(parentId, childId) {
				if (this.disposed) throw new Error("侧聊插件已停用。");
				if (!this.owns(parentId, childId)) throw new Error("这条记录不是当前主会话的侧聊。");
				const existing = this.entries[parentId];
				if (existing?.childId === childId && existing.reference) {
					await existing.ready;
					return this.entries[parentId];
				}
				if (existing?.reference) throw new Error("当前主会话已有另一个侧聊。");
				const reference = this.ctx.sessions.retain(childId, { source: "controllerOperation" });
				const identity = this.owned.get(childId);
				const hold = this.ctx.remote.sideChat.hold(identity);
				let acknowledge, refuse;
				const held = new Promise((resolve, reject) => {
					acknowledge = resolve;
					refuse = reject;
				});
				const entry = {
					...identity,
					reference,
					hold,
					phase: "loading",
					ready: Promise.all([reference.ready, held])
				};
				this.publish(parentId, entry);
				entry.holdDone = (async () => {
					try {
						for await (const value of hold) if (value.held) acknowledge();
						refuse(/* @__PURE__ */ new Error("临时侧聊已结束。"));
					} catch (error) {
						refuse(error);
					} finally {
						if (!this.disposed && this.owns(parentId, childId) && !this.closing.has(childId)) this.expire(parentId, childId);
					}
				})();
				try {
					await entry.ready;
					if (this.disposed) throw new Error("侧聊插件已停用。");
					const ready = {
						...entry,
						phase: "ready"
					};
					this.publish(parentId, ready);
					return ready;
				} catch (error) {
					reference.release();
					hold.dispose();
					this.publish(parentId, {
						parentId,
						childId,
						phase: "error",
						error: error.message ?? String(error)
					});
					throw error;
				}
			}
			async create(parentId) {
				const parent = this.ctx.sessions.retain(parentId, { source: "controllerOperation" });
				let childId;
				try {
					const atSeq = (await parent.ready).eventSource.getSnapshot().entries.filter((entry) => entry.type === "event").at(-1)?.event.seq;
					if (!Number.isSafeInteger(atSeq) || atSeq < 0) throw new Error("主会话还没有可引用的上下文，请先发送一条消息。");
					const result = await this.ctx.remote.sideChat.open({
						parentId,
						atSeq
					});
					if (!result.ok) throw new Error(result.error.message);
					const identity = result.value;
					childId = identity.childId;
					if (childId === parentId) {
						childId = void 0;
						throw new Error("DSH 返回了无效的侧聊身份。");
					}
					this.owned.set(childId, identity);
					if (this.disposed) throw new Error("侧聊插件已停用。");
					return await this.attach(parentId, childId);
				} catch (error) {
					if (childId) try {
						await this.close(parentId, childId);
					} catch (cleanup) {
						throw new Error(`${error.message}；临时侧聊清理失败：${cleanup.message}`);
					}
					throw error;
				} finally {
					parent.release();
				}
			}
			async open(parentId) {
				if (this.disposed) throw new Error("侧聊插件已停用。");
				if (this.isSide(parentId)) throw new Error("侧聊中不能再开启侧聊，请回到主会话。");
				const closing = this.closing.get(this.entries[parentId]?.childId);
				if (closing) await closing;
				let pending = this.opening.get(parentId);
				if (!pending) {
					const existing = this.entries[parentId];
					if (existing?.phase === "ready") pending = Promise.resolve(existing);
					else pending = this.create(parentId);
					this.opening.set(parentId, pending);
				}
				let entry;
				try {
					entry = await pending;
				} finally {
					if (this.opening.get(parentId) === pending) this.opening.delete(parentId);
				}
				if (this.disposed) throw new Error("侧聊插件已停用。");
				this.ctx.sidebarRight.openResourceIn(parentId, sideAddress(parentId, entry.childId), {
					kind: TAB_KIND,
					revealIfOpened: true
				});
				return entry;
			}
			async ask(parentId, question) {
				const entry = await this.open(parentId);
				if (question.trim()) {
					const result = await entry.reference.binding.session.prompt([{
						type: "text",
						text: question.trim()
					}], "queue");
					if (!result.ok) throw new Error(result.error.message);
				}
				return entry;
			}
			async close(parentId, childId) {
				if (!this.owns(parentId, childId)) throw new Error("这条记录不是当前主会话的侧聊。");
				let pending = this.closing.get(childId);
				if (!pending) {
					pending = (async () => {
						const result = await this.ctx.remote.sideChat.discard(this.owned.get(childId));
						if (!result.ok) throw new Error(result.error.message);
						const entry = this.entries[parentId];
						if (entry?.childId === childId) {
							entry.hold.dispose();
							entry.reference?.release();
							this.publish(parentId, void 0);
						}
						this.owned.delete(childId);
						this.dismissStale(parentId, childId);
					})();
					this.closing.set(childId, pending);
				}
				try {
					await pending;
				} finally {
					if (this.closing.get(childId) === pending) this.closing.delete(childId);
				}
			}
			expire(parentId, childId) {
				const entry = this.entries[parentId];
				if (entry?.childId !== childId) return;
				this.owned.delete(childId);
				entry.reference?.release();
				this.publish(parentId, void 0);
				this.dismissStale(parentId, childId);
			}
			dismissStale(parentId, childId) {
				for (const tab of this.ctx.sidebarRight.tabsIn(parentId)) if (parseSideAddress(tab.contentId)?.childId === childId) this.ctx.sidebarRight.closeIn(parentId, tab.id);
			}
			async dispose() {
				this.disposed = true;
				await Promise.allSettled([...this.opening.values()]);
				await Promise.all([...this.owned.values()].map(({ parentId, childId }) => this.close(parentId, childId)));
				this.listeners.clear();
			}
		};
		function sideInputSource(chats) {
			const claim = (session) => ({ claim: {
				name: "side",
				token: "/side ",
				hint: "向侧聊提问，主会话继续运行",
				submit: async (question) => {
					try {
						await chats.ask(session.sessionId, question);
						return { kind: "success" };
					} catch (error) {
						return {
							kind: "error",
							text: error.message ?? String(error)
						};
					}
				}
			} });
			return {
				trigger: "/",
				name: "dsh-side-chat-input",
				order: 50,
				candidates: async () => [],
				onPick: () => void 0,
				matchSpace: (session, token) => token === "/side" ? claim(session) : void 0,
				matchEnter: async (session, line, _signal, envelope) => {
					if (!/^\/side(?:\s|$)/.test(line)) return;
					if (chats.isSide(session.sessionId)) throw new Error("侧聊中不能再开启侧聊，请回到主会话。");
					if (envelope.attachments > 0) throw new Error("请先用 /side 打开侧聊，再在侧聊输入框中添加附件；当前附件已保留。");
					return claim(session);
				}
			};
		}
		//#endregion
		//#region src/remote.js
		var strict = (name, parse) => ({
			mode: "strict",
			typeSymbol: "dsh-side-chat#" + name,
			create: () => ({ parse })
		});
		function identity(value) {
			if (!value || [
				"parentId",
				"childId",
				"leaseId"
			].some((key) => typeof value[key] !== "string" || !value[key])) throw new Error("侧聊身份无效。");
			return {
				parentId: value.parentId,
				childId: value.childId,
				leaseId: value.leaseId
			};
		}
		var openRequest = strict("OpenRequest", (value) => {
			if (!value || typeof value.parentId !== "string" || !value.parentId || !Number.isSafeInteger(value.atSeq) || value.atSeq < 0) throw new Error("侧聊上下文边界无效。");
			return {
				parentId: value.parentId,
				atSeq: value.atSeq
			};
		});
		var leaseRequest = strict("LeaseRequest", identity);
		var openResult = strict("OpenResult", (value) => {
			const ids = identity(value);
			if (!Number.isSafeInteger(value.visibleFromSeq) || value.visibleFromSeq < 0) throw new Error("侧聊显示边界无效。");
			return {
				...ids,
				visibleFromSeq: value.visibleFromSeq
			};
		});
		var heldResult = strict("HeldResult", (value) => {
			if (value?.held !== true) throw new Error("侧聊未就绪。");
			return { held: true };
		});
		var discardResult = strict("DiscardResult", (value) => {
			if (value?.discarded !== true) throw new Error("侧聊未清理。");
			return { discarded: true };
		});
		var sideChatRemote = {
			package: "dsh-side-chat",
			descriptors: [
				"open",
				"discard",
				"hold"
			].map((method) => ({
				id: `dsh-side-chat#sideChat/${method}`,
				service: "sideChatHost",
				namespace: "sideChat",
				method,
				invocation: { kind: "direct" },
				parameters: [{
					name: "request",
					wire: "request",
					source: "json",
					codec: method === "open" ? openRequest : leaseRequest
				}],
				result: method === "open" ? openResult : method === "hold" ? heldResult : discardResult,
				...method === "hold" ? {
					mode: "stream",
					cancellation: { parameter: "signal" }
				} : {}
			}))
		};
		//#endregion
		//#region src/presentation.js
		function sidePresentation(boundary) {
			const chatCache = /* @__PURE__ */ new WeakMap(), conversationCache = /* @__PURE__ */ new WeakMap();
			const visible = (chat, key) => (chat.nodes.get(key)?.anchorSeq ?? -1) >= boundary;
			const chat = (snapshot) => {
				const navigation = snapshot.navigation.items();
				const cached = chatCache.get(snapshot);
				if (cached?.navigation === navigation) return cached.value;
				const order = snapshot.order.filter((key) => visible(snapshot, key));
				const items = navigation.filter((item) => visible(snapshot, item.anchorKey));
				const filtered = {
					...snapshot,
					order,
					navigation: { items: () => items }
				};
				chatCache.set(snapshot, {
					navigation,
					value: filtered
				});
				return filtered;
			};
			const conversation = (snapshot) => {
				const target = snapshot.views.get("chat");
				const grouped = snapshot.views.grouped("chat");
				const cached = conversationCache.get(snapshot);
				if (cached?.target === target && cached.entries === grouped?.entries) return cached.value;
				const entries = grouped?.entries.filter((entry) => target && (entry.kind === "node" ? visible(target, entry.key) : grouped.groupSource(entry.key).getSnapshot()?.members.some((member) => visible(target, member.key))));
				const filtered = {
					...snapshot,
					views: {
						get: (key) => key === "chat" && target ? chat(target) : snapshot.views.get(key),
						grouped: (key) => key === "chat" && grouped ? {
							entries,
							groupSource: (value) => grouped.groupSource(value)
						} : snapshot.views.grouped(key)
					}
				};
				conversationCache.set(snapshot, {
					target,
					entries: grouped?.entries,
					value: filtered
				});
				return filtered;
			};
			return {
				chat,
				conversation
			};
		}
		function withoutSideSessions(snapshot, owned) {
			const ids = snapshot.ids.filter((id) => !owned.has(id));
			const byId = Object.fromEntries(Object.entries(snapshot.byId).filter(([id]) => !owned.has(id)));
			return {
				...snapshot,
				ids,
				byId
			};
		}
		//#endregion
		//#region src/client.jsx
		var inject = [
			"sessions",
			"resources",
			"slots",
			"commandUi",
			"inputTriggers",
			"conversation",
			"sidebarRight",
			"sidebarRightTabs",
			"uiWorkspace",
			"remote"
		];
		var css = `
.dsh-side-chat{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-side-chat-status{padding:12px;font-size:13px}
.dsh-side-chat-open{background:transparent;border:0;display:inline-flex;align-items:center;justify-content:center;gap:4px;color:inherit;cursor:pointer;padding:5px;border-radius:6px}
.dsh-side-chat-open:hover{background:var(--dsw-alias-interactive-bg-hover)}
`;
		function SideIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "16",
				height: "16",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.5",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: "3",
					y: "4",
					width: "18",
					height: "16",
					rx: "3"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M14 4v16M17 8h2m-2 4h2m-2 4h2" })]
			});
		}
		function OpenSide({ sessionId, chats }) {
			if (chats.isSide(sessionId)) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: "dsh-side-chat-open",
				"aria-label": "打开侧聊",
				title: "打开侧聊 /side",
				onClick: () => {
					chats.open(sessionId).catch((error) => chats.notify(sessionId, error));
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SideIcon, {})
			});
		}
		function ChatView(props) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: props.renderSlot("conversation.session", { view: "chat" }) });
		}
		function mapHook(hook, map) {
			return (selector = (value) => value, equal) => hook((value) => selector(map(value)), equal);
		}
		function NativeSideChat({ native, chats, ...props }) {
			const boundary = chats.boundary(props.sessionId);
			const filtered = (0, react.useMemo)(() => boundary === void 0 ? null : sidePresentation(boundary), [boundary]);
			const overrides = (0, react.useMemo)(() => filtered ? {
				useChat: mapHook(props.useChat, filtered.chat),
				useConversation: mapHook(props.useConversation, filtered.conversation),
				useSession: mapHook(props.useSession, (value) => ({
					...value,
					hasMore: false
				})),
				useProjection: (key, selector = (value) => value, equal) => props.useProjection(key, (value) => selector(key === "turnOutline" ? void 0 : value), equal)
			} : {}, [
				filtered,
				props.useChat,
				props.useConversation,
				props.useSession,
				props.useProjection
			]);
			return react.default.createElement(native, {
				...props,
				...overrides
			});
		}
		function NativeWorkspace({ native, chats, ...props }) {
			const filtered = (0, react.useMemo)(() => {
				const cache = /* @__PURE__ */ new WeakMap();
				return (value) => {
					if (!cache.has(value)) cache.set(value, withoutSideSessions(value, chats.owned));
					return cache.get(value);
				};
			}, [(0, react.useSyncExternalStore)(chats.subscribe, chats.getSnapshot), chats]);
			return react.default.createElement(native, {
				...props,
				useSessions: mapHook(props.useSessions, filtered),
				searchSessions: async (...args) => {
					const result = await props.searchSessions(...args);
					return result.ok ? {
						...result,
						value: {
							...result.value,
							items: result.value.items.filter((item) => !chats.isSide(item.sessionId))
						}
					} : result;
				}
			});
		}
		function wrapNativeSlot(ctx, name, matches, component, chats) {
			const original = ctx.slots.entriesOfSlot(name).find(matches);
			if (!original) throw new Error(`DSH 原生 ${name} 界面不可用。`);
			const native = original.component;
			const wrapped = (props) => react.default.createElement(component, {
				...props,
				native,
				chats
			});
			original.component = wrapped;
			return () => {
				if (original.component === wrapped) original.component = native;
			};
		}
		function SideConversation({ useSession, useConversation, useSessions, sessionId, renderFactorySlot }) {
			const session = useSession((value) => value);
			const active = useConversation((value) => value).activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
			const knownBlank = useSessions((value) => value.byId[sessionId]?.blank);
			const settling = !active && session.openState === "loading" && knownBlank !== true;
			const hero = !active && (session.openState === "open" || knownBlank === true);
			return renderFactorySlot("conversation.content", {
				variant: "embedded",
				phase: settling ? "settling" : hero ? "hero" : "active",
				hero
			}, { slots: { views: ChatView } });
		}
		function SideTab({ sessionId, useTabInfo, SessionProvider, renderSlot, chats }) {
			const { tab, sidebar } = useTabInfo();
			const target = parseSideAddress(tab.contentId);
			const entry = (0, react.useSyncExternalStore)(chats.subscribe, chats.getSnapshot)[sessionId];
			(0, react.useLayoutEffect)(() => {
				if (!sidebar.expanded && !tab.visible && target?.parentId === sessionId && chats.owns(sessionId, target.childId)) chats.close(sessionId, target.childId).catch((error) => chats.notify(sessionId, error));
			}, [
				sidebar.expanded,
				tab.visible,
				sessionId,
				target?.parentId,
				target?.childId,
				chats
			]);
			(0, react.useEffect)(() => {
				if (target?.parentId !== sessionId) return;
				if (!chats.owns(sessionId, target.childId)) {
					chats.dismissStale(sessionId, target.childId);
					return;
				}
				chats.attach(sessionId, target.childId).catch(() => {});
			}, [
				sessionId,
				target?.parentId,
				target?.childId,
				chats
			]);
			if (target?.parentId !== sessionId) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				role: "alert",
				children: "侧聊地址与主会话不匹配。"
			});
			if (!chats.owns(sessionId, target.childId)) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("section", {
				className: "dsh-side-chat",
				"aria-label": "侧聊",
				"data-side-chat-session": target.childId,
				children: entry?.phase === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsh-side-chat-status",
					role: "alert",
					children: entry.error
				}) : entry?.phase !== "ready" || entry.childId !== target.childId ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: "dsh-side-chat-status",
					role: "status",
					children: "加载中…"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SessionProvider, {
					session: entry.reference,
					children: renderSlot("dsh.side-chat.conversation", {})
				})
			});
		}
		async function apply(ctx) {
			const unmount = await ctx.remote.$mount(sideChatRemote);
			ctx.inject(["remote.sideChat"], (inner) => mountUI(inner, unmount));
		}
		function mountUI(ctx, unmount) {
			const chats = new SideChats(ctx);
			ctx.effect(() => async () => {
				await chats.dispose();
				await unmount();
			}, "side-chat: temporary Client sessions");
			ctx.effect(() => wrapNativeSlot(ctx, "conversation.view", (entry) => entry.options.id === "chat", NativeSideChat, chats), "side-chat: separate visible transcript");
			ctx.effect(() => wrapNativeSlot(ctx, "sidebar.workspaces", () => true, NativeWorkspace, chats), "side-chat: temporary sessions stay out of the chat list");
			for (const parentId of ctx.sessions.list.getSnapshot().ids) for (const tab of ctx.sidebarRight.tabsIn(parentId)) if (parseSideAddress(tab.contentId)) ctx.sidebarRight.closeIn(parentId, tab.id);
			ctx.effect(() => {
				const style = document.createElement("style");
				style.textContent = css;
				document.head.append(style);
				return () => style.remove();
			}, "side-chat: styles");
			ctx.effect(() => ctx.commandUi.register({
				name: "side",
				label: () => "侧聊",
				description: () => "继承当前上下文，在右侧提问，主会话继续运行",
				icon: SideIcon,
				available: (session) => !chats.isSide(session.sessionId),
				ui: {
					kind: "action",
					run: (session) => {
						chats.open(session.sessionId).catch((error) => chats.notify(session.sessionId, error));
					}
				}
			}), "side-chat: /side command");
			ctx.effect(() => ctx.inputTriggers.registerSource(sideInputSource(chats)), "side-chat: inline question");
			ctx.effect(() => ctx.resources.register({
				protocol: "sidechat",
				async *open(address, { signal }) {
					const target = parseSideAddress(address);
					if (!target) return;
					if (!chats.owns(target.parentId, target.childId)) {
						chats.dismissStale(target.parentId, target.childId);
						return;
					}
					if (signal.aborted) return;
					yield {
						ok: true,
						value: target
					};
					if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				}
			}), "side-chat: sidebar resource");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				patterns: ["dsh-resource://sidechat/**"],
				priority: "extension",
				multiple: true,
				keepMounted: true,
				canOpen: (address) => {
					const target = parseSideAddress(address);
					return target !== void 0 && chats.owns(target.parentId, target.childId);
				},
				title: () => "侧聊"
			}), "side-chat: sidebar type");
			ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (parentId, tab) => {
				const target = parseSideAddress(tab.contentId);
				if (target?.parentId === parentId && chats.getSnapshot()[parentId]?.childId === target.childId) chats.close(parentId, target.childId).catch((error) => chats.notify(parentId, error));
			}), "side-chat: sidebar close");
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				inject: () => ({ chats }),
				children: { "dsh.side-chat.conversation": {
					kind: "single",
					scope: "session"
				} }
			}, SideTab));
			ctx.slots.inject("dsh.side-chat.conversation", () => ctx.slots.register({ name: "dsh.side-chat.conversation" }, SideConversation));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: TAB_ID,
				order: 50,
				inject: () => ({ chats })
			}, OpenSide));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
