// Shell do terminal (host) e shell dentro dos containers, sistema de arquivos virtual e utilitários.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, SH = KS.sh, S = KS.schema, IM = KS.images;

  // ---------------- Pipe (stream entre estágios) ----------------
  class Pipe {
    constructor() { this.buf = ''; this.closed = false; this.waiters = []; }
    write(s) { this.buf += s; this.wake(); }
    close() { this.closed = true; this.wake(); }
    wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
    wait() { return new Promise((r) => this.waiters.push(r)); }
    async readAll() { while (!this.closed) await this.wait(); return this.buf; }
    async *lines(signal) {
      let pos = 0;
      for (;;) {
        const nl = this.buf.indexOf('\n', pos);
        if (nl >= 0) { yield this.buf.slice(pos, nl); pos = nl + 1; continue; }
        if (this.closed) { if (pos < this.buf.length) yield this.buf.slice(pos); return; }
        if (signal && signal.aborted) return;
        await Promise.race([this.wait(), new Promise((r) => setTimeout(r, 200))]);
      }
    }
  }
  KS.Pipe = Pipe;
  const readAll = async (stdin) => (stdin === null || stdin === undefined ? '' : typeof stdin === 'string' ? stdin : stdin.readAll());
  async function* stdinLines(stdin, signal) {
    if (stdin === null || stdin === undefined) return;
    if (typeof stdin === 'string') { const ls = stdin.split('\n'); if (ls[ls.length - 1] === '') ls.pop(); yield* ls; return; }
    yield* stdin.lines(signal);
  }

  // ---------------- VFS ----------------
  class VFS {
    constructor(state) {
      this.files = (state && state.files) || {};
      this.dirs = new Set((state && state.dirs) || ['/', '/root', '/root/.kube', '/tmp', '/etc', '/usr', '/usr/bin', '/var', '/home', '/bin', '/opt']);
      this.cwdPath = (state && state.cwd) || '/root';
      this.onWrite = null;
    }
    serialize() { return { files: this.files, dirs: [...this.dirs], cwd: this.cwdPath }; }
    cwd() { return this.cwdPath; }
    abs(p) {
      if (!p) return this.cwdPath;
      if (p === '~' || p.startsWith('~/')) p = '/root' + p.slice(1);
      if (!p.startsWith('/')) p = this.cwdPath.replace(/\/$/, '') + '/' + p;
      const out = [];
      for (const part of p.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return '/' + out.join('/');
    }
    read(p) { const a = this.abs(p); return Object.prototype.hasOwnProperty.call(this.files, a) ? this.files[a] : null; }
    exists(p) { return this.read(p) !== null || this.isDir(p); }
    isDir(p) {
      const a = this.abs(p);
      if (this.dirs.has(a)) return true;
      const pre = a === '/' ? '/' : a + '/';
      return Object.keys(this.files).some((f) => f.startsWith(pre));
    }
    mkdirp(a) {
      const parts = a.split('/').filter(Boolean);
      let cur = '';
      for (const p of parts) { cur += '/' + p; this.dirs.add(cur); }
    }
    write(p, content) {
      const a = this.abs(p);
      if (this.isDir(a) && this.read(a) === null) throw new Error(`${p}: Is a directory`);
      this.mkdirp(a.slice(0, a.lastIndexOf('/')) || '/');
      this.files[a] = String(content);
      if (this.onWrite) this.onWrite(a, this.files[a]);
    }
    rm(p, recursive) {
      const a = this.abs(p);
      if (this.read(a) !== null) { delete this.files[a]; if (this.onWrite) this.onWrite(a, null); return true; }
      if (this.isDir(a)) {
        if (!recursive) return 'dir';
        for (const f of Object.keys(this.files)) if (f.startsWith(a + '/')) { delete this.files[f]; if (this.onWrite) this.onWrite(f, null); }
        for (const d of [...this.dirs]) if (d === a || d.startsWith(a + '/')) this.dirs.delete(d);
        return true;
      }
      return false;
    }
    list(p) {
      const a = this.abs(p);
      const pre = a === '/' ? '/' : a + '/';
      const names = new Set();
      for (const f of Object.keys(this.files)) if (f.startsWith(pre)) { const rest = f.slice(pre.length); names.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest); }
      for (const d of this.dirs) if (d.startsWith(pre) && d !== a) { const rest = d.slice(pre.length); if (rest) names.add(rest.split('/')[0] + '/'); }
      return [...names].sort();
    }
    walk(p) {
      const a = this.abs(p);
      const out = {};
      for (const f of Object.keys(this.files)) if (f.startsWith(a + '/')) out[f.slice(a.length + 1)] = this.files[f];
      return out;
    }
  }
  KS.VFS = VFS;

  // adaptador de FS do pod
  class PodFS {
    constructor(cluster, pod, cname) { this.cluster = cluster; this.pod = pod; this.cname = cname; this.cwdPath = '/'; this.prof = IM.profile(((pod.spec.containers.concat(pod.spec.initContainers || [], pod.spec.ephemeralContainers || [])).find((c) => c.name === cname) || {}).image); }
    cwd() { return this.cwdPath; }
    abs(p) { return VFS.prototype.abs.call({ cwdPath: this.cwdPath }, p && p.startsWith('~') ? '/root' + p.slice(1) : p); }
    fsmap() { return this.cluster.podFileSystem(this.pod, this.cname); }
    read(p) { const v = this.fsmap()[this.abs(p)]; return typeof v === 'string' ? v : null; }
    write(p, content) { const e = this.cluster.podWriteFile(this.pod, this.cname, this.abs(p), content); if (e) throw new Error(e); }
    rm(p) { const a = this.abs(p); if (this.read(a) === null) return this.isDir(a) ? 'dir' : false; const e = this.cluster.podWriteFile(this.pod, this.cname, a, null); if (e) throw new Error(e); return true; }
    baseDirs() {
      const s = new Set(['/', ...IM.rootDirs(this.prof).map((d) => '/' + d), '/tmp', '/root', '/proc', '/var/run', '/var/run/secrets', '/usr/share', '/var/log']);
      for (const m of (this.spec() || {}).volumeMounts || []) { const mp = m.mountPath.replace(/\/$/, ''); let cur = ''; for (const part of mp.split('/').filter(Boolean)) { cur += '/' + part; s.add(cur); } }
      return s;
    }
    spec() { return this.pod.spec.containers.concat(this.pod.spec.initContainers || [], this.pod.spec.ephemeralContainers || []).find((c) => c.name === this.cname); }
    isDir(p) {
      const a = this.abs(p);
      if (this.baseDirs().has(a)) return true;
      const pre = a === '/' ? '/' : a + '/';
      const m = this.fsmap();
      return Object.keys(m).some((f) => f.startsWith(pre) && m[f] !== null);
    }
    exists(p) { return this.read(p) !== null || this.isDir(p); }
    list(p) {
      const a = this.abs(p);
      const pre = a === '/' ? '/' : a + '/';
      const names = new Set();
      const m = this.fsmap();
      for (const f of Object.keys(m)) {
        if (m[f] === null || !f.startsWith(pre)) continue;
        const rest = f.slice(pre.length);
        if (!rest) continue;
        names.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest);
      }
      for (const d of this.baseDirs()) if (d.startsWith(pre) && d !== a) names.add(d.slice(pre.length).split('/')[0] + '/');
      if (a === '/') for (const d of IM.rootDirs(this.prof)) if (!names.has(d + '/') && !names.has(d)) names.add(d.includes('.') ? d : d + '/');
      return [...names].sort();
    }
    walk(p) { const a = this.abs(p); const m = this.fsmap(); const o = {}; for (const f of Object.keys(m)) if (f.startsWith(a + '/') && typeof m[f] === 'string' && !f.endsWith('/')) o[f.slice(a.length + 1)] = m[f]; return o; }
  }

  // ---------------- sinais de controle ----------------
  class ShExit { constructor(code) { this.code = code; } }
  const BREAK = { brk: true }, CONTINUE = { cont: true };
  class Aborted { constructor() { this.code = 130; } }

  // ---------------- interpretador ----------------
  class Interp {
    constructor(o) {
      this.vars = o.vars;
      this.fs = o.fs;
      this.aliases = o.aliases || {};
      this.commands = o.commands;
      this.shellName = o.shellName || 'bash';
      this.notFoundFmt = o.notFoundFmt || ((b) => `bash: ${b}: command not found\n`);
      this.last = 0;
      this.funcs = {};
      this.hasCommand = o.hasCommand || ((n) => !!this.commands[n]);
      this.onBackground = o.onBackground;
      this.globFs = o.globFs !== false;
    }
    getVar(n) {
      if (n === '?') return String(this.last);
      if (n === '$') return String(this.vars.$$ || 1);
      if (n === '#') return '0';
      if (n === '0') return this.shellName;
      if (n === 'RANDOM') return String(Math.floor(Math.random() * 32768));
      if (n === 'PWD') return this.fs.cwd();
      return this.vars[n];
    }
    async run(src, io) {
      const ast = SH.parse(src);
      try {
        return await this.execList(ast, io);
      } catch (e) {
        if (e instanceof Aborted) return (this.last = 130);
        if (e === BREAK || e === CONTINUE) return this.last;
        throw e;
      }
    }
    checkAbort(io) { if (io.signal && io.signal.aborted) throw new Aborted(); }
    async execList(list, io) {
      for (const it of list.items) {
        this.checkAbort(io);
        if (it.bg) {
          if (this.onBackground) this.onBackground(it.ao, io);
          this.last = 0;
          continue;
        }
        this.last = await this.execAndOr(it.ao, io);
      }
      return this.last;
    }
    async execAndOr(ao, io) {
      let st = await this.execPipe(ao.first, io);
      for (const r of ao.rest) {
        this.last = st;
        if ((r.op === '&&' && st === 0) || (r.op === '||' && st !== 0)) st = await this.execPipe(r.pipe, io);
      }
      return (this.last = st);
    }
    async execPipe(pipe, io) {
      let st;
      if (pipe.cmds.length === 1) st = await this.execCmd(pipe.cmds[0], io);
      else {
        const proms = [];
        let prev = io.stdin;
        for (let i = 0; i < pipe.cmds.length; i++) {
          const last = i === pipe.cmds.length - 1;
          const outPipe = last ? null : new Pipe();
          const sio = { ...io, stdin: prev, out: outPipe ? (s) => outPipe.write(s) : io.out, piped: !last };
          proms.push(this.execCmd(pipe.cmds[i], sio).catch((e) => { if (e instanceof ShExit) return e.code; throw e; }).finally(() => outPipe && outPipe.close()));
          prev = outPipe;
        }
        const res = await Promise.all(proms);
        st = res[res.length - 1];
      }
      if (pipe.neg) st = st === 0 ? 1 : 0;
      return st;
    }
    async substMap(raws, io) {
      const map = new Map();
      for (const raw of raws) {
        for (const src of SH.collectSubsts(raw)) {
          if (map.has(src)) continue;
          let buf = '';
          const saved = this.last;
          try {
            await this.run(src, { ...io, out: (s) => (buf += s), stdin: null });
          } catch (e) {
            if (e instanceof ShExit) { /* exit dentro de $( ) */ } else if (e.incomplete || e instanceof SH.SyntaxError) io.err(`${this.shellName}: command substitution: ${e.message}\n`); else throw e;
          }
          this.last = saved;
          map.set(src, buf);
        }
      }
      return (src) => map.get(src) ?? '';
    }
    expand(words, subst) {
      const out = [];
      for (const w of words) {
        const fields = SH.expandWord(w, (n) => this.getVar(n), subst);
        for (const f of fields) {
          if (this.globFs && SH.hasUnquotedGlob(w) && /[*?]/.test(f)) {
            const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
            const pat = SH.globToRegex(f.slice(dir.length));
            let names = [];
            try { names = this.fs.list(dir || '.').map((n) => n.replace(/\/$/, '')).filter((n) => pat.test(n) && !n.startsWith('.')); } catch (e) { names = []; }
            if (names.length) { out.push(...names.map((n) => dir + n)); continue; }
          }
          out.push(f);
        }
      }
      return out;
    }
    async execCmd(cmd, io0) {
      this.checkAbort(io0);
      let io = io0;
      const redirs = cmd.redirs || [];
      let outFile = null, errFile = null, bufOut = null, bufErr = null, errToOut = false;
      if (redirs.length) {
        const subst = await this.substMap(redirs.map((r) => r.target || ''), io);
        for (const r of redirs) {
          if (r.op === '<<') {
            io = { ...io, stdin: r.quoted ? r.body : SH.expandHeredoc(r.body, (n) => this.getVar(n), await this.substMap([r.body.replace(/`/g, '`')], io)) };
            continue;
          }
          if (r.op === '2>&1') { errToOut = true; continue; }
          const target = SH.expandWord(r.target, (n) => this.getVar(n), subst, { noSplit: true })[0];
          if (r.op === '<') {
            const c = this.fs.read(target);
            if (c === null) { io.err(`${this.shellName}: ${target}: No such file or directory\n`); return 1; }
            io = { ...io, stdin: c };
          } else if (r.op === '>' || r.op === '>>' || r.op === '&>') {
            if (target === '/dev/null') { bufOut = { null: true }; if (r.op === '&>') bufErr = { null: true }; continue; }
            if (target === '/dev/stderr') { io = { ...io, out: io.err }; continue; }
            outFile = { path: target, append: r.op === '>>' };
            if (r.op === '&>') errFile = outFile;
          } else if (r.op === '2>' || r.op === '2>>') {
            if (target === '/dev/null') { bufErr = { null: true }; continue; }
            errFile = { path: target, append: r.op === '2>>' };
          }
        }
        if (outFile && !(bufOut && bufOut.null)) { bufOut = { s: '' }; }
        if (errFile && !(bufErr && bufErr.null)) { bufErr = errFile === outFile ? bufOut : { s: '' }; }
        const outFn = bufOut ? (bufOut.null ? () => {} : (s) => (bufOut.s += s)) : io.out;
        const errFn = errToOut ? outFn : bufErr ? (bufErr.null ? () => {} : (s) => (bufErr.s += s)) : io.err;
        io = { ...io, out: outFn, err: errFn };
      }
      let st;
      try {
        st = await this.execCmdInner(cmd, io);
      } finally {
        const flush = (f, b) => {
          if (!f || !b || b.null) return;
          try {
            const prev = f.append ? this.fs.read(f.path) || '' : '';
            this.fs.write(f.path, prev + b.s);
          } catch (e) { io0.err(`${this.shellName}: ${f.path}: ${e.message}\n`); }
        };
        flush(outFile, bufOut);
        if (errFile !== outFile) flush(errFile, bufErr);
      }
      return st;
    }
    async execCmdInner(cmd, io) {
      switch (cmd.t) {
        case 'group': return this.execList(cmd.body, io);
        case 'if': {
          for (const cl of cmd.clauses) if ((await this.execList(cl.cond, io)) === 0) return this.execList(cl.body, io);
          return cmd.elseBody ? this.execList(cmd.elseBody, io) : 0;
        }
        case 'while': {
          let st = 0;
          for (let n = 0; ; n++) {
            this.checkAbort(io);
            const c = await this.execList(cmd.cond, io);
            if (cmd.until ? c === 0 : c !== 0) break;
            try { st = await this.execList(cmd.body, io); } catch (e) { if (e === BREAK) break; if (e === CONTINUE) continue; throw e; }
            if (n % 50 === 49) await new Promise((r) => setTimeout(r, 0));
          }
          return st;
        }
        case 'for': {
          const subst = await this.substMap(cmd.words || [], io);
          const items = cmd.words ? this.expand(cmd.words, subst) : [];
          let st = 0;
          for (const it of items) {
            this.checkAbort(io);
            this.vars[cmd.name] = it;
            try { st = await this.execList(cmd.body, io); } catch (e) { if (e === BREAK) break; if (e === CONTINUE) continue; throw e; }
          }
          return st;
        }
      }
      // comando simples
      const subst = await this.substMap([...cmd.words, ...cmd.assigns], io);
      const assigns = cmd.assigns.map((a) => {
        const i = a.indexOf('=');
        return [a.slice(0, i), SH.expandWord(a.slice(i + 1), (n) => this.getVar(n), subst, { noSplit: true })[0] ?? ''];
      });
      if (!cmd.words.length) {
        for (const [k, v] of assigns) this.vars[k] = v;
        return 0;
      }
      let argv = this.expand(cmd.words, subst);
      if (!argv.length) return 0;
      if (this.aliases[argv[0]] && /^[\w.-]+$/.test(cmd.words[0])) {
        const al = SH.lex(this.aliases[argv[0]]).filter((t) => t.t === 'w').map((t) => SH.expandWord(t.v, (n) => this.getVar(n), () => '', {})[0]);
        argv = [...al, ...argv.slice(1)];
      }
      const envOverride = Object.fromEntries(assigns);
      return this.invoke(argv, io, envOverride);
    }
    async invoke(argv, io, envOverride = {}) {
      const name = argv[0];
      if (this.funcs[name]) return this.execList(this.funcs[name], io);
      const fn = this.hasCommand(name) ? this.commands[name] || this.commands.__fallback : null;
      if (!fn) {
        io.err(this.notFoundFmt(name));
        return 127;
      }
      const saved = {};
      for (const [k, v] of Object.entries(envOverride)) { saved[k] = this.vars[k]; this.vars[k] = v; }
      try {
        const r = await fn.call(this, argv, io);
        return r === undefined ? 0 : r;
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete this.vars[k]; else this.vars[k] = v; }
      }
    }
  }
  KS.Interp = Interp;
  Interp.Exit = ShExit;
  Interp.BREAK = BREAK;
  Interp.CONTINUE = CONTINUE;

  // ---------------- utilitários comuns (texto/arquivos) ----------------
  const parseNum = (s) => (s === undefined ? undefined : parseInt(s));
  function getopts(args, withValue = []) {
    const flags = {}, pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { pos.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--') && a.length > 2) {
        const [k, v] = a.slice(2).split('=');
        if (v !== undefined) flags[k] = v;
        else if (withValue.includes(k)) flags[k] = args[++i];
        else flags[k] = true;
      } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          if (withValue.includes(ch)) { flags[ch] = a.slice(j + 1) || args[++i]; break; }
          flags[ch] = true;
        }
      } else pos.push(a);
    }
    return { flags, pos };
  }
  const readInputs = async (sh, files, io, name) => {
    if (!files.length || (files.length === 1 && files[0] === '-')) return [{ name: '-', text: await readAll(io.stdin) }];
    const out = [];
    for (const f of files) {
      if (sh.fs.isDir(f) && sh.fs.read(f) === null) { io.err(`${name}: ${f}: Is a directory\n`); continue; }
      const t = sh.fs.read(f);
      if (t === null) { io.err(`${name}: ${f}: No such file or directory\n`); out.err = true; continue; }
      out.push({ name: f, text: t });
    }
    return out;
  };
  const splitLines = (t) => { const l = t.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  const toRegex = (pat, flags = {}) => {
    let p = pat;
    if (flags.F) p = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (!flags.E) p = p.replace(/\\\|/g, '|').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\+/g, '+').replace(/\\\?/g, '?').replace(/\\\{/g, '{').replace(/\\\}/g, '}');
    p = p.replace(/\[\[:alpha:\]\]/g, '[A-Za-z]').replace(/\[\[:digit:\]\]/g, '[0-9]').replace(/\[\[:space:\]\]/g, '\\s').replace(/\[\[:upper:\]\]/g, '[A-Z]').replace(/\[\[:lower:\]\]/g, '[a-z]').replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]');
    if (flags.w) p = `\\b(?:${p})\\b`;
    if (flags.x) p = `^(?:${p})$`;
    return new RegExp(p, flags.i ? 'i' : '');
  };
  // awk mínimo
  function runAwk(prog, lines, FS, out, vars0 = {}) {
    const rules = [];
    let src = prog.trim();
    const rx = /^\s*(BEGIN|END|\/(?:[^/\\]|\\.)*\/|[^{]*?)?\s*\{([\s\S]*?)\}\s*;?/;
    while (src) {
      const m = src.match(rx);
      if (!m) { rules.push({ pat: src.trim(), act: 'print' }); break; }
      rules.push({ pat: (m[1] || '').trim(), act: m[2] });
      src = src.slice(m[0].length);
    }
    const vars = { ...vars0 };
    let NR = 0, fields = [], line = '';
    const val = (e) => {
      e = e.trim();
      if (/^"(.*)"$/.test(e)) return e.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      if (/^\$\(?NF\)?(-\d+)?$/.test(e)) { const m = e.match(/-(\d+)/); const i = fields.length - (m ? Number(m[1]) : 0); return fields[i - 1] ?? ''; }
      if (/^\$\d+$/.test(e)) { const i = Number(e.slice(1)); return i === 0 ? line : fields[i - 1] ?? ''; }
      if (e === 'NR') return NR;
      if (e === 'NF') return fields.length;
      if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
      const lm = e.match(/^length\((.*)\)$/);
      if (lm) return String(lm[1] ? val(lm[1]) : line).length;
      const tm = e.match(/^(toupper|tolower)\((.*)\)$/);
      if (tm) return tm[1] === 'toupper' ? String(val(tm[2])).toUpperCase() : String(val(tm[2])).toLowerCase();
      const ar = e.match(/^(.+?)\s*([+\-*/%])\s*(.+)$/);
      if (ar && !/^"/.test(e)) { const a = Number(val(ar[1])) || 0, b = Number(val(ar[3])) || 0; return { '+': a + b, '-': a - b, '*': a * b, '/': a / b, '%': a % b }[ar[2]]; }
      if (/^[A-Za-z_]\w*$/.test(e)) return vars[e] ?? '';
      return e;
    };
    const cond = (p) => {
      if (!p) return true;
      const rm = p.match(/^\/(.*)\/$/);
      if (rm) return new RegExp(rm[1]).test(line);
      const nm = p.match(/^(\S+?)\s*~\s*\/(.*)\/$/);
      if (nm) return new RegExp(nm[2]).test(String(val(nm[1])));
      const cm = p.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
      if (cm) {
        let a = val(cm[1]), b = val(cm[3]);
        if (!isNaN(Number(a)) && !isNaN(Number(b)) && a !== '' && b !== '') { a = Number(a); b = Number(b); }
        return { '==': a == b, '!=': a != b, '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b }[cm[2]];
      }
      return !!val(p);
    };
    const splitArgs = (s) => {
      const parts = []; let cur = '', q = false, depth = 0;
      for (const ch of s) {
        if (ch === '"') q = !q;
        if (!q && ch === '(') depth++;
        if (!q && ch === ')') depth--;
        if (ch === ',' && !q && !depth) { parts.push(cur); cur = ''; } else cur += ch;
      }
      if (cur.trim()) parts.push(cur);
      return parts;
    };
    const concat = (s) => {
      const toks = s.match(/"(?:[^"\\]|\\.)*"|\$\(?[\w-]+\)?|[^\s"]+/g) || [];
      return toks.map((t) => String(val(t))).join('');
    };
    const act = (a) => {
      for (let stmt of a.split(/;|\n/)) {
        stmt = stmt.trim();
        if (!stmt) continue;
        let m;
        if ((m = stmt.match(/^printf\s*\(?\s*"((?:[^"\\]|\\.)*)"\s*,?\s*(.*?)\)?$/))) {
          const args = m[2] ? splitArgs(m[2]).map((x) => val(x)) : [];
          let i = 0;
          out(m[1].replace(/%(-?\d*)(?:\.\d+)?([sdf])/g, (mm, w, t) => { const v = args[i++]; const s = t === 'd' ? String(Math.trunc(Number(v) || 0)) : String(v ?? ''); return w ? (w.startsWith('-') ? s.padEnd(Math.abs(w)) : s.padStart(Number(w))) : s; }).replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
        } else if ((m = stmt.match(/^print\s*(.*)$/))) {
          if (!m[1].trim()) { out(line + '\n'); continue; }
          out(splitArgs(m[1]).map((x) => concat(x.trim())).join(' ') + '\n');
        } else if ((m = stmt.match(/^([A-Za-z_]\w*)\s*(\+\+|--)$/))) vars[m[1]] = (Number(vars[m[1]]) || 0) + (m[2] === '++' ? 1 : -1);
        else if ((m = stmt.match(/^([A-Za-z_]\w*)\s*([+\-*/]?=)\s*(.+)$/))) {
          const v = val(m[3]);
          const cur = Number(vars[m[1]]) || 0;
          vars[m[1]] = m[2] === '=' ? v : m[2] === '+=' ? cur + Number(v) : m[2] === '-=' ? cur - Number(v) : m[2] === '*=' ? cur * Number(v) : cur / Number(v);
        } else if (stmt === 'next') return 'next';
      }
    };
    for (const r of rules) if (r.pat === 'BEGIN') act(r.act);
    for (const l of lines) {
      NR++;
      line = l;
      fields = FS === ' ' ? l.trim().split(/\s+/).filter(Boolean) : l.split(FS.length === 1 ? FS : new RegExp(FS));
      for (const r of rules) {
        if (r.pat === 'BEGIN' || r.pat === 'END') continue;
        if (cond(r.pat)) { if (act(r.act) === 'next') break; }
      }
    }
    for (const r of rules) if (r.pat === 'END') act(r.act);
  }
  // sed mínimo
  function runSed(scripts, text, quiet) {
    const lines = splitLines(text);
    const out = [];
    const cmds = [];
    for (const s of scripts) for (const part of s.split(/;\s*(?=[\d$/]*[sdpaic]|$)|\n/)) if (part.trim()) cmds.push(part.trim());
    const parsed = cmds.map((c) => {
      let addr = null, m;
      if ((m = c.match(/^(\d+|\$)(?:,(\d+|\$))?(.*)$/))) { addr = { a: m[1], b: m[2] }; c = m[3]; }
      else if ((m = c.match(/^\/((?:[^/\\]|\\.)*)\/(.*)$/))) { addr = { re: new RegExp(m[1]) }; c = m[2]; }
      if ((m = c.match(/^s(.)((?:(?!\1)[^\\]|\\.)*)\1((?:(?!\1)[^\\]|\\.)*)\1([gip0-9]*)$/))) {
        const f = m[4];
        const re = new RegExp(m[2].replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\+/g, '+').replace(/\\\|/g, '|'), (f.includes('g') ? 'g' : '') + (f.includes('i') ? 'i' : ''));
        return { addr, op: 's', re, rep: m[3].replace(/\\(\d)/g, '$$$1').replace(/&/g, '$$&'), p: f.includes('p') };
      }
      return { addr, op: c.trim()[0], arg: c.trim().slice(1).trim() };
    });
    lines.forEach((l, idx) => {
      let line = l, del = false, printed = false;
      const n = idx + 1, last = idx === lines.length - 1;
      for (const c of parsed) {
        if (c.addr) {
          const at = (x) => (x === '$' ? last : n === Number(x));
          if (c.addr.re && !c.addr.re.test(line)) continue;
          if (c.addr.a && !c.addr.b && !at(c.addr.a)) continue;
          if (c.addr.a && c.addr.b && !(n >= Number(c.addr.a) && (c.addr.b === '$' || n <= Number(c.addr.b)))) continue;
        }
        if (c.op === 's') { const nl = line.replace(c.re, c.rep); if (nl !== line && c.p) { out.push(nl); printed = true; } line = nl; }
        else if (c.op === 'd') { del = true; break; }
        else if (c.op === 'p') { out.push(line); }
        else if (c.op === 'a') { if (!quiet) { out.push(line); printed = true; } out.push(c.arg.replace(/^\\/, '')); del = true; }
        else if (c.op === 'i') out.push(c.arg.replace(/^\\/, ''));
        else if (c.op === 'q') { if (!quiet) out.push(line); return out.push('\0QUIT'); }
      }
      if (!del && !quiet) out.push(line);
      void printed;
    });
    const q = out.indexOf('\0QUIT');
    const res = q >= 0 ? out.slice(0, q) : out;
    return res.length ? res.join('\n') + '\n' : '';
  }
  // jq mínimo
  function runJq(filter, input) {
    const splitTop = (s, sep) => {
      const parts = []; let cur = '', depth = 0, q = false;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' && s[i - 1] !== '\\') q = !q;
        if (!q && '([{'.includes(ch)) depth++;
        if (!q && ')]}'.includes(ch)) depth--;
        if (!q && !depth && s.startsWith(sep, i)) { parts.push(cur); cur = ''; i += sep.length - 1; continue; }
        cur += ch;
      }
      parts.push(cur);
      return parts.map((x) => x.trim());
    };
    const evalOne = (f, v) => {
      f = f.trim();
      if (f === '.' || f === '') return [v];
      if (f === 'keys') return [U.isObj(v) ? Object.keys(v).sort() : Array.isArray(v) ? v.map((_, i) => i) : []];
      if (f === 'length') return [v === null ? 0 : Array.isArray(v) || typeof v === 'string' ? v.length : U.isObj(v) ? Object.keys(v).length : Math.abs(v)];
      if (f === 'to_entries') return [Object.entries(v || {}).map(([key, value]) => ({ key, value }))];
      if (f === 'tostring') return [typeof v === 'string' ? v : JSON.stringify(v)];
      if (f === 'type') return [v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v];
      if (f === 'add') return [Array.isArray(v) ? v.reduce((a, b) => (a === null ? b : a + b), null) : null];
      if (/^"(.*)"$/.test(f)) return [JSON.parse(f)];
      if (/^-?\d+(\.\d+)?$/.test(f)) return [Number(f)];
      if (f === 'true' || f === 'false' || f === 'null') return [JSON.parse(f)];
      let m;
      if ((m = f.match(/^select\((.*)\)$/))) return evalOne(m[1], v).some((x) => x !== false && x !== null) ? [v] : [];
      if ((m = f.match(/^map\((.*)\)$/))) return [(Array.isArray(v) ? v : Object.values(v || {})).flatMap((x) => run(m[1], x))];
      if ((m = f.match(/^has\("(.*)"\)$/))) return [!!v && Object.prototype.hasOwnProperty.call(v, m[1])];
      if ((m = f.match(/^test\("(.*)"\)$/))) return [new RegExp(m[1]).test(String(v))];
      if ((m = f.match(/^startswith\("(.*)"\)$/))) return [String(v).startsWith(m[1])];
      if ((m = f.match(/^\[(.*)\]$/s)) && !f.startsWith('[.') ) return [run(m[1], v)];
      if ((m = f.match(/^\{(.*)\}$/s))) {
        const o = {};
        for (const kv of splitTop(m[1], ',')) {
          const i = kv.indexOf(':');
          if (i < 0) { const k = kv.replace(/^\./, ''); o[k] = v ? v[k] : null; continue; }
          o[kv.slice(0, i).trim().replace(/^"|"$/g, '')] = run(kv.slice(i + 1), v)[0];
        }
        return [o];
      }
      const cmp = splitTop(f, ' == ');
      if (cmp.length === 2) return [JSON.stringify(run(cmp[0], v)[0]) === JSON.stringify(run(cmp[1], v)[0])];
      const ne = splitTop(f, ' != ');
      if (ne.length === 2) return [JSON.stringify(run(ne[0], v)[0]) !== JSON.stringify(run(ne[1], v)[0])];
      const and = splitTop(f, ' and ');
      if (and.length === 2) return [!!run(and[0], v)[0] && !!run(and[1], v)[0]];
      const plus = splitTop(f, ' + ');
      if (plus.length === 2) { const a = run(plus[0], v)[0], b = run(plus[1], v)[0]; return [typeof a === 'string' || typeof b === 'string' ? String(a ?? '') + String(b ?? '') : (a || 0) + (b || 0)]; }
      // caminho
      if (f.startsWith('.')) {
        let vals = [v];
        const re = /\.([A-Za-z_$][\w$-]*)|\.?\["([^"]+)"\]|\.?\[(-?\d+)?\]|\.?\[(-?\d*):(-?\d*)\]/g;
        let pos = 0, mm;
        const steps = [];
        while ((mm = re.exec(f))) {
          if (mm.index !== pos) break;
          steps.push(mm);
          pos = re.lastIndex;
        }
        if (pos !== f.length && !(f[pos] === '?' && pos === f.length - 1)) throw new Error(`jq: error: syntax error, unexpected INVALID_CHARACTER at <top-level>, line 1:\n${f}`);
        for (const st of steps) {
          const next = [];
          for (const x of vals) {
            if (st[1] !== undefined || st[2] !== undefined) {
              const k = st[1] ?? st[2];
              if (x !== null && x !== undefined && typeof x !== 'object') throw new Error(`jq: error (at <stdin>:0): Cannot index ${typeof x} with "${k}"`);
              next.push(x == null ? null : x[k] === undefined ? null : x[k]);
            } else if (st[0].includes(':')) next.push(Array.isArray(x) ? x.slice(st[4] ? Number(st[4]) : 0, st[5] ? Number(st[5]) : undefined) : null);
            else if (st[3] !== undefined) next.push(Array.isArray(x) ? x[Number(st[3]) < 0 ? x.length + Number(st[3]) : Number(st[3])] ?? null : null);
            else {
              if (Array.isArray(x)) next.push(...x);
              else if (U.isObj(x)) next.push(...Object.values(x));
              else throw new Error(`jq: error (at <stdin>:0): Cannot iterate over ${x === null ? 'null' : typeof x}`);
            }
          }
          vals = next;
        }
        return vals;
      }
      throw new Error(`jq: error: ${f}/0 is not defined at <top-level>, line 1:\n${f}`);
    };
    const run = (f, v) => {
      const pipes = splitTop(f, '|');
      let vals = [v];
      for (const p of pipes) {
        const commas = splitTop(p, ',');
        vals = vals.flatMap((x) => commas.flatMap((c) => evalOne(c, x)));
      }
      return vals;
    };
    return run(filter, input);
  }
  const COMMON = {
    echo(argv, io) {
      let a = argv.slice(1), nl = true, esc = false;
      while (a[0] && /^-[neE]+$/.test(a[0])) { if (a[0].includes('n')) nl = false; if (a[0].includes('e')) esc = true; a = a.slice(1); }
      let s = a.join(' ');
      if (esc) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\e\[/g, '\x1b[').replace(/\\033\[/g, '\x1b[').replace(/\\\\/g, '\\');
      io.out(s + (nl ? '\n' : ''));
      return 0;
    },
    printf(argv, io) {
      const fmt = argv[1] || '';
      const args = argv.slice(2);
      let i = 0, out = '';
      do {
        out += fmt.replace(/%(-?\d*)(?:\.(\d+))?([sdfqxb%])/g, (m, w, prec, t) => {
          if (t === '%') return '%';
          const v = args[i++] ?? '';
          let s = t === 'd' ? String(parseInt(v) || 0) : t === 'f' ? (parseFloat(v) || 0).toFixed(prec ? Number(prec) : 6) : t === 'x' ? (parseInt(v) || 0).toString(16) : t === 'q' ? SH.quote(v) : String(v);
          if (t === 'b') s = s.replace(/\\n/g, '\n');
          return w ? (w.startsWith('-') ? s.padEnd(Math.abs(w)) : s.padStart(Number(w))) : s;
        }).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\e/g, '\x1b');
      } while (i < args.length && /%[sdfqxb]/.test(fmt));
      io.out(out);
      return 0;
    },
    true: () => 0,
    false: () => 1,
    ':': () => 0,
    async cat(argv, io) {
      const { pos, flags } = getopts(argv.slice(1));
      const ins = await readInputs(this, pos, io, 'cat');
      for (const f of ins) {
        let t = f.text;
        if (flags.n) t = splitLines(t).map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n') + '\n';
        io.out(t);
      }
      return ins.err ? 1 : 0;
    },
    async grep(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['e', 'A', 'B', 'C', 'm', 'color', 'colour']);
      let pat = flags.e;
      const files = pos.slice();
      if (pat === undefined) pat = files.shift();
      if (pat === undefined) { io.err('Usage: grep [OPTION]... PATTERNS [FILE]...\nTry \'grep --help\' for more information.\n'); return 2; }
      let re;
      try { re = toRegex(pat, { E: flags.E || argv[0] === 'egrep', F: flags.F, i: flags.i, w: flags.w, x: flags.x }); } catch (e) { io.err(`grep: Invalid regular expression\n`); return 2; }
      let count = 0, anyMatch = false;
      const multi = files.length > 1 || flags.r;
      const after = parseNum(flags.A ?? flags.C) || 0, before = parseNum(flags.B ?? flags.C) || 0;
      const max = parseNum(flags.m);
      const doLines = async (name, lines) => {
        let n = 0, lastPrinted = -1, afterLeft = 0;
        const buf = [];
        count = 0;
        for await (const line of lines) {
          n++;
          const m = re.test(line) !== !!flags.v;
          if (m) {
            anyMatch = true;
            count++;
            if (flags.q) return true;
            if (flags.l) { io.out(name + '\n'); return false; }
            if (!flags.c) {
              for (const b of buf) if (b.n > lastPrinted) io.out(`${multi ? name + (flags.n ? ':' : '-') : ''}${flags.n ? b.n + '-' : ''}${b.l}\n`);
              buf.length = 0;
              if (flags.o && !flags.v) { const g = new RegExp(re.source, re.flags + 'g'); for (const mm of line.match(g) || []) io.out(`${multi ? name + ':' : ''}${flags.n ? n + ':' : ''}${mm}\n`); }
              else io.out(`${multi ? name + ':' : ''}${flags.n ? n + ':' : ''}${line}\n`);
              lastPrinted = n;
            }
            afterLeft = after;
            if (max && count >= max) break;
          } else {
            if (afterLeft > 0 && !flags.c) { io.out(`${multi ? name + '-' : ''}${flags.n ? n + '-' : ''}${line}\n`); lastPrinted = n; afterLeft--; }
            else if (before) { buf.push({ n, l: line }); if (buf.length > before) buf.shift(); }
          }
        }
        if (flags.c) io.out(`${multi ? name + ':' : ''}${count}\n`);
        return false;
      };
      if (!files.length) { await doLines('(standard input)', stdinLines(io.stdin, io.signal)); }
      else {
        const list = [];
        for (const f of files) {
          if (this.fs.isDir(f) && this.fs.read(f) === null) {
            if (!flags.r && !flags.R) { io.err(`grep: ${f}: Is a directory\n`); continue; }
            for (const [rel, t] of Object.entries(this.fs.walk(f))) list.push({ name: f.replace(/\/$/, '') + '/' + rel, text: t });
            continue;
          }
          const t = this.fs.read(f);
          if (t === null) { if (!flags.s) io.err(`grep: ${f}: No such file or directory\n`); continue; }
          list.push({ name: f, text: t });
        }
        for (const it of list) if (await doLines(it.name, splitLines(it.text))) break;
      }
      return anyMatch ? 0 : 1;
    },
    async head(argv, io) {
      const a = argv.slice(1).map((x) => (/^-\d+$/.test(x) ? ['-n', x.slice(1)] : [x])).flat();
      const { flags, pos } = getopts(a, ['n', 'c']);
      const n = flags.n !== undefined ? parseInt(flags.n) : 10;
      if (flags.c !== undefined) { const t = (await readInputs(this, pos, io, 'head'))[0]; io.out((t ? t.text : '').slice(0, Number(flags.c))); return 0; }
      if (!pos.length) {
        let i = 0;
        const all = [];
        for await (const l of stdinLines(io.stdin, io.signal)) {
          if (n >= 0) { if (i++ < n) io.out(l + '\n'); else if (io.stdin instanceof Pipe) break; }
          else all.push(l);
        }
        if (n < 0) io.out(all.slice(0, n).map((l) => l + '\n').join(''));
        return 0;
      }
      const ins = await readInputs(this, pos, io, 'head');
      ins.forEach((f, i) => { if (ins.length > 1) io.out(`${i ? '\n' : ''}==> ${f.name} <==\n`); const ls = splitLines(f.text); io.out((n >= 0 ? ls.slice(0, n) : ls.slice(0, n)).map((l) => l + '\n').join('')); });
      return 0;
    },
    async tail(argv, io) {
      const a = argv.slice(1).map((x) => (/^-\d+$/.test(x) ? ['-n', x.slice(1)] : [x])).flat();
      const { flags, pos } = getopts(a, ['n', 'c']);
      const spec = flags.n !== undefined ? String(flags.n) : '10';
      const ins = await readInputs(this, pos, io, 'tail');
      for (const f of ins) {
        const ls = splitLines(f.text);
        const sel = spec.startsWith('+') ? ls.slice(Number(spec.slice(1)) - 1) : ls.slice(-Number(spec) || ls.length);
        io.out((Number(spec) === 0 ? [] : sel).map((l) => l + '\n').join(''));
      }
      if (flags.f) { while (!(io.signal && io.signal.aborted)) await new Promise((r) => setTimeout(r, 200)); return 130; }
      return 0;
    },
    async wc(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      const ins = await readInputs(this, pos, io, 'wc');
      const fmt = (t, name) => {
        const l = (t.match(/\n/g) || []).length, w = t.split(/\s+/).filter(Boolean).length, c = new TextEncoder().encode(t).length;
        const parts = [];
        if (flags.l) parts.push(l);
        if (flags.w) parts.push(w);
        if (flags.c || flags.m) parts.push(c);
        if (!parts.length) parts.push(l, w, c);
        const w0 = pos.length || parts.length > 1 ? 7 : 0;
        return parts.map((x) => String(x).padStart(parts.length > 1 || pos.length ? w0 : 0)).join(' ') + (name && name !== '-' ? ' ' + name : '');
      };
      for (const f of ins) io.out(fmt(f.text, f.name).trimStart().replace(/^/, pos.length || !(flags.l || flags.w || flags.c) ? '' : '') + '\n');
      return 0;
    },
    async sort(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['k', 't']);
      const ins = await readInputs(this, pos, io, 'sort');
      let lines = ins.flatMap((f) => splitLines(f.text));
      const key = (l) => {
        if (!flags.k) return l;
        const [start] = String(flags.k).split(',');
        const [fi, ch] = start.split('.');
        const fields = flags.t ? l.split(flags.t) : l.trim().split(/\s+/);
        let v = fields[Number(fi.replace(/\D.*$/, '')) - 1] ?? '';
        if (ch) v = v.slice(Number(ch) - 1);
        return v;
      };
      const num = flags.n || /n/.test(String(flags.k || '')), hum = flags.h;
      const hv = (s) => U.parseQuantity(String(s).replace(/([KMGT])$/, '$1i').replace(/B$/, '')) || parseFloat(s) || 0;
      lines.sort((a, b) => {
        const x = key(a), y = key(b);
        if (hum) return hv(x) - hv(y);
        if (num) return (parseFloat(x) || 0) - (parseFloat(y) || 0);
        return flags.f ? x.toLowerCase().localeCompare(y.toLowerCase()) : x < y ? -1 : x > y ? 1 : 0;
      });
      if (flags.r) lines.reverse();
      if (flags.u) lines = lines.filter((l, i) => i === 0 || key(l) !== key(lines[i - 1]));
      io.out(lines.map((l) => l + '\n').join(''));
      return 0;
    },
    async uniq(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      const ins = await readInputs(this, pos.slice(0, 1), io, 'uniq');
      const lines = ins.flatMap((f) => splitLines(f.text));
      const groups = [];
      for (const l of lines) { const g = groups[groups.length - 1]; if (g && (flags.i ? g.l.toLowerCase() === l.toLowerCase() : g.l === l)) g.n++; else groups.push({ l, n: 1 }); }
      for (const g of groups) {
        if (flags.d && g.n < 2) continue;
        if (flags.u && g.n > 1) continue;
        io.out(flags.c ? `${String(g.n).padStart(7)} ${g.l}\n` : g.l + '\n');
      }
      return 0;
    },
    async cut(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['d', 'f', 'c']);
      const ranges = (spec) => spec.split(',').map((r) => { const [a, b] = r.split('-'); return [a ? Number(a) : 1, r.includes('-') ? (b ? Number(b) : Infinity) : Number(a)]; });
      const inR = (i, rs) => rs.some(([a, b]) => i >= a && i <= b);
      const proc = (l) => {
        if (flags.c) return [...l].filter((_, i) => inR(i + 1, ranges(flags.c))).join('');
        if (!flags.f) return l;
        const d = flags.d ?? '\t';
        if (!l.includes(d)) return flags.s ? null : l;
        return l.split(d).filter((_, i) => inR(i + 1, ranges(flags.f))).join(d);
      };
      if (!flags.f && !flags.c) { io.err('cut: you must specify a list of bytes, characters, or fields\n'); return 1; }
      if (!pos.length) { for await (const l of stdinLines(io.stdin, io.signal)) { const r = proc(l); if (r !== null) io.out(r + '\n'); } return 0; }
      for (const f of await readInputs(this, pos, io, 'cut')) for (const l of splitLines(f.text)) { const r = proc(l); if (r !== null) io.out(r + '\n'); }
      return 0;
    },
    async tr(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      const exp = (s) => {
        s = (s || '').replace(/\[:upper:\]/g, 'A-Z').replace(/\[:lower:\]/g, 'a-z').replace(/\[:digit:\]/g, '0-9').replace(/\[:space:\]/g, ' \t\n').replace(/\[:alpha:\]/g, 'a-zA-Z').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        let out = '';
        for (let i = 0; i < s.length; i++) {
          if (s[i + 1] === '-' && s[i + 2]) { for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out += String.fromCharCode(c); i += 2; }
          else out += s[i];
        }
        return out;
      };
      const a = exp(pos[0]), b = exp(pos[1]);
      const t = await readAll(io.stdin);
      let r;
      if (flags.d) r = [...t].filter((ch) => !a.includes(ch)).join('');
      else if (b) r = [...t].map((ch) => { const i = a.indexOf(ch); return i < 0 ? ch : b[Math.min(i, b.length - 1)]; }).join('');
      else r = t;
      if (flags.s) { const set = b || a; r = r.replace(new RegExp(`([${set.replace(/[\]\\^-]/g, '\\$&')}])\\1+`, 'g'), '$1'); }
      io.out(r);
      return 0;
    },
    async sed(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['e']);
      const scripts = flags.e ? [flags.e] : [pos.shift()];
      if (!scripts[0]) { io.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n'); return 1; }
      if (flags.i) {
        for (const f of pos) { const t = this.fs.read(f); if (t === null) { io.err(`sed: can't read ${f}: No such file or directory\n`); return 2; } this.fs.write(f, runSed(scripts, t, flags.n)); }
        return 0;
      }
      if (!pos.length && io.stdin instanceof Pipe) {
        for await (const l of stdinLines(io.stdin, io.signal)) io.out(runSed(scripts, l + '\n', flags.n));
        return 0;
      }
      const ins = await readInputs(this, pos, io, 'sed');
      io.out(runSed(scripts, ins.map((f) => f.text).join(''), flags.n));
      return ins.err ? 2 : 0;
    },
    async awk(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['F', 'v']);
      const prog = pos.shift();
      if (!prog) { io.err('usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]\n'); return 2; }
      const vars = {};
      if (flags.v) { const [k, v] = String(flags.v).split('='); vars[k] = v; }
      const FS = flags.F === undefined ? ' ' : flags.F === 't' ? '\t' : flags.F.replace(/^\\t$/, '\t');
      try {
        if (!pos.length && io.stdin instanceof Pipe && !/END/.test(prog)) { for await (const l of stdinLines(io.stdin, io.signal)) runAwk(prog, [l], FS, io.out, vars); return 0; }
        const ins = await readInputs(this, pos, io, 'awk');
        runAwk(prog, ins.flatMap((f) => splitLines(f.text)), FS, io.out, vars);
      } catch (e) { io.err(`awk: syntax error: ${e.message}\n`); return 2; }
      return 0;
    },
    async tee(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      const t = await readAll(io.stdin);
      for (const f of pos) { try { this.fs.write(f, (flags.a ? this.fs.read(f) || '' : '') + t); } catch (e) { io.err(`tee: ${f}: ${e.message}\n`); } }
      io.out(t);
      return 0;
    },
    async base64(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['w']);
      const t = pos.length ? this.fs.read(pos[0]) : await readAll(io.stdin);
      if (t === null) { io.err(`base64: ${pos[0]}: No such file or directory\n`); return 1; }
      if (flags.d || flags.decode) {
        try { io.out(U.b64d(t.replace(/\s/g, ''))); } catch (e) { io.err('base64: invalid input\n'); return 1; }
      } else {
        const enc = U.b64e(t);
        const w = flags.w !== undefined ? Number(flags.w) : 76;
        io.out((w ? enc.match(new RegExp(`.{1,${w}}`, 'g')) || [''] : [enc]).join('\n') + '\n');
      }
      return 0;
    },
    async seq(argv, io) {
      const n = argv.slice(1).filter((x) => !x.startsWith('-') || /^-\d/.test(x)).map(Number);
      const [s, st, e] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : n;
      let o = '';
      for (let x = s; st > 0 ? x <= e : x >= e; x += st) { o += x + '\n'; if (o.length > 2e5) break; }
      io.out(o);
      return 0;
    },
    expr(argv, io) {
      const a = argv.slice(1);
      if (a[1] === ':' ) { const m = String(a[0]).match(new RegExp('^' + a[2])); io.out((m ? (m[1] ?? m[0].length) : 0) + '\n'); return m ? 0 : 1; }
      try { const r = SH.evalArith(a.join(' ').replace(/\\\*/g, '*'), (n) => this.getVar(n)); io.out(r + '\n'); return r === '0' ? 1 : 0; } catch (e) { io.err('expr: syntax error\n'); return 2; }
    },
    async sleep(argv, io) {
      let total = 0;
      for (const x of argv.slice(1)) {
        if (x === 'infinity') total = Infinity;
        const m = x.match(/^(\d*\.?\d+)([smhd]?)$/);
        if (!m && x !== 'infinity') { io.err(`sleep: invalid time interval '${x}'\nTry 'sleep --help' for more information.\n`); return 1; }
        if (m) total += parseFloat(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
      }
      if (!argv[1]) { io.err('sleep: missing operand\n'); return 1; }
      const end = Date.now() + total * 1000;
      while (Date.now() < end) {
        if (io.signal && io.signal.aborted) throw new Aborted();
        await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
      }
      return 0;
    },
    date(argv, io) {
      const now = Date.now();
      const f = argv.find((x) => x.startsWith('+'));
      const d = new Date(now);
      const p2 = (n) => String(n).padStart(2, '0');
      const utc = argv.includes('-u') || true;
      void utc;
      if (argv.includes('-Iseconds') || argv.includes('--iso-8601=seconds')) { io.out(d.toISOString().replace(/\.\d+Z$/, '+00:00') + '\n'); return 0; }
      if (f) {
        io.out(f.slice(1).replace(/%s/g, String(Math.floor(now / 1000))).replace(/%T/g, `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`).replace(/%F/g, d.toISOString().slice(0, 10)).replace(/%H/g, p2(d.getUTCHours())).replace(/%M/g, p2(d.getUTCMinutes())).replace(/%S/g, p2(d.getUTCSeconds())).replace(/%Y/g, d.getUTCFullYear()).replace(/%m/g, p2(d.getUTCMonth() + 1)).replace(/%d/g, p2(d.getUTCDate())).replace(/%N/g, String(d.getUTCMilliseconds()).padEnd(9, '0')) + '\n');
      } else io.out(U.dateCmd(now) + '\n');
      return 0;
    },
    test(argv, io) {
      let a = argv.slice(1);
      if (argv[0] === '[' || argv[0] === '[[') { if (a[a.length - 1] !== (argv[0] === '[' ? ']' : ']]')) { io.err(`${this.shellName}: ${argv[0]}: missing \`]'\n`); return 2; } a = a.slice(0, -1); }
      const one = (x) => {
        if (!x.length) return false;
        if (x[0] === '!') return !one(x.slice(1));
        const oi = x.findIndex((t, i) => i > 0 && (t === '-a' || t === '&&' || t === '-o' || t === '||'));
        if (oi > 0) { const l = one(x.slice(0, oi)), r = one(x.slice(oi + 1)); return x[oi] === '-a' || x[oi] === '&&' ? l && r : l || r; }
        if (x.length === 1) return x[0] !== '';
        if (x.length === 2) {
          const [op, v] = x;
          switch (op) {
            case '-z': return v === '';
            case '-n': return v !== '';
            case '-f': return this.fs.read(v) !== null;
            case '-e': return this.fs.exists(v);
            case '-d': return this.fs.isDir(v) && this.fs.read(v) === null;
            case '-s': return (this.fs.read(v) || '').length > 0;
            case '-r': case '-w': case '-x': return this.fs.exists(v);
          }
        }
        const [l, op, r] = x;
        switch (op) {
          case '=': case '==': return argv[0] === '[[' ? SH.globToRegex(r).test(l) : l === r;
          case '!=': return l !== r;
          case '=~': return new RegExp(r).test(l);
          case '-eq': return +l === +r;
          case '-ne': return +l !== +r;
          case '-gt': return +l > +r;
          case '-lt': return +l < +r;
          case '-ge': return +l >= +r;
          case '-le': return +l <= +r;
          case '<': return l < r;
          case '>': return l > r;
        }
        return false;
      };
      return one(a) ? 0 : 1;
    },
    pwd(argv, io) { io.out(this.fs.cwd() + '\n'); return 0; },
    cd(argv, io) {
      let t = argv[1] || this.vars.HOME || '/';
      if (t === '-') t = this.vars.OLDPWD || this.fs.cwd();
      const a = this.fs.abs(t);
      if (!this.fs.isDir(a)) { io.err(`${this.shellName}: cd: ${argv[1]}: ${this.fs.exists(a) ? 'Not a directory' : 'No such file or directory'}\n`); return 1; }
      this.vars.OLDPWD = this.fs.cwd();
      this.fs.cwdPath = a;
      return 0;
    },
    ls(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      const targets = pos.length ? pos : ['.'];
      let st = 0;
      targets.forEach((t, idx) => {
        if (!this.fs.exists(t)) { io.err(`ls: cannot access '${t}': No such file or directory\n`); st = 2; return; }
        if (this.fs.read(t) !== null && !(this.fs.isDir(t) && this.fs.read(t) === '')) {
          const c = this.fs.read(t);
          io.out(flags.l ? `-rw-r--r-- 1 root root ${String(new TextEncoder().encode(c).length).padStart(5)} ${new Date().toUTCString().slice(8, 11)} ${String(new Date().getUTCDate()).padStart(2)} ${new Date().toISOString().slice(11, 16)} ${t}\n` : t + '\n');
          return;
        }
        let names = this.fs.list(t);
        if (!flags.a && !flags.A) names = names.filter((n) => !n.startsWith('.'));
        else if (flags.a) names = ['./', '../', ...names];
        if (targets.length > 1) io.out(`${idx ? '\n' : ''}${t}:\n`);
        if (flags.l) {
          if (!flags.d) io.out(`total ${names.length * 4}\n`);
          for (const n of names) {
            const isD = n.endsWith('/');
            const full = t.replace(/\/$/, '') + '/' + n.replace(/\/$/, '');
            const size = isD ? 4096 : new TextEncoder().encode(this.fs.read(full) || '').length;
            const d = new Date();
            io.out(`${isD ? 'drwxr-xr-x' : '-rw-r--r--'} ${isD ? 2 : 1} root root ${String(size).padStart(5)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 16)} ${isD ? '\x1b[1;34m' + n.replace(/\/$/, '') + '\x1b[0m' : n}\n`);
          }
        } else {
          const disp = names.map((n) => (n.endsWith('/') ? `\x1b[1;34m${n.replace(/\/$/, '')}\x1b[0m` : n));
          if (flags['1'] || io.piped) io.out(names.map((n) => n.replace(/\/$/, '')).join('\n') + (names.length ? '\n' : ''));
          else if (disp.length) io.out(disp.join('  ') + '\n');
        }
      });
      return st;
    },
    mkdir(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      for (const d of pos) {
        if (this.fs.exists(d) && !flags.p) { io.err(`mkdir: cannot create directory '${d}': File exists\n`); return 1; }
        if (this.fs.mkdirp) this.fs.mkdirp(this.fs.abs(d));
        else { try { this.fs.write(this.fs.abs(d) + '/', ''); } catch (e) { io.err(`mkdir: cannot create directory '${d}': ${e.message}\n`); return 1; } }
      }
      return 0;
    },
    rmdir(argv, io) { for (const d of argv.slice(1)) this.fs.rm(d, true); return 0; },
    rm(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      let st = 0;
      for (const f of pos) {
        let r;
        try { r = this.fs.rm(f, flags.r || flags.R); } catch (e) { io.err(`rm: cannot remove '${f}': ${e.message}\n`); st = 1; continue; }
        if (r === 'dir') { io.err(`rm: cannot remove '${f}': Is a directory\n`); st = 1; }
        else if (!r && !flags.f) { io.err(`rm: cannot remove '${f}': No such file or directory\n`); st = 1; }
      }
      return st;
    },
    touch(argv, io) {
      for (const f of argv.slice(1).filter((x) => !x.startsWith('-'))) {
        if (this.fs.read(f) === null) { try { this.fs.write(f, ''); } catch (e) { io.err(`touch: cannot touch '${f}': ${e.message}\n`); return 1; } }
      }
      return 0;
    },
    cp(argv, io) {
      const { flags, pos } = getopts(argv.slice(1));
      const dst = pos.pop();
      for (const s of pos) {
        if (this.fs.isDir(s) && this.fs.read(s) === null) {
          if (!flags.r && !flags.R && !flags.a) { io.err(`cp: -r not specified; omitting directory '${s}'\n`); return 1; }
          const base = this.fs.isDir(dst) ? dst.replace(/\/$/, '') + '/' + s.split('/').filter(Boolean).pop() : dst;
          for (const [rel, c] of Object.entries(this.fs.walk(s))) this.fs.write(base + '/' + rel, c);
          continue;
        }
        const c = this.fs.read(s);
        if (c === null) { io.err(`cp: cannot stat '${s}': No such file or directory\n`); return 1; }
        const target = this.fs.isDir(dst) && this.fs.read(dst) === null ? dst.replace(/\/$/, '') + '/' + s.split('/').pop() : dst;
        this.fs.write(target, c);
      }
      return 0;
    },
    mv(argv, io) {
      const { pos } = getopts(argv.slice(1));
      const dst = pos.pop();
      for (const s of pos) {
        if (this.fs.isDir(s) && this.fs.read(s) === null) {
          const base = this.fs.isDir(dst) ? dst.replace(/\/$/, '') + '/' + s.split('/').filter(Boolean).pop() : dst;
          for (const [rel, c] of Object.entries(this.fs.walk(s))) this.fs.write(base + '/' + rel, c);
          this.fs.rm(s, true);
          continue;
        }
        const c = this.fs.read(s);
        if (c === null) { io.err(`mv: cannot stat '${s}': No such file or directory\n`); return 1; }
        const target = this.fs.isDir(dst) && this.fs.read(dst) === null ? dst.replace(/\/$/, '') + '/' + s.split('/').pop() : dst;
        this.fs.write(target, c);
        this.fs.rm(s);
      }
      return 0;
    },
    find(argv, io) {
      const a = argv.slice(1);
      const start = a[0] && !a[0].startsWith('-') ? a.shift() : '.';
      let name = null, type = null;
      for (let i = 0; i < a.length; i++) { if (a[i] === '-name' || a[i] === '-iname') name = SH.globToRegex(a[++i]); if (a[i] === '-type') type = a[++i]; }
      const base = start.replace(/\/$/, '');
      const out = [];
      if (type !== 'f' && (!name || name.test(base.split('/').pop()))) out.push(base);
      const walk = (dir) => {
        for (const n of this.fs.list(dir)) {
          const isD = n.endsWith('/');
          const p = dir.replace(/\/$/, '') + '/' + n.replace(/\/$/, '');
          if ((!type || (type === 'd' ? isD : !isD)) && (!name || name.test(n.replace(/\/$/, '')))) out.push(p);
          if (isD) walk(p);
        }
      };
      if (!this.fs.exists(start)) { io.err(`find: '${start}': No such file or directory\n`); return 1; }
      walk(start);
      io.out(out.map((x) => x + '\n').join(''));
      return 0;
    },
    basename(argv, io) { let b = (argv[1] || '').replace(/\/+$/, '').split('/').pop(); if (argv[2] && b.endsWith(argv[2])) b = b.slice(0, -argv[2].length); io.out(b + '\n'); return 0; },
    dirname(argv, io) { const p = (argv[1] || '').replace(/\/+$/, ''); io.out((p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : '.') + '\n'); return 0; },
    async jq(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['arg']);
      const filter = pos.shift() || '.';
      const txt = pos.length ? this.fs.read(pos[0]) : await readAll(io.stdin);
      if (txt === null) { io.err(`jq: error: Could not open ${pos[0]}: No such file or directory\n`); return 2; }
      const docs = [];
      try {
        const t = txt.trim();
        if (t) {
          let i = 0;
          while (i < t.length) {
            let depth = 0, q = false, j = i;
            for (; j < t.length; j++) { const ch = t[j]; if (q) { if (ch === '\\') j++; else if (ch === '"') q = false; continue; } if (ch === '"') q = true; else if (ch === '{' || ch === '[') depth++; else if (ch === '}' || ch === ']') { depth--; if (!depth) break; } }
            docs.push(JSON.parse(t.slice(i, j + 1)));
            i = j + 1;
            while (i < t.length && /\s/.test(t[i])) i++;
          }
        }
      } catch (e) { io.err(`jq: error (at <stdin>:1): Cannot parse input: ${e.message}\n`); return 2; }
      try {
        for (const d of docs) for (const r of runJq(filter, d)) io.out((flags.r && typeof r === 'string' ? r : flags.c ? JSON.stringify(r) : JSON.stringify(r, null, 2)) + '\n');
      } catch (e) { io.err(e.message + '\n'); return 5; }
      return 0;
    },
    async xargs(argv, io) {
      const { flags, pos } = getopts(argv.slice(1), ['I', 'n']);
      const input = (await readAll(io.stdin)).split(/\s+/).filter(Boolean);
      const cmd = pos.length ? pos : ['echo'];
      let st = 0;
      if (flags.I) { for (const it of input) st = await this.invoke(cmd.map((x) => x.split(flags.I).join(it)), { ...io, stdin: null }); return st; }
      const n = flags.n ? Number(flags.n) : input.length || 1;
      if (!input.length && flags.r) return 0;
      for (let i = 0; i < Math.max(1, input.length); i += n) st = await this.invoke([...cmd, ...input.slice(i, i + n)], { ...io, stdin: null });
      return st;
    },
    async column(argv, io) {
      const t = await readAll(io.stdin);
      io.out(U.tabwrite(splitLines(t).map((l) => l.trim().split(/\s+/).join('\t')).join('\n'), 0, 2) + '\n');
      return 0;
    },
    async diff(argv, io) {
      const { pos } = getopts(argv.slice(1));
      const a = this.fs.read(pos[0]), b = this.fs.read(pos[1]);
      if (a === null || b === null) { io.err(`diff: ${a === null ? pos[0] : pos[1]}: No such file or directory\n`); return 2; }
      const d = U.unifiedDiff(a.replace(/\n$/, ''), b.replace(/\n$/, ''));
      if (!d) return 0;
      io.out(`--- ${pos[0]}\n+++ ${pos[1]}\n${d}`);
      return 1;
    },
    yes: async (argv, io) => { for (let i = 0; i < 200; i++) io.out((argv.slice(1).join(' ') || 'y') + '\n'); return 0; },
    export(argv) {
      for (const kv of argv.slice(1)) {
        if (kv === '-p') continue;
        const i = kv.indexOf('=');
        if (i > 0) this.vars[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return 0;
    },
    unset(argv) { for (const k of argv.slice(1)) delete this.vars[k]; return 0; },
    env(argv, io) {
      if (argv.length > 1 && argv[1].includes('=')) {
        let i = 1; const ov = {};
        while (argv[i] && argv[i].includes('=')) { const [k, ...v] = argv[i].split('='); ov[k] = v.join('='); i++; }
        if (argv[i]) return this.invoke(argv.slice(i), io, ov);
      }
      io.out(Object.entries(this.vars).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/i.test(k) && k !== '$$').map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      return 0;
    },
    printenv(argv, io) {
      if (argv[1]) { const v = this.vars[argv[1]]; if (v === undefined) return 1; io.out(v + '\n'); return 0; }
      return COMMON.env.call(this, ['env'], io);
    },
    exit(argv) { throw new ShExit(argv[1] !== undefined ? parseInt(argv[1]) & 255 : this.last); },
    return(argv) { throw new ShExit(argv[1] !== undefined ? parseInt(argv[1]) : this.last); },
    break() { throw BREAK; },
    continue() { throw CONTINUE; },
    set: () => 0,
    trap: () => 0,
    shift: () => 0,
    wait: () => 0,
    read(argv, io) {
      const names = argv.slice(1).filter((x) => !x.startsWith('-'));
      const line = typeof io.stdin === 'string' ? io.stdin.split('\n')[0] : '';
      const parts = line.split(/\s+/);
      names.forEach((n, i) => (this.vars[n] = i === names.length - 1 ? parts.slice(i).join(' ') : parts[i] || ''));
      return line ? 0 : 1;
    },
    async source(argv, io) {
      const t = this.fs.read(argv[1] || '');
      if (t === null) { io.err(`${this.shellName}: ${argv[1]}: No such file or directory\n`); return 1; }
      return this.run(t, io);
    },
    type(argv, io) {
      let st = 0;
      for (const n of argv.slice(1)) {
        if (this.aliases[n]) io.out(`${n} is aliased to \`${this.aliases[n]}'\n`);
        else if (['cd', 'echo', 'export', 'exit', 'pwd', 'set', 'unset', 'type', 'alias', 'source', 'read', 'printf', 'test', 'true', 'false', 'kill', 'jobs', 'history'].includes(n)) io.out(`${n} is a shell builtin\n`);
        else if (this.hasCommand(n)) io.out(`${n} is /usr/bin/${n}\n`);
        else { io.err(`${this.shellName}: type: ${n}: not found\n`); st = 1; }
      }
      return st;
    },
    which(argv, io) {
      let st = 0;
      for (const n of argv.slice(1)) {
        if (this.hasCommand(n) && !['cd', 'export', 'exit', 'alias', 'source', 'set', 'unset'].includes(n)) io.out(`/usr/${['kubectl', 'curl', 'jq'].includes(n) ? 'local/bin' : 'bin'}/${n}\n`);
        else st = 1;
      }
      return st;
    },
    uname(argv, io) { io.out(argv.includes('-a') ? `Linux ${this.vars.HOSTNAME || 'sim-control-plane'} 6.10.14-linuxkit #1 SMP PREEMPT_DYNAMIC Fri Nov 29 17:24:06 UTC 2024 x86_64 GNU/Linux\n` : argv.includes('-r') ? '6.10.14-linuxkit\n' : argv.includes('-m') ? 'x86_64\n' : 'Linux\n'); return 0; },
    whoami(argv, io) { io.out('root\n'); return 0; },
    id(argv, io) { io.out('uid=0(root) gid=0(root) groups=0(root)\n'); return 0; },
    hostname(argv, io) { io.out((this.vars.HOSTNAME || 'sim-control-plane') + '\n'); return 0; },
  };
  COMMON['['] = COMMON.test;
  COMMON['[['] = COMMON.test;
  COMMON['.'] = COMMON.source;
  COMMON.egrep = COMMON.grep;
  KS.shellCommon = COMMON;
  KS.runJq = runJq;

  // ---------------- curl/wget (host e pod) ----------------
  const parseCurl = (argv) => {
    const o = { headers: {}, method: null, data: null, out: null, silent: false, include: false, head: false, verbose: false, url: null, write: null, fail: false, insecure: false, follow: false };
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      const next = () => argv[++i];
      if (a === '-H' || a === '--header') { const h = next(); const j = h.indexOf(':'); o.headers[h.slice(0, j).trim().toLowerCase()] = h.slice(j + 1).trim(); }
      else if (a === '-X' || a === '--request') o.method = next();
      else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') { o.data = next(); o.method = o.method || 'POST'; }
      else if (a === '-o' || a === '--output') o.out = next();
      else if (a === '-O' || a === '--remote-name') o.out = '__remote__';
      else if (a === '-w' || a === '--write-out') o.write = next();
      else if (a === '--cacert') { next(); o.insecure = true; }
      else if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '--cert' || a === '--key' || a === '-u' || a === '--user' || a === '-A' || a === '--user-agent') next();
      else if (a === '-I' || a === '--head') { o.head = true; o.method = 'HEAD'; }
      else if (a === '-i' || a === '--include') o.include = true;
      else if (a === '-v' || a === '--verbose') o.verbose = true;
      else if (a === '-k' || a === '--insecure') o.insecure = true;
      else if (a === '-L' || a === '--location') o.follow = true;
      else if (a === '-f' || a === '--fail') o.fail = true;
      else if (a === '-s' || a === '--silent') o.silent = true;
      else if (/^-[sSfLkivI]+$/.test(a)) { if (a.includes('s')) o.silent = true; if (a.includes('k')) o.insecure = true; if (a.includes('i')) o.include = true; if (a.includes('v')) o.verbose = true; if (a.includes('I')) { o.head = true; o.method = 'HEAD'; } if (a.includes('f')) o.fail = true; if (a.includes('L')) o.follow = true; }
      else if (!a.startsWith('-')) o.url = a;
    }
    return o;
  };
  const STATUS_TEXT = { 200: 'OK', 201: 'Created', 301: 'Moved Permanently', 302: 'Found', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity', 500: 'Internal Server Error', 503: 'Service Temporarily Unavailable' };
  const tokenIdentity = (cluster, token) => {
    if (!token) return { user: 'system:anonymous', groups: ['system:unauthenticated'] };
    try {
      const p = JSON.parse(U.b64d(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      const m = (p.sub || '').match(/^system:serviceaccount:([^:]+):(.+)$/);
      if (!m) return null;
      return { user: p.sub, groups: ['system:serviceaccounts', `system:serviceaccounts:${m[1]}`, 'system:authenticated'] };
    } catch (e) { return null; }
  };
  KS.tokenIdentity = tokenIdentity;
  // resposta para chamadas à API do Kubernetes feitas por curl
  const apiCall = (cluster, method, path, o, who) => {
    if (!who) return { status: 401, body: JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: 'Unauthorized', reason: 'Unauthorized', code: 401 }, null, 2) + '\n' };
    if (who.user === 'system:anonymous' && !/^\/(version|healthz|livez|readyz)/.test(path)) return { status: 403, body: JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: `forbidden: User "system:anonymous" cannot get path "${path.split('?')[0]}"`, reason: 'Forbidden', details: {}, code: 403 }, null, 2) + '\n' };
    let body = o.data;
    if (body) { try { body = JSON.parse(body); } catch (e) { try { body = globalThis.jsyaml.load(body); } catch (e2) { /* */ } } }
    const r = cluster.rest(method, path, body, who, { 'Content-Type': o.headers['content-type'] || '' });
    return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2) + '\n' };
  };
  KS.apiCall = apiCall;
  // executa curl/wget; network(url, o) -> {status, body, error, code, ...}
  async function curlLike(sh, argv, io, network, tool) {
    if (tool === 'wget') {
      const qi = argv.indexOf('-O');
      const quiet = argv.some((a) => /^-[a-zA-Z]*q/.test(a) && !a.startsWith('--'));
      const toStdout = argv.includes('-O-') || (qi >= 0 && argv[qi + 1] === '-') || argv.includes('-qO-') || argv.some((a) => /^-q?O-$/.test(a));
      const url = argv.slice(1).filter((a, i) => !a.startsWith('-') && !(argv[i] === '-O' || argv[i] === '-T')).pop();
      if (!url) { io.err('BusyBox v1.36.1 (2024-06-10 07:11:47 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]\n\t[--post-data STR | --post-file FILE] [-Y on/off]\n\t[-P DIR] [-U AGENT] [-T SEC] URL...\n'); return 1; }
      const host = url.replace(/^https?:\/\//, '').split(/[/:?]/)[0];
      const r = await network(url, { tool: 'wget', method: 'GET', headers: {} });
      if (r.delay) await COMMON.sleep.call(sh, ['sleep', String(r.delay / 1000)], io).catch(() => {});
      if (r.error) { io.err(r.error + '\n'); return 1; }
      if (!quiet) io.err(`Connecting to ${host}${r.ip ? ` (${r.ip}:${r.port})` : ''}\n`);
      if (r.status >= 400) { io.err(`wget: server returned error: HTTP/1.1 ${r.status} ${STATUS_TEXT[r.status] || ''}\n`); return 1; }
      if (toStdout) { if (!quiet) io.err('writing to stdout\n'); io.out(r.body); if (!quiet) io.err(`-                    100% |********************************|   ${r.body.length}  0:00:00 ETA\nwritten to stdout\n`); }
      else {
        const fname = qi >= 0 ? argv[qi + 1] : (url.split('?')[0].split('/').pop() || 'index.html').replace(/^$/, 'index.html') || 'index.html';
        sh.fs.write(url.split('/').length <= 3 && qi < 0 ? 'index.html' : fname, r.body);
        if (!quiet) io.err(`saving to '${qi >= 0 ? fname : 'index.html'}'\nindex.html           100% |********************************|   ${r.body.length}  0:00:00 ETA\n'index.html' saved\n`);
      }
      return 0;
    }
    const o = parseCurl(argv);
    if (!o.url) { io.err("curl: try 'curl --help' or 'curl --manual' for more information\n"); return 2; }
    const m = o.url.match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?/);
    const host = m ? m[2] : o.url;
    const port = m && m[3] ? m[3] : m && m[1] === 'https' ? 443 : 80;
    if (o.verbose) io.err(`* Host ${host}:${port} was resolved.\n*   Trying ${host}:${port}...\n`);
    const r = await network(o.url, { tool: 'curl', method: o.method || 'GET', headers: o.headers, data: o.data, insecure: o.insecure });
    if (r.delay) { try { await COMMON.sleep.call(sh, ['sleep', String(r.delay / 1000)], io); } catch (e) { throw e; } }
    if (r.error) { if (!o.silent || argv.includes('-S') || argv.some((a) => /^-[a-zA-Z]*S/.test(a))) io.err(r.error + '\n'); return r.code || 7; }
    if (r.tls && !o.insecure) { io.err('curl: (60) SSL certificate problem: unable to get local issuer certificate\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the webpage mentioned above.\n'); return 60; }
    if (o.verbose) io.err(`* Connected to ${host} (${r.ip || host}) port ${port}\n> ${o.method || 'GET'} ${o.url.replace(/^https?:\/\/[^/]+/, '') || '/'} HTTP/1.1\n> Host: ${host}${m && m[3] ? ':' + m[3] : ''}\n> User-Agent: curl/8.10.1\n> Accept: */*\n> \n< HTTP/1.1 ${r.status} ${STATUS_TEXT[r.status] || ''}\n< Content-Length: ${r.body.length}\n< \n`);
    const headers = `HTTP/1.1 ${r.status} ${STATUS_TEXT[r.status] || ''}\r\n${r.server ? `Server: ${r.server}\r\n` : ''}Date: ${new Date().toUTCString()}\r\nContent-Type: ${r.type || (r.body.trim().startsWith('{') ? 'application/json' : 'text/plain; charset=utf-8')}\r\nContent-Length: ${r.body.length}\r\n${r.location ? `Location: ${r.location}\r\n` : ''}\r\n`;
    if (o.fail && r.status >= 400) { if (!o.silent) io.err(`curl: (22) The requested URL returned error: ${r.status}\n`); return 22; }
    let text = o.head ? headers : (o.include ? headers : '') + r.body;
    if (o.out) { sh.fs.write(o.out === '__remote__' ? (o.url.split('/').pop() || 'index.html') : o.out, text); if (!o.silent) io.err(`  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n100  ${String(text.length).padStart(4)}  100  ${String(text.length).padStart(4)}    0     0   ${String(text.length * 40).padStart(5)}      0 --:--:-- --:--:-- --:--:-- ${String(text.length * 40).padStart(5)}\n`); text = ''; }
    if (o.write) text += o.write.replace(/%\{http_code\}/g, String(r.status)).replace(/%\{remote_ip\}/g, r.ip || '').replace(/%\{time_total\}/g, '0.004321').replace(/\\n/g, '\n');
    io.out(text);
    return 0;
  }

  // ---------------- openssl (simulado) ----------------
  const pemWrap = (label, body) => `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  const CA_KEY_MARK = 'SIMCAKEY';
  function openssl(sh, argv, io) {
    const sub = argv[1];
    const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
    const parseSubj = (s) => {
      const subj = { CN: '', O: [] };
      for (const part of String(s || '').split('/').filter(Boolean)) { const [k, v] = part.split('='); if (k === 'CN') subj.CN = v; else if (k === 'O') subj.O.push(v); }
      return subj;
    };
    const readSubject = (pem) => {
      try {
        const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
        const dec = U.b64d(body);
        const m = dec.match(/^SIM(?:SUBJECT|CERT):([^:]+):/);
        return m ? JSON.parse(U.b64d(m[1])) : null;
      } catch (e) { return null; }
    };
    const subjStr = (s) => `CN=${s.CN}${(s.O || []).map((o) => `, O=${o}`).join('')}`;
    switch (sub) {
      case 'genrsa': case 'genpkey': case 'ecparam': {
        const bits = argv.find((a) => /^\d{3,4}$/.test(a)) || '2048';
        const key = pemWrap('PRIVATE KEY', U.b64e('SIMKEY:' + U.hex(Number(bits) / 4)));
        const out = get('-out');
        if (out) sh.fs.write(out, key); else io.out(key);
        return 0;
      }
      case 'req': {
        const keyf = get('-key');
        if (keyf && sh.fs.read(keyf) === null) { io.err(`Could not open file or uri for loading private key from ${keyf}\n`); return 1; }
        const subj = parseSubj(get('-subj'));
        if (!subj.CN && !argv.includes('-x509')) { io.err('No subject given; use -subj "/CN=name/O=group"\n'); return 1; }
        let pem;
        if (argv.includes('-x509')) pem = pemWrap('CERTIFICATE', U.b64e('SIMCERT:' + U.b64e(JSON.stringify({ ...subj, untrusted: true })) + ':' + U.hex(200)));
        else pem = pemWrap('CERTIFICATE REQUEST', U.b64e('SIMSUBJECT:' + U.b64e(JSON.stringify(subj)) + ':' + U.hex(300)));
        const out = get('-out');
        if (argv.includes('-newkey') && get('-keyout')) sh.fs.write(get('-keyout'), pemWrap('PRIVATE KEY', U.b64e('SIMKEY:' + U.hex(512))));
        if (out) sh.fs.write(out, pem); else io.out(pem);
        return 0;
      }
      case 'x509': {
        const inf = get('-in');
        const pem = inf ? sh.fs.read(inf) : typeof io.stdin === 'string' ? io.stdin : '';
        if (pem === null) { io.err(`Could not open file or uri for loading ${argv.includes('-req') ? 'certificate request' : 'certificate'} from ${inf}\n`); return 1; }
        const subj = readSubject(pem || '');
        if (!subj) { io.err('Could not find certificate from <stdin>\n'); return 1; }
        if (argv.includes('-req')) {
          const cakey = get('-CAkey');
          const ck = cakey ? sh.fs.read(cakey) : null;
          const trusted = !!ck && U.b64d(ck.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')).startsWith(CA_KEY_MARK);
          const cert = pemWrap('CERTIFICATE', U.b64e('SIMCERT:' + U.b64e(JSON.stringify({ CN: subj.CN, O: subj.O || [], ...(trusted ? {} : { untrusted: true }) })) + ':' + U.hex(300)));
          io.err(`Certificate request self-signature ok\nsubject=${subjStr(subj)}\n`);
          const out = get('-out');
          if (out) sh.fs.write(out, cert); else io.out(cert);
          return 0;
        }
        if (argv.includes('-noout')) {
          if (argv.includes('-subject')) io.out(`subject=${subjStr(subj)}\n`);
          if (argv.includes('-issuer')) io.out('issuer=CN=kubernetes\n');
          if (argv.includes('-enddate')) io.out(`notAfter=${new Date(Date.now() + 365 * 86400e3).toUTCString().replace('GMT', 'GMT')}\n`);
          if (argv.includes('-text')) io.out(`Certificate:\n    Data:\n        Version: 3 (0x2)\n        Serial Number: ${U.hex(16)}\n        Signature Algorithm: sha256WithRSAEncryption\n        Issuer: CN=kubernetes\n        Validity\n            Not Before: ${new Date().toUTCString()}\n            Not After : ${new Date(Date.now() + 365 * 86400e3).toUTCString()}\n        Subject: ${subjStr(subj)}\n`);
          return 0;
        }
        io.out(pem);
        return 0;
      }
      case 'rand': {
        const n = Number(argv[argv.length - 1]) || 16;
        const bytes = U.hex(n * 2);
        io.out((argv.includes('-hex') ? bytes : U.b64e(bytes.slice(0, n))) + '\n');
        return 0;
      }
      case 'version': io.out('OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)\n'); return 0;
      default:
        io.err(`Invalid command '${sub || ''}'; type "help" for a list.\n`);
        return 1;
    }
  }
  KS.CA_KEY = pemWrap('RSA PRIVATE KEY', U.b64e(CA_KEY_MARK + ':' + 'a'.repeat(400)));

  // ---------------- shell do host ----------------
  class HostShell {
    constructor(opts) {
      this.cluster = opts.cluster;
      this.fs = opts.fs;
      this.term = opts.term; // {editor, interactive, readLine, clear, print}
      this.forwards = [];
      this.jobs = [];
      this.jobSeq = 0;
      this.history = opts.history || [];
      const vars = Object.assign({ HOME: '/root', USER: 'root', SHELL: '/bin/bash', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', TERM: 'xterm-256color', HOSTNAME: 'sim-control-plane', LANG: 'C.UTF-8', $$: String(1000 + Math.floor(Math.random() * 8000)) }, opts.vars || {});
      const self = this;
      const cmds = Object.assign({}, COMMON, {
        async kubectl(argv, io) { return self.kubectl(argv.slice(1), io, this.vars); },
        async curl(argv, io) { return curlLike(this, argv, io, (url, o) => self.hostNet(url, o), 'curl'); },
        async wget(argv, io) { return curlLike(this, argv, io, (url, o) => self.hostNet(url, o), 'wget'); },
        openssl(argv, io) { return openssl(this, argv, io); },
        clear() { self.term.clear(); return 0; },
        reset() { self.term.clear(); return 0; },
        history(argv, io) {
          if (argv[1] === '-c') { self.history.length = 0; return 0; }
          const n = argv[1] ? Number(argv[1]) : self.history.length;
          self.history.slice(-n).forEach((h, i, arr) => io.out(`${String(self.history.length - arr.length + i + 1).padStart(5)}  ${h}\n`));
          return 0;
        },
        alias(argv, io) {
          if (argv.length === 1) { for (const [k, v] of Object.entries(this.aliases)) io.out(`alias ${k}='${v}'\n`); return 0; }
          for (const a of argv.slice(1)) {
            const i = a.indexOf('=');
            if (i < 0) { if (this.aliases[a]) io.out(`alias ${a}='${this.aliases[a]}'\n`); else { io.err(`bash: alias: ${a}: not found\n`); return 1; } continue; }
            this.aliases[a.slice(0, i)] = a.slice(i + 1);
          }
          return 0;
        },
        unalias(argv) { for (const a of argv.slice(1)) delete this.aliases[a]; return 0; },
        jobs(argv, io) { for (const j of self.jobs) io.out(`[${j.id}]${j === self.jobs[self.jobs.length - 1] ? '+' : '-'}  ${j.done ? 'Done' : 'Running'}                 ${j.text} &\n`); return 0; },
        async kill(argv, io) {
          let st = 0;
          for (const a of argv.slice(1).filter((x) => !/^-\w+$/.test(x))) {
            const id = a.startsWith('%') ? Number(a.slice(1)) : null;
            const j = self.jobs.find((x) => x.id === id || x.pid === Number(a));
            if (!j) { io.err(`bash: kill: ${a}: no such job\n`); st = 1; continue; }
            j.signal.aborted = true;
          }
          await new Promise((r) => setTimeout(r, 150));
          return st;
        },
        async fg(argv, io) {
          const id = argv[1] ? Number(argv[1].replace('%', '')) : (self.jobs[self.jobs.length - 1] || {}).id;
          const j = self.jobs.find((x) => x.id === id);
          if (!j) { io.err(`bash: fg: ${argv[1] || 'current'}: no such job\n`); return 1; }
          io.out(j.text + '\n');
          const stop = setInterval(() => { if (io.signal && io.signal.aborted) j.signal.aborted = true; }, 100);
          try { return await j.promise; } finally { clearInterval(stop); }
        },
        async watch(argv, io) {
          let a = argv.slice(1), interval = 2;
          while (a[0] && a[0].startsWith('-')) { if (a[0] === '-n') { interval = Number(a[1]); a = a.slice(2); } else if (/^-n\d/.test(a[0])) { interval = Number(a[0].slice(2)); a = a.slice(1); } else a = a.slice(1); }
          const cmd = a.join(' ');
          if (!cmd) { io.err('Usage:\n watch [options] command\n'); return 1; }
          while (!(io.signal && io.signal.aborted)) {
            let buf = '';
            try { await this.run(cmd, { ...io, out: (s) => (buf += s), err: (s) => (buf += s) }); } catch (e) { if (e instanceof Aborted) break; buf += String(e.message) + '\n'; }
            self.term.clear();
            io.out(`Every ${interval.toFixed(1)}s: ${cmd}${' '.repeat(Math.max(2, 50 - cmd.length))}sim-control-plane: ${new Date().toString().slice(0, 24)}\n\n${buf}`);
            try { await COMMON.sleep.call(this, ['sleep', String(interval)], io); } catch (e) { break; }
          }
          return 0;
        },
        async vi(argv, io) { return self.editFile(argv[argv.length - 1], io); },
        async help(argv, io) { io.out(self.term.helpText ? self.term.helpText() : 'Use kubectl --help\n'); return 0; },
        async nslookup(argv, io) { io.err(`;; connection timed out; no servers could be reached\n\n`); io.out('Dica: nomes do cluster (ex.: nginx.default.svc.cluster.local) só resolvem de dentro de um pod. Use: kubectl run -it --rm dns --image=busybox:1.36 --restart=Never -- nslookup kubernetes.default\n'); return 1; },
        async ping(argv, io) { const h = argv[argv.length - 1]; io.out(`PING ${h} (${h}) 56(84) bytes of data.\n64 bytes from ${h}: icmp_seq=1 ttl=64 time=0.062 ms\n\n--- ${h} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss, time 0ms\n`); return 0; },
        uptime(argv, io) { io.out(` ${new Date().toTimeString().slice(0, 8)} up 47 min,  1 user,  load average: 0.42, 0.37, 0.31\n`); return 0; },
        async 'reset-cluster'(argv, io) { self.term.resetCluster && (await self.term.resetCluster()); return 0; },
        systemctl(argv, io) {
          if (argv[1] === 'status' && /kubelet/.test(argv[2] || '')) { io.out(`\x1b[32m●\x1b[0m kubelet.service - kubelet: The Kubernetes Node Agent\n     Loaded: loaded (/etc/systemd/system/kubelet.service; enabled; preset: enabled)\n    Drop-In: /etc/systemd/system/kubelet.service.d\n             └─10-kubeadm.conf, 11-kind.conf\n     Active: \x1b[32mactive (running)\x1b[0m since ${new Date(Date.now() - 2830e3).toUTCString()}; 47min ago\n       Docs: http://kubernetes.io/docs/\n   Main PID: 213 (kubelet)\n      Tasks: 16 (limit: 9261)\n     Memory: 48.2M\n`); return 0; }
          if (['restart', 'start', 'stop', 'enable', 'daemon-reload'].includes(argv[1])) return 0;
          io.err(`Unknown command verb ${argv[1] || ''}.\n`);
          return 1;
        },
        crictl(argv, io) {
          if (argv[1] === 'ps') {
            const rows = [['CONTAINER', 'IMAGE', 'CREATED', 'STATE', 'NAME', 'ATTEMPT', 'POD ID', 'POD']];
            for (const p of self.cluster.rawList(S.byId('pods'))) {
              if (p.spec.nodeName !== 'sim-control-plane') continue;
              for (const cs of p.status.containerStatuses || []) if (cs.state.running) rows.push([cs.containerID.slice(13, 26), cs.imageID.split('@sha256:')[1].slice(0, 13), U.age(cs.state.running.startedAt) + ' ago', 'Running', cs.name, String(cs.restartCount), p.metadata.uid.replace(/-/g, '').slice(0, 13), p.metadata.name]);
            }
            io.out(U.tabwrite(rows.map((r) => r.join('\t')).join('\n'), 0, 3) + '\n');
            return 0;
          }
          if (argv[1] === 'images') {
            io.out(U.tabwrite([['IMAGE', 'TAG', 'IMAGE ID', 'SIZE'], ...(self.cluster.nodeImages['sim-control-plane'] || []).map((i) => { const r = IM.parseRef(i); return [`${r.registry}/${r.path}`, r.tag || '<none>', IM.digest(i).slice(0, 13), (IM.profile(i).size).toFixed(1) + 'MB']; })].map((r) => r.join('\t')).join('\n'), 0, 3) + '\n');
            return 0;
          }
          io.err('Use: crictl ps | crictl images\n');
          return 1;
        },
      });
      cmds.k = cmds.kubectl;
      cmds.vim = cmds.vi;
      cmds.nano = cmds.vi;
      cmds.more = cmds.cat;
      cmds.less = cmds.cat;
      this.interp = new Interp({
        vars, fs: this.fs, commands: cmds, shellName: 'bash',
        aliases: Object.assign({ k: 'kubectl', ll: 'ls -l' }, opts.aliases || {}),
        onBackground: (ao, io) => this.startJob(ao, io),
      });
      this.interp.cluster = this.cluster;
    }
    get vars() { return this.interp.vars; }
    startJob(ao, io) {
      const id = ++this.jobSeq > 0 ? this.jobs.length + 1 : 1;
      const signal = { aborted: false };
      const job = { id, pid: 10000 + Math.floor(Math.random() * 20000), signal, text: this.lastLine ? this.lastLine.replace(/\s*&\s*$/, '') : '', done: false };
      job.promise = this.interp.execAndOr(ao, { ...io, signal, stdin: null }).catch((e) => (e instanceof ShExit ? e.code : e instanceof Aborted ? 130 : (io.err(String(e.message) + '\n'), 1))).then((code) => { job.done = true; job.code = code; return code; });
      this.jobs.push(job);
      io.out(`[${job.id}] ${job.pid}\n`);
    }
    reapJobs() {
      const done = this.jobs.filter((j) => j.done);
      let out = '';
      for (const j of done) out += `[${j.id}]${j === this.jobs[this.jobs.length - 1] ? '+' : '-'}  ${j.code === 0 ? 'Done' : j.code === 130 || j.signal.aborted ? 'Terminated' : `Exit ${j.code}`}                    ${j.text}\n`;
      this.jobs = this.jobs.filter((j) => !j.done);
      return out;
    }
    prompt() {
      const cwd = this.fs.cwd();
      const home = cwd === '/root' ? '~' : cwd.startsWith('/root/') ? '~' + cwd.slice(5) : cwd;
      return `\x1b[1;32mroot@sim-control-plane\x1b[0m:\x1b[1;34m${home}\x1b[0m# `;
    }
    async runLine(line, io) {
      this.lastLine = line;
      try {
        return await this.interp.run(line, io);
      } catch (e) {
        if (e instanceof ShExit) { io.out('logout\n'); io.err('\x1b[33m(o terminal do simulador não pode ser fechado; use "clear" para limpar a tela)\x1b[0m\n'); return e.code; }
        if (e instanceof Aborted) return 130;
        if (e instanceof SH.SyntaxError) { io.err(`bash: ${e.message}\n`); return 2; }
        throw e;
      }
    }
    async kubectl(args, io, vars) {
      const stdin = io.stdin !== null && io.stdin !== undefined ? await readAll(io.stdin) : null;
      return KS.kubectl.run(args, {
        cluster: this.cluster,
        fs: this.fs,
        vars: { ...vars },
        stdin,
        out: io.out,
        err: io.err,
        signal: io.signal || { aborted: false },
        editor: (path, content) => this.term.editor(path, content),
        interactive: (s) => this.term.interactive(s, io),
        readLine: (p) => this.term.readLine(p),
        confirmReopen: null,
        forwards: this.forwards,
      });
    }
    async editFile(path, io) {
      if (!path || path.startsWith('-')) { io.err('Informe um arquivo: vi <arquivo>\n'); return 1; }
      const cur = this.fs.read(path);
      if (this.fs.isDir(path) && cur === null) { io.err(`"${path}" is a directory\n`); return 1; }
      const res = await this.term.editor(this.fs.abs(path), cur ?? '');
      if (res !== null) this.fs.write(path, res);
      return 0;
    }
    // rede vista a partir da máquina do usuário (host do kind)
    async hostNet(url, o) {
      const m = String(url).match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?(.*)$/);
      if (!m) return { error: 'curl: (3) URL rejected: Malformed input to a URL function', code: 3 };
      const scheme = m[1] || 'http';
      const host = m[2];
      const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
      const path = m[4] || '/';
      if ((host === '127.0.0.1' || host === 'localhost') && port === 43127) {
        if (scheme !== 'https') return { status: 400, body: 'Client sent an HTTP request to an HTTPS server.\n' };
        const who = tokenIdentity(this.cluster, (o.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        const r = apiCall(this.cluster, o.method || 'GET', path, o, who);
        return { ...r, tls: !o.insecure, ip: '127.0.0.1', port };
      }
      if (host === 'localhost' || host === '127.0.0.1') {
        const fw = this.forwards.find((f) => f.local === port);
        if (fw && fw.proxy) {
          const r = apiCall(this.cluster, o.method || 'GET', path, o, fw.auth);
          return { ...r, ip: '127.0.0.1', port };
        }
        if (fw) {
          if (fw.onConnect) fw.onConnect();
          const cur = this.cluster.raw(S.byId('pods'), fw.pod.metadata.namespace, fw.pod.metadata.name);
          if (!cur) return { error: `curl: (52) Empty reply from server`, code: 52 };
          const r = this.cluster.http(`http://${this.cluster.rt[cur.metadata.uid].ip}:${fw.remote}${path}`, { method: o.method, tool: o.tool, fromPod: cur });
          return r.error ? { error: 'curl: (52) Empty reply from server', code: 52 } : { ...r, ip: '127.0.0.1', port };
        }
        if (port === 80 || port === 443) return this.cluster.ingressRoute(o.headers.host || 'localhost', path, o);
        return { error: `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`, code: 7 };
      }
      const res = this.cluster.resolve(host, null);
      if (res && (res.svc || res.pod) && !res.node) return { error: `curl: (28) Failed to connect to ${host} port ${port} after 133${Math.floor(Math.random() * 900)} ms: Couldn't connect to server`, code: 28, delay: 2000 };
      if (res && res.node && (port === 6443)) {
        const who = tokenIdentity(this.cluster, (o.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        return { ...apiCall(this.cluster, o.method || 'GET', path, o, who), tls: !o.insecure };
      }
      if (!res && !/\./.test(host)) return { error: `curl: (6) Could not resolve host: ${host}`, code: 6 };
      return this.cluster.http(url, { method: o.method, tool: o.tool, hostHeader: o.headers.host });
    }
  }
  KS.HostShell = HostShell;

  // ---------------- shell dentro de um container ----------------
  class PodShell {
    constructor(cluster, pod, cname, io) {
      this.cluster = cluster;
      this.pod = pod;
      this.cname = cname;
      this.io = io;
      this.fs = new PodFS(cluster, pod, cname);
      this.spec = this.fs.spec();
      this.prof = IM.profile(this.spec.image);
      const r = cluster.rt[pod.metadata.uid] || {};
      const rec = (r.cs || {})[cname] || (r.ics || {})[cname] || (r.ecs || {})[cname] || { runs: [{}] };
      this.run0 = rec.runs[rec.runs.length - 1] || {};
      this.installed = (this.run0.installed = this.run0.installed || []);
      const vars = Object.assign({ PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', TERM: 'xterm', SHLVL: '1' }, this.run0.env || {}, { HOSTNAME: pod.spec.hostname || pod.metadata.name });
      const self = this;
      const cmds = Object.assign({}, COMMON, {
        async curl(argv, io) { return curlLike(this, argv, io, (url, o) => self.podNet(url, o), 'curl'); },
        async wget(argv, io) { return curlLike(this, argv, io, (url, o) => self.podNet(url, o), 'wget'); },
        ps(argv, io) { io.out(self.psOutput()); return 0; },
        hostname(argv, io) { io.out((pod.spec.hostname || pod.metadata.name) + (argv.includes('-i') ? '' : '') + '\n'); if (argv.includes('-i')) io.out(''); return 0; },
        async nslookup(argv, io) { const name = argv.filter((a) => !a.startsWith('-')).slice(1)[0]; if (!name) { io.err('Usage: nslookup [-type=QUERY_TYPE] [-debug] HOST [DNS_SERVER]\n'); return 1; } const r = cluster.nslookup(name, pod); if (r.delay) await COMMON.sleep.call(this, ['sleep', String(r.delay / 1000)], io); io.out(r.out); return r.code; },
        async dig(argv, io) {
          const name = argv.filter((a) => !a.startsWith('-') && !a.startsWith('+') && !a.startsWith('@')).slice(1)[0] || '.';
          const r = cluster.resolve(name, pod.metadata.namespace);
          const short = argv.includes('+short');
          const fq = r && r.svc ? `${r.svc.metadata.name}.${r.svc.metadata.namespace}.svc.cluster.local.` : name + '.';
          if (short) { if (r && r.ip) io.out(r.ip + '\n'); return 0; }
          io.out(`\n; <<>> DiG 9.18.28 <<>> ${name}\n;; global options: +cmd\n;; Got answer:\n;; ->>HEADER<<- opcode: QUERY, status: ${r ? 'NOERROR' : 'NXDOMAIN'}, id: ${Math.floor(Math.random() * 65535)}\n;; flags: qr aa rd; QUERY: 1, ANSWER: ${r ? 1 : 0}, AUTHORITY: 0, ADDITIONAL: 1\n\n;; QUESTION SECTION:\n;${fq}\t\t\tIN\tA\n\n${r && r.ip ? `;; ANSWER SECTION:\n${fq}\t30\tIN\tA\t${r.ip}\n\n` : ''};; Query time: 0 msec\n;; SERVER: 10.96.0.10#53(10.96.0.10) (UDP)\n;; WHEN: ${new Date().toUTCString()}\n;; MSG SIZE  rcvd: 106\n\n`);
          return 0;
        },
        async ping(argv, io) {
          const h = argv.filter((a) => !a.startsWith('-') && !/^\d+$/.test(a)).slice(1)[0];
          const r = cluster.resolve(h, pod.metadata.namespace);
          if (!r || !r.ip) { io.err(`ping: bad address '${h}'\n`); return 1; }
          const cnt = argv.includes('-c') ? Number(argv[argv.indexOf('-c') + 1]) : 4;
          io.out(`PING ${h} (${r.ip}): 56 data bytes\n`);
          if (r.svc && !r.headless) { for (let i = 0; i < cnt; i++) { await COMMON.sleep.call(this, ['sleep', '1'], io); } io.out(`\n--- ${h} ping statistics ---\n${cnt} packets transmitted, 0 packets received, 100% packet loss\n`); return 1; }
          for (let i = 0; i < cnt; i++) { io.out(`64 bytes from ${r.ip}: seq=${i} ttl=${r.pod && r.pod.spec.nodeName === pod.spec.nodeName ? 64 : 62} time=0.${100 + Math.floor(Math.random() * 400)} ms\n`); await COMMON.sleep.call(this, ['sleep', '1'], io); }
          io.out(`\n--- ${h} ping statistics ---\n${cnt} packets transmitted, ${cnt} packets received, 0% packet loss\nround-trip min/avg/max = 0.101/0.204/0.412 ms\n`);
          return 0;
        },
        async nc(argv, io) {
          const a = argv.filter((x) => !x.startsWith('-'));
          const [host, port] = a.slice(1);
          if (!host) { io.err('BusyBox v1.36.1 multi-call binary.\n\nUsage: nc [OPTIONS] HOST PORT  - connect\n'); return 1; }
          const r = cluster.http(`http://${host}:${port}/`, { fromPod: pod, dry: true });
          if (r.error) { if (r.delay) await COMMON.sleep.call(this, ['sleep', '2'], io); io.err(`nc: ${host} (${r.ip || host}:${port}): ${r.code === 28 ? 'Connection timed out' : 'Connection refused'}\n`); return 1; }
          if (argv.includes('-z') || argv.includes('-zv') || argv.includes('-vz')) io.err(`${host} (${r.ip}:${port}) open\n`);
          return 0;
        },
        ip(argv, io) {
          const ip = (cluster.rt[pod.metadata.uid] || {}).ip;
          if (argv[1] === 'route' || argv[1] === 'r') io.out(`default via 10.244.${ip ? ip.split('.')[2] : 0}.1 dev eth0 \n10.244.${ip ? ip.split('.')[2] : 0}.0/24 dev eth0 scope link  src ${ip} \n`);
          else io.out(`1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n2: eth0@if${10 + Math.floor(U.seeded(pod.metadata.uid) * 20)}: <BROADCAST,MULTICAST,UP,LOWER_UP,M-DOWN> mtu 65535 qdisc noqueue state UP \n    link/ether ${U.hex(2)}:${U.hex(2)}:${U.hex(2)}:${U.hex(2)}:${U.hex(2)}:${U.hex(2)} brd ff:ff:ff:ff:ff:ff\n    inet ${ip}/24 brd ${ip ? ip.split('.').slice(0, 3).join('.') : ''}.255 scope global eth0\n       valid_lft forever preferred_lft forever\n`);
          return 0;
        },
        ifconfig(argv, io) { const ip = (cluster.rt[pod.metadata.uid] || {}).ip; io.out(`eth0      Link encap:Ethernet  HWaddr 1A:2B:3C:4D:5E:6F  \n          inet addr:${ip}  Bcast:0.0.0.0  Mask:255.255.255.0\n          UP BROADCAST RUNNING MULTICAST  MTU:65535  Metric:1\n\nlo        Link encap:Local Loopback  \n          inet addr:127.0.0.1  Mask:255.0.0.0\n          UP LOOPBACK RUNNING  MTU:65536  Metric:1\n\n`); return 0; },
        netstat(argv, io) {
          const l = cluster.containerListening ? (self.run0.listen || self.prof.ports || []) : [];
          io.out('Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State       \n' + l.map((p) => `tcp        0      0 0.0.0.0:${p}${' '.repeat(Math.max(1, 16 - String(p).length))}0.0.0.0:*               LISTEN      \n`).join(''));
          return 0;
        },
        df(argv, io) { io.out(`Filesystem           1K-blocks      Used Available Use% Mounted on\noverlay               61202244  18734592  39326768  32% /\ntmpfs                    65536         0     65536   0% /dev\n/dev/vda1             61202244  18734592  39326768  32% /etc/hosts\nshm                      65536         0     65536   0% /dev/shm\n` + ((self.spec.volumeMounts || []).map((m) => `tmpfs                  8024128        12   8024116   0% ${m.mountPath}\n`).join(''))); return 0; },
        mount(argv, io) { io.out(`overlay on / type overlay (rw,relatime)\nproc on /proc type proc (rw,nosuid,nodev,noexec,relatime)\ntmpfs on /dev type tmpfs (rw,nosuid,size=65536k,mode=755)\n` + (self.spec.volumeMounts || []).map((m) => `/dev/vda1 on ${m.mountPath} type ext4 (${m.readOnly ? 'ro' : 'rw'},relatime)\n`).join('')); return 0; },
        free(argv, io) { const m = argv.includes('-m'); const f = (x) => String(m ? Math.round(x / 1024) : x).padStart(12); io.out(`              total        used        free      shared  buff/cache   available\nMem:${f(8024128)}${f(2412032)}${f(3102716)}${f(4380)}${f(2509380)}${f(5389612)}\nSwap:${f(0)}${f(0)}${f(0)}\n`); return 0; },
        top(argv, io) { io.out(`Mem: 2412032K used, 5612096K free, 4380K shrd, 136172K buff, 2373208K cached\nCPU:   2% usr   1% sys   0% nic  96% idle   0% io   0% irq   0% sirq\nLoad average: 0.42 0.37 0.31 2/412 57\n${self.psOutput().replace('PID   USER     TIME  COMMAND', '  PID  PPID USER     STAT   VSZ %VSZ CPU %CPU COMMAND')}`); return 0; },
        async kill(argv, io) {
          const pid = argv.filter((a) => !a.startsWith('-')).slice(1)[0];
          if (pid === '1') {
            const r = cluster.rt[pod.metadata.uid];
            const rec = r && ((r.cs || {})[cname]);
            const run = rec && rec.runs[rec.runs.length - 1];
            if (run && rec.stage === 'running') { run.exitAt = cluster.now() + 100; run.code = argv.includes('-9') ? 137 : 143; }
            await new Promise((res) => setTimeout(res, 300));
            throw new ShExit(137);
          }
          return 0;
        },
        async 'apt-get'(argv, io) {
          if (argv[1] === 'update') { io.out(`Get:1 http://deb.debian.org/debian bookworm InRelease [151 kB]\nGet:2 http://deb.debian.org/debian bookworm-updates InRelease [55.4 kB]\nGet:3 http://deb.debian.org/debian-security bookworm-security InRelease [48.0 kB]\nGet:4 http://deb.debian.org/debian bookworm/main amd64 Packages [8792 kB]\nFetched 9046 kB in 2s (4523 kB/s)\nReading package lists... Done\n`); await COMMON.sleep.call(this, ['sleep', '1.5'], io); self.aptUpdated = true; return 0; }
          if (argv[1] === 'install') {
            const pkgs = argv.slice(2).filter((a) => !a.startsWith('-'));
            if (!self.aptUpdated && !self.installed.length) { io.out('Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\n'); io.err(`E: Unable to locate package ${pkgs[0]}\n`); return 100; }
            io.out(`Reading package lists... Done\nBuilding dependency tree... Done\nReading state information... Done\nThe following NEW packages will be installed:\n  ${pkgs.join(' ')}\n0 upgraded, ${pkgs.length} newly installed, 0 to remove and 0 not upgraded.\n`);
            await COMMON.sleep.call(this, ['sleep', '1.5'], io);
            for (const p of pkgs) { io.out(`Setting up ${p} ...\n`); self.addTools(p); }
            return 0;
          }
          io.err('E: Invalid operation ' + (argv[1] || '') + '\n');
          return 100;
        },
        async apk(argv, io) {
          if (argv[1] === 'update') { io.out(`fetch https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz\nfetch https://dl-cdn.alpinelinux.org/alpine/v3.20/community/x86_64/APKINDEX.tar.gz\nv3.20.3-137-g0a0f0f0 [https://dl-cdn.alpinelinux.org/alpine/v3.20/main]\nOK: 24164 distinct packages available\n`); return 0; }
          if (argv[1] === 'add') {
            const pkgs = argv.slice(2).filter((a) => !a.startsWith('-'));
            pkgs.forEach((p, i) => io.out(`(${i + 1}/${pkgs.length}) Installing ${p} (latest)\n`));
            await COMMON.sleep.call(this, ['sleep', '1'], io);
            io.out(`OK: 12 MiB in ${15 + pkgs.length} packages\n`);
            for (const p of pkgs) self.addTools(p);
            return 0;
          }
          io.err('apk-tools 2.14.4, compiled for x86_64.\n');
          return 1;
        },
        nginx(argv, io) {
          if (argv.includes('-t')) { io.err('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n'); return 0; }
          if (argv.includes('-v')) { io.err('nginx version: nginx/1.27.1\n'); return 0; }
          if (argv.includes('-s')) return 0;
          io.err('nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)\n');
          return 1;
        },
        'redis-cli'(argv, io) {
          const store = (self.run0.redis = self.run0.redis || {});
          const a = argv.slice(1).filter((x, i, arr) => !(x === '-h' || x === '-p' || arr[i - 1] === '-h' || arr[i - 1] === '-p'));
          if (!a.length) { io.out('127.0.0.1:6379> (modo interativo não suportado; use: redis-cli SET chave valor)\n'); return 0; }
          const [c, k, v] = [a[0].toUpperCase(), a[1], a[2]];
          if (!self.prof.logs || self.prof.logs !== 'redis') { io.err('Could not connect to Redis at 127.0.0.1:6379: Connection refused\n'); return 1; }
          switch (c) {
            case 'PING': io.out('PONG\n'); break;
            case 'SET': store[k] = v; io.out('OK\n'); break;
            case 'GET': io.out(store[k] === undefined ? '(nil)\n' : `"${store[k]}"\n`); break;
            case 'DEL': io.out(`(integer) ${k in store ? 1 : 0}\n`); delete store[k]; break;
            case 'INCR': store[k] = String((Number(store[k]) || 0) + 1); io.out(`(integer) ${store[k]}\n`); break;
            case 'KEYS': { const ks = Object.keys(store); io.out(ks.length ? ks.map((x, i) => `${i + 1}) "${x}"`).join('\n') + '\n' : '(empty array)\n'); break; }
            case 'DBSIZE': io.out(`(integer) ${Object.keys(store).length}\n`); break;
            case 'INFO': io.out('# Server\r\nredis_version:7.4.0\r\nredis_mode:standalone\r\nos:Linux 6.10.14-linuxkit x86_64\r\ntcp_port:6379\r\n'); break;
            default: io.out(`(error) ERR unknown command '${a[0]}', with args beginning with: ${a.slice(1).map((x) => `'${x}' `).join('')}\n`);
          }
          return 0;
        },
        env(argv, io) { io.out(Object.entries(this.vars).filter(([k]) => k !== '$$' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'); return 0; },
        python3(argv, io) {
          const ci = argv.indexOf('-c');
          if (ci >= 0) { for (const m of (argv[ci + 1] || '').matchAll(/print\((['"])(.*?)\1\)/g)) io.out(m[2] + '\n'); return 0; }
          if (argv.includes('--version') || argv.includes('-V')) { io.out('Python 3.12.6\n'); return 0; }
          io.out('Python 3.12.6 (main, Sep 27 2024, 06:10:08) [GCC 12.2.0] on linux\n(modo interativo não suportado neste simulador)\n');
          return 0;
        },
      });
      cmds.python = cmds.python3;
      cmds.printenv = function (argv, io) { if (argv[1]) { const v = this.vars[argv[1]]; if (v === undefined) return 1; io.out(v + '\n'); return 0; } return cmds.env.call(this, argv, io); };
      cmds.ss = cmds.netstat;
      cmds.more = cmds.cat;
      cmds.less = cmds.cat;
      cmds.vi = function (argv, io) { io.err('vi: não disponível dentro do container simulado; use echo/cat com redirecionamento (ex.: echo texto > arquivo)\n'); return 1; };
      cmds.vim = cmds.vi;
      cmds.nano = cmds.vi;
      cmds.clear = () => { if (io.clear) io.clear(); return 0; };
      const shellBins = ['sh', 'bash', 'ash', 'zsh', 'dash'];
      const builtinsAlways = new Set(['echo', 'printf', 'cd', 'pwd', 'export', 'unset', 'exit', 'return', 'true', 'false', ':', 'test', '[', '[[', 'set', 'trap', 'shift', 'wait', 'read', 'source', '.', 'type', 'kill', 'break', 'continue', 'alias', 'unalias', 'clear']);
      this.hasTool = (n) => builtinsAlways.has(n) || this.prof.tools.has(n) || this.installed.includes(n) || (shellBins.includes(n) && (this.prof.tools.has(n) || (n === 'sh' && !!this.prof.shell)));
      this.shellName = this.prof.shell === 'bash' ? 'bash' : this.prof.shell || 'sh';
      this.interp = new Interp({
        vars, fs: this.fs, commands: cmds, shellName: this.shellName,
        hasCommand: (n) => {
          if (!this.hasTool(n.split('/').pop())) return false;
          return !!cmds[n.split('/').pop()] || shellBins.includes(n.split('/').pop()) || this.prof.tools.has(n.split('/').pop());
        },
        notFoundFmt: (b) => (this.shellName === 'bash' ? `bash: ${b}: command not found\n` : `${this.shellName}: ${b}: not found\n`),
      });
      this.interp.cluster = cluster;
      // subshells: sh -c "..."
      for (const b of shellBins) cmds[b] = async function (argv, io2) {
        const ci = argv.indexOf('-c');
        if (ci >= 0) return this.run(argv[ci + 1] || '', io2);
        if (argv[1] && !argv[1].startsWith('-')) { const t = self.fs.read(argv[1]); if (t === null) { io2.err(`${b}: can't open '${argv[1]}': No such file or directory\n`); return 2; } return this.run(t, io2); }
        return 0;
      };
      // comandos presentes na imagem mas sem simulação detalhada
      cmds.__fallback = async function (argv, io2) { return 0; };
      this.ps = [{ pid: 1, cmd: this.mainCmd() }];
    }
    addTools(pkg) {
      const map = { curl: ['curl'], wget: ['wget'], dnsutils: ['nslookup', 'dig', 'host'], 'bind-tools': ['nslookup', 'dig', 'host'], iputils: ['ping'], 'iputils-ping': ['ping'], procps: ['ps', 'top', 'free', 'kill'], 'net-tools': ['netstat', 'ifconfig'], iproute2: ['ip', 'ss'], vim: ['vi', 'vim'], nano: ['nano'], netcat: ['nc'], 'netcat-openbsd': ['nc'], 'netcat-traditional': ['nc'], jq: ['jq'], less: ['less'], bash: ['bash'], python3: ['python3', 'python'] };
      for (const t of map[pkg] || [pkg]) if (!this.installed.includes(t)) this.installed.push(t);
      this.cluster.dirty = true;
    }
    mainCmd() {
      const argv = IM.effectiveArgv(this.prof, this.spec);
      if (argv) return argv.join(' ');
      switch (this.prof.logs) {
        case 'nginx': return 'nginx: master process nginx -g daemon off;';
        case 'redis': return 'redis-server *:6379';
        case 'postgres': return 'postgres';
        case 'httpd': return 'httpd -DFOREGROUND';
        default: return this.prof.shell || this.prof.ref.name;
      }
    }
    psOutput() {
      const rows = ['PID   USER     TIME  COMMAND'];
      const t = '0:00';
      rows.push(`    1 root      ${t} ${this.mainCmd()}`);
      if (this.prof.logs === 'nginx') for (let i = 0; i < 4; i++) rows.push(`   ${29 + i} nginx     ${t} nginx: worker process`);
      rows.push(`   ${40 + Math.floor(Math.random() * 5)} root      ${t} ${this.shellName}`);
      rows.push(`   ${50 + Math.floor(Math.random() * 9)} root      ${t} ps${this.prof.base === 'busybox' || this.prof.base === 'alpine' ? '' : ' aux'}`);
      if (this.prof.base !== 'busybox' && this.prof.base !== 'alpine') {
        return 'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n' + rows.slice(1).map((r) => { const m = r.trim().match(/^(\d+)\s+(\S+)\s+\S+\s+(.*)$/); return `${m[2].padEnd(8)} ${m[1].padStart(8)}  0.0  0.1  11400  7252 ?        Ss   ${new Date().toTimeString().slice(0, 5)}   0:00 ${m[3]}`; }).join('\n') + '\n';
      }
      return rows.join('\n') + '\n';
    }
    prompt() {
      const cwd = this.fs.cwd();
      const name = this.pod.spec.hostname || this.pod.metadata.name;
      if (this.shellName === 'bash') return `root@${name}:${cwd === '/root' ? '~' : cwd}# `;
      if (this.shellName === 'zsh') return `\x1b[31m ${name}\x1b[0m  ${cwd === '/root' ? '~' : cwd}  `;
      if (this.prof.base === 'busybox' || this.prof.base === 'alpine') return `${cwd === '/root' ? '~' : cwd} # `;
      return '# ';
    }
    alive() {
      const p = this.cluster.raw(S.byId('pods'), this.pod.metadata.namespace, this.pod.metadata.name);
      if (!p || p.metadata.uid !== this.pod.metadata.uid) return false;
      const st = [...(p.status.containerStatuses || []), ...(p.status.ephemeralContainerStatuses || []), ...(p.status.initContainerStatuses || [])].find((x) => x.name === this.cname);
      return !!(st && st.state.running);
    }
    // exec não interativo. Retorna código ou 'notfound'
    async execArgv(argv, stdin) {
      const bin = argv[0].split('/').pop();
      if (!this.hasTool(bin) && !(argv[0].startsWith('/') && this.prof.tools.has(bin))) return 'notfound';
      const io = { out: this.io.out, err: this.io.err, stdin: stdin || null, signal: this.io.signal };
      try {
        if (['sh', 'bash', 'ash', 'zsh', 'dash'].includes(bin)) {
          const ci = argv.indexOf('-c');
          if (ci >= 0) return await this.interp.run(argv[ci + 1] || '', io);
          if (stdin) return await this.interp.run(stdin, io);
          return 0;
        }
        return await this.interp.invoke(argv, io);
      } catch (e) {
        if (e instanceof ShExit) return e.code;
        if (e instanceof Aborted) return 130;
        if (e instanceof SH.SyntaxError || e.incomplete) { io.err(`${this.shellName}: syntax error: ${e.message}\n`); return 2; }
        throw e;
      }
    }
    // linha interativa: {code, exit}
    async runLine(line, io) {
      if (!this.alive()) return { exit: true, code: 137, lost: true };
      try {
        const code = await this.interp.run(line, io);
        return { code };
      } catch (e) {
        if (e instanceof ShExit) return { exit: true, code: e.code };
        if (e.incomplete) throw e;
        if (e instanceof SH.SyntaxError) { io.err(`${this.shellName}: syntax error: ${e.message.replace(/^syntax error /, '')}\n`); return { code: 2 }; }
        throw e;
      }
    }
    async podNet(url, o) {
      const m = String(url).match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?(.*)$/);
      const host = m ? m[2] : '';
      const port = m && m[3] ? Number(m[3]) : m && m[1] === 'https' ? 443 : 80;
      const path = (m && m[4]) || '/';
      const apiHosts = ['kubernetes', 'kubernetes.default', 'kubernetes.default.svc', 'kubernetes.default.svc.cluster.local', '10.96.0.1'];
      if (apiHosts.includes(host) && port === 443) {
        if (!this.cluster.dnsAllowed(this.pod) && !/^\d/.test(host)) return { error: `curl: (6) Could not resolve host: ${host}`, code: 6, delay: 5000 };
        const who = tokenIdentity(this.cluster, (o.headers.authorization || '').replace(/^Bearer\s+/i, ''));
        const r = apiCall(this.cluster, o.method || 'GET', path, o, who);
        return { ...r, tls: !o.insecure && !o.headers.__cacert, ip: '10.96.0.1', port };
      }
      const r = this.cluster.http(url, { fromPod: this.cluster.raw(S.byId('pods'), this.pod.metadata.namespace, this.pod.metadata.name) || this.pod, method: o.method, tool: o.tool });
      return r;
    }
  }
  KS.PodShell = PodShell;
})();

// ---------------- sistema de arquivos inicial e pods estáticos ----------------
(function () {
  const KS = globalThis.KS;
  const U = KS.util, PR = KS.printers, S = KS.schema;
  const pem = (label, body) => `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  KS.adminCert = () => pem('CERTIFICATE', U.b64e('SIMCERT:' + U.b64e(JSON.stringify({ CN: 'kubernetes-admin', O: ['kubeadm:cluster-admins'] })) + ':' + 'f3a1'.repeat(80)));
  KS.kubeconfigYAML = (server, name) => PR.yaml({
    apiVersion: 'v1',
    clusters: [{ cluster: { 'certificate-authority-data': U.b64e(KS.CA_CRT), server }, name }],
    contexts: [{ context: { cluster: name, user: name }, name }],
    'current-context': name,
    kind: 'Config',
    preferences: {},
    users: [{ name, user: { 'client-certificate-data': U.b64e(KS.adminCert()), 'client-key-data': U.b64e(pem('RSA PRIVATE KEY', U.b64e('SIMKEY:' + 'b2'.repeat(300)))) } }],
  });
  const staticFile = (sp) => {
    const comp = sp.metadata.labels.component;
    const m = U.clone(sp);
    delete m.file;
    m.metadata = { creationTimestamp: null, labels: m.metadata.labels, name: comp, namespace: 'kube-system', ...(m.metadata.annotations && Object.keys(m.metadata.annotations).some((k) => k.startsWith('kubeadm')) ? { annotations: Object.fromEntries(Object.entries(m.metadata.annotations).filter(([k]) => k.startsWith('kubeadm'))) } : {}) };
    delete m.spec.nodeName;
    delete m.spec.automountServiceAccountToken;
    delete m.spec.enableServiceLinks;
    m.status = {};
    return PR.yaml(m);
  };
  KS.bootstrapFS = (vfs, cluster) => {
    vfs.write('/root/.kube/config', KS.kubeconfigYAML(KS.kubectl.SERVER, 'kind-sim'));
    vfs.write('/etc/kubernetes/admin.conf', KS.kubeconfigYAML('https://sim-control-plane:6443', 'sim'));
    vfs.write('/etc/kubernetes/pki/ca.crt', KS.CA_CRT);
    vfs.write('/etc/kubernetes/pki/ca.key', KS.CA_KEY);
    for (const sp of cluster.misc.staticPods || []) {
      const comp = sp.metadata.labels.component;
      sp.file = `/etc/kubernetes/manifests/${comp}.yaml`;
      vfs.write(sp.file, staticFile(sp));
    }
    for (const [f, c] of Object.entries(KS.examples.files)) vfs.write('/root/examples/' + f, c);
    vfs.write('/root/.bashrc', "alias k=kubectl\nexport KUBE_EDITOR=vi\n");
    vfs.cwdPath = '/root';
  };
  // Mudanças em /etc/kubernetes/manifests refletem nos pods estáticos (como o kubelet faz)
  KS.attachStaticPodSync = (vfs, cluster) => {
    vfs.onWrite = (path, content) => {
      if (!path.startsWith('/etc/kubernetes/manifests/')) return;
      if (!/\.(ya?ml|json)$/.test(path)) return;
      const list = (cluster.misc.staticPods = cluster.misc.staticPods || []);
      const idx = list.findIndex((x) => x.file === path);
      const old = idx >= 0 ? list[idx] : null;
      const pT = S.byId('pods');
      const dropOld = () => {
        if (!old) return;
        const p = cluster.raw(pT, old.metadata.namespace, old.metadata.name);
        if (p) cluster.removeRaw(pT, p);
      };
      if (content === null) {
        dropOld();
        if (idx >= 0) list.splice(idx, 1);
        cluster.dirty = true;
        return;
      }
      let obj = null;
      try { obj = PR.parseYAMLDocs(content)[0]; } catch (e) { obj = null; }
      dropOld();
      if (idx >= 0) list.splice(idx, 1);
      if (!obj || obj.kind !== 'Pod' || !obj.metadata || !obj.metadata.name || !obj.spec || !(obj.spec.containers || []).length) { cluster.dirty = true; return; }
      const sp = {
        apiVersion: 'v1', kind: 'Pod', file: path,
        metadata: { name: `${obj.metadata.name}-sim-control-plane`, namespace: obj.metadata.namespace || 'kube-system', labels: obj.metadata.labels || {}, annotations: { ...(obj.metadata.annotations || {}), 'kubernetes.io/config.hash': U.hex(32), 'kubernetes.io/config.mirror': U.hex(32), 'kubernetes.io/config.seen': new Date().toISOString(), 'kubernetes.io/config.source': 'file' } },
        spec: { ...obj.spec, nodeName: 'sim-control-plane', automountServiceAccountToken: false },
      };
      list.push(sp);
      cluster.misc['static' + sp.metadata.name] = cluster.now();
      cluster.dirty = true;
    };
  };
})();
