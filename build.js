/**
 * Cloudflare Pages 静态构建脚本 (可选构建命令：node build.js)
 * 自动读取后台环境变量 AUTH_PASSWORD 并生成带 SHA-256 哈希的 config.js
 */
const fs = require('fs');
const crypto = require('crypto');

const pwd = (process.env.AUTH_PASSWORD || process.env.SITE_PASSWORD || '').trim();
const hash = pwd ? crypto.createHash('sha256').update(pwd).digest('hex') : '';

const output = `/**
 * 由 Cloudflare 构建环境根据环境变量 AUTH_PASSWORD 自动生成
 */
window.AUTH_CONFIG = {
  enabled: ${Boolean(pwd)},
  password: "",
  passwordHash: "${hash}",
  title: "安全访问验证",
  subtitle: "本站点已开启访问控制，请输入访问密码以解锁"
};
`;

fs.writeFileSync('config.js', output, 'utf8');
console.log(`[Cloudflare Build] config.js generated. Auth enabled: ${Boolean(pwd)}`);
