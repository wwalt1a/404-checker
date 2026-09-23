/**
 * Cloudflare Pages Function: /api/config
 * 动态读取 Cloudflare Pages 后台配置的环境变量 AUTH_PASSWORD
 * 并返回安全的 SHA-256 密码哈希，实现零明文泄露的极简鉴权
 */
export async function onRequest(context) {
  const pwd = (context.env.AUTH_PASSWORD || context.env.SITE_PASSWORD || "").trim();
  let hash = "";

  if (pwd) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pwd);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    hash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  return new Response(JSON.stringify({
    enabled: Boolean(pwd),
    passwordHash: hash
  }), {
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}
