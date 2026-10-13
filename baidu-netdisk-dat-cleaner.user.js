// ==UserScript==
// @name         百度网盘 .dat 视频批量清理器
// @namespace    https://github.com/EvanLee-yc
// @version      1.1.1
// @description  批量删除百度网盘里的 .dat 视频文件。v1.1 默认改用搜索接口 + 「搜索-删除-再搜索」循环，请求数从「目录数」降到「轮数」，比 v1.0 的全盘遍历快两个数量级；仍保留遍历模式用于获取完整清单。默认试运行。
// @author       Evan
// @match        https://pan.baidu.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ─────────────────────────── v1.1 改了什么 ───────────────────────────
// v1.0 用 /api/list 逐目录递归：请求数 ≈ 目录数量。
//   如果你有 2 万个目录，就要发 2 万多次请求（每次还有节流），慢是必然的
//   —— 慢的原因是「目录数量」，不是「文件数量」。
//
// v1.1 默认改成 /api/search 按关键词直接定位文件：
//   一轮 = 几次搜索请求 + 几次删除请求，然后删完再搜，让下一批“露出来”。
//   例：3000 个 .dat 文件，遍历法约 2 万次请求；搜索法约 60 次请求。
//
// 代价（必须知道）：搜索模式下列表是「删掉一批才露出下一批」的，
//   所以**看不到完整清单**。要完整清单（用于人工核对）请切到遍历模式。
//
// 其他说明：
// 1) 只调用网盘网页版自己在用的接口（/api/search、/api/list、/api/filemanager），
//    复用当前登录态 Cookie，不涉及第三方登录、不上传任何数据。
// 2) 删除后文件进「回收站」，默认保留约 10 天可恢复。
// 3) 默认 dryRun：只扫描、只列清单、只统计体积，不删任何东西。
// 4) 油猴脚本和控制台粘贴两种用法都行（不依赖任何 GM_ API）。
// 5) 批量删除会被网盘风控拦下并要求「验证身份」（errno 132，一般是手机短信验证码）。
//    脚本不会去绕过它，遇到就停下并在日志里列出 4 个验证入口；
//    你手动过完验证后再点一次「开始删除」即接着删。

(function () {
  'use strict';

  // ======================= 配置区 =======================
  const CONFIG = {
    // ===== 工作模式 =====
    // 'search' = 用搜索接口定位 .dat（快，默认）
    // 'walk'   = 逐目录递归遍历（慢，但能得到完整清单，便于人工核对）
    mode: 'search',

    // 搜索关键词。'.dat' 更精确；如果搜不到东西就改成 'dat'
    // （本地仍会按扩展名二次过滤，所以放宽关键词不会误删）
    searchKey: '.dat',

    // 搜索单页条数 / 单轮最多翻几页（5 × 100 = 500，与网页版搜索显示上限一致）
    searchPageSize: 100,
    searchMaxPages: 5,

    // 搜索排序：'time' 或 'name'。若某个窗口反复卡在已删文件上，换个排序能看到不同结果
    searchSort: 'time',

    // 追加到 /api/search 上的额外查询参数。
    // 用途：把搜索限定在某个分类里（例如网盘的「视频」分类）。
    // 默认留空 —— 因为脚本已经用 category === 1 在本地做了等价过滤，
    // 只删视频这件事不依赖这个参数。
    // 如果你想让搜索窗口 100% 被视频占满（少跑几轮），可以这样填：
    //   searchExtraParams: { category: '1' }
    // 具体参数名以你自己浏览器的实际请求为准：
    //   F12 → Network → 在「视频」分类里搜索一次 → 点开 /api/search 请求看参数。
    searchExtraParams: {},

    // 「搜索-删除-再搜索」的最大轮数
    maxRounds: 200,

    // 某一轮没有新命中时：等待多久（等搜索索引刷新）
    noProgressWaitMs: 5000,

    // 一轮删完后，等多久再开始下一轮搜索。给搜索索引一点刷新时间，少白跑一轮
    postDeleteWaitMs: 3000,

    // 兜底：当搜索窗口被「删不掉的文件」占满、彻底搜不动时，
    // 是否自动切到遍历模式把剩下的收尾（遍历模式可能很慢，所以默认关闭）
    autoFallbackToWalk: false,

    // ===== 筛选规则 =====
    // 起始目录，'/' 表示整个网盘（遍历模式的起点；搜索模式用 recursion=1 全盘搜）
    rootDir: '/',

    // 要清理的扩展名（不区分大小写）
    ext: '.dat',

    // true = 只删网盘判定为「视频」的文件（返回字段 category === 1）
    onlyCategoryVideo: true,

    // 体积下限（字节）。0 表示不限
    minSize: 0,

    // 路径黑名单：路径里包含任意一个字符串就跳过
    excludePaths: [],

    // true = 只扫描不删除（控制台调用 bdcl.run() 时的默认值；
    //        面板上的「开始删除」是强制执行，但一定会弹确认框）
    dryRun: true,

    // ===== 删除参数 =====
    // 单次删除请求携带的文件数。遇到「一次操作文件不可超过 100 个」会自动拆半重试
    batchSize: 100,

    // 每个删除批次之间的间隔（毫秒）。调太小容易触发风控
    batchDelayMs: 800,

    // 单次运行最多删多少个（安全阀）
    maxFilesPerRun: 50000,

    // ===== 遍历模式参数 =====
    // 列表接口单页条数，最大 1000
    pageSize: 1000,

    // 递归深度上限
    maxDepth: 64,

    // 列表请求失败重试次数
    listRetry: 3,

    // 删除请求失败重试次数
    deleteRetry: 3,

    // 异步删除的任务轮询间隔
    pollInterval: 3000,

    // 是否显示悬浮面板
    showPanel: true,
  };
  // =====================================================

  const API_LIST = 'https://pan.baidu.com/api/list';
  const API_SEARCH = 'https://pan.baidu.com/api/search';
  const API_FM = 'https://pan.baidu.com/api/filemanager';
  const API_TASK = 'https://pan.baidu.com/share/taskquery';
  const APP_ID = '250528';

  // category: 1=视频 2=音频 3=图片 4=文档 5=应用 6=其他 7=种子
  const CATEGORY_NAME = {
    1: '视频', 2: '音频', 3: '图片', 4: '文档',
    5: '应用', 6: '其他', 7: '种子',
  };

  const state = {
    running: false,
    aborted: false,
    bdstoken: '',
    mode: '',
    rounds: 0,
    apiCalls: 0,
    startTs: 0,
    scannedDirs: 0,
    scannedFiles: 0,
    matched: [],          // 累计命中的文件 {path, name, size, category}
    skippedByCategory: 0,
    deleted: [],
    deleteFailed: [],
    totalBytes: 0,
    stopReason: '',
    starvation: false,     // 搜索窗口被「删不掉的文件」占满
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function fmtDuration(ms) {
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' 秒';
    return Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
  }

  // ======================= 日志 / UI =======================
  const logEl = () => document.getElementById('bdcl-log');

  function log(msg, level) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (level === 'err') console.error('[bdcl]', msg);
    else if (level === 'warn') console.warn('[bdcl]', msg);
    else console.log('[bdcl]', msg);
    const el = logEl();
    if (el) {
      const div = document.createElement('div');
      div.textContent = line;
      if (level === 'err') div.style.color = '#ff6b6b';
      else if (level === 'warn') div.style.color = '#ffd166';
      else if (level === 'ok') div.style.color = '#6bff9e';
      el.appendChild(div);
      el.scrollTop = el.scrollHeight;
      while (el.childNodes.length > 800) el.removeChild(el.firstChild);
    }
  }

  function refreshStats() {
    const el = document.getElementById('bdcl-stats');
    if (!el) return;
    const dur = state.startTs ? fmtDuration(Date.now() - state.startTs) : '—';
    const rate = state.apiCalls && state.startTs
      ? (state.apiCalls / Math.max(1, (Date.now() - state.startTs) / 1000)).toFixed(1)
      : '—';
    el.innerHTML = `
      模式：<b>${state.mode || CONFIG.mode}</b>　轮次：<b>${state.rounds}</b>　
      API 请求：<b>${state.apiCalls}</b> 次（${rate}/秒）　耗时：<b>${dur}</b><br>
      ${state.mode === 'walk'
        ? `已扫描目录：<b>${state.scannedDirs}</b>　文件：<b>${state.scannedFiles}</b><br>`
        : ''}
      命中 .dat：<b style="color:#ff7b72">${state.matched.length}</b> 个　
      合计 <b>${fmtSize(state.totalBytes)}</b><br>
      因非视频跳过：<b>${state.skippedByCategory}</b>　
      已删除：<b style="color:#6bff9e">${state.deleted.length}</b>　
      失败：<b style="color:#ffd166">${state.deleteFailed.length}</b>
    `;
  }

  function buildPanel() {
    if (!CONFIG.showPanel || document.getElementById('bdcl-panel')) return;
    const p = document.createElement('div');
    p.id = 'bdcl-panel';
    p.style.cssText = `
      position:fixed;right:16px;bottom:16px;z-index:999999;width:420px;
      background:#1f2126;color:#e6e6e6;border:1px solid #3a3d44;border-radius:10px;
      font:12px/1.6 -apple-system,Menlo,monospace;box-shadow:0 8px 28px rgba(0,0,0,.5);
    `;
    p.innerHTML = `
      <div id="bdcl-head" style="padding:8px 10px;background:#2a2d34;border-radius:10px 10px 0 0;
           display:flex;justify-content:space-between;align-items:center;cursor:move;">
        <span style="font-weight:600">百度网盘 .dat 清理器 <span style="color:#8b8f98">v1.1.1</span></span>
        <span>
          <button id="bdcl-min" style="background:none;border:none;color:#8b8f98;cursor:pointer">—</button>
          <button id="bdcl-close" style="background:none;border:none;color:#8b8f98;cursor:pointer">×</button>
        </span>
      </div>
      <div id="bdcl-body" style="padding:10px">
        <div id="bdcl-stats" style="margin-bottom:8px;color:#c9ccd4"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center">
          <select id="bdcl-mode" class="bdcl-btn" style="padding:4px 6px">
            <option value="search">搜索模式（快）</option>
            <option value="walk">遍历模式（完整清单）</option>
          </select>
          <button id="bdcl-scan"  class="bdcl-btn">试运行扫描</button>
          <button id="bdcl-del"   class="bdcl-btn">开始删除</button>
          <button id="bdcl-print" class="bdcl-btn">打印清单</button>
          <button id="bdcl-stop"  class="bdcl-btn">停止</button>
          <button id="bdcl-clear" class="bdcl-btn">清空日志</button>
        </div>
        <div style="color:#8b8f98;margin-bottom:4px">
          起始目录 <b>${CONFIG.rootDir}</b>　关键词 <b>${CONFIG.searchKey}</b>　
          扩展名 <b>${CONFIG.ext}</b>　仅视频 <b>${CONFIG.onlyCategoryVideo}</b>
        </div>
        <div id="bdcl-log" style="height:190px;overflow:auto;background:#16181c;border:1px solid #2f323a;
             border-radius:6px;padding:6px;white-space:pre-wrap;word-break:break-all"></div>
      </div>
    `;
    document.body.appendChild(p);

    const st = document.createElement('style');
    st.textContent = `.bdcl-btn{background:#2f323a;color:#e6e6e6;border:1px solid #3f434c;
      border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
      .bdcl-btn:hover{background:#3a3e48}.bdcl-btn:disabled{opacity:.45;cursor:not-allowed}`;
    document.head.appendChild(st);

    const modeSel = document.getElementById('bdcl-mode');
    if (modeSel) {
      modeSel.value = CONFIG.mode;
      modeSel.onchange = () => { CONFIG.mode = modeSel.value; refreshStats(); };
    }
    document.getElementById('bdcl-scan').onclick = () => run(true);
    document.getElementById('bdcl-del').onclick = () => run(false);
    document.getElementById('bdcl-print').onclick = printList;
    document.getElementById('bdcl-stop').onclick = () => {
      state.aborted = true;
      log('已请求停止，将在当前请求结束后退出…', 'warn');
    };
    document.getElementById('bdcl-clear').onclick = () => {
      const el = logEl();
      if (el) el.innerHTML = '';
    };
    document.getElementById('bdcl-min').onclick = () => {
      const b = document.getElementById('bdcl-body');
      b.style.display = b.style.display === 'none' ? '' : 'none';
    };
    document.getElementById('bdcl-close').onclick = () => p.remove();

    let drag = null;
    const head = document.getElementById('bdcl-head');
    head.onmousedown = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { x: e.clientX, y: e.clientY, l: p.offsetLeft, t: p.offsetTop };
    };
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      p.style.left = drag.l + e.clientX - drag.x + 'px';
      p.style.top = drag.t + e.clientY - drag.y + 'px';
      p.style.right = 'auto';
      p.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = null; });

    refreshStats();
  }

  function setButtons(disabled) {
    ['bdcl-scan', 'bdcl-del', 'bdcl-print', 'bdcl-mode'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = disabled;
    });
  }

  // ======================= 带计数的请求 =======================
  async function apiFetch(url, opt) {
    state.apiCalls++;
    return await fetch(url, opt);
  }

  // ======================= 鉴权：拿 bdstoken =======================
  async function getBdstoken() {
    if (state.bdstoken) return state.bdstoken;

    try {
      if (window.locals && typeof window.locals.get === 'function') {
        const t = window.locals.get('bdstoken');
        if (t) return (state.bdstoken = t);
      }
    } catch (e) { /* ignore */ }

    try {
      const url = `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=${APP_ID}` +
        `&web=1&fields=${encodeURIComponent('["bdstoken"]')}`;
      const r = await apiFetch(url, { credentials: 'include' });
      const j = await r.json();
      if (j && j.errno === 0 && j.result && j.result.bdstoken) {
        return (state.bdstoken = j.result.bdstoken);
      }
    } catch (e) { /* ignore */ }

    try {
      const r = await apiFetch('https://pan.baidu.com/disk/home', { credentials: 'include' });
      const html = await r.text();
      const m = html.match(/bdstoken['":\s]+([0-9a-f]{32})/);
      if (m) return (state.bdstoken = m[1]);
    } catch (e) { /* ignore */ }

    return '';
  }

  // ======================= 筛选规则 =======================
  function checkFile(f) {
    const name = f.server_filename || (f.path || '').split('/').pop() || '';
    if (!name.toLowerCase().endsWith(CONFIG.ext.toLowerCase())) return { match: false, reason: 'ext' };
    if ((f.size || 0) < CONFIG.minSize) return { match: false, reason: 'size' };
    if (CONFIG.onlyCategoryVideo && f.category !== 1) return { match: false, reason: 'category' };
    if (CONFIG.excludePaths.some((k) => (f.path || '').includes(k))) return { match: false, reason: 'exclude' };
    return { match: true };
  }

  // ======================= 搜索模式 =======================
  // GET /api/search?recursion=1&page=&num=&key=<关键词>
  // 返回字段与 /api/list 完全一致（含 isdir / category），所以判定逻辑通用。
  async function apiSearch(page) {
    const qs = new URLSearchParams({
      recursion: '1',
      order: CONFIG.searchSort,
      desc: '1',
      showempty: '0',
      web: '1',
      page: String(page),
      num: String(CONFIG.searchPageSize),
      key: CONFIG.searchKey,
      t: String(Date.now()),
      channel: 'chunlei',
      app_id: APP_ID,
      bdstoken: state.bdstoken,
      clienttype: '0',
    });
    // 追加用户配置的额外参数（例如把搜索限定到「视频」分类）
    for (const [k, v] of Object.entries(CONFIG.searchExtraParams || {})) {
      qs.set(k, String(v));
    }
    const res = await apiFetch(`${API_SEARCH}?${qs.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return await res.json();
  }

  // 取一轮搜索结果：翻 searchMaxPages 页，按 path 去重。
  // 返回 { items, full }：
  //   full === true 表示「拿满了一整窗」，也就是搜索结果至少还有 pages × pageSize 条
  //   （可能还有更多被 500 条窗口挡住）——用来区分「真的删完了」和「窗口被占满」。
  async function collectSearchRound(isStale) {
    const out = [];
    const seen = new Set();
    let full = false;
    for (let page = 1; page <= CONFIG.searchMaxPages; page++) {
      if (state.aborted) break;
      let data = null;
      for (let i = 1; i <= CONFIG.listRetry; i++) {
        try {
          data = await apiSearch(page);
          if (data && (data.errno === 0 || data.errno === -9)) break;
          if (data && data.errno === 112) {
            log('bdstoken 已过期，重新获取…', 'warn');
            state.bdstoken = '';
            await getBdstoken();
            continue;
          }
          if (data && data.errno === -6) {
            log('登录态已失效，请刷新页面重新登录。', 'err');
            state.stopReason = '登录态失效';
            state.aborted = true;
            return null;
          }
          log(`搜索失败 page=${page} errno=${data && data.errno}（第 ${i} 次）`, 'warn');
        } catch (e) {
          log(`搜索异常 page=${page}：${e.message}（第 ${i} 次）`, 'warn');
        }
        await sleep(600 * i);
      }
      if (!data) { log(`搜索请求放弃（page=${page}）`, 'err'); break; }
      if (data.errno !== 0) { log(`搜索返回 errno=${data.errno}：${data.errmsg || ''}`, 'err'); break; }

      const list = (data.list || []).filter((f) => !f.isdir);
      for (const f of list) {
        if (!seen.has(f.path)) { seen.add(f.path); out.push(f); }
      }
      if (list.length < CONFIG.searchPageSize) { full = false; break; }
      full = true;   // 这一页是满的 → 结果可能还有更多

      // 省流优化：第 1 页全是「刚刚删过的」文件时，说明索引还没刷新，
      // 后面几页大概率也是同一批，不必翻，省下几次请求，直接进入等待。
      if (page === 1 && isStale && list.every((f) => isStale(f.path))) {
        log('第 1 页全是刚删过的文件（索引尚未刷新），本轮不再翻页。', 'warn');
        break;
      }
      await sleep(150);
    }
    return { items: out, full };
  }

  // 「搜索 → 筛选 → 删除 → 再搜索」循环
  async function runSearchMode(dry) {
    const deletedSet = new Set();     // 已确认删掉的路径（权威的“做完了”集合）
    const matchedSet = new Set();     // 只用于清单去重显示
    const skippedSet = new Set();     // 已计过数的“非视频”路径，避免每轮重复累加
    let round = 0;
    let idleStreak = 0;
    let zeroDeleteStreak = 0;

    while (!state.aborted && round < CONFIG.maxRounds) {
      round++;
      state.rounds = round;

      const res = await collectSearchRound((p) => deletedSet.has(p));
      if (res === null) break;
      const items = res.items;
      const roundFull = res.full;

      const hits = [];
      for (const f of items) {
        const v = checkFile(f);
        if (v.match) hits.push(f);
        else if (v.reason === 'category' && !skippedSet.has(f.path)) {
          skippedSet.add(f.path);
          state.skippedByCategory++;
        }
      }

      // fresh = 还没被删掉的（删除失败的下一轮会被重试）
      const fresh = hits.filter((f) => !deletedSet.has(f.path));
      log(`第 ${round} 轮：搜索返回 ${items.length} 条 → 命中 ${hits.length} 个 → 新文件 ${fresh.length} 个` +
        `（API 请求累计 ${state.apiCalls} 次）`);
      refreshStats();

      if (!fresh.length) {
        // 关键判别：结果已经不足一整窗 → 说明搜索把全部结果都给了我们，确实删完了
        if (!roundFull) {
          log('搜索结果已不足一整窗且没有新文件 → 确认清理完毕。', 'ok');
          break;
        }
        idleStreak++;
        // 阶梯式自救：等索引 → 换排序 → 判定「窗口被占满」
        // （刻意不做「加深分页」这一步：接口超出真实上限后会返回空页，
        //   看起来就像「结果已经取完」，会把「窗口被占满」误判成「已清理完毕」。）
        if (idleStreak === 1) {
          log(`本轮没有新命中，等 ${Math.round(CONFIG.noProgressWaitMs / 1000)} 秒等搜索索引刷新…`, 'warn');
          await sleep(CONFIG.noProgressWaitMs);
          continue;
        }
        if (idleStreak === 2) {
          CONFIG.searchSort = CONFIG.searchSort === 'name' ? 'time' : 'name';
          log(`仍然没有新命中，把搜索排序换成 ${CONFIG.searchSort}，换个结果窗口再看…`, 'warn');
          await sleep(1000);
          continue;
        }
        if (idleStreak === 3) {
          log('搜索窗口里已经没有新的可删文件了。', 'err');
          log('原因通常是：命中结果里混着一批「删不掉的文件」（比如非视频的 .dat），', 'err');
          log('它们把搜索窗口的前排占满了，后面的文件就永远露不出来。', 'err');
          log('建议：① 把 CONFIG.searchExtraParams 填成视频分类参数（对着 F12 里的 /api/search 请求抄）；', 'err');
          log('      ② 或把 CONFIG.autoFallbackToWalk 设为 true，自动用遍历模式收尾；', 'err');
          log('      ③ 或直接用遍历模式跑一遍。', 'err');
          state.stopReason = '搜索窗口被不可删除的文件占满';
          state.starvation = true;
          break;
        }
      }
      idleStreak = 0;

      for (const f of fresh) {
        if (!matchedSet.has(f.path)) {
          matchedSet.add(f.path);
          state.matched.push({
            path: f.path,
            name: f.server_filename || f.path.split('/').pop(),
            size: f.size || 0,
            category: f.category,
          });
          state.totalBytes += f.size || 0;
        }
      }

      if (dry) {
        log('试运行：只看第 1 轮，没有删除任何文件。', 'warn');
        log('注意：搜索模式是「删掉一批才露出下一批」，所以看不到完整清单；', 'warn');
        log('       要完整清单请把模式切到「遍历模式（完整清单）」再扫描。', 'warn');
        break;
      }

      if (state.deleted.length >= CONFIG.maxFilesPerRun) {
        log(`已达 maxFilesPerRun=${CONFIG.maxFilesPerRun}，停止。`, 'warn');
        break;
      }

      const before = state.deleted.length;
      const paths = fresh.map((f) => f.path);
      for (let i = 0; i < paths.length; i += CONFIG.batchSize) {
        if (state.aborted) break;
        const batch = paths.slice(i, i + CONFIG.batchSize);
        log(`第 ${round} 轮：删除 ${i + 1}~${Math.min(i + CONFIG.batchSize, paths.length)} / ${paths.length}` +
          `（累计已删 ${state.deleted.length}）`);
        await doDelete(batch);
        await sleep(CONFIG.batchDelayMs);
      }

      // 只把「确实删成功」的路径记进 deletedSet
      for (const p of state.deleted) deletedSet.add(p);

      if (state.deleted.length === before) {
        zeroDeleteStreak++;
        if (zeroDeleteStreak > 3) {
          log('连续多轮一个都没删成功，停止（避免空转）。请检查日志里的 errno。', 'err');
          state.stopReason = '连续多轮删除全部失败';
          break;
        }
      } else {
        zeroDeleteStreak = 0;
      }

      await sleep(CONFIG.postDeleteWaitMs);
    }

    if (round >= CONFIG.maxRounds) {
      log(`已达 maxRounds=${CONFIG.maxRounds}，停止（可能还有剩余文件，可再次运行）。`, 'warn');
    }
    if (state.stopReason) log(`停止原因：${state.stopReason}`, 'err');
  }

  // ======================= 遍历模式 =======================
  // GET /api/list?dir=&page=&num=1000 —— 单页 1000，翻页直到不足一页；
  // 再对子目录递归。请求数 ≈ 目录数量，慢但能得到完整清单。
  async function apiList(dir, page) {
    const qs = new URLSearchParams({
      order: 'time',
      desc: '1',
      showempty: '0',
      web: '1',
      page: String(page),
      num: String(CONFIG.pageSize),
      dir: dir,
      t: String(Date.now()),
      channel: 'chunlei',
      app_id: APP_ID,
      bdstoken: state.bdstoken,
      clienttype: '0',
    });
    const res = await apiFetch(`${API_LIST}?${qs.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return await res.json();
  }

  async function listAllOfDir(dir) {
    const all = [];
    let page = 1;
    for (;;) {
      if (state.aborted) break;
      let data = null;
      for (let i = 1; i <= CONFIG.listRetry; i++) {
        try {
          data = await apiList(dir, page);
          if (data && (data.errno === 0 || data.errno === -9)) break;
          if (data && data.errno === 112) {
            log('bdstoken 已过期，重新获取…', 'warn');
            state.bdstoken = '';
            await getBdstoken();
            continue;
          }
          if (data && data.errno === -6) {
            log('登录态已失效，请刷新页面重新登录。', 'err');
            state.stopReason = '登录态失效';
            state.aborted = true;
            return null;
          }
          log(`列表失败 ${dir} page=${page} errno=${data && data.errno}（第 ${i} 次）`, 'warn');
        } catch (e) {
          log(`列表异常 ${dir} page=${page}：${e.message}（第 ${i} 次）`, 'warn');
        }
        await sleep(600 * i);
      }
      if (!data) { log(`放弃该目录：${dir}`, 'err'); break; }
      if (data.errno === -9) break;
      if (data.errno !== 0) { log(`列表返回 errno=${data.errno}：${data.errmsg || ''}`, 'err'); break; }

      const list = data.list || [];
      all.push(...list);
      if (list.length < CONFIG.pageSize) break;
      page++;
      await sleep(150);
    }
    return all;
  }

  async function runWalkMode(dry) {
    const queue = [{ dir: CONFIG.rootDir, depth: 0 }];
    // 从已有清单起步，避免和搜索模式的结果重复计数
    const matchedSet = new Set(state.matched.map((x) => x.path));
    // 本次遍历真正发现的文件。删除时只删这一批 ——
    // 不能拿 state.matched 去删，那里面含搜索阶段已经删过的路径，会被重复计入。
    const walkFound = [];

    while (queue.length) {
      if (state.aborted) break;
      const { dir, depth } = queue.shift();
      if (depth > CONFIG.maxDepth) {
        log(`递归超过 ${CONFIG.maxDepth} 层，跳过：${dir}`, 'warn');
        continue;
      }
      const items = await listAllOfDir(dir);
      if (items === null) break;
      state.scannedDirs++;
      let hitHere = 0;

      for (const f of items) {
        if (f.isdir) {
          const sub = f.path;
          if (!CONFIG.excludePaths.some((k) => sub.includes(k))) {
            queue.push({ dir: sub, depth: depth + 1 });
          }
          continue;
        }
        state.scannedFiles++;
        const v = checkFile(f);
        if (v.match) {
          walkFound.push(f.path);
          if (!matchedSet.has(f.path)) {
            matchedSet.add(f.path);
            state.matched.push({
              path: f.path,
              name: f.server_filename || f.path.split('/').pop(),
              size: f.size || 0,
              category: f.category,
            });
            state.totalBytes += f.size || 0;
          }
          hitHere++;
        } else if (v.reason === 'category') {
          state.skippedByCategory++;
        }
      }

      log(`扫描 ${dir} → 子项 ${items.length}，命中 ${hitHere}，待处理目录 ${queue.length}` +
        `（API 请求累计 ${state.apiCalls} 次）`);
      refreshStats();
      await sleep(120);
    }

    log(`扫描结束：目录 ${state.scannedDirs}，文件 ${state.scannedFiles}，` +
      `命中 ${state.matched.length} 个（${fmtSize(state.totalBytes)}）`, 'ok');

    if (!state.matched.length) { log('没有命中任何文件，无需删除。', 'ok'); return; }

    if (dry) {
      log('试运行模式：没有删除任何文件。请点「打印清单」核对，确认无误后再点「开始删除」。', 'warn');
      return;
    }

    const ok = window.confirm(
      `即将删除 ${state.matched.length} 个 .dat 文件，合计 ${fmtSize(state.totalBytes)}。\n\n` +
      `删除后文件会进入「回收站」（约 10 天可恢复）。\n\n确定继续吗？`
    );
    if (!ok) { log('用户取消删除。', 'warn'); return; }

    const targets = walkFound.slice(0, CONFIG.maxFilesPerRun);
    if (targets.length < walkFound.length) {
      log(`超过 maxFilesPerRun=${CONFIG.maxFilesPerRun}，本次只处理前 ${targets.length} 个。`, 'warn');
    }
    for (let i = 0; i < targets.length; i += CONFIG.batchSize) {
      if (state.aborted) break;
      const batch = targets.slice(i, i + CONFIG.batchSize);
      log(`删除进度 ${i + 1}~${Math.min(i + CONFIG.batchSize, targets.length)} / ${targets.length}`);
      await doDelete(batch);
      await sleep(CONFIG.batchDelayMs);
    }
    log(`删除结束：成功 ${state.deleted.length}，失败 ${state.deleteFailed.length}`, 'ok');
    if (state.stopReason) log(`停止原因：${state.stopReason}`, 'err');
  }

  // ======================= 删除 =======================
  // POST /api/filemanager?async=2&opera=delete&onnest=fail&...
  // body: filelist=<URL 编码的 JSON 数组>
  async function deleteBatch(paths) {
    const qs = new URLSearchParams({
      async: '2',
      opera: 'delete',
      onnest: 'fail',
      channel: 'chunlei',
      web: '1',
      app_id: APP_ID,
      bdstoken: state.bdstoken,
      clienttype: '0',
      'dp-logid': String(Date.now()) + '0000',
    });
    const res = await apiFetch(`${API_FM}?${qs.toString()}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: 'filelist=' + encodeURIComponent(JSON.stringify(paths)),
    });
    return await res.json();
  }

  async function pollTask(taskid) {
    for (;;) {
      if (state.aborted) return 'aborted';
      await sleep(CONFIG.pollInterval);
      try {
        const qs = new URLSearchParams({
          taskid: String(taskid),
          channel: 'chunlei',
          web: '1',
          app_id: APP_ID,
          bdstoken: state.bdstoken,
          clienttype: '0',
        });
        const r = await apiFetch(`${API_TASK}?${qs.toString()}`, { credentials: 'include' });
        const j = await r.json();
        const status = (j && (j.status || (j.taskinfo && j.taskinfo[0] && j.taskinfo[0].status))) || '';
        if (status === 'success' || status === 'failed') return status;
      } catch (e) {
        log(`任务状态查询异常：${e.message}`, 'warn');
      }
    }
  }

  async function doDelete(paths) {
    if (!paths.length) return;
    if (paths.length > CONFIG.batchSize) {
      const half = Math.ceil(paths.length / 2);
      await doDelete(paths.slice(0, half));
      await doDelete(paths.slice(half));
      return;
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= CONFIG.deleteRetry; attempt++) {
      if (state.aborted) return;
      try {
        const j = await deleteBatch(paths);
        const errno = j && j.errno;

        if (errno === 0) {
          if (j.taskid) {
            const st = await pollTask(j.taskid);
            if (st === 'failed') log(`任务 ${j.taskid} 状态 failed（文件通常仍已删除）`, 'warn');
          }
          state.deleted.push(...paths);
          refreshStats();
          return;
        }

        if (errno === 3) {
          log(`单次数量超限，拆半重试（${paths.length} → ${Math.ceil(paths.length / 2)}）`, 'warn');
          const half = Math.ceil(paths.length / 2);
          await doDelete(paths.slice(0, half));
          await doDelete(paths.slice(half));
          return;
        }

        if (errno === -9) {
          state.deleted.push(...paths);   // 文件已不存在，视为已删
          refreshStats();
          return;
        }

        if (errno === 112) {
          log('bdstoken 过期，重新获取后重试…', 'warn');
          state.bdstoken = '';
          await getBdstoken();
          continue;
        }

        if (errno === 132) {
          // 网盘风控：批量删除要过身份验证（一般是手机短信验证码）。
          // 验证框由网页版前端弹出，直接调接口只会拿到这个错误码，
          // 没有任何可编程的验证入口 —— 所以脚本只能停下，绝不尝试绕过。
          log('❗ 网盘要求「删除文件需要验证您的身份」，已自动停止。', 'err');
          log('   这个验证框只会出现在网页版界面上，接口调用拿不到，必须手动过一次。', 'err');
          log('   验证入口（任选一个）：', 'err');
          log('     A. 网页版随便勾选一个文件 → 点「删除」→ 弹出提示后点「立即验证」→ 输短信验证码', 'err');
          log('     B. 左侧「回收站」→ 右上角「清空」→ 点「立即验证」→ 输短信验证码', 'err');
          log('     C. 手机百度网盘 App：我的 → 回收站 → 清空 → 立即验证', 'err');
          log('     D. 电脑客户端：头像 → 个人中心 → 账号管理 → 身份验证 → 用手机 App 扫码', 'err');
          log('   验证通过后，直接再点一次「开始删除」就能接着删（已删的不会重复删）。', 'err');
          log('   想少被拦：把 batchSize 调小（如 20）、batchDelayMs 调大（如 5000）。', 'err');
          state.stopReason = '需要身份验证 (errno 132)：请在网页版手动过一次验证，再点「开始删除」继续';
          state.aborted = true;
          return;
        }

        if (errno === 111) {
          log('有未完成的任务在队列里，等 5 秒重试…', 'warn');
          await sleep(5000);
          continue;
        }

        lastErr = `errno=${errno} ${j.errmsg || ''}`;
        log(`删除失败：${lastErr}`, 'warn');
        await sleep(1000 * attempt);
      } catch (e) {
        lastErr = e.message;
        log(`删除请求异常：${e.message}`, 'warn');
        await sleep(1000 * attempt);
      }
    }
    state.deleteFailed.push(...paths);
    refreshStats();
  }

  // ======================= 主流程 =======================
  async function run(forceDry) {
    if (state.running) { log('已有任务在运行。', 'warn'); return; }

    // forceDry === true      → 强制试运行（面板「试运行扫描」按钮）
    // forceDry === false     → 强制执行删除（面板「开始删除」按钮，一定会弹确认框）
    // forceDry === undefined → 按 CONFIG.dryRun（控制台直接调 bdcl.run() 时）
    const dry = forceDry === true ? true : (forceDry === false ? false : CONFIG.dryRun);
    state.running = true;
    state.aborted = false;
    state.stopReason = '';
    state.starvation = false;
    state.mode = CONFIG.mode;
    state.rounds = 0;
    state.apiCalls = 0;
    state.startTs = Date.now();
    state.scannedDirs = 0;
    state.scannedFiles = 0;
    state.matched = [];
    state.skippedByCategory = 0;
    state.deleted = [];
    state.deleteFailed = [];
    state.totalBytes = 0;
    setButtons(true);
    refreshStats();

    try {
      const token = await getBdstoken();
      if (!token) {
        log('拿不到 bdstoken，请确认已登录网盘并停留在 pan.baidu.com 页面上。', 'err');
        return;
      }
      log(`bdstoken 获取成功。模式 = ${CONFIG.mode}` +
        (CONFIG.mode === 'search' ? `，关键词 = "${CONFIG.searchKey}"` : `，起始目录 = ${CONFIG.rootDir}`), 'ok');

      if (CONFIG.mode === 'search') {
        if (!dry) {
          const ok = window.confirm(
            '搜索模式说明：脚本会「搜索一批 → 删除一批 → 再搜索」，逐轮推进，直到搜不到新文件。\n\n' +
            '· 筛选规则：非目录 + 扩展名 ' + CONFIG.ext + ' + ' +
            (CONFIG.onlyCategoryVideo ? '网盘判定为「视频」' : '不限制类型') + '\n' +
            '· 删除后进回收站，约 10 天可恢复\n' +
            '· 搜索模式看不到完整清单，要完整清单请用遍历模式\n\n确定开始吗？'
          );
          if (!ok) { log('用户取消。', 'warn'); return; }
        }
        await runSearchMode(dry);

        // 搜索窗口被占满时，可选地自动切到遍历模式收尾
        if (state.starvation && CONFIG.autoFallbackToWalk && !state.aborted && !dry) {
          log('自动切换到遍历模式，把搜索够不到的剩余文件收尾…', 'warn');
          state.mode = 'walk';
          state.starvation = false;
          state.stopReason = '';
          await runWalkMode(false);
          state.mode = 'search';
        }
      } else {
        await runWalkMode(dry);
      }

      const echo = `本轮结束：命中 ${state.matched.length} 个（${fmtSize(state.totalBytes)}），` +
        `已删 ${state.deleted.length}，失败 ${state.deleteFailed.length}，` +
        `API 请求 ${state.apiCalls} 次，耗时 ${fmtDuration(Date.now() - state.startTs)}`;
      log(echo, 'ok');
    } catch (e) {
      log(`运行出错：${e.message}`, 'err');
      console.error(e);
    } finally {
      state.running = false;
      setButtons(false);
      refreshStats();
    }
  }

  function printList() {
    if (!state.matched.length) { log('还没有扫到文件，可先点「试运行扫描」。', 'warn'); return; }
    const lines = state.matched.map((x, i) =>
      `${String(i + 1).padStart(5)}  ${fmtSize(x.size).padStart(9)}  ${x.path}`
    );
    const text = `共 ${state.matched.length} 个，合计 ${fmtSize(state.totalBytes)}\n\n` +
      lines.join('\n') +
      (state.deleted.length ? `\n\n已删除 ${state.deleted.length} 个：\n` + state.deleted.join('\n') : '');
    console.log('%c========== .dat 清单 ==========', 'color:#ff7b72');
    console.log(text);
    try {
      navigator.clipboard.writeText(text);
      log('清单已打印到控制台，并已复制到剪贴板。', 'ok');
    } catch (e) {
      log('清单已打印到控制台（复制失败，请手动复制）。', 'ok');
    }
  }

  // ======================= 启动 =======================
  window.bdcl = { CONFIG, state, run, printList, getBdstoken };

  function boot() {
    if (!CONFIG.showPanel) {
      log('已加载（面板已关闭）。控制台调用：bdcl.run() / bdcl.printList()');
      console.log('[bdcl] 命令：bdcl.CONFIG.mode = "search" | "walk"；然后 bdcl.run()。');
      return;
    }
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (!document.getElementById('bdcl-panel')) buildPanel();
      if (tries > 200) clearInterval(timer);
    }, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  console.log('[bdcl] 百度网盘 .dat 清理器 v1.1.1 已加载。默认搜索模式、只试运行，不会删文件。');
})();
