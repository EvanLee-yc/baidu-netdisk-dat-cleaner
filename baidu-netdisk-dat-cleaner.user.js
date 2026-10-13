// ==UserScript==
// @name         百度网盘 .dat 视频批量清理器
// @namespace    https://github.com/EvanLee-yc
// @version      1.0.0
// @description  递归遍历百度网盘全部目录（绕过网页搜索最多 500 条的限制），批量删除 .dat 格式的视频文件。默认试运行，不会直接删。
// @author       Evan
// @match        https://pan.baidu.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// 说明：
// 1) 本脚本只调用网盘网页版自己就在用的接口（/api/list 与 /api/filemanager），
//    复用当前登录态 Cookie，不涉及第三方登录、不上传任何数据。
// 2) 删除动作走的是网页版同一个接口，被删文件会进入「回收站」，默认保留 10 天可恢复。
// 3) 默认 dryRun = true：只扫描、只列清单、只统计体积，不删任何东西。
//    确认清单没问题后，再把 CONFIG.dryRun 改成 false，或点面板上的「开始删除」。
// 4) 可以直接装成油猴脚本，也可以整段复制到网盘页面的控制台里直接回车运行。

(function () {
  'use strict';

  // ======================= 配置区 =======================
  const CONFIG = {
    // 起始目录，'/' 表示整个网盘。只想扫某个文件夹就写成 '/我的资源/video'
    rootDir: '/',

    // 要清理的扩展名（不区分大小写）
    ext: '.dat',

    // true = 只删网盘判定为「视频」的文件（接口返回 category === 1）
    // 打开这个开关可以避免误删同名的非视频 .dat
    onlyCategoryVideo: true,

    // 体积下限（字节）。0 表示不限；设成 1024*1024 就是忽略小于 1MB 的
    minSize: 0,

    // 路径黑名单：路径里包含任意一个字符串就跳过（防止扫到不想动的目录）
    excludePaths: [],

    // 控制台调用 bdcl.run() 时的默认行为：true = 只扫描不删除（建议保持 true）。
    // 注意：面板上的「开始删除」按钮是强制执行删除，不受这个开关限制，
    //      但它一定会弹出确认框，把要删的数量和体积先报给你。
    dryRun: true,

    // 单次删除请求携带的文件数。官方接口对单次数量有限制，
    // 遇到「一次操作文件不可超过 100 个」会自动拆半重试，所以这里不用太保守
    batchSize: 100,

    // 每个删除批次之间的间隔（毫秒）。调太小容易触发风控
    batchDelayMs: 800,

    // 列表接口单页条数，最大 1000（这就是绕开搜索 500 条上限的关键：按目录分页遍历）
    pageSize: 1000,

    // 一次运行最多删多少个，安全阀
    maxDelete: 200000,

    // 递归深度上限，防止异常目录结构导致死循环
    maxDepth: 64,

    // 列表请求失败重试次数
    listRetry: 3,

    // 删除请求失败重试次数
    deleteRetry: 3,

    // 删除任务轮询间隔（异步删除需要查任务状态）
    pollInterval: 3000,

    // 是否显示悬浮控制面板（关掉就纯控制台输出）
    showPanel: true,
  };
  // =====================================================

  const API_LIST = 'https://pan.baidu.com/api/list';
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
    scannedDirs: 0,
    scannedFiles: 0,
    matched: [],        // 命中的文件 {path, name, size, category}
    skippedByCategory: 0,
    deleted: [],
    deleteFailed: [],
    totalBytes: 0,
    stopReason: '',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // 防止日志过长卡顿
      while (el.childNodes.length > 800) el.removeChild(el.firstChild);
    }
  }

  function refreshStats() {
    const el = document.getElementById('bdcl-stats');
    if (!el) return;
    el.innerHTML = `
      已扫描目录：<b>${state.scannedDirs}</b>　文件：<b>${state.scannedFiles}</b><br>
      命中 .dat：<b style="color:#ff7b72">${state.matched.length}</b> 个　
      合计 <b>${fmtSize(state.totalBytes)}</b><br>
      因非视频跳过：<b>${state.skippedByCategory}</b><br>
      已删除：<b style="color:#6bff9e">${state.deleted.length}</b>　
      失败：<b style="color:#ffd166">${state.deleteFailed.length}</b>
    `;
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function buildPanel() {
    if (!CONFIG.showPanel || document.getElementById('bdcl-panel')) return;
    const p = document.createElement('div');
    p.id = 'bdcl-panel';
    p.style.cssText = `
      position:fixed;right:16px;bottom:16px;z-index:999999;width:400px;
      background:#1f2126;color:#e6e6e6;border:1px solid #3a3d44;border-radius:10px;
      font:12px/1.6 -apple-system,Menlo,monospace;box-shadow:0 8px 28px rgba(0,0,0,.5);
    `;
    p.innerHTML = `
      <div id="bdcl-head" style="padding:8px 10px;background:#2a2d34;border-radius:10px 10px 0 0;
           display:flex;justify-content:space-between;align-items:center;cursor:move;">
        <span style="font-weight:600">百度网盘 .dat 清理器 <span style="color:#8b8f98">v1.0.0</span></span>
        <span>
          <button id="bdcl-min" style="background:none;border:none;color:#8b8f98;cursor:pointer">—</button>
          <button id="bdcl-close" style="background:none;border:none;color:#8b8f98;cursor:pointer">×</button>
        </span>
      </div>
      <div id="bdcl-body" style="padding:10px">
        <div id="bdcl-stats" style="margin-bottom:8px;color:#c9ccd4"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
          <button id="bdcl-scan"  class="bdcl-btn">试运行扫描</button>
          <button id="bdcl-del"   class="bdcl-btn">开始删除</button>
          <button id="bdcl-print" class="bdcl-btn">打印删除清单</button>
          <button id="bdcl-stop"  class="bdcl-btn">停止</button>
          <button id="bdcl-clear" class="bdcl-btn">清空日志</button>
        </div>
        <div style="color:#8b8f98;margin-bottom:4px">
          起始目录 <b>${CONFIG.rootDir}</b>　扩展名 <b>${CONFIG.ext}</b>　
          仅视频 <b>${CONFIG.onlyCategoryVideo}</b>　
          批大小 <b>${CONFIG.batchSize}</b>
        </div>
        <div id="bdcl-log" style="height:180px;overflow:auto;background:#16181c;border:1px solid #2f323a;
             border-radius:6px;padding:6px;white-space:pre-wrap;word-break:break-all"></div>
      </div>
    `;
    document.body.appendChild(p);

    const st = document.createElement('style');
    st.textContent = `.bdcl-btn{background:#2f323a;color:#e6e6e6;border:1px solid #3f434c;
      border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
      .bdcl-btn:hover{background:#3a3e48}.bdcl-btn:disabled{opacity:.45;cursor:not-allowed}`;
    document.head.appendChild(st);

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

    // 简单拖动
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
    ['bdcl-scan', 'bdcl-del', 'bdcl-print'].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = disabled;
    });
  }

  // ======================= 鉴权：拿 bdstoken =======================
  // 网盘写操作需要 bdstoken（CSRF token）。按可靠性依次尝试三种来源。
  async function getBdstoken() {
    if (state.bdstoken) return state.bdstoken;

    // 1) 页面全局 locals
    try {
      if (window.locals && typeof window.locals.get === 'function') {
        const t = window.locals.get('bdstoken');
        if (t) return (state.bdstoken = t);
      }
    } catch (e) { /* ignore */ }

    // 2) 官方取模板变量接口
    try {
      const url = `https://pan.baidu.com/api/gettemplatevariable?clienttype=0&app_id=${APP_ID}` +
        `&web=1&fields=${encodeURIComponent('["bdstoken"]')}`;
      const r = await fetch(url, { credentials: 'include' });
      const j = await r.json();
      if (j && j.errno === 0 && j.result && j.result.bdstoken) {
        return (state.bdstoken = j.result.bdstoken);
      }
    } catch (e) { /* ignore */ }

    // 3) 抓主页 HTML 里的 locals.set('bdstoken', '...')
    try {
      const r = await fetch('https://pan.baidu.com/disk/home', { credentials: 'include' });
      const html = await r.text();
      const m = html.match(/bdstoken['":\s]+([0-9a-f]{32})/);
      if (m) return (state.bdstoken = m[1]);
    } catch (e) { /* ignore */ }

    return '';
  }

  // ======================= 列表接口 =======================
  // 关键点：这里按「目录 + 分页」遍历，而不是用网页搜索框。
  // 网页搜索单次最多返回 500 条，而 /api/list 单页 num 最大 1000，
  // 靠翻页可以拿到一个目录下的全部文件，再递归子目录即可覆盖整个网盘。
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
    const res = await fetch(`${API_LIST}?${qs.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return await res.json();
  }

  async function listAllOfDir(dir, depth) {
    const all = [];
    let page = 1;
    for (;;) {
      if (state.aborted) break;
      let data = null;
      for (let i = 1; i <= CONFIG.listRetry; i++) {
        try {
          data = await apiList(dir, page);
          if (data && (data.errno === 0 || data.errno === -9)) break;
          log(`列表失败 ${dir} page=${page} errno=${data && data.errno}（第 ${i} 次）`, 'warn');
        } catch (e) {
          log(`列表异常 ${dir} page=${page}：${e.message}（第 ${i} 次）`, 'warn');
        }
        await sleep(600 * i);
      }
      if (!data) { log(`放弃该目录：${dir}`, 'err'); break; }

      if (data.errno === 112) {
        // 页面已过期，通常是 bdstoken 失效，刷新后重试一次
        log('bdstoken 已过期，重新获取…', 'warn');
        state.bdstoken = '';
        await getBdstoken();
        continue;
      }
      if (data.errno === -6) {
        log('登录态已失效，请刷新页面重新登录。', 'err');
        state.stopReason = '登录态失效';
        state.aborted = true;
        break;
      }
      if (data.errno === -9) break; // 目录已被删除
      if (data.errno !== 0) {
        log(`列表返回 errno=${data.errno}：${data.errmsg || ''}`, 'err');
        break;
      }

      const list = data.list || [];
      all.push(...list);
      if (list.length < CONFIG.pageSize) break;
      page++;
      await sleep(150); // 轻微节流，别把接口打爆
    }
    return all;
  }

  async function walk(root) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (state.aborted) break;
      const { dir, depth } = queue.shift();
      if (depth > CONFIG.maxDepth) {
        log(`递归超过 ${CONFIG.maxDepth} 层，跳过：${dir}`, 'warn');
        continue;
      }
      const items = await listAllOfDir(dir, depth);
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
          state.matched.push({
            path: f.path,
            name: f.server_filename || f.path.split('/').pop(),
            size: f.size || 0,
            category: f.category,
          });
          state.totalBytes += f.size || 0;
          hitHere++;
        } else if (v.reason === 'category') {
          state.skippedByCategory++;
        }
      }

      log(`扫描 ${dir} → 子项 ${items.length}，命中 ${hitHere}，待处理目录 ${queue.length}`);
      refreshStats();
      await sleep(120);
    }
  }

  function checkFile(f) {
    const name = f.server_filename || f.path.split('/').pop() || '';
    if (!name.toLowerCase().endsWith(CONFIG.ext.toLowerCase())) return { match: false, reason: 'ext' };
    if ((f.size || 0) < CONFIG.minSize) return { match: false, reason: 'size' };
    if (CONFIG.onlyCategoryVideo && f.category !== 1) return { match: false, reason: 'category' };
    return { match: true };
  }

  // ======================= 删除接口 =======================
  // POST /api/filemanager?async=2&opera=delete&onnest=fail&...
  // body: filelist=<URL 编码的 JSON 数组>
  // 返回 {errno:0, taskid:N}，随后轮询 /share/taskquery 等任务结束
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
    const res = await fetch(`${API_FM}?${qs.toString()}`, {
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
        const r = await fetch(`${API_TASK}?${qs.toString()}`, { credentials: 'include' });
        const j = await r.json();
        const status = (j && (j.status || (j.taskinfo && j.taskinfo[0] && j.taskinfo[0].status))) || '';
        if (status === 'success' || status === 'failed') return status;
      } catch (e) {
        log(`任务状态查询异常：${e.message}`, 'warn');
      }
    }
  }

  // 真正的删除调度：自动拆批 + 遇到数量超限拆半重试
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
          // 成功：异步任务需等它跑完，再进入下一批
          if (j.taskid) {
            const st = await pollTask(j.taskid);
            if (st === 'failed') log(`任务 ${j.taskid} 状态 failed（文件通常仍已删除）`, 'warn');
          }
          state.deleted.push(...paths);
          refreshStats();
          return;
        }

        if (errno === 3) {
          // 「一次操作文件不可超过 100 个」→ 拆半重试
          log(`单次数量超限，拆半重试（${paths.length} → ${Math.ceil(paths.length / 2)}）`, 'warn');
          const half = Math.ceil(paths.length / 2);
          await doDelete(paths.slice(0, half));
          await doDelete(paths.slice(half));
          return;
        }

        if (errno === -9) {
          // 文件已不存在，视为成功
          state.deleted.push(...paths);
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
          log('❗ 网盘要求「删除文件需要验证您的身份」，已自动停止。请到网页上手动验证一次身份后再运行。', 'err');
          state.stopReason = '需要身份验证 (errno 132)';
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

    // 只有两种模式：forceDry === true 强制试运行；
    // forceDry === false / undefined 时按 CONFIG.dryRun 决定。
    // 面板上的「开始删除」传 false，所以它会真的删（并且一定弹确认框）。
    const dry = forceDry === true ? true : CONFIG.dryRun;
    state.running = true;
    state.aborted = false;
    state.stopReason = '';
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
      log(`bdstoken 获取成功，开始扫描 ${CONFIG.rootDir} …`, 'ok');

      await walk(CONFIG.rootDir);

      log(`扫描结束：目录 ${state.scannedDirs}，文件 ${state.scannedFiles}，` +
        `命中 ${state.matched.length} 个（${fmtSize(state.totalBytes)}）`, 'ok');
      if (state.skippedByCategory) {
        log(`另有 ${state.skippedByCategory} 个 .dat 因不是「视频」类型被跳过（可关闭 onlyCategoryVideo 纳入）。`, 'warn');
      }

      if (state.matched.length === 0) {
        log('没有命中任何文件，无需删除。', 'ok');
        return;
      }

      if (dry) {
        log('试运行模式：没有删除任何文件。请点「打印删除清单」核对，确认无误后再点「开始删除」。', 'warn');
        return;
      }

      // 二次确认
      const ok = window.confirm(
        `即将删除 ${state.matched.length} 个 .dat 文件，合计 ${fmtSize(state.totalBytes)}。\n\n` +
        `删除后文件会进入「回收站」（约 10 天可恢复）。\n\n确定继续吗？`
      );
      if (!ok) { log('用户取消删除。', 'warn'); return; }

      log(`开始删除 ${state.matched.length} 个文件，批大小 ${CONFIG.batchSize}，间隔 ${CONFIG.batchDelayMs}ms …`, 'warn');
      const targets = state.matched.map((x) => x.path).slice(0, CONFIG.maxDelete);
      if (targets.length < state.matched.length) {
        log(`超过 maxDelete=${CONFIG.maxDelete}，本次只处理前 ${targets.length} 个。`, 'warn');
      }

      for (let i = 0; i < targets.length; i += CONFIG.batchSize) {
        if (state.aborted) break;
        const batch = targets.slice(i, i + CONFIG.batchSize);
        log(`删除进度 ${i}/${targets.length} …`);
        await doDelete(batch);
        await sleep(CONFIG.batchDelayMs);
      }
      log(`删除结束：成功 ${state.deleted.length}，失败 ${state.deleteFailed.length}`, 'ok');
      if (state.stopReason) log(`停止原因：${state.stopReason}`, 'err');
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
  // 暴露到控制台，方便手动调用
  window.bdcl = { CONFIG, state, run, printList, getBdstoken };

  function boot() {
    if (!CONFIG.showPanel) {
      log('已加载（面板已关闭）。控制台调用：bdcl.run() / bdcl.printList()');
      console.log('[bdcl] 命令：bdcl.run() 扫描并删除；先改 bdcl.CONFIG.dryRun = false 才真删。');
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

  console.log('[bdcl] 百度网盘 .dat 清理器已加载。默认只试运行，不会删文件。');
})();
