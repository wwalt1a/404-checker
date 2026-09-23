/**
 * 云端静态与 Serverless 构建脚本 (node build.js)
 * 适配 Cloudflare Pages、Vercel 等 CI/CD 自动构建
 * 1. 自动读取后台环境变量 AUTH_PASSWORD 并生成带 SHA-256 哈希的 config.js 及 auth.json
 * 2. 自动读取后台环境变量 TARGETS_LOCAL_JSON 并生成 targets.local.json (实现私有网址安全云端注入)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 1. 处理鉴权密码
const pwd = (process.env.AUTH_PASSWORD || process.env.SITE_PASSWORD || '').trim();
const hash = pwd ? crypto.createHash('sha256').update(pwd).digest('hex') : '';

if (pwd) {
  const output = `/**
 * 由云端构建环境 (Vercel / Cloudflare) 根据环境变量 AUTH_PASSWORD 自动生成
 */
window.AUTH_CONFIG = {
  enabled: true,
  password: "",
  passwordHash: "${hash}",
  title: "安全访问验证",
  subtitle: "本站点已开启访问控制，请输入访问密码以解锁"
};
`;
  fs.writeFileSync('config.js', output, 'utf8');

  const authJson = {
    enabled: true,
    passwordHash: hash,
    title: "安全访问验证",
    subtitle: "本站点已开启访问控制，请输入访问密码以解锁"
  };
  fs.writeFileSync('auth.json', JSON.stringify(authJson, null, 2), 'utf8');
  console.log(`[Build] config.js and auth.json generated. Auth enabled: true`);
} else {
  console.log(`[Build] AUTH_PASSWORD not provided, keeping default public config.js.`);
}

// 2. 处理本地私人网址 (TARGETS_LOCAL_JSON)
const rawTargets = (process.env.TARGETS_LOCAL_JSON || '').trim();
if (rawTargets) {
  try {
    const parsed = JSON.parse(rawTargets);
    fs.writeFileSync('targets.local.json', JSON.stringify(parsed, null, 2), 'utf8');
    const count = (parsed.custom_targets || parsed.targets || []).length;
    console.log(`[Build] targets.local.json injected successfully (${count} private targets).`);
  } catch (err) {
    console.warn(`[Build] Failed to parse TARGETS_LOCAL_JSON:`, err.message);
  }
} else {
  console.log(`[Build] TARGETS_LOCAL_JSON not provided in environment.`);
}

// 3. 确保 api/ 目录下的 Serverless Function 可用
try {
  if (!fs.existsSync('api')) fs.mkdirSync('api');
  const apiCode = `const crypto = require('crypto');

module.exports = (req, res) => {
  const pwd = (process.env.AUTH_PASSWORD || process.env.SITE_PASSWORD || '${pwd}').trim();
  const hash = pwd ? crypto.createHash('sha256').update(pwd).digest('hex') : '${hash}';

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  res.status(200).json({
    enabled: Boolean(hash),
    passwordHash: hash
  });
};
`;
  fs.writeFileSync(path.join('api', 'config.js'), apiCode, 'utf8');
} catch (e) {
  console.warn(`[Build] Failed to create api/config.js:`, e.message);
}
