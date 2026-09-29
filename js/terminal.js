// Interface: terminal, editor, painel do cluster e persistência.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, S = KS.schema;
  const STORE_KEY = 'ks-state-v1';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------- ANSI -> HTML ----------------
  function ansiToHtml(text, state) {
    let out = '';
    const re = /\x1b\[([0-9;]*)m/g;
    let last = 0, m;
    const open = () => {
      const cls = [];
      if (state.bold) cls.push('b');
      if (state.dim) cls.push('dim');
      if (state.fg !== null && state.fg !== undefined) cls.push('c' + state.fg);
      return cls.length ? `<span class="${cls.join(' ')}">` : '<span>';
    };
    const push = (s) => { if (s) out += open() + esc(s) + '</span>'; };
    while ((m = re.exec(text))) {
      push(text.slice(last, m.index));
      for (const code of (m[1] || '0').split(';').map(Number)) {
        if (code === 0) { state.bold = false; state.dim = false; state.fg = null; }
        else if (code === 1) state.bold = true;
        else if (code === 2) state.dim = true;
        else if (code >= 30 && code <= 37) state.fg = code - 30;
        else if (code >= 90 && code <= 97) state.fg = code - 90;
        else if (code === 39) state.fg = null;
      }
      last = re.lastIndex;
    }
    push(text.slice(last));
    return out;
  }

  // ---------------- Terminal ----------------
  class Terminal {
    constructor() {
      this.screen = $('#screen');
      this.inputLine = $('#input-line');
      this.promptEl = $('#prompt');
      this.input = $('#cmd');
      this.ansi = {};
      this.history = [];
      this.hIdx = -1;
      this.pending = '';
      this.busy = false;
      this.signal = null;
      this.sessions = [];
      this.lineWaiter = null;
      this.curLine = null;
      this.load();
      this.bind();
    }
    load() {
      let st = null;
      try { st = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { st = null; }
      try {
        if (st && st.cluster) {
          this.cluster = new KS.Cluster(st.cluster);
          this.vfs = new KS.VFS(st.fs);
          this.history = st.history || [];
          this.restored = true;
        }
      } catch (e) { this.cluster = null; st = null; }
      if (!this.cluster) {
        this.cluster = new KS.Cluster();
        this.vfs = new KS.VFS();
        KS.bootstrapFS(this.vfs, this.cluster);
      }
      KS.attachStaticPodSync(this.vfs, this.cluster);
      this.shell = new KS.HostShell({ cluster: this.cluster, fs: this.vfs, term: this, history: this.history, aliases: st && st.aliases });
    }
    save() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ cluster: this.cluster.serialize(), fs: this.vfs.serialize(), history: this.history.slice(-500), aliases: this.shell.interp.aliases }));
      } catch (e) { /* armazenamento indisponível: segue em memória */ }
    }
    async resetCluster() {
      this.noSave = true;
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* */ }
      location.reload();
    }
    // ---------- saída ----------
    write(text) {
      if (!text) return;
      const parts = String(text).split('\n');
      parts.forEach((p, i) => {
        if (!this.curLine) { this.curLine = document.createElement('div'); this.curLine.className = 'ln'; this.screen.appendChild(this.curLine); }
        if (p) this.curLine.insertAdjacentHTML('beforeend', ansiToHtml(p.replace(/\r/g, ''), this.ansi));
        if (i < parts.length - 1) { if (!this.curLine.innerHTML) this.curLine.innerHTML = '&#8203;'; this.curLine = null; }
      });
      while (this.screen.childElementCount > 4000) this.screen.firstChild.remove();
      this.scroll();
    }
    clear() { this.screen.innerHTML = ''; this.curLine = null; }
    scroll() { const w = $('#term'); w.scrollTop = w.scrollHeight; }
    echoLine(prompt, line) { this.write(prompt); this.write(line + '\n'); }
    currentPrompt() {
      if (this.lineWaiter) return this.lineWaiter.prompt;
      if (this.pending) return '> ';
      const s = this.sessions[this.sessions.length - 1];
      return s ? s.sh.prompt() : this.shell.prompt();
    }
    showInput() {
      if (this.curLine && this.curLine.innerHTML) { this.curLine = null; }
      this.promptEl.innerHTML = ansiToHtml(this.currentPrompt(), {});
      this.inputLine.hidden = false;
      this.input.focus({ preventScroll: true });
      this.scroll();
    }
    hideInput() { this.inputLine.hidden = true; }
    // ---------- API usada pelo shell/kubectl ----------
    readLine(prompt) {
      return new Promise((resolve) => {
        this.lineWaiter = { prompt, resolve };
        this.showInput();
      });
    }
    editor(path, content) { return KS.editor.open(path, content); }
    async interactive(s, io) {
      const sh = new KS.PodShell(this.cluster, s.pod, s.container, { out: (x) => this.write(x), err: (x) => this.write(x), signal: io.signal, clear: () => this.clear() });
      const argv = s.argv;
      const shells = ['sh', 'bash', 'ash', 'zsh', 'dash'];
      const isShell = argv && shells.includes(argv[0].split('/').pop()) && !argv.includes('-c');
      const execErr = (bin) => `error: Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${U.hex(64)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${bin}": executable file not found in $PATH: unknown\n`;
      if (argv && !isShell) {
        const code = await sh.execArgv(argv, '');
        if (code === 'notfound') { this.write(execErr(argv[0])); return 1; }
        if (code) this.write(`command terminated with exit code ${code}\n`);
        return code;
      }
      if (argv && !sh.hasTool(argv[0].split('/').pop())) { this.write(execErr(argv[0])); return 1; }
      if (!argv && !sh.prof.shell) { this.write('error: Unable to attach: container has no shell\n'); return 1; }
      return new Promise((resolve) => {
        this.sessions.push({ sh, resolve });
        this.busy = false;
        this.showInput();
      });
    }
    helpText() {
      return [
        '\x1b[1mSimulador de cluster Kubernetes v1.31\x1b[0m — 3 nós (sim-control-plane, sim-worker, sim-worker2)',
        '',
        'Este terminal é o nó de control plane e o kubectl já está configurado (contexto kind-sim).',
        'O shell aceita pipes, redirecionamentos, $(...), &&, ||, for/while, variáveis, aliases e jobs com &.',
        '',
        '\x1b[1mExperimente\x1b[0m',
        '  kubectl get nodes -o wide',
        '  kubectl apply -f examples/nginx-deployment.yaml',
        '  kubectl get pods -w                              (Ctrl+C para parar)',
        '  kubectl exec -it deploy/nginx-deployment -- bash',
        '  kubectl run -it --rm tmp --image=busybox:1.36 --restart=Never -- sh',
        '  kubectl port-forward svc/nginx 8080:80 &   e depois   curl localhost:8080',
        '  kubectl edit deploy nginx-deployment             (abre o editor; Ctrl+S salva)',
        '  vi /etc/kubernetes/manifests/kube-scheduler.yaml (pods estáticos do control plane)',
        '',
        '\x1b[1mArquivos\x1b[0m  ls examples/ · cat examples/hpa-demo.yaml · vi meu.yaml',
        '\x1b[1mAtalhos\x1b[0m   Tab completa · ↑/↓ histórico · Ctrl+C interrompe · Ctrl+L limpa · Ctrl+D sai do container',
        '\x1b[1mOutros\x1b[0m    curl, wget, jq, grep, awk, sed, watch, openssl, crictl · reset-cluster recria o cluster',
        '',
      ].join('\n') + '\n';
    }
    // ---------- execução ----------
    async submit(line) {
      if (this.lineWaiter) {
        const w = this.lineWaiter;
        this.lineWaiter = null;
        this.echoLine(w.prompt, line);
        this.hideInput();
        w.resolve(line);
        return;
      }
      const session = this.sessions[this.sessions.length - 1];
      const prompt = this.currentPrompt();
      this.echoLine(prompt, line);
      const src = this.pending ? this.pending + '\n' + line : line;
      if (!src.trim()) { this.pending = ''; this.showInput(); return; }
      try { KS.sh.parse(src); } catch (e) {
        if (e.incomplete) { this.pending = src; this.showInput(); return; }
      }
      this.pending = '';
      const h = src.replace(/\n/g, '\n');
      if (h.trim() && this.history[this.history.length - 1] !== h) this.history.push(h);
      this.hIdx = -1;
      this.hideInput();
      this.busy = true;
      this.signal = { aborted: false };
      const io = { out: (s) => this.write(s), err: (s) => this.write(s), stdin: null, signal: this.signal, clear: () => this.clear() };
      try {
        if (session) {
          session.sh.io.signal = this.signal;
          const r = await session.sh.runLine(src, io);
          if (r.exit) {
            this.sessions.pop();
            if (r.lost) this.write('command terminated with exit code 137\n');
            else if (r.code) this.write(`command terminated with exit code ${r.code}\n`);
            this.busy = true;
            session.resolve(r.code || 0);
            return; // o kubectl que abriu a sessão termina e reexibe o prompt do host
          }
        } else {
          await this.shell.runLine(src, io);
          const done = this.shell.reapJobs();
          if (done) this.write(done);
        }
      } catch (e) {
        if (e && e.incomplete) this.write(`bash: syntax error: unexpected end of file\n`);
        else {
          this.write(`\x1b[31merro interno do simulador: ${String((e && e.message) || e)}\x1b[0m\n`);
          if (globalThis.console) console.error(e);
        }
      }
      // se esta execução abriu uma sessão interativa, ela já mostrou o prompt
      if (!session && this.sessions.length) return;
      this.busy = false;
      if (!this.noSave) this.save();
      this.showInput();
    }
    interrupt() {
      if (this.lineWaiter) { const w = this.lineWaiter; this.lineWaiter = null; this.write(w.prompt + this.input.value + '^C\n'); this.input.value = ''; w.resolve(''); return; }
      if (this.busy && this.signal) { this.signal.aborted = true; this.write('^C\n'); return; }
      this.write(this.currentPrompt() + this.input.value + '^C\n');
      this.pending = '';
      this.input.value = '';
      this.showInput();
    }
    curNs() {
      try {
        const kc = globalThis.jsyaml.load(this.vfs.read('/root/.kube/config'));
        const ctx = (kc.contexts || []).find((c) => c.name === kc['current-context']);
        return (ctx && ctx.context && ctx.context.namespace) || 'default';
      } catch (e) { return 'default'; }
    }
    // ---------- autocompletar ----------
    complete() {
      const val = this.input.value;
      const caret = this.input.selectionStart;
      const before = val.slice(0, caret);
      const words = before.split(/\s+/);
      const cur = words[words.length - 1];
      const prev = words.slice(0, -1).filter(Boolean);
      let cands = [];
      const session = this.sessions[this.sessions.length - 1];
      const fsys = session ? session.sh.fs : this.vfs;
      const fileCands = () => {
        const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/') + 1) : '';
        try { return fsys.list(dir || '.').map((n) => dir + n); } catch (e) { return []; }
      };
      const isK = prev[0] === 'kubectl' || prev[0] === 'k';
      if (!prev.length) {
        cands = session ? [] : Object.keys(this.shell.interp.commands).filter((n) => !n.startsWith('__')).concat(Object.keys(this.shell.interp.aliases));
        if (cur.includes('/')) cands = fileCands();
      } else if (isK && !session) {
        const args = prev.slice(1).filter((a, i, arr) => !a.startsWith('-') && !['-n', '--namespace', '-o', '--output', '-f', '--filename', '-l', '-c', '--container'].includes(arr[i - 1]));
        const flagPrev = prev[prev.length - 1];
        const nsIdx = prev.findIndex((a) => a === '-n' || a === '--namespace');
        const ns = nsIdx >= 0 ? prev[nsIdx + 1] : this.curNs();
        const C = KS.kubectl.CMD;
        const def0 = C[args[0]];
        const def = def0 && def0.sub && args[1] && def0.sub[args[1]] ? def0.sub[args[1]] : def0;
        if (cur.startsWith('-')) cands = [...Object.keys({ ...((def && def.flags) || {}), namespace: 1, context: 1 }).map((f) => '--' + f), '-n', '-o', '-A', '-l', '-f', '-w'];
        else if (flagPrev === '-n' || flagPrev === '--namespace') cands = this.cluster.rawList(S.byId('namespaces')).map((n) => n.metadata.name);
        else if (flagPrev === '-o' || flagPrev === '--output') cands = ['yaml', 'json', 'wide', 'name', 'jsonpath=', 'custom-columns=', 'go-template='];
        else if (flagPrev === '-f' || flagPrev === '--filename') cands = fileCands();
        else if (flagPrev === '-c' || flagPrev === '--container') cands = [];
        else if (!args.length) cands = Object.keys(C);
        else if (def0 && def0.sub && Object.keys(def0.sub).length && args.length === 1) cands = Object.keys(def0.sub);
        else if (args[0] === 'config') {
          try { cands = (globalThis.jsyaml.load(this.vfs.read('/root/.kube/config')).contexts || []).map((c) => c.name); } catch (e) { cands = []; }
        } else {
          const rest = def0 && def0.sub && def0.sub[args[1]] ? args.slice(2) : args.slice(1);
          const podCmds = ['logs', 'exec', 'attach', 'port-forward', 'cp'];
          const nodeCmds = ['cordon', 'uncordon', 'drain'];
          if (cur.includes('/')) {
            const [tn, pre] = cur.split('/');
            const t = S.resolve(tn);
            if (t) cands = this.cluster.rawList(t, t.namespaced ? ns : null).map((o) => `${tn}/${o.metadata.name}`).filter((x) => x.startsWith(`${tn}/${pre}`));
          } else if (podCmds.includes(args[0]) || nodeCmds.includes(args[0]) || args[0] === 'top' || (args[0] === 'taint' && rest.length === 1)) {
            const t = nodeCmds.includes(args[0]) || args[0] === 'taint' || (args[0] === 'top' && /^no/.test(args[1] || '')) ? S.byId('nodes') : S.byId('pods');
            cands = this.cluster.rawList(t, t.namespaced ? ns : null).map((o) => o.metadata.name);
          } else if (!rest.length) cands = [...new Set(S.types.filter((t) => t.group !== 'metrics.k8s.io').flatMap((t) => [t.plural, ...t.short]))].sort();
          else {
            const t = S.resolve(rest[0].split(',')[0]);
            if (t) cands = this.cluster.rawList(t, t.namespaced ? ns : null).map((o) => o.metadata.name);
          }
        }
      } else cands = fileCands();
      const matches = [...new Set(cands)].filter((c) => c.startsWith(cur)).sort();
      if (!matches.length) return;
      let common = matches[0];
      for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
      if (matches.length === 1) common = matches[0] + (/[/=]$/.test(matches[0]) ? '' : ' ');
      if (common.length > cur.length) {
        this.input.value = before.slice(0, before.length - cur.length) + common + val.slice(caret);
        const p = before.length - cur.length + common.length;
        this.input.setSelectionRange(p, p);
      } else if (matches.length > 1) {
        this.echoLine(this.currentPrompt(), val);
        this.write(matches.slice(0, 300).join('   ') + '\n');
        this.showInput();
      }
    }
    // ---------- eventos ----------
    bind() {
      const inp = this.input;
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const v = inp.value; inp.value = ''; this.submit(v); return; }
        if (e.key === 'Tab') { e.preventDefault(); this.complete(); return; }
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { if (window.getSelection().toString()) return; e.preventDefault(); this.interrupt(); return; }
        if (e.ctrlKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); this.clear(); this.showInput(); return; }
        if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); if (!inp.value && this.sessions.length) this.submit('exit'); return; }
        if (e.ctrlKey && e.key === 'u') { e.preventDefault(); inp.value = inp.value.slice(inp.selectionStart); inp.setSelectionRange(0, 0); return; }
        if (e.ctrlKey && e.key === 'k') { e.preventDefault(); inp.value = inp.value.slice(0, inp.selectionStart); return; }
        if (e.ctrlKey && e.key === 'a') { e.preventDefault(); inp.setSelectionRange(0, 0); return; }
        if (e.ctrlKey && e.key === 'e') { e.preventDefault(); inp.setSelectionRange(inp.value.length, inp.value.length); return; }
        if (e.ctrlKey && e.key === 'w') { e.preventDefault(); const p = inp.selectionStart; const b = inp.value.slice(0, p).replace(/\S+\s*$/, ''); inp.value = b + inp.value.slice(p); inp.setSelectionRange(b.length, b.length); return; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          if (!this.history.length) return;
          if (e.key === 'ArrowUp') this.hIdx = this.hIdx < 0 ? this.history.length - 1 : Math.max(0, this.hIdx - 1);
          else if (this.hIdx >= 0) this.hIdx++;
          if (this.hIdx >= this.history.length) this.hIdx = -1;
          inp.value = this.hIdx < 0 ? '' : this.history[this.hIdx];
          inp.setSelectionRange(inp.value.length, inp.value.length);
        }
      });
      document.addEventListener('keydown', (e) => {
        if (KS.editor.isOpen()) return;
        if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && this.busy && !window.getSelection().toString()) { e.preventDefault(); this.interrupt(); }
      });
      $('#term').addEventListener('mouseup', () => { if (!window.getSelection().toString() && !this.inputLine.hidden) inp.focus({ preventScroll: true }); });
      inp.addEventListener('paste', (e) => {
        const t = (e.clipboardData || window.clipboardData).getData('text');
        if (!t.includes('\n')) return;
        e.preventDefault();
        const lines = t.replace(/\r/g, '').replace(/\n$/, '').split('\n');
        lines[0] = inp.value + lines[0];
        inp.value = '';
        (async () => {
          for (const l of lines) {
            while (this.busy && !this.sessions.length && !this.lineWaiter) await U.sleep(40);
            await this.submit(l);
          }
        })();
      });
    }
    insert(cmd) {
      if (this.inputLine.hidden) return;
      this.input.value = cmd;
      this.input.focus();
      this.input.setSelectionRange(cmd.length, cmd.length);
    }
  }

  // ---------------- Editor modal ----------------
  KS.editor = {
    open(path, content) {
      return new Promise((resolve) => {
        const dlg = $('#editor');
        const ta = $('#editor-text');
        $('#editor-file').textContent = path;
        ta.value = content;
        dlg.hidden = false;
        this._open = true;
        ta.focus();
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
        const done = (val) => {
          dlg.hidden = true;
          this._open = false;
          ta.removeEventListener('keydown', onKey);
          $('#editor-save').onclick = null;
          $('#editor-quit').onclick = null;
          $('#cmd').focus();
          resolve(val);
        };
        const onKey = (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); done(ta.value); }
          else if (e.key === 'Escape') { e.preventDefault(); done(null); }
          else if (e.key === 'Tab') {
            e.preventDefault();
            const s = ta.selectionStart;
            ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(ta.selectionEnd);
            ta.setSelectionRange(s + 2, s + 2);
          }
        };
        ta.addEventListener('keydown', onKey);
        $('#editor-save').onclick = () => done(ta.value);
        $('#editor-quit').onclick = () => done(null);
      });
    },
    isOpen() { return !!this._open; },
  };

  // ---------------- Painel do cluster ----------------
  class ClusterPanel {
    constructor(term) {
      this.term = term;
      this.cluster = term.cluster;
      this.el = $('#nodes');
      this.nsSel = $('#ns-filter');
      this.dirty = true;
      this.cluster.watch((type, t) => { if (t.id === 'pods' || t.id === 'nodes' || t.id === 'namespaces') this.dirty = true; });
      this.nsSel.addEventListener('change', () => { this.dirty = true; this.render(); });
      setInterval(() => this.render(), 700);
      setInterval(() => { this.dirty = true; }, 5000);
      this.el.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-pod]');
        if (chip) { term.insert(`kubectl describe pod ${chip.dataset.pod} -n ${chip.dataset.ns}`); return; }
        const node = e.target.closest('[data-node]');
        if (node && node.dataset.node) term.insert(`kubectl describe node ${node.dataset.node}`);
      });
    }
    render() {
      if (!this.dirty) return;
      this.dirty = false;
      const PR = KS.printers;
      const nss = this.cluster.rawList(S.byId('namespaces')).map((n) => n.metadata.name);
      const cur = this.nsSel.value || '__user';
      const opts = ['__user', '__all', ...nss];
      if (this.nsSel.options.length !== opts.length || [...this.nsSel.options].some((o, i) => o.value !== opts[i])) {
        this.nsSel.innerHTML = opts.map((n) => `<option value="${esc(n)}">${n === '__user' ? 'Aplicações' : n === '__all' ? 'Todos os namespaces' : esc(n)}</option>`).join('');
        this.nsSel.value = opts.includes(cur) ? cur : '__user';
      }
      const sel = this.nsSel.value;
      const sys = new Set(['kube-system', 'local-path-storage', 'ingress-nginx', 'kube-public', 'kube-node-lease']);
      const pods = this.cluster.rawList(S.byId('pods')).filter((p) => (sel === '__all' ? true : sel === '__user' ? !sys.has(p.metadata.namespace) : p.metadata.namespace === sel));
      const nodes = this.cluster.rawList(S.byId('nodes'));
      const statusOf = (p) => {
        const st = PR.podStatus(p);
        const s = st.status;
        const [r, t] = st.ready.split('/');
        if (p.metadata.deletionTimestamp) return ['term', s];
        if (s === 'Running' && r === t) return ['ok', s];
        if (s === 'Completed' || s === 'Succeeded') return ['done', s];
        if (/Err|BackOff|Error|Failed|OOM|Invalid|Unknown|ConfigError|Evicted/.test(s)) return ['bad', s];
        return ['wait', s];
      };
      const chip = (p) => {
        const [cls, s] = statusOf(p);
        return `<button type="button" class="pod ${cls}" data-pod="${esc(p.metadata.name)}" data-ns="${esc(p.metadata.namespace)}" title="${esc(p.metadata.namespace + '/' + p.metadata.name + ' · ' + s)}"><span class="dot" aria-hidden="true"></span><span class="pn">${esc(p.metadata.name)}</span><span class="ps">${esc(s)}</span></button>`;
      };
      let html = '';
      const counts = { ok: 0, wait: 0, bad: 0 };
      for (const p of pods) { const c = statusOf(p)[0]; if (c in counts) counts[c]++; }
      for (const n of nodes) {
        const mine = pods.filter((p) => p.spec.nodeName === n.metadata.name);
        const ready = PR.columnsFor(S.byId('nodes')).f(n)[1];
        const a = this.cluster.nodeAllocated(n.metadata.name);
        const cap = this.cluster.nodeCap(n);
        const cpuPct = Math.min(100, Math.round((a.cpu / cap.cpu) * 100));
        const memPct = Math.min(100, Math.round((a.mem / cap.mem) * 100));
        const role = n.metadata.labels['node-role.kubernetes.io/control-plane'] !== undefined ? 'control-plane' : 'worker';
        html += `<section class="node" data-node="${esc(n.metadata.name)}">
          <header><span class="nn">${esc(n.metadata.name)}</span><span class="role">${role}</span><span class="nstat ${ready === 'Ready' ? 'ok' : 'warn'}">${esc(ready)}</span></header>
          <div class="meters">
            <div class="meter" title="CPU solicitada (requests) / alocável"><span>cpu</span><b><i style="width:${cpuPct}%"></i></b><em>${cpuPct}%</em></div>
            <div class="meter" title="Memória solicitada (requests) / alocável"><span>mem</span><b><i style="width:${memPct}%"></i></b><em>${memPct}%</em></div>
          </div>
          <div class="pods">${mine.map(chip).join('') || '<span class="empty">nenhum pod neste filtro</span>'}</div>
        </section>`;
      }
      const pending = pods.filter((p) => !p.spec.nodeName);
      if (pending.length) html += `<section class="node pendingbox"><header><span class="nn">Aguardando agendamento</span><span class="nstat warn">${pending.length}</span></header><div class="pods">${pending.map(chip).join('')}</div></section>`;
      this.el.innerHTML = html;
      $('#summary').innerHTML = `<span class="sum ok">${counts.ok} prontos</span><span class="sum wait">${counts.wait} aguardando</span><span class="sum bad">${counts.bad} com erro</span>`;
      $('#ctx').textContent = `kind-sim · ns ${this.term.curNs()}`;
    }
  }

  // ---------------- inicialização ----------------
  function start() {
    const term = new Terminal();
    KS.term = term;
    new ClusterPanel(term);
    setInterval(() => { try { term.cluster.tick(); } catch (e) { if (globalThis.console) console.error(e); } }, 500);
    setInterval(() => { if (term.cluster.dirty && !term.noSave) { term.cluster.dirty = false; term.save(); } }, 4000);
    window.addEventListener('beforeunload', () => { if (!term.noSave) term.save(); });
    if (term.restored) term.write('\x1b[2mEstado anterior restaurado deste navegador. Use "reset-cluster" para recomeçar do zero.\x1b[0m\n');
    term.write(`\x1b[1mkube-sim\x1b[0m · cluster Kubernetes v1.31.0 simulado no navegador · digite \x1b[36mhelp\x1b[0m para começar\n\n`);
    term.showInput();
    document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => term.insert(b.dataset.cmd)));
    $('#btn-reset').addEventListener('click', () => { $('#confirm-reset').hidden = !$('#confirm-reset').hidden; });
    $('#reset-yes').addEventListener('click', () => term.resetCluster());
    $('#reset-no').addEventListener('click', () => { $('#confirm-reset').hidden = true; });
    $('#btn-panel').addEventListener('click', () => {
      document.body.classList.toggle('panel-hidden');
      $('#btn-panel').setAttribute('aria-pressed', document.body.classList.contains('panel-hidden') ? 'false' : 'true');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
