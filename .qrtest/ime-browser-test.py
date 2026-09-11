# -*- coding: utf-8 -*-
# ime-browser-test.py — 浏览器级验证：中文输入法组词回车不误发消息。
# 方法：playwright(chromium) 加载真实 mobile.html + mobile-app.js，
#       用 CDP Input.imeSetComposition 驱动 Chromium 真实输入管线产生
#       compositionstart/update/end 与真实 keydown(isComposing/keyCode)，
#       验证：① 组词中回车=确认候选词，不发送；② 组词结束后回车=正常发送。
# 运行：D:\anaconda3\python.exe .qrtest\ime-browser-test.py
# 输出统一 ASCII（[OK]/[FAIL]），GBK 控制台安全。
import http.server
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OK, FAIL = [], []


def check(cond, name):
    (OK if cond else FAIL).append(name)
    print('  [%s] %s' % ('OK' if cond else 'FAIL', name))


INIT_JS = r"""
(() => {
  window.__keylog = [];
  window.__cmp = [];
  window.__fetches = [];
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'chatIn') {
      window.__keylog.push({ key: e.key, keyCode: e.keyCode, isComposing: e.isComposing });
    }
  }, true);
  ['compositionstart', 'compositionupdate', 'compositionend'].forEach((t) => {
    document.addEventListener(t, (e) => {
      if (e.target && e.target.id === 'chatIn') window.__cmp.push(t);
    }, true);
  });
  // 网络桩：记录全部 fetch；schedule/models 回最小合法响应，页面可完整初始化
  window.fetch = (url, opts) => {
    window.__fetches.push(String(url));
    const u = String(url);
    const body = u.indexOf('/api/schedule') !== -1 ? { events: [] }
      : u.indexOf('/api/chat/models') !== -1 ? { ok: true, current: { provider: 'p', model: 'm' } }
      : { ok: true };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  };
  // WS 桩：立即 hello，避免真实连接失败引发的无限重连噪音
  class FakeWS {
    constructor(u) {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = 1;
        if (this.onopen) this.onopen();
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ t: 'hello', sid: 'browser-test' }) });
      }, 0);
    }
    close() { this.readyState = 3; }
  }
  window.WebSocket = FakeWS;
})();
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass


def streams(fetches):
    return [u for u in fetches if u.find('/api/chat/stream') != -1]


def main():
    from playwright.sync_api import sync_playwright

    with socketserver.TCPServer(('127.0.0.1', 0), Handler) as httpd:
        port = httpd.server_address[1]
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()

        with sync_playwright() as p:
            browser = None
            for launch in (
                lambda: p.chromium.launch(headless=True),
                lambda: p.chromium.launch(headless=True, channel='msedge'),
                lambda: p.chromium.launch(headless=True, channel='chrome'),
            ):
                try:
                    browser = launch()
                    break
                except Exception as e:
                    last = e
            if browser is None:
                print('[FAIL] cannot launch chromium: %r' % (last,))
                sys.exit(2)
            ctx = browser.new_context()
            ctx.add_init_script(INIT_JS)
            page = ctx.new_page()
            cdp = ctx.new_cdp_session(page)

            page.goto('http://127.0.0.1:%d/mobile.html' % port)
            page.wait_for_selector('#chatIn', state='attached')
            page.wait_for_timeout(300)  # 等页面脚本初始化完毕
            page.click('#tabChat')  # 输入框在对话页（默认日程页隐藏），先切页签（真实用户路径）
            page.wait_for_selector('#chatIn', state='visible')
            page.focus('#chatIn')
            page.keyboard.type('x')  # 聚焦金丝雀：打字必须生效，否则后续全部无效
            v0 = page.locator('#chatIn').input_value()
            if v0 != 'x':
                print('[FAIL] focus canary failed: value=%r' % v0)
                sys.exit(2)
            page.evaluate('document.getElementById("chatIn").value = ""; window.__fetches = []; window.__keylog = [];')

            print('-- S1 组词：nihao（CDP 真实输入管线）--')
            page.focus('#chatIn')
            cdp.send('Input.imeSetComposition', {'text': 'nihao', 'selectionStart': 5, 'selectionEnd': 5})
            page.wait_for_timeout(200)
            val1 = page.locator('#chatIn').input_value()
            cmp1 = page.evaluate('window.__cmp')
            check('compositionstart' in cmp1, 'S1 compositionstart 触发（真实组词状态）')
            check('nihao' in val1, 'S1 组词文本进入输入框（value=%r）' % val1)

            print('-- S2 组词中回车：应被守卫拦下，不发送 --')
            n_before = len(streams(page.evaluate('window.__fetches')))
            page.keyboard.press('Enter')
            page.wait_for_timeout(250)
            val2 = page.locator('#chatIn').input_value()
            fetched2 = page.evaluate('window.__fetches')
            keylog = page.evaluate('window.__keylog')
            cmp2 = page.evaluate('window.__cmp')
            print('  keylog=%r' % (keylog,))
            print('  cmp=%r' % (cmp2,))
            check(len(keylog) >= 1 and keylog[-1]['isComposing'] is True,
                  'S2 组词中回车的真实 keydown 带 isComposing=True（守卫主条件命中）')
            check(len(streams(fetched2)) == n_before, 'S2 提交回车未发送消息')
            check('nihao' in val2, 'S2 选词文本保留在输入框（value=%r），消息未丢' % val2)

            print('-- S3 提交候选词（模拟选词上屏：insertText 结束组词）--')
            cdp.send('Input.insertText', {'text': 'nihao'})
            page.wait_for_timeout(250)
            val3 = page.locator('#chatIn').input_value()
            cmp3 = page.evaluate('window.__cmp')
            check('compositionend' in cmp3, 'S3 组词结束（compositionend）')
            check('nihao' in val3, 'S3 候选词上屏（value=%r）' % val3)
            check(len(streams(page.evaluate('window.__fetches'))) == n_before, 'S3 上屏动作本身不发送')

            print('-- S4 组词结束后再回车：应正常发送 --')
            page.keyboard.press('Enter')
            page.wait_for_timeout(300)
            fetched4 = page.evaluate('window.__fetches')
            keylog4 = page.evaluate('window.__keylog')
            val4 = page.locator('#chatIn').input_value()
            print('  keylog(tail)=%r' % (keylog4[-1:],))
            check(len(keylog4) >= 2 and keylog4[-1]['isComposing'] is False,
                  'S4 组词已结束：干净回车 isComposing=False（守卫放行）')
            check(len(streams(fetched4)) == n_before + 1, 'S4 干净回车触发发送（/api/chat/stream）')
            check(val4 == '', 'S4 发送后输入框清空（value=%r）' % val4)

            print('-- S5 Shift+Enter 换行不发送 --')
            page.keyboard.type('abc')
            page.keyboard.press('Shift+Enter')
            page.wait_for_timeout(150)
            val5 = page.locator('#chatIn').input_value()
            fetched5 = page.evaluate('window.__fetches')
            check(len(streams(fetched5)) == n_before + 1, 'S5 Shift+Enter 不发送')
            check(val5.find('\n') != -1, 'S5 Shift+Enter 插入换行（value=%r）' % val5.replace('\n', '\\n'))

            browser.close()
        httpd.shutdown()  # 干净停掉静态服务线程，避免解释器退出时 serve_forever 报异常

    print('\n结果: %d 通过 / %d 失败' % (len(OK), len(FAIL)))
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
