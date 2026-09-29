// Utilitários compartilhados: tempo, quantidades, seletores, JSONPath, patches, tabwriter, diff, cron.
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const U = (KS.util = {});

  U.clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  U.isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
  U.now = () => Date.now();
  U.iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  U.ms = (s) => (s ? Date.parse(s) : 0);
  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ALNUM = 'bcdfghjklmnpqrstvwxz2456789';
  U.rand = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += ALNUM[Math.floor(Math.random() * ALNUM.length)];
    return s;
  };
  U.hex = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return s;
  };
  U.uid = () => `${U.hex(8)}-${U.hex(4)}-4${U.hex(3)}-${'89ab'[Math.floor(Math.random() * 4)]}${U.hex(3)}-${U.hex(12)}`;
  U.fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  // Igual ao rand.SafeEncodeString(fmt.Sprint(hash)) usado no pod-template-hash
  U.safeHash = (str) =>
    String(U.fnv(str))
      .split('')
      .map((c) => ALNUM[c.charCodeAt(0) % ALNUM.length])
      .join('');
  U.seeded = (str) => U.fnv(str) / 4294967296; // 0..1 determinístico

  // ---------- idade (duration.HumanDuration) ----------
  U.human = (sec) => {
    if (sec < -1) return '<invalid>';
    if (sec < 0) return '0s';
    const s = Math.floor(sec);
    if (s < 120) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 10) return s % 60 === 0 ? m + 'm' : m + 'm' + (s % 60) + 's';
    if (m < 180) return m + 'm';
    const h = Math.floor(s / 3600);
    if (h < 8) return m % 60 === 0 ? h + 'h' : h + 'h' + (m % 60) + 'm';
    if (h < 48) return h + 'h';
    if (h < 192) return h % 24 === 0 ? Math.floor(h / 24) + 'd' : Math.floor(h / 24) + 'd' + (h % 24) + 'h';
    if (h < 24 * 365 * 2) return Math.floor(h / 24) + 'd';
    const y = Math.floor(h / 24 / 365);
    if (y < 8) {
      const d = Math.floor(h / 24) - y * 365;
      return d === 0 ? y + 'y' : y + 'y' + d + 'd';
    }
    return y + 'y';
  };
  U.age = (ts, now = Date.now()) => (ts ? U.human((now - U.ms(ts)) / 1000) : '<unknown>');
  U.parseDuration = (s) => {
    if (s === undefined || s === null || s === '') return null;
    if (/^\d+$/.test(String(s))) return Number(s);
    let total = 0;
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    let m, ok = false;
    while ((m = re.exec(s))) {
      ok = true;
      const v = parseFloat(m[1]);
      total += m[2] === 'ms' ? v / 1000 : m[2] === 's' ? v : m[2] === 'm' ? v * 60 : v * 3600;
    }
    return ok ? total : null;
  };
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n) => String(n).padStart(2, '0');
  U.rfc1123z = (ts) => {
    const d = new Date(typeof ts === 'number' ? ts : U.ms(ts));
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const oh = p2(Math.floor(Math.abs(off) / 60)), om = p2(Math.abs(off) % 60);
    return `${DAYS[d.getDay()]}, ${p2(d.getDate())} ${MONS[d.getMonth()]} ${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${sign}${oh}${om}`;
  };
  U.dateCmd = (t = Date.now()) => {
    const d = new Date(t);
    return `${DAYS[d.getUTCDay()]} ${MONS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
  };
  U.nginxTime = (t) => {
    const d = new Date(t);
    return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  };
  U.clfTime = (t) => {
    const d = new Date(t);
    return `${p2(d.getUTCDate())}/${MONS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
  };

  // ---------- quantidades ----------
  const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
  const DEC = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  U.validQuantity = (q) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+|Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/.test(String(q));
  U.parseQuantity = (q) => {
    if (q === undefined || q === null || q === '') return 0;
    if (typeof q === 'number') return q;
    const m = String(q).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+))([eE][+-]?\d+|Ki|Mi|Gi|Ti|Pi|Ei|n|u|m|k|K|M|G|T|P|E)?$/);
    if (!m) return NaN;
    const v = parseFloat(m[1]);
    const suf = m[2] || '';
    if (/^[eE]/.test(suf)) return v * Math.pow(10, parseInt(suf.slice(1)));
    if (BIN[suf]) return v * BIN[suf];
    return v * DEC[suf];
  };
  U.cpuMilli = (q) => Math.round(U.parseQuantity(q) * 1000);
  U.fmtCPU = (m) => (m % 1000 === 0 && m !== 0 ? String(m / 1000) : Math.round(m) + 'm');
  U.fmtMem = (b) => {
    if (b === 0) return '0';
    for (const [s, v] of [['Gi', 2 ** 30], ['Mi', 2 ** 20], ['Ki', 2 ** 10]]) if (b >= v && b % v === 0) return b / v + s;
    if (b >= 2 ** 20) return Math.round(b / 2 ** 20) + 'Mi';
    if (b >= 1024) return Math.round(b / 1024) + 'Ki';
    return String(Math.round(b));
  };
  U.topMem = (b) => Math.round(b / 2 ** 20) + 'Mi';
  U.intOrPercent = (v, total, roundUp) => {
    if (v === undefined || v === null) return 0;
    if (typeof v === 'string' && v.endsWith('%')) {
      const r = (parseInt(v) * total) / 100;
      return roundUp ? Math.ceil(r) : Math.floor(r);
    }
    return parseInt(v);
  };

  // ---------- base64 ----------
  U.b64e = (s) => {
    const bytes = new TextEncoder().encode(String(s));
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return btoa(bin);
  };
  U.b64d = (s) => {
    const bin = atob(String(s).replace(/\s/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };
  U.b64url = (s) => U.b64e(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

  // ---------- caminhos ----------
  U.getPath = (obj, path) => {
    let cur = obj;
    for (const p of path.split('.')) {
      if (cur === undefined || cur === null) return undefined;
      cur = cur[p];
    }
    return cur;
  };

  // ---------- seletores ----------
  U.selectorError = (msg) => {
    const e = new Error(msg);
    e.selector = true;
    return e;
  };
  // "app=nginx,env in (a,b),!foo,tier!=db"
  U.parseLabelSelector = (sel) => {
    const reqs = [];
    if (!sel || !sel.trim()) return reqs;
    let s = sel.trim();
    const parts = [];
    let depth = 0, cur = '';
    for (const c of s) {
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 0) {
        parts.push(cur);
        cur = '';
      } else cur += c;
    }
    parts.push(cur);
    for (let p of parts) {
      p = p.trim();
      if (!p) throw U.selectorError(`unable to parse requirement: found '', expected: identifier`);
      let m;
      if ((m = p.match(/^([\w./-]+)\s+(in|notin)\s+\(([^)]*)\)$/))) {
        reqs.push({ key: m[1], op: m[2], values: m[3].split(',').map((x) => x.trim()).filter(Boolean) });
      } else if ((m = p.match(/^!\s*([\w./-]+)$/))) reqs.push({ key: m[1], op: '!' });
      else if ((m = p.match(/^([\w./-]+)\s*(==|!=|=)\s*([\w./-]*)$/))) reqs.push({ key: m[1], op: m[2] === '!=' ? '!=' : '=', values: [m[3]] });
      else if ((m = p.match(/^([\w./-]+)\s*(>|<)\s*(\d+)$/))) reqs.push({ key: m[1], op: m[2], values: [m[3]] });
      else if ((m = p.match(/^([\w./-]+)$/))) reqs.push({ key: m[1], op: 'exists' });
      else throw U.selectorError(`unable to parse requirement: <nil>: Invalid value: "${p}": invalid label selector`);
    }
    return reqs;
  };
  U.matchReqs = (reqs, labels) => {
    labels = labels || {};
    return reqs.every((r) => {
      const has = Object.prototype.hasOwnProperty.call(labels, r.key);
      const v = labels[r.key];
      switch (r.op) {
        case '=': return has && v === r.values[0];
        case '!=': return !has || v !== r.values[0];
        case 'in': return has && r.values.includes(v);
        case 'notin': return !has || !r.values.includes(v);
        case 'exists': return has;
        case '!': return !has;
        case '>': return has && Number(v) > Number(r.values[0]);
        case '<': return has && Number(v) < Number(r.values[0]);
      }
      return false;
    });
  };
  U.matchLabelString = (sel, labels) => U.matchReqs(U.parseLabelSelector(sel), labels);
  // LabelSelector (matchLabels/matchExpressions)
  U.selectorReqs = (ls) => {
    if (!ls) return null;
    const reqs = [];
    for (const [k, v] of Object.entries(ls.matchLabels || {})) reqs.push({ key: k, op: '=', values: [String(v)] });
    for (const e of ls.matchExpressions || []) {
      const op = { In: 'in', NotIn: 'notin', Exists: 'exists', DoesNotExist: '!' }[e.operator];
      reqs.push({ key: e.key, op, values: e.values || [] });
    }
    return reqs;
  };
  U.matchSelector = (ls, labels) => {
    const r = U.selectorReqs(ls);
    if (!r) return false;
    return U.matchReqs(r, labels);
  };
  U.selectorString = (ls) => {
    if (!ls) return '<none>';
    const parts = [];
    for (const [k, v] of Object.entries(ls.matchLabels || {}).sort()) parts.push(`${k}=${v}`);
    for (const e of ls.matchExpressions || []) {
      if (e.operator === 'In') parts.push(`${e.key} in (${(e.values || []).join(',')})`);
      else if (e.operator === 'NotIn') parts.push(`${e.key} notin (${(e.values || []).join(',')})`);
      else if (e.operator === 'Exists') parts.push(e.key);
      else parts.push('!' + e.key);
    }
    return parts.length ? parts.join(',') : '<none>';
  };
  U.mapSelectorString = (m) => {
    const e = Object.entries(m || {});
    return e.length ? e.sort().map(([k, v]) => `${k}=${v}`).join(',') : '<none>';
  };
  U.labelsString = (m) => {
    const e = Object.entries(m || {});
    return e.length ? e.sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(',') : '<none>';
  };
  U.parseFieldSelector = (sel) => {
    if (!sel) return [];
    return sel.split(',').map((p) => {
      const m = p.trim().match(/^([\w.\-/]+)\s*(==|!=|=)\s*(.*)$/);
      if (!m) throw U.selectorError(`invalid selector: '${sel}'; can't understand '${p}'`);
      return { path: m[1], neg: m[2] === '!=', value: m[3] };
    });
  };

  // ---------- JSONPath (dialeto do kubectl) ----------
  const JP = (U.jsonpath = {});
  JP.relax = (t) => {
    t = t.trim();
    if (t.startsWith('{') && t.endsWith('}')) return t;
    if (!t.includes('{')) {
      if (!t.startsWith('.') && !t.startsWith('$')) t = '.' + t;
      return '{' + t + '}';
    }
    return t;
  };
  JP.parseTemplate = (tpl) => {
    const toks = [];
    let i = 0;
    while (i < tpl.length) {
      const j = tpl.indexOf('{', i);
      if (j < 0) {
        toks.push({ t: 'text', v: tpl.slice(i) });
        break;
      }
      if (j > i) toks.push({ t: 'text', v: tpl.slice(i, j) });
      let k = j + 1, q = null, depth = 0;
      for (; k < tpl.length; k++) {
        const c = tpl[k];
        if (q) {
          if (c === '\\') { k++; continue; }
          if (c === q) q = null;
          continue;
        }
        if (c === '"' || c === "'") q = c;
        else if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) break;
          depth--;
        }
      }
      if (k >= tpl.length) throw new Error(`unclosed action`);
      toks.push({ t: 'action', v: tpl.slice(j + 1, k).trim() });
      i = k + 1;
    }
    // árvore com range/end
    const root = [];
    const stack = [root];
    for (const tk of toks) {
      const cur = stack[stack.length - 1];
      if (tk.t === 'text') cur.push(tk);
      else if (/^range\s/.test(tk.v)) {
        const node = { t: 'range', path: tk.v.slice(6).trim(), body: [] };
        cur.push(node);
        stack.push(node.body);
      } else if (tk.v === 'end') {
        if (stack.length === 1) throw new Error('not in range, nothing to end');
        stack.pop();
      } else {
        cur.push({ t: 'expr', v: tk.v });
      }
    }
    if (stack.length !== 1) throw new Error('unexpected EOF: missing {end}');
    return root;
  };
  const unq = (s) => {
    const q = s[0];
    let body = s.slice(1, -1);
    if (q === '"' || q === "'") body = body.replace(/\\(.)/g, (m, c) => ({ n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }[c] ?? c));
    return body;
  };
  U.unquote = unq;
  function parsePath(expr) {
    const steps = [];
    let i = 0;
    if (expr[0] === '$' || expr[0] === '@') i = 1;
    while (i < expr.length) {
      const c = expr[i];
      if (c === '.') {
        if (expr[i + 1] === '.') {
          i += 2;
          let name = '';
          while (i < expr.length && !/[.[]/.test(expr[i])) name += expr[i++];
          steps.push({ t: 'recursive', name });
          continue;
        }
        i++;
        let name = '';
        while (i < expr.length && expr[i] !== '.' && expr[i] !== '[') {
          if (expr[i] === '\\' && i + 1 < expr.length) { name += expr[i + 1]; i += 2; continue; }
          name += expr[i++];
        }
        if (name === '*') steps.push({ t: 'wild' });
        else if (name) steps.push({ t: 'field', name });
        continue;
      }
      if (c === '[') {
        let k = i + 1, depth = 1, q = null;
        for (; k < expr.length; k++) {
          const ch = expr[k];
          if (q) { if (ch === '\\') { k++; continue; } if (ch === q) q = null; continue; }
          if (ch === '"' || ch === "'") q = ch;
          else if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (!depth) break; }
        }
        const inner = expr.slice(i + 1, k).trim();
        i = k + 1;
        if (inner === '*') steps.push({ t: 'wild' });
        else if (inner.startsWith('?(')) steps.push({ t: 'filter', expr: inner.slice(2, -1) });
        else if (/^['"]/.test(inner)) steps.push({ t: 'fields', names: inner.split(/\s*,\s*/).map(unq) });
        else if (inner.includes(':')) {
          const [a, b, st] = inner.split(':').map((x) => (x.trim() === '' ? null : parseInt(x)));
          steps.push({ t: 'slice', a, b, st });
        } else if (inner.includes(',')) steps.push({ t: 'idxs', idx: inner.split(',').map((x) => parseInt(x)) });
        else if (/^-?\d+$/.test(inner)) steps.push({ t: 'idx', i: parseInt(inner) });
        else steps.push({ t: 'field', name: inner });
        continue;
      }
      let name = '';
      while (i < expr.length && expr[i] !== '.' && expr[i] !== '[') name += expr[i++];
      if (name) steps.push({ t: 'field', name });
    }
    return steps;
  }
  function evalFilter(expr, item, root) {
    const parts = expr.split(/\s*(&&|\|\|)\s*/);
    let result = null, op = null;
    for (const p of parts) {
      if (p === '&&' || p === '||') { op = p; continue; }
      const m = p.match(/^(.+?)\s*(==|!=|<=|>=|<|>|=~)\s*(.+)$/);
      let r;
      if (!m) {
        const v = evalPath(p.trim(), item, root);
        r = v.length > 0 && v[0] !== undefined && v[0] !== null && v[0] !== false;
      } else {
        const lv = evalPath(m[1].trim(), item, root);
        let rhs = m[3].trim();
        let rv;
        if (/^['"]/.test(rhs)) rv = unq(rhs);
        else if (/^-?\d+(\.\d+)?$/.test(rhs)) rv = Number(rhs);
        else if (rhs === 'true' || rhs === 'false') rv = rhs === 'true';
        else if (rhs.startsWith('@') || rhs.startsWith('$')) rv = evalPath(rhs, item, root)[0];
        else rv = rhs;
        const l = lv[0];
        if (lv.length === 0) r = false;
        else switch (m[2]) {
          case '==': r = l == rv; break;
          case '!=': r = l != rv; break;
          case '<': r = l < rv; break;
          case '>': r = l > rv; break;
          case '<=': r = l <= rv; break;
          case '>=': r = l >= rv; break;
          case '=~': r = new RegExp(String(rv).replace(/^\/|\/$/g, '')).test(String(l)); break;
        }
      }
      result = result === null ? r : op === '&&' ? result && r : result || r;
    }
    return !!result;
  }
  function evalPath(expr, cur, root) {
    expr = expr.trim();
    let start = expr[0] === '$' ? root : cur;
    if (expr === '@' || expr === '$' || expr === '.') return [start];
    let vals = [start];
    for (const st of parsePath(expr)) {
      const next = [];
      for (const v of vals) {
        if (v === undefined || v === null) continue;
        switch (st.t) {
          case 'field':
            if (U.isObj(v) && st.name in v) next.push(v[st.name]);
            else if (Array.isArray(v) && st.name === 'length') next.push(v.length);
            break;
          case 'fields':
            for (const n of st.names) if (U.isObj(v) && n in v) next.push(v[n]);
            break;
          case 'wild':
            if (Array.isArray(v)) next.push(...v);
            else if (U.isObj(v)) next.push(...Object.keys(v).sort().map((k) => v[k]));
            break;
          case 'idx':
            if (Array.isArray(v)) {
              const i = st.i < 0 ? v.length + st.i : st.i;
              if (i >= 0 && i < v.length) next.push(v[i]);
              else throw new Error(`array index out of bounds: index ${st.i}, length ${v.length}`);
            }
            break;
          case 'idxs':
            if (Array.isArray(v)) for (const i of st.idx) if (v[i] !== undefined) next.push(v[i]);
            break;
          case 'slice':
            if (Array.isArray(v)) {
              let a = st.a ?? 0, b = st.b ?? v.length;
              if (a < 0) a = Math.max(0, v.length + a);
              if (b < 0) b = v.length + b;
              b = Math.min(b, v.length);
              for (let i = a; i < b; i += st.st || 1) next.push(v[i]);
            }
            break;
          case 'filter': {
            const items = Array.isArray(v) ? v : U.isObj(v) ? Object.values(v) : [];
            for (const it of items) if (evalFilter(st.expr, it, root)) next.push(it);
            break;
          }
          case 'recursive': {
            const walk = (o) => {
              if (Array.isArray(o)) o.forEach(walk);
              else if (U.isObj(o)) {
                if (st.name === '' || st.name === '*') next.push(o);
                else if (st.name in o) next.push(o[st.name]);
                Object.keys(o).forEach((k) => walk(o[k]));
              }
            };
            walk(v);
            break;
          }
        }
      }
      vals = next;
    }
    return vals;
  }
  JP.evalPath = evalPath;
  const fmtVal = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  JP.execute = (tpl, data, opts = {}) => {
    const tree = JP.parseTemplate(tpl);
    let out = '';
    const run = (nodes, cur) => {
      for (const n of nodes) {
        if (n.t === 'text') out += n.v;
        else if (n.t === 'range') {
          const vals = evalPath(n.path, cur, data);
          const items = vals.length === 1 && Array.isArray(vals[0]) ? vals[0] : vals;
          for (const it of items) run(n.body, it);
        } else {
          const e = n.v;
          if (/^(['"]).*\1$/s.test(e)) out += unq(e);
          else {
            const vals = evalPath(e, cur, data);
            if (opts.asJSON) out += JSON.stringify(vals.length === 1 ? vals[0] : vals, null, 4);
            else out += vals.map(fmtVal).join(' ');
          }
        }
      }
    };
    run(tree, data);
    return out;
  };

  // ---------- go-template mínimo ----------
  U.goTemplate = (tpl, data) => {
    let out = '';
    const re = /\{\{-?\s*(.*?)\s*-?\}\}/gs;
    const toks = [];
    let last = 0, m;
    while ((m = re.exec(tpl))) {
      toks.push({ t: 'text', v: tpl.slice(last, m.index) });
      toks.push({ t: 'act', v: m[1] });
      last = re.lastIndex;
    }
    toks.push({ t: 'text', v: tpl.slice(last) });
    const resolve = (expr, dot, vars) => {
      expr = expr.trim();
      if (/^".*"$/.test(expr)) return unq(expr);
      let m2;
      if ((m2 = expr.match(/^index\s+(\S+)\s+(.+)$/))) {
        let base = resolve(m2[1], dot, vars);
        for (const k of m2[2].match(/"[^"]*"|\S+/g)) base = base == null ? undefined : base[/^"/.test(k) ? unq(k) : /^\d+$/.test(k) ? Number(k) : resolve(k, dot, vars)];
        return base;
      }
      if ((m2 = expr.match(/^base64decode\s+(.+)$/))) return U.b64d(resolve(m2[1], dot, vars) || '');
      if ((m2 = expr.match(/^len\s+(.+)$/))) { const v = resolve(m2[1], dot, vars); return v ? (Array.isArray(v) ? v.length : Object.keys(v).length) : 0; }
      if ((m2 = expr.match(/^printf\s+("(?:[^"\\]|\\.)*")\s*(.*)$/))) {
        const f = unq(m2[1]);
        const args = (m2[2].match(/"[^"]*"|\S+/g) || []).map((a) => resolve(a, dot, vars));
        let i = 0;
        return f.replace(/%[sdvq]/g, (x) => (x === '%q' ? JSON.stringify(args[i++]) : String(args[i++])));
      }
      if (expr.startsWith('$')) {
        const [v, ...rest] = expr.split('.');
        let base = v === '$' ? data : vars[v];
        for (const r of rest) base = base == null ? undefined : base[r];
        return base;
      }
      if (expr === '.') return dot;
      let base = dot;
      for (const r of expr.split('.').filter(Boolean)) base = base == null ? undefined : base[r];
      return base;
    };
    let pos = 0;
    const skip = () => {
      let d = 0;
      while (pos < toks.length) {
        const tk = toks[pos++];
        if (tk.t !== 'act') continue;
        if (/^(range|if)\b/.test(tk.v)) d++;
        else if (tk.v === 'end') { if (!d) return; d--; }
      }
    };
    const skipUntilElse = () => {
      let d = 0;
      while (pos < toks.length) {
        const tk = toks[pos++];
        if (tk.t !== 'act') continue;
        if (/^(range|if)\b/.test(tk.v)) d++;
        else if (tk.v === 'else' && !d) return 'else';
        else if (tk.v === 'end') { if (!d) return 'end'; d--; }
      }
    };
    const exec = (dot, vars) => {
      while (pos < toks.length) {
        const tk = toks[pos++];
        if (tk.t === 'text') { out += tk.v; continue; }
        const a = tk.v;
        if (a === 'end' || a === 'else') return a;
        let m3;
        if ((m3 = a.match(/^range\s+(?:(\$\w+)\s*(?:,\s*(\$\w+))?\s*:=\s*)?(.+)$/))) {
          const coll = resolve(m3[3], dot, vars);
          const bodyStart = pos;
          const entries = Array.isArray(coll) ? coll.map((v, i) => [i, v]) : U.isObj(coll) ? Object.keys(coll).sort().map((k) => [k, coll[k]]) : [];
          if (!entries.length) { skip(); continue; }
          for (const [k, v] of entries) {
            pos = bodyStart;
            const nv = { ...vars };
            if (m3[1] && m3[2]) { nv[m3[1]] = k; nv[m3[2]] = v; } else if (m3[1]) nv[m3[1]] = v;
            exec(v, nv);
          }
          continue;
        }
        if ((m3 = a.match(/^if\s+(.+)$/))) {
          let cond;
          const m4 = m3[1].match(/^(eq|ne)\s+(\S+)\s+(\S+)$/);
          if (m4) { const x = resolve(m4[2], dot, vars), y = resolve(m4[3], dot, vars); cond = m4[1] === 'eq' ? x == y : x != y; }
          else { const v = resolve(m3[1], dot, vars); cond = !!v && !(Array.isArray(v) && !v.length); }
          if (cond) { const r = exec(dot, vars); if (r === 'else') skip(); }
          else { const r = skipUntilElse(); if (r === 'else') exec(dot, vars); }
          continue;
        }
        const v = resolve(a, dot, vars);
        out += v === undefined ? '<no value>' : typeof v === 'object' ? (Array.isArray(v) ? `[${v.join(' ')}]` : `map[${Object.entries(v).map(([k, x]) => k + ':' + x).join(' ')}]`) : String(v);
      }
    };
    exec(data, {});
    return out;
  };

  // ---------- tabwriter (text/tabwriter do Go) ----------
  U.tabwrite = (text, minwidth = 0, padding = 1) => {
    const lines = text.split('\n').map((l) => l.split('\t'));
    const widths = lines.map(() => []);
    const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
    const format = (l0, l1, col) => {
      for (let t = l0; t < l1; t++) {
        if (col >= lines[t].length - 1) continue;
        let width = minwidth, l = t;
        for (; l < l1; l++) {
          if (col >= lines[l].length - 1) break;
          width = Math.max(width, vis(lines[l][col]) + padding);
        }
        for (let k = t; k < l; k++) widths[k][col] = width;
        format(t, l, col + 1);
        t = l - 1;
      }
    };
    format(0, lines.length, 0);
    return lines
      .map((cells, i) => cells.map((c, j) => (j < cells.length - 1 ? c + ' '.repeat(Math.max(0, widths[i][j] - vis(c))) : c)).join(''))
      .join('\n');
  };
  U.table = (rows) => U.tabwrite(rows.map((r) => r.join('\t')).join('\n'), 6, 3);

  // ---------- patches ----------
  const MERGE_KEYS = {
    containers: 'name', initContainers: 'name', ephemeralContainers: 'name', volumes: 'name', env: 'name',
    volumeMounts: 'mountPath', imagePullSecrets: 'name', conditions: 'type', hostAliases: 'ip',
    topologySpreadConstraints: 'topologyKey', volumeDevices: 'devicePath', resourceClaims: 'name',
  };
  const mergeKeyFor = (key, list) => {
    if (key === 'ports') {
      const it = (list || []).find((x) => U.isObj(x));
      if (it && 'containerPort' in it) return 'containerPort';
      if (it && 'port' in it) return 'port';
      return null;
    }
    return MERGE_KEYS[key] || null;
  };
  U.mergeKeyFor = mergeKeyFor;
  U.strategicMerge = (target, patch) => {
    if (!U.isObj(patch)) return U.clone(patch);
    const out = U.isObj(target) ? U.clone(target) : {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === '$patch' || k.startsWith('$setElementOrder') || k === '$retainKeys') continue;
      if (v === null) { delete out[k]; continue; }
      if (Array.isArray(v)) {
        const mk = mergeKeyFor(k, v.length ? v : out[k]);
        if (mk && Array.isArray(out[k])) {
          const res = U.clone(out[k]);
          for (const item of v) {
            if (!U.isObj(item)) continue;
            const idx = res.findIndex((x) => x && x[mk] === item[mk]);
            if (item.$patch === 'delete') { if (idx >= 0) res.splice(idx, 1); continue; }
            if (idx >= 0) res[idx] = U.strategicMerge(res[idx], item);
            else res.push(U.strategicMerge({}, item));
          }
          out[k] = res;
        } else out[k] = U.clone(v);
      } else if (U.isObj(v)) out[k] = U.strategicMerge(out[k], v);
      else out[k] = v;
    }
    return out;
  };
  U.mergePatch = (target, patch) => {
    if (!U.isObj(patch)) return U.clone(patch);
    const out = U.isObj(target) ? U.clone(target) : {};
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete out[k];
      else out[k] = U.mergePatch(out[k], v);
    }
    return out;
  };
  const ptr = (p) => (p === '' ? [] : p.replace(/^\//, '').split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')));
  U.jsonPatch = (target, ops) => {
    let doc = U.clone(target);
    if (!Array.isArray(ops)) throw new Error('json: cannot unmarshal object into Go value of type jsonpatch.Patch');
    const getParent = (path) => {
      const parts = ptr(path);
      let cur = doc;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = Array.isArray(cur) ? Number(parts[i]) : parts[i];
        if (cur[k] === undefined) throw new Error(`doc is missing path: "${path}": missing value`);
        cur = cur[k];
      }
      return [cur, parts[parts.length - 1]];
    };
    const getVal = (path) => {
      let cur = doc;
      for (const p of ptr(path)) {
        if (cur === undefined || cur === null) return undefined;
        cur = cur[Array.isArray(cur) ? Number(p) : p];
      }
      return cur;
    };
    const add = (path, value) => {
      if (path === '') { doc = U.clone(value); return; }
      const [parent, key] = getParent(path);
      if (Array.isArray(parent)) {
        if (key === '-') parent.push(U.clone(value));
        else parent.splice(Number(key), 0, U.clone(value));
      } else parent[key] = U.clone(value);
    };
    const remove = (path) => {
      const [parent, key] = getParent(path);
      if (Array.isArray(parent)) {
        if (Number(key) >= parent.length) throw new Error(`Unable to remove nonexistent key: ${key}: missing value`);
        parent.splice(Number(key), 1);
      } else {
        if (!(key in parent)) throw new Error(`Unable to remove nonexistent key: ${key}: missing value`);
        delete parent[key];
      }
    };
    for (const op of ops) {
      switch (op.op) {
        case 'add': add(op.path, op.value); break;
        case 'remove': remove(op.path); break;
        case 'replace': {
          if (getVal(op.path) === undefined) throw new Error(`replace operation does not apply: doc is missing key: ${op.path}: missing value`);
          const [parent, key] = getParent(op.path);
          parent[Array.isArray(parent) ? Number(key) : key] = U.clone(op.value);
          break;
        }
        case 'move': { const v = getVal(op.from); remove(op.from); add(op.path, v); break; }
        case 'copy': add(op.path, getVal(op.from)); break;
        case 'test':
          if (JSON.stringify(getVal(op.path)) !== JSON.stringify(op.value)) throw new Error(`testing value ${op.path} failed: test failed`);
          break;
        default: throw new Error(`Unexpected kind: ${op.op}`);
      }
    }
    return doc;
  };
  // patch de três vias (apply client-side): remove o que saiu do last-applied
  U.threeWay = (live, last, desired) => {
    const out = U.isObj(live) ? U.clone(live) : {};
    last = U.isObj(last) ? last : {};
    for (const k of Object.keys(last)) if (!(k in desired)) delete out[k];
    for (const [k, v] of Object.entries(desired)) {
      if (U.isObj(v)) out[k] = U.threeWay(out[k], last[k], v);
      else if (Array.isArray(v)) {
        const mk = mergeKeyFor(k, v);
        if (mk && Array.isArray(out[k]) && v.every((x) => U.isObj(x) && mk in x)) {
          const lastArr = Array.isArray(last[k]) ? last[k] : [];
          const res = [];
          for (const item of v) {
            const liveItem = out[k].find((x) => x && x[mk] === item[mk]);
            const lastItem = lastArr.find((x) => x && x[mk] === item[mk]);
            res.push(liveItem ? U.threeWay(liveItem, lastItem, item) : U.clone(item));
          }
          for (const liveItem of out[k]) {
            const inNew = v.some((x) => x[mk] === liveItem[mk]);
            const inLast = lastArr.some((x) => x && x[mk] === liveItem[mk]);
            if (!inNew && !inLast) res.push(liveItem);
          }
          out[k] = res;
        } else out[k] = U.clone(v);
      } else out[k] = v;
    }
    return out;
  };

  // ---------- diff unificado ----------
  U.diffLines = (a, b) => {
    const A = a.split('\n'), B = b.split('\n');
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push([' ', A[i], i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', A[i], i, j]); i++; }
      else { ops.push(['+', B[j], i, j]); j++; }
    }
    while (i < n) { ops.push(['-', A[i], i, j]); i++; }
    while (j < m) { ops.push(['+', B[j], i, j]); j++; }
    return ops;
  };
  U.unifiedDiff = (a, b, ctx = 3) => {
    const ops = U.diffLines(a, b);
    if (!ops.some((o) => o[0] !== ' ')) return '';
    const hunks = [];
    let k = 0;
    while (k < ops.length) {
      if (ops[k][0] === ' ') { k++; continue; }
      let start = Math.max(0, k - ctx), end = k;
      while (end < ops.length) {
        if (ops[end][0] !== ' ') { end++; continue; }
        let run = 0;
        while (end + run < ops.length && ops[end + run][0] === ' ') run++;
        if (run > ctx * 2 || end + run >= ops.length) { end = Math.min(ops.length, end + ctx); break; }
        end += run;
      }
      hunks.push(ops.slice(start, end));
      k = end;
    }
    let out = '';
    for (const h of hunks) {
      const aStart = h[0][2] + 1, bStart = h[0][3] + 1;
      const aLen = h.filter((o) => o[0] !== '+').length, bLen = h.filter((o) => o[0] !== '-').length;
      out += `@@ -${aStart},${aLen} +${bStart},${bLen} @@\n`;
      for (const o of h) out += o[0] + o[1] + '\n';
    }
    return out;
  };

  // ---------- cron ----------
  const CRON_ALIASES = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
  const MONTHN = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const DOWN = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  U.parseCron = (expr) => {
    expr = (CRON_ALIASES[expr.trim()] || expr).trim();
    let tz = null;
    const tzm = expr.match(/^(?:CRON_)?TZ=(\S+)\s+(.*)$/);
    if (tzm) { tz = tzm[1]; expr = tzm[2]; }
    const f = expr.split(/\s+/);
    if (f.length !== 5) throw new Error(`expected exactly 5 fields, found ${f.length}: ${expr}`);
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const names = [null, null, null, MONTHN, DOWN];
    const sets = f.map((field, idx) => {
      const [lo, hi] = ranges[idx];
      const set = new Set();
      for (const part of field.split(',')) {
        const [rng, stepS] = part.split('/');
        const step = stepS ? parseInt(stepS) : 1;
        if (stepS && (isNaN(step) || step <= 0)) throw new Error(`invalid step: ${part}`);
        let a, b;
        const nm = (x) => {
          const lx = x.toLowerCase();
          if (names[idx] && lx in names[idx]) return names[idx][lx];
          if (!/^\d+$/.test(x)) throw new Error(`failed to parse int from ${x}: strconv.Atoi: parsing "${x}": invalid syntax`);
          return parseInt(x);
        };
        if (rng === '*' || rng === '?') { a = lo; b = hi; }
        else if (rng.includes('-')) { [a, b] = rng.split('-').map(nm); }
        else { a = nm(rng); b = stepS ? hi : a; }
        if (a < lo || b > hi || a > b) throw new Error(`end of range (${b}) above maximum (${hi}): ${rng}`);
        for (let v = a; v <= b; v += step) set.add(idx === 4 && v === 7 ? 0 : v);
      }
      return set;
    });
    const domStar = f[2] === '*' || f[2] === '?', dowStar = f[4] === '*' || f[4] === '?';
    return {
      tz,
      match(d) {
        const dom = sets[2].has(d.getUTCDate()), dow = sets[4].has(d.getUTCDay());
        const dayOk = domStar || dowStar ? dom && dow : dom || dow;
        return sets[0].has(d.getUTCMinutes()) && sets[1].has(d.getUTCHours()) && sets[3].has(d.getUTCMonth() + 1) && dayOk;
      },
    };
  };
  U.cronNext = (cron, after) => {
    const t = new Date(Math.floor(after / 60000) * 60000 + 60000);
    for (let i = 0; i < 60 * 24 * 366; i++) {
      if (cron.match(t)) return t.getTime();
      t.setTime(t.getTime() + 60000);
    }
    return null;
  };

  // ---------- validações de nome ----------
  U.dns1123Subdomain = (n) => typeof n === 'string' && n.length <= 253 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(n);
  U.dns1123Label = (n) => typeof n === 'string' && n.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(n);
  U.dns1035Label = (n) => typeof n === 'string' && n.length <= 63 && /^[a-z]([-a-z0-9]*[a-z0-9])?$/.test(n);
  U.validLabelValue = (v) => v === '' || (String(v).length <= 63 && /^(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])$/.test(String(v)));
  U.validLabelKey = (k) => {
    const parts = String(k).split('/');
    if (parts.length > 2) return false;
    const name = parts[parts.length - 1];
    if (parts.length === 2 && !U.dns1123Subdomain(parts[0])) return false;
    return name.length <= 63 && /^([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]$/.test(name);
  };

  // ---------- pi (job de exemplo do perl) ----------
  U.piDigits = (n) => {
    let q = 1n, r = 0n, t = 1n, k = 1n, m = 3n, x = 3n;
    let out = '';
    while (out.length < n + 1) {
      if (4n * q + r - t < m * t) {
        out += m.toString();
        if (out.length === 1) out += '.';
        const nr = 10n * (r - m * t);
        m = (10n * (3n * q + r)) / t - 10n * m;
        q *= 10n;
        r = nr;
      } else {
        const nr = (2n * q + r) * x;
        const nm = (q * (7n * k + 2n) + r * x) / (t * x);
        q *= k;
        t *= x;
        x += 2n;
        k += 1n;
        m = nm;
        r = nr;
      }
    }
    return out.slice(0, n + 2);
  };

  // ---------- ANSI ----------
  U.c = {
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    yellow: (s) => `\x1b[33m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
    blue: (s) => `\x1b[34m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
  };
})();
