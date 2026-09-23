/**
 * 网络可达性与延迟检测工具 - 核心逻辑引擎
 * 纯浏览器端发起，绝不经由任何服务器代理，真实呈现用户手机网络质量
 */

(function () {
  'use strict';

  // ================= 默认配置与持久化键名 =================
  const STORAGE_KEYS = {
    TARGETS: 'net_reachability_targets',
    CONFIG: 'net_reachability_config',
    LAST_TIME: 'net_reachability_last_time',
    AUTH_SESSION: 'net_reachability_auth_session'
  };

  const DEFAULT_CONFIG = {
    timeout: 5000,       // 默认超时毫秒 (5秒)
    concurrency: 8,      // 默认并发通道数 (8通道高速并发)
    samples: 1,          // 默认采样次数 (1: 快速, 3: 精准中位数)
    autostart: true      // 打开网页自动测试
  };

  // 应用状态容器
  const state = {
    config: Object.assign({}, DEFAULT_CONFIG),
    targets: [],
    activeCategory: 'custom', // 'custom' (默认第一项) | 'overseas' | 'domestic'
    isRunning: false,
    abortBatchController: null,
    activeFilter: 'all', // 'all' | 'online' | 'offline'
    isSortedByLatency: false,
    completedCount: 0,
    localNetwork: {
      ipv6: null, // null: 未检测, true: 支持IPv6(双栈), false: 仅IPv4
      isChecking: false,
      lastChecked: 0
    }
  };

  const CATEGORY_META = {
    custom: { name: '自定义网址', icon: '🛠️' },
    overseas: { name: '国外网址', icon: '🌐' },
    domestic: { name: '国内网址', icon: '🇨🇳' }
  };

  function getActiveCategoryTargets() {
    return state.targets.filter(t => (t.category || 'custom') === state.activeCategory);
  }

  // DOM 元素缓存
  const dom = {
    appContainer: document.getElementById('app-container'),
    btnLockSite: document.getElementById('btn-lock-site'),
    modalAuth: document.getElementById('modal-auth'),
    authCard: document.getElementById('auth-card'),
    authTitle: document.getElementById('auth-title'),
    authSubtitle: document.getElementById('auth-subtitle'),
    authForm: document.getElementById('auth-form'),
    inputAuthPassword: document.getElementById('input-auth-password'),
    btnTogglePassword: document.getElementById('btn-toggle-password'),
    eyeIcon: document.getElementById('eye-icon'),
    authErrorMsg: document.getElementById('auth-error-msg'),
    authRememberMe: document.getElementById('auth-remember-me'),
    btnAuthSubmit: document.getElementById('btn-auth-submit'),
    securityNotice: document.getElementById('security-notice'),
    netEnvBadge: document.getElementById('net-env-badge'),
    netEnvDot: document.getElementById('net-env-dot'),
    netEnvText: document.getElementById('net-env-text'),
    statTotal: document.getElementById('stat-total'),
    statOnline: document.getElementById('stat-online'),
    statTimeout: document.getElementById('stat-timeout'),
    statAvg: document.getElementById('stat-avg'),
    progressContainer: document.getElementById('progress-container'),
    progressBar: document.getElementById('progress-bar'),
    btnTestAll: document.getElementById('btn-test-all'),
    btnTestIcon: document.getElementById('btn-test-icon'),
    btnTestText: document.getElementById('btn-test-text'),
    btnCopyReachable: document.getElementById('btn-copy-reachable'),
    btnSort: document.getElementById('btn-sort'),
    targetList: document.getElementById('target-list'),
    lastUpdatedText: document.getElementById('last-updated-text'),
    countAll: document.getElementById('count-all'),
    countOnline: document.getElementById('count-online'),
    countOffline: document.getElementById('count-offline'),
    pills: document.querySelectorAll('.pill-btn[data-filter]'),
    toastContainer: document.getElementById('toast-container'),
    // 分类下拉菜单元素
    categoryBar: document.getElementById('category-bar'),
    categoryMenu: document.getElementById('category-menu'),
    catActiveIcon: document.getElementById('cat-active-icon'),
    catActiveName: document.getElementById('cat-active-name'),
    catActiveBadge: document.getElementById('cat-active-badge'),
    catChevron: document.getElementById('cat-chevron'),
    catMenuItems: document.querySelectorAll('.category-menu-item'),
    catCountCustom: document.getElementById('cat-count-custom'),
    catCountOverseas: document.getElementById('cat-count-overseas'),
    catCountDomestic: document.getElementById('cat-count-domestic'),
    // 弹窗元素
    modalSettings: document.getElementById('modal-settings'),
    modalImport: document.getElementById('modal-import'),
    btnOpenSettings: document.getElementById('btn-open-settings'),
    btnOpenImport: document.getElementById('btn-open-import'),
    settingTimeout: document.getElementById('setting-timeout'),
    settingConcurrency: document.getElementById('setting-concurrency'),
    settingSamples: document.getElementById('setting-samples'),
    settingAutostart: document.getElementById('setting-autostart'),
    tabManageList: document.getElementById('tab-manage-list'),
    tabAddSingle: document.getElementById('tab-add-single'),
    tabAddBatch: document.getElementById('tab-add-batch'),
    panelManageList: document.getElementById('panel-manage-list'),
    panelAddSingle: document.getElementById('panel-add-single'),
    panelAddBatch: document.getElementById('panel-add-batch'),
    manageItemsContainer: document.getElementById('manage-items-container'),
    btnExportJson: document.getElementById('btn-export-json'),
    selectInsertPos: document.getElementById('select-insert-pos'),
    btnSaveSingle: document.getElementById('btn-save-single'),
    btnSaveBatch: document.getElementById('btn-save-batch'),
    btnResetDefaults: document.getElementById('btn-reset-defaults'),
    inputTargetName: document.getElementById('input-target-name'),
    inputTargetUrl: document.getElementById('input-target-url'),
    inputTargetGroup: document.getElementById('input-target-group'),
    textareaBatchUrls: document.getElementById('textarea-batch-urls')
  };

  // ================= 站点安全鉴权引擎 (AuthManager) =================

  async function sha256(message) {
    if (!window.crypto || !window.crypto.subtle) {
      let hash = 0;
      for (let i = 0; i < message.length; i++) {
        hash = ((hash << 5) - hash) + message.charCodeAt(i);
        hash |= 0;
      }
      return 'fallback_' + Math.abs(hash).toString(16);
    }
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const AuthManager = {
    config: {
      enabled: false,
      password: '',
      passwordHash: '',
      title: '安全访问验证',
      subtitle: '本站点已开启访问控制，请输入访问密码以解锁'
    },
    expectedHash: '',

    async init() {
      // 1. 本地私有优先：读取 auth.local.json (受 .gitignore 保护，不入库，本地测试利器)
      try {
        const localResp = await fetch('auth.local.json?_v=' + Date.now());
        if (localResp.ok) {
          const localData = await localResp.json();
          if (localData && typeof localData === 'object') {
            Object.assign(this.config, localData);
          }
        }
      } catch {}

      // 2. Cloudflare Pages 环境变量支持：动态拉取 /api/config
      if (!this.config.enabled && !this.config.password && !this.config.passwordHash) {
        try {
          const cfResp = await fetch('/api/config');
          if (cfResp.ok) {
            const cfData = await cfResp.json();
            if (cfData && cfData.enabled) {
              Object.assign(this.config, cfData);
            }
          }
        } catch {}
      }

      // 3. 静态 window.AUTH_CONFIG (来自 config.js 或 build.js 环境变量生成)
      if (!this.config.enabled && window.AUTH_CONFIG && typeof window.AUTH_CONFIG === 'object') {
        Object.assign(this.config, window.AUTH_CONFIG);
      }

      // 4. 备选 auth.json
      if (!this.config.enabled && !this.config.password && !this.config.passwordHash) {
        try {
          const resp = await fetch('auth.json?_v=' + Date.now());
          if (resp.ok) {
            const data = await resp.json();
            Object.assign(this.config, data);
          }
        } catch {}
      }

      // 计算并规范化目标验证 Hash
      if (this.config.passwordHash) {
        this.expectedHash = this.config.passwordHash.trim().toLowerCase();
      } else if (this.config.password) {
        this.expectedHash = await sha256(this.config.password.trim());
      }

      if (dom.authTitle && this.config.title) {
        dom.authTitle.textContent = this.config.title;
      }
      if (dom.authSubtitle && this.config.subtitle) {
        dom.authSubtitle.textContent = this.config.subtitle;
      }
    },

    isProtected() {
      return Boolean(this.config.enabled && (this.config.password || this.config.passwordHash));
    },

    isAuthenticated() {
      if (!this.isProtected()) return true;

      // 极简永久认证：只要本地成功登录过一次即长期有效，关闭浏览器重开依然免密
      const token = localStorage.getItem(STORAGE_KEYS.AUTH_SESSION) || sessionStorage.getItem(STORAGE_KEYS.AUTH_SESSION);
      return Boolean(token && token === this.expectedHash);
    },

    async verifyPassword(inputPassword) {
      if (!this.isProtected()) return true;
      const cleanInput = (inputPassword || '').trim();
      if (!cleanInput) return false;

      const inputHash = await sha256(cleanInput);
      const isMatch = (inputHash === this.expectedHash) || 
                      (this.config.password && cleanInput === this.config.password.trim());

      if (isMatch) {
        // 登录成功：永久存入 localStorage，长期有效
        localStorage.setItem(STORAGE_KEYS.AUTH_SESSION, this.expectedHash);
        sessionStorage.setItem(STORAGE_KEYS.AUTH_SESSION, this.expectedHash);
        return true;
      }

      return false;
    },

    lockSite() {
      // 主动点击锁定：清空本地免密凭证
      localStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);
      sessionStorage.removeItem(STORAGE_KEYS.AUTH_SESSION);

      if (state.isRunning) {
        stopBatchTests();
      }

      // 核心安全隔离：清空内存与 DOM 中的所有目标网址信息，绝不泄露
      state.targets = [];
      dom.targetList.innerHTML = '';
      dom.statTotal.textContent = '-';
      dom.statOnline.textContent = '-';
      dom.statTimeout.textContent = '-';
      dom.statAvg.textContent = '-';
      if (dom.countAll) dom.countAll.textContent = '0';
      if (dom.countOnline) dom.countOnline.textContent = '0';
      if (dom.countOffline) dom.countOffline.textContent = '0';
      if (dom.catActiveBadge) dom.catActiveBadge.textContent = '🔒 已锁定';

      // 高斯模糊与弹窗展现
      if (dom.appContainer) dom.appContainer.classList.add('auth-locked');
      if (dom.modalAuth) {
        dom.modalAuth.style.display = 'flex';
        void dom.modalAuth.offsetWidth;
        dom.modalAuth.classList.add('active');
      }
      if (dom.inputAuthPassword) {
        dom.inputAuthPassword.value = '';
        setTimeout(() => dom.inputAuthPassword.focus(), 60);
      }
      if (dom.authErrorMsg) dom.authErrorMsg.style.display = 'none';
      if (dom.btnLockSite) dom.btnLockSite.style.display = 'flex';
    },

    unlockSiteUI() {
      if (dom.modalAuth) {
        dom.modalAuth.classList.remove('active');
        setTimeout(() => {
          dom.modalAuth.style.display = 'none';
        }, 300);
      }
      if (dom.appContainer) dom.appContainer.classList.remove('auth-locked');
      if (dom.btnLockSite) dom.btnLockSite.style.display = this.isProtected() ? 'flex' : 'none';
    }
  };

  // ================= IPv6 本地协议栈与目标域名识别模块 =================

  // 纯 IPv6 探测端点：国内权威高校清华大学 TUNA 镜像站 (三网直连无GFW) + 国际知名纯 IPv6 节点
  const IPV6_PROBE_ENDPOINTS = [
    'https://mirrors6.tuna.tsinghua.edu.cn/static/img/favicon.png',
    'https://api6.ipify.org?format=json'
  ];

  /**
   * 诊断当前浏览器/本地网络是否具备 IPv6 连通能力
   * 采用国内高校 + 国际节点赛马竞速 (Promise.any)，毫秒级定性，无视 GFW 干扰
   */
  async function checkLocalIPv6(force = false) {
    if (!force && state.localNetwork.ipv6 !== null && (Date.now() - state.localNetwork.lastChecked < 60000)) {
      return state.localNetwork.ipv6;
    }

    state.localNetwork.isChecking = true;
    updateNetEnvUI('checking');

    const probe = async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        await fetch(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now(), {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal
        });
        clearTimeout(timer);
        return true;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    };

    try {
      await Promise.any(IPV6_PROBE_ENDPOINTS.map(url => probe(url)));
      state.localNetwork.ipv6 = true;
      state.localNetwork.lastChecked = Date.now();
      updateNetEnvUI('dual-stack');
      return true;
    } catch {
      state.localNetwork.ipv6 = false;
      state.localNetwork.lastChecked = Date.now();
      updateNetEnvUI('ipv4-only');
      return false;
    } finally {
      state.localNetwork.isChecking = false;
    }
  }

  function updateNetEnvUI(status) {
    if (!dom.netEnvBadge || !dom.netEnvText) return;

    dom.netEnvBadge.classList.remove('checking', 'dual-stack', 'ipv4-only');

    if (status === 'checking') {
      dom.netEnvBadge.classList.add('checking');
      dom.netEnvText.textContent = 'IPv6 检测中...';
      dom.netEnvBadge.title = '正在探测当前网络是否具备 IPv6 访问能力...';
    } else if (status === 'dual-stack') {
      dom.netEnvBadge.classList.add('dual-stack');
      dom.netEnvText.textContent = 'IPv4 / IPv6 双栈';
      dom.netEnvBadge.title = '本地网络已成功连通 IPv6，可正常访问纯 IPv6 网站 (点击重新诊断)';
    } else if (status === 'ipv4-only') {
      dom.netEnvBadge.classList.add('ipv4-only');
      dom.netEnvText.textContent = '仅 IPv4 (无 IPv6)';
      dom.netEnvBadge.title = '当前网络未获得 IPv6 支持，纯 IPv6 网站将无法直连 (点击重新诊断)';
    }
  }

  // 内存 DNS 缓存 (避免重复查询相同域名)
  const domainDnsCache = new Map();

  function isIPv6Host(hostname) {
    if (!hostname) return false;
    const raw = hostname.replace(/^\[|\]$/g, '');
    return raw.includes(':');
  }

  function isIPv4Host(hostname) {
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  }

  /**
   * 异步检测目标域名/地址是否属于 IPv6-Only
   */
  async function checkTargetIPv6Profile(url) {
    let hostname = '';
    try {
      const u = new URL(url);
      hostname = u.hostname;
    } catch {
      hostname = (url || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
    }

    if (!hostname) {
      return { isIPv6Only: false, isDualStack: false, hasA: false, hasAAAA: false };
    }

    // 1. 若本身就是纯 IPv6 字面量地址 (如 [2408:8206:...])
    if (isIPv6Host(hostname)) {
      return { isIPv6Only: true, isDualStack: false, hasAAAA: true, hasA: false };
    }

    // 2. 若是纯 IPv4 字面量或本地地址
    if (isIPv4Host(hostname) || hostname === 'localhost') {
      return { isIPv6Only: false, isDualStack: false, hasAAAA: false, hasA: true };
    }

    // 3. 命中缓存直接返回
    if (domainDnsCache.has(hostname)) {
      return domainDnsCache.get(hostname);
    }

    // 4. DoH 探测：国内首选阿里 DNS，备用 Cloudflare DoH
    async function queryDoH(domain, type) {
      const targetType = type === 'A' ? 1 : 28;

      // 4.1 阿里 DNS DoH (国内免翻毫秒级)
      try {
        const resp = await fetch(`https://dns.alidns.com/resolve?name=${encodeURIComponent(domain)}&type=${type}`, {
          signal: AbortSignal.timeout(1200)
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json && Array.isArray(json.Answer)) {
            return json.Answer.some(ans => ans.type === targetType);
          }
        }
      } catch {}

      // 4.2 Cloudflare DoH (国外与备选)
      try {
        const resp = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${type}`, {
          headers: { 'Accept': 'application/dns-json' },
          signal: AbortSignal.timeout(1500)
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json && Array.isArray(json.Answer)) {
            return json.Answer.some(ans => ans.type === targetType);
          }
        }
      } catch {}

      return false;
    }

    try {
      const [hasA, hasAAAA] = await Promise.all([
        queryDoH(hostname, 'A'),
        queryDoH(hostname, 'AAAA')
      ]);

      const result = {
        isIPv6Only: Boolean(hasAAAA && !hasA),
        isDualStack: Boolean(hasAAAA && hasA),
        hasA,
        hasAAAA
      };
      domainDnsCache.set(hostname, result);
      return result;
    } catch {
      const fallback = { isIPv6Only: false, isDualStack: false, hasA: false, hasAAAA: false };
      domainDnsCache.set(hostname, fallback);
      return fallback;
    }
  }

  /**
   * 对探测结果进行智能归因与 IPv6 诊断
   */
  async function finalizeProbeResult(target, res) {
    let hostname = '';
    try {
      hostname = new URL(target.url).hostname;
    } catch {
      hostname = (target.url || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
    }

    if (isIPv6Host(hostname)) {
      target.isIPv6Only = true;
    }

    // 若测试未通 (超时/阻断/失败)，智能诊断目标是否为 IPv6-only
    if (res.status !== 'online') {
      try {
        const profile = await checkTargetIPv6Profile(target.url);
        if (profile.isIPv6Only) {
          target.isIPv6Only = true;
          // 若本地网络未具备 IPv6，准确定性原因
          if (state.localNetwork.ipv6 === false) {
            res.status = 'unsupported_ipv6';
            res.reason = '需 IPv6 网络 (本机当前网络缺少 IPv6 支持，无法直连)';
          } else {
            // 本机具备 IPv6 支持或处于检测状态，但目标无响应或不可达
            if (res.status === 'timeout') {
              res.reason = '纯 IPv6 网站响应超时 (目标无响应/DNS未更新/端口未映射)';
            } else {
              res.reason = '纯 IPv6 连接失败 (网络不可达/DNS未更新/端口无响应)';
            }
          }
        }
      } catch {}
    } else {
      // 成功连通时，如果已有缓存或快速检查发现是纯 IPv6
      if (target.isIPv6Only === undefined) {
        try {
          const profile = await checkTargetIPv6Profile(target.url);
          if (profile.isIPv6Only) {
            target.isIPv6Only = true;
          }
        } catch {}
      }
    }

    return res;
  }

  // ================= 核心网络探测引擎 (ProbeEngine) =================

  /**
   * 安全构造探测 URL (规范化端口与防缓存参数)
   * 完美适配形如 https://sub.fapcraft.cf:8888 的带端口地址与 Cloudflare Tunnel 路径
   */
  function buildProbeUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      u.searchParams.set('_probe_ts', Date.now().toString());
      return u.toString();
    } catch {
      let normalized = rawUrl;
      if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
        normalized = 'https://' + normalized;
      }
      if (/:\d{2,5}$/.test(normalized)) {
        normalized += '/';
      }
      const sep = normalized.includes('?') ? '&' : (normalized.endsWith('/') ? '?' : '/?');
      return `${normalized}${sep}_probe_ts=${Date.now()}`;
    }
  }

  /**
   * 单次探测目标 URL
   * 采用多矢量智能探测架构 (Multi-Vector Reachability Engine)：
   * 1. 主路径探测：mode: 'no-cors'，若成功返回 HTTP 响应则判定在线
   * 2. 超时与取消捕获：严格遵守配置上限 (如 5000ms)
   * 3. 极速本地/协议拒绝拦截：如 HTTPS 页面探测 HTTP 明文限制、本地 127.0.0.1 端口未开等 (< 12ms)
   * 4. 链路容错向量 A (轻量静态资源探针)：针对站点探测 /favicon.ico 验证 Web 服务器存活
   * 5. 链路容错向量 B (Cloudflare 边缘探针)：针对 Tunnel 穿透域名探测 /cdn-cgi/trace
   */
  async function probeOnce(url, timeoutMs, externalSignal, targetCategory) {
    const t0 = performance.now();
    const controller = new AbortController();

    // 组合超时中断与外部取消信号
    let isTimeout = false;
    const timeoutId = setTimeout(() => {
      isTimeout = true;
      controller.abort();
    }, timeoutMs);

    if (externalSignal) {
      externalSignal.addEventListener('abort', () => {
        controller.abort();
      });
    }

    // 构造防缓存 URL (自动保留端口与根路径)
    const testUrl = buildProbeUrl(url);

    try {
      // mode: 'no-cors' 兼容任意第三方 HTTPS/HTTP 网站及非标端口，不被同源策略阻断
      await fetch(testUrl, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const elapsed = Math.round(performance.now() - t0);
      return {
        status: 'online',
        latency: Math.max(1, elapsed),
        reason: '连接成功 (HTTP响应完成)'
      };
    } catch (err) {
      clearTimeout(timeoutId);
      const elapsed = Math.round(performance.now() - t0);

      if (externalSignal && externalSignal.aborted) {
        return {
          status: 'ready',
          latency: null,
          reason: '用户手动中止'
        };
      }

      // 极快失败 (< 12ms)：通常为本地拒绝、端口未开放或 HTTPS 下对 HTTP 的混合内容拦截
      if (elapsed < 12) {
        if (window.location && window.location.protocol === 'https:' && url.startsWith('http:')) {
          return {
            status: 'blocked',
            latency: elapsed,
            reason: '混合内容限制 (HTTPS页面无法跨域探测HTTP明文网址)'
          };
        }
        if (url.includes('127.0.0.1') || url.includes('localhost')) {
          return {
            status: 'offline',
            latency: elapsed,
            reason: '本地端口未开放 (Connection Refused)'
          };
        }
      }

      let urlObj;
      try {
        urlObj = new URL(url);
      } catch {
        urlObj = null;
      }

      if (urlObj && (!externalSignal || !externalSignal.aborted)) {
        // 容错向量 A：轻量静态图标探针 (/favicon.ico)
        // 针对任天堂等主路径慢重定向、大型 HTML 或 CDN 边缘未命中导致超时的站点，直接探测轻量静态资源验证存活性
        try {
          const favCtrl = new AbortController();
          const favTimeout = setTimeout(() => favCtrl.abort(), 2000);
          const favT0 = performance.now();
          await fetch(`${urlObj.origin}/favicon.ico`, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            signal: favCtrl.signal
          });
          clearTimeout(favTimeout);
          const favElapsed = Math.round(performance.now() - favT0);
          return {
            status: 'online',
            latency: Math.max(1, favElapsed),
            reason: '连接成功 (静态资源已响应)'
          };
        } catch {
          // 静态资源同样受限，继续向下
        }

        // 容错向量 B：Cloudflare 边缘节点探针 (/cdn-cgi/trace)
        // Cloudflare Tunnel 或 CDN 代理网站在主路径受限时，边缘节点仍可直接返回 200
        try {
          const cfCtrl = new AbortController();
          const cfTimeout = setTimeout(() => cfCtrl.abort(), 2000);
          const cfT0 = performance.now();
          await fetch(`${urlObj.origin}/cdn-cgi/trace`, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            signal: cfCtrl.signal
          });
          clearTimeout(cfTimeout);
          const cfElapsed = Math.round(performance.now() - cfT0);
          return {
            status: 'online',
            latency: Math.max(1, cfElapsed),
            reason: '连接成功 (通过Cloudflare边缘校验)'
          };
        } catch {
          // 边缘节点未命中或非 Cloudflare 托管，继续向下
        }
      }

      // 若容错向量也无法连通，且原本属于超时：明确判定为连接超时
      if (isTimeout) {
        return {
          status: 'timeout',
          latency: elapsed,
          reason: `连接超时 (> ${timeoutMs}ms 无响应)`
        };
      }

      // 海外公网网站若未成功建立通信，明确判定为网络阻断 (GFW SNI 阻断 / TCP RST / DNS 污染)
      if (targetCategory === 'overseas') {
        return {
          status: 'blocked',
          latency: elapsed,
          reason: '连接阻断 (防火墙TCP RST/SNI阻断/DNS污染)'
        };
      }

      // 其他未知网络错误
      let failureReason = err.message || '网络连接异常';
      if (failureReason.includes('Failed to fetch')) {
        failureReason = '连接失败 (网络不可达/DNS未更新/端口无响应)';
      }

      return {
        status: 'offline',
        latency: elapsed,
        reason: failureReason
      };
    }
  }

  /**
   * 目标采样探测 (根据设置执行 1 次快速测试或 3 次精准中位数)
   * 方案 A：针对超时 (timeout) 自动重试 1 次，只有连续 2 次都超时才最终判定为超时
   */
  async function probeTarget(target, timeoutMs, sampleCount, externalSignal) {
    if (sampleCount <= 1) {
      target.isRetrying = false;
      const res = await probeOnce(target.url, timeoutMs, externalSignal, target.category);

      // 方案 A：仅针对超时 (timeout) 自动重试 1 次（过滤瞬时偶发丢包）
      if (res.status === 'timeout' && (!externalSignal || !externalSignal.aborted)) {
        target.isRetrying = true;
        target.reason = `初次超时(>${timeoutMs}ms)，自动重试中 (2/2)...`;
        updateCardDOM(target);

        // 短暂缓冲 100ms
        await new Promise(r => setTimeout(r, 100));

        if (!externalSignal || !externalSignal.aborted) {
          const retryRes = await probeOnce(target.url, timeoutMs, externalSignal, target.category);
          target.isRetrying = false;
          if (retryRes.status === 'online') {
            retryRes.reason = `重试成功连通 (${retryRes.latency}ms)`;
            return await finalizeProbeResult(target, retryRes);
          }
          if (retryRes.status === 'timeout') {
            retryRes.reason = `连接超时 (重试2次均 >${timeoutMs}ms 无响应)`;
            return await finalizeProbeResult(target, retryRes);
          }
          return await finalizeProbeResult(target, retryRes);
        }
      }

      target.isRetrying = false;
      return await finalizeProbeResult(target, res);
    }

    // 精准模式：连续采样 3 次
    const results = [];
    for (let i = 0; i < sampleCount; i++) {
      if (externalSignal && externalSignal.aborted) break;
      const res = await probeOnce(target.url, timeoutMs, externalSignal, target.category);
      results.push(res);
      // 小间隔以分散压力
      if (i < sampleCount - 1) {
        await new Promise(r => setTimeout(r, 60));
      }
    }

    const onlineResults = results.filter(r => r.status === 'online');
    if (onlineResults.length > 0) {
      // 取中位数
      onlineResults.sort((a, b) => a.latency - b.latency);
      const mid = Math.floor(onlineResults.length / 2);
      return await finalizeProbeResult(target, onlineResults[mid]);
    } else {
      // 全失败，返回最后一个失败结果
      const last = results[results.length - 1] || { status: 'offline', latency: null, reason: '采样测试失败' };
      if (results.every(r => r.status === 'timeout')) {
        last.reason = `连接超时 (连续采样${sampleCount}次均无响应)`;
      }
      return await finalizeProbeResult(target, last);
    }
  }

  // ================= 并发任务队列管理 (Worker Pool) =================

  async function runBatchTests() {
    if (state.isRunning) {
      // 如果正在运行，则执行中止操作
      stopBatchTests();
      return;
    }

    const activeTargets = getActiveCategoryTargets().filter(t => t.enabled !== false);
    const catName = CATEGORY_META[state.activeCategory].name;
    if (activeTargets.length === 0) {
      showToast(`⚠️ 当前【${catName}】分类下没有可测试的目标网址`);
      return;
    }

    state.isRunning = true;
    state.abortBatchController = new AbortController();
    state.completedCount = 0;

    // 并发静默确保本地 IPv6 诊断状态有效
    if (state.localNetwork.ipv6 === null || (Date.now() - state.localNetwork.lastChecked > 120000)) {
      checkLocalIPv6();
    }

    // 更新界面主按钮状态
    dom.btnTestIcon.textContent = '⏹';
    dom.btnTestText.textContent = `停止测试 [${catName}]`;
    dom.btnTestAll.classList.add('running');
    dom.progressContainer.classList.add('active');
    updateProgress(0, activeTargets.length);

    // 将所有活跃目标重置为“等待测试”
    activeTargets.forEach(t => {
      t.status = 'testing';
      t.isRetrying = false;
      t.reason = '正在探测中...';
      updateCardDOM(t);
    });
    updateDashboard();

    const concurrency = Math.max(1, parseInt(state.config.concurrency, 10) || 8);
    const timeout = parseInt(state.config.timeout, 10) || 5000;
    const samples = parseInt(state.config.samples, 10) || 1;

    let index = 0;
    const total = activeTargets.length;

    // 工作线程轮询池
    async function worker() {
      while (index < total && !state.abortBatchController.signal.aborted) {
        const currentIndex = index++;
        const target = activeTargets[currentIndex];

        const result = await probeTarget(
          target,
          timeout,
          samples,
          state.abortBatchController.signal
        );

        if (!state.abortBatchController.signal.aborted) {
          target.status = result.status;
          target.latency = result.latency;
          target.reason = result.reason;
          target.isRetrying = false;
          target.lastTested = Date.now();

          state.completedCount++;
          updateCardDOM(target);
          updateProgress(state.completedCount, total);
          updateDashboard();
        }
      }
    }

    // 启动指定并发数的 worker 并行工作
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    // 测试完成收尾
    state.isRunning = false;
    dom.btnTestIcon.textContent = '🔄';
    dom.btnTestText.textContent = `重新测试全部 [${catName}]`;
    dom.btnTestAll.classList.remove('running');
    dom.progressContainer.classList.remove('active');

    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    dom.lastUpdatedText.textContent = `最后检测时间：今日 ${timeStr}`;
    localStorage.setItem(STORAGE_KEYS.LAST_TIME, timeStr);

    // 自动重排（如果处于排序视图）
    if (state.isSortedByLatency) {
      renderAllCards();
    }

    showToast(`✅ 【${catName}】全部 ${total} 个目标检测完毕`);
  }

  function stopBatchTests() {
    if (state.abortBatchController) {
      state.abortBatchController.abort();
    }
    state.isRunning = false;
    state.targets.forEach(t => { t.isRetrying = false; });
    dom.btnTestIcon.textContent = '▶';
    dom.btnTestText.textContent = `开始批量测试全部`;
    dom.btnTestAll.classList.remove('running');
    dom.progressContainer.classList.remove('active');
    showToast('⏹ 已停止后续测试');
  }

  /**
   * 单项重新测试
   */
  async function retestSingleTarget(targetId) {
    const target = state.targets.find(t => t.id === targetId);
    if (!target) return;

    target.status = 'testing';
    target.isRetrying = false;
    target.reason = '正在单独探测中...';
    updateCardDOM(target);

    const timeout = parseInt(state.config.timeout, 10) || 5000;
    const samples = parseInt(state.config.samples, 10) || 1;

    const res = await probeTarget(target, timeout, samples);
    target.status = res.status;
    target.latency = res.latency;
    target.reason = res.reason;
    target.isRetrying = false;
    target.lastTested = Date.now();

    updateCardDOM(target);
    updateDashboard();
    showToast(`🎯 ${target.name}: ${target.status === 'online' ? target.latency + ' ms' : target.reason}`);
  }

  // ================= DOM 渲染与局部更新 =================

  function updateProgress(current, total) {
    if (total === 0) return;
    const percent = Math.min(100, Math.round((current / total) * 100));
    dom.progressBar.style.width = `${percent}%`;
  }

  function updateDashboard() {
    const allTargets = state.targets;
    const countCustom = allTargets.filter(t => (t.category || 'custom') === 'custom').length;
    const countOverseas = allTargets.filter(t => t.category === 'overseas').length;
    const countDomestic = allTargets.filter(t => t.category === 'domestic').length;

    if (dom.catCountCustom) dom.catCountCustom.textContent = countCustom;
    if (dom.catCountOverseas) dom.catCountOverseas.textContent = countOverseas;
    if (dom.catCountDomestic) dom.catCountDomestic.textContent = countDomestic;

    const targets = getActiveCategoryTargets().filter(t => t.enabled !== false);
    const total = targets.length;
    const onlineList = targets.filter(t => t.status === 'online');
    const online = onlineList.length;
    const timeout = targets.filter(t => t.status === 'timeout' || t.status === 'blocked' || t.status === 'offline' || t.status === 'unsupported_ipv6').length;

    dom.statTotal.textContent = total;
    dom.statOnline.textContent = online;
    dom.statTimeout.textContent = timeout;

    dom.countAll.textContent = total;
    dom.countOnline.textContent = online;
    dom.countOffline.textContent = timeout;

    if (dom.catActiveBadge) {
      dom.catActiveBadge.textContent = `${total} 个目标`;
    }

    if (online > 0) {
      const sumLatency = onlineList.reduce((acc, cur) => acc + (cur.latency || 0), 0);
      const avg = Math.round(sumLatency / online);
      dom.statAvg.textContent = `${avg}ms`;
    } else {
      dom.statAvg.textContent = '-';
    }
  }

  function getHostDisplay(url) {
    try {
      const u = new URL(url);
      // 若包含非标准端口 (例如 sub.fapcraft.cf:8888)，完整展示 host:port
      return u.host || u.hostname;
    } catch {
      return url.replace(/^https?:\/\//i, '').split('/')[0] || url;
    }
  }

  /**
   * 生成单张卡片的 HTML 字符串
   */
  function createCardHTML(t) {
    let statusClass = 'ready';
    let badgeHtml = '<span class="status-badge">待测试</span>';

    if (t.status === 'testing') {
      if (t.isRetrying) {
        statusClass = 'status-retrying';
        badgeHtml = '<span class="status-badge retrying"><span class="spin-icon">🔄</span> 重试中</span>';
      } else {
        statusClass = 'status-testing';
        badgeHtml = '<span class="status-badge testing"><span class="spin-icon">⏳</span> 探测中</span>';
      }
    } else if (t.status === 'online') {
      statusClass = 'status-online';
      badgeHtml = `<span class="status-badge online">✅ ${t.latency} ms</span>`;
    } else if (t.status === 'unsupported_ipv6') {
      statusClass = 'status-ipv6-need';
      badgeHtml = `<span class="status-badge status-ipv6-need">⚠️ 需 IPv6 环境</span>`;
    } else if (t.status === 'timeout') {
      statusClass = 'status-timeout';
      badgeHtml = `<span class="status-badge timeout">⏱️ 超时 >${t.latency || state.config.timeout}ms</span>`;
    } else if (t.status === 'blocked') {
      statusClass = 'status-blocked';
      badgeHtml = `<span class="status-badge blocked">🚫 阻断 ${t.latency ? t.latency + 'ms' : ''}</span>`;
    } else if (t.status === 'offline') {
      statusClass = 'status-timeout';
      badgeHtml = `<span class="status-badge timeout">❌ 失败</span>`;
    }

    const host = getHostDisplay(t.url);
    const ipv6TagHtml = t.isIPv6Only ? '<span class="target-ipv6-tag" title="仅支持 IPv6 访问的目标网站">IPv6-Only</span>' : '';

    return `
      <div class="target-card ${statusClass} ${t.enabled === false ? 'disabled' : ''}" id="card-${t.id}" data-id="${t.id}">
        <div class="target-info">
          <div class="target-header">
            <span class="target-name" title="${t.name}">${t.name}</span>
            ${t.group ? `<span class="target-group">${t.group}</span>` : ''}
            ${ipv6TagHtml}
          </div>
          <span class="target-url" title="${t.url}">${host}</span>
          <div class="target-reason" style="font-size:10px;color:var(--text-muted);margin-top:2px;${t.reason ? '' : 'display:none;'}">${t.reason || ''}</div>
        </div>
        <div class="target-meta">
          ${badgeHtml}
          <button class="retest-btn" data-action="retest" data-id="${t.id}" title="单独重新测试此项">
            ↻
          </button>
          <a href="${t.url}" target="_blank" rel="noopener noreferrer" class="retest-btn" title="在新标签页直达目标" style="text-decoration:none;">
            ↗
          </a>
        </div>
      </div>
    `;
  }

  /**
   * 精确更新单个卡片的 DOM 节点，避免全列表重绘抖动
   */
  function updateCardDOM(target) {
    const el = document.getElementById(`card-${target.id}`);
    if (!el) {
      renderAllCards();
      return;
    }

    // 更新状态样式类
    el.className = `target-card ${target.enabled === false ? 'disabled' : ''}`;
    let badgeHtml = '';

    if (target.status === 'testing') {
      if (target.isRetrying) {
        el.classList.add('status-retrying');
        badgeHtml = '<span class="status-badge retrying"><span class="spin-icon">🔄</span> 重试中</span>';
      } else {
        el.classList.add('status-testing');
        badgeHtml = '<span class="status-badge testing"><span class="spin-icon">⏳</span> 探测中</span>';
      }
    } else if (target.status === 'online') {
      el.classList.add('status-online');
      badgeHtml = `<span class="status-badge online">✅ ${target.latency} ms</span>`;
    } else if (target.status === 'unsupported_ipv6') {
      el.classList.add('status-ipv6-need');
      badgeHtml = `<span class="status-badge status-ipv6-need">⚠️ 需 IPv6 环境</span>`;
    } else if (target.status === 'timeout') {
      el.classList.add('status-timeout');
      badgeHtml = `<span class="status-badge timeout">⏱️ 超时 >${target.latency || state.config.timeout}ms</span>`;
    } else if (target.status === 'blocked') {
      el.classList.add('status-blocked');
      badgeHtml = `<span class="status-badge blocked">🚫 阻断 ${target.latency ? target.latency + 'ms' : ''}</span>`;
    } else if (target.status === 'offline') {
      el.classList.add('status-timeout');
      badgeHtml = `<span class="status-badge timeout">❌ 失败</span>`;
    } else {
      badgeHtml = '<span class="status-badge">待测试</span>';
    }

    // 动态同步 IPv6-Only 标签
    const headerEl = el.querySelector('.target-header');
    if (headerEl) {
      let tagEl = headerEl.querySelector('.target-ipv6-tag');
      if (target.isIPv6Only) {
        if (!tagEl) {
          tagEl = document.createElement('span');
          tagEl.className = 'target-ipv6-tag';
          tagEl.title = '仅支持 IPv6 访问的目标网站';
          tagEl.textContent = 'IPv6-Only';
          headerEl.appendChild(tagEl);
        }
      } else if (tagEl) {
        tagEl.remove();
      }
    }

    // 更新内容
    const metaContainer = el.querySelector('.target-meta');
    if (metaContainer) {
      metaContainer.innerHTML = `
        ${badgeHtml}
        <button class="retest-btn" data-action="retest" data-id="${target.id}" title="单独重新测试此项">
          ↻
        </button>
        <a href="${target.url}" target="_blank" rel="noopener noreferrer" class="retest-btn" title="在新标签页直达目标" style="text-decoration:none;">
          ↗
        </a>
      `;
    }

    // 更新原因提示信息
    let reasonEl = el.querySelector('.target-reason');
    if (!reasonEl) {
      const infoContainer = el.querySelector('.target-info');
      if (infoContainer) {
        reasonEl = document.createElement('div');
        reasonEl.className = 'target-reason';
        reasonEl.style.fontSize = '10px';
        reasonEl.style.color = 'var(--text-muted)';
        reasonEl.style.marginTop = '2px';
        infoContainer.appendChild(reasonEl);
      }
    }
    if (reasonEl) {
      if (target.reason) {
        reasonEl.textContent = target.reason;
        reasonEl.style.display = 'block';
      } else {
        reasonEl.style.display = 'none';
      }
    }

    // 根据筛选模式控制显隐
    applyFilterToElement(el, target);
  }

  function applyFilterToElement(el, target) {
    if (state.activeFilter === 'online') {
      el.style.display = target.status === 'online' ? 'flex' : 'none';
    } else if (state.activeFilter === 'offline') {
      const isBad = target.status === 'timeout' || target.status === 'blocked' || target.status === 'offline' || target.status === 'unsupported_ipv6';
      el.style.display = isBad ? 'flex' : 'none';
    } else {
      el.style.display = 'flex';
    }
  }

  function renderAllCards() {
    let list = getActiveCategoryTargets();

    if (state.isSortedByLatency) {
      list.sort((a, b) => {
        if (a.status === 'online' && b.status === 'online') {
          return (a.latency || 99999) - (b.latency || 99999);
        }
        if (a.status === 'online') return -1;
        if (b.status === 'online') return 1;
        return 0;
      });
    }

    if (list.length === 0) {
      if (state.activeCategory === 'custom') {
        dom.targetList.innerHTML = `
          <div class="empty-state">
            <div class="icon">🛠️</div>
            <div style="font-weight:600;margin-bottom:6px;color:#f8fafc;">暂无自定义网址</div>
            <div style="font-size:12px;margin-bottom:14px;color:var(--text-muted);">您可以点击下方按钮添加或批量导入您的专属测速目标</div>
            <button id="btn-empty-add" class="btn-primary" style="margin:0 auto;display:inline-flex;padding:8px 18px;min-height:38px;font-size:13px;">
              ➕ 立即添加自定义网址
            </button>
          </div>
        `;
        const btnEmpty = document.getElementById('btn-empty-add');
        if (btnEmpty) {
          btnEmpty.addEventListener('click', () => {
            switchImportTab(dom.tabAddBatch, dom.panelAddBatch);
            openModal(dom.modalImport);
          });
        }
      } else {
        dom.targetList.innerHTML = `
          <div class="empty-state">
            <div class="icon">📭</div>
            <div>此分类下暂无网址目标</div>
          </div>
        `;
      }
      updateDashboard();
      return;
    }

    dom.targetList.innerHTML = list.map(t => createCardHTML(t)).join('');

    // 应用筛选显隐
    list.forEach(t => {
      const el = document.getElementById(`card-${t.id}`);
      if (el) applyFilterToElement(el, t);
    });

    updateDashboard();
  }

  // ================= 目标管理与本地存储 =================

  async function loadTargets() {
    const TARGETS_VERSION = '1.6.0';
    const localVer = localStorage.getItem('net_reachability_version');

    // 优先从 LocalStorage 读取用户自定制数据
    let loadedTargets = null;
    const saved = localStorage.getItem(STORAGE_KEYS.TARGETS);
    if (saved && localVer === TARGETS_VERSION) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          loadedTargets = parsed;
        }
      } catch (e) {
        console.error('Failed to parse local targets:', e);
      }
    }

    // 若无本地缓存或版本升级，拉取最新的 targets.json (v1.5.0)
    if (!loadedTargets) {
      try {
        const resp = await fetch('targets.json?_v=' + Date.now());
        if (resp.ok) {
          const data = await resp.json();
          let newTargets = data.targets || [];
          if (saved) {
            try {
              const oldTargets = JSON.parse(saved);
              const userCustomTargets = oldTargets.filter(t => (t.category || 'custom') === 'custom');
              if (userCustomTargets.length > 0) {
                // 保留用户旧自定义项，同时补充 targets.json 中新增的官方默认自定义项 (如 GitHub 加速)
                const existingUrls = new Set(userCustomTargets.map(t => t.url));
                const newCustomDefaults = newTargets.filter(t => (t.category || 'custom') === 'custom' && !existingUrls.has(t.url));
                const mergedCustom = [...userCustomTargets, ...newCustomDefaults];
                const nonCustomNew = newTargets.filter(t => (t.category || 'custom') !== 'custom');
                newTargets = mergedCustom.concat(nonCustomNew);
              }
            } catch (e) {}
          }
          loadedTargets = newTargets;
          localStorage.setItem('net_reachability_version', data.version || TARGETS_VERSION);
        } else {
          throw new Error('HTTP ' + resp.status);
        }
      } catch (e) {
        console.warn('Cannot fetch targets.json, fallback to built-in:', e);
        loadedTargets = [
          { id: 'custom_gh_proxy', name: 'GH-Proxy 加速', group: 'GitHub加速', category: 'custom', url: 'https://gh-proxy.com', enabled: true },
          { id: 'custom_jsdelivr', name: 'jsDelivr 官方CDN', group: 'GitHub加速', category: 'custom', url: 'https://cdn.jsdelivr.net', enabled: true },
          { id: 'custom_jsdmirror', name: 'JSDMirror 镜像加速', group: 'GitHub加速', category: 'custom', url: 'https://cdn.jsdmirror.com', enabled: true },
          { id: 'custom_ghproxy_net', name: 'GHProxy.net 节点', group: 'GitHub加速', category: 'custom', url: 'https://ghproxy.net', enabled: true },
          { id: 'custom_gh_ddlc', name: 'DDLC GitHub 加速', group: 'GitHub加速', category: 'custom', url: 'https://gh.ddlc.top', enabled: true },
          { id: 'custom_outlook', name: 'Outlook 邮箱网页', group: '常用办公', category: 'custom', url: 'https://outlook.live.com/', enabled: true },
          { id: 'custom_wise', name: 'Wise 官网', group: '跨境理财', category: 'custom', url: 'https://wise.com/', enabled: true },
          { id: 'custom_ifast', name: 'iFAST 官网', group: '境外银行', category: 'custom', url: 'https://www.ifastgb.com/', enabled: true },
          { id: 'custom_schwab', name: '嘉信理财', group: '美股券商', category: 'custom', url: 'https://www.schwab.com/', enabled: true },
          { id: 'custom_tradingview', name: 'TradingView', group: '行情看盘', category: 'custom', url: 'https://www.tradingview.com/', enabled: true },
          { id: 'custom_ibkr', name: 'IBKR 盈透证券', group: '美股券商', category: 'custom', url: 'https://www.interactivebrokers.com/', enabled: true },
          { id: 'custom_binance', name: '币安 Binance', group: '加密资产', category: 'custom', url: 'https://www.binance.com/', enabled: true },
          { id: 'custom_htx', name: '火币 HTX', group: '加密资产', category: 'custom', url: 'https://www.htx.com/', enabled: true },
          { id: 'sm_youtube', name: 'YouTube 视频', group: '社交媒体', category: 'overseas', url: 'https://www.youtube.com/', enabled: true },
          { id: 'sm_instagram', name: 'Instagram 社交', group: '社交媒体', category: 'overseas', url: 'https://www.instagram.com/', enabled: true }
        ];
      }
    }

    // 🚀 核心特性：自动检测并载入本地私有配置 targets.local.json (受 .gitignore 保护，绝不上传 GitHub)
    try {
      const localResp = await fetch('targets.local.json?_v=' + Date.now());
      if (localResp.ok) {
        const localData = await localResp.json();
        const privateTargets = localData.custom_targets || localData.targets || [];
        if (Array.isArray(privateTargets) && privateTargets.length > 0) {
          const formattedPrivates = privateTargets.map((t, idx) => ({
            id: t.id || ('priv_' + idx),
            name: t.name,
            group: t.group || '私人服务',
            category: 'custom',
            url: t.url,
            enabled: t.enabled !== false,
            status: 'ready'
          }));

          const privIds = new Set(formattedPrivates.map(p => p.id));
          const privUrls = new Set(formattedPrivates.map(p => p.url));
          const otherTargets = loadedTargets.filter(t => !privIds.has(t.id) && !privUrls.has(t.url));

          const otherCustom = otherTargets.filter(t => (t.category || 'custom') === 'custom');
          const nonCustom = otherTargets.filter(t => (t.category || 'custom') !== 'custom');

          // 将私人网站列表【置顶】在原来的自定义网址列表最上方
          loadedTargets = [...formattedPrivates, ...otherCustom, ...nonCustom];
        }
      }
    } catch {
      // 本地私有文件不存在时静默忽略（适合云端公开部署环境）
    }

    state.targets = loadedTargets || [];
    saveTargets();
    renderAllCards();
    updateDashboard();
  }

  function saveTargets() {
    localStorage.setItem(STORAGE_KEYS.TARGETS, JSON.stringify(state.targets));
  }

  function saveConfig() {
    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(state.config));
  }

  function loadConfig() {
    const saved = localStorage.getItem(STORAGE_KEYS.CONFIG);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // 自动迁移旧版本默认值
        if (parsed.timeout === 3000) {
          parsed.timeout = 5000;
        }
        if (parsed.concurrency === 6) {
          parsed.concurrency = 8;
        }
        state.config = Object.assign({}, DEFAULT_CONFIG, parsed);
        saveConfig();
      } catch (e) {
        state.config = Object.assign({}, DEFAULT_CONFIG);
      }
    }

    // 回填设置表单
    dom.settingTimeout.value = state.config.timeout;
    dom.settingConcurrency.value = state.config.concurrency;
    dom.settingSamples.value = state.config.samples;
    dom.settingAutostart.checked = Boolean(state.config.autostart);

    const savedLast = localStorage.getItem(STORAGE_KEYS.LAST_TIME);
    if (savedLast) {
      dom.lastUpdatedText.textContent = `最后检测时间：今日 ${savedLast}`;
    }
  }

  // ================= 辅助功能：一键复制 / 弹窗 / Toast =================

  function copyReachableUrls() {
    const catName = CATEGORY_META[state.activeCategory].name;
    const reachable = getActiveCategoryTargets()
      .filter(t => t.status === 'online')
      .map(t => `${t.name}: ${t.url} (${t.latency}ms)`);

    if (reachable.length === 0) {
      showToast(`⚠️ 【${catName}】暂无可达网址，请先开始测试`);
      return;
    }

    const text = reachable.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(`📋 已成功复制【${catName}】${reachable.length} 个可用网址到剪贴板`);
      }).catch(() => {
        fallbackCopy(text, reachable.length, catName);
      });
    } else {
      fallbackCopy(text, reachable.length, catName);
    }
  }

  function fallbackCopy(text, count, catName) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(`📋 已成功复制【${catName}】${count} 个可用网址到剪贴板`);
    } catch {
      showToast('❌ 复制失败，请手动选择');
    }
    document.body.removeChild(ta);
  }

  function fallbackCopy(text, count) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(`📋 已成功复制 ${count} 个可用网址到剪贴板`);
    } catch {
      showToast('❌ 复制失败，请手动选择');
    }
    document.body.removeChild(ta);
  }

  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s, transform 0.3s';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-8px)';
      setTimeout(() => toast.remove(), 300);
    }, 2400);
  }

  function openModal(modalEl) {
    modalEl.classList.add('show');
  }

  function closeModal(modalEl) {
    modalEl.classList.remove('show');
  }

  // ================= 事件绑定初始化 =================

  function initEvents() {
    // 本地网络 IPv6 诊断刷新
    if (dom.netEnvBadge) {
      dom.netEnvBadge.addEventListener('click', () => {
        showToast('正在重新诊断本地网络 IPv6 连通性...', 'info');
        checkLocalIPv6(true);
      });
    }

    // 主控按钮：批量测试/停止
    dom.btnTestAll.addEventListener('click', () => {
      runBatchTests();
    });

    // 复制可用
    dom.btnCopyReachable.addEventListener('click', () => {
      copyReachableUrls();
    });

    // 延迟升序排序切换
    dom.btnSort.addEventListener('click', () => {
      state.isSortedByLatency = !state.isSortedByLatency;
      dom.btnSort.style.color = state.isSortedByLatency ? '#60a5fa' : 'var(--text-secondary)';
      dom.btnSort.style.borderColor = state.isSortedByLatency ? 'rgba(59,130,246,0.5)' : 'var(--border-color)';
      renderAllCards();
      showToast(state.isSortedByLatency ? '📶 已按延迟升序排序' : '📶 已恢复默认排序');
    });

    // 筛选 Pills 切换
    dom.pills.forEach(pill => {
      pill.addEventListener('click', () => {
        dom.pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.activeFilter = pill.getAttribute('data-filter');

        state.targets.forEach(t => {
          const el = document.getElementById(`card-${t.id}`);
          if (el) applyFilterToElement(el, t);
        });
      });
    });

    // 单项重测事件委托
    dom.targetList.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action="retest"]');
      if (btn) {
        const id = btn.getAttribute('data-id');
        retestSingleTarget(id);
      }
    });

    // 弹窗开关
    dom.btnOpenSettings.addEventListener('click', () => openModal(dom.modalSettings));
    dom.btnOpenImport.addEventListener('click', () => openModal(dom.modalImport));

    document.querySelectorAll('.modal-close, [data-close]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = btn.getAttribute('data-close');
        if (targetId) {
          closeModal(document.getElementById(targetId));
        } else {
          const m = btn.closest('.modal-overlay');
          if (m) closeModal(m);
        }
      });
    });

    // 点击遮罩外部关闭
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal(overlay);
      });
    });

    // 设置项实时变动保存
    dom.settingTimeout.addEventListener('change', (e) => {
      state.config.timeout = parseInt(e.target.value, 10);
      saveConfig();
    });
    dom.settingConcurrency.addEventListener('change', (e) => {
      state.config.concurrency = parseInt(e.target.value, 10);
      saveConfig();
    });
    dom.settingSamples.addEventListener('change', (e) => {
      state.config.samples = parseInt(e.target.value, 10);
      saveConfig();
    });
    dom.settingAutostart.addEventListener('change', (e) => {
      state.config.autostart = e.target.checked;
      saveConfig();
    });

    // ================= 分类下拉长条菜单交互 =================

    if (dom.categoryBar) {
      dom.categoryBar.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dom.categoryMenu.classList.contains('show');
        if (isOpen) {
          dom.categoryMenu.classList.remove('show');
          dom.categoryBar.classList.remove('open');
          dom.categoryBar.setAttribute('aria-expanded', 'false');
        } else {
          dom.categoryMenu.classList.add('show');
          dom.categoryBar.classList.add('open');
          dom.categoryBar.setAttribute('aria-expanded', 'true');
        }
      });
    }

    dom.catMenuItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const cat = item.getAttribute('data-cat');
        if (!cat) return;

        state.activeCategory = cat;
        dom.catMenuItems.forEach(mi => mi.classList.remove('active'));
        item.classList.add('active');

        if (dom.catActiveIcon) dom.catActiveIcon.textContent = CATEGORY_META[cat].icon;
        if (dom.catActiveName) dom.catActiveName.textContent = CATEGORY_META[cat].name;
        dom.btnTestText.textContent = `开始批量测试全部`;

        dom.categoryMenu.classList.remove('show');
        dom.categoryBar.classList.remove('open');
        dom.categoryBar.setAttribute('aria-expanded', 'false');

        renderAllCards();
        updateDashboard();
        showToast(`🔀 已切换至【${CATEGORY_META[cat].name}】`);
      });
    });

    document.addEventListener('click', (e) => {
      if (dom.categoryBar && dom.categoryMenu) {
        if (!dom.categoryBar.contains(e.target) && !dom.categoryMenu.contains(e.target)) {
          dom.categoryMenu.classList.remove('show');
          dom.categoryBar.classList.remove('open');
          dom.categoryBar.setAttribute('aria-expanded', 'false');
        }
      }
    });

    // ================= 目标管理与排序面板渲染 =================

    function renderManageList() {
      if (!dom.manageItemsContainer) return;
      const list = getActiveCategoryTargets();
      const catName = CATEGORY_META[state.activeCategory].name;

      if (list.length === 0) {
        dom.manageItemsContainer.innerHTML = `
          <div style="text-align:center;padding:24px 10px;color:var(--text-muted);font-size:13px;">
            【${catName}】下当前无目标，请切换到“批量导入”或“单个添加”
          </div>
        `;
        return;
      }

      dom.manageItemsContainer.innerHTML = list.map((t, idx) => {
        const isFirst = idx === 0;
        const isLast = idx === list.length - 1;
        const host = getHostDisplay(t.url);

        return `
          <div class="manage-item" data-id="${t.id}" data-index="${idx}">
            <div class="manage-item-info">
              <span class="manage-item-idx">#${idx + 1}</span>
              <input type="checkbox" class="target-enable-toggle" data-index="${idx}" ${t.enabled !== false ? 'checked' : ''} title="勾选启用/取消禁用" style="accent-color:#10b981;cursor:pointer;">
              <div class="manage-item-text">
                <div class="manage-item-name">${t.name}</div>
                <span class="manage-item-url">${host}</span>
              </div>
            </div>
            <div class="manage-item-actions">
              <button class="order-btn" data-action="move-up" data-index="${idx}" ${isFirst ? 'disabled' : ''} title="向上移一位">
                ▲
              </button>
              <button class="order-btn" data-action="move-down" data-index="${idx}" ${isLast ? 'disabled' : ''} title="向下移一位">
                ▼
              </button>
              <button class="order-btn del-btn" data-action="delete-item" data-index="${idx}" title="删除此目标">
                ✕
              </button>
            </div>
          </div>
        `;
      }).join('');
    }

    // 目标管理列表内的操作（上移、下移、删除、勾选）
    dom.manageItemsContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const idx = parseInt(btn.getAttribute('data-index'), 10);
      if (isNaN(idx)) return;

      const catList = getActiveCategoryTargets();
      if (action === 'move-up' && idx > 0) {
        const itemA = catList[idx];
        const itemB = catList[idx - 1];
        const realIdxA = state.targets.indexOf(itemA);
        const realIdxB = state.targets.indexOf(itemB);
        if (realIdxA !== -1 && realIdxB !== -1) {
          state.targets[realIdxA] = itemB;
          state.targets[realIdxB] = itemA;
          saveTargets();
          renderManageList();
          renderAllCards();
          showToast(`▲ 已将【${itemA.name}】上移至第 ${idx} 位`);
        }
      } else if (action === 'move-down' && idx < catList.length - 1) {
        const itemA = catList[idx];
        const itemB = catList[idx + 1];
        const realIdxA = state.targets.indexOf(itemA);
        const realIdxB = state.targets.indexOf(itemB);
        if (realIdxA !== -1 && realIdxB !== -1) {
          state.targets[realIdxA] = itemB;
          state.targets[realIdxB] = itemA;
          saveTargets();
          renderManageList();
          renderAllCards();
          showToast(`▼ 已将【${itemA.name}】下移至第 ${idx + 2} 位`);
        }
      } else if (action === 'delete-item') {
        const item = catList[idx];
        const realIdx = state.targets.indexOf(item);
        if (realIdx !== -1) {
          state.targets.splice(realIdx, 1);
          saveTargets();
          renderManageList();
          renderAllCards();
          showToast(`🗑️ 已移除【${item.name}】`);
        }
      }
    });

    dom.manageItemsContainer.addEventListener('change', (e) => {
      if (e.target.classList.contains('target-enable-toggle')) {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        const catList = getActiveCategoryTargets();
        const item = catList[idx];
        if (item) {
          item.enabled = e.target.checked;
          saveTargets();
          renderAllCards();
        }
      }
    });

    // 导出当前排序列表为 targets.json 文件
    dom.btnExportJson.addEventListener('click', () => {
      const exportData = {
        version: '1.1.0',
        targets: state.targets.map(t => ({
          id: t.id,
          name: t.name,
          group: t.group || '常用',
          category: t.category || 'custom',
          url: t.url,
          enabled: t.enabled !== false
        }))
      };
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'targets.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('💾 已下载 targets.json，可直接替换项目默认配置！');
    });

    // 弹窗 Tab 切换逻辑
    function switchImportTab(activeTab, activePanel) {
      [dom.tabManageList, dom.tabAddBatch, dom.tabAddSingle].forEach(t => t.classList.remove('active'));
      [dom.panelManageList, dom.panelAddBatch, dom.panelAddSingle].forEach(p => p.style.display = 'none');
      activeTab.classList.add('active');
      activePanel.style.display = 'block';
    }

    dom.tabManageList.addEventListener('click', () => {
      switchImportTab(dom.tabManageList, dom.panelManageList);
      renderManageList();
    });

    dom.tabAddBatch.addEventListener('click', () => {
      switchImportTab(dom.tabAddBatch, dom.panelAddBatch);
    });

    dom.tabAddSingle.addEventListener('click', () => {
      switchImportTab(dom.tabAddSingle, dom.panelAddSingle);
    });

    // 点击右上角 ➕ 弹窗时，默认渲染当前分类的管理列表
    dom.btnOpenImport.addEventListener('click', () => {
      switchImportTab(dom.tabManageList, dom.panelManageList);
      renderManageList();
      openModal(dom.modalImport);
    });

    // 单个保存
    dom.btnSaveSingle.addEventListener('click', () => {
      const name = dom.inputTargetName.value.trim();
      let url = dom.inputTargetUrl.value.trim();
      const group = dom.inputTargetGroup.value.trim() || '自定义';
      const insertPos = dom.selectInsertPos ? dom.selectInsertPos.value : 'bottom';

      if (!url) {
        showToast('❌ 请填写目标网址 URL');
        return;
      }
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }

      const newTarget = {
        id: 'custom_' + Date.now(),
        name: name || getHostDisplay(url),
        group: group,
        category: state.activeCategory || 'custom',
        url: url,
        enabled: true,
        status: 'ready'
      };

      if (insertPos === 'top') {
        state.targets.unshift(newTarget);
        showToast(`➕ 成功添加并置顶：${newTarget.name}`);
      } else {
        state.targets.push(newTarget);
        showToast(`➕ 成功添加到末尾：${newTarget.name}`);
      }

      saveTargets();
      renderAllCards();
      renderManageList();
      closeModal(dom.modalImport);
      dom.inputTargetName.value = '';
      dom.inputTargetUrl.value = '';
    });

    // 批量导入 / 替换当前分类
    dom.btnSaveBatch.addEventListener('click', () => {
      const text = dom.textareaBatchUrls.value.trim();
      if (!text) {
        showToast('❌ 请先粘贴网址列表');
        return;
      }

      const modeRadio = document.querySelector('input[name="batch-mode"]:checked');
      const isReplace = modeRadio && modeRadio.value === 'replace';

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      const parsedTargets = [];
      const currentCat = state.activeCategory || 'custom';
      const catName = CATEGORY_META[currentCat].name;

      lines.forEach((line, idx) => {
        let name = '';
        let url = line;

        // 智能提取带端口的 URL (如 https://sub.fapcraft.cf:8888 或 sub.fapcraft.cf:8888)
        const tokens = line.split(/\s+/);
        const urlIndex = tokens.findIndex(t => t.startsWith('http://') || t.startsWith('https://') || /:\d{2,5}/.test(t));
        if (urlIndex !== -1) {
          url = tokens[urlIndex];
          name = tokens.slice(0, urlIndex).join(' ').trim();
          if (!name && urlIndex + 1 < tokens.length) {
            name = tokens.slice(urlIndex + 1).join(' ').trim();
          }
        } else if (line.includes(',')) {
          const parts = line.split(',');
          name = parts[0].trim();
          url = parts.slice(1).join(',').trim();
        } else if (tokens.length >= 2) {
          url = tokens[tokens.length - 1];
          name = tokens.slice(0, tokens.length - 1).join(' ');
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          url = 'https://' + url;
        }

        parsedTargets.push({
          id: 'custom_' + Date.now() + '_' + idx,
          name: name || getHostDisplay(url),
          group: currentCat === 'custom' ? (url.includes(':') ? '端口服务' : '自选常用') : (currentCat === 'domestic' ? '国内源' : '国外'),
          category: currentCat,
          url: url,
          enabled: true,
          status: 'ready'
        });
      });

      if (parsedTargets.length === 0) {
        showToast('❌ 未识别到有效网址');
        return;
      }

      if (isReplace) {
        // 仅覆盖当前激活的分类，不影响其他分类！
        state.targets = state.targets.filter(t => (t.category || 'custom') !== currentCat).concat(parsedTargets);
        showToast(`📥 成功覆盖！【${catName}】已按顺序保存 ${parsedTargets.length} 个目标`);
      } else {
        state.targets.push(...parsedTargets);
        showToast(`📥 已在【${catName}】末尾追加 ${parsedTargets.length} 个目标`);
      }

      saveTargets();
      renderAllCards();
      renderManageList();
      closeModal(dom.modalImport);
      dom.textareaBatchUrls.value = '';
    });

    // 重置为默认 targets.json
    dom.btnResetDefaults.addEventListener('click', async () => {
      if (confirm('确定要清除自定义并恢复为预置默认目标吗？')) {
        localStorage.removeItem(STORAGE_KEYS.TARGETS);
        await loadTargets();
        renderManageList();
        closeModal(dom.modalImport);
        showToast('🔄 已恢复为初始预置目标');
      }
    });

    // 安全鉴权表单提交
    if (dom.authForm) {
      dom.authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pwd = (dom.inputAuthPassword ? dom.inputAuthPassword.value : '').trim();
        if (!pwd) {
          if (dom.authErrorMsg) {
            dom.authErrorMsg.textContent = '请输入站点访问密码';
            dom.authErrorMsg.style.display = 'block';
          }
          return;
        }

        if (dom.btnAuthSubmit) {
          dom.btnAuthSubmit.disabled = true;
          dom.btnAuthSubmit.innerHTML = '<span>⏳ 正在验证...</span>';
        }

        const isValid = await AuthManager.verifyPassword(pwd);

        if (dom.btnAuthSubmit) {
          dom.btnAuthSubmit.disabled = false;
          dom.btnAuthSubmit.innerHTML = '<span>🚀 验证并进入网站</span>';
        }

        if (isValid) {
          showToast('🔓 验证成功，欢迎访问');
          AuthManager.unlockSiteUI();
          await loadTargets();
          if (state.config.autostart) {
            setTimeout(() => runBatchTests(), 400);
          }
        } else {
          if (dom.authErrorMsg) {
            dom.authErrorMsg.textContent = '❌ 密码错误，请重新输入';
            dom.authErrorMsg.style.display = 'block';
          }
          if (dom.authCard) {
            dom.authCard.classList.remove('shake');
            void dom.authCard.offsetWidth; // 触发回流重绘
            dom.authCard.classList.add('shake');
            setTimeout(() => dom.authCard.classList.remove('shake'), 500);
          }
          if (dom.inputAuthPassword) {
            dom.inputAuthPassword.value = '';
            dom.inputAuthPassword.focus();
          }
        }
      });
    }

    // 密码显隐切换按钮
    if (dom.btnTogglePassword && dom.inputAuthPassword) {
      dom.btnTogglePassword.addEventListener('click', () => {
        const isPassword = dom.inputAuthPassword.type === 'password';
        dom.inputAuthPassword.type = isPassword ? 'text' : 'password';
        if (dom.eyeIcon) {
          dom.eyeIcon.textContent = isPassword ? '🙈' : '👁️';
        }
      });
    }

    // 锁定与退出按钮
    if (dom.btnLockSite) {
      dom.btnLockSite.addEventListener('click', () => {
        if (confirm('确定要锁定网站并退出访问吗？')) {
          AuthManager.lockSite();
          showToast('🔒 站点已重新锁定');
        }
      });
    }
  }

  // ================= 启动引导 =================

  async function initAuth() {
    await AuthManager.init();

    if (!AuthManager.isProtected()) {
      // 未配置密码保护：保持公开免密运行
      if (dom.btnLockSite) dom.btnLockSite.style.display = 'none';
      if (dom.modalAuth) dom.modalAuth.style.display = 'none';
      if (dom.appContainer) dom.appContainer.classList.remove('auth-locked');
      await loadTargets();
      if (state.config.autostart) {
        setTimeout(() => runBatchTests(), 500);
      }
      return;
    }

    // 配置了密码保护：
    if (dom.btnLockSite) dom.btnLockSite.style.display = 'flex';

    if (AuthManager.isAuthenticated()) {
      // 已在有效期内免密通过验证
      AuthManager.unlockSiteUI();
      await loadTargets();
      if (state.config.autostart) {
        setTimeout(() => runBatchTests(), 500);
      }
    } else {
      // 未通过验证：【严格前置隔离】
      // 1. 绝不调用 loadTargets()
      // 2. 绝不在页面 DOM 渲染测试网址与卡片
      // 3. 绝不发起自动批量测速
      AuthManager.lockSite();
    }
  }

  async function bootstrap() {
    loadConfig();
    initEvents();
    // 页面加载后立即在后台静默发起本地 IPv6 连通性诊断 (0 阻塞，与鉴权和加载并行)
    checkLocalIPv6();
    await initAuth();

    // 注册 PWA Service Worker (若支持)
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // 页面就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
