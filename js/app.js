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
    LAST_TIME: 'net_reachability_last_time'
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
    completedCount: 0
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
   * 使用 mode: 'no-cors' 配合时间戳防缓存
   * 由浏览器内核发起真实 TCP 握手与 TLS 交换，支持自定义端口与 Cloudflare Tunnel 域名
   */
  async function probeOnce(url, timeoutMs, externalSignal) {
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

      if (isTimeout) {
        return {
          status: 'timeout',
          latency: elapsed,
          reason: `连接超时 (> ${timeoutMs}ms 无响应)`
        };
      }

      if (externalSignal && externalSignal.aborted) {
        return {
          status: 'ready',
          latency: null,
          reason: '用户手动中止'
        };
      }

      // 深度容错：如果主请求发生异常 (Failed to fetch) 但耗时 > 200ms，说明 TCP/TLS 链路实际已打通，
      // 极大概率是服务端安全策略 (如 Helmet 下发的 Cross-Origin-Resource-Policy: same-origin) 触发了浏览器跨域阻断。
      // 我们向 Cloudflare / 边缘轻量节点 (/cdn-cgi/trace) 触发链路备选探测验证真实连通性
      if (elapsed >= 200 && (!externalSignal || !externalSignal.aborted)) {
        try {
          const u = new URL(url);
          const fallbackUrl = `${u.origin}/cdn-cgi/trace?_probe_ts=${Date.now()}`;
          const fbCtrl = new AbortController();
          const fbTimeout = setTimeout(() => fbCtrl.abort(), Math.min(timeoutMs, 3000));
          const fbT0 = performance.now();
          await fetch(fallbackUrl, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            credentials: 'omit',
            signal: fbCtrl.signal
          });
          clearTimeout(fbTimeout);
          const fbElapsed = Math.round(performance.now() - fbT0);
          return {
            status: 'online',
            latency: Math.max(1, fbElapsed),
            reason: '连接成功 (主路径受CORP跨域保护，边缘链路已通)'
          };
        } catch {
          // 备选路径亦失败，继续向下判定常规错误
        }
      }

      // 诊断：若在极短时间内 (如 < 250ms) 立即报错失败，通常为防火墙拦截、TCP RST 重置、端口未开放或 DNS 污染
      if (elapsed < 250) {
        return {
          status: 'blocked',
          latency: elapsed,
          reason: '快速拒绝/阻断 (端口未开放/TCP RST/DNS污染)'
        };
      }

      // 其他网络错误 (如证书异常、自定义端口未开通或 SSL 未信任等)
      let failureReason = err.message || '网络连接异常';
      if (failureReason.includes('Failed to fetch')) {
        failureReason = '连接失败 (证书未信任/端口无响应/网络不可达)';
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
      const res = await probeOnce(target.url, timeoutMs, externalSignal);

      // 方案 A：仅针对超时 (timeout) 自动重试 1 次（过滤瞬时偶发丢包）
      if (res.status === 'timeout' && (!externalSignal || !externalSignal.aborted)) {
        target.isRetrying = true;
        target.reason = `初次超时(>${timeoutMs}ms)，自动重试中 (2/2)...`;
        updateCardDOM(target);

        // 短暂缓冲 100ms
        await new Promise(r => setTimeout(r, 100));

        if (!externalSignal || !externalSignal.aborted) {
          const retryRes = await probeOnce(target.url, timeoutMs, externalSignal);
          target.isRetrying = false;
          if (retryRes.status === 'online') {
            retryRes.reason = `重试成功连通 (${retryRes.latency}ms)`;
            return retryRes;
          }
          if (retryRes.status === 'timeout') {
            retryRes.reason = `连接超时 (重试2次均 >${timeoutMs}ms 无响应)`;
            return retryRes;
          }
          return retryRes;
        }
      }

      target.isRetrying = false;
      return res;
    }

    // 精准模式：连续采样 3 次
    const results = [];
    for (let i = 0; i < sampleCount; i++) {
      if (externalSignal && externalSignal.aborted) break;
      const res = await probeOnce(target.url, timeoutMs, externalSignal);
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
      return onlineResults[mid];
    } else {
      // 全失败，返回最后一个失败结果
      const last = results[results.length - 1] || { status: 'offline', latency: null, reason: '采样测试失败' };
      if (results.every(r => r.status === 'timeout')) {
        last.reason = `连接超时 (连续采样${sampleCount}次均无响应)`;
      }
      return last;
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
    const timeout = targets.filter(t => t.status === 'timeout' || t.status === 'blocked' || t.status === 'offline').length;

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

    return `
      <div class="target-card ${statusClass} ${t.enabled === false ? 'disabled' : ''}" id="card-${t.id}" data-id="${t.id}">
        <div class="target-info">
          <div class="target-header">
            <span class="target-name" title="${t.name}">${t.name}</span>
            ${t.group ? `<span class="target-group">${t.group}</span>` : ''}
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
      const isBad = target.status === 'timeout' || target.status === 'blocked' || target.status === 'offline';
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
    const TARGETS_VERSION = '1.4.0';
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

    // 若无本地缓存或版本升级，拉取最新的 targets.json (v1.4.0)
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
                const nonCustomNew = newTargets.filter(t => (t.category || 'custom') !== 'custom');
                newTargets = userCustomTargets.concat(nonCustomNew);
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
  }

  // ================= 启动引导 =================

  async function bootstrap() {
    loadConfig();
    initEvents();
    await loadTargets();

    // 注册 PWA Service Worker (若支持)
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }

    // 需求 4 方式 A：如果开启了进入页面自动检测，则在短暂首屏渲染后自启动
    if (state.config.autostart) {
      setTimeout(() => {
        runBatchTests();
      }, 500);
    }
  }

  // 页面就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
