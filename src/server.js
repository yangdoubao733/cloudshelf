import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import Busboy from 'busboy';
import bcrypt from 'bcryptjs';
import cookie from 'cookie';
import mime from 'mime-types';
import iconv from 'iconv-lite';
import { parseEpub } from './epub.js';
import { createFtsQuery, createSearchText, excerpt, normalizeText, splitTxtIntoSections } from './text.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const booksDir = path.join(dataDir, 'books');
const coversDir = path.join(dataDir, 'covers');
const dbPath = path.join(dataDir, 'cloudshelf.db');
const port = Number(process.env.PORT || 8080);
const adminPassword = process.env.ADMIN_PASSWORD || 'cloudshelf';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const isProduction = process.env.NODE_ENV === 'production';
const trustProxy = process.env.TRUST_PROXY === '1';
const forceSecureCookies = process.env.COOKIE_SECURE === '1';
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 200);

if (isProduction && adminPassword === 'cloudshelf') {
  throw new Error('ADMIN_PASSWORD must be changed before running in production.');
}

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set before running in production.');
}

await fsp.mkdir(booksDir, { recursive: true });
await fsp.mkdir(coversDir, { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY,
    folder_id INTEGER,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '[]',
    format TEXT NOT NULL,
    language TEXT DEFAULT '',
    publisher TEXT DEFAULT '',
    description TEXT DEFAULT '',
    file_path TEXT NOT NULL,
    cover_path TEXT DEFAULT '',
    size INTEGER NOT NULL,
    section_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL,
    section_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    href TEXT DEFAULT '',
    text TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS table_of_contents (
    id INTEGER PRIMARY KEY,
    book_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    href TEXT DEFAULT '',
    section_index INTEGER NOT NULL,
    sort_order INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS section_fts USING fts5(
    title,
    body,
    book_id UNINDEXED,
    section_id UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
  );

  CREATE TABLE IF NOT EXISTS reading_state (
    book_id INTEGER PRIMARY KEY,
    locator TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

ensureColumn('books', 'folder_id', 'INTEGER');

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
if (userCount === 0) {
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('admin', bcrypt.hashSync(adminPassword, 12), new Date().toISOString());
  console.log('CloudShelf admin user created. Username: admin');
}

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...headers });
  if (body && typeof body.pipe === 'function') {
    body.pipe(res);
    return;
  }
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { ...jsonHeaders, ...headers });
}

function isSecureRequest(req) {
  if (forceSecureCookies) return true;
  if (!trustProxy) return false;
  return req.headers['x-forwarded-proto'] === 'https';
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 30;
  db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(id, userId, expiresAt);
  return `${id}.${sign(id)}`;
}

function getSession(req) {
  const cookies = cookie.parse(req.headers.cookie || '');
  const token = cookies.cloudshelf_session;
  if (!token) return null;
  const [id, signature] = token.split('.');
  if (!id || signature !== sign(id)) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, Date.now());
  return session || null;
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: '需要登录' });
    return null;
  }
  return session;
}

function bookRowToDto(row, includeState = true) {
  const state = includeState
    ? db.prepare('SELECT locator, progress, updated_at FROM reading_state WHERE book_id = ?').get(row.id)
    : null;
  const parsedState = state
    ? { ...state, locator: safeJsonParse(state.locator, '') }
    : { locator: '', progress: 0, updated_at: '' };
  return {
    id: row.id,
    folderId: row.folder_id || null,
    folderName: row.folder_name || '',
    title: row.title,
    authors: JSON.parse(row.authors || '[]'),
    format: row.format,
    language: row.language || '',
    publisher: row.publisher || '',
    description: row.description || '',
    coverUrl: row.cover_path ? `/api/books/${row.id}/cover` : '',
    size: row.size,
    sectionCount: row.section_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    state: parsedState
  };
}

function folderRowToDto(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    bookCount: row.book_count || 0
  };
}

function getOrCreateFolder(name) {
  const normalized = normalizeText(name);
  if (!normalized) return null;
  const existing = db.prepare('SELECT id FROM folders WHERE name = ?').get(normalized);
  if (existing) return existing.id;
  const now = new Date().toISOString();
  const result = db.prepare('INSERT INTO folders (name, created_at, updated_at) VALUES (?, ?, ?)').run(normalized, now, now);
  return Number(result.lastInsertRowid);
}

function inferFolderName(file) {
  const raw = file.relativePath || file.filename || '';
  const normalized = String(raw).replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '';
}

function deleteFileQuietly(filePath) {
  if (!filePath) return;
  fsp.rm(filePath, { force: true }).catch(() => {});
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function decodeTxt(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return iconv.decode(buffer, 'utf16-le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return iconv.decode(buffer, 'utf16-be');
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return iconv.decode(buffer, 'utf8');
  const utf8 = iconv.decode(buffer, 'utf8');
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementCount > Math.max(3, utf8.length * 0.01)) return iconv.decode(buffer, 'gb18030');
  return utf8;
}

function insertSections(bookId, sections, toc = []) {
  const insertSection = db.prepare(`
    INSERT INTO sections (book_id, section_index, title, href, text)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    INSERT INTO section_fts (title, body, book_id, section_id)
    VALUES (?, ?, ?, ?)
  `);
  const insertToc = db.prepare(`
    INSERT INTO table_of_contents (book_id, title, href, section_index, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  db.prepare('DELETE FROM sections WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM section_fts WHERE book_id = ?').run(bookId);
  db.prepare('DELETE FROM table_of_contents WHERE book_id = ?').run(bookId);

  sections.forEach((section, index) => {
    const result = insertSection.run(bookId, index, section.title || `章节 ${index + 1}`, section.href || '', section.text || '');
    const sectionId = Number(result.lastInsertRowid);
    insertFts.run(
      createSearchText(section.title || ''),
      createSearchText(section.text || ''),
      bookId,
      sectionId
    );
  });

  const finalToc = toc.length
    ? toc
    : sections.map((section, index) => ({ title: section.title || `章节 ${index + 1}`, href: section.href || '', sectionIndex: index }));

  finalToc.forEach((item, index) => {
    const sectionIndex = Math.max(0, Math.min(sections.length - 1, Number(item.sectionIndex) || 0));
    insertToc.run(bookId, item.title || `章节 ${sectionIndex + 1}`, item.href || '', sectionIndex, index);
  });

  db.prepare('UPDATE books SET section_count = ?, updated_at = ? WHERE id = ?')
    .run(sections.length, new Date().toISOString(), bookId);
}

async function saveUploadedBook(file, options = {}) {
  const ext = path.extname(file.filename).toLowerCase();
  if (!['.epub', '.txt'].includes(ext)) {
    throw new Error('仅支持 EPUB 和 TXT 文件');
  }

  const inferredFolder = inferFolderName(file);
  const folderId = options.folderId
    || getOrCreateFolder(options.folderName || inferredFolder)
    || null;

  const idName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const targetPath = path.join(booksDir, idName);
  await fsp.rename(file.path, targetPath);

  const stat = await fsp.stat(targetPath);
  const now = new Date().toISOString();
  let metadata = {
    title: path.basename(file.filename, ext),
    authors: [],
    language: '',
    publisher: '',
    description: ''
  };
  let sections = [];
  let toc = [];
  let coverPath = '';

  if (ext === '.epub') {
    const parsed = parseEpub(targetPath);
    metadata = { ...metadata, ...parsed.metadata };
    sections = parsed.sections;
    toc = parsed.toc || [];
    if (parsed.cover) {
      const coverExt = mime.extension(parsed.cover.mime) || 'jpg';
      const coverName = `${path.basename(idName, ext)}.${coverExt}`;
      coverPath = path.join(coversDir, coverName);
      await fsp.writeFile(coverPath, parsed.cover.data);
    }
  } else {
    const buffer = await fsp.readFile(targetPath);
    const text = decodeTxt(buffer);
    sections = splitTxtIntoSections(text);
  }

  const result = db.prepare(`
    INSERT INTO books (folder_id, title, authors, format, language, publisher, description, file_path, cover_path, size, section_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    folderId,
    normalizeText(metadata.title) || path.basename(file.filename, ext),
    JSON.stringify(metadata.authors || []),
    ext.slice(1),
    metadata.language || '',
    metadata.publisher || '',
    metadata.description || '',
    targetPath,
    coverPath,
    stat.size,
    0,
    now,
    now
  );

  const bookId = Number(result.lastInsertRowid);
  insertSections(bookId, sections, toc);
  return db.prepare(`
    SELECT books.*, folders.name AS folder_name
    FROM books
    LEFT JOIN folders ON folders.id = books.folder_id
    WHERE books.id = ?
  `).get(bookId);
}

function handleUpload(req, res) {
  const busboy = Busboy({
    headers: req.headers,
    defParamCharset: 'utf8',
    preservePath: true,
    limits: { fileSize: maxUploadMb * 1024 * 1024, files: 500 }
  });
  const pending = [];
  const fields = {};
  let uploadError;

  busboy.on('file', (name, file, info) => {
    const filename = path.basename(info.filename || 'book');
    const relativePath = info.filename || filename;
    const tempPath = path.join(dataDir, `${crypto.randomBytes(12).toString('hex')}.upload`);
    const stream = fs.createWriteStream(tempPath);
    file.pipe(stream);
    pending.push(new Promise((resolve, reject) => {
      stream.on('finish', () => resolve({ path: tempPath, filename }));
      stream.on('error', reject);
      file.on('limit', () => reject(new Error(`文件太大，最大支持 ${maxUploadMb}MB`)));
    }).then((item) => ({ ...item, relativePath })));
  });

  busboy.on('field', (name, value) => {
    fields[name] = value;
  });

  busboy.on('error', (error) => {
    uploadError = error;
  });

  busboy.on('finish', async () => {
    try {
      if (uploadError) throw uploadError;
      if (!pending.length) throw new Error('没有收到文件');
      const folderId = fields.folderId ? Number(fields.folderId) : null;
      const folderName = fields.folderName || '';
      const files = await Promise.all(pending);
      const books = [];
      const errors = [];
      for (const file of files) {
        try {
          const row = await saveUploadedBook(file, { folderId, folderName });
          books.push(bookRowToDto(row));
        } catch (error) {
          errors.push({ filename: file.filename, error: error.message || '上传失败' });
          await fsp.rm(file.path, { force: true });
        }
      }
      sendJson(res, errors.length ? 207 : 201, { books, errors });
    } catch (error) {
      sendJson(res, 400, { error: error.message || '上传失败' });
    }
  });

  req.pipe(busboy);
}

function routeApi(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    parseBody(req)
      .then(({ username = 'admin', password = '' }) => {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
          sendJson(res, 401, { error: '用户名或密码错误' });
          return;
        }
        const token = createSession(user.id);
        sendJson(res, 200, { ok: true, username: user.username }, {
          'set-cookie': cookie.serialize('cloudshelf_session', token, {
            httpOnly: true,
            sameSite: 'lax',
            secure: isSecureRequest(req),
            path: '/',
            maxAge: 60 * 60 * 24 * 30
          })
        });
      })
      .catch(() => sendJson(res, 400, { error: '请求格式错误' }));
    return true;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const session = getSession(req);
    if (session) db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    sendJson(res, 200, { ok: true }, {
      'set-cookie': cookie.serialize('cloudshelf_session', '', {
        path: '/',
        maxAge: 0,
        secure: isSecureRequest(req)
      })
    });
    return true;
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const session = getSession(req);
    sendJson(res, 200, { authenticated: Boolean(session) });
    return true;
  }

  if (url.pathname === '/api/health' && req.method === 'GET') {
    try {
      db.prepare('SELECT 1').get();
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 503, { ok: false });
    }
    return true;
  }

  if (!requireAuth(req, res)) return true;

  if (url.pathname === '/api/password' && req.method === 'PUT') {
    const session = getSession(req);
    parseBody(req)
      .then(({ currentPassword = '', newPassword = '' }) => {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
        if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
          sendJson(res, 400, { error: '当前密码不正确' });
          return;
        }
        if (!String(newPassword)) {
          sendJson(res, 400, { error: '新密码不能为空' });
          return;
        }
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .run(bcrypt.hashSync(newPassword, 12), user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, session.id);
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 400, { error: '请求格式错误' }));
    return true;
  }

  if (url.pathname === '/api/folders' && req.method === 'GET') {
    const rows = db.prepare(`
      SELECT folders.*, COUNT(books.id) AS book_count
      FROM folders
      LEFT JOIN books ON books.folder_id = folders.id
      GROUP BY folders.id
      ORDER BY folders.name COLLATE NOCASE
    `).all();
    sendJson(res, 200, { folders: rows.map(folderRowToDto) });
    return true;
  }

  if (url.pathname === '/api/folders' && req.method === 'POST') {
    parseBody(req)
      .then(({ name = '' }) => {
        const id = getOrCreateFolder(name);
        if (!id) {
          sendJson(res, 400, { error: '文件夹名称不能为空' });
          return;
        }
        const row = db.prepare('SELECT folders.*, 0 AS book_count FROM folders WHERE id = ?').get(id);
        sendJson(res, 201, { folder: folderRowToDto(row) });
      })
      .catch(() => sendJson(res, 400, { error: '请求格式错误' }));
    return true;
  }

  if (url.pathname === '/api/books' && req.method === 'GET') {
    const folderId = url.searchParams.get('folderId');
    const params = [];
    let where = '';
    if (folderId === 'none') {
      where = 'WHERE books.folder_id IS NULL';
    } else if (folderId) {
      where = 'WHERE books.folder_id = ?';
      params.push(Number(folderId));
    }
    const rows = db.prepare(`
      SELECT books.*, folders.name AS folder_name
      FROM books
      LEFT JOIN folders ON folders.id = books.folder_id
      ${where}
      ORDER BY books.updated_at DESC
    `).all(...params);
    sendJson(res, 200, { books: rows.map((row) => bookRowToDto(row)) });
    return true;
  }

  if (url.pathname === '/api/books' && req.method === 'POST') {
    handleUpload(req, res);
    return true;
  }

  const bookMatch = url.pathname.match(/^\/api\/books\/(\d+)(?:\/(file|cover|sections|state))?$/);
  if (bookMatch) {
    const bookId = Number(bookMatch[1]);
    const action = bookMatch[2] || '';
    const row = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
    if (!row) {
      sendJson(res, 404, { error: '图书不存在' });
      return true;
    }

    if (!action && req.method === 'GET') {
      sendJson(res, 200, { book: bookRowToDto(row) });
      return true;
    }

    if (!action && req.method === 'PATCH') {
      parseBody(req)
        .then(({ title, authors, folderId, publisher, description }) => {
          const nextTitle = title == null ? row.title : normalizeText(title);
          if (!nextTitle) {
            sendJson(res, 400, { error: '书名不能为空' });
            return;
          }
          const nextAuthors = authors == null
            ? row.authors
            : JSON.stringify(Array.isArray(authors) ? authors.map(normalizeText).filter(Boolean) : String(authors).split(/[,\n、]/).map(normalizeText).filter(Boolean));
          const nextFolderId = folderId === undefined || folderId === ''
            ? row.folder_id
            : folderId === null
              ? null
              : Number(folderId);
          db.prepare(`
            UPDATE books
            SET title = ?, authors = ?, folder_id = ?, publisher = ?, description = ?, updated_at = ?
            WHERE id = ?
          `).run(
            nextTitle,
            nextAuthors,
            nextFolderId,
            publisher == null ? row.publisher : String(publisher),
            description == null ? row.description : String(description),
            new Date().toISOString(),
            bookId
          );
          const updated = db.prepare(`
            SELECT books.*, folders.name AS folder_name
            FROM books
            LEFT JOIN folders ON folders.id = books.folder_id
            WHERE books.id = ?
          `).get(bookId);
          sendJson(res, 200, { book: bookRowToDto(updated) });
        })
        .catch(() => sendJson(res, 400, { error: '请求格式错误' }));
      return true;
    }

    if (!action && req.method === 'DELETE') {
      db.prepare('DELETE FROM section_fts WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM table_of_contents WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM sections WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM reading_state WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM books WHERE id = ?').run(bookId);
      deleteFileQuietly(row.file_path);
      deleteFileQuietly(row.cover_path);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (action === 'file' && req.method === 'GET') {
      send(res, 200, fs.createReadStream(row.file_path), {
        'content-type': mime.lookup(row.file_path) || 'application/octet-stream'
      });
      return true;
    }

    if (action === 'cover' && req.method === 'GET') {
      if (!row.cover_path) {
        sendJson(res, 404, { error: '没有封面' });
        return true;
      }
      send(res, 200, fs.createReadStream(row.cover_path), {
        'content-type': mime.lookup(row.cover_path) || 'image/jpeg',
        'cache-control': 'private, max-age=86400'
      });
      return true;
    }

    if (action === 'sections' && req.method === 'GET') {
      const sections = db.prepare('SELECT id, section_index, title, href, text FROM sections WHERE book_id = ? ORDER BY section_index').all(bookId);
      const toc = db.prepare('SELECT title, href, section_index AS sectionIndex FROM table_of_contents WHERE book_id = ? ORDER BY sort_order').all(bookId);
      sendJson(res, 200, { sections, toc });
      return true;
    }

    if (action === 'state' && req.method === 'PUT') {
      parseBody(req)
        .then(({ locator = '', progress = 0 }) => {
          db.prepare(`
            INSERT INTO reading_state (book_id, locator, progress, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(book_id) DO UPDATE SET locator = excluded.locator, progress = excluded.progress, updated_at = excluded.updated_at
          `).run(bookId, JSON.stringify(locator), Math.max(0, Math.min(1, Number(progress) || 0)), new Date().toISOString());
          sendJson(res, 200, { ok: true });
        })
        .catch(() => sendJson(res, 400, { error: '请求格式错误' }));
      return true;
    }
  }

  if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const ftsQuery = createFtsQuery(q);
    if (!ftsQuery) {
      sendJson(res, 200, { results: [] });
      return true;
    }
    const rows = db.prepare(`
      SELECT books.id AS book_id, books.title AS book_title, sections.id AS section_id,
             sections.section_index, sections.title AS section_title, sections.text
      FROM section_fts
      JOIN sections ON sections.id = section_fts.section_id
      JOIN books ON books.id = section_fts.book_id
      WHERE section_fts MATCH ?
      ORDER BY rank
      LIMIT 40
    `).all(ftsQuery);
    sendJson(res, 200, {
      results: rows.map((row) => ({
        bookId: row.book_id,
        bookTitle: row.book_title,
        sectionId: row.section_id,
        sectionIndex: row.section_index,
        sectionTitle: row.section_title,
        excerpt: excerpt(row.text, q)
      }))
    });
    return true;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    sendJson(res, 200, {
      settings: Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]))
    });
    return true;
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    parseBody(req)
      .then((settings) => {
        const stmt = db.prepare(`
          INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        for (const [key, value] of Object.entries(settings || {})) {
          stmt.run(key, JSON.stringify(value));
        }
        sendJson(res, 200, { ok: true });
      })
      .catch(() => sendJson(res, 400, { error: '请求格式错误' }));
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(publicDir, pathname));
  if (!filePath.startsWith(publicDir)) {
    send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    send(res, 200, fs.createReadStream(filePath), {
      'content-type': mime.lookup(filePath) || 'application/octet-stream',
      'cache-control': 'no-store'
    });
  } catch {
    const indexPath = path.join(publicDir, 'index.html');
    send(res, 200, fs.createReadStream(indexPath), {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!routeApi(req, res, url)) sendJson(res, 404, { error: '接口不存在' });
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: '服务器内部错误' });
  }
});

server.listen(port, () => {
  console.log(`CloudShelf is listening on http://localhost:${port}`);
});
