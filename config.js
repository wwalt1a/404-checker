/**
 * 404-checker 站点安全鉴权配置文件
 * 
 * 【部署说明】：
 * 1. 若要启用密码保护：将 enabled 设为 true，并在 password 中填写密码（或在 passwordHash 填写 SHA-256 哈希）；
 * 2. 若不启用密码保护：保持 enabled 设为 false，网站即为完全免密公开访问模式。
 */
window.AUTH_CONFIG = {
  // 是否启用访问密码保护 (true: 开启密码保护, false: 完全公开免密)
  enabled: false,

  // 访问密码 (明文方式，如 "admin888" 或 "my-secret-password")
  // 如果同时配置了 passwordHash，系统将优先以 passwordHash 进行加密比对
  password: "",

  // 可选：密码的 SHA-256 哈希值 (推荐部署在公共仓库时使用，避免明文泄露)
  // 例如 "123456" 的 SHA-256 值为:
  // "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92"
  passwordHash: "",

  // 记住密码免密访问天数 (默认 7 天；设为 0 为仅当前会话有效，关闭标签页需重新输入)
  rememberDays: 7,

  // 弹窗标题与提示文案
  title: "安全访问验证",
  subtitle: "本站点已开启访问控制，请输入访问密码以解锁"
};
