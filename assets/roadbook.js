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
  var GENERIC = /^(早餐|午餐|晚餐|用餐|酒店|市区|自由活动|休息|返程|送机|接机|集合)$/;
  var NOT_STOP =/机场|酒店|客栈|宾馆|民宿|饭店|火车站|高铁站|度假村/;
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

  function ruleChips(all) {
    var chips = [];
    ['早餐', '午餐', '晚餐'].forEach(function (meal) {
      var m = all.match(new RegExp(meal + '(?!后)[^，。；\\n]{0,14}?(不含|自理|含)'));
      if (m) chips.push(meal + (m[1] === '含' ? '含' : '自理'));
    });
    var hotel = all.match(/(?:入住|住宿|宿)[:：]?\s*([^\s，。,；;（(]{2,20}?(?:酒店|宾馆|客栈|民宿|饭店|度假村))/);
    if (hotel) chips.push('住：' + hotel[1]);
    else if (/住宿同前|同前住宿|连住/.test(all)) chips.push('住：同前一晚');
    return chips;
  }

  function mergeChips(aiChips, rule) {
    var out = (aiChips || []).filter(Boolean).slice();
    var hasStay = out.some(function (c) { return /^住/.test(c); });
    rule.forEach(function (c) {
      if (/^住/.test(c) && hasStay) return;
      var meal = c.slice(0, 2);
      if (/餐$/.test(meal) && out.some(function (x) { return x.indexOf(meal) === 0; })) return;
      if (out.indexOf(c) < 0) out.push(c);
    });
    return out;
  }

  /* 根据一天的原始文字，推导时间线、含餐、住宿、地点 */
  function buildDay(day) {
    var lines = day.text.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    day.items = lines.map(function (l) {
      var m = l.match(TIME_RE);
      return { t: m ? m[1].replace('：', ':') : '', w: m ? l.slice(m[0].length) : l };
    });
    var all = lines.join('\n');
    if (day.ai) { day.chips = mergeChips(day.aiChips, ruleChips(all)); return day; }
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

  /* 把 AI 返回的 JSON 整理成和规则识别一样的数据结构，并用规则结果补齐遗漏 */
  function fromAI(obj, rawText) {
    var rule = parseItinerary(rawText);
    var str = function (v) { return v == null ? '' : String(v).trim(); };
    var arr = function (v) { return Array.isArray(v) ? v.map(str).filter(Boolean) : []; };
    var data = {
      title: str(obj.title) || rule.title, org: rule.org,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(str(obj.startDate)) ? str(obj.startDate) : rule.startDate,
      pax: str(obj.pax).replace(/\D/g, '') || rule.pax, city: str(obj.city),
      contacts: (Array.isArray(obj.contacts) ? obj.contacts : []).filter(function (c) { return c && c.tel; }).slice(0, 2)
        .map(function (c) { return { role: /司机/.test(c.role) ? '司机' : '导游', name: str(c.name), tel: str(c.tel) }; }),
      include: arr(obj.include).length ? arr(obj.include) : rule.include,
      exclude: arr(obj.exclude).length ? arr(obj.exclude) : rule.exclude,
      notes: arr(obj.notes).length ? arr(obj.notes) : rule.notes, days: [], ai: true
    };
    if (!data.contacts.length) data.contacts = rule.contacts;
    (Array.isArray(obj.days) ? obj.days : []).forEach(function (d, i) {
      var items = (Array.isArray(d.items) ? d.items : []).map(function (it) {
        return { t: str(it.t), w: str(it.w), p: arr(it.p) };
      }).filter(function (it) { return it.w; });
      var desc = {}, info = {}, places = [];
      (Array.isArray(d.places) ? d.places : []).forEach(function (p) {
        var n = str(p && p.name); if (!n || GENERIC.test(n)) return;
        if (places.indexOf(n) < 0) places.push(n);
        if (str(p.desc)) desc[n] = str(p.desc);
        var first = function (v) { return str(v).split(/\s+\/\s+/)[0]; };
        info[n] = { local: first(p.local), en: first(p.en), address: str(p.address), city: str(p.city), country: str(p.country),
          translated: p.translated === true || p.translated === 'true' };
      });
      items.forEach(function (it) {
        it.p = it.p.filter(function (n) { return !GENERIC.test(n); });
        it.p.forEach(function (n) { if (places.indexOf(n) < 0) places.push(n); });
      });
      var text = items.map(function (it) { return (it.t ? it.t + ' ' : '') + it.w; }).join('\n');
      data.days.push({
        title: str(d.title) || (rule.days[i] && rule.days[i].title) || '第' + (i + 1) + '天',
        text: text, items: items, places: places, placeDesc: desc, placeInfo: info, placesEdited: true,
        ai: true, aiChips: arr(d.chips), chips: mergeChips(arr(d.chips), ruleChips(text)), tip: str(d.tip)
      });
    });
    var counts = {};
    data.days.forEach(function (d) { Object.keys(d.placeInfo).forEach(function (n) { var c = d.placeInfo[n].country; if (c) counts[c] = (counts[c] || 0) + 1; }); });
    var main = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0] || '';
    if (isAbroad(main)) data.country = main;
    if (isAbroad(main)) data.days.forEach(function (d) {
      d.places.forEach(function (n) {
        var f = d.placeInfo[n] || (d.placeInfo[n] = { local: '', en: '', address: '', city: '', country: '' });
        if (!f.country) f.country = main;
      });
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
    '.cover{background:var(--green);color:#fff}.cover .in{padding:30px 20px 0}.org{font-size:14px;opacity:.85}.label{font-size:13px;letter-spacing:.2em;opacity:.8;margin-top:18px}' +
    '.cover h1{font-size:clamp(32px,8.5vw,46px);line-height:1.15;margin-top:6px;text-wrap:balance;font-weight:600}.meta{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:14px;font-size:15px}.meta b{font-weight:600}' +
    '.band{display:block;width:100%;height:24px;background:var(--leaf)}.stops{display:flex;flex-wrap:wrap;gap:6px;padding:18px 20px 24px}.stops span{font-size:13px;background:rgba(255,255,255,.14);border-radius:999px;padding:4px 10px;white-space:nowrap}' +
    '.dnav{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);overflow-x:auto;white-space:nowrap;padding:8px 16px;scrollbar-width:none}.dnav a{display:inline-block;padding:4px 12px;margin-right:6px;border-radius:999px;background:var(--leaf);font-size:14px;text-decoration:none}section{padding:28px 20px 8px;scroll-margin-top:52px}h2{font-size:26px;line-height:1.15;margin-bottom:14px}.overview{display:grid;gap:10px}' +
    '.ov{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:center;padding:14px 16px;border:1px solid var(--line);border-radius:14px;text-decoration:none;background:var(--card)}' +
    '.ov .d{font-family:"Songti SC","STSong",serif;font-size:24px;color:var(--chili);font-weight:700}.ov .t{font-weight:600}.ov .s{font-size:14px;color:var(--muted)}.ov .go{font-size:14px;color:var(--muted)}' +
    '.day{border-top:8px solid var(--leaf);padding-top:28px}.dhead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.dhead .k{font-size:13px;letter-spacing:.2em;color:var(--chili)}.dhead .no{font-family:"Songti SC","STSong",serif;font-size:44px;line-height:1;color:var(--chili);font-weight:700}.dhead .date{font-size:14px;color:var(--muted)}.day h2{margin:8px 0 10px}' +
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.chips span{font-size:13px;border:1px solid var(--line);border-radius:999px;padding:3px 10px}' +
    '.sched{list-style:none;margin:0;padding:0}.sched li{display:grid;grid-template-columns:4.4em minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.sched li:last-child{border-bottom:0}' +
    '.time{font-variant-numeric:tabular-nums;font-size:17px;font-weight:700;white-space:nowrap}.what{font-weight:600}' +
    '.place{margin-top:8px;background:var(--leaf);border-radius:12px;padding:10px 12px}.ph{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}.place .pn{font-weight:600}.addr{font-size:13px;color:var(--muted);margin-top:2px}.pd{margin:6px 0 0;font-size:14px;color:var(--muted)}.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}' +
    '.notice{background:var(--leaf);border-radius:14px;padding:14px 16px}.notice h3{font-size:18px;margin-bottom:6px}.notice ul{margin:0;padding-left:1.1em}.notice li{margin:4px 0;font-size:15px}' +
    '.drv{display:none;position:fixed;inset:0;z-index:20;background:#fff;color:#111;padding:64px 22px calc(28px + env(safe-area-inset-bottom,0px));flex-direction:column;justify-content:center;gap:16px;overflow:auto}.drv:target{display:flex}' +
    '.drv .x{position:absolute;top:16px;right:16px;font-size:16px;padding:8px 16px;border:1.5px solid #111;border-radius:999px;text-decoration:none;color:#111}' +
    '.drv .ask{font-size:20px;color:#444}.drv .ask.en{font-size:16px;color:#777;margin-top:-10px}.drv .big{font-size:clamp(36px,11vw,60px);font-weight:700;line-height:1.2;overflow-wrap:anywhere}' +
    '.drv .addr2{font-size:clamp(22px,6.5vw,32px);line-height:1.4;overflow-wrap:anywhere}.drv .en2{font-size:20px;color:#333}.drv .cn{font-size:16px;color:#666}.drv small{font-size:14px;color:#888}' +
    '.btn{display:inline-flex;align-items:center;gap:6px;min-height:38px;padding:0 14px;border-radius:999px;font-size:15px;font-weight:600;text-decoration:none;border:1.5px solid var(--chili);color:var(--chili);white-space:nowrap}.btn.solid{background:var(--chili);color:#fff}.btn svg{width:16px;height:16px;flex:none}' +
    '.tip{margin-top:14px;font-size:15px;background:var(--leaf);border-radius:12px;padding:10px 14px}.tip b{color:var(--chili);font-weight:600;margin-right:6px}' +
    '.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.box{border:1px solid var(--line);border-radius:14px;padding:14px 16px}.box h3{font-size:18px;margin-bottom:6px}.box ul{margin:0;padding-left:1.1em}.box li{margin:4px 0}.notes{margin:0;padding-left:1.2em}.notes li{margin:6px 0}' +
    '.hero{margin:0;position:relative}.hero img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover}.cap{font-size:11px;line-height:1.4;color:var(--muted);margin:4px 0 0}.cap a{color:inherit}' +
    '.hero .cap{position:absolute;right:8px;bottom:6px;margin:0;color:#fff;opacity:.85;text-shadow:0 0 3px #000;max-width:80%;text-align:right}' +
    '.pimg{margin:-10px -12px 10px}.pimg img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:12px 12px 0 0}.pimg .cap{padding:0 12px}' +
    '.dph{display:flex;gap:8px;overflow-x:auto;margin:2px -20px 14px;padding:0 20px;scroll-snap-type:x mandatory;scrollbar-width:none}.dph img{flex:none;width:80%;max-width:440px;aspect-ratio:4/3;object-fit:cover;border-radius:12px;scroll-snap-align:start}.dph img:only-child{width:100%;max-width:none;aspect-ratio:16/9}' +
    '.team{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.mate{display:grid;grid-template-columns:72px minmax(0,1fr);gap:14px;align-items:center;border:1px solid var(--line);border-radius:14px;padding:12px}' +
    '.mate img{width:72px;height:72px;border-radius:50%;object-fit:cover}.mate .r{font-size:13px;color:var(--chili)}.mate b{display:block;font-size:17px}.mate .btn{margin-top:6px}' +
    '.call.pic{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center}.call img{width:36px;height:36px;border-radius:50%;object-fit:cover;grid-row:span 2;margin-right:10px;border:2px solid rgba(255,255,255,.6)}' +
    'footer{padding:28px 20px 36px;font-size:13px;color:var(--muted)}' +
    '.bar{position:fixed;left:0;right:0;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}.bar .in{max-width:640px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));gap:10px}' +
    '.call{display:flex;flex-direction:column;justify-content:center;min-height:52px;border-radius:14px;padding:6px 12px;text-decoration:none;background:var(--green);color:#fff}.call.alt{background:var(--leaf);color:var(--ink)}.call b{font-size:15px}.call small{font-size:13px;opacity:.85}' +
    '@media(min-width:700px){.cover .in{padding:40px 32px 0}.stops{padding:0 32px 26px}section{padding:32px 32px 8px}footer{padding:32px}}';

  function isAbroad(country) {
    country = (country || '').trim();
    return !!country && !/^(中国|中华人民共和国|China)$/i.test(country);
  }
  function hasLocal(f) {
    f = f || {};
    return !!(f.local || f.en);
  }
  function uniqJoin(parts) {
    var out = [];
    parts.forEach(function (p) {
      p = (p || '').trim();
      if (p && !out.some(function (o) { return o.indexOf(p) >= 0; })) out.push(p);
    });
    return out.join(', ');
  }
  var PLEASE = {
    '埃及': 'من فضلك خذني إلى هذا المكان', '土耳其': 'Lütfen beni bu adrese götürün', '日本': 'この場所までお願いします',
    '韩国': '이곳으로 가 주세요', '泰国': 'กรุณาพาฉันไปที่นี่', '法国': 'Emmenez-moi à cette adresse, s’il vous plaît',
    '意大利': 'Mi porti a questo indirizzo, per favore', '西班牙': 'Lléveme a esta dirección, por favor', '德国': 'Bitte bringen Sie mich zu dieser Adresse'
  };
  function driverPage(dv) {
    var f = dv.f;
    var ask = PLEASE[f.country];
    return '<div class="drv" id="' + dv.id + '" role="dialog" aria-label="给司机看：' + esc(dv.cn) + '"><a class="x" href="#' + dv.back + '">关闭</a>' +
      (ask ? '<div class="ask" dir="auto">' + esc(ask) + '</div>' : '') + '<div class="ask en">Please take me here</div>' +
      '<div class="big" dir="auto">' + esc(f.local || f.en) + '</div>' +
      (f.address ? '<div class="addr2" dir="auto">' + esc(f.address) + '</div>' : '') +
      (f.en && f.en !== f.local ? '<div class="en2">' + esc(f.en) + '</div>' : '') +
      '<div class="cn">' + esc(uniqJoin([dv.cn, f.city, f.country])) + '</div>' +
      (f.translated ? '<small>名称为 AI 翻译，请以酒店确认单上的名称为准</small>' : '') + '<small>把手机屏幕给司机看</small></div>';
  }

  // 目的地主题：主色（封面）、点缀色、浅底色，以及一条当地风格的花纹
  var THEMES = [
    { key: '土耳其', re: /土耳其|伊斯坦布尔|卡帕多[奇细]亚|棉花堡|安塔利亚|以弗所|库[萨沙]达斯/, label: 'TÜRKİYE', main: '#1F4E79', accent: '#B03A2E', accentD: '#F08A7E', soft: '#EEF3F8', softD: '#16212C', motif: 'star' },
    { key: '埃及', re: /埃及|开罗|卢克索|阿斯旺|赫尔格达|亚历山大/, label: 'مصر · EGYPT', main: '#1D4B5E', accent: '#9A6B12', accentD: '#E2B65C', soft: '#F7F0E2', softD: '#221D14', motif: 'zigzag' },
    { key: '日本', re: /日本|东京|京都|大阪|北海道|奈良|冲绳/, label: '日本 · NIPPON', main: '#2E2A28', accent: '#C23B22', accentD: '#F2836F', soft: '#F5F1EA', softD: '#1E1B19', motif: 'waves' },
    { key: '泰国', re: /泰国|曼谷|清迈|普吉/, label: 'ประเทศไทย · THAILAND', main: '#4E2A78', accent: '#8C6510', accentD: '#E2B65C', soft: '#F4EFF8', softD: '#1D1726', motif: 'diamond' },
    { key: '意大利', re: /意大利|罗马|佛罗伦萨|威尼斯|米兰/, label: 'ITALIA', main: '#7A3B2E', accent: '#2F6B4F', accentD: '#7CC5A0', soft: '#F8F0EA', softD: '#241A16', motif: 'diamond' },
    { key: '法国', re: /法国|巴黎|普罗旺斯|尼斯/, label: 'FRANCE', main: '#23395B', accent: '#A3333D', accentD: '#F08A92', soft: '#EFF2F7', softD: '#171D27', motif: 'dots' },
    { key: '西安', re: /西安|长安|兵马俑|大雁塔/, label: '长安 · XI’AN', main: '#3A2E2A', accent: '#A2382B', accentD: '#F0907F', soft: '#F6F0EA', softD: '#201A17', motif: 'meander' },
    { key: '成都', re: /成都|四川|熊猫|九寨/, label: '蜀 · CHENGDU', main: '#2F5D50', accent: '#C8322A', accentD: '#FF7A6E', soft: '#EDF4F0', softD: '#16211D', motif: 'diamond' },
    { key: '云南', re: /云南|大理|丽江|昆明|洱海|玉龙|香格里拉|西双版纳/, label: '彩云之南 · YUNNAN', main: '#1E4F80', accent: '#C2562A', accentD: '#F59A72', soft: '#EDF3F9', softD: '#151E28', motif: 'dots' }
  ];
  var THEME_CN = { label: '中国 · CHINA', main: '#1F4D3A', accent: '#C8322A', accentD: '#FF7A6E', soft: '#EAF2EC', softD: '#17241E', motif: 'meander' };
  var THEME_ABROAD = { main: '#24363F', accent: '#B5502A', accentD: '#F2956E', soft: '#EFF3F4', softD: '#182023', motif: 'dots' };

  function pickTheme(data) {
    var country = (data.country || '').trim();
    if (isAbroad(country)) {
      var byCountry = THEMES.filter(function (t) { return t.key === country; })[0];
      if (byCountry) return byCountry;
    }
    var hay = [data.title, data.city, country].concat((data.days || []).map(function (d) {
      return Object.keys(d.placeInfo || {}).map(function (n) { return (d.placeInfo[n] || {}).city || ''; }).join(' ') + ' ' + (d.title || '');
    })).join(' ');
    var counts = THEMES.map(function (t) { var m = hay.match(new RegExp(t.re.source, 'g')); return m ? m.length : 0; });
    var best = counts.indexOf(Math.max.apply(null, counts));
    if (counts[best] > 0) return THEMES[best];
    if (isAbroad(country)) { var t = Object.assign({}, THEME_ABROAD); t.label = country; return t; }
    return THEME_CN;
  }

  function motifBand(t) {
    var a = t.accent, m = t.main, tile;
    if (t.motif === 'star') tile = '<path d="M12 4l2.2 5.8L20 12l-5.8 2.2L12 20l-2.2-5.8L4 12l5.8-2.2z" fill="' + a + '"/><circle cx="0" cy="12" r="2" fill="' + m + '"/><circle cx="24" cy="12" r="2" fill="' + m + '"/>';
    else if (t.motif === 'zigzag') tile = '<path d="M0 20L6 6l6 14 6-14 6 14" fill="none" stroke="' + a + '" stroke-width="2"/><path d="M0 22h24" stroke="' + m + '" stroke-width="2"/>';
    else if (t.motif === 'waves') tile = '<g fill="none" stroke-width="1.6"><path d="M0 24a12 12 0 0124 0" stroke="' + m + '"/><path d="M4 24a8 8 0 0116 0" stroke="' + a + '"/><path d="M8 24a4 4 0 018 0" stroke="' + m + '"/></g>';
    else if (t.motif === 'meander') tile = '<path d="M2 21V3h20v14H8V9h8v4" fill="none" stroke="' + a + '" stroke-width="2"/>';
    else if (t.motif === 'diamond') tile = '<path d="M12 3l9 9-9 9-9-9z" fill="none" stroke="' + a + '" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="' + m + '"/>';
    else tile = '<circle cx="6" cy="12" r="3.2" fill="' + a + '"/><circle cx="18" cy="12" r="1.8" fill="' + m + '"/>';
    return '<svg class="band" height="24" aria-hidden="true"><defs><pattern id="motif" width="24" height="24" patternUnits="userSpaceOnUse">' + tile + '</pattern></defs><rect width="100%" height="24" fill="url(#motif)"/></svg>';
  }

  function credit(v) {
    var c = v && v.credit;
    if (!c || !c.license) return '';
    return '<p class="cap">图：' + esc(c.artist || '佚名') + ' · ' + esc(c.license) + (c.page ? ' · <a href="' + esc(c.page) + '" target="_blank" rel="noopener">维基共享资源</a>' : '') + '</p>';
  }
  function okImg(v) { return v && typeof v.src === 'string' && /^(data:image\/(jpeg|png|webp);base64,|img\/|https:\/\/)/.test(v.src); }

  function renderRoadbook(data) {
    var city = (data.city || '').trim();
    var nav = function (kw) {
      return 'https://uri.amap.com/search?keyword=' + encodeURIComponent(kw) + (city ? '&city=' + encodeURIComponent(city) : '') + '&src=ai-roadbook';
    };
    var linkBtn = function (url, label, solid) { return '<a class="btn' + (solid ? ' solid' : '') + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + (solid ? ICO_NAV : '') + esc(label) + '</a>'; };
    var telBtn = function (n) { return '<a class="btn" href="tel:' + esc(n.replace(/[\s-]/g, '')) + '">' + ICO_TEL + esc(n) + '</a>'; };
    var days = data.days || [];
    var stops = [];
    days.forEach(function (d) { (d.places || []).forEach(function (p) { if (!NOT_STOP.test(p) && stops.indexOf(p) < 0) stops.push(p); }); });
    var nights = days.length > 1 ? days.length - 1 : 0;
    var meta = [rangeText(data.startDate, days.length) && '<span><b>' + esc(rangeText(data.startDate, days.length)) + '</b></span>',
      days.length && '<span>' + days.length + '天' + (nights ? nights + '晚' : '') + '</span>',
      data.pax && '<span>' + esc(data.pax) + '人</span>'].filter(Boolean).join('');

    var th = pickTheme(data);
    var themeCss = ':root{--green:' + th.main + ';--chili:light-dark(' + th.accent + ',' + th.accentD + ');--leaf:light-dark(' + th.soft + ',' + th.softD + ')}';
    var drivers = [], abroadAny = false;
    var dayHtml = days.map(function (d, i) {
      var places = (d.places || []).slice();
      var used = [];
      var desc = d.placeDesc || {};
      var info = d.placeInfo || {};
      var mapBtns = function (p) {
        var f = info[p] || {};
        var country = f.country || data.country || '';
        var abroad = isAbroad(country);
        if (!abroad) {
          var c = f.city || city;
          var amap = 'https://uri.amap.com/search?keyword=' + encodeURIComponent(p) + (c ? '&city=' + encodeURIComponent(c) : '') + '&callnative=1&src=ai-roadbook';
          var aq = uniqJoin([p, f.address, c]);
          return linkBtn('https://maps.apple.com/?daddr=' + encodeURIComponent(aq) + '&dirflg=d', '苹果地图导航', true) + linkBtn(amap, '高德地图');
        }
        abroadAny = true;
        var dest = f.local ? uniqJoin([f.local, f.address]) : uniqJoin([f.en || p, f.address, f.city, country]);
        var out = linkBtn('https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(dest) + '&travelmode=driving', 'Google 导航', true) +
          linkBtn('https://maps.apple.com/?daddr=' + encodeURIComponent(dest) + '&dirflg=d', '苹果地图导航');
        if (hasLocal(f)) {
          var id = 'drv-' + (drivers.length + 1);
          drivers.push({ id: id, back: 'day' + (i + 1), cn: p, f: { local: f.local, en: f.en, address: f.address, city: f.city, country: country, translated: f.translated } });
          out += '<a class="btn" href="#' + id + '">给司机看</a>';
        }
        return out;
      };
      var card = function (p, phone) {
        var f = info[p] || {};
        var sub = uniqJoin([f.local && f.local !== p ? f.local : '', f.address]);
        return '<div class="place">' + (okImg(f.img) ? '<figure class="pimg"><img src="' + esc(f.img.src) + '" alt="' + esc(p) + '" loading="lazy">' + credit(f.img) + '</figure>' : '') +
          '<div class="ph"><span class="pn">' + esc(p) + '</span></div>' +
          (sub ? '<div class="addr" dir="auto">' + esc(sub) + '</div>' : '') +
          (desc[p] ? '<p class="pd">' + esc(desc[p]) + '</p>' : '') +
          '<div class="acts">' + mapBtns(p) + (phone ? telBtn(phone) : '') + '</div></div>';
      };
      var items = (d.items || []).map(function (it) {
        var inItem = it.p && it.p.length ? places.filter(function (p) { return it.p.indexOf(p) >= 0 && used.indexOf(p) < 0; })
          : places.filter(function (p) { return it.w.indexOf(p) >= 0; });
        inItem = inItem.filter(function (p) { return !inItem.some(function (q) { return q !== p && q.indexOf(p) >= 0; }); });
        inItem.forEach(function (p) { if (used.indexOf(p) < 0) used.push(p); });
        var phone = it.w.match(PHONE_RE);
        var cards = inItem.map(function (p, k) { return card(p, k === 0 && phone ? phone[0] : ''); }).join('');
        return '<li><span class="time">' + esc(it.t) + '</span><div><div class="what">' + esc(it.w) + '</div>' + cards + '</div></li>';
      }).join('');
      var extra = places.filter(function (p) { return used.indexOf(p) < 0; });
      if (extra.length) {
        items += '<li><span class="time">地点</span><div>' + extra.map(function (p) { return card(p, ''); }).join('') + '</div></li>';
      }
      return '<section class="day" id="day' + (i + 1) + '"><div class="dhead"><span class="k">DAY</span><span class="no">' + (i < 9 ? '0' : '') + (i + 1) + '</span><span class="date">' + esc(dayDate(data.startDate, i)) + '</span></div>' +
        '<h2>' + esc(d.title) + '</h2>' + ((d.photos || []).filter(okImg).length ? '<div class="dph">' + d.photos.filter(okImg).map(function (x) { return '<img src="' + esc(x.src) + '" alt="' + esc(d.title) + '" loading="lazy">'; }).join('') + '</div>' : '') + (d.chips && d.chips.length ? '<div class="chips">' + d.chips.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>' : '') +
        '<ol class="sched">' + items + '</ol>' + (d.tip ? '<div class="tip"><b>' + (isAbroad(data.country) ? '当地贴士' : '贴士') + '</b>' + esc(d.tip) + '</div>' : '') + '</section>';
    }).join('');

    var overview = days.map(function (d, i) {
      var sub = [dayDate(data.startDate, i)].concat((d.places || []).filter(function (p) { return !NOT_STOP.test(p); }).slice(0, 3)).filter(Boolean).join(' · ');
      return '<a class="ov" href="#day' + (i + 1) + '"><span class="d">D' + (i + 1) + '</span><span><div class="t">' + esc(d.title) + '</div><div class="s">' + esc(sub) + '</div></span><span class="go">查看 ›</span></a>';
    }).join('');

    var list = function (arr) { return '<ul>' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'; };
    var fees = (data.include.length || data.exclude.length) ? '<section id="fees"><h2>费用说明</h2><div class="cols">' +
      (data.include.length ? '<div class="box"><h3>已包含</h3>' + list(data.include) + '</div>' : '') +
      (data.exclude.length ? '<div class="box"><h3>不包含</h3>' + list(data.exclude) + '</div>' : '') + '</div></section>' : '';
    var mates = (data.contacts || []).filter(function (c) { return c && (c.name || c.tel) && c.photo && okImg(c.photo); });
    var team = mates.length ? '<section><h2>你的领队与司机</h2><div class="team">' + (data.contacts || []).filter(function (c) { return c && (c.name || c.tel); }).map(function (c) {
      return '<div class="mate">' + (okImg(c.photo) ? '<img src="' + esc(c.photo.src) + '" alt="' + esc(c.role + ' ' + c.name) + '" loading="lazy">' : '<span></span>') +
        '<div><div class="r">' + esc(c.role) + '</div><b>' + esc(c.name) + '</b>' + (c.tel ? telBtn(c.tel) : '') + '</div></div>';
    }).join('') + '</div></section>' : '';
    var notes = data.notes.length ? '<section><h2>出行提示</h2><ol class="notes">' + data.notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol></section>' : '';
    var contacts = (data.contacts || []).filter(function (c) { return c && c.tel; });
    var bar = contacts.length ? '<nav class="bar" aria-label="联系方式"><div class="in">' + contacts.map(function (c, i) {
      return '<a class="call' + (i ? ' alt' : '') + (c.photo && okImg(c.photo) ? ' pic' : '') + '" href="tel:' + esc(c.tel.replace(/[\s-]/g, '')) + '">' + (c.photo && okImg(c.photo) ? '<img src="' + esc(c.photo.src) + '" alt="">' : '') + '<b>致电' + esc(c.role) + ' ' + esc(c.name) + '</b><small>' + esc(c.tel) + '</small></a>';
    }).join('') + '</div></nav>' : '';

    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>' + esc(data.title || '行程路书') + '</title><style>' + CSS + themeCss + '</style></head><body>' +
      '<header class="cover"><div class="wrap">' + (okImg(data.cover) ? '<figure class="hero"><img src="' + esc(data.cover.src) + '" alt="' + esc(data.title || '') + '">' + credit(data.cover) + '</figure>' : '') + '<div class="in"><div class="org">' + esc(data.org || '') + ' · 出行手册</div>' + (th.label ? '<div class="label">' + esc(th.label) + '</div>' : '') + '<h1>' + esc(data.title || '行程路书') + '</h1><div class="meta">' + meta + '</div></div>' +
      '<div class="stops">' + stops.slice(0, 8).map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') + '</div></div></header>' + motifBand(th) +
      (days.length > 1 ? '<nav class="dnav" aria-label="按天跳转"><div class="wrap">' + days.map(function (d, i) { return '<a href="#day' + (i + 1) + '">D' + (i + 1) + '</a>'; }).join('') + '<a href="#fees">费用</a></div></nav>' : '') +
      '<main class="wrap">' + (days.length ? '<section><h2>行程一览</h2><div class="overview">' + overview + '</div></section>' : '') +
      (abroadAny ? '<section><div class="notice"><h3>出境导航小贴士</h3><ul><li>出境后建议在当地购买电话卡或开通国际流量。用国内手机卡漫游时，Google 地图可能打不开，可以改用苹果地图。</li><li>打车或问路时，点地点旁边的「给司机看」，把屏幕给司机看，上面是当地语言的地名和地址。</li></ul></div></section>' : '') +
      team + dayHtml + fees + notes + '</main>' +
      '<footer class="wrap">' + esc(data.org || '') + ' · 本路书由 AI 路书工具生成。地名和地址由 AI 整理，出发前请以导游通知为准。</footer>' + bar + drivers.map(driverPage).join('') + '</body></html>';
  }

  global.Roadbook = { parseItinerary: parseItinerary, buildDay: buildDay, detectPlaces: detectPlaces, renderRoadbook: renderRoadbook, fromAI: fromAI, isAbroad: isAbroad, hasLocal: hasLocal };
})(window);
