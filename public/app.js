const app = document.querySelector('#app');

const defaultSettings = {
  fontSize: 19,
  lineHeight: 1.8,
  letterSpacing: 0,
  verticalMargin: 32,
  horizontalMargin: 32,
  fontFamily: '"Noto Serif SC", "Songti SC", serif',
  background: '#f7f4ed',
  textColor: '#24211d',
  leftHand: false,
  reverseTap: false,
  readingMode: 'scroll'
};

const state = {
  authed: false,
  books: [],
  folders: [],
  activeFolderId: 'all',
  query: '',
  results: [],
  currentBook: null,
  sections: [],
  toc: [],
  settings: { ...defaultSettings },
  sectionIndex: 0,
  pageIndex: 0,
  pageCount: 1,
  touchStart: null,
  suppressTapUntil: 0
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body instanceof FormData ? {} : { 'content-type': 'application/json' },
    ...options,
    body: options.body instanceof FormData ? options.body : options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || data || '请求失败');
  return data;
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatAuthors(book) {
  return book.authors?.length ? book.authors.join('、') : '未知作者';
}

async function init() {
  const me = await api('/api/me');
  state.authed = me.authenticated;
  if (state.authed) {
    await Promise.all([loadFolders(), loadBooks(), loadSettings()]);
  }
  render();
}

async function loadBooks() {
  const folderQuery = state.activeFolderId === 'all' ? '' : `?folderId=${encodeURIComponent(state.activeFolderId)}`;
  const data = await api(`/api/books${folderQuery}`);
  state.books = data.books;
}

async function loadFolders() {
  const data = await api('/api/folders');
  state.folders = data.folders;
}

async function refreshLibrary() {
  await Promise.all([loadFolders(), loadBooks()]);
}

async function loadSettings() {
  const data = await api('/api/settings');
  state.settings = normalizeSettings({ ...defaultSettings, ...data.settings });
}

async function saveSettings() {
  await api('/api/settings', { method: 'PUT', body: state.settings });
}

function render() {
  if (!state.authed) {
    renderLogin();
    return;
  }

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <strong>CloudShelf</strong>
          <span>私有云阅读器</span>
        </div>
        <div class="toolbar">
          <input class="searchbox" placeholder="搜索书名、作者或全文" value="${escapeHtml(state.query)}" />
          <button class="new-folder-btn">新建文件夹</button>
          <button class="upload-folder-btn">上传文件夹</button>
          <button class="primary upload-btn">上传图书</button>
          <button class="change-password-btn">修改密码</button>
          <button class="logout-btn" title="退出登录">退出</button>
          <input class="file-input" type="file" accept=".epub,.txt" multiple hidden />
          <input class="folder-input" type="file" accept=".epub,.txt" multiple webkitdirectory directory hidden />
        </div>
      </header>
      <main class="main library-layout">
        ${renderFolders()}
        <section class="library-pane">
          <div class="notice"></div>
          ${state.results.length ? renderResults() : ''}
          ${state.books.length ? renderLibrary() : '<div class="empty">这个位置还没有图书，可以上传 EPUB/TXT 或选择一个文件夹批量上传。</div>'}
        </section>
      </main>
    </div>
  `;

  app.querySelector('.searchbox').addEventListener('input', debounce(onSearch, 250));
  app.querySelector('.upload-btn').addEventListener('click', () => app.querySelector('.file-input').click());
  app.querySelector('.upload-folder-btn').addEventListener('click', () => app.querySelector('.folder-input').click());
  app.querySelector('.file-input').addEventListener('change', (event) => onUpload(event, false));
  app.querySelector('.folder-input').addEventListener('change', (event) => onUpload(event, true));
  app.querySelector('.new-folder-btn').addEventListener('click', createFolder);
  app.querySelector('.change-password-btn').addEventListener('click', changePassword);
  app.querySelector('.logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    state.authed = false;
    render();
  });

  app.querySelectorAll('[data-folder]').forEach((node) => {
    node.addEventListener('click', async () => {
      state.activeFolderId = node.dataset.folder;
      await loadBooks();
      state.results = [];
      state.query = '';
      render();
    });
  });

  app.querySelectorAll('[data-open-book]').forEach((node) => {
    node.addEventListener('click', () => openBook(Number(node.dataset.openBook)));
  });
  app.querySelectorAll('[data-edit-book]').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      editBook(Number(node.dataset.editBook));
    });
  });
  app.querySelectorAll('[data-move-book]').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      moveBook(Number(node.dataset.moveBook));
    });
  });
  app.querySelectorAll('[data-delete-book]').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteBook(Number(node.dataset.deleteBook));
    });
  });
  app.querySelectorAll('[data-result-book]').forEach((node) => {
    node.addEventListener('click', () => openBook(Number(node.dataset.resultBook), Number(node.dataset.sectionIndex)));
  });
}

function renderFolders() {
  const uncategorized = state.books.filter((book) => !book.folderId).length;
  return `
    <aside class="folder-sidebar">
      <button class="${state.activeFolderId === 'all' ? 'active' : ''}" data-folder="all">
        <span>全部图书</span><small>${state.folders.reduce((sum, folder) => sum + folder.bookCount, 0) + uncategorized}</small>
      </button>
      <button class="${state.activeFolderId === 'none' ? 'active' : ''}" data-folder="none">
        <span>未分类</span><small>${uncategorized}</small>
      </button>
      ${state.folders.map((folder) => `
        <button class="${String(state.activeFolderId) === String(folder.id) ? 'active' : ''}" data-folder="${folder.id}">
          <span>${escapeHtml(folder.name)}</span><small>${folder.bookCount}</small>
        </button>
      `).join('')}
    </aside>
  `;
}

function renderLogin() {
  app.innerHTML = `
    <main class="login">
      <form class="login-panel">
        <h1>CloudShelf</h1>
        <p>输入密码后访问你的私有书库。默认账号是 admin。</p>
        <label>
          <span>用户名</span>
          <input name="username" value="admin" autocomplete="username" />
        </label>
        <label>
          <span>密码</span>
          <input name="password" type="password" autocomplete="current-password" autofocus />
        </label>
        <button class="primary" type="submit">登录</button>
        <div class="notice"></div>
      </form>
    </main>
  `;

  app.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api('/api/login', {
        method: 'POST',
        body: { username: form.get('username'), password: form.get('password') }
      });
      state.authed = true;
      await Promise.all([loadFolders(), loadBooks(), loadSettings()]);
      render();
    } catch (error) {
      app.querySelector('.notice').textContent = error.message;
    }
  });
}

function renderLibrary() {
  return `
    <section class="library">
      ${state.books.map((book) => `
        <article class="book-card" data-open-book="${book.id}">
          <div class="cover">
            ${book.coverUrl ? `<img src="${book.coverUrl}" alt="${escapeHtml(book.title)} 封面" loading="lazy" />` : `<span>${escapeHtml(book.title)}</span>`}
          </div>
          <div class="book-meta">
            <div class="book-title">${escapeHtml(book.title)}</div>
            <div class="book-sub">
              <span>${escapeHtml(formatAuthors(book))}</span>
              <span>${book.format.toUpperCase()}</span>
            </div>
            <div class="book-folder">${escapeHtml(book.folderName || '未分类')}</div>
            <div class="book-actions">
              <button data-edit-book="${book.id}">编辑</button>
              <button data-move-book="${book.id}">移动</button>
              <button data-delete-book="${book.id}">删除</button>
            </div>
            <div class="progress"><span style="width: ${percent(book.state.progress)}"></span></div>
          </div>
        </article>
      `).join('')}
    </section>
  `;
}

function renderResults() {
  return `
    <section class="results">
      ${state.results.map((item) => `
        <article class="result" data-result-book="${item.bookId}" data-section-index="${item.sectionIndex}">
          <strong>${escapeHtml(item.bookTitle)} · ${escapeHtml(item.sectionTitle)}</strong>
          <p>${escapeHtml(item.excerpt)}</p>
        </article>
      `).join('')}
    </section>
  `;
}

async function onSearch(event) {
  state.query = event.target.value.trim();
  if (!state.query) {
    state.results = [];
    render();
    return;
  }
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(state.query)}`);
    state.results = data.results;
    render();
  } catch (error) {
    app.querySelector('.notice').textContent = error.message;
  }
}

async function onUpload(event, isFolderUpload) {
  const files = [...(event.target.files || [])].filter((file) => /\.(epub|txt)$/i.test(file.name));
  if (!files.length) return;
  const notice = app.querySelector('.notice');
  notice.textContent = `正在上传 ${files.length} 本书并建立索引...`;
  const form = new FormData();
  if (!isFolderUpload && state.activeFolderId !== 'all' && state.activeFolderId !== 'none') {
    form.append('folderId', state.activeFolderId);
  }
  for (const file of files) {
    form.append('books', file, file.webkitRelativePath || file.name);
  }
  try {
    const result = await api('/api/books', { method: 'POST', body: form });
    await refreshLibrary();
    state.results = [];
    state.query = '';
    render();
    const uploaded = result.books?.length || 0;
    const failed = result.errors?.length || 0;
    if (failed) {
      app.querySelector('.notice').textContent = `已上传 ${uploaded} 本，${failed} 本失败。`;
    }
  } catch (error) {
    notice.textContent = error.message;
  } finally {
    event.target.value = '';
  }
}

async function createFolder() {
  const name = prompt('文件夹名称');
  if (!name?.trim()) return;
  await api('/api/folders', { method: 'POST', body: { name } });
  await refreshLibrary();
  render();
}

async function changePassword() {
  const currentPassword = prompt('当前密码');
  if (currentPassword == null) return;
  const newPassword = prompt('新密码');
  if (newPassword == null) return;
  const confirmPassword = prompt('再次输入新密码');
  if (confirmPassword == null) return;
  if (newPassword !== confirmPassword) {
    alert('两次输入的新密码不一致');
    return;
  }
  try {
    await api('/api/password', {
      method: 'PUT',
      body: { currentPassword, newPassword }
    });
    alert('密码已修改。其他已登录设备会失效。');
  } catch (error) {
    alert(error.message);
  }
}

async function editBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;
  const title = prompt('书名', book.title);
  if (title == null) return;
  const authors = prompt('作者，多个作者用顿号或逗号分隔', formatAuthors(book) === '未知作者' ? '' : formatAuthors(book));
  if (authors == null) return;
  await api(`/api/books/${bookId}`, {
    method: 'PATCH',
    body: { title, authors }
  });
  await refreshLibrary();
  render();
}

async function moveBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book) return;
  const choices = ['0: 未分类', ...state.folders.map((folder) => `${folder.id}: ${folder.name}`)];
  const input = prompt(`移动到哪个文件夹？\n${choices.join('\n')}`, book.folderId || '0');
  if (input == null) return;
  const folderId = Number(String(input).split(':')[0].trim());
  await api(`/api/books/${bookId}`, {
    method: 'PATCH',
    body: { folderId: folderId ? folderId : null }
  });
  await refreshLibrary();
  render();
}

async function deleteBook(bookId) {
  const book = state.books.find((item) => item.id === bookId);
  if (!book || !confirm(`确定删除《${book.title}》吗？这个操作会删除服务器上的图书文件。`)) return;
  await api(`/api/books/${bookId}`, { method: 'DELETE' });
  await refreshLibrary();
  render();
}

async function openBook(bookId, sectionIndex = null) {
  const book = state.books.find((item) => item.id === bookId) || (await api(`/api/books/${bookId}`)).book;
  const data = await api(`/api/books/${bookId}/sections`);
  state.currentBook = book;
  state.sections = data.sections;
  state.toc = data.toc?.length ? data.toc : data.sections.map((section) => ({
    title: section.title,
    href: section.href,
    sectionIndex: section.section_index
  }));
  const saved = book.state.locator;
  const savedIndex = typeof saved === 'object' ? Number(saved.sectionIndex || 0) : 0;
  const savedPage = typeof saved === 'object' ? Number(saved.pageIndex || 0) : 0;
  state.sectionIndex = Number.isInteger(sectionIndex) ? sectionIndex : savedIndex;
  state.pageIndex = Number.isInteger(sectionIndex) ? 0 : savedPage;
  renderReader();
  mountSectionReader();
}

function renderReader() {
  const settings = normalizeSettings(state.settings);
  state.settings = settings;
  app.insertAdjacentHTML('beforeend', `
    <section class="reader ${settings.leftHand ? 'left-hand' : ''} ${settings.reverseTap ? 'reverse-tap' : ''} mode-${settings.readingMode}" style="${readerStyle(settings)}">
      <header class="reader-header">
        <button class="icon close-reader" title="返回书库">←</button>
        <button class="icon toc-toggle" title="目录">☰</button>
        <div class="reader-title">${escapeHtml(state.currentBook.title)}</div>
        <button class="settings-toggle" title="阅读设置">设置</button>
      </header>
      <div class="reader-body">
        <aside class="toc-panel" hidden>
          <div class="toc-head">目录</div>
          <div class="toc-list">
            ${state.toc.map((item) => `<button data-toc-index="${item.sectionIndex}">${escapeHtml(item.title)}</button>`).join('')}
          </div>
        </aside>
        <aside class="settings-panel" hidden>
          <div class="settings-head">
            <strong>阅读设置</strong>
            <button class="icon settings-close" title="关闭设置">×</button>
          </div>
          <div class="settings-form">
            <label>
              <span>阅读模式</span>
              <select class="reading-mode">
                <option value="scroll" ${settings.readingMode === 'scroll' ? 'selected' : ''}>滚动</option>
                <option value="page" ${settings.readingMode === 'page' ? 'selected' : ''}>左右翻页</option>
              </select>
            </label>
            <label>
              <span>字号</span>
              <input class="font-size-input" type="number" min="12" max="40" step="1" value="${settings.fontSize}" />
            </label>
            <label>
              <span>字距</span>
              <input class="letter-spacing" type="number" min="0" max="12" step="0.5" value="${settings.letterSpacing}" />
            </label>
            <label>
              <span>上下边距</span>
              <input class="vertical-margin" type="number" min="0" max="160" step="4" value="${settings.verticalMargin}" />
            </label>
            <label>
              <span>左右边距</span>
              <input class="horizontal-margin" type="number" min="0" max="160" step="4" value="${settings.horizontalMargin}" />
            </label>
            <label>
              <span>背景</span>
              <input class="bg-color" type="color" value="${settings.background}" />
            </label>
            <label>
              <span>文字</span>
              <input class="text-color" type="color" value="${settings.textColor}" />
            </label>
            <button class="left-hand-toggle ${settings.leftHand ? 'primary' : ''}" title="左手模式">左手模式</button>
            <button class="reverse-tap-toggle ${settings.reverseTap ? 'primary' : ''}" title="点击左右区域反向翻页">反向点击</button>
          </div>
        </aside>
        <div class="tap-zone prev" title="上一页"></div>
        <div class="tap-zone next" title="下一页"></div>
        <div class="txt-reader"><article></article></div>
      </div>
      <footer class="reader-footer">
        <button class="prev-page">上一页</button>
        <span class="reader-progress">${percent(state.currentBook.state.progress)}</span>
        <button class="next-page">下一页</button>
      </footer>
    </section>
  `);

  const reader = app.querySelector('.reader');
  reader.querySelector('.close-reader').addEventListener('click', closeReader);
  reader.querySelector('.toc-toggle').addEventListener('click', toggleToc);
  reader.querySelector('.settings-toggle').addEventListener('click', toggleSettings);
  reader.querySelector('.settings-close').addEventListener('click', () => toggleSettings(false));
  reader.querySelector('.reading-mode').addEventListener('change', (event) => updateReaderSetting('readingMode', event.target.value, true));
  reader.querySelector('.font-size-input').addEventListener('change', (event) => updateReaderSetting('fontSize', clampNumber(event.target.value, 12, 40), true));
  reader.querySelector('.letter-spacing').addEventListener('change', (event) => updateReaderSetting('letterSpacing', clampNumber(event.target.value, 0, 12), true));
  reader.querySelector('.vertical-margin').addEventListener('change', (event) => updateReaderSetting('verticalMargin', clampNumber(event.target.value, 0, 160), true));
  reader.querySelector('.horizontal-margin').addEventListener('change', (event) => updateReaderSetting('horizontalMargin', clampNumber(event.target.value, 0, 160), true));
  reader.querySelector('.bg-color').addEventListener('input', (event) => updateReaderSetting('background', event.target.value));
  reader.querySelector('.text-color').addEventListener('input', (event) => updateReaderSetting('textColor', event.target.value));
  reader.querySelector('.left-hand-toggle').addEventListener('click', () => updateReaderSetting('leftHand', !state.settings.leftHand));
  reader.querySelector('.reverse-tap-toggle').addEventListener('click', () => updateReaderSetting('reverseTap', !state.settings.reverseTap));
  reader.querySelector('.prev-page').addEventListener('click', previousPage);
  reader.querySelector('.next-page').addEventListener('click', nextPage);
  reader.querySelector('.tap-zone.prev').addEventListener('click', () => handleTapPage('prev'));
  reader.querySelector('.tap-zone.next').addEventListener('click', () => handleTapPage('next'));
  reader.querySelector('.reader-body').addEventListener('touchstart', handleReaderTouchStart, { passive: true });
  reader.querySelector('.reader-body').addEventListener('touchend', handleReaderTouchEnd);
  reader.querySelector('.reader-body').addEventListener('touchcancel', () => {
    state.touchStart = null;
  });
  reader.querySelectorAll('[data-toc-index]').forEach((node) => {
    node.addEventListener('click', () => jumpToSection(Number(node.dataset.tocIndex)));
  });
  window.addEventListener('resize', debouncedPaginate);
}

function readerStyle(settings) {
  return [
    `--reader-bg:${settings.background}`,
    `--reader-text:${settings.textColor}`,
    `--reader-font-size:${settings.fontSize}px`,
    `--reader-line-height:${settings.lineHeight}`,
    `--reader-font-family:${settings.fontFamily}`,
    `--reader-letter-spacing:${settings.letterSpacing}px`,
    `--reader-vertical-margin:${settings.verticalMargin}px`,
    `--reader-horizontal-margin:${settings.horizontalMargin}px`,
    `--reader-page-gap:${settings.horizontalMargin + 64}px`
  ].join(';');
}

function mountSectionReader() {
  renderSection();
}

function renderSection() {
  const section = state.sections[state.sectionIndex] || state.sections[0];
  const article = app.querySelector('.txt-reader article');
  article.textContent = `${section.title}\n\n${section.text}`;
  app.querySelector('.txt-reader').scrollTop = 0;
  state.pageIndex = Math.max(0, state.pageIndex);
  paginateCurrentSection();
  saveCurrentProgress();
}

function paginateCurrentSection() {
  const reader = app.querySelector('.txt-reader');
  if (!reader) return;
  if (state.settings.readingMode !== 'page') {
    reader.style.removeProperty('--reader-page-index');
    reader.style.removeProperty('--reader-page-width');
    reader.style.removeProperty('--reader-page-stride');
    state.pageCount = 1;
    state.pageIndex = 0;
    return;
  }

  const article = reader.querySelector('article');
  reader.style.setProperty('--reader-page-index', state.pageIndex);
  const computedReaderStyle = getComputedStyle(reader);
  const horizontalPadding = parseFloat(computedReaderStyle.paddingLeft) + parseFloat(computedReaderStyle.paddingRight);
  const pageWidth = Math.max(1, reader.clientWidth - horizontalPadding);
  const pageStride = pageWidth + parseFloat(computedReaderStyle.columnGap || 0);
  reader.style.setProperty('--reader-page-width', `${pageWidth}px`);
  reader.style.setProperty('--reader-page-stride', `${pageStride}px`);
  state.pageCount = Math.max(1, Math.ceil(article.scrollWidth / pageStride));
  state.pageIndex = Math.max(0, Math.min(state.pageIndex, state.pageCount - 1));
  reader.style.setProperty('--reader-page-index', state.pageIndex);
}

function previousPage() {
  if (state.settings.readingMode === 'page' && state.pageIndex > 0) {
    state.pageIndex -= 1;
    paginateCurrentSection();
    saveCurrentProgress();
    return;
  }
  state.sectionIndex = Math.max(0, state.sectionIndex - 1);
  state.pageIndex = 0;
  renderSection();
}

function nextPage() {
  if (state.settings.readingMode === 'page' && state.pageIndex < state.pageCount - 1) {
    state.pageIndex += 1;
    paginateCurrentSection();
    saveCurrentProgress();
    return;
  }
  state.sectionIndex = Math.min(state.sections.length - 1, state.sectionIndex + 1);
  state.pageIndex = 0;
  renderSection();
}

function handleTapPage(zone) {
  if (Date.now() < state.suppressTapUntil) return;
  if (state.settings.reverseTap) {
    zone === 'prev' ? nextPage() : previousPage();
    return;
  }
  zone === 'prev' ? previousPage() : nextPage();
}

function handleReaderTouchStart(event) {
  if (state.settings.readingMode !== 'page' || event.touches.length !== 1) return;
  const touch = event.touches[0];
  state.touchStart = {
    x: touch.clientX,
    y: touch.clientY,
    time: Date.now()
  };
}

function handleReaderTouchEnd(event) {
  if (state.settings.readingMode !== 'page' || !state.touchStart || event.changedTouches.length !== 1) return;
  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - state.touchStart.x;
  const deltaY = touch.clientY - state.touchStart.y;
  const elapsed = Date.now() - state.touchStart.time;
  state.touchStart = null;
  if (elapsed > 800 || Math.abs(deltaX) < 42 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return;
  state.suppressTapUntil = Date.now() + 350;
  deltaX < 0 ? nextPage() : previousPage();
}

function jumpToSection(index) {
  state.sectionIndex = Math.max(0, Math.min(state.sections.length - 1, index));
  state.pageIndex = 0;
  toggleToc(false);
  renderSection();
}

function saveCurrentProgress() {
  const sectionBase = state.sections.length <= 1 ? 0 : state.sectionIndex / state.sections.length;
  const pagePart = state.settings.readingMode === 'page' && state.pageCount > 1
    ? state.pageIndex / state.pageCount / Math.max(1, state.sections.length)
    : 0;
  const progress = Math.min(1, sectionBase + pagePart);
  saveBookState({ sectionIndex: state.sectionIndex, pageIndex: state.pageIndex }, progress);
}

async function saveBookState(locator, progress) {
  app.querySelector('.reader-progress').textContent = percent(progress);
  const book = state.currentBook;
  book.state = { locator, progress };
  await api(`/api/books/${book.id}/state`, { method: 'PUT', body: { locator, progress } });
}

function updateReaderSetting(key, value, rerender = false) {
  state.settings[key] = value;
  state.settings = normalizeSettings(state.settings);
  const reader = app.querySelector('.reader');
  reader.setAttribute('style', readerStyle(state.settings));
  reader.classList.toggle('left-hand', state.settings.leftHand);
  reader.classList.toggle('reverse-tap', state.settings.reverseTap);
  reader.classList.toggle('mode-page', state.settings.readingMode === 'page');
  reader.classList.toggle('mode-scroll', state.settings.readingMode !== 'page');
  reader.querySelector('.left-hand-toggle').classList.toggle('primary', state.settings.leftHand);
  reader.querySelector('.reverse-tap-toggle').classList.toggle('primary', state.settings.reverseTap);
  reader.querySelector('.reading-mode').value = state.settings.readingMode;
  reader.querySelector('.font-size-input').value = state.settings.fontSize;
  reader.querySelector('.letter-spacing').value = state.settings.letterSpacing;
  reader.querySelector('.vertical-margin').value = state.settings.verticalMargin;
  reader.querySelector('.horizontal-margin').value = state.settings.horizontalMargin;
  if (rerender) {
    state.pageIndex = 0;
    requestAnimationFrame(() => {
      paginateCurrentSection();
      saveCurrentProgress();
    });
  }
  saveSettings();
}

function toggleToc(force) {
  const panel = app.querySelector('.toc-panel');
  const nextHidden = typeof force === 'boolean' ? !force : !panel.hidden;
  if (!nextHidden) {
    toggleSettings(false);
  }
  panel.hidden = nextHidden;
}

function toggleSettings(force) {
  const panel = app.querySelector('.settings-panel');
  const nextHidden = typeof force === 'boolean' ? !force : !panel.hidden;
  if (!nextHidden) {
    toggleToc(false);
  }
  panel.hidden = nextHidden;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeSettings(settings) {
  const fallbackMargin = Number.isFinite(Number(settings.pageMargin)) ? Number(settings.pageMargin) : defaultSettings.horizontalMargin;
  return {
    ...defaultSettings,
    ...settings,
    verticalMargin: clampNumber(settings.verticalMargin ?? fallbackMargin, 0, 160),
    horizontalMargin: clampNumber(settings.horizontalMargin ?? fallbackMargin, 0, 160),
    leftHand: Boolean(settings.leftHand),
    reverseTap: Boolean(settings.reverseTap)
  };
}

async function closeReader() {
  window.removeEventListener('resize', debouncedPaginate);
  app.querySelector('.reader')?.remove();
  await refreshLibrary();
  render();
}

const debouncedPaginate = debounce(() => {
  if (!app.querySelector('.reader')) return;
  paginateCurrentSection();
  saveCurrentProgress();
}, 200);

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

init().catch((error) => {
  app.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});
