import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

if (existsSync('.env.local')) {
  console.error('.env.local already exists. Keep it safe; move it aside if you want to generate new credentials.');
  process.exit(1);
}
const password = randomBytes(18).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const secret = randomBytes(32).toString('hex');
writeFileSync('.env.local', `APP_ORIGIN=http://localhost:3000\nADMIN_USERNAME=admin\nADMIN_PASSWORD_HASH=${hash}\nSESSION_SECRET=${secret}\nSTORAGE_PATH=./storage\nSTORAGE_QUOTA_BYTES=20000000000\nMIN_FREE_DISK_BYTES=5000000000\nMAX_FILE_BYTES=1000000000\n`, { mode: 0o600, flag: 'wx' });
console.log(`\nPocket Drive is configured.\n\nUsername: admin\nPassword: ${password}\n\nSave this password in your password manager. It is shown only now.\nStart locally: npm run dev\nFor Coolify: follow COOLIFY.md and copy settings from .env.local.\n`);
