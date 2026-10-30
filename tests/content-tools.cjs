const assert = require('node:assert/strict');
const { writeFileSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { BrowserWindow, webContents } = require('electron');

exports.run = async ({ host, js, until, parentId, workspace, requests, report, data }) => {
  const main = `[data-conversation-content][data-conversation-session="${parentId}"]`;
  const side = '[data-side-chat-session] [data-conversation-content]';
  const input = selector => `${selector} [contenteditable="true"]`;
  const before = requests.length;
  const setDraft = (id, text) => js(`{const ctx=window.__dshSideChatTest;ctx.conversation.input.for(ctx.sessions.scope(${JSON.stringify(id)})).setDraft(${JSON.stringify(text)});}`);
  const select = async (selector, text) => {
    await js(`(() => {const root=document.querySelector(${JSON.stringify(selector)});const walk=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode()){const at=node.textContent.indexOf(${JSON.stringify(text)});if(at<0||node.parentElement.closest('[contenteditable]'))continue;node.parentElement.scrollIntoView({block:'center'});const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+${text.length});getSelection().removeAllRanges();getSelection().addRange(range);return;}throw Error('Selection fixture text missing');})()`);
    await until(() => js(`!!document.querySelector('[aria-label="选中内容操作"]')`), 'Selection actions did not appear');
  };
  const action = label => js(`Array.from(document.querySelectorAll('[aria-label="选中内容操作"] button')).find(button=>button.textContent===${JSON.stringify(label)}).click()`);
  const popup = () => BrowserWindow.getAllWindows().find(window => window.getTitle() === 'DSH 内容搜索' && window.isVisible());
  const key = async (keyCode, modifiers = [], target = popup()?.webContents ?? host) => { target.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); target.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
  const layout = selector => js(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}),root=element.closest('[data-dockkit-content]')||element.closest('[data-conversation-content]'),style=getComputedStyle(root);return {root:root.getBoundingClientRect().toJSON(),padding:style.padding,children:root.childElementCount,first:root.firstElementChild?.getBoundingClientRect().toJSON(),composer:root.querySelector('[contenteditable="true"]')?.getBoundingClientRect().toJSON()};})()`);
  const findInput = async query => {
    const window = await until(() => popup(), 'External search window did not open');
    await until(() => window.webContents.executeJavaScript(`!!document.querySelector('input[aria-label="搜索当前内容"]')`), 'External search input did not load');
    await window.webContents.executeJavaScript(`(()=>{const field=document.querySelector('input[aria-label="搜索当前内容"]');field.focus();field.select();})()`);
    await window.webContents.insertText(query);
  };
  const find = async (selector, query) => {
    const point = await js(`(()=>{getSelection().removeAllRanges();const element=document.querySelector(${JSON.stringify(selector)});const root=element.closest('[data-dockkit-content]')||element.closest('[data-conversation-content]');const r=root.getBoundingClientRect();return {x:Math.round((r.left+r.right)/2),y:Math.round(Math.min(r.bottom-20,r.top+100))};})()`);
    host.focus();
    host.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    host.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    const beforeLayout = await layout(selector);
    await key('s', [process.platform === 'darwin' ? 'meta' : 'control'], host);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await layout(selector), beforeLayout, 'Opening search changed the content layout');
    await findInput(query);
  };
  const count = () => popup()?.webContents.executeJavaScript(`document.querySelector('[aria-label="查找当前内容"] output')?.textContent`);
  const closeFind = async () => { await key('Escape'); await until(() => !popup(), 'Escape did not close external find'); await until(() => js(`!CSS.highlights.has('desktop-content-results')`), 'Closing search left DOM highlights'); };
  const preview = '[role="dialog"][aria-label="选中内容原文"]';
  const openPreview = async selector => {
    const point = await until(() => js(`(()=>{const chip=Array.from(document.querySelectorAll(${JSON.stringify(selector + ' [data-composer-chip="desktop-selected-text"]')})).at(-1);if(!chip)return false;chip.scrollIntoView({block:'nearest'});const r=chip.getBoundingClientRect();const point={x:Math.round((r.left+r.right)/2),y:Math.round((r.top+r.bottom)/2)};return chip.contains(document.elementFromPoint(point.x,point.y))?point:false;})()`), 'Selected-text chip did not settle into the visible pane');
    host.focus();
    host.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    host.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    try {
    await until(() => js(`!!document.querySelector(${JSON.stringify(preview)})`), 'Clicking a selected-text reference did not open its original text');
    } catch (error) {
      report.previewDebug = await js(`({point: ${JSON.stringify(point)}, target: document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,1200), body: document.body.innerText.slice(-3500)})`);
      writeFileSync(join(data, 'selection-preview-failure.png'), (await host.capturePage()).toPNG());
      throw error;
    }
  };
  const closePreview = async () => { await key('Escape'); await until(() => js(`!document.querySelector(${JSON.stringify(preview)})`), 'Escape did not close the selected-text preview'); };

  await setDraft(parentId, 'MAIN_DRAFT_KEEP ');
  await select(main, 'CONTEXT_TOKEN_ALPHA');
  await action('添加到主对话');
  await until(() => js(`document.querySelector(${JSON.stringify(input(main))})?.textContent.includes('选中内容')`), 'Main draft did not receive a reference');
  assert.ok(await js(`document.querySelector(${JSON.stringify(input(main))}).textContent.includes('MAIN_DRAFT_KEEP')`));
  assert.equal(requests.length, before, 'Selection action sent a model request');
  report.checks.push('Selected transcript text enters the native main composer as a reference chip; existing draft is preserved and no request is sent');
  const mainDraft = await js(`document.querySelector(${JSON.stringify(input(main))}).textContent`);
  await openPreview(main);
  assert.equal(await js(`document.querySelector(${JSON.stringify(preview + ' [aria-label="原文内容"]')}).textContent`), 'CONTEXT_TOKEN_ALPHA');
  await closePreview();
  assert.equal(await js(`document.querySelector(${JSON.stringify(input(main))}).textContent`), mainDraft);
  assert.equal(requests.length, before);
  report.checks.push('A real main-composer reference click shows the exact original text; Escape closes it without changing or sending the draft');

  await select(main, 'CONTEXT_TOKEN_ALPHA');
  await action('在侧边聊天中提问');
  const childId = await until(() => js(`document.querySelector('[data-side-chat-session]')?.dataset.sideChatSession`), 'Selection did not open /side');
  await until(() => js(`document.querySelector(${JSON.stringify(input(side))})?.textContent.includes('选中内容')`), 'Side draft did not receive the captured selection');
  assert.notEqual(parentId, childId);
  assert.equal(requests.length, before);
  assert.equal(await js(`window.__dshSideChatTest.sessions.binding(${JSON.stringify(parentId)}).session.getSnapshot().running`), true);
  report.checks.push('Ask in side chat opens the real temporary /side with selection in its unsent composer while the parent continues');
  await openPreview(side);
  assert.equal(await js(`document.querySelector(${JSON.stringify(preview + ' [aria-label="原文内容"]')}).textContent`), 'CONTEXT_TOKEN_ALPHA');
  await closePreview();
  assert.equal(await js(`document.querySelector('[data-side-chat-session]').dataset.sideChatSession`), childId);
  assert.equal(requests.length, before);
  report.checks.push('Selected-text references in the existing side composer open the same preview without creating a new chat or sending a request');
  await host.insertText(' SIDE_INLINE_QUESTION');
  await key('Enter');
  await until(() => js(`document.querySelector('[data-side-chat-session]')?.innerText.includes('SIDE_CONTEXT_OK')`), 'Explicit side submit failed to serialize selection');
  const request = requests.find(row => row.question === 'side');
  assert.ok(JSON.stringify(request.request).includes('选中内容（主对话）：\\n> CONTEXT_TOKEN_ALPHA'));
  report.checks.push('Only explicit Enter sends the side question; model input contains the exact quoted selection and the typed question');

  await setDraft(childId, 'SIDE_DRAFT_KEEP ');
  await select(main, 'CONTEXT_TOKEN_ALPHA');
  await action('在侧边聊天中提问');
  await until(() => js(`document.querySelector(${JSON.stringify(input(side))}).textContent.includes('选中内容')`), 'Main selection was not appended to the already-open side draft');
  assert.equal(await js(`document.querySelector('[data-side-chat-session]').dataset.sideChatSession`), childId);
  assert.ok(await js(`document.querySelector(${JSON.stringify(input(side))}).textContent.includes('SIDE_DRAFT_KEEP')`));
  assert.ok(await js(`document.querySelector('[data-side-chat-session]').innerText.includes('SIDE_CONTEXT_OK')`));
  assert.equal(await js(`document.querySelectorAll('[data-side-chat-session]').length`), 1);
  assert.equal(requests.filter(row => row.question === 'side').length, 1);
  report.checks.push('Selecting main-conversation text with /side already open appends to that exact side draft, preserving its history and existing input; it creates no second side and sends no request');
  await select(side, 'SIDE_CONTEXT_OK');
  await action('在侧边聊天中提问');
  await until(() => js(`document.querySelector(${JSON.stringify(input(side))}).textContent.includes('选中内容')`), 'Side selection failed to reuse its composer');
  assert.equal(await js(`document.querySelector('[data-side-chat-session]').dataset.sideChatSession`), childId);
  assert.ok(await js(`document.querySelector(${JSON.stringify(input(side))}).textContent.includes('SIDE_DRAFT_KEEP')`));
  await select(side, 'SIDE_CONTEXT_OK');
  await action('添加到主对话');
  assert.ok(await js(`document.querySelector(${JSON.stringify(input(main))}).textContent.includes('MAIN_DRAFT_KEEP')`));
  assert.equal(requests.filter(row => row.question === 'side').length, 1);
  report.checks.push('Selections from /side can be added to main or the existing side draft without nested chats or replacing draft text');

  await find(main, 'SIDE_CONTEXT_OK');
  await until(async () => await count() === '0/0', 'Main search leaked the side transcript');
  await closeFind();
  await find(main, 'context_token_alpha');
  await until(async () => await count() === '1/1', 'Case-insensitive main content search failed or included draft chips');
  const searchWindow = popup();
  assert.equal(searchWindow.getParentWindow(), BrowserWindow.fromWebContents(host));
  assert.equal(searchWindow.isModal(), false);
  assert.ok(searchWindow.getBounds().width <= 360 && searchWindow.getBounds().height <= 64);
  assert.equal(await js(`!!document.querySelector('.desktop-content-find, .desktop-content-find-scope, input[aria-label="搜索当前内容"]')`), false);
  assert.equal(await searchWindow.webContents.executeJavaScript('typeof window.dshDesktop'), 'undefined');
  const currentQuery = await searchWindow.webContents.executeJavaScript(`document.querySelector('input').value`);
  await key('s', [process.platform === 'darwin' ? 'meta' : 'control']);
  assert.equal(popup(), searchWindow);
  assert.equal(await searchWindow.webContents.executeJavaScript(`document.querySelector('input').value`), currentQuery);
  report.checks.push('Content find is a separate compact modeless child window with no full Desktop API; reopening reuses it and leaves conversation layout unchanged');
  assert.equal(await js(`CSS.highlights.get('desktop-content-results').size`), 1);
  await closeFind();
  assert.equal(await js(`CSS.highlights.has('desktop-content-results')`), false);
  await find(side, 'SIDE_CONTEXT_OK');
  await until(async () => await count() === '1/1', 'Side content search included the main content or composer');
  writeFileSync(join(data, 'side-content-find.png'), (await host.capturePage()).toPNG());
  writeFileSync(join(data, 'external-content-find.png'), (await popup().webContents.capturePage()).toPNG());
  await closeFind();
  report.checks.push('Cmd/Ctrl+S searches the selected main or /side panel, ignores composers, highlights matches and clears them with Escape');

  await find(main, 'CONTEXT_TOKEN_ALPHA');
  await until(async () => await count() === '1/1', 'External find lost the main scope before the session-search shortcut');
  await key('f', [process.platform === 'darwin' ? 'meta' : 'control']);
  await until(() => js(`document.activeElement?.matches('input.bhn1Oq_searchInput') && document.querySelector('button.bhn1Oq_searchButton')?.getAttribute('aria-expanded')==='true'`), 'Cmd/Ctrl+F no longer opened session search');
  assert.equal(popup(), undefined);
  await key('Escape');
  report.checks.push('Cmd/Ctrl+F from the focused external find window closes it and opens the original left session search');

  const textFile = join(workspace, 'content-search.txt');
  const longSelection = 'literal a+b[0] 中文🙂\n<script>window.__previewExecuted=true</script>\n' + 'unrelated line\n'.repeat(200) + 'literal a+b[0] 中文🙂\n';
  writeFileSync(textFile, longSelection);
  const address = `dsh-resource://file/session/${parentId}/content-search.txt`;
  await js(`window.__dshSideChatTest.get('sidebarRight').openResource(${JSON.stringify(address)})`);
  await until(() => js(`!!document.querySelector('[data-document-preview="text"] pre')`), 'Text preview missing');
  await find('[data-document-preview="text"]', 'a+b[0]');
  await until(async () => await count() === '1/2', 'File search interpreted a literal as a regular expression');
  await key('Enter');
  await until(async () => await count() === '2/2', 'Next match did not navigate to offscreen file text');
  const scrolled = await js(`document.querySelector('[data-textpreview-body]')?.scrollTop ?? document.querySelector('[data-document-preview="text"]').parentElement.scrollTop`);
  assert.ok(scrolled > 0, 'The second match was not scrolled into view');
  await key('Enter', ['shift']);
  await until(async () => await count() === '1/2', 'Previous match did not wrap correctly');
  await closeFind();
  await find('[data-document-preview="text"]', '中文🙂');
  await until(async () => await count() === '1/2', 'Unicode file search failed');
  await closeFind();
  report.checks.push('Opened-file search treats regex characters literally, finds Unicode and offscreen text, and supports Enter / Shift+Enter navigation');
  await setDraft(parentId, 'MAIN_DRAFT_KEEP ');
  await select('[data-document-preview="text"]', longSelection);
  const selectedOriginal = await js('getSelection().toString()');
  assert.ok(longSelection.startsWith(selectedOriginal) && longSelection.length - selectedOriginal.length <= 1, 'The long fixture selection did not cover the original file text');
  await action('添加到主对话');
  const longDraft = await js(`document.querySelector(${JSON.stringify(input(main))}).textContent`);
  const requestCount = requests.length;
  await openPreview(main);
  const excerpt = await js(`document.querySelector(${JSON.stringify(preview + ' [aria-label="原文内容"]')}).textContent`);
  assert.ok(excerpt.length <= 480 && selectedOriginal.startsWith(excerpt) && excerpt.includes('中文🙂'));
  assert.ok(excerpt.length < selectedOriginal.length);
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(preview + ' button')})).find(button=>button.textContent==='展开全文').click()`);
  await until(() => js(`document.querySelector(${JSON.stringify(preview + ' [aria-label="原文内容"]')}).textContent===${JSON.stringify(selectedOriginal)}`), 'Long selected text was lost or changed when expanded');
  assert.equal(await js(`window.__previewExecuted`), undefined, 'Reference markup was executed instead of displayed as text');
  writeFileSync(join(data, 'selected-text-full-preview.png'), (await host.capturePage()).toPNG());
  await js(`Array.from(document.querySelectorAll(${JSON.stringify(preview + ' button')})).find(button=>button.textContent==='收起全文').click()`);
  assert.equal(await js(`document.querySelector(${JSON.stringify(preview + ' [aria-label="原文内容"]')}).textContent`), excerpt);
  await closePreview();
  assert.equal(await js(`document.querySelector(${JSON.stringify(input(main))}).textContent`), longDraft);
  assert.equal(requests.length, requestCount);
  report.checks.push('Long Unicode selections show a beginning excerpt and expand/collapse the exact full original safely as plain text, preserving the draft without submitting');

  const fixtures = join(process.env.DSH_SIDE_CHAT_APP_ROOT, 'tests/fixtures/document-preview');
  copyFileSync(join(fixtures, 'sample.docx'), join(workspace, '搜索文档.docx'));
  await js(`window.__dshSideChatTest.get('sidebarRight').openResource(${JSON.stringify(`dsh-resource://file/session/${parentId}/${encodeURIComponent('搜索文档.docx')}`)})`);
  await until(() => js(`document.querySelector('[data-pdf-preview]')?.innerText.includes('DOCX_PREVIEW_OK')`), 'Default converted Word PDF did not load');
  await find('[data-pdf-preview]', 'DOCX_PREVIEW_OK');
  await until(async () => await count() === '1/1', 'Default converted Word PDF text was not searchable');
  await closeFind();
  await js(`document.querySelector('[data-document-viewer-menu]').click()`);
  await until(() => js(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(item=>item.textContent.trim()==='Word 文档')`), 'Local Word viewer choice missing');
  await js(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(item=>item.textContent.trim()==='Word 文档').click()`);
  await until(() => js(`document.querySelector('[data-office-preview="docx"]')?.dataset.officeStatus==='ready'`), 'Opaque Word frame did not become ready');
  await find('[data-office-preview="docx"]', 'DOCX_PREVIEW_OK');
  await until(async () => await count() === '1/1', 'Opaque Office-frame text was not searchable');
  const channel = await js(`document.querySelector('iframe[data-desktop-office-channel]').dataset.desktopOfficeChannel`);
  const frame = await until(async () => {
    for (const frame of host.mainFrame.framesInSubtree) {
      if (frame === host.mainFrame || frame.detached) continue;
      try { if (await frame.executeJavaScript(`document.documentElement.dataset.channel===${JSON.stringify(channel)}`)) return frame; } catch {}
    }
  }, 'Office frame identity missing');
  assert.equal(await frame.executeJavaScript(`CSS.highlights.get('desktop-content-results').size`), 1);
  assert.equal(await frame.executeJavaScript(`typeof window.dshDesktop`), 'undefined');
  await closeFind();
  assert.equal(await frame.executeJavaScript(`CSS.highlights.get('desktop-content-results').size`), 0);
  report.checks.push('Both converted Office/PDF text and the opaque local Word frame support scoped search; closing clears frame highlights without exposing Desktop APIs');

  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Content find fixture</title><p>native Needle</p><p>native Needle</p>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    await js(`window.__dshSideChatTest.get('sidebarRight').openResource('dsh-resource://web/'+encodeURIComponent(${JSON.stringify(url)}))`);
    const page = await until(() => webContents.getAllWebContents().find(contents => contents.getURL() === url), 'Native browser view did not open');
    await until(() => !page.isLoading(), 'Native browser fixture did not load');
    const nativeFind = [];
    const nativeView = BrowserWindow.fromWebContents(host).contentView.children.find(view => view.webContents?.id === page.id);
    const nativeBounds = nativeView.getBounds();
    page.on('found-in-page', (_event, result) => nativeFind.push(result));
    page.focus();
    page.sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    page.sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
    await findInput('needle');
    assert.deepEqual(nativeView.getBounds(), nativeBounds, 'External find resized or moved the native browser view');
    assert.equal(nativeView.getVisible(), true, 'External find hid the native browser view');
    await until(async () => await count() === '1/2', 'Native view find results were not received').catch(async error => {
      report.nativeFind = { events: nativeFind, ui: await js(`({query:document.querySelector('input[aria-label="搜索当前内容"]')?.value,active:document.activeElement?.outerHTML,browserId:document.querySelector('.desktop-browser')?.dataset.desktopBrowserId,viewport:document.querySelector('.desktop-browser-viewport')?.getBoundingClientRect().toJSON(),root:document.querySelector('[aria-label="查找当前内容"]')?.parentElement?.outerHTML.slice(0,500)})`), text: await page.executeJavaScript('document.body.innerText') };
      throw error;
    });
    await key('Enter');
    await until(async () => await count() === '2/2', 'Native view next match failed');
    await closeFind();
    report.checks.push('Focused native web/file views route Cmd/Ctrl+S to their own panel; isolated Chromium find reports matches and navigates without opening Save');
  } finally { server.closeAllConnections(); server.close(); }
  await js(`window.__dshSideChatTest.get('sideChats').close(${JSON.stringify(parentId)},${JSON.stringify(childId)})`);
  await until(() => js(`!document.querySelector('[data-side-chat-session]')`), 'Side failed to close after content tests');

  const other = await js(`(async()=>{const ctx=window.__dshSideChatTest;const id=await ctx.sessions.create({cwd:${JSON.stringify(workspace)}});const ref=ctx.sessions.retain(id,{source:'controllerOperation'});try{await ref.ready;const result=await ref.binding.session.prompt([{type:'text',text:'OTHER_SESSION_PRIMER'}],'queue');if(!result.ok)throw Error(result.error.message);return id;}finally{ref.release();}})()`);
  await select(main, 'CONTEXT_TOKEN_ALPHA');
  await js(`(()=>{const chats=window.__dshSideChatTest.get('sideChats');const original=chats.open;window.__releaseSelectionSide=null;window.__selectionSideOpened=false;chats.open=async function(...args){await new Promise(resolve=>{window.__releaseSelectionSide=resolve;});try{const entry=await original.apply(this,args);window.__selectionSideOpened=true;return entry;}finally{this.open=original;}};})()`);
  await action('在侧边聊天中提问');
  await until(() => js(`typeof window.__releaseSelectionSide==='function'`), 'Selection race gate did not start');
  await js(`window.__dshSideChatTest.uiWorkspace.openSession(${JSON.stringify(other)})`);
  await until(() => js(`!!document.querySelector('[data-conversation-session="${other}"] [contenteditable="true"]')`), 'Other session composer did not mount');
  await setDraft(other, 'OTHER_DRAFT_KEEP');
  await until(() => js(`document.querySelector('[data-conversation-session="${other}"] [contenteditable="true"]').textContent==='OTHER_DRAFT_KEEP'`), 'The second-session draft was not prepared');
  await js(`window.__releaseSelectionSide()`);
  await until(() => js(`window.__selectionSideOpened && !window.__dshSideChatTest.get('sideChats').getSnapshot()[${JSON.stringify(parentId)}] && window.__dshSideChatTest.get('sideChats').owned.size===0`), 'A superseded selection left a fresh side lease alive');
  assert.equal(await js(`document.querySelector('[data-conversation-session="${other}"] [contenteditable]').textContent`), 'OTHER_DRAFT_KEEP');
  assert.equal(await js(`document.querySelectorAll('[aria-label="选中内容操作"]').length`), 0);
  report.checks.push('Switching main sessions while /side opens cannot attach the captured selection to the new session; its draft stays intact and the fresh unused side is discarded');
};
