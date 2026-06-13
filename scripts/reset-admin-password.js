import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const dbPath = path.join(dataDir, 'cloudshelf.db');
const password = process.env.ADMIN_PASSWORD;

if (!password || password.length < 12) {
  console.error('Set ADMIN_PASSWORD to a new password with at least 12 characters.');
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const hash = bcrypt.hashSync(password, 12);
const result = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, 'admin');

if (result.changes === 0) {
  console.error('Admin user was not found. Start CloudShelf once before resetting the password.');
  process.exit(1);
}

console.log('Admin password updated.');
