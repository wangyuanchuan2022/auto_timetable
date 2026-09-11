// mobile-app.js — 手机端页面主脚本（自 mobile.html 内联 <script> 原样抽离，行为零变化）。
// 加载顺序（与浏览器一致）：<script src="/occur.js">（共享领域判定，全局 TTOccur）→ 本文件。
// 由 mobile-server.mjs 静态托管（GET /mobile-app.js）；CSP script-src 'self' 允许。
(function () {
    'use strict';

    var API_READ = '/api/schedule';
    var API_WRITE = '/api/schedule';
    var LEGACY_PIN_KEY = 'tt-mobile-pin'; // 旧版把密码存 localStorage，登录成功后清除

    // 安卓 APP（原生 WebView 壳）桥接检测：页面被装入 APP 时由原生注入 window.NativeBridge。
    // APP 内系统通知由原生精确闹钟提供（WebView 无 Web Push 能力），页面只负责：
    // ① 登录成功后让 APP 立即同步提醒计划（refreshPlan）；② 通知按钮转交原生权限申请。
    // 浏览器环境无 NativeBridge → 全部走原有 Web Push 路径，行为零变化。
    function nativeBridge() {
      try { return (window.NativeBridge && typeof window.NativeBridge.refreshPlan === 'function') ? window.NativeBridge : null; }
      catch (e) { return null; }
    }

    // 登录：验证密码后由服务端种 HttpOnly Cookie（密码不落 localStorage、不进 URL）
    function login(pin) {
      return fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ pin: pin })
      }).then(function (r) {
        if (r.status === 429) throw new Error('尝试次数过多，稍后再试');
        if (!r.ok) throw new Error('badpin');
        try { localStorage.removeItem(LEGACY_PIN_KEY); } catch (e) {}
        return true;
      });
    }

    // 密码错误 / 未登录时弹出页内密码输入框（type=password），返回 Promise<密码或 null>。
    // 不再用 window.prompt：手机端 prompt 输入体验差、部分内嵌浏览器会拦截。
    function askPin(wasWrong) {
      return new Promise(function (resolve) {
        var mask = document.createElement('div');
        mask.className = 'mask';
        mask.innerHTML =
          '<div class="dlg" role="dialog">' +
          '  <h2>安全密码</h2>' +
          '  <div class="rep muted" id="pMsg"></div>' +
          '  <div class="field"><input type="password" id="pIn" placeholder="请输入安全密码" autocomplete="current-password" enterkeyhint="go" /></div>' +
          '  <div class="btns">' +
          '    <button class="btn btnCancel" id="pCancel">取消</button>' +
          '    <button class="btn btnSave" id="pOk">确认</button>' +
          '  </div>' +
          '</div>';
        document.body.appendChild(mask);
        var msgEl = mask.querySelector('#pMsg');
        var input = mask.querySelector('#pIn');
        var okBtn = mask.querySelector('#pOk');
        if (msgEl) msgEl.textContent = wasWrong ? '密码不正确，请重新输入：' : '本日程受安全密码保护，请输入密码：';
        function close(val) { mask.parentNode && mask.parentNode.removeChild(mask); resolve(val); }
        okBtn.onclick = function () {
          var v = String((input && input.value) || '');
          if (!v) { if (msgEl) msgEl.textContent = '密码不能为空，请输入后确认'; return; }
          close(v);
        };
        var cancelBtn = mask.querySelector('#pCancel');
        if (cancelBtn) cancelBtn.onclick = function () { close(null); };
        mask.addEventListener('click', function (e) { if (e.target === mask) close(null); });
        if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } });
        try { input && input.focus(); } catch (e) {}
      });
    }

    // 全局登录闸门：并发的多个 401（日程请求 / watch 流等）共享同一次弹窗与登录，
    // 「密码不正确」文案只在真实登录失败后出现（修复：首登后仍弹"密码不正确"的误导）
    var authOk = false;
    var authInFlight = null;
    function ensureAuth() {
      if (authOk) return Promise.resolve(true);
      if (authInFlight) return authInFlight;
      authInFlight = new Promise(function (resolve) {
        var attempt = function (wasWrong) {
          askPin(wasWrong).then(function (pin) {
            if (pin === null) { authInFlight = null; resolve(false); return; }
            login(pin)
              .then(function () {
                authOk = true;
                var nb = nativeBridge();
                if (nb) { try { nb.refreshPlan(); } catch (e) {} } // APP 内：登录成功（Cookie 就位）→ 立即同步提醒计划
                authInFlight = null; resolve(true);
              })
              .catch(function (err) {
                var msg = String(err && err.message || '');
                if (msg.indexOf('稍后再试') > -1 || msg.indexOf('badpin') === -1) {
                  bubble('登录失败：' + (msg || '未知错误'), 'bot');
                  authInFlight = null;
                  resolve(false);
                  return;
                }
                attempt(true); // 只有真的输错才提示"密码不正确"并重问
              });
          });
        };
        attempt(false);
      });
      return authInFlight;
    }

    // 静默会话复核：无弹窗地探测会话 Cookie 是否仍有效（true=有效）。
    // authOk 只是「本次页面加载内登录过」的内存标志——重开网页即重置，不代表会话失效；
    // WebView 冷启动首个请求也可能竞态漏带 Cookie。401/断线后先静默复核，仍 401 才弹登录框，
    // 消灭「已登录却再次弹密码」的误弹（会话真的失效时复核仍 401，照常弹窗，无安全让步）。
    var authProbeInFlight = null;
    function sessionProbe() {
      if (!authProbeInFlight) {
        authProbeInFlight = fetch('/api/schedule', { credentials: 'same-origin', cache: 'no-store' })
          .then(function (r) { authProbeInFlight = null; return r.status !== 401; })
          .catch(function () { authProbeInFlight = null; return false; });
      }
      return authProbeInFlight;
    }

    function apiFetch(url, opts) {
      opts = opts || {};
      opts.credentials = 'same-origin'; // 携带登录 Cookie
      return fetch(url, opts).then(function (r) {
        if (r.status !== 401) return r;
        // 401 先静默复核会话：有效（冷启动竞态漏带 Cookie 等）→ 静默重试原请求；
        // 复核仍 401（会话真失效）→ 走全局登录闸门（并发去重），登录成功后重试一次
        return sessionProbe().then(function (valid) {
          if (valid) return fetch(url, opts);
          return ensureAuth().then(function (ok) {
            return ok ? fetch(url, opts) : r;
          });
        });
      });
    }

    var data = null;
    var editEv = null; // 当前对话框正在编辑的事件

    function $(id) { return document.getElementById(id); }
    function pad(n) { return String(n).padStart(2, '0'); }
    function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function parseDate(s) { var p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
    function toMin(hhmm) { var p = String(hhmm || '0:0').split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
    function isoWeekday(d) { return (d.getDay() + 6) % 7 + 1; }
    var DAY_FULL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    // 领域判定单一实现：共享模块 occur.js（全局 TTOccur；与服务端 / 桌面端 / Python 同语义）
    var occursOn = TTOccur.occursOn;

    function describeRepeat(ev) {
      var t = ev.type || 'once';
      var s;
      if (t === 'task') {
        var s = '任务';
        if (ev.start) s += ' · ' + ev.start + ' 起';
        if (ev.deadline) s += ' · 截止 ' + ev.deadline;
        return s;
      }
      if (t === 'weekly') s = '每周重复 · ' + (DAY_FULL[(ev.weekday || 1) - 1] || '');
      else if (t === 'once') s = '一次性 · ' + (ev.date || '');
      else {
        var r = ev.repeat || {};
        var unitMap = { day: '天', week: '周', month: '月' };
        s = '每 ' + (parseInt(r.interval, 10) || 1) + ' ' + (unitMap[r.unit || 'day'] || '天') + '重复 · 自 ' + (r.start || '?');
        if (r.until) s += ' 至 ' + r.until;
      }
      if (t === 'weekly' && ev.weekPattern && ev.weekPattern.start) {
        s += ' · ' + (ev.weekPattern.odd === false ? '双周' : '单周') + '（自 ' + ev.weekPattern.start + ' 所在周起算）';
      }
      if (Array.isArray(ev.skip) && ev.skip.length) s += ' · 例外 ' + ev.skip.length + ' 天';
      if (t !== 'once' && t !== 'task' && ev.deadline) s += ' · 截止 ' + ev.deadline;
      return s;
    }

    /** weekPattern.start 的新建默认值：优先 meta.termStart（当前学期），无则今天所在周的周一。 */
    function defaultPatternStart() {
      var ts = data && data.meta && data.meta.termStart;
      if (TTOccur.isDateStr(ts)) return ts;
      return TTOccur.fmtDate(TTOccur.mondayOf(new Date()));
    }

    function load() {
      apiFetch(API_READ, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (json) {
        data = json;
        render();
      }).catch(function () {
        data = null;
        $('list').className = 'empty';
        $('list').textContent = '加载失败：无法连接电脑端服务（或密码未通过）';
      });
    }

    function dayEvents(day) {
      if (!data || !Array.isArray(data.events)) return [];
      return data.events.filter(function (ev) { return occursOn(ev, day); })
        .sort(function (a, b) { return toMin(a.start) - toMin(b.start); });
    }

    function render() {
      var pick = $('datePick');
      if (!pick.value) pick.value = fmtDate(new Date());
      var day = parseDate(pick.value);
      var list = $('list');
      list.className = 'list';
      list.innerHTML = '';

      var evs = dayEvents(day);
      if (!evs.length) {
        list.className = 'empty';
        list.textContent = (isToday(day) ? '今天' : '该日') + '暂无日程';
        return;
      }
      var nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      evs.forEach(function (ev) {
        var it = document.createElement('div');
        it.className = 'it';
        var isTask = (ev.type || 'once') === 'task'; // 长周期任务：[start, deadline] 区间逐日展示
        var s = toMin(ev.start), e = toMin(ev.end);
        var isDeadlineDay = isTask && ev.deadline && fmtDate(day) === ev.deadline;
        if (isTask) { if (isDeadlineDay) it.style.borderColor = '#f85149'; }
        else if (isToday(day) && s <= nowMin && e >= nowMin) it.style.borderColor = '#f85149';

        var bar = document.createElement('div');
        bar.className = 'bar';
        bar.style.background = ev.color || (isTask ? '#f85149' : '#4f8ef7');

        var time = document.createElement('div');
        time.className = 'time';
        if (isTask) {
          // 任务状态位（相对今天）：未开始 / 进行中（倒计时）/ 今天截止 / 已逾期
          var todayStr = fmtDate(new Date());
          var n = ev.deadline ? Math.round((parseDate(ev.deadline) - parseDate(todayStr)) / 86400000) : NaN;
          var notStarted = ev.start && ev.start > todayStr;
          if (!ev.deadline) {
            time.textContent = '任务';
            time.style.color = '#6e7681';
          } else if (notStarted) {
            time.textContent = '未开始';
            time.style.color = '#6e7681';
          } else if (n === 0) {
            time.textContent = '今天截止';
            time.style.color = '#f85149';
          } else if (n < 0) {
            time.textContent = '已逾期';
            time.style.color = '#f85149';
          } else {
            time.textContent = '进行中';
            time.style.color = '#f0883e';
          }
          var dsub = document.createElement('small');
          var parts = [];
          if (ev.start) parts.push(ev.start + ' 起');
          if (ev.deadline) parts.push('截止 ' + ev.deadline + (isNaN(n) ? '' : n === 0 ? '（今天）' : n > 0 ? '·剩 ' + n + ' 天' : ''));
          dsub.textContent = parts.join(' · ');
          dsub.className = 'muted';
          time.appendChild(dsub);
        } else {
          time.textContent = ev.start || '';
          var sub = document.createElement('small');
          sub.textContent = '至 ' + (ev.end || '');
          sub.className = 'muted';
          time.appendChild(sub);
        }

        var body = document.createElement('div');
        body.style.minWidth = '0'; body.style.flex = '1';
        var t = document.createElement('div');
        t.className = 'title';
        t.textContent = ev.title || '(未命名)';
        body.appendChild(t);
        if (ev.location) {
          var m = document.createElement('div');
          m.className = 'meta muted';
          m.textContent = ev.location;
          body.appendChild(m);
        }
        if (ev.deadline && !isTask && (ev.type || 'once') !== 'once') {
          var dlm = document.createElement('div');
          dlm.className = 'meta muted';
          dlm.textContent = '⏱ 截止 ' + ev.deadline;
          body.appendChild(dlm);
        }

        it.appendChild(bar); it.appendChild(time); it.appendChild(body);
        it.onclick = function () { openDialog(ev); };
        list.appendChild(it);
      });
    }
    function isToday(d) { return fmtDate(d) === fmtDate(new Date()); }

    // ---------- 对话框：查看并修改该条日程 ----------
    function openDialog(ev) {
      editEv = ev;
      var mask = document.createElement('div');
      mask.className = 'mask';
      mask.id = 'dlgMask';
      mask.innerHTML =
        '<div class="dlg" role="dialog">' +
        '  <h2>日程详情</h2>' +
        '  <div class="rep muted" id="dRep"></div>' +
        '  <div class="field"><label>名称</label><input id="dTitle" /></div>' +
        '  <div class="row2" id="dTimeRow">' +
        '    <div class="field"><label>开始时间</label><input type="time" id="dStart" /></div>' +
        '    <div class="field"><label>结束时间</label><input type="time" id="dEnd" /></div>' +
        '  </div>' +
        '  <div class="field" id="dTaskStartWrap" style="display:none"><label>开始日期（可选；从该日起持续到截止日，留空 = 一直可见）</label><input type="date" id="dTaskStart" /></div>' +
        '  <div class="field"><label>地点</label><input id="dLoc" placeholder="可选" /></div>' +
        '  <div class="field"><label>备注</label><input id="dNote" placeholder="可选" /></div>' +
        '  <div class="field"><label>提前提醒（分钟，0 = 不提醒，默认 20）</label><input type="number" id="dLead" min="0" max="1440" step="1" /></div>' +
        '  <div class="field"><label>截止日期（到该日（含）为止生效；过期满 3 个月自动清除）</label><input type="date" id="dDeadline" /></div>' +
        '  <div class="field" id="dWeekPatternWrap" style="display:none"><label>单双周（仅每周重复课程）</label><select id="dWeekPattern">' +
        '    <option value="none">每周（不区分单双周）</option>' +
        '    <option value="odd">单周（第 1/3/5… 教学周上课）</option>' +
        '    <option value="even">双周（第 2/4/6… 教学周上课）</option>' +
        '  </select></div>' +
        '  <div class="field"><label>例外日期（停课/调休，这些日期不上课）</label><input id="dSkip" placeholder="如 2026-10-01、2026-10-08（逗号或空格分隔）；留空 = 无" /></div>' +
        '  <div class="btns">' +
        '    <button class="btn btnCancel" id="dCancel">取消</button>' +
        '    <button class="btn btnSave" id="dSave">保存</button>' +
        '  </div>' +
        '  <button class="btn" id="dDel" style="background:transparent;border:1px solid #cf222e;color:#cf222e;margin-top:10px">删除此事件</button>' +
        '  <div class="dlgMsg" id="dMsg"></div>' +
        '</div>';
      document.body.appendChild(mask);
      var isTaskDlg = (ev.type || 'once') === 'task'; // 任务：无起止时刻，截止日期必填，可选开始日期
      if (isTaskDlg) $('dTimeRow').style.display = 'none';
      $('dTaskStartWrap').style.display = isTaskDlg ? '' : 'none';
      $('dRep').textContent = describeRepeat(ev);
      $('dTitle').value = ev.title || '';
      $('dStart').value = ev.start || '';
      $('dEnd').value = ev.end || '';
      $('dTaskStart').value = isTaskDlg && ev.start ? ev.start : '';
      $('dLoc').value = ev.location || '';
      $('dNote').value = ev.note || '';
      $('dLead').value = (typeof ev.remindLead === 'number' && isFinite(ev.remindLead)) ? ev.remindLead : 20;
      $('dDeadline').value = ev.deadline || '';
      // 单双周（仅 weekly 显示）：无 / 单周(odd:true) / 双周(odd:false)，带出当前状态
      var isWeeklyEv = (ev.type || 'once') === 'weekly';
      $('dWeekPatternWrap').style.display = isWeeklyEv ? '' : 'none';
      var wpSel = $('dWeekPattern');
      if (ev.weekPattern && ev.weekPattern.odd === false) wpSel.value = 'even';
      else if (ev.weekPattern && ev.weekPattern.start) wpSel.value = 'odd';
      else wpSel.value = 'none';
      // 例外日期：数组 → 顿号分隔展示
      $('dSkip').value = Array.isArray(ev.skip) ? ev.skip.join('、') : '';
      $('dMsg').textContent = '';

      function close() { mask.parentNode && mask.parentNode.removeChild(mask); editEv = null; }
      $('dCancel').onclick = close;
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

      // 删除此事件：两段式确认（首点武装变红「确认删除？」，3 秒内再点一次才生效）
      var delArmed = false;
      var delBtn = $('dDel');
      delBtn.onclick = function () {
        if (!editEv) return;
        if (!delArmed) {
          delArmed = true;
          delBtn.textContent = '确认删除？再点一次生效';
          delBtn.style.background = '#cf222e';
          delBtn.style.color = '#fff';
          setTimeout(function () {
            if (delArmed) {
              delArmed = false;
              delBtn.textContent = '删除此事件';
              delBtn.style.background = 'transparent';
              delBtn.style.color = '#cf222e';
            }
          }, 3000);
          return;
        }
        delArmed = false;
        delBtn.disabled = true;
        var msgEl = $('dMsg');
        msgEl.className = 'dlgMsg';
        msgEl.textContent = '正在删除…';
        var arr = (data && data.events) || [];
        var idx = arr.indexOf(editEv);
        if (idx > -1) arr.splice(idx, 1);
        apiFetch(API_WRITE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: JSON.stringify(data, null, 2) })
        }).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.json();
        }).then(function (j) {
          if (!j.ok) throw new Error(j.error || 'write failed');
          msgEl.textContent = '已删除，电脑端同步生效 ✓';
          msgEl.classList.add('ok');
          setTimeout(function () { close(); render(); }, 500);
        }).catch(function (err) {
          if (idx > -1) arr.splice(idx, 0, editEv); // 写回失败：把事件放回原位，内存与文件保持一致
          delBtn.disabled = false;
          msgEl.textContent = '删除失败：' + (err.message || err);
          msgEl.classList.add('err');
        });
      };
      $('dSave').onclick = function () {
        if (!editEv) return;
        var title = String($('dTitle').value || '').trim();
        var start = $('dStart').value, end = $('dEnd').value;
        var msgEl = $('dMsg');
        msgEl.className = 'dlgMsg';
        if (!title) { msgEl.textContent = '名称不能为空'; msgEl.classList.add('err'); return; }
        if (isTaskDlg) {
          if (!$('dDeadline').value) { msgEl.textContent = '任务需要截止日期（必须完成日，必填）'; msgEl.classList.add('err'); return; }
          if ($('dTaskStart').value && $('dTaskStart').value > $('dDeadline').value) { msgEl.textContent = '开始日期不能晚于截止日期'; msgEl.classList.add('err'); return; }
        } else {
          if (!start || !end) { msgEl.textContent = '请填写开始与结束时间'; msgEl.classList.add('err'); return; }
          if (toMin(end) === toMin(start)) { msgEl.textContent = '结束时间不能等于开始时间'; msgEl.classList.add('err'); return; }
        }
        // 例外日期（skip）：逗号/中文逗号/顿号/空格分隔 → 数组；空 = 清除；格式逐个校验
        var skipRaw = String($('dSkip').value || '').trim();
        var skipList = skipRaw ? skipRaw.split(/[,，、\s]+/).filter(Boolean) : [];
        for (var si = 0; si < skipList.length; si++) {
          if (!TTOccur.isDateStr(skipList[si])) {
            msgEl.textContent = '例外日期格式错误：' + skipList[si] + '（需为 YYYY-MM-DD，逗号或空格分隔）';
            msgEl.classList.add('err');
            return;
          }
        }
        // 单双周（weekPattern，仅 weekly）：none → 清除；odd/even → start 保留已有值，新建默认 meta.termStart（无则本周一）
        var wpVal = $('dWeekPattern').value;
        var isWeeklyEv = (editEv.type || 'once') === 'weekly';
        var newWp = null;
        if (isWeeklyEv && wpVal !== 'none') {
          newWp = {
            start: (editEv.weekPattern && TTOccur.isDateStr(editEv.weekPattern.start))
              ? editEv.weekPattern.start
              : defaultPatternStart(),
            odd: wpVal === 'odd',
          };
        }
        // P1-2 结构校验（共享模块）：拦截日期/截止/skip/weekPattern 等格式错误，含未编辑字段的整体一致性
        var cand = {
          type: editEv.type || 'once',
          title: title, start: start, end: end,
          date: editEv.date, weekday: editEv.weekday, repeat: editEv.repeat,
          deadline: $('dDeadline').value || undefined,
          skip: skipList.length ? skipList : undefined,
          weekPattern: newWp || undefined,
        };
        if (isTaskDlg) cand.start = $('dTaskStart').value || undefined; // 任务：start = 开始日期（YYYY-MM-DD）
        var errs = TTOccur.validateEvent(cand);
        if (errs.length) { msgEl.textContent = '无法保存：' + errs.join('；'); msgEl.classList.add('err'); return; }

        // 先改内存对象，写盘成功后关闭
        editEv.title = title;
        if (isTaskDlg) {
          delete editEv.end; delete editEv.remindLead; // 任务无结束时刻、不参与时刻提醒
          if ($('dTaskStart').value) editEv.start = $('dTaskStart').value; // 开始日期（YYYY-MM-DD，可选）
          else delete editEv.start; // 留空 = 一直可见到截止
        } else {
          editEv.start = start;
          editEv.end = end;
        }
        editEv.location = String($('dLoc').value || '').trim();
        editEv.note = String($('dNote').value || '').trim();
        if (skipList.length) editEv.skip = skipList;
        else delete editEv.skip; // 留空 = 清除例外日期
        if (newWp) editEv.weekPattern = newWp;
        else delete editEv.weekPattern; // 每周（none）或非 weekly → 清除
        if (!isTaskDlg) {
          var leadVal = parseInt($('dLead').value, 10);
          if (!isNaN(leadVal) && leadVal >= 0 && leadVal <= 1440) editEv.remindLead = leadVal;
          else delete editEv.remindLead; // 缺省回落到默认 20 分钟
        }
        var dl = $('dDeadline').value;
        if (dl) editEv.deadline = dl;
        else if ((editEv.type || 'once') === 'once' && editEv.date) editEv.deadline = editEv.date; // 一次性：留空即事件当日
        else if (editEv.repeat && editEv.repeat.until) editEv.deadline = editEv.repeat.until; // 与重复结束日对齐
        else delete editEv.deadline;
        msgEl.textContent = '正在保存…';
        apiFetch(API_WRITE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: JSON.stringify(data, null, 2) })
        }).then(function (r) {
          if (!r.ok) throw new Error('http ' + r.status);
          return r.json();
        }).then(function (j) {
          if (!j.ok) throw new Error(j.error || 'write failed');
          msgEl.textContent = '已保存，电脑端同步生效 ✓';
          msgEl.classList.add('ok');
          setTimeout(function () { close(); render(); }, 500);
        }).catch(function (err) {
          msgEl.textContent = '保存失败：' + (err.message || err);
          msgEl.classList.add('err');
        });
      };
    }

    $('datePick').addEventListener('change', render);

    // ---------- 提醒：事件开始前 N 分钟弹窗（N = 事件 remindLead，默认 20 分钟；0 = 不提醒） ----------
    // 事件对象：schedule.json 的日程（weekly/once/custom），字段为本地日期 + start(HH:MM)。
    // 计时基准：手机本地时钟——日程是无时区的本地墙上时间，与服务器时钟/时区无关，
    // 时钟偏差与时区差异下触发点仍以「手机看到的事件开始时刻」为准。
    var REMIND_DEFAULT = 20; // 分钟
    var REMIND_OVERRIDE = null; // ?remindLead=xx 仅供验证测试（如 0.5 = 提前 30 秒）
    try {
      var qLead = new URLSearchParams(location.search).get('remindLead');
      if (qLead !== null) { var f = parseFloat(qLead); if (isFinite(f)) REMIND_OVERRIDE = Math.min(REMIND_DEFAULT, Math.max(0.05, f)); }
    } catch (e) {}
    function leadOf(ev) {
      if (REMIND_OVERRIDE !== null) return REMIND_OVERRIDE;
      return TTOccur.leadMinutes(ev, REMIND_DEFAULT); // 共享模块：>=0 原值（0=不提醒），缺失/非法回落默认
    }
    var REMIND_STORE = 'tt-remind-state'; // { fired: {key: ts}, snooze: {key: ts} }
    var remindOpen = null; // 当前弹窗对应的 key（弹窗期间不再弹新窗）
    var SNOOZE_MS = 5 * 60 * 1000;

    function remindState() {
      try { return JSON.parse(localStorage.getItem(REMIND_STORE)) || { fired: {}, snooze: {} }; }
      catch (e) { return { fired: {}, snooze: {} }; }
    }
    function remindSave(s) { try { localStorage.setItem(REMIND_STORE, JSON.stringify(s)); } catch (e) {} }
    /** 已触发记录键：事件身份 + 日期 + 开始时间。改期（start 变）→ 键变 → 按新时间重新提醒；取消 → 事件消失 → 不再弹。 */
    function evKey(ev, day) { return (ev.id || ev.title) + '|' + fmtDate(day) + '|' + ev.start; }

    /** 到点应提醒的候选：今天/明天发生、落在 [start-lead, start) 窗口内、未弹过且不在小睡中的事件。 */
    function reminderCandidates(now) {
      if (!data || !Array.isArray(data.events)) return [];
      var nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      var st = remindState();
      var out = [];
      [now, new Date(now.getTime() + 864e5)].forEach(function (day) {
        var isToday = fmtDate(day) === fmtDate(now);
        data.events.forEach(function (ev) {
          if ((ev.type || 'once') === 'task') return; // 任务无起止时刻，不参与时刻提醒
          if (!occursOn(ev, day)) return;
          var lead = leadOf(ev);
          if (!(lead > 0)) return; // remindLead = 0 → 不提醒
          var s = toMin(ev.start), e = toMin(ev.end);
          if (e <= s) return; // 跨天事件：按开始日的开始时刻提醒，不做跨日推算
          var fireAt = s - lead;
          if (isToday) {
            if (!(nowMin >= fireAt && nowMin < s)) return;
          } else {
            // 明天的事件仅当提醒点落在今天（fireAt < 0，即临近午夜的日程）才可能到点
            if (fireAt >= 0) return;
            if (!(nowMin >= fireAt + 1440 && nowMin < s)) return;
          }
          var key = evKey(ev, day);
          if (st.fired[key]) return;
          if (st.snooze[key] && Date.now() < st.snooze[key]) return;
          out.push({ ev: ev, key: key, inMin: s - nowMin });
        });
      });
      return out.sort(function (a, b) { return a.inMin - b.inMin; });
    }

    function showReminder(c) {
      remindOpen = c.key;
      var st = remindState();
      st.fired[c.key] = Date.now();
      var cut = Date.now() - 48 * 3600e3;
      ['fired', 'snooze'].forEach(function (p) { for (var k in st[p]) if (st[p][k] < cut) delete st[p][k]; });
      remindSave(st);

      var ev = c.ev;
      var title = '⏰ 日程提醒 · ' + (ev.title || '(未命名)');
      var body = '约 ' + (c.inMin >= 1 ? Math.round(c.inMin) + ' 分钟后' : '马上') + '开始\n' + (ev.start || '') + ' – ' + (ev.end || '') + (ev.location ? ' · ' + ev.location : '');

      // 系统级通知（已授权且 SW 就绪）：即使页面在后台/锁屏也能弹出；点击回到本页
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && swReg) {
        try {
          swReg.showNotification(title, { body: body, tag: c.key, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', vibrate: [200, 100, 200], data: { url: '/' } });
          try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
          remindOpen = null; // 系统通知不等关闭，不阻塞后续提醒
          return;
        } catch (e) { /* SW 不可用则回落页面内弹窗 */ }
      }

      var mask = document.createElement('div');
      mask.className = 'mask';
      mask.innerHTML =
        '<div class="dlg" role="alertdialog">' +
        '  <h2>⏰ 日程提醒</h2>' +
        '  <div class="rep muted">约 ' + (c.inMin >= 1 ? Math.round(c.inMin) + ' 分钟后' : '马上') + '开始</div>' +
        '  <div style="font-size:16px;font-weight:600;margin:6px 0 2px" id="rTitle"></div>' +
        '  <div class="muted" style="margin-bottom:6px" id="rMeta"></div>' +
        '  <div class="btns">' +
        '    <button class="btn btnCancel" id="rSnooze">稍后再提（5 分钟）</button>' +
        '    <button class="btn btnSave" id="rOk">知道了</button>' +
        '  </div>' +
        '</div>';
      mask.querySelector('#rTitle').textContent = ev.title || '(未命名日程)';
      mask.querySelector('#rMeta').textContent = (ev.start || '') + ' – ' + (ev.end || '') + (ev.location ? ' · ' + ev.location : '');
      document.body.appendChild(mask);
      function close() { mask.parentNode && mask.parentNode.removeChild(mask); remindOpen = null; }
      mask.querySelector('#rOk').onclick = close;
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
      mask.querySelector('#rSnooze').onclick = function () {
        var s2 = remindState();
        delete s2.fired[c.key];
        s2.snooze[c.key] = Date.now() + SNOOZE_MS;
        remindSave(s2);
        close();
      };
      try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
    }

    // ---------- 系统级通知：Service Worker + Web Push 订阅（后台由电脑端服务定时推送） ----------
    var swReg = null;

    function urlB64ToUint8(b64) {
      var pad = '='.repeat((4 - (b64.length % 4)) % 4);
      var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
      var arr = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
      return arr;
    }

    function notifyStateMsg(text) { $('notifyState').textContent = text || ''; }

    async function enableNotifications() {
      var btn = $('notifyBtn');
      btn.disabled = true;
      try {
        var nb = nativeBridge();
        if (nb) {
          // APP 内：通知由原生精确闹钟提供（WebView 无 Web Push），这里只申请系统通知权限
          try { nb.requestNotifyPermission(); } catch (e) {}
          btn.textContent = '🔔 通知由 APP 管理';
          notifyStateMsg('提醒由 APP 提供（系统闹钟，锁屏/后台均可收到）');
          return;
        }
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
          notifyStateMsg('此浏览器不支持系统通知（iOS 需 16.4+ 并添加到主屏幕）');
          return;
        }
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') { notifyStateMsg('通知权限未授予，仍用页面内弹窗'); return; }
        swReg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        var key = await apiFetch('/api/push/key', { cache: 'no-store' }).then(function (r) { return r.json(); });
        if (!key || !key.ok) { notifyStateMsg('服务端推送不可用：' + ((key && key.error) || '')); return; }
        var existing = await swReg.pushManager.getSubscription();
        var sub = existing || await swReg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(key.publicKey),
        });
        var r2 = await apiFetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        }).then(function (x) { return x.json(); });
        if (r2 && r2.ok) {
          notifyStateMsg('系统通知已开启 ✓（后台/锁屏也能提醒）');
          btn.textContent = '🔔 系统通知已开启';
        } else {
          notifyStateMsg('订阅登记失败：' + ((r2 && r2.error) || ''));
        }
      } catch (e) {
        notifyStateMsg('开启失败：' + (e.message || e));
      } finally {
        btn.disabled = false;
      }
    }

    $('notifyBtn').onclick = enableNotifications;

    // 已授权过的设备静默恢复：注册 SW、同步订阅、更新按钮状态
    (async function restoreNotifications() {
      try {
        var nb = nativeBridge();
        if (nb) { // APP 内：无 Web Push，通知由原生闹钟提供，状态固定
          $('notifyBtn').textContent = '🔔 通知由 APP 管理';
          notifyStateMsg('提醒由 APP 提供（系统闹钟，锁屏/后台均可收到）');
          return;
        }
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !('serviceWorker' in navigator)) return;
        swReg = await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        $('notifyBtn').textContent = '🔔 系统通知已开启';
        var sub = await swReg.pushManager.getSubscription();
        if (sub) {
          await apiFetch('/api/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() }),
          }).catch(function () {});
          notifyStateMsg('系统通知已开启 ✓（后台/锁屏也能提醒）');
        }
      } catch (e) { /* 静默 */ }
    })();

    // ---------- 模型切换：列出 / 选择专属会话的对话模型 ----------
    function setModelLabel(cur) {
      $('modelBtn').textContent = '模型：' + ((cur && cur.model) || '未知');
    }

    function openModelSheet() {
      var mask = document.createElement('div');
      mask.className = 'mask';
      var dlg = document.createElement('div');
      dlg.className = 'dlg';
      var h = document.createElement('h2');
      h.textContent = '切换对话模型';
      var msgEl = document.createElement('div');
      msgEl.className = 'qbadge';
      msgEl.textContent = '加载中…';
      var list = document.createElement('div');
      list.style.maxHeight = '50vh';
      list.style.overflowY = 'auto';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'btn btnCancel';
      closeBtn.textContent = '关闭';
      closeBtn.style.marginTop = '10px';
      closeBtn.style.width = '100%';
      dlg.appendChild(h); dlg.appendChild(msgEl); dlg.appendChild(list); dlg.appendChild(closeBtn);
      mask.appendChild(dlg);
      document.body.appendChild(mask);
      function close() { mask.parentNode && mask.parentNode.removeChild(mask); }
      closeBtn.onclick = close;
      mask.addEventListener('click', function (e) { if (e.target === mask) close(); });

      apiFetch('/api/chat/models', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      }).then(function (j) {
        if (!j.ok) throw new Error(j.error || 'failed');
        msgEl.textContent = '当前：' + (j.current ? j.current.provider + ' / ' + j.current.model : '未知');
        list.innerHTML = '';
        (j.groups || []).forEach(function (g) {
          var gh = document.createElement('div');
          gh.className = 'qdetail';
          gh.style.margin = '8px 0 2px';
          gh.textContent = g.id;
          list.appendChild(gh);
          (g.models || []).forEach(function (m) {
            var b = document.createElement('button');
            b.className = 'qopt';
            b.style.width = '100%';
            b.textContent = m.id + (j.current && j.current.model === m.id && j.current.provider === g.id ? '  ✓' : '');
            b.onclick = function () {
              b.disabled = true;
              msgEl.textContent = '切换中…';
              apiFetch('/api/chat/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: g.id, model: m.id }),
              }).then(function (r2) { return r2.json(); }).then(function (j2) {
                if (j2.ok) { setModelLabel(j2.current); msgEl.textContent = '已切换：' + j2.current.model; setTimeout(close, 600); }
                else { msgEl.textContent = '切换失败：' + (j2.error || ''); b.disabled = false; }
              }).catch(function (e2) { msgEl.textContent = '切换失败：' + (e2.message || e2); b.disabled = false; });
            };
            list.appendChild(b);
          });
        });
      }).catch(function (e) {
        msgEl.textContent = '加载失败：' + (e.message || e);
      });
    }
    $('modelBtn').onclick = openModelSheet;

    // 初始显示当前模型
    apiFetch('/api/chat/models', { cache: 'no-store' }).then(function (r) { return r.json(); })
      .then(function (j) { if (j.ok) setModelLabel(j.current); }).catch(function () {});

    // ---------- 新建对话：丢弃当前专属会话（历史仍保留在电脑端 DSH），另建全新会话 ----------
    var chatGen = 0;       // 会话代数：reset 后旧发送流的帧回调按代数丢弃，不再写入新对话
    var newChatArmed = 0;  // 两段式确认：3 秒内再点一次才执行（防手机误触）
    function newChatLabel(s) { $('newChatBtn').textContent = s; }
    function doNewChat() {
      newChatLabel('新建中…');
      $('newChatBtn').disabled = true;
      apiFetch('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j.ok) throw new Error(j.error || 'failed');
          chatGen++;
          // 清空本地渲染状态（seq 去重表 / 思考块 / 工具卡 / 交互卡 / 流式气泡 / 待确认气泡）
          renderedSeqs = {}; reasoningSeen = {}; toolEls = {}; liveCards = {};
          pendingLocalUser = null; reasonEl = null; dropLive();
          chatBusyUI = false; $('chatSend').disabled = false; $('chatAttach').disabled = false;
          $('chatLog').innerHTML = '';
          openWatch(); // watch 流重连：服务端按新会话下发空快照，旧会话事件不再到达
          bubble('已开启新对话。之前的对话仍保留在电脑端 DSH。', 'bot');
        })
        .catch(function (err) { bubble('新建对话失败：' + (err.message || err), 'bot'); })
        .then(function () { $('newChatBtn').disabled = false; newChatLabel('✚ 新对话'); });
    }
    $('newChatBtn').onclick = function () {
      if ($('newChatBtn').disabled) return;
      if (chatBusyUI) { newChatLabel('处理中，稍候…'); setTimeout(function () { newChatLabel('✚ 新对话'); }, 1500); return; }
      var now = Date.now();
      if (now - newChatArmed > 3000) { // 首点：仅武装确认，不执行
        newChatArmed = now;
        newChatLabel('再点一次确认清空');
        setTimeout(function () { if (Date.now() - newChatArmed >= 2900) newChatLabel('✚ 新对话'); }, 3000);
        return;
      }
      newChatArmed = 0;
      doNewChat();
    };

    function checkReminders() {
      if (remindOpen) return;
      var cands = reminderCandidates(new Date());
      if (cands.length) showReminder(cands[0]);
    }
    setInterval(checkReminders, 15000);   // 每 15 秒检查一次
    setInterval(load, 5 * 60 * 1000);     // 每 5 分钟拉最新数据：电脑端取消/改期及时同步，避免误弹/漏弹
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { load(); checkReminders(); } // 回到前台立即检查
    });

    // ---------- 对话电脑端 DSH（双端同会话：watch 流原样镜像电脑端与手机端的消息） ----------

    // ---------- Markdown 渲染（安全语义对齐官方 DSH 前端 MarkdownText，即 dsh-pocket 镜像到手机的渲染） ----------
    // 不变量：① 只用 createElement/textContent 构建节点，消息源文本里的 HTML 一律按字面文本
    // 显示、绝不进 DOM（天然防 XSS）；② 链接仅允许 http/https/mailto（与官方 sanitizeUrl 一致），
    // javascript: 等按纯文本渲染；③ 远程图片不内嵌（CSP img-src 亦不允许 http），渲染为可点链接。
    function mdSafeUrl(url) {
      try {
        var p = new URL(url).protocol;
        if (p === 'http:' || p === 'https:' || p === 'mailto:') return url;
      } catch (e) {}
      return '';
    }
    function mdLink(href, text, imgChip) {
      var a = document.createElement('a');
      a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = (imgChip ? '🖼 ' : '') + (text || href);
      return a;
    }
    // 行内解析：反斜杠转义 / 代码 span / 图片 / 链接 / 裸 URL 自动链接 / 粗体 / 删除线 / 斜体
    function mdInline(parent, s) {
      var i = 0, n = s.length, buf = '';
      function flush() { if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ''; } }
      while (i < n) {
        var c = s[i], m;
        if (c === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!>~|]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
        if (c === '`') {
          var ticks = s.slice(i).match(/^`+/)[0];
          var close = s.indexOf(ticks, i + ticks.length);
          if (close > i + ticks.length) {
            flush();
            var codeEl = document.createElement('code');
            codeEl.textContent = s.slice(i + ticks.length, close).replace(/\n/g, ' ');
            parent.appendChild(codeEl);
            i = close + ticks.length;
            continue;
          }
        }
        m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
        if (m) {
          flush();
          var iu = mdSafeUrl(m[2]);
          parent.appendChild(iu ? mdLink(iu, m[1] || m[2], true) : document.createTextNode(m[0]));
          i += m[0].length; continue;
        }
        m = /^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(s.slice(i));
        if (m) {
          flush();
          var lu = mdSafeUrl(m[2]);
          if (lu) {
            var la = document.createElement('a');
            la.href = lu; la.target = '_blank'; la.rel = 'noopener noreferrer';
            mdInline(la, m[1] || m[2]);
            parent.appendChild(la);
          } else parent.appendChild(document.createTextNode(m[0]));
          i += m[0].length; continue;
        }
        m = /^https?:\/\/[^\s<>()[\]]+/.exec(s.slice(i));
        if (m) {
          var url = m[0].replace(/[.,;:!?，。；：！？）】》”’]+$/, '');
          if (url) {
            flush();
            parent.appendChild(mdLink(url, url));
            i += url.length; continue;
          }
        }
        m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(s.slice(i));
        if (m && (m[1] === '**' || !/[\w]/.test(s[i - 1] || ''))) { // _ 粗体不允许词内
          flush();
          var strong = document.createElement('strong');
          mdInline(strong, m[2]);
          parent.appendChild(strong);
          i += m[0].length; continue;
        }
        m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(s.slice(i));
        if (m) {
          flush();
          var del = document.createElement('del');
          mdInline(del, m[1]);
          parent.appendChild(del);
          i += m[0].length; continue;
        }
        m = /^\*(?=\S)([\s\S]*?\S)\*/.exec(s.slice(i));
        if (m) {
          flush();
          var em1 = document.createElement('em');
          mdInline(em1, m[1]);
          parent.appendChild(em1);
          i += m[0].length; continue;
        }
        m = /^_(?=\S)([\s\S]*?\S)_/.exec(s.slice(i));
        if (m && !/[\w]/.test(s[i - 1] || '') && !/[\w]/.test(s[i + m[0].length] || '')) { // _ 斜体需词边界
          flush();
          var em2 = document.createElement('em');
          mdInline(em2, m[1]);
          parent.appendChild(em2);
          i += m[0].length; continue;
        }
        buf += c; i++;
      }
      flush();
    }
    // 表格行拆分（尊重 \| 转义，去首尾管道）
    function mdSplitRow(line) {
      var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
      return t.replace(/\\\|/g, '\u0000').split('|').map(function (cell) { return cell.replace(/\u0000/g, '|').trim(); });
    }
    // 列表（缩进嵌套 + 任务列表 [x]）；返回 { el, i }
    function mdList(lines, i) {
      var first = /^( *)([-*+]|\d{1,9}[.)])\s+/.exec(lines[i]);
      var indent = first[1].length;
      var ordered = /\d/.test(first[2]);
      var list = document.createElement(ordered ? 'ol' : 'ul');
      var itemRe = new RegExp('^( *)(' + (ordered ? '\\d{1,9}[.)]' : '[-*+]') + ')\\s+');
      while (i < lines.length) {
        if (!lines[i].trim()) {
          var nm = i + 1 < lines.length ? itemRe.exec(lines[i + 1]) : null; // 空行后仍有同级条目 → 宽松列表继续
          if (nm && nm[1].length === indent) { i++; continue; }
          break;
        }
        var m = itemRe.exec(lines[i]);
        if (!m || m[1].length !== indent) break; // 缩进不同 → 交给上层/嵌套处理
        var li = document.createElement('li');
        var content = [lines[i].slice(m[0].length)];
        i++;
        while (i < lines.length && lines[i].trim()) { // 收集延续行：更深缩进（嵌套列表/段落延续）
          var mm = itemRe.exec(lines[i]);
          if (mm && mm[1].length <= indent) break;   // 同级/更浅条目 → 本条目结束
          content.push(lines[i].replace(new RegExp('^ {' + (indent + 2) + '}'), ''));
          i++;
        }
        var tm = /^\[([ xX])\]\s+/.exec(content[0]);
        if (tm) { // 任务列表
          li.className = 'mdTask';
          var box = document.createElement('span');
          box.textContent = tm[1] === ' ' ? '☐' : '☑';
          li.appendChild(box);
          li.appendChild(document.createTextNode(' '));
          content[0] = content[0].slice(tm[0].length);
        }
        var holder = document.createElement('div');
        mdBlocks(holder, content);
        while (holder.firstChild) li.appendChild(holder.firstChild);
        list.appendChild(li);
      }
      return { el: list, i: i };
    }
    // 块级解析：fenced 代码块 / 标题 / 分隔线 / 引用块 / GFM 表格 / 列表 / 段落（软换行 → <br>）
    function mdBlocks(parent, lines) {
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        if (!line.trim()) { i++; continue; }
        var mF = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (mF) {
          var fenceChar = mF[1][0];
          var closeRe = new RegExp('^ {0,3}\\' + fenceChar + '{3,}\\s*$');
          var body = [];
          i++;
          while (i < lines.length && !closeRe.test(lines[i])) { body.push(lines[i]); i++; }
          if (i < lines.length) i++; // 跳过闭合围栏
          var pre = document.createElement('pre');
          pre.className = 'mdCode';
          var lang = mF[2].trim();
          if (lang) pre.setAttribute('data-lang', lang);
          var codeBlock = document.createElement('code');
          codeBlock.textContent = body.join('\n');
          pre.appendChild(codeBlock);
          parent.appendChild(pre);
          continue;
        }
        var mH = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (mH) {
          var h = document.createElement('h' + mH[1].length);
          mdInline(h, mH[2]);
          parent.appendChild(h);
          i++; continue;
        }
        if (/^\s{0,3}((-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$)/.test(line)) {
          parent.appendChild(document.createElement('hr'));
          i++; continue;
        }
        if (/^ {0,3}>/.test(line)) {
          var q = [];
          while (i < lines.length && /^ {0,3}>/.test(lines[i])) { q.push(lines[i].replace(/^ {0,3}>\s?/, '')); i++; }
          var bq = document.createElement('blockquote');
          mdBlocks(bq, q);
          parent.appendChild(bq);
          continue;
        }
        if (line.indexOf('|') !== -1 && i + 1 < lines.length && lines[i + 1].indexOf('|') !== -1 &&
            /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1])) {
          var head = mdSplitRow(line);
          var aligns = mdSplitRow(lines[i + 1]).map(function (cell) {
            var l = cell[0] === ':', r = cell[cell.length - 1] === ':';
            return (l && r) ? 'center' : (r ? 'right' : (l ? 'left' : ''));
          });
          i += 2;
          var tbl = document.createElement('table');
          var thead = document.createElement('thead');
          var trh = document.createElement('tr');
          head.forEach(function (cellText, ci) {
            var th = document.createElement('th');
            if (aligns[ci]) th.style.textAlign = aligns[ci];
            mdInline(th, cellText);
            trh.appendChild(th);
          });
          thead.appendChild(trh);
          tbl.appendChild(thead);
          var tbody = document.createElement('tbody');
          while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
            var tr = document.createElement('tr');
            mdSplitRow(lines[i]).forEach(function (cellText, ci) {
              var td = document.createElement('td');
              if (aligns[ci]) td.style.textAlign = aligns[ci];
              mdInline(td, cellText);
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
            i++;
          }
          tbl.appendChild(tbody);
          parent.appendChild(tbl);
          continue;
        }
        if (/^ *([-*+]|\d{1,9}[.)])\s+/.test(line)) {
          var res = mdList(lines, i);
          parent.appendChild(res.el);
          i = res.i;
          continue;
        }
        var para = [line]; // 段落：累积到空行或块级起始
        i++;
        while (i < lines.length && lines[i].trim() &&
            !/^ {0,3}(`{3,}|~{3,})/.test(lines[i]) &&
            !/^ {0,3}#{1,6}\s/.test(lines[i]) &&
            !/^ {0,3}>/.test(lines[i]) &&
            !/^ *([-*+]|\d{1,9}[.)])\s+/.test(lines[i]) &&
            !/^\s{0,3}((-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$)/.test(lines[i])) {
          para.push(lines[i]);
          i++;
        }
        var pe = document.createElement('p');
        for (var pi = 0; pi < para.length; pi++) {
          if (pi) pe.appendChild(document.createElement('br'));
          mdInline(pe, para[pi]);
        }
        parent.appendChild(pe);
      }
    }
    // 渲染入口：清空后按块解析重建（流式 partial 每帧全量重渲染，规模小、无性能问题）
    function mdRender(el, src) {
      el.textContent = '';
      mdBlocks(el, String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n'));
    }

    function bubble(text, who, md) {
      var log = $('chatLog');
      var b = document.createElement('div');
      b.className = 'bubble ' + (who === 'user' ? 'bUser' : 'bBot');
      if (md) { b._mdRaw = text; mdRender(b, text); } // _mdRaw：去重「原位采纳」比对原始文本
      else b.textContent = text;
      log.appendChild(b);
      b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return b;
    }

    // ---- 权威渲染：/api/chat/watch（优先 WebSocket——公网隧道会缓冲 GET SSE 流式响应体，
    //      WS 帧不被缓冲且支持心跳保活（与 dsh-pocket 一致）；WS 不可用时回落 EventSource SSE） ----
    var renderedSeqs = {};   // 已渲染帧 seq → true（快照/兜底轮询幂等去重）
    var watchSid = null;     // 当前 watch 绑定的宿主会话 id（hello 帧携带；会话重建后 seq 撞号，需清表）
    var lastWatchFrameTs = Date.now(); // 最近一次收到 watch 帧（含 ping）的时间：静默僵尸连接检测
    var liveEl = null;       // 流式增量气泡（手机发送与电脑端生成共用）
    var lastPartialText = '';
    var pendingLocalUser = null; // 手机刚发出、尚未被 watch 确认的用户气泡 {text, el}

    function ensureLive() {
      if (liveEl && liveEl.parentNode) return liveEl;
      liveEl = bubble('…', 'bot');
      return liveEl;
    }
    function dropLive() {
      if (liveEl && liveEl.parentNode) liveEl.parentNode.removeChild(liveEl);
      liveEl = null;
      lastPartialText = '';
    }

    // ---- 思考过程 / 工具调用（与 DSH 生成过程同步展示；完整过程含工具入参与输出） ----
    // DeepSeek 风格：生成中标签「💭 深度思考中…」并展开跟随滚动；结束后收起，标签变
    // 「💭 已深度思考（用时 N 秒）」保留在对话流里。快照回放块（fresh）直接呈收起态。
    var reasonEl = null;   // 当前轮的思考过程折叠块（结束后收起保留）
    var reasonStartTs = 0; // 本轮思考开始时刻（结束时计算用时）
    function updateReasoning(text, fresh) {
      if (!text) return;
      if (fresh && reasonEl && reasonEl.parentNode) settleReasoning(); // 快照回放：每个步骤一个折叠块
      if (!reasonEl || !reasonEl.parentNode) {
        reasonEl = document.createElement('details');
        reasonEl.className = 'bReason';
        var sum = document.createElement('summary');
        sum.textContent = fresh ? '💭 已深度思考' : '💭 深度思考中…';
        var body = document.createElement('div');
        body.className = 'rBody';
        reasonEl.appendChild(sum);
        reasonEl.appendChild(body);
        if (!fresh) {
          try { reasonEl.open = true; } catch (e) {}
          reasonStartTs = Date.now();
        } else {
          try { reasonEl.open = false; } catch (e) {} // 快照回放块直接呈收起态
        }
        $('chatLog').appendChild(reasonEl);
        pinBottom();
      }
      var body2 = reasonEl.querySelector('.rBody');
      if (body2) {
        body2.textContent = text;
        if (reasonEl.open) {
          try { body2.scrollTop = body2.scrollHeight; } catch (e) {}
          if (nearBottom($('chatLog'))) pinBottom(); // 生成中跟随滚动（用户上翻回看时不打扰）
        }
      }
    }
    // ---- 工具卡片：🔧 名称 + 入参 + 输出（运行中 ⏳ / 成功 ✓ / 失败 ✕） ----
    var toolEls = {}; // callId → 卡片元素
    function toolCard(j) {
      if (j.seq !== undefined) {
        if (renderedSeqs[j.seq]) return;
        renderedSeqs[j.seq] = true;
      }
      var id = j.id || ('seq-' + (j.seq ?? Math.random()));
      if (toolEls[id] && toolEls[id].parentNode) return toolEls[id]; // 重复推送幂等
      var d = document.createElement('details');
      d.className = 'bToolCard';
      var sum = document.createElement('summary');
      var stat = document.createElement('span');
      stat.className = 'tstat';
      stat.textContent = '⏳ ' + (j.name || 'tool');
      sum.appendChild(stat);
      d.appendChild(sum);
      if (j.args) {
        var pre = document.createElement('pre');
        pre.textContent = String(j.args);
        d.appendChild(pre);
      }
      var res = document.createElement('pre');
      res.style.display = 'none';
      d.appendChild(res);
      $('chatLog').appendChild(d);
      toolEls[id] = d;
      pinBottom();
      return d;
    }
    function lastOpenToolCard() {
      var cards = $('chatLog').querySelectorAll('.bToolCard');
      for (var i = cards.length - 1; i >= 0; i--) { if (cards[i].getAttribute('data-done') !== '1') return cards[i]; }
      return null;
    }
    function toolResultCard(j) {
      if (j.seq !== undefined) {
        if (renderedSeqs[j.seq]) return;
        renderedSeqs[j.seq] = true;
      }
      var id = j.id || '';
      var d = (id && toolEls[id] && toolEls[id].parentNode) ? toolEls[id] : (lastOpenToolCard() || toolCard({ id: id, name: 'tool' }));
      d.setAttribute('data-done', '1');
      var stat = d.querySelector('.tstat');
      if (stat) stat.textContent = (j.error ? '✕ ' : '✓ ') + (stat.textContent.replace(/^[⏳✓✕]\s*/, '') || 'tool');
      var pres = d.querySelectorAll('pre');
      var res = pres[pres.length - 1];
      if (res && j.text) {
        res.textContent = String(j.text);
        res.style.display = 'block';
        if (j.error) res.classList.add('terr');
      }
    }
    function settleReasoning() {
      if (reasonEl && reasonEl.parentNode) {
        try { reasonEl.open = false; } catch (e) {}
        var sum = reasonEl.querySelector('summary');
        if (sum) {
          var sec = reasonStartTs ? Math.max(1, Math.round((Date.now() - reasonStartTs) / 1000)) : 0;
          sum.textContent = sec ? '💭 已深度思考（用时 ' + sec + ' 秒）' : '💭 已深度思考';
        }
      }
      reasonEl = null; // 下一轮思考创建新的折叠块
      reasonStartTs = 0;
    }

    function nearBottom(el) {
      return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    }

    // 注入设定剥离（客户端兜底）：服务端镜像（chat-setup.mjs stripSetup）已剥首条消息内联的
    // 系统设定，这里按同款协议分隔标记再剥一次，保证设定全文任何情况下都不显示在对话里。
    var SETUP_SEPS = ['〔以上是系统设定；以下是用户消息〕', '（以上为系统设定。下面是用户消息：）'];
    function stripSetupClient(s) {
      s = String(s == null ? '' : s);
      for (var i = 0; i < SETUP_SEPS.length; i++) {
        var k = s.indexOf(SETUP_SEPS[i]);
        if (k !== -1) return s.slice(k + SETUP_SEPS[i].length).replace(/^\s+/, '');
      }
      return s;
    }

    // 对话页不在前台时点亮标签红点（新回复 / 待处理的提问与批准）；回到对话页清除
    function setChatDot(on) {
      var d = $('chatDot');
      if (d) d.className = 'dot' + (on ? ' on' : '');
    }
    function chatDotIfHidden() { if (curTab !== 'chat') setChatDot(true); }

    function appendServerMessage(msg) {
      if (!msg || renderedSeqs[msg.seq]) return;
      renderedSeqs[msg.seq] = true;
      var text = msg.role === 'user' ? stripSetupClient(msg.text) : msg.text;
      if (msg.role === 'user') {
        // 手机本地刚发的同文本气泡 → 原位采纳（避免重复）。
        // 不能用「对话区最后一个元素」判断：发送后末尾会紧跟流式气泡/思考块/工具卡，
        // 待确认的用户气泡不在最后。优先用发送时记录的元素引用（pendingLocalUser.el）定位，
        // 找不到时再向前小范围扫描兜底。比对用 _mdRaw（markdown 渲染前的原始文本）。
        var sameText = function (el) { return (el._mdRaw !== undefined && el._mdRaw === text) || el.textContent === text; };
        var take = null;
        var p = pendingLocalUser;
        if (p && p.el && p.el.parentNode && p.el.getAttribute('data-local') === '1' && sameText(p.el)) {
          take = p.el;
        } else {
          var kids = $('chatLog').children;
          for (var i = kids.length - 1; i >= 0 && i >= kids.length - 8; i--) {
            if (kids[i].classList.contains('bUser') && kids[i].getAttribute('data-local') === '1' && sameText(kids[i])) { take = kids[i]; break; }
          }
        }
        if (take) { take.removeAttribute('data-local'); pendingLocalUser = null; return; }
        settleReasoning(); // 新一轮对话开始
        bubble(text, 'user', true);
      } else {
        dropLive(); // 最终消息覆盖流式气泡
        settleReasoning(); // 思考过程收起保留在对话流中
        bubble(text, 'bot', true);
        chatDotIfHidden(); // 用户在日程页时红点提示有新回复
        load(); // DSH 可能修改了 schedule.json
      }
    }

    var watchWS = null;
    var watchES = null;
    var watchTransport = 'none';
    var reasoningSeen = {}; // 快照思考块去重（内容前缀 → true）
    // ---- 日程自动刷新：最终消息落地时必刷新；工具结果到达时节流刷新 ----
    // DSH 修改 schedule.json 的标志是写文件工具返回；不等最终消息，改完即刷，
    // 即使消息帧丢失/延迟，日程视图也能跟上（此前只在最终消息帧刷新，帧一丢就"要手动刷新才可见"）
    var lastSchedRefreshTs = 0;
    function scheduleMaybeChanged() {
      var now = Date.now();
      if (now - lastSchedRefreshTs < 2000) return;
      lastSchedRefreshTs = now;
      load();
    }
    function handleWatchFrame(j) {
      if (!j) return;
      lastWatchFrameTs = Date.now(); // 任何帧（含 ping）都证明连接活着
      if (j.t === 'hello') {
        // 快照前的首帧：sid 变化 = 服务端重建过会话（宿主失效自愈/污染重置）。
        // seq 是每会话独立编号，旧表会撞号误丢新会话的帧 → 清空按会话去重的表（DOM 保留作视觉历史）
        if (j.sid) {
          if (watchSid && watchSid !== j.sid) { renderedSeqs = {}; reasoningSeen = {}; }
          watchSid = j.sid;
        }
        return;
      }
      if (j.t === 'ping') return; // 服务端应用层心跳：只刷新 lastWatchFrameTs
      if (j.t === 'reset') {
        // 服务端重建了会话并已把本连接改绑到新会话：清状态并立即重连拿新会话快照
        renderedSeqs = {}; reasoningSeen = {}; watchSid = null;
        dropLive();
        setTimeout(openWatch, 300);
        return;
      }
      if (j.t === 'message') appendServerMessage(j);
      else if (j.t === 'question') renderQuestionCard(j);
      else if (j.t === 'approval') renderApprovalCard(j);
      else if (j.t === 'resolved') resolveCard(j);
      else if (j.t === 'note') renderNoteCard(j);
      else if (j.t === 'tool') toolCard(j);
      else if (j.t === 'toolresult') { toolResultCard(j); scheduleMaybeChanged(); }
      else if (j.t === 'reasoning') {
        if (j.fresh) {
          // 快照回放：每个步骤的完整思考一个折叠块，按内容去重（兜底轮询会重复推送）
          var rk = 'r:' + String(j.text || '').slice(0, 80);
          if (!reasoningSeen[rk]) { reasoningSeen[rk] = true; updateReasoning(j.text, true); }
        } else {
          updateReasoning(j.text); // 实时增量（当前步骤累计文本）
        }
      }
      else if (j.t === 'partial') {
        var el = ensureLive();
        if (j.text) { lastPartialText = j.text; mdRender(el, j.text); }
        else if (lastPartialText) mdRender(el, lastPartialText + '\n…（继续处理中）');
        else el.textContent = 'DSH 处理中…';
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }

    // 连接断了（WS 与 SSE 共用）：先静默复核会话（authOk 是页面内存标志，重开网页必为
    // false 但 Cookie 可能仍有效——直接弹窗就是「已登录却再要密码」的误弹）；确实失效才弹登录框
    function watchDown() {
      if (!authOk) {
        sessionProbe().then(function (valid) {
          if (valid) { authOk = true; setTimeout(openWatch, 300); }
          else ensureAuth().then(function (ok) { if (ok) setTimeout(openWatch, 300); });
        });
      } else {
        setTimeout(openWatch, Math.min(3000, 500 + Math.floor(Math.random() * 500)));
      }
    }

    function openWatch() {
      try { if (watchES) { watchES.close(); watchES = null; } } catch (e) {}
      // 关旧连接时同时摘掉 onmessage：已排队帧不再派发（新建对话清屏后旧会话帧一帧不留）
      try { if (watchWS) { watchWS.onclose = watchWS.onerror = watchWS.onmessage = null; watchWS.close(); watchWS = null; } } catch (e) {}
      // 优先 WebSocket：移动网络中间设备可能缓冲 GET SSE 流式响应体，手机长时间收不到
      // 任何帧；WebSocket 帧不被缓冲，且服务端注入协议层 Ping 心跳保活。
      // Cookie 随同源 WS 握手自动携带。
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      var ws;
      try { ws = new WebSocket(proto + '//' + location.host + '/api/chat/watch'); }
      catch (e) { return openWatchSSE(); }
      watchWS = ws;
      watchTransport = 'ws';
      var helloed = false;
      ws.onmessage = function (e) {
        var j = null;
        try { j = JSON.parse(e.data); } catch (err) { return; }
        if (j.t === 'hello') helloed = true;
        handleWatchFrame(j);
      };
      ws.onclose = function () {
        if (watchWS !== ws) return;
        watchWS = null;
        if (helloed) { watchDown(); return; } // 用过且断开 → 重连
        // 握手都没成功（鉴权失败/中间层拒绝 WS）→ 回落 SSE（EventSource）
        openWatchSSE();
      };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }

    // 兜底通道：EventSource SSE（局域网/WS 被中间层拦时使用；服务端 15 秒心跳注释行保活）
    function openWatchSSE() {
      try { if (watchES) watchES.close(); } catch (e) {}
      watchTransport = 'sse';
      var es = new EventSource('/api/chat/watch');
      watchES = es;
      es.onmessage = function (e) {
        var j = null;
        try { j = JSON.parse(e.data); } catch (err) { return; }
        handleWatchFrame(j);
      };
      es.onerror = function () {
        // 致命关闭：EventSource 遇非 200（如限流 503）不再自动重连 → 交给 watchDown 统一重开
        if (es.readyState === EventSource.CLOSED) {
          if (watchES !== es) return;
          watchES = null;
          watchDown();
        }
        // CONNECTING（网络闪断）由 EventSource 自动重连，不处理
      };
    }

    // ---- 连接活性自检（修复"无流式响应、刷新才可见"的另一半根因）----
    // 服务端每 15/25 秒发应用层 ping。手机休眠/运营商 NAT 静默丢映射时连接双方都
    // 收不到断开通知：服务端写帧进黑洞、手机端 onclose 永不触发，页面就永远停在
    // "DSH 处理中…"。前台页面超过 45 秒没收到任何帧 → 判死并主动重连，不等 onclose。
    function watchZombieHeal() {
      if (document.hidden) return; // 后台挂起时定时器不跑也不判（回到前台由 visibilitychange 立即判）
      if (Date.now() - lastWatchFrameTs <= 45000) return;
      lastWatchFrameTs = Date.now(); // 重置计时防重连风暴（本轮重连后 45 秒内不再触发）
      openWatch(); // openWatch 会关掉旧连接（含摘除 onmessage）并重开
    }
    setInterval(watchZombieHeal, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) watchZombieHeal(); });
    // ---- 交互卡片：回答 DSH 的问题 / 批准工具调用（POST /api/respond 回传宿主） ----
    var liveCards = {}; // rpcId → 卡片元素
    function pinBottom() { var log = $('chatLog'); log.scrollTop = log.scrollHeight; }

    function respond(payload, badge) {
      badge.textContent = '提交中…';
      apiFetch('/api/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok) badge.textContent = '已提交 ✓（等待 DSH 继续）';
        else badge.textContent = '提交失败：' + ((j && j.error) || '未知错误');
      }).catch(function (err) { badge.textContent = '提交失败：' + (err.message || err); });
    }

    function renderQuestionCard(j) {
      if (liveCards[j.rpcId]) return; // 已渲染（重连快照重复推送）
      chatDotIfHidden(); // 待处理的提问：日程页标签红点提示
      var card = document.createElement('div');
      card.className = 'qcard';
      var badge = document.createElement('div');
      badge.className = 'qbadge';
      var selections = {}; // questionId → Set(label)
      (j.questions || []).forEach(function (q) {
        selections[q.id] = new Set();
        var t = document.createElement('div');
        t.className = 'qtitle';
        t.textContent = (q.header ? q.header + ' · ' : '') + q.question;
        card.appendChild(t);
        if (q.detail) { var d = document.createElement('div'); d.className = 'qdetail'; d.textContent = q.detail; card.appendChild(d); }
        var opts = document.createElement('div');
        opts.className = 'qopts';
        var custom = null;
        (q.options || []).forEach(function (o) {
          var label = o.label;
          var b = document.createElement('button');
          b.className = 'qopt';
          b.textContent = label;
          if (o.description) { var s = document.createElement('small'); s.textContent = o.description; b.appendChild(s); }
          b.onclick = function () {
            if (card.classList.contains('done')) return;
            if (q.multiSelect) {
              if (selections[q.id].has(label)) { selections[q.id].delete(label); b.classList.remove('on'); }
              else { selections[q.id].add(label); b.classList.add('on'); }
            } else {
              selections[q.id].clear();
              Array.prototype.forEach.call(opts.children, function (x) { x.classList.remove('on'); });
              selections[q.id].add(label);
              b.classList.add('on');
            }
          };
          opts.appendChild(b);
        });
        card.appendChild(opts);
        custom = document.createElement('input');
        custom.className = 'qcustom';
        custom.placeholder = '其他（可自由输入）';
        card.appendChild(custom);
        custom.setAttribute('data-qid', q.id);
      });
      var submit = document.createElement('button');
      submit.className = 'qsubmit';
      submit.textContent = '提交回答';
      submit.onclick = function () {
        var answer = [];
        var ok = true;
        (j.questions || []).forEach(function (q) {
          var custEl = card.querySelector('.qcustom[data-qid="' + q.id + '"]');
          var customText = String(custEl && custEl.value || '').trim();
          var item = { id: q.id, selected: Array.from(selections[q.id]) };
          if (customText) item.custom = customText;
          if (!item.selected.length && !customText) ok = false;
          answer.push(item);
        });
        if (!ok) { badge.textContent = '请先选择或输入答案'; return; }
        submit.disabled = true;
        respond({ rpcId: j.rpcId, kind: 'question', answer: answer }, badge);
      };
      card.appendChild(submit);
      card.appendChild(badge);
      $('chatLog').appendChild(card);
      liveCards[j.rpcId] = card;
      pinBottom();
    }

    function renderApprovalCard(j) {
      if (liveCards[j.rpcId]) return;
      chatDotIfHidden(); // 待处理的批准：日程页标签红点提示
      var card = document.createElement('div');
      card.className = 'qcard';
      var t = document.createElement('div');
      t.className = 'qtitle';
      t.textContent = '⚠️ 需要批准：' + (j.toolName || '工具调用');
      card.appendChild(t);
      if (j.reason) { var d = document.createElement('div'); d.className = 'qdetail'; d.textContent = j.reason; card.appendChild(d); }
      var badge = document.createElement('div');
      badge.className = 'qbadge';
      var row = document.createElement('div');
      row.style.display = 'flex'; row.style.gap = '8px'; row.style.justifyContent = 'flex-end';
      function act(outcome) {
        Array.prototype.forEach.call(row.children, function (b) { b.disabled = true; });
        respond({ rpcId: j.rpcId, kind: 'approval', approvalId: j.approvalId, outcome: outcome }, badge);
      }
      var no = document.createElement('button');
      no.className = 'qsubmit'; no.style.background = 'transparent'; no.style.border = '1px solid #d1d5db'; no.style.color = 'inherit';
      no.textContent = '拒绝'; no.onclick = function () { act('rejected'); };
      var yes = document.createElement('button');
      yes.className = 'qsubmit';
      yes.textContent = '批准一次'; yes.onclick = function () { act('allowed-once'); };
      row.appendChild(no); row.appendChild(yes);
      card.appendChild(row);
      card.appendChild(badge);
      $('chatLog').appendChild(card);
      liveCards[j.rpcId] = card;
      pinBottom();
    }

    function resolveCard(j) {
      var card = liveCards[j.rpcId];
      if (!card) return;
      card.classList.add('done');
      card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      var badge = card.querySelector('.qbadge');
      if (badge) badge.textContent = '已处理（' + (j.outcome || 'resolved') + '）';
      delete liveCards[j.rpcId];
    }

    // 提示卡（如：会话卡在早前电脑端的提问，可取消本轮解阻塞）
    function renderNoteCard(j) {
      var key = 'note-' + (j.text || '').slice(0, 24);
      if (liveCards[key]) return;
      var card = document.createElement('div');
      card.className = 'qcard';
      var t = document.createElement('div');
      t.className = 'qdetail';
      t.textContent = j.text || '';
      card.appendChild(t);
      if (j.cancellable) {
        var btn = document.createElement('button');
        btn.className = 'qsubmit';
        btn.textContent = '取消本轮';
        var badge = document.createElement('div');
        badge.className = 'qbadge';
        btn.onclick = function () {
          btn.disabled = true;
          badge.textContent = '取消中…';
          apiFetch('/api/chat/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function (r) { return r.json(); })
            .then(function (r2) { badge.textContent = r2.ok ? '已取消，可重新发送消息' : '取消失败：' + (r2.error || ''); })
            .catch(function (e) { badge.textContent = '取消失败：' + (e.message || e); });
        };
        card.appendChild(btn);
        card.appendChild(badge);
      }
      $('chatLog').appendChild(card);
      liveCards[key] = card;
      pinBottom();
    }

    openWatch();

    // ---------- 图片附件（拍照/相册 → 压缩 → base64） ----------
    var attachments = []; // {mediaType, data(base64 无前缀), name, preview(dataURL)}
    var MAX_ATTACH = 4;

    function renderThumbs() {
      var wrap = $('chatThumbs');
      wrap.innerHTML = '';
      wrap.style.display = attachments.length ? 'flex' : 'none';
      attachments.forEach(function (a, i) {
        var t = document.createElement('div');
        t.className = 'thumb';
        var img = document.createElement('img');
        img.src = a.preview;
        var rm = document.createElement('button');
        rm.textContent = '×';
        rm.onclick = function () { attachments.splice(i, 1); renderThumbs(); };
        t.appendChild(img); t.appendChild(rm);
        wrap.appendChild(t);
      });
    }

    // 非动图统一压缩：最长边 1568px、JPEG 82%（动图 gif 直接原样，保留动画）
    function compressImage(file) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onerror = function () { reject(new Error('读取失败')); };
        fr.onload = function () {
          var dataUrl = String(fr.result);
          if (file.type === 'image/gif') {
            resolve({ mediaType: 'image/gif', data: dataUrl.split(',')[1], name: file.name, preview: dataUrl });
            return;
          }
          var img = new Image();
          img.onerror = function () { reject(new Error('图片解析失败')); };
          img.onload = function () {
            var maxSide = 1568;
            var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            var out = c.toDataURL('image/jpeg', 0.82);
            resolve({ mediaType: 'image/jpeg', data: out.split(',')[1], name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', preview: out });
          };
          img.src = dataUrl;
        };
        fr.readAsDataURL(file);
      });
    }

    $('chatAttach').onclick = function () { $('chatFile').click(); };
    $('chatFile').addEventListener('change', function () {
      var files = Array.prototype.slice.call($('chatFile').files || []);
      $('chatFile').value = '';
      var room = MAX_ATTACH - attachments.length;
      if (files.length > room) files = files.slice(0, room);
      var chain = Promise.resolve();
      files.forEach(function (f) {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) return;
        chain = chain.then(function () {
          return compressImage(f).then(function (a) { attachments.push(a); renderThumbs(); });
        });
      });
      chain.catch(function (e) { bubble('图片处理失败：' + e.message, 'bot'); });
    });

    var chatBusyUI = false;
    function sendChat() {
      if (chatBusyUI) return;
      var input = $('chatIn');
      var text = String(input.value || '').trim();
      if (!text && !attachments.length) return;
      input.value = '';
      chatInGrow(); // 发送后收回增高
      var imgs = attachments.slice();
      var ub = bubble(text || '（图片）', 'user', true);
      ub.setAttribute('data-local', '1'); // 待 watch 流确认后原位采纳
      pendingLocalUser = { text: text, el: ub };
      attachments = [];
      renderThumbs();
      var live = ensureLive();
      live.textContent = 'DSH 处理中…（可能需要十几秒）';
      chatBusyUI = true;
      $('chatSend').disabled = true;
      $('chatAttach').disabled = true;

      // 发送走流式端点（增量即时反馈）；最终消息与用户气泡由 watch 流统一落地
      var gen = chatGen; // 本轮发送所属的会话代数（新建对话后旧流帧全部丢弃）
      function handleFrame(line) {
        if (gen !== chatGen) return;
        if (line.indexOf('data: ') !== 0) return;
        var j = null;
        try { j = JSON.parse(line.slice(6)); } catch (e) { return; }
        if (j.t === 'partial') {
          if (j.text) { lastPartialText = j.text; mdRender(live, j.text); }
          else if (lastPartialText) mdRender(live, lastPartialText + '\n…（继续处理中）');
          live.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else if (j.t === 'done') {
          // watch 流会把最终 assistant/message 送来并移除实时气泡；此处仅兜底展示
          if (live.parentNode && j.reply) mdRender(live, j.reply);
          load();
        } else if (j.t === 'error') {
          dropLive();
          bubble('发送失败：' + (j.error || 'unknown'), 'bot');
        }
      }

      apiFetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ message: text, images: imgs })
      }).then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        if (r.body && r.body.getReader) {
          var reader = r.body.getReader();
          var dec = new TextDecoder();
          var buf = '';
          return (function pump() {
            return reader.read().then(function (chunk) {
              if (chunk.done) return;
              buf += dec.decode(chunk.value, { stream: true });
              var idx;
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                var frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                handleFrame(frame.trim());
              }
              return pump();
            });
          })();
        }
        return r.text().then(function (all) { all.split('\n\n').forEach(function (f) { handleFrame(f.trim()); }); });
      }).catch(function (err) {
        if (gen !== chatGen) return; // 会话已重建：旧流失败不写入新对话
        dropLive();
        bubble('发送失败：' + (err.message || err), 'bot');
      }).then(function () {
        if (gen !== chatGen) return;
        chatBusyUI = false;
        $('chatSend').disabled = false;
        $('chatAttach').disabled = false;
      });
    }
    $('chatSend').onclick = sendChat;
    // 长文本输入：textarea 自适应增高（最高 35vh 后内部滚动），Enter 发送、Shift+Enter 换行
    function chatInGrow() {
      var ta = $('chatIn');
      if (!ta) return;
      ta.style.height = 'auto';
      var maxH = 260;
      try { if (window.innerHeight) maxH = Math.round(window.innerHeight * 0.35); } catch (e) {}
      ta.style.height = Math.max(42, Math.min(ta.scrollHeight || 42, maxH)) + 'px';
    }
    try { $('chatIn').addEventListener('input', chatInGrow); } catch (e) {}
    $('chatIn').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); sendChat(); }
    });

    // ---------- 分页：日程 / 对话 两页切换（底部标签栏；状态记入 localStorage，重开恢复） ----------
    var curTab = 'sched';
    function showTab(name) {
      curTab = name === 'chat' ? 'chat' : 'sched';
      var sched = $('pageSched'), chat = $('pageChat');
      if (sched) sched.className = 'page pageSched' + (curTab === 'sched' ? ' on' : '');
      if (chat) chat.className = 'page pageChat' + (curTab === 'chat' ? ' on' : '');
      var b1 = $('tabSched'), b2 = $('tabChat');
      if (b1) b1.className = 'tabBtn' + (curTab === 'sched' ? ' on' : '');
      if (b2) b2.className = 'tabBtn' + (curTab === 'chat' ? ' on' : '');
      if (curTab === 'chat') setChatDot(false); // 回到对话页：清未读红点并贴底
      if (curTab === 'chat') pinBottom();
      try { localStorage.setItem('tt-tab', curTab); } catch (e) {}
    }
    if ($('tabSched')) $('tabSched').onclick = function () { showTab('sched'); };
    if ($('tabChat')) $('tabChat').onclick = function () { showTab('chat'); };
    try { showTab(localStorage.getItem('tt-tab') === 'chat' ? 'chat' : 'sched'); }
    catch (e) { showTab('sched'); }

    load();
  })();
