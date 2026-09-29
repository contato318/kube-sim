// Lexer, parser e expansão de palavras no estilo POSIX sh.
// Usado pelo terminal, pelo `kubectl exec` e pela simulação dos comandos dos containers.
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const SH = (KS.sh = {});

  class Incomplete extends Error {
    constructor(msg) {
      super(msg || 'incomplete');
      this.incomplete = true;
    }
  }
  SH.Incomplete = Incomplete;
  class SyntaxErr extends Error {}
  SH.SyntaxError = SyntaxErr;

  const OPS = ['&&', '||', ';;', '>>', '2>&1', '2>>', '2>', '&>', '>&', '|', ';', '&', '>', '<', '(', ')'];

  function scanQuoted(src, i, q) {
    for (let j = i + 1; j < src.length; j++) {
      if (q === '"' && src[j] === '\\') { j++; continue; }
      if (q === '"' && src[j] === '$' && src[j + 1] === '(') { j = scanParen(src, j + 1); continue; }
      if (src[j] === q) return j;
    }
    throw new Incomplete();
  }
  function scanParen(src, i) {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (c === "'" || c === '"' || c === '`') { j = c === '`' ? scanBacktick(src, j) : scanQuoted(src, j, c); continue; }
      if (c === '\\') { j++; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return j; }
    }
    throw new Incomplete();
  }
  function scanBacktick(src, i) {
    for (let j = i + 1; j < src.length; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '`') return j;
    }
    throw new Incomplete();
  }

  SH.lex = function lex(src) {
    const toks = [];
    let i = 0, word = null;
    const n = src.length;
    const pending = [];
    const push = () => {
      if (word !== null) { toks.push({ t: 'w', v: word }); word = null; }
    };
    while (i < n) {
      const c = src[i];
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { push(); i++; continue; }
      if (c === '\n') {
        push();
        toks.push({ t: 'op', v: '\n' });
        i++;
        for (const h of pending) {
          const lines = [];
          let found = false;
          while (i <= n) {
            let e = src.indexOf('\n', i);
            if (e < 0) e = n;
            const line = src.slice(i, e);
            i = e + 1;
            const cmp = h.strip ? line.replace(/^\t+/, '') : line;
            if (cmp === h.delim) { found = true; break; }
            lines.push(cmp);
            if (e >= n) break;
          }
          if (!found) throw new Incomplete('heredoc');
          h.tok.body = lines.length ? lines.join('\n') + '\n' : '';
        }
        pending.length = 0;
        continue;
      }
      if (c === '#' && word === null) {
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === "'") {
        const j = src.indexOf("'", i + 1);
        if (j < 0) throw new Incomplete();
        word = (word || '') + src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '"') {
        const j = scanQuoted(src, i, '"');
        word = (word || '') + src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '`') {
        const j = scanBacktick(src, i);
        word = (word || '') + src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '(') {
        const j = scanParen(src, i + 1);
        word = (word || '') + src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        const j = src.indexOf('}', i);
        if (j < 0) throw new Incomplete();
        word = (word || '') + src.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      if (c === '\\') {
        if (i + 1 >= n) throw new Incomplete();
        word = (word || '') + src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (src.startsWith('<<', i)) {
        push();
        const strip = src[i + 2] === '-';
        i += strip ? 3 : 2;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let d = '';
        let quoted = false;
        while (i < n && !/[\s;|&<>]/.test(src[i])) {
          if (src[i] === "'" || src[i] === '"') { quoted = true; i++; continue; }
          d += src[i++];
        }
        if (!d) throw new SyntaxErr("syntax error near unexpected token `newline'");
        const tok = { t: 'op', v: '<<', delim: d, strip, quoted, body: null };
        toks.push(tok);
        pending.push({ tok, delim: d, strip });
        continue;
      }
      let matched = null;
      for (const op of OPS) {
        if (!src.startsWith(op, i)) continue;
        if (op[0] === '2' && word !== null) continue;
        matched = op;
        break;
      }
      if (matched) {
        push();
        toks.push({ t: 'op', v: matched });
        i += matched.length;
        continue;
      }
      word = (word || '') + c;
      i++;
    }
    push();
    if (pending.length) throw new Incomplete('heredoc');
    return toks;
  };

  const REDIR = new Set(['>', '>>', '<', '2>', '2>>', '2>&1', '&>', '>&', '<<']);

  SH.parse = function parse(src) {
    const toks = SH.lex(src);
    let p = 0;
    const peek = () => toks[p];
    const isWord = (v) => peek() && peek().t === 'w' && (v === undefined || peek().v === v);
    const isOp = (v) => peek() && peek().t === 'op' && (v === undefined || peek().v === v);
    const isRedir = () => peek() && peek().t === 'op' && REDIR.has(peek().v);
    const skipNl = () => { while (isOp('\n') || isOp(';')) p++; };
    const skipNlOnly = () => { while (isOp('\n')) p++; };
    const unexpected = () => {
      const t = peek();
      return new SyntaxErr(`syntax error near unexpected token \`${t ? (t.v === '\n' ? 'newline' : t.v) : 'newline'}'`);
    };
    const expectWord = (v) => {
      if (!peek()) throw new Incomplete();
      if (!isWord(v)) throw unexpected();
      p++;
    };

    function parseList(stops) {
      const items = [];
      skipNl();
      while (p < toks.length) {
        if (peek().t === 'w' && stops.includes(peek().v)) break;
        if (isOp(')') && stops.includes(')')) break;
        const ao = parseAndOr();
        let bg = false;
        if (isOp('&')) { bg = true; p++; }
        else if (isOp(';') || isOp('\n')) p++;
        else if (p < toks.length && !(peek().t === 'w' && stops.includes(peek().v)) && !(isOp(')') && stops.includes(')'))) throw unexpected();
        items.push({ ao, bg });
        skipNl();
      }
      if (stops.length && p >= toks.length) throw new Incomplete();
      return { t: 'list', items };
    }
    function parseAndOr() {
      const first = parsePipeline();
      const rest = [];
      while (isOp('&&') || isOp('||')) {
        const op = toks[p++].v;
        skipNlOnly();
        if (p >= toks.length) throw new Incomplete();
        rest.push({ op, pipe: parsePipeline() });
      }
      return { first, rest };
    }
    function parsePipeline() {
      let neg = false;
      if (isWord('!')) { neg = true; p++; }
      const cmds = [parseCommand()];
      while (isOp('|')) {
        p++;
        skipNlOnly();
        if (p >= toks.length) throw new Incomplete();
        cmds.push(parseCommand());
      }
      return { t: 'pipe', cmds, neg };
    }
    function parseRedirs(cmd) {
      while (isRedir()) {
        const op = toks[p++];
        if (op.v === '2>&1') { cmd.redirs.push({ op: '2>&1' }); continue; }
        if (op.v === '<<') { cmd.redirs.push({ op: '<<', body: op.body, quoted: op.quoted }); continue; }
        if (!isWord()) throw unexpected();
        cmd.redirs.push({ op: op.v, target: toks[p++].v });
      }
    }
    function parseCommand() {
      if (!peek()) throw new Incomplete();
      if (isWord('while') || isWord('until')) {
        const until = peek().v === 'until';
        p++;
        const cond = parseList(['do']);
        expectWord('do');
        const body = parseList(['done']);
        expectWord('done');
        const c = { t: 'while', until, cond, body, redirs: [] };
        parseRedirs(c);
        return c;
      }
      if (isWord('for')) {
        p++;
        if (!isWord()) throw new Incomplete();
        const name = toks[p++].v;
        let words = null;
        skipNlOnly();
        if (isWord('in')) {
          p++;
          words = [];
          while (isWord()) words.push(toks[p++].v);
        }
        skipNl();
        expectWord('do');
        const body = parseList(['done']);
        expectWord('done');
        const c = { t: 'for', name, words, body, redirs: [] };
        parseRedirs(c);
        return c;
      }
      if (isWord('if')) {
        p++;
        const clauses = [];
        let cond = parseList(['then']);
        expectWord('then');
        let body = parseList(['elif', 'else', 'fi']);
        clauses.push({ cond, body });
        let elseBody = null;
        while (isWord('elif')) {
          p++;
          cond = parseList(['then']);
          expectWord('then');
          body = parseList(['elif', 'else', 'fi']);
          clauses.push({ cond, body });
        }
        if (isWord('else')) {
          p++;
          elseBody = parseList(['fi']);
        }
        expectWord('fi');
        const c = { t: 'if', clauses, elseBody, redirs: [] };
        parseRedirs(c);
        return c;
      }
      if (isWord('{')) {
        p++;
        const body = parseList(['}']);
        expectWord('}');
        const c = { t: 'group', body, redirs: [] };
        parseRedirs(c);
        return c;
      }
      if (isOp('(')) {
        p++;
        const body = parseList([')']);
        if (!isOp(')')) throw new Incomplete();
        p++;
        const c = { t: 'group', sub: true, body, redirs: [] };
        parseRedirs(c);
        return c;
      }
      const cmd = { t: 'simple', assigns: [], words: [], redirs: [] };
      while (p < toks.length) {
        if (isWord()) {
          const v = peek().v;
          if (!cmd.words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { cmd.assigns.push(v); p++; continue; }
          cmd.words.push(v);
          p++;
          continue;
        }
        if (isRedir()) { parseRedirs(cmd); continue; }
        break;
      }
      if (!cmd.words.length && !cmd.assigns.length && !cmd.redirs.length) throw unexpected();
      if (cmd.words.length && ['then', 'else', 'elif', 'fi', 'do', 'done', '}'].includes(cmd.words[0])) {
        throw new SyntaxErr(`syntax error near unexpected token \`${cmd.words[0]}'`);
      }
      return cmd;
    }
    const list = parseList([]);
    if (p < toks.length) throw unexpected();
    return list;
  };

  // ---------- expansão ----------
  SH.collectSubsts = function (raw) {
    const out = [];
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === "'") { const j = raw.indexOf("'", i + 1); i = j < 0 ? raw.length : j + 1; continue; }
      if (c === '"') { i++; continue; }
      if (c === '\\') { i += 2; continue; }
      if (c === '$' && raw[i + 1] === '(' && raw[i + 2] !== '(') {
        const j = scanParen(raw, i + 1);
        out.push(raw.slice(i + 2, j));
        i = j + 1;
        continue;
      }
      if (c === '`') {
        const j = scanBacktick(raw, i);
        out.push(raw.slice(i + 1, j));
        i = j + 1;
        continue;
      }
      i++;
    }
    return out;
  };

  SH.evalArith = function (expr, vars) {
    let e = expr.replace(/\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, name) => {
      const v = vars(name);
      return v === undefined || v === '' ? '0' : String(parseInt(v) || 0);
    });
    if (!/^[\d\s+\-*/%()<>=!&|^~?:]*$/.test(e)) throw new Error(`syntax error in expression (error token is "${expr}")`);
    e = e.replace(/(\d+)\s*\/\s*(\d+)/g, 'Math.trunc($1/$2)');
    // eslint-disable-next-line no-new-func
    const r = Function(`"use strict";return (${e.trim() || 0});`)();
    return String(typeof r === 'boolean' ? (r ? 1 : 0) : Math.trunc(r));
  };

  function paramExpand(inner, vars) {
    let m;
    if ((m = inner.match(/^#([A-Za-z_]\w*)$/))) return String((vars(m[1]) || '').length);
    if ((m = inner.match(/^([A-Za-z_]\w*|\d+|[?$#@*])(:?[-=+?])(.*)$/s))) {
      const v = vars(m[1]);
      const empty = m[2].startsWith(':') ? v === undefined || v === '' : v === undefined;
      const op = m[2].replace(':', '');
      if (op === '-' || op === '=') return empty ? m[3] : v;
      if (op === '+') return empty ? '' : m[3];
      if (op === '?') { if (empty) throw new Error(`${m[1]}: ${m[3] || 'parameter null or not set'}`); return v; }
    }
    if ((m = inner.match(/^([A-Za-z_]\w*)(##|#|%%|%)(.*)$/))) {
      const v = vars(m[1]) || '';
      const greedy = m[2].length === 2;
      const src = m[3].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const re = new RegExp('^' + src + '$');
      if (m[2][0] === '#') {
        const idx = [];
        for (let i = 0; i <= v.length; i++) if (re.test(v.slice(0, i))) idx.push(i);
        if (!idx.length) return v;
        return v.slice(greedy ? idx[idx.length - 1] : idx[0]);
      }
      const idx = [];
      for (let i = v.length; i >= 0; i--) if (re.test(v.slice(i))) idx.push(i);
      if (!idx.length) return v;
      return v.slice(0, greedy ? idx[idx.length - 1] : idx[0]);
    }
    if ((m = inner.match(/^([A-Za-z_]\w*):(-?\d+)(?::(\d+))?$/))) {
      const v = vars(m[1]) || '';
      const s = parseInt(m[2]);
      const st = s < 0 ? v.length + s : s;
      return m[3] !== undefined ? v.substr(st, parseInt(m[3])) : v.substr(st);
    }
    return vars(inner) ?? '';
  }

  // Expande uma palavra em campos. vars(name) -> string|undefined; subst(src) -> string
  SH.expandWord = function (raw, vars, subst, opts = {}) {
    const fields = [];
    let cur = '', any = false;
    const split = (s) => {
      if (opts.noSplit) { cur += s; if (s) any = true; return; }
      const parts = s.split(/[ \t\n]+/);
      if (parts.length === 1) { cur += s; if (s) any = true; return; }
      cur += parts[0];
      if (cur !== '' || any) fields.push(cur);
      for (let k = 1; k < parts.length - 1; k++) if (parts[k] !== '') fields.push(parts[k]);
      cur = parts[parts.length - 1];
      any = cur !== '';
    };
    const dollar = (i) => {
      const nx = raw[i + 1];
      if (nx === '(' && raw[i + 2] === '(') {
        let depth = 0, j = i + 1;
        for (; j < raw.length; j++) { if (raw[j] === '(') depth++; else if (raw[j] === ')') { depth--; if (!depth) break; } }
        const inner = raw.slice(i + 3, j - 1);
        return [SH.evalArith(inner, vars), j + 1];
      }
      if (nx === '(') {
        const j = scanParen(raw, i + 1);
        return [String(subst(raw.slice(i + 2, j)) || '').replace(/\n+$/, ''), j + 1];
      }
      if (nx === '{') {
        const j = raw.indexOf('}', i);
        return [paramExpand(raw.slice(i + 2, j), vars), j + 1];
      }
      if (nx && /[?$#@*!0-9]/.test(nx)) return [vars(nx) ?? '', i + 2];
      const m = raw.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (m) return [vars(m[0]) ?? '', i + 1 + m[0].length];
      return ['$', i + 1];
    };
    let i = 0;
    if (raw[0] === '~' && (raw.length === 1 || raw[1] === '/')) {
      cur += vars('HOME') || '/root';
      any = true;
      i = 1;
    }
    while (i < raw.length) {
      const c = raw[i];
      if (c === "'") {
        const j = raw.indexOf("'", i + 1);
        cur += raw.slice(i + 1, j);
        any = true;
        i = j + 1;
      } else if (c === '"') {
        any = true;
        i++;
        while (i < raw.length && raw[i] !== '"') {
          const d = raw[i];
          if (d === '\\' && /[\\"$`\n]/.test(raw[i + 1])) { cur += raw[i + 1]; i += 2; continue; }
          if (d === '$') { const [v, j] = dollar(i); cur += v; i = j; continue; }
          if (d === '`') {
            const j = scanBacktick(raw, i);
            cur += String(subst(raw.slice(i + 1, j)) || '').replace(/\n+$/, '');
            i = j + 1;
            continue;
          }
          cur += d;
          i++;
        }
        i++;
      } else if (c === '\\') {
        cur += raw[i + 1] ?? '';
        any = true;
        i += 2;
      } else if (c === '$') {
        const [v, j] = dollar(i);
        split(v);
        i = j;
      } else if (c === '`') {
        const j = scanBacktick(raw, i);
        split(String(subst(raw.slice(i + 1, j)) || '').replace(/\n+$/, ''));
        i = j + 1;
      } else {
        cur += c;
        any = true;
        i++;
      }
    }
    if (cur !== '' || any) fields.push(cur);
    return fields;
  };
  SH.hasUnquotedGlob = (raw) => {
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === "'" || c === '"') { const j = raw.indexOf(c, i + 1); i = j < 0 ? raw.length : j + 1; continue; }
      if (c === '\\') { i += 2; continue; }
      if (c === '*' || c === '?') return true;
      i++;
    }
    return false;
  };
  SH.globToRegex = (g) => new RegExp('^' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
  // Heredoc: expande $VAR e $(...) a menos que o delimitador esteja entre aspas
  SH.expandHeredoc = (body, vars, subst) => {
    let out = '';
    let i = 0;
    while (i < body.length) {
      const c = body[i];
      if (c === '\\' && /[$`\\]/.test(body[i + 1] || '')) { out += body[i + 1]; i += 2; continue; }
      if (c === '$' && /[({A-Za-z_?$#@*0-9]/.test(body[i + 1] || '')) {
        let j;
        if (body[i + 1] === '(') j = scanParen(body, i + 1) + 1;
        else if (body[i + 1] === '{') j = body.indexOf('}', i) + 1;
        else { const m = body.slice(i + 1).match(/^([A-Za-z_]\w*|.)/); j = i + 1 + m[0].length; }
        out += SH.expandWord(body.slice(i, j), vars, subst, { noSplit: true })[0] ?? '';
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  };
  SH.quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
})();
