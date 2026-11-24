/* 路书核心：把行程文字解析成结构化数据，再渲染成一份独立的路书网页（不依赖任何外部文件）。
   当前版本是规则解析，不调用 AI；以后接入大模型时替换 parseItinerary 即可。 */
(function (global) {
  'use strict';

  var HAN = '\\u4e00-\\u9fa5';
  var SUFFIX = ['研究基地', '博物院', '博物馆', '国际机场', '机场', '火车站', '高铁站', '景区', '公园', '古镇', '古城', '古街', '老街',
    '不夜城', '城墙', '巷子', '广场', '基地', '雪山', '瀑布', '草原', '沙漠', '湿地', '酒店', '客栈', '宾馆', '民宿', '饭店', '度假村',
    '寺', '庙', '祠', '宫', '塔', '楼', '府', '馆', '园', '谷', '峡', '岛', '湖', '海', '山', '街', '堰', '洞', '村', '桥'];
  var NEXT_OK = '游漫看品骑打参逛自乘拍喝散览观赏玩吃接送赏';
  var PLACE_RE = new RegExp('([' + HAN + 'A-Za-z0-9·]{1,16}?(?:' + SUFFIX.join('|') + '))(?=$|[^' + HAN + ']|[' + NEXT_OK + '])', 'g');
  var END_RE = new RegExp('(?:' + SUFFIX.join('|') + ')$');
  var LEAD_RE =/^(?:\d{1,2}[:：]\d{2}|上午|下午|中午|晚上|早上|傍晚|早餐后|午餐后|晚餐后|出发前往|乘车前往|驱车前往|前往|乘车|驱车|游览|参观|抵达|到达|入住|返回|送往|接机|打卡|夜游|自由漫步|漫步|品尝|途经|出发|环|乘|赴|去|到|在|逛|游|看|送)+/;
  var SPLIT_RE = /[，,、。；;：:（）()\s→—~\/+和与及]+/;
  var TIME_RE = /^(\d{1,2}[:：]\d{2}|上午|下午|中午|晚上|早上|傍晚|全天|早餐后|午餐后|晚餐后)\s*[：:]?\s*/;
  var DAY_RE = /^(?:D\s*(\d+)|第\s*([一二三四五六七八九十\d]+)\s*天|Day\s*(\d+))\s*[：:、.\-]?\s*/i;
  var PHONE_RE = /1\d{2}[\s-]?\d{4}[\s-]?\d{4}|0\d{2,3}[\s-]?\d{4}[\s-]?\d{4}/;
  var NOT_STOP = /机场|酒店|客栈|宾馆|民宿|饭店|火车站|高铁站|度假村/;
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  function cnToNum(s) {
    if (/^\d+$/.test(s)) return +s;
    if (s.length === 1) return CN_NUM[s] || 0;
    if (s[0] === '十') return 10 + (CN_NUM[s[1]] || 0);
    return (CN_NUM[s[0]] || 0) * 10 + (CN_NUM[s[2]] || 0);
  }

  function detectPlaces(text) {
    var found = [];
    text.split(SPLIT_RE).forEach(function (tok) {
      tok = tok.replace(LEAD_RE, '');
      if (tok.length < 2) return;
      var m;
      PLACE_RE.lastIndex = 0;
      while ((m = PLACE_RE.exec(tok))) {
        var name = m[1].replace(LEAD_RE, '');
        var tail = name.match(/^.+?[上下到至往](.{2,})$/);
        if (tail && END_RE.test(tail[1])) name = tail[1];
        if (name.length >= 2 && found.indexOf(name) < 0) found.push(name);
      }
    });
    return found;
  }

  function splitList(s) {
    return s.split(/[；;\n]+/).map(function (x) { return x.replace(/^\s*(?:\d+\s*[.、．)]|[-•·])\s*/, '').trim(); }).filter(Boolean);
  }

  function headerOf(line) {
    var m = line.match(/^(费用包含|费用含|包含项目|费用不含|费用不包含|不含项目|温馨提示|注意事项|出行提示|特别提示|备注)\s*[：:]?\s*(.*)$/);
    if (!m) return null;
    var k = /不/.test(m[1]) ? 'exclude' : /包含|费用含/.test(m[1]) ? 'include' : 'notes';
    return { key: k, rest: m[2] };
  }

  /* 根据一天的原始文字，推导时间线、含餐、住宿、地点 */
  function buildDay(day) {
    var lines = day.text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    day.items = lines.map(function (l) {
      var m = l.match(TIME_RE);
      return { t: m ? m[1].replace('：', ':') : '', w: m ? l.slice(m[0].length) : l };
    });
    var all = lines.join('\n');
    var chips = [];
    ['早餐', '午餐', '晚餐'].forEach(function (meal) {
      var re = new RegExp(meal + '(?!后)[^，。；\\n]{0,14}?(不含|自理|含)');
      var m = all.match(re);
      if (m) chips.push(meal + (m[1] === '含' ? '含' : '自理'));
    });
    var hotel = all.match(/(?:入住|住宿|宿)[:：]?\s*([^\s，。,；;（(]{2,20}?(?:酒店|宾馆|客栈|民宿|饭店|度假村))/);
    if (hotel) chips.push('住：' + hotel[1]);
    else if (/住宿同前|同前住宿|连住/.test(all)) chips.push('住：同前一晚');
    day.chips = chips;
    if (!day.placesEdited) day.places = detectPlaces(all);
    return day;
  }

  function parseItinerary(raw) {
    var lines = String(raw || '').replace(/\r/g, '').split('\n').map(function (l) { return l.replace(/ /g, ' ').trim(); }).filter(Boolean);
    var data = { title: '', org: '示例旅行社', startDate: '', pax: '', city: '', contacts: [], days: [], include: [], exclude: [], notes: [] };
    var meta = [], cur = null, section = null;
    lines.forEach(function (line, i) {
      var dm = line.match(DAY_RE);
      if (dm && line.length < 60) {
        cur = { title: line.slice(dm[0].length).trim(), text: '', tip: '' };
        data.days.push(cur); section = null; return;
      }
      var h = headerOf(line);
      if (h) { section = h.key; cur = null; if (h.rest) data[section] = data[section].concat(splitList(h.rest)); return; }
      if (section) { data[section] = data[section].concat(splitList(line)); return; }
      if (cur) { cur.text += (cur.text ? '\n' : '') + line; return; }
      if (!data.title && i === 0) data.title = line; else meta.push(line);
    });
    var metaText = meta.join('\n');
    var d = metaText.match(/(20\d{2})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})/);
    if (d) data.startDate = d[1] + '-' + ('0' + d[2]).slice(-2) + '-' + ('0' + d[3]).slice(-2);
    var p = metaText.match(/(\d+)\s*人/);
    if (p) data.pax = p[1];
    var cre = /(导游|司机|领队|管家|地接)[^：:\d\n]{0,4}[：:]?\s*([一-龥]{1,4}?(?:导|师傅|老师|先生|女士)?)\s*((?:1\d{2}|0\d{2,3})[\s-]?\d{4}[\s-]?\d{4})/g, cm;
    while ((cm = cre.exec(metaText)) && data.contacts.length < 2) {
      data.contacts.push({ role: /司机/.test(cm[1]) ? '司机' : '导游', name: cm[2], tel: cm[3].replace(/-/g, ' ') });
    }
    var c = data.title.match(new RegExp('^([' + HAN + ']{2,6}?)\\s*(?:\\d+|[一二三四五六七八九十]+)\\s*[日天]'));
    data.city = c && c[1].length <= 3 ? c[1] : '';
    data.days.forEach(function (day, i) {
      if (!day.title) day.title = '第' + (i + 1) + '天';
      buildDay(day);
    });
    return data;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function dayDate(start, i) {
    if (!start) return '';
    var dt = new Date(start + 'T00:00:00');
    if (isNaN(dt)) return '';
    dt.setDate(dt.getDate() + i);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日 ' + WEEK[dt.getDay()];
  }

  function rangeText(start, n) {
    if (!start || !n) return '';
    var a = new Date(start + 'T00:00:00'), b = new Date(start + 'T00:00:00');
    if (isNaN(a)) return '';
    b.setDate(b.getDate() + n - 1);
    var left = (a.getMonth() + 1) + '月' + a.getDate() + '日';
    var right = (a.getMonth() === b.getMonth() ? '' : (b.getMonth() + 1) + '月') + b.getDate() + '日';
    return left + '–' + right + '（' + WEEK[a.getDay()] + '至' + WEEK[b.getDay()] + '）';
  }

  var ICO_NAV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-8-8 18-2-8-8-2z"/></svg>';
  var ICO_TEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2"/></svg>';

  var CSS = ':root{color-scheme:light dark;--bg:light-dark(#ffffff,#0f1714);--ink:light-dark(#14201b,#e8efe9);--muted:light-dark(#5b6b63,#9fb0a7);--green:light-dark(#1f4d3a,#143528);--leaf:light-dark(#eaf2ec,#17241e);--chili:light-dark(#c8322a,#ff6f61);--line:light-dark(#dde6df,#26352d);--card:light-dark(#ffffff,#132019)}' +
    '*{box-sizing:border-box;min-width:0}html{scroll-behavior:smooth}' +
    'body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 "PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif;overflow-x:clip;padding-bottom:calc(88px + env(safe-area-inset-bottom,0px))}' +
    '.wrap{max-width:640px;margin:0 auto}h1,h2,h3{font-family:"Songti SC","STSong","Noto Serif CJK SC","SimSun",serif;letter-spacing:-.01em;margin:0}a{color:inherit}' +
    '.cover{background:var(--green);color:#fff}.cover .in{padding:28px 20px 0}.org{font-size:14px;opacity:.85}' +
    '.cover h1{font-size:clamp(32px,8.5vw,46px);line-height:1.1;margin-top:14px;text-wrap:balance}.meta{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;font-size:15px}.meta b{font-weight:600}' +
    '.hills{display:block;width:100%;height:auto;margin-top:14px}.stops{display:flex;flex-wrap:wrap;gap:6px;padding:0 20px 22px;margin-top:-4px}.stops span{font-size:13px;background:rgba(255,255,255,.14);border-radius:999px;padding:4px 10px;white-space:nowrap}' +
    'section{padding:28px 20px 8px}h2{font-size:26px;line-height:1.15;margin-bottom:14px}.overview{display:grid;gap:10px}' +
    '.ov{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;border:1px solid var(--line);border-radius:14px;text-decoration:none;background:var(--card)}' +
    '.ov .d{font-family:"Songti SC","STSong",serif;font-size:24px;color:var(--green);font-weight:700}.ov .t{font-weight:600}.ov .s{font-size:14px;color:var(--muted)}.ov .go{font-size:14px;color:var(--muted)}' +
    '.day{border-top:8px solid var(--leaf);padding-top:28px}.dhead{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.dhead .no{font-family:"Songti SC","STSong",serif;font-size:40px;line-height:1;color:var(--chili);font-weight:700}.dhead .date{font-size:14px;color:var(--muted)}.day h2{margin:8px 0 10px}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.chips span{font-size:13px;border:1px solid var(--line);border-radius:999px;padding:3px 10px}' +
    '.sched{list-style:none;margin:0;padding:0}.sched li{display:grid;grid-template-columns:4.4em minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.sched li:last-child{border-bottom:0}' +
    '.time{font-variant-numeric:tabular-nums;font-size:17px;font-weight:700;white-space:nowrap}.what{font-weight:600}' +
    '.place{margin-top:8px;background:var(--leaf);border-radius:12px;padding:10px 12px;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}.place .pn{font-weight:600}.acts{display:flex;flex-wrap:wrap;gap:8px}' +
    '.btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 14px;border-radius:999px;font-size:15px;font-weight:600;text-decoration:none;border:1.5px solid var(--chili);color:var(--chili);white-space:nowrap}.btn.solid{background:var(--chili);color:#fff}.btn svg{width:16px;height:16px;flex:none}' +
    '.tip{margin-top:12px;font-size:15px;border-left:3px solid var(--chili);padding:2px 0 2px 12px}' +
    '.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.box{border:1px solid var(--line);border-radius:14px;padding:14px 16px}.box h3{font-size:18px;margin-bottom:6px}.box ul{margin:0;padding-left:1.1em}.box li{margin:4px 0}.notes{margin:0;padding-left:1.2em}.notes li{margin:6px 0}' +
    'footer{padding:28px 20px 36px;font-size:13px;color:var(--muted)}' +
    '.bar{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}.bar .in{max-width:640px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:10px}' +
    '.call{display:flex;flex-direction:column;justify-content:center;min-height:52px;border-radius:14px;padding:6px 12px;text-decoration:none;background:var(--green);color:#fff}.call.alt{background:var(--leaf);color:var(--ink)}.call b{font-size:15px}.call small{font-size:13px;opacity:.85}' +
    '@media(min-width:700px){.cover .in{padding:40px 32px 0}.stops{padding:0 32px 26px}section{padding:32px 32px 8px}footer{padding:32px}}';

  function hills(n) {
    var pts = [];
    for (var i = 0; i < n; i++) {
      var x = Math.round(40 + (n === 1 ? 0 : i * 570 / (n - 1)));
      pts.push([x, Math.round(118 - 40 * (x / 640) - 10 * Math.sin(x / 70))]);
    }
    var path = 'M' + pts.map(function (p) { return p[0] + ' ' + p[1]; }).join(' L');
    return '<svg class="hills" viewBox="0 0 640 170" preserveAspectRatio="xMidYMax slice" aria-hidden="true">' +
      '<path d="M0 120 C70 70 120 90 170 60 S280 40 330 78 S450 30 520 64 S610 70 640 52 V170 H0Z" fill="#fff" fill-opacity=".08"/>' +
      '<path d="M0 140 C60 104 130 120 190 96 S300 86 360 112 S470 80 540 104 S610 110 640 98 V170 H0Z" fill="#fff" fill-opacity=".12"/>' +
      '<path d="M0 158 C80 140 150 150 230 136 S380 146 450 134 S580 140 640 130 V170 H0Z" fill="#fff" fill-opacity=".18"/>' +
      '<path d="' + path + '" fill="none" stroke="#fff" stroke-width="2.5" stroke-dasharray="6 7" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<g fill="#ff8a7a" stroke="#fff" stroke-width="2.5">' + pts.map(function (p) { return '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="7"/>'; }).join('') + '</g></svg>';
  }

  function renderRoadbook(data) {
    var city = (data.city || '').trim();
    var nav = function (kw) {
      return 'https://uri.amap.com/search?keyword=' + encodeURIComponent(kw) + (city ? '&city=' + encodeURIComponent(city) : '') + '&src=ai-roadbook';
    };
    var navBtn = function (kw) { return '<a class="btn solid" href="' + esc(nav(kw)) + '" target="_blank" rel="noopener">' + ICO_NAV + '导航</a>'; };
    var telBtn = function (n) { return '<a class="btn" href="tel:' + esc(n.replace(/[\s-]/g, '')) + '">' + ICO_TEL + esc(n) + '</a>'; };
    var days = data.days || [];
    var stops = [];
    days.forEach(function (d) { (d.places || []).forEach(function (p) { if (!NOT_STOP.test(p) && stops.indexOf(p) < 0) stops.push(p); }); });
    var nights = days.length > 1 ? days.length - 1 : 0;
    var meta = [rangeText(data.startDate, days.length) && '<span><b>' + esc(rangeText(data.startDate, days.length)) + '</b></span>',
      days.length && '<span>' + days.length + '天' + (nights ? nights + '晚' : '') + '</span>',
      data.pax && '<span>' + esc(data.pax) + '人</span>'].filter(Boolean).join('');

    var dayHtml = days.map(function (d, i) {
      var places = (d.places || []).slice();
      var used = [];
      var items = (d.items || []).map(function (it) {
        var inItem = places.filter(function (p) { return it.w.indexOf(p) >= 0; });
        inItem = inItem.filter(function (p) { return !inItem.some(function (q) { return q !== p && q.indexOf(p) >= 0; }); });
        inItem.forEach(function (p) { if (used.indexOf(p) < 0) used.push(p); });
        var phone = it.w.match(PHONE_RE);
        var cards = inItem.map(function (p, k) {
          return '<div class="place"><span class="pn">' + esc(p) + '</span><span class="acts">' + navBtn(p) + (k === 0 && phone ? telBtn(phone[0]) : '') + '</span></div>';
        }).join('');
        return '<li><span class="time">' + esc(it.t) + '</span><div><div class="what">' + esc(it.w) + '</div>' + cards + '</div></li>';
      }).join('');
      var extra = places.filter(function (p) { return used.indexOf(p) < 0; });
      if (extra.length) {
        items += '<li><span class="time">地点</span><div>' + extra.map(function (p) {
          return '<div class="place"><span class="pn">' + esc(p) + '</span><span class="acts">' + navBtn(p) + '</span></div>';
        }).join('') + '</div></li>';
      }
      return '<section class="day" id="day' + (i + 1) + '"><div class="dhead"><span class="no">D' + (i + 1) + '</span><span class="date">' + esc(dayDate(data.startDate, i)) + '</span></div>' +
        '<h2>' + esc(d.title) + '</h2>' + (d.chips && d.chips.length ? '<div class="chips">' + d.chips.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>' : '') +
        '<ol class="sched">' + items + '</ol>' + (d.tip ? '<div class="tip">' + esc(d.tip) + '</div>' : '') + '</section>';
    }).join('');

    var overview = days.map(function (d, i) {
      var sub = [dayDate(data.startDate, i)].concat((d.places || []).filter(function (p) { return !NOT_STOP.test(p); }).slice(0, 3)).filter(Boolean).join(' · ');
      return '<a class="ov" href="#day' + (i + 1) + '"><span class="d">D' + (i + 1) + '</span><span><div class="t">' + esc(d.title) + '</div><div class="s">' + esc(sub) + '</div></span><span class="go">查看 ›</span></a>';
    }).join('');

    var list = function (arr) { return '<ul>' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'; };
    var fees = (data.include.length || data.exclude.length) ? '<section><h2>费用说明</h2><div class="cols">' +
      (data.include.length ? '<div class="box"><h3>已包含</h3>' + list(data.include) + '</div>' : '') +
      (data.exclude.length ? '<div class="box"><h3>不包含</h3>' + list(data.exclude) + '</div>' : '') + '</div></section>' : '';
    var notes = data.notes.length ? '<section><h2>出行提示</h2><ol class="notes">' + data.notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol></section>' : '';
    var contacts = (data.contacts || []).filter(function (c) { return c && c.tel; });
    var bar = contacts.length ? '<nav class="bar" aria-label="联系方式"><div class="in">' + contacts.map(function (c, i) {
      return '<a class="call' + (i ? ' alt' : '') + '" href="tel:' + esc(c.tel.replace(/[\s-]/g, '')) + '"><b>致电' + esc(c.role) + ' ' + esc(c.name) + '</b><small>' + esc(c.tel) + '</small></a>';
    }).join('') + '</div></nav>' : '';

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(data.title || '行程路书') + '</title><style>' + CSS + '</style></head><body>' +
      '<header class="cover"><div class="wrap"><div class="in"><div class="org">' + esc(data.org || '') + ' · 出行手册</div><h1>' + esc(data.title || '行程路书') + '</h1><div class="meta">' + meta + '</div></div>' +
      hills(Math.min(Math.max(stops.length, 2), 6)) + '<div class="stops">' + stops.slice(0, 8).map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div></div></header>' +
      '<main class="wrap">' + (days.length ? '<section><h2>行程一览</h2><div class="overview">' + overview + '</div></section>' : '') + dayHtml + fees + notes + '</main>' +
      '<footer class="wrap">' + esc(data.org || '') + ' · 本路书由 AI 路书工具生成，地点导航使用高德地图按名称搜索，出发前请以导游通知为准。</footer>' + bar + '</body></html>';
  }

  global.Roadbook = { parseItinerary: parseItinerary, buildDay: buildDay, detectPlaces: detectPlaces, renderRoadbook: renderRoadbook };
})(window);
