import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.join(os.tmpdir(), `cloudshelf-smoke-${Date.now()}`);
const port = 18080 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

await fs.mkdir(dataDir, { recursive: true });

const child = spawn(process.execPath, ['--experimental-sqlite', 'src/server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    ADMIN_PASSWORD: 'cloudshelf',
    SESSION_SECRET: 'smoke-secret'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

try {
  await waitForServer();
  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'cloudshelf' })
  });
  assert(login.ok, 'login failed');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'missing session cookie');

  const folderCreate = await fetch(`${base}/api/folders`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '中文文件夹' })
  });
  assert(folderCreate.ok, 'folder create failed');
  const createdFolder = await folderCreate.json();
  assert(createdFolder.folder.name === '中文文件夹', 'folder name mismatch');

  const form = new FormData();
  const txt = '第一章 云端书架\n\n这是一本中文测试书。明朝的月光落在书页上。\n\n第二章 搜索\n\n全文搜索应该可以找到中文关键词。';
  form.append('folderId', String(createdFolder.folder.id));
  form.append('book', new Blob([txt], { type: 'text/plain;charset=utf-8' }), '中文测试.txt');
  const upload = await fetch(`${base}/api/books`, {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  if (!upload.ok) {
    throw new Error(`upload failed: ${await upload.text()}`);
  }
  const uploaded = await upload.json();
  assert(uploaded.books[0].title === '中文测试', 'book title mismatch');
  assert(uploaded.books[0].folderId === createdFolder.folder.id, 'book folder mismatch');

  const batchForm = new FormData();
  batchForm.append('books', new Blob(['批量一'], { type: 'text/plain;charset=utf-8' }), '批量/第一本.txt');
  batchForm.append('books', new Blob(['批量二'], { type: 'text/plain;charset=utf-8' }), '批量/第二本.txt');
  const batchUpload = await fetch(`${base}/api/books`, {
    method: 'POST',
    headers: { cookie },
    body: batchForm
  });
  assert(batchUpload.ok, 'batch upload failed');
  const batchUploaded = await batchUpload.json();
  assert(batchUploaded.books.length === 2, 'batch upload count mismatch');
  assert(batchUploaded.books.every((book) => book.folderName === '批量'), 'folder upload inference failed');

  const epubPath = path.join(dataDir, 'fixture.epub');
  await createMinimalEpub(epubPath);
  const epubForm = new FormData();
  epubForm.append('book', new Blob([await fs.readFile(epubPath)], { type: 'application/epub+zip' }), '元数据测试.epub');
  const epubUpload = await fetch(`${base}/api/books`, {
    method: 'POST',
    headers: { cookie },
    body: epubForm
  });
  if (!epubUpload.ok) {
    throw new Error(`epub upload failed: ${await epubUpload.text()}`);
  }
  const uploadedEpub = await epubUpload.json();
  const epubBook = uploadedEpub.books[0];
  assert(epubBook.title === '云端阅读测试', 'EPUB title metadata mismatch');
  assert(epubBook.authors.includes('豆包作者'), 'EPUB author metadata mismatch');
  assert(epubBook.language === 'zh-CN', 'EPUB language metadata mismatch');
  assert(epubBook.publisher === 'CloudShelf Press', 'EPUB publisher metadata mismatch');
  const epubSections = await fetch(`${base}/api/books/${epubBook.id}/sections`, {
    headers: { cookie }
  });
  assert(epubSections.ok, 'EPUB sections failed');
  const epubSectionsJson = await epubSections.json();
  assert(epubSectionsJson.toc.length === 2, 'EPUB toc was not parsed');
  assert(epubSectionsJson.toc[1].sectionIndex === 1, 'EPUB toc section index mismatch');

  const search = await fetch(`${base}/api/search?q=${encodeURIComponent('明朝')}`, {
    headers: { cookie }
  });
  assert(search.ok, 'search failed');
  const results = await search.json();
  assert(results.results.length > 0, 'Chinese full-text search returned no results');

  const state = await fetch(`${base}/api/books/${uploaded.books[0].id}/state`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ locator: { sectionIndex: 1 }, progress: 0.5 })
  });
  assert(state.ok, 'state sync failed');

  const patch = await fetch(`${base}/api/books/${uploaded.books[0].id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '改名后的中文测试', folderId: null })
  });
  assert(patch.ok, 'book patch failed');
  const patched = await patch.json();
  assert(patched.book.title === '改名后的中文测试', 'book patch title mismatch');
  assert(patched.book.folderId === null, 'book move to uncategorized failed');

  const deletion = await fetch(`${base}/api/books/${batchUploaded.books[0].id}`, {
    method: 'DELETE',
    headers: { cookie }
  });
  assert(deletion.ok, 'book delete failed');

  const passwordChange = await fetch(`${base}/api/password`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'cloudshelf', newPassword: '123' })
  });
  assert(passwordChange.ok, 'password change failed');

  const oldLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'cloudshelf' })
  });
  assert(!oldLogin.ok, 'old password still works');

  const newLogin = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123' })
  });
  assert(newLogin.ok, 'new password does not work');

  console.log('Smoke test passed');
} finally {
  await stopServer();
  await fs.rm(dataDir, { recursive: true, force: true });
}

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/me`);
      if (res.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`server did not start\n${output}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function createMinimalEpub(targetPath) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile('META-INF/container.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`));
  zip.addFile('OEBPS/content.opf', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0" unique-identifier="bookid" xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">cloudshelf-smoke</dc:identifier>
    <dc:title>云端阅读测试</dc:title>
    <dc:creator>豆包作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>CloudShelf Press</dc:publisher>
    <dc:description>用于验证 EPUB 元数据读取。</dc:description>
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
    <itemref idref="chapter2"/>
  </spine>
</package>`));
  zip.addFile('OEBPS/nav.xhtml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
  <body>
    <nav epub:type="toc">
      <ol>
        <li><a href="chapter1.xhtml">第一章 云端</a></li>
        <li><a href="chapter2.xhtml">第二章 目录</a></li>
      </ol>
    </nav>
  </body>
</html>`));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>第一章</title></head>
  <body><h1>第一章</h1><p>这是一段 EPUB 中文正文，适合云端同步阅读。</p></body>
</html>`));
  zip.addFile('OEBPS/chapter2.xhtml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN">
  <head><title>第二章</title></head>
  <body><h1>第二章</h1><p>目录应该可以跳到这一章。</p></body>
</html>`));
  await fs.writeFile(targetPath, zip.toBuffer());
}

function stopServer() {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', resolve);
    child.kill();
    setTimeout(resolve, 2000);
  });
}
