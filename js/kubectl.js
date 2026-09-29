// kubectl simulado — parte 1: parser de flags, infraestrutura e comandos de leitura/escrita de recursos.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, S = KS.schema, PR = KS.printers, SYSTEM = KS.SYSTEM;
  const K = (KS.kubectl = {});
  const SERVER = 'https://127.0.0.1:43127';
  K.SERVER = SERVER;
  K.CLIENT_VERSION = { major: '1', minor: '31', gitVersion: 'v1.31.0', gitCommit: '9edcffcde5595e8a5b1a35f88c421764e575afce', gitTreeState: 'clean', buildDate: '2024-08-13T07:37:34Z', goVersion: 'go1.22.5', compiler: 'gc', platform: 'linux/amd64' };

  class Exit extends Error {
    constructor(code, msg) {
      super(msg || '');
      this.exitCode = code;
      this.printed = !msg;
    }
  }
  K.Exit = Exit;

  // ---------------- flags ----------------
  const F = (t, s, d, o) => ({ t, s, d, o });
  const GLOBAL = {
    namespace: F('string', 'n', 'If present, the namespace scope for this CLI request'),
    context: F('string', null, 'The name of the kubeconfig context to use'),
    cluster: F('string', null, 'The name of the kubeconfig cluster to use'),
    user: F('string', null, 'The name of the kubeconfig user to use'),
    kubeconfig: F('string', null, 'Path to the kubeconfig file to use for CLI requests.'),
    v: F('int', 'v', 'number for the log level verbosity'),
    as: F('string', null, 'Username to impersonate for the operation. User could be a regular user or a service account in a namespace.'),
    'as-group': F('strings', null, 'Group to impersonate for the operation, this flag can be repeated to specify multiple groups.'),
    'as-uid': F('string', null, 'UID to impersonate for the operation.'),
    'request-timeout': F('string', null, "The length of time to wait before giving up on a single server request. Non-zero values should contain a corresponding time unit (e.g. 1s, 2m, 3h). A value of zero means don't timeout requests."),
    server: F('string', 's', 'The address and port of the Kubernetes API server'),
    token: F('string', null, 'Bearer token for authentication to the API server'),
    'insecure-skip-tls-verify': F('bool', null, "If true, the server's certificate will not be checked for validity. This will make your HTTPS connections insecure"),
    'certificate-authority': F('string', null, 'Path to a cert file for the certificate authority'),
    'client-certificate': F('string', null, 'Path to a client certificate file for TLS'),
    'client-key': F('string', null, 'Path to a client key file for TLS'),
    username: F('string', null, 'Username for basic authentication to the API server'),
    password: F('string', null, 'Password for basic authentication to the API server'),
    'tls-server-name': F('string', null, 'Server name to use for server certificate validation. If it is not provided, the hostname used to contact the server is used'),
    'match-server-version': F('bool', null, 'Require server version to match client version'),
    'cache-dir': F('string', null, 'Default cache directory'),
    'log-flush-frequency': F('string', null, 'Maximum number of seconds between log flushes'),
    'warnings-as-errors': F('bool', null, 'Treat warnings received from the server as errors and exit with a non-zero exit code'),
    'disable-compression': F('bool', null, 'If true, opt-out of response compression for all requests to the server'),
    profile: F('string', null, "Name of profile to capture. One of (none|cpu|heap|goroutine|threadcreate|block|mutex)"),
    'profile-output': F('string', null, 'Name of the file to write the profile to'),
    help: F('bool', 'h', 'help for this command'),
  };
  K.GLOBAL = GLOBAL;
  const PRINT = {
    output: F('string', 'o', 'Output format. One of: (json, yaml, name, go-template, go-template-file, template, templatefile, jsonpath, jsonpath-as-json, jsonpath-file).'),
    template: F('string', null, 'Template string or path to template file to use when -o=go-template, -o=go-template-file.'),
    'show-managed-fields': F('bool', null, 'If true, keep the managedFields when printing objects in JSON or YAML format.'),
    'allow-missing-template-keys': F('bool', null, 'If true, ignore any errors in templates when a field or map key is missing in the template.'),
  };
  const DRY = { 'dry-run': F('string', null, 'Must be "none", "server", or "client". If client strategy, only print the object that would be sent, without sending it. If server strategy, submit server-side request without persisting the resource.', 'unchanged') };
  const FILES = {
    filename: F('strings', 'f', 'Filename, directory, or URL to files to use.'),
    recursive: F('bool', 'R', 'Process the directory used in -f, --filename recursively. Useful when you want to manage related manifests organized within the same directory.'),
    kustomize: F('string', 'k', 'Process a kustomization directory. This flag can\'t be used together with -f or -R.'),
  };
  const SEL = {
    selector: F('string', 'l', "Selector (label query) to filter on, supports '=', '==', '!=', 'in', 'notin'.(e.g. -l key1=value1,key2=value2,key3 in (value3)). Matching objects must satisfy all of the specified label constraints."),
    'field-selector': F('string', null, "Selector (field query) to filter on, supports '=', '==', and '!='.(e.g. --field-selector key1=value1,key2=value2). The server only supports a limited number of field queries per type."),
    'all-namespaces': F('bool', 'A', 'If present, list the requested object(s) across all namespaces. Namespace in current context is ignored even if specified with --namespace.'),
  };
  const COMMON_W = { 'field-manager': F('string', null, 'Name of the manager used to track field ownership.'), validate: F('string', null, "Must be one of: strict (or true), warn, ignore (or false).", 'strict'), 'save-config': F('bool', null, 'If true, the configuration of current object will be saved in its annotation.'), record: F('bool', null, 'Record current kubectl command in the resource annotation. [DEPRECATED]') };

  function parseArgs(args, spec) {
    const flags = {}, pos = [], seen = {};
    let dash = null;
    const byShort = {};
    for (const [k, v] of Object.entries(spec)) if (v.s) byShort[v.s] = k;
    const setVal = (name, raw, disp) => {
      const f = spec[name];
      let v = raw;
      if (f.t === 'bool') {
        if (raw === true) v = true;
        else if (/^(true|1|t|T|TRUE|True)$/.test(raw)) v = true;
        else if (/^(false|0|f|F|FALSE|False)$/.test(raw)) v = false;
        else throw new Exit(1, `error: invalid argument "${raw}" for "${disp}" flag: strconv.ParseBool: parsing "${raw}": invalid syntax\nSee '${K._cmdPath} --help' for usage.`);
      } else if (f.t === 'int') {
        if (!/^-?\d+$/.test(String(raw))) throw new Exit(1, `error: invalid argument "${raw}" for "${disp}" flag: strconv.ParseInt: parsing "${raw}": invalid syntax\nSee '${K._cmdPath} --help' for usage.`);
        v = parseInt(raw);
      } else if (f.t === 'strings') {
        v = (flags[name] || []).concat(String(raw).split(',').filter((x) => x !== '' || true));
        if (name === 'filename' || name === 'as-group' || name === 'env' || name === 'from-literal' || name === 'from-file' || name === 'from-env-file' || name === 'rule' || name === 'annotation' || name === 'overrides' || name === 'resource-name') v = (flags[name] || []).concat([raw]);
      } else if (f.t === 'stringArray') v = (flags[name] || []).concat([raw]);
      flags[name] = v;
      seen[name] = true;
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { dash = args.slice(i + 1); break; }
      if (a.startsWith('--') && a.length > 2) {
        let name = a.slice(2), val;
        const eq = name.indexOf('=');
        if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
        if (!spec[name]) throw new Exit(1, `error: unknown flag: --${name}\nSee '${K._cmdPath} --help' for usage.`);
        const f = spec[name];
        if (val === undefined) {
          if (f.t === 'bool') val = true;
          else if (f.o !== undefined) val = f.o;
          else {
            if (i + 1 >= args.length) throw new Exit(1, `error: flag needs an argument: --${name}\nSee '${K._cmdPath} --help' for usage.`);
            val = args[++i];
          }
        }
        setVal(name, val, '--' + name);
        continue;
      }
      if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
        for (let j = 1; j < a.length; j++) {
          const ch = a[j];
          const name = byShort[ch];
          if (!name) throw new Exit(1, `error: unknown shorthand flag: '${ch}' in ${a}\nSee '${K._cmdPath} --help' for usage.`);
          const f = spec[name];
          if (f.t === 'bool') {
            if (a[j + 1] === '=') { setVal(name, a.slice(j + 2), '-' + ch); break; }
            setVal(name, true, '-' + ch);
            continue;
          }
          let val = a.slice(j + 1);
          if (val.startsWith('=')) val = val.slice(1);
          if (val === '') {
            if (f.o !== undefined) val = f.o;
            else {
              if (i + 1 >= args.length) throw new Exit(1, `error: flag needs an argument: '${ch}' in -${ch}\nSee '${K._cmdPath} --help' for usage.`);
              val = args[++i];
            }
          }
          setVal(name, val, '-' + ch);
          break;
        }
        continue;
      }
      pos.push(a);
    }
    return { flags, pos, dash, seen };
  }
  K.parseArgs = parseArgs;

  // ---------------- comandos ----------------
  const CMD = (K.CMD = {});
  K.def = (name, def) => (CMD[name] = def);

  // ---------------- contexto de execução ----------------
  class Ctx {
    constructor(env, cmdPath, parsed, raw) {
      this.env = env;
      this.cluster = env.cluster;
      this.cmdPath = cmdPath;
      this.flags = parsed.flags;
      this.seen = parsed.seen;
      this.pos = parsed.pos;
      this.dash = parsed.dash;
      this.raw = raw;
      this.code = 0;
    }
    out(s) { this.env.out(s); }
    err(s) { this.env.err(s); }
    fail(msg, code = 1) { throw new Exit(code, 'error: ' + msg); }
    usageFail(msg) { throw new Exit(1, `error: ${msg}\nSee '${this.cmdPath} -h' for help and examples`); }
    get aborted() { return this.env.signal && this.env.signal.aborted; }
    async sleep(ms) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (this.aborted) throw new Exit(130);
        await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
      }
    }
    // kubeconfig
    kcPath() { return this.flags.kubeconfig || (this.env.vars && this.env.vars.KUBECONFIG ? this.env.vars.KUBECONFIG.split(':')[0] : '/root/.kube/config'); }
    kubeconfig() {
      if (this._kc) return this._kc;
      const p = this.kcPath();
      const text = this.env.fs.read(p);
      let kc;
      if (text === null) kc = { apiVersion: 'v1', kind: 'Config', clusters: [], contexts: [], users: [], preferences: {}, 'current-context': '' };
      else {
        try {
          kc = globalThis.jsyaml.load(text) || {};
        } catch (e) {
          this.fail(`error loading config file "${p}": yaml: ${e.reason || e.message}`);
        }
      }
      kc.clusters = kc.clusters || [];
      kc.contexts = kc.contexts || [];
      kc.users = kc.users || [];
      this._kc = kc;
      return kc;
    }
    saveKubeconfig(kc) {
      this.env.fs.write(this.kcPath(), PR.yaml(kc));
      this._kc = kc;
    }
    currentContext() {
      const kc = this.kubeconfig();
      const name = this.flags.context || kc['current-context'];
      const ctx = kc.contexts.find((c) => c.name === name);
      return { name, ctx: ctx ? ctx.context || {} : null };
    }
    ns() {
      if (this.flags.namespace) return this.flags.namespace;
      const { ctx } = this.currentContext();
      return (ctx && ctx.namespace) || 'default';
    }
    nsExplicit() { return !!this.flags.namespace; }
    // autenticação: retorna {user, groups}
    auth() {
      if (this._auth) return this._auth;
      const kc = this.kubeconfig();
      const { name, ctx } = this.currentContext();
      if (this.flags.context && !ctx) this.fail(`context was not found for specified context: ${this.flags.context}`);
      const clusterName = this.flags.cluster || (ctx && ctx.cluster);
      const cl = kc.clusters.find((c) => c.name === clusterName);
      const server = this.flags.server || (cl && cl.cluster && cl.cluster.server);
      if (!server) {
        if (!kc.contexts.length && !this.flags.server) throw new Exit(1, 'The connection to the server localhost:8080 was refused - did you specify the right host or port?');
        if (ctx === null && name) this.fail(`context was not found for specified context: ${name}`);
        throw new Exit(1, 'The connection to the server localhost:8080 was refused - did you specify the right host or port?');
      }
      const hostport = server.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!['127.0.0.1:43127', 'localhost:43127', 'sim-control-plane:6443', '172.18.0.2:6443', 'kubernetes.default.svc:443', '10.96.0.1:443', 'kubernetes:443'].includes(hostport)) {
        if (/^\d+\.\d+\.\d+\.\d+/.test(hostport) || hostport.startsWith('localhost')) throw new Exit(1, `The connection to the server ${hostport} was refused - did you specify the right host or port?`);
        throw new Exit(1, `Unable to connect to the server: dial tcp: lookup ${hostport.split(':')[0]} on 127.0.0.11:53: no such host`);
      }
      if (!this.cluster.componentUp('kube-apiserver')) throw new Exit(1, `The connection to the server ${hostport} was refused - did you specify the right host or port?`);
      const userName = (this.localFlags && this.localFlags.user ? null : this.flags.user) || (ctx && ctx.user);
      const uEntry = (kc.users.find((u) => u.name === userName) || {}).user || {};
      let token = this.flags.token || uEntry.token;
      if (!token && uEntry.tokenFile) token = (this.env.fs.read(uEntry.tokenFile) || '').trim();
      let certData = null;
      const certFile = this.flags['client-certificate'] || uEntry['client-certificate'];
      if (uEntry['client-certificate-data'] && !this.flags['client-certificate']) {
        try { certData = U.b64d(uEntry['client-certificate-data']); } catch (e) { certData = ''; }
      } else if (certFile) {
        certData = this.env.fs.read(certFile);
        if (certData === null) this.fail(`unable to read client-cert ${certFile} for ${userName} due to open ${certFile}: no such file or directory`);
      }
      let who = null;
      const unauthorized = () => new Exit(1, 'error: You must be logged in to the server (Unauthorized)');
      if (token) {
        const parts = token.split('.');
        try {
          const payload = JSON.parse(U.b64d(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (!payload.sub || payload.exp * 1000 < Date.now()) throw unauthorized();
          const m = payload.sub.match(/^system:serviceaccount:([^:]+):(.+)$/);
          if (m) {
            if (!this.cluster.raw(S.byId('serviceaccounts'), m[1], m[2])) throw unauthorized();
            who = { user: payload.sub, groups: ['system:serviceaccounts', `system:serviceaccounts:${m[1]}`, 'system:authenticated'] };
          } else who = { user: payload.sub, groups: ['system:authenticated'] };
        } catch (e) {
          if (e instanceof Exit) throw e;
          throw unauthorized();
        }
      } else if (certData) {
        const b = certData.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
        let subj = null;
        try {
          const dec = U.b64d(b);
          const m = dec.match(/^SIMCERT:([^:]+):/);
          if (m) subj = JSON.parse(U.b64d(m[1]));
        } catch (e) { /* */ }
        if (!subj || subj.untrusted) throw unauthorized();
        who = { user: subj.CN, groups: [...(subj.O || []), 'system:authenticated'] };
      } else if (this.flags.username || uEntry.username) {
        throw unauthorized();
      } else {
        who = { user: 'system:anonymous', groups: ['system:unauthenticated'] };
      }
      if (this.flags.as) {
        const imp = this.cluster.authorize(who, { verb: 'impersonate', group: '', resource: this.flags.as.startsWith('system:serviceaccount:') ? 'serviceaccounts' : 'users', name: this.flags.as.split(':').pop(), namespace: this.flags.as.startsWith('system:serviceaccount:') ? this.flags.as.split(':')[2] : '' });
        if (!imp.allowed) throw new Exit(1, `Error from server (Forbidden): users "${this.flags.as}" is forbidden: User "${who.user}" cannot impersonate resource "users" in API group "" at the cluster scope`);
        const m = this.flags.as.match(/^system:serviceaccount:([^:]+):(.+)$/);
        const groups = [...(this.flags['as-group'] || [])];
        if (m) groups.push('system:serviceaccounts', `system:serviceaccounts:${m[1]}`);
        groups.push('system:authenticated');
        who = { user: this.flags.as, groups };
      } else if (this.flags['as-group']) {
        throw new Exit(1, 'error: requesting uid, groups or user-extra for  without impersonating a user');
      }
      if (who.user === 'system:anonymous') {
        // RBAC ainda é aplicado; a maioria das chamadas falhará com Forbidden
      }
      this._auth = who;
      this.logReq('GET', `${SERVER}/api?timeout=32s`, 200);
      return who;
    }
    logReq(method, url, code, body) {
      const v = this.flags.v || 0;
      if (v < 6) return;
      const d = new Date();
      const ts = `I${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')} ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
      this.err(`${ts}   ${1000 + Math.floor(Math.random() * 9000)} round_trippers.go:553] ${method} ${url} ${code} ${{ 200: 'OK', 201: 'Created', 404: 'Not Found', 403: 'Forbidden', 409: 'Conflict', 422: 'Unprocessable Entity' }[code] || ''} in ${1 + Math.floor(Math.random() * 9)} milliseconds\n`);
      if (v >= 8 && body) this.err(`${ts}   1234 request.go:1351] Response Body: ${JSON.stringify(body).slice(0, 1024)}\n`);
    }
    apiPath(t, ns, name, q) {
      const base = t.group ? `/apis/${t.group}/${t.version}` : `/api/${t.version}`;
      return `${SERVER}${base}${t.namespaced && ns ? `/namespaces/${ns}` : ''}/${t.plural}${name ? '/' + name : ''}${q || ''}`;
    }
    // operações de API com log de verbosidade
    get(t, ns, name) {
      const a = this.auth();
      try {
        const o = this.cluster.get(t, ns, name, a);
        this.logReq('GET', this.apiPath(t, ns, name), 200, o);
        return o;
      } catch (e) {
        this.logReq('GET', this.apiPath(t, ns, name), e.code || 500);
        throw e;
      }
    }
    list(t, ns, opts) {
      const a = this.auth();
      const q = [];
      if (opts && opts.labelSelector) q.push('labelSelector=' + encodeURIComponent(opts.labelSelector));
      if (opts && opts.fieldSelector) q.push('fieldSelector=' + encodeURIComponent(opts.fieldSelector));
      q.push('limit=500');
      const r = this.cluster.list(t, ns, opts || {}, a);
      this.logReq('GET', this.apiPath(t, ns, null, '?' + q.join('&')), 200);
      return r;
    }
    create(obj, opts) {
      const ot = this.cluster.typeOf(obj);
      if (ot && ot.namespaced) {
        obj.metadata = obj.metadata || {};
        if (!obj.metadata.namespace) obj.metadata.namespace = this.ns();
      }
      const r = this.cluster.create(obj, this.auth(), opts);
      const t = this.cluster.typeOf(obj);
      this.logReq('POST', this.apiPath(t, obj.metadata.namespace, null, opts && opts.dryRun ? '?dryRun=All&fieldManager=kubectl-client-side-apply&fieldValidation=Strict' : '?fieldManager=kubectl-create&fieldValidation=Strict'), 201);
      return r;
    }
    update(obj, opts) {
      const r = this.cluster.update(obj, this.auth(), opts);
      const t = this.cluster.typeOf(obj);
      this.logReq('PUT', this.apiPath(t, obj.metadata.namespace, obj.metadata.name), 200);
      return r;
    }
    patch(t, ns, name, p, type, opts) {
      const r = this.cluster.patch(t, ns, name, p, type, this.auth(), opts);
      this.logReq('PATCH', this.apiPath(t, ns, name, '?fieldManager=kubectl-patch'), 200);
      return r;
    }
    del(t, ns, name, opts) {
      const r = this.cluster.delete(t, ns, name, opts, this.auth());
      this.logReq('DELETE', this.apiPath(t, ns, name), 200);
      return r;
    }
    dryRun() {
      const d = this.flags['dry-run'];
      if (d === undefined || d === 'none' || d === 'false') return null;
      if (d === 'unchanged' || d === 'true') { this.err(`W${new Date().toTimeString().slice(0, 8)} --dry-run is deprecated and can be replaced with --dry-run=client.\n`); return 'client'; }
      if (d !== 'client' && d !== 'server') this.fail(`Invalid dry-run value (${d}). Must be "none", "server", or "client".`);
      return d;
    }
    drySuffix() {
      const d = this.dryRun();
      return d === 'client' ? ' (dry run)' : d === 'server' ? ' (server dry run)' : '';
    }
    // resolução de tipo
    type(str) {
      const t = S.resolve(str);
      if (!t) this.fail(`the server doesn't have a resource type "${str}"`);
      return t;
    }
    // Resolve argumentos no formato do kubectl -> [{t, name|null}]
    resolveArgs(args, opts = {}) {
      const out = [];
      if (!args.length) return out;
      if (args.some((a) => a.includes('/'))) {
        for (const a of args) {
          if (!a.includes('/')) this.fail(`there is no need to specify a resource type as a separate argument when passing arguments in resource/name form (e.g. '${this.cmdPath.replace(/^kubectl /, 'kubectl ')} resource/<resource_name>' instead of '${this.cmdPath} resource resource/<resource_name>'`);
          const i = a.indexOf('/');
          const tn = a.slice(0, i), name = a.slice(i + 1);
          if (!name) this.fail(`arguments in resource/name form must have a single resource and name`);
          out.push({ t: this.type(tn), name });
        }
        return out;
      }
      const types = [];
      for (const part of args[0].split(',')) {
        if (!part) continue;
        if (part === 'all' && !S.resolve('all')) types.push(...S.expandCategory('all').filter((t) => t.id !== 'replicationcontrollers' || true));
        else {
          const cat = S.types.filter((t) => t.categories.includes(part));
          if (cat.length && !S.resolve(part)) types.push(...cat);
          else types.push(this.type(part));
        }
      }
      const names = args.slice(1);
      for (const t of types) {
        if (names.length) for (const n of names) out.push({ t, name: n });
        else out.push({ t, name: null });
      }
      out.allCategory = args[0].split(',').includes('all') || types.length > 1;
      return out;
    }
    // Leitura de manifestos (-f / -k)
    readSource(src) {
      if (src === '-') {
        if (this.env.stdin === null || this.env.stdin === undefined) return '';
        return this.env.stdin;
      }
      if (/^https?:\/\//.test(src)) {
        const txt = (KS.examples && KS.examples.urls[src]) || null;
        if (txt === null) this.fail(`unable to read URL "${src}", server reported 404 Not Found, status code=404`);
        return txt;
      }
      const c = this.env.fs.read(src);
      if (c === null) {
        if (this.env.fs.isDir(src)) return null;
        this.fail(`the path "${src}" does not exist`);
      }
      return c;
    }
    manifests(opts = {}) {
      const files = this.flags.filename || [];
      const out = [];
      if (this.flags.kustomize) {
        const docs = K.kustomizeBuild(this, this.flags.kustomize);
        for (const d of docs) out.push({ obj: d, source: this.flags.kustomize });
        return out;
      }
      const addText = (text, source) => {
        let docs;
        try {
          docs = PR.parseYAMLDocs(text);
        } catch (e) {
          const line = e.mark ? e.mark.line + 1 : 1;
          this.fail(`error parsing ${source}: error converting YAML to JSON: yaml: line ${line}: ${(e.reason || e.message).replace(/\n[\s\S]*/, '')}`);
        }
        for (const d of docs) {
          if (!U.isObj(d)) this.fail(`error validating "${source}": error validating data: invalid object to validate; if you choose to ignore these errors, turn validation off with --validate=false`);
          if (d.kind && /List$/.test(d.kind) && Array.isArray(d.items)) { for (const it of d.items) out.push({ obj: it, source }); continue; }
          out.push({ obj: d, source });
        }
      };
      for (const f of files) {
        if (f !== '-' && !/^https?:\/\//.test(f) && this.env.fs.isDir(f)) {
          const walk = (dir) => {
            for (const name of this.env.fs.list(dir).sort()) {
              const p = dir.replace(/\/$/, '') + '/' + name.replace(/\/$/, '');
              if (this.env.fs.isDir(p)) { if (this.flags.recursive) walk(p); continue; }
              if (/\.(ya?ml|json)$/.test(name)) addText(this.env.fs.read(p), p);
            }
          };
          walk(f);
          continue;
        }
        addText(this.readSource(f), f);
      }
      if (!out.length && files.length && !opts.allowEmpty) this.fail('no objects passed to ' + (opts.verb || 'apply'));
      return out;
    }
    // valida objeto do manifesto (tipo, campos desconhecidos) -> t
    mapObj(obj, source) {
      if (!obj.kind) this.fail(`error validating "${source}": error validating data: kind not set; if you choose to ignore these errors, turn validation off with --validate=false`);
      if (!obj.apiVersion) this.fail(`error validating "${source}": error validating data: apiVersion not set; if you choose to ignore these errors, turn validation off with --validate=false`);
      const t = this.cluster.typeOf(obj);
      if (!t || (t.version !== obj.apiVersion.split('/').pop() && !(t.versions || []).includes(obj.apiVersion.split('/').pop()))) {
        throw new Exit(1, `error: resource mapping not found for name: "${(obj.metadata || {}).name || ''}" namespace: "${(obj.metadata || {}).namespace || ''}" from "${source}": no matches for kind "${obj.kind}" in version "${obj.apiVersion}"\nensure CRDs are installed first`);
      }
      return t;
    }
    strictCheck(t, obj, source, verb) {
      const v = this.flags.validate;
      if (v === 'ignore' || v === 'false') return;
      const bad = K.unknownFields(t, obj);
      const typeErr = K.typeErrors(t, obj);
      if (typeErr) throw Object.assign(new KS.ApiError(400, 'BadRequest', `error when ${verb} "${source}": ${t.kind} in version "${t.version}" cannot be handled as a ${t.kind}: ${typeErr}`), { raw: true });
      if (!bad.length) return;
      if (v === 'warn') {
        for (const b of bad) this.err(`Warning: unknown field "${b}"\n`);
        return;
      }
      throw Object.assign(new KS.ApiError(400, 'BadRequest', `error when ${verb} "${source}": ${t.kind} in version "${t.version}" cannot be handled as a ${t.kind}: strict decoding error: ${bad.map((b) => `unknown field "${b}"`).join(', ')}`), { raw: true });
    }
    // impressão do resultado de operações de escrita
    printOp(t, obj, verb) {
      const o = this.flags.output;
      if (o && o !== 'name' && o !== 'wide') { this.printObjects([{ t, o: obj }], { single: true }); return; }
      const ref = `${t.kindRef}/${obj.metadata.name}`;
      if (o === 'name') this.out(ref + '\n');
      else this.out(`${ref} ${verb}${this.drySuffix()}\n`);
    }
    // impressão genérica (-o)
    printObjects(entries, { single, allNs, withKind } = {}) {
      const o = this.flags.output || '';
      const [fmt, ...rest] = o.split('=');
      const arg = rest.join('=');
      const strip = (x) => {
        const c = U.clone(x);
        if (!this.flags['show-managed-fields'] && c.metadata) delete c.metadata.managedFields;
        return c;
      };
      const items = entries.map((e) => strip(e.o));
      const data = single && items.length === 1 ? items[0] : { apiVersion: 'v1', items, kind: 'List', metadata: { resourceVersion: '' } };
      switch (fmt) {
        case 'yaml': this.out(PR.yaml(data)); return;
        case 'json': this.out(PR.json(data)); return;
        case 'name': for (const e of entries) this.out(`${e.t.kindRef}/${e.o.metadata.name}\n`); return;
        case 'jsonpath': case 'jsonpath-as-json': case 'jsonpath-file': {
          let tpl = fmt === 'jsonpath-file' ? this.env.fs.read(arg) : arg || this.flags.template;
          if (tpl === null || tpl === undefined) this.fail(fmt === 'jsonpath-file' ? `error reading --template ${arg}, no such file or directory` : 'template format specified but no template given');
          try {
            this.out(U.jsonpath.execute(U.jsonpath.relax(tpl), data, { asJSON: fmt === 'jsonpath-as-json' }) + (fmt === 'jsonpath-as-json' ? '\n' : ''));
          } catch (e) {
            this.fail(`error parsing jsonpath ${tpl}, ${e.message}`);
          }
          return;
        }
        case 'go-template': case 'go-template-file': case 'template': case 'templatefile': {
          const tpl = fmt.endsWith('file') ? this.env.fs.read(arg) : arg || this.flags.template;
          if (!tpl) this.fail('template format specified but no template given');
          this.out(U.goTemplate(tpl, data));
          return;
        }
        case 'custom-columns': case 'custom-columns-file': {
          let spec = arg;
          if (fmt === 'custom-columns-file') {
            const txt = this.env.fs.read(arg) || '';
            const [h, p] = txt.trim().split('\n');
            const hs = h.trim().split(/\s+/), ps = p.trim().split(/\s+/);
            spec = hs.map((x, i) => `${x}:${ps[i]}`).join(',');
          }
          if (!spec) this.fail('custom-columns format specified but no custom columns given');
          const cols = spec.split(',').map((c) => {
            const i = c.indexOf(':');
            if (i < 0) this.fail(`unexpected custom-columns spec: ${c}, expected <header>:<json-path-expr>`);
            return [c.slice(0, i), c.slice(i + 1)];
          });
          const rows = [cols.map((c) => c[0])];
          for (const it of items) {
            rows.push(cols.map(([, p]) => {
              let vals;
              try { vals = U.jsonpath.evalPath(p.replace(/^\{|\}$/g, '').replace(/^([^.$@])/, '.$1'), it, it); } catch (e) { vals = []; }
              vals = vals.filter((v) => v !== undefined && v !== null);
              if (!vals.length) return '<none>';
              return vals.map((v) => (typeof v === 'object' ? (Array.isArray(v) ? JSON.stringify(v).replace(/"/g, '').replace(/,/g, ' ') : 'map[' + Object.entries(v).map(([k, x]) => `${k}:${typeof x === 'object' ? JSON.stringify(x) : x}`).join(' ') + ']') : String(v))).join(',');
            }));
          }
          if (this.flags['no-headers']) rows.shift();
          this.out(U.tabwrite(rows.map((r) => r.join('\t')).join('\n'), 0, 3) + '\n');
          return;
        }
        case '': case 'wide': {
          // agrupado por tipo
          const groups = [];
          for (const e of entries) {
            let g = groups.find((x) => x.t === e.t);
            if (!g) groups.push((g = { t: e.t, items: [] }));
            g.items.push(e.o);
          }
          const multi = withKind || groups.length > 1 || this.flags['show-kind'];
          groups.forEach((g, i) => {
            if (i) this.out('\n');
            this.out(PR.table(g.t, g.items, { wide: fmt === 'wide', withKind: multi, allNs, showLabels: this.flags['show-labels'], labelCols: (this.flags['label-columns'] || []).flatMap((x) => x.split(',')), noHeaders: this.flags['no-headers'] }) + '\n');
          });
          return;
        }
        default:
          this.fail(`unable to match a printer suitable for the output format "${o}", allowed formats are: custom-columns,custom-columns-file,go-template,go-template-file,json,jsonpath,jsonpath-as-json,jsonpath-file,name,template,templatefile,wide,yaml`);
      }
    }
    // coleta objetos a partir de -f ou argumentos (usado por delete/label/annotate/scale/etc.)
    collect(opts = {}) {
      const res = [];
      const ns = this.ns();
      const allNs = this.flags['all-namespaces'];
      if ((this.flags.filename || []).length || this.flags.kustomize) {
        for (const m of this.manifests({ verb: opts.verb })) {
          const t = this.mapObj(m.obj, m.source);
          const ons = t.namespaced ? m.obj.metadata.namespace || ns : '';
          res.push({ t, ns: ons, name: m.obj.metadata.name, source: m.source });
        }
        return res;
      }
      const args = opts.args || this.pos;
      if (!args.length) {
        if (opts.required !== false) this.fail(opts.noArgsMsg || `You must provide one or more resources by argument or filename.\nExample resource specifications include:\n   '-f rsrc.yaml'\n   '--filename=rsrc.json'\n   '<resource> <name>'\n   '<resource>'`);
        return res;
      }
      const refs = this.resolveArgs(args);
      for (const r of refs) {
        if (r.name) res.push({ t: r.t, ns: r.t.namespaced ? ns : '', name: r.name });
        else {
          if (!this.flags.all && !this.flags.selector && !this.flags['field-selector'] && !opts.listOk) this.fail(opts.noNameMsg || 'resource(s) were provided, but no name was specified');
          const items = this.list(r.t, r.t.namespaced && !allNs ? ns : null, { labelSelector: this.flags.selector, fieldSelector: this.flags['field-selector'] });
          for (const it of items) res.push({ t: r.t, ns: it.metadata.namespace || '', name: it.metadata.name, obj: it });
        }
      }
      return res;
    }
  }
  K.Ctx = Ctx;

  // ---------------- erros ----------------
  K.formatError = (e, ctx = {}) => {
    if (e instanceof Exit) return e.message;
    if (e instanceof KS.ApiError) {
      if (e.reason === 'Invalid' && e.causes) {
        const where = ctx.file ? `error when ${ctx.verb || 'creating'} "${ctx.file}": ` : '';
        if (where) return `Error from server (Invalid): ${where}${e.message}`;
        if (e.causes.length === 1) return `The ${e.kind} "${e.objName}" is invalid: ${e.causes[0]}`;
        return `The ${e.kind} "${e.objName}" is invalid: \n${e.causes.map((c) => '* ' + c).join('\n')}`;
      }
      if (e.raw) return `Error from server (${e.reason}): ${e.message}`;
      const where = ctx.file ? `error when ${ctx.verb || 'creating'} "${ctx.file}": ` : '';
      return `Error from server (${e.reason}): ${where}${e.message}`;
    }
    if (e && e.selector) return `error: ${e.message}`;
    return `error: ${e && e.message ? e.message : e}`;
  };

  // ---------------- validação estrita (campos desconhecidos) ----------------
  const EXTRA = {
    PodSpec: ['hostUsers', 'os', 'overhead', 'resourceClaims', 'schedulingGates', 'setHostnameAsFQDN', 'resources'],
    Container: ['resizePolicy', 'volumeDevices', 'restartPolicy'],
    ObjectMeta: [],
  };
  const docFields = (type) => {
    const d = S.docs[type];
    if (!d) return null;
    return new Set([...Object.keys(d.fields), ...(EXTRA[type] || [])]);
  };
  K.unknownFields = (t, obj) => {
    const bad = [];
    const check = (val, type, path) => {
      if (!U.isObj(val)) return;
      const f = docFields(type);
      if (!f) return;
      for (const k of Object.keys(val)) {
        if (!f.has(k)) { bad.push(path ? `${path}.${k}` : k); continue; }
        const fd = S.docs[type].fields[k];
        if (!fd) continue;
        const sub = fd[0].replace(/^\[\]/, '');
        if (fd[0].startsWith('[]') && Array.isArray(val[k])) val[k].forEach((it, i) => check(it, sub, `${path ? path + '.' : ''}${k}[${i}]`));
        else if (!fd[0].startsWith('map[') && S.docs[sub]) check(val[k], sub, `${path ? path + '.' : ''}${k}`);
      }
    };
    const doc = S.docs[t.kind];
    if (!doc || t.crd) return bad;
    check(obj, t.kind, '');
    return bad;
  };
  K.typeErrors = (t, obj) => {
    const s = obj.spec || {};
    const intField = (v, struct, path) => (v !== undefined && typeof v !== 'number' ? `json: cannot unmarshal ${typeof v === 'string' ? 'string' : typeof v} into Go struct field ${struct}.${path} of type int32` : null);
    if (['Deployment', 'ReplicaSet', 'StatefulSet'].includes(t.kind)) {
      const r = intField(s.replicas, `${t.kind}Spec`, 'spec.replicas');
      if (r) return r;
    }
    const tpl = t.kind === 'Pod' ? s : s.template && s.template.spec;
    for (const c of (tpl && tpl.containers) || []) for (const p of c.ports || []) { const r = intField(p.containerPort, 'ContainerPort', `spec${t.kind === 'Pod' ? '' : '.template.spec'}.containers.ports.containerPort`); if (r) return r; }
    if (t.kind === 'Service') for (const p of s.ports || []) { const r = intField(p.port, 'ServicePort', 'spec.ports.port'); if (r) return r; }
    for (const [k, v] of Object.entries((obj.metadata || {}).labels || {})) if (typeof v !== 'string') return `json: cannot unmarshal ${typeof v === 'number' ? 'number' : 'bool'} into Go struct field ObjectMeta.metadata.labels of type string`;
    if (t.kind === 'ConfigMap') for (const [k, v] of Object.entries(obj.data || {})) if (typeof v !== 'string') return `json: cannot unmarshal ${typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'object'} into Go struct field ConfigMap.data of type string`;
    return null;
  };

  // ---------------- helpers de negócio ----------------
  const LAST = 'kubectl.kubernetes.io/last-applied-configuration';
  K.LAST = LAST;
  const lastApplied = (obj) => {
    const c = U.clone(obj);
    if (c.metadata && c.metadata.annotations) {
      delete c.metadata.annotations[LAST];
      if (!Object.keys(c.metadata.annotations).length) delete c.metadata.annotations;
    }
    return JSON.stringify(PR.sortKeys(c)) + '\n';
  };
  K.lastApplied = lastApplied;
  const recordCause = (c, obj) => {
    if (!c.flags.record) return;
    obj.metadata.annotations = { ...(obj.metadata.annotations || {}), 'kubernetes.io/change-cause': 'kubectl ' + c.raw.join(' ') };
    c.err('Flag --record has been deprecated, --record will be removed in the future\n');
  };
  K.recordCause = recordCause;
  const containerName = (image) => {
    let n = image.split('@')[0].split('/').pop().split(':')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    return n || 'container';
  };
  K.containerName = containerName;

  // ---------------- GET ----------------
  K.def('get', {
    short: 'Display one or many resources',
    usage: 'kubectl get [(-o|--output=)json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-as-json|jsonpath-file|custom-columns|custom-columns-file|wide] (TYPE[.VERSION][.GROUP] [NAME | -l label] | TYPE[.VERSION][.GROUP]/NAME ...) [flags] [options]',
    long: " Display one or many resources.\n\n Prints a table of the most important information about the specified resources. You can filter the list using a label selector and the --selector flag. If the desired resource type is namespaced you will only see results in the current namespace unless you pass --all-namespaces.\n\n By specifying the output as 'template' and providing a Go template as the value of the --template flag, you can filter the attributes of the fetched resources.\n\nUse \"kubectl api-resources\" for a complete list of supported resources.",
    example: `  # List all pods in ps output format
  kubectl get pods

  # List all pods in ps output format with more information (such as node name)
  kubectl get pods -o wide

  # List a single replication controller with specified NAME in ps output format
  kubectl get replicationcontroller web

  # List deployments in JSON output format, in the "v1" version of the "apps" API group
  kubectl get deployments.v1.apps -o json

  # List a single pod in JSON output format
  kubectl get -o json pod web-pod-13je7

  # List a pod identified by type and name specified in "pod.yaml" in JSON output format
  kubectl get -f pod.yaml -o json

  # Return only the phase value of the specified pod
  kubectl get -o template pod/web-pod-13je7 --template={{.status.phase}}

  # List resource information in custom columns
  kubectl get pod test-pod -o custom-columns=CONTAINER:.spec.containers[0].name,IMAGE:.spec.containers[0].image

  # List all replication controllers and services together in ps output format
  kubectl get rc,services

  # List one or more resources by their type and names
  kubectl get rc/web service/frontend pods/web-pod-13je7`,
    flags: {
      ...PRINT, ...SEL, ...FILES,
      watch: F('bool', 'w', 'After listing/getting the requested object, watch for changes.'),
      'watch-only': F('bool', null, 'Watch for changes to the requested object(s), without listing/getting first.'),
      'output-watch-events': F('bool', null, 'Output watch event objects when --watch or --watch-only is used. Existing objects are output as initial ADDED events.'),
      'show-labels': F('bool', null, 'When printing, show all labels as the last column (default hide labels column).'),
      'show-kind': F('bool', null, 'If present, list the resource type for the requested object(s).'),
      'label-columns': F('strings', 'L', 'Accepts a comma separated list of labels that are going to be presented as columns.'),
      'sort-by': F('string', null, 'If non-empty, sort list types using this field specification.'),
      'no-headers': F('bool', null, 'When using the default or custom-column output format, don\'t print headers (default print headers).'),
      'ignore-not-found': F('bool', null, 'If the requested object does not exist the command will return exit code 0.'),
      'chunk-size': F('int', null, 'Return large lists in chunks rather than all at once.'),
      raw: F('string', null, 'Raw URI to request from the server.  Uses the transport specified by the kubeconfig file.'),
      subresource: F('string', null, 'If specified, gets the subresource of the requested object.'),
      'server-print': F('bool', null, 'If true, have the server return the appropriate table output.'),
    },
    async run(c) {
      if (c.flags.raw) {
        c.auth();
        const r = c.cluster.rest('GET', c.flags.raw, null, c.auth());
        if (r.status >= 400) throw Object.assign(new KS.ApiError(r.status, r.body.reason, r.body.message), { raw: true });
        c.out(typeof r.body === 'string' ? r.body : JSON.stringify(r.body) + '\n');
        return;
      }
      const ns = c.ns();
      const allNs = !!c.flags['all-namespaces'];
      let entries = [];
      let anyNamed = false, anyList = false;
      let refs;
      if ((c.flags.filename || []).length || c.flags.kustomize) {
        refs = c.manifests().map((m) => { const t = c.mapObj(m.obj, m.source); return { t, name: m.obj.metadata.name, ns: m.obj.metadata.namespace }; });
      } else {
        if (!c.pos.length) {
          c.fail(`You must specify the type of resource to get. Use "kubectl api-resources" for a complete list of supported resources.\n\nerror: Required resource not specified.\nUse "kubectl explain <resource>" for a detailed description of that resource (e.g. kubectl explain pods).\nSee 'kubectl get -h' for help and examples`);
        }
        refs = c.resolveArgs(c.pos);
      }
      const multiKind = refs.allCategory || new Set(refs.map((r) => r.t.id)).size > 1;
      let failed = false;
      const errors = [];
      for (const r of refs) {
        if (r.name) {
          anyNamed = true;
          try {
            let o;
            if (r.t.group === 'metrics.k8s.io') {
              o = c.cluster.metricsList(r.t, r.t.namespaced ? r.ns || ns : null).find((x) => x.metadata.name === r.name);
              if (!o) throw new KS.ApiError(404, 'NotFound', `${r.t.kind === 'NodeMetrics' ? 'nodemetrics' : 'podmetrics'}.metrics.k8s.io "${r.name}" not found`);
            } else o = c.get(r.t, r.t.namespaced ? r.ns || ns : '', r.name);
            if (c.flags.selector && !U.matchLabelString(c.flags.selector, o.metadata.labels)) continue;
            entries.push({ t: r.t, o });
          } catch (e) {
            if (e instanceof KS.ApiError && e.code === 404 && c.flags['ignore-not-found']) continue;
            failed = true;
            errors.push(K.formatError(e));
          }
        } else {
          anyList = true;
          try {
            const items = c.list(r.t, r.t.namespaced && !allNs ? ns : null, { labelSelector: c.flags.selector, fieldSelector: c.flags['field-selector'] });
            for (const o of items) entries.push({ t: r.t, o });
          } catch (e) {
            if (multiKind && e instanceof KS.ApiError && e.code === 403) { errors.push(K.formatError(e)); failed = true; continue; }
            throw e;
          }
        }
      }
      if (c.flags['sort-by']) {
        const expr = c.flags['sort-by'].replace(/^\{|\}$/g, '');
        const key = (o) => {
          const v = U.jsonpath.evalPath(expr.startsWith('.') || expr.startsWith('$') ? expr : '.' + expr, o, o)[0];
          if (v === undefined || v === null) return '';
          if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return U.ms(v);
          if (typeof v === 'string' && U.validQuantity(v) && /\d(m|Ki|Mi|Gi|k|M|G)?$/.test(v) && !/^\d+$/.test(v)) return U.parseQuantity(v);
          return v;
        };
        entries.sort((a, b) => {
          if (a.t !== b.t) return 0;
          const x = key(a.o), y = key(b.o);
          if (typeof x === 'number' && typeof y === 'number') return x - y;
          return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
        });
      }
      const watch = c.flags.watch || c.flags['watch-only'];
      const single = anyNamed && !anyList && refs.length === 1 && !((c.flags.filename || []).length > 0 && refs.length > 1);
      if (!c.flags['watch-only']) {
        if (!entries.length && !watch) {
          for (const e of errors) c.err(e + '\n');
          if (!anyNamed || anyList) {
            const nsTypes = refs.some((r) => r.t.namespaced);
            if (!c.flags.output || /^(wide|custom-columns)/.test(c.flags.output)) c.err(allNs || !nsTypes ? 'No resources found\n' : `No resources found in ${ns} namespace.\n`);
            else if (/^(json|yaml)$/.test(c.flags.output)) c.printObjects([], {});
          }
          if (failed) throw new Exit(1);
          return;
        }
        if (entries.length && c.flags['output-watch-events'] && watch) {
          for (const e of entries) c.out(PR.table(e.t, [e.o], { wide: c.flags.output === 'wide', noHeaders: false }).replace(/^/, 'EVENT   ').replace(/\n/, '\nADDED   ') + '\n');
        } else if (entries.length) c.printObjects(entries, { single, allNs, withKind: multiKind });
        for (const e of errors) c.err(e + '\n');
      }
      if (failed && !watch) throw new Exit(1);
      if (!watch) return;
      // modo watch
      const types = new Set(refs.map((r) => r.t.id));
      const names = new Set(refs.filter((r) => r.name).map((r) => r.name));
      const lastRow = new Map();
      for (const e of entries) lastRow.set(e.o.metadata.uid, PR.table(e.t, [e.o], { wide: c.flags.output === 'wide', noHeaders: true, allNs, withKind: multiKind }));
      let headerPrinted = entries.length > 0;
      const reqs = c.flags.selector ? U.parseLabelSelector(c.flags.selector) : null;
      const queue = [];
      const unsub = c.cluster.watch((type, t, obj) => {
        if (!types.has(t.id)) return;
        if (t.namespaced && !allNs && obj.metadata.namespace !== ns) return;
        if (names.size && !names.has(obj.metadata.name)) return;
        if (reqs && !U.matchReqs(reqs, obj.metadata.labels)) return;
        queue.push({ type, t, obj: U.clone(obj) });
      });
      try {
        while (!c.aborted) {
          while (queue.length) {
            const ev = queue.shift();
            const fmt = c.flags.output || '';
            if (/^(yaml|json)$/.test(fmt)) {
              if (c.flags['output-watch-events']) c.printObjects([{ t: ev.t, o: { type: ev.type, object: ev.obj } }].map((x) => ({ t: x.t, o: x.o })), { single: true });
              else { if (fmt === 'yaml') c.out('---\n'); c.printObjects([{ t: ev.t, o: ev.obj }], { single: true }); }
              continue;
            }
            if (/^(name|jsonpath|custom-columns|go-template)/.test(fmt)) { c.printObjects([{ t: ev.t, o: ev.obj }], { single: true }); continue; }
            const row = PR.table(ev.t, [ev.obj], { wide: fmt === 'wide', noHeaders: true, allNs, withKind: multiKind, showLabels: c.flags['show-labels'], labelCols: c.flags['label-columns'] });
            if (ev.type !== 'DELETED' && lastRow.get(ev.obj.metadata.uid) === row) continue;
            lastRow.set(ev.obj.metadata.uid, row);
            if (!headerPrinted && !c.flags['no-headers']) {
              const full = PR.table(ev.t, [ev.obj], { wide: fmt === 'wide', allNs, withKind: multiKind, showLabels: c.flags['show-labels'], labelCols: c.flags['label-columns'] });
              c.out((c.flags['output-watch-events'] ? full.split('\n').map((l, i) => (i === 0 ? 'EVENT      ' : ev.type.padEnd(11)) + l).join('\n') : full) + '\n');
              headerPrinted = true;
              continue;
            }
            // realinha a linha com a largura do cabeçalho original
            c.out((c.flags['output-watch-events'] ? ev.type.padEnd(11) : '') + row + '\n');
          }
          await c.sleep(150);
        }
      } finally {
        unsub();
      }
    },
  });

  // ---------------- DESCRIBE ----------------
  K.def('describe', {
    short: 'Show details of a specific resource or group of resources',
    usage: 'kubectl describe (-f FILENAME | TYPE [NAME_PREFIX | -l label] | TYPE/NAME) [flags] [options]',
    long: ' Show details of a specific resource or group of resources.\n\n Print a detailed description of the selected resources, including related resources such as events or controllers. You may select a single object by name, all objects of that type, provide a name prefix, or label selector. For example:\n\n        $ kubectl describe TYPE NAME_PREFIX\n        \n will first check for an exact match on TYPE and NAME_PREFIX. If no such resource exists, it will output details for every resource that has a name prefixed with NAME_PREFIX.\n\nUse "kubectl api-resources" for a complete list of supported resources.',
    example: '  # Describe a node\n  kubectl describe nodes kubernetes-node-emt8.c.myproject.internal\n  \n  # Describe a pod\n  kubectl describe pods/nginx\n  \n  # Describe a pod identified by type and name in "pod.json"\n  kubectl describe -f pod.json\n  \n  # Describe all pods\n  kubectl describe pods\n  \n  # Describe pods by label name=myLabel\n  kubectl describe pods -l name=myLabel\n  \n  # Describe all pods managed by the \'frontend\' replication controller\n  # (rc-created pods get the name of the rc as a prefix in the pod name)\n  kubectl describe pods frontend',
    flags: { ...SEL, ...FILES, 'show-events': F('bool', null, 'If true, display events related to the described object.'), 'chunk-size': F('int', null, 'Return large lists in chunks rather than all at once.') },
    async run(c) {
      const ns = c.ns();
      const allNs = c.flags['all-namespaces'];
      let targets = [];
      if ((c.flags.filename || []).length) {
        for (const m of c.manifests()) { const t = c.mapObj(m.obj, m.source); targets.push({ t, name: m.obj.metadata.name, ns: m.obj.metadata.namespace || ns }); }
      } else {
        if (!c.pos.length) c.fail('You must specify the type of resource to describe. Use "kubectl api-resources" for a complete list of supported resources.');
        targets = c.resolveArgs(c.pos).map((r) => ({ ...r, ns }));
      }
      const outs = [];
      let failed = false;
      for (const r of targets) {
        const tns = r.t.namespaced && !allNs ? r.ns : null;
        if (r.name) {
          let o = null;
          try { o = c.get(r.t, r.t.namespaced ? r.ns : '', r.name); } catch (e) {
            if (!(e instanceof KS.ApiError) || e.code !== 404) throw e;
            // prefixo
            const pref = c.list(r.t, tns, {}).filter((x) => x.metadata.name.startsWith(r.name));
            if (!pref.length) { c.err(K.formatError(e) + '\n'); failed = true; continue; }
            for (const p of pref) outs.push(PR.describe(r.t, p, c.cluster));
            continue;
          }
          outs.push(PR.describe(r.t, o, c.cluster));
        } else {
          const items = c.list(r.t, tns, { labelSelector: c.flags.selector, fieldSelector: c.flags['field-selector'] });
          if (!items.length && targets.length === 1) {
            c.err(allNs || !r.t.namespaced ? 'No resources found\n' : `No resources found in ${ns} namespace.\n`);
            return;
          }
          for (const o of items) outs.push(PR.describe(r.t, o, c.cluster));
        }
      }
      let text = outs.join('\n\n');
      if (c.flags['show-events'] === false) text = text.replace(/\nEvents:[\s\S]*?(?=\n\n\n|$)/g, '');
      if (outs.length) c.out(text.replace(/\n*$/, '\n'));
      if (failed) throw new Exit(1);
    },
  });

  // ---------------- APPLY ----------------
  K.applyOne = (c, m, opts = {}) => {
    const obj = U.clone(m.obj);
    const t = c.mapObj(obj, m.source);
    obj.metadata = obj.metadata || {};
    const defNs = c.ns();
    if (t.namespaced) {
      if (c.nsExplicit() && obj.metadata.namespace && obj.metadata.namespace !== c.flags.namespace)
        c.fail(`the namespace from the provided object "${obj.metadata.namespace}" does not match the namespace "${c.flags.namespace}". You must pass '--namespace=${obj.metadata.namespace}' to perform this operation.`);
      obj.metadata.namespace = obj.metadata.namespace || defNs;
    } else delete obj.metadata.namespace;
    if (!obj.metadata.name) {
      if (obj.metadata.generateName) c.fail(`from ${obj.metadata.generateName}: cannot use generate name with apply`);
      c.fail(`error validating "${m.source}": error validating data: ValidationError(${obj.kind}.metadata): missing required field "name" in io.k8s.apimachinery.pkg.apis.meta.v1.ObjectMeta; if you choose to ignore these errors, turn validation off with --validate=false`);
    }
    const dry = c.dryRun();
    recordCause(c, obj);
    const la = lastApplied(obj);
    const withAnn = U.clone(obj);
    if (!c.flags['server-side']) withAnn.metadata.annotations = { ...(withAnn.metadata.annotations || {}), [LAST]: la };
    const existing = c.cluster.raw(t, obj.metadata.namespace, obj.metadata.name);
    if (!existing) {
      c.strictCheck(t, obj, m.source, 'creating');
      if (dry === 'client') return { t, o: withAnn, verb: c.flags['server-side'] ? 'serverside-applied' : 'created' };
      try {
        const created = c.create(withAnn, { dryRun: dry === 'server' });
        return { t, o: created, verb: c.flags['server-side'] ? 'serverside-applied' : 'created' };
      } catch (e) {
        throw Object.assign(e, { file: m.source, verb: 'creating' });
      }
    }
    c.get(t, obj.metadata.namespace, obj.metadata.name);
    c.strictCheck(t, obj, m.source, 'patching');
    let prev = null;
    try { prev = JSON.parse(((existing.metadata.annotations || {})[LAST]) || 'null'); } catch (e) { prev = null; }
    if (!prev && !c.flags['server-side'] && !opts.quietWarn) c.err(`Warning: resource ${t.plural}/${obj.metadata.name} is missing the ${LAST} annotation which is required by kubectl apply. kubectl apply should only be used on resources created declaratively by either kubectl create --save-config or kubectl apply. The missing annotation will be patched automatically.\n`);
    let merged = U.threeWay(existing, prev || {}, withAnn);
    merged.metadata.resourceVersion = existing.metadata.resourceVersion;
    if (c.flags['server-side']) {
      merged = U.strategicMerge(existing, obj);
    }
    try {
      if (dry === 'client') {
        const same = JSON.stringify(PR.sortKeys({ ...merged, metadata: { ...merged.metadata, resourceVersion: '' } })) === JSON.stringify(PR.sortKeys({ ...existing, metadata: { ...existing.metadata, resourceVersion: '' } }));
        return { t, o: merged, verb: same ? 'unchanged' : 'configured' };
      }
      const r = c.update(merged, { dryRun: dry === 'server' });
      return { t, o: r, verb: c.flags['server-side'] ? 'serverside-applied' : r._changed || dry === 'server' ? 'configured' : 'unchanged' };
    } catch (e) {
      if (c.flags.force && e instanceof KS.ApiError && e.reason === 'Invalid') {
        c.cluster.delete(t, obj.metadata.namespace, obj.metadata.name, { gracePeriodSeconds: c.flags['grace-period'] >= 0 ? c.flags['grace-period'] : undefined }, c.auth());
        c.cluster.removeRaw(t, c.cluster.raw(t, obj.metadata.namespace, obj.metadata.name) || { metadata: obj.metadata });
        const created = c.create(withAnn, {});
        return { t, o: created, verb: 'configured' };
      }
      throw Object.assign(e, { file: m.source, verb: 'patching' });
    }
  };
  K.def('apply', {
    short: 'Apply a configuration to a resource by file name or stdin',
    usage: 'kubectl apply (-f FILENAME | -k DIRECTORY) [flags] [options]',
    long: " Apply a configuration to a resource by file name or stdin. The resource name must be specified. This resource will be created if it doesn't exist yet. To use 'apply', always create the resource initially with either 'apply' or 'create --save-config'.\n\n JSON and YAML formats are accepted.\n\n Alpha Disclaimer: the --prune functionality is not yet complete. Do not use unless you are aware of what the current state is. See https://issues.k8s.io/34274.",
    example: "  # Apply the configuration in pod.json to a pod\n  kubectl apply -f ./pod.json\n  \n  # Apply resources from a directory containing kustomization.yaml - e.g. dir/kustomization.yaml\n  kubectl apply -k dir/\n  \n  # Apply the JSON passed into stdin to a pod\n  cat pod.json | kubectl apply -f -\n  \n  # Apply the configuration from all files that end with '.json'\n  kubectl apply -f '*.json'\n  \n  # Note: --prune is still in Alpha\n  # Apply the configuration in manifest.yaml that matches label app=nginx and delete all other resources that are not in the file and match label app=nginx\n  kubectl apply --prune -f manifest.yaml -l app=nginx",
    flags: { ...PRINT, ...DRY, ...FILES, ...COMMON_W, selector: SEL.selector, all: F('bool', null, 'Select all resources in the namespace of the specified resource types.'), prune: F('bool', null, 'Automatically delete resource objects, that do not appear in the configs and are created by either apply or create --save-config. Should be used with either -l or --all.'), 'prune-allowlist': F('strings', null, 'Overwrite the default allowlist with <group/version/kind> for --prune'), force: F('bool', null, 'If true, immediately remove resources from API and bypass graceful deletion.'), 'grace-period': F('int', null, 'Period of time in seconds given to the resource to terminate gracefully.'), overwrite: F('bool', null, 'Automatically resolve conflicts between the modified and live configuration by using values from the modified configuration'), 'server-side': F('bool', null, 'If true, apply runs in the server instead of the client.'), 'force-conflicts': F('bool', null, 'If true, server-side apply will force the changes against conflicts.'), wait: F('bool', null, 'If true, wait for resources to be gone before returning. This waits for finalizers.'), timeout: F('string', null, 'The length of time to wait before giving up on a delete'), cascade: F('string', null, 'Must be "background", "orphan", or "foreground".', 'background'), 'openapi-patch': F('bool', null, 'If true, use openapi to calculate diff when the openapi presents and the resource can be found in the openapi spec. Otherwise, fall back to use baked-in types.') },
    sub: {},
    async run(c) {
      if (!(c.flags.filename || []).length && !c.flags.kustomize) c.fail('must specify one of -f and -k\n\nerror: no objects passed to apply');
      const ms = c.manifests({ verb: 'apply' });
      let failed = false;
      const applied = new Set();
      for (const m of ms) {
        try {
          const r = K.applyOne(c, m);
          applied.add(`${r.t.id}/${r.o.metadata.namespace || ''}/${r.o.metadata.name}`);
          c.printOp(r.t, r.o, r.verb);
        } catch (e) {
          failed = true;
          c.err(K.formatError(e, { file: e.file, verb: e.verb }) + '\n');
        }
      }
      if (c.flags.prune) {
        if (!c.flags.selector && !c.flags.all) c.fail('all resources selected for prune without explicitly passing --all. To prune all resources, pass the --all flag. If you did not mean to prune all resources, specify a label selector');
        const ns = c.ns();
        const types = new Set(ms.map((m) => c.cluster.typeOf(m.obj)).filter(Boolean));
        for (const t of types) {
          for (const o of c.list(t, t.namespaced ? ns : null, { labelSelector: c.flags.selector })) {
            if (!(o.metadata.annotations || {})[LAST]) continue;
            if (applied.has(`${t.id}/${o.metadata.namespace || ''}/${o.metadata.name}`)) continue;
            if (!c.dryRun()) c.del(t, o.metadata.namespace, o.metadata.name, {});
            c.out(`${t.kindRef}/${o.metadata.name} pruned${c.drySuffix()}\n`);
          }
        }
      }
      if (failed) throw new Exit(1);
    },
  });
  CMD.apply.sub['view-last-applied'] = {
    short: 'View the latest last-applied-configuration annotations of a resource/object',
    usage: 'kubectl apply view-last-applied (TYPE [NAME | -l label] | TYPE/NAME | -f FILENAME) [flags] [options]',
    flags: { ...FILES, selector: SEL.selector, all: F('bool', null, 'Select all resources in the namespace of the specified resource types'), output: F('string', 'o', 'Output format. Must be one of (yaml, json)') },
    async run(c) {
      for (const r of c.collect({ listOk: true })) {
        const o = c.get(r.t, r.ns, r.name);
        const la = (o.metadata.annotations || {})[LAST];
        if (!la) c.fail(`no last-applied-configuration annotation found on resource: ${r.name}`);
        const obj = JSON.parse(la);
        c.out(c.flags.output === 'json' ? JSON.stringify(obj, null, 2) + '\n' : PR.yaml(obj));
      }
    },
  };
  CMD.apply.sub['set-last-applied'] = {
    short: 'Set the last-applied-configuration annotation on a live object to match the contents of a file',
    usage: 'kubectl apply set-last-applied -f FILENAME [flags] [options]',
    flags: { ...FILES, ...PRINT, ...DRY, 'create-annotation': F('bool', null, 'Will create \'last-applied-configuration\' annotations if current objects doesn\'t have one') },
    async run(c) {
      for (const m of c.manifests()) {
        const t = c.mapObj(m.obj, m.source);
        const ns = t.namespaced ? m.obj.metadata.namespace || c.ns() : '';
        const o = c.get(t, ns, m.obj.metadata.name);
        if (!(o.metadata.annotations || {})[LAST] && !c.flags['create-annotation']) c.fail(`no last-applied-configuration annotation found on resource: ${o.metadata.name}, to create the annotation, run the command with --create-annotation`);
        if (!c.dryRun()) c.patch(t, ns, o.metadata.name, { metadata: { annotations: { [LAST]: lastApplied(m.obj) } } }, 'merge');
        c.out(`${t.kindRef}/${o.metadata.name} configured${c.drySuffix()}\n`);
      }
    },
  };
  CMD.apply.sub['edit-last-applied'] = {
    short: 'Edit latest last-applied-configuration annotations of a resource/object',
    usage: 'kubectl apply edit-last-applied (RESOURCE/NAME | -f FILENAME) [flags] [options]',
    flags: { ...FILES, output: F('string', 'o', 'Output format. One of: (yaml, json).'), 'windows-line-endings': F('bool', null, 'Defaults to the line ending native to your platform.') },
    async run(c) {
      for (const r of c.collect()) {
        const o = c.get(r.t, r.ns, r.name);
        const la = (o.metadata.annotations || {})[LAST];
        if (!la) c.fail(`no last-applied-configuration annotation found on resource: ${r.name}`);
        const edited = await c.env.editor(`/tmp/kubectl-edit-${U.rand(8)}.yaml`, "# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n" + PR.yaml(JSON.parse(la)));
        if (edited === null) { c.out('Edit cancelled, no changes made.\n'); return; }
        const obj = globalThis.jsyaml.load(edited.replace(/^#.*$/gm, ''));
        c.patch(r.t, r.ns, r.name, { metadata: { annotations: { [LAST]: lastApplied(obj) } } }, 'merge');
        c.out(`${r.t.kindRef}/${r.name} edited\n`);
      }
    },
  };

  // ---------------- CREATE ----------------
  const createCommon = { ...PRINT, ...DRY, ...COMMON_W };
  const finishCreate = (c, obj) => {
    const t = c.cluster.typeOf(obj);
    if (c.flags['save-config']) obj.metadata.annotations = { ...(obj.metadata.annotations || {}), [LAST]: lastApplied(obj) };
    const dry = c.dryRun();
    if (dry === 'client') {
      if (c.flags.output) c.printObjects([{ t, o: obj }], { single: true });
      else c.out(`${t.kindRef}/${obj.metadata.name} created (dry run)\n`);
      return obj;
    }
    const r = c.create(obj, { dryRun: dry === 'server' });
    c.printOp(t, r, 'created');
    return r;
  };
  K.finishCreate = finishCreate;
  const needName = (c, what) => {
    if (c.pos.length !== 1) c.usageFail(`exactly one NAME is required, got ${c.pos.length}`);
    return c.pos[0];
  };
  K.def('create', {
    short: 'Create a resource from a file or from stdin',
    usage: 'kubectl create -f FILENAME [flags] [options]',
    long: ' Create a resource from a file or from stdin.\n\n JSON and YAML formats are accepted.',
    example: '  # Create a pod using the data in pod.json\n  kubectl create -f ./pod.json\n  \n  # Create a pod based on the JSON passed into stdin\n  cat pod.json | kubectl create -f -\n  \n  # Edit the data in registry.yaml in JSON then create the resource using the edited data\n  kubectl create -f registry.yaml --edit -o json',
    flags: { ...createCommon, ...FILES, edit: F('bool', null, 'Edit the API resource before creating'), raw: F('string', null, 'Raw URI to POST to the server.  Uses the transport specified by the kubeconfig file.'), selector: SEL.selector, 'windows-line-endings': F('bool', null, 'Only relevant if --edit=true. Defaults to the line ending native to your platform.') },
    sub: {},
    async run(c) {
      if (c.flags.raw) {
        const body = c.readSource((c.flags.filename || [])[0] || '-');
        const obj = PR.parseYAMLDocs(body)[0];
        const r = c.cluster.rest('POST', c.flags.raw, obj, c.auth());
        if (r.status >= 400) throw Object.assign(new KS.ApiError(r.status, r.body.reason, r.body.message), { raw: true });
        c.out(JSON.stringify(r.body) + '\n');
        return;
      }
      if (!(c.flags.filename || []).length && !c.flags.kustomize) {
        if (c.pos.length) throw new Exit(1, `error: unknown command "${c.pos[0]}" for "kubectl create"\n\nDid you mean this?\n\t${Object.keys(CMD.create.sub).sort((a, b) => lev(a, c.pos[0]) - lev(b, c.pos[0]))[0]}\n`);
        throw new Exit(1, `error: must specify one of -f and -k\n\nerror: Unexpected args: []\nSee 'kubectl create -h' for help and examples`);
      }
      let failed = false;
      for (const m of c.manifests({ verb: 'create' })) {
        try {
          let obj = U.clone(m.obj);
          const t = c.mapObj(obj, m.source);
          obj.metadata = obj.metadata || {};
          if (t.namespaced) {
            if (c.nsExplicit() && obj.metadata.namespace && obj.metadata.namespace !== c.flags.namespace) c.fail(`the namespace from the provided object "${obj.metadata.namespace}" does not match the namespace "${c.flags.namespace}". You must pass '--namespace=${obj.metadata.namespace}' to perform this operation.`);
            obj.metadata.namespace = obj.metadata.namespace || c.ns();
          }
          if (c.flags.selector && !U.matchLabelString(c.flags.selector, obj.metadata.labels)) continue;
          c.strictCheck(t, obj, m.source, 'creating');
          if (c.flags.edit) {
            const ed = await c.env.editor(`/tmp/kubectl-edit-${U.rand(8)}.yaml`, "# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n" + PR.yaml(obj));
            if (ed === null) { c.out('Edit cancelled, no changes made.\n'); continue; }
            obj = globalThis.jsyaml.load(ed.replace(/^#.*$/gm, ''));
          }
          recordCause(c, obj);
          try {
            finishCreate(c, obj);
          } catch (e) {
            throw Object.assign(e, { file: m.source, verb: 'creating' });
          }
        } catch (e) {
          failed = true;
          c.err(K.formatError(e, { file: e.file, verb: e.verb }) + '\n');
        }
      }
      if (failed) throw new Exit(1);
    },
  });
  const CS = CMD.create.sub;
  CS.deployment = {
    alias: ['deploy'],
    short: 'Create a deployment with the specified name',
    usage: 'kubectl create deployment NAME --image=image -- [COMMAND] [args...] [flags] [options]',
    example: '  # Create a deployment named my-dep that runs the busybox image\n  kubectl create deployment my-dep --image=busybox\n  \n  # Create a deployment with a command\n  kubectl create deployment my-dep --image=busybox -- date\n  \n  # Create a deployment named my-dep that runs the nginx image with 3 replicas\n  kubectl create deployment my-dep --image=nginx --replicas=3\n  \n  # Create a deployment named my-dep that runs the busybox image and expose port 5701\n  kubectl create deployment my-dep --image=busybox --port=5701\n  \n  # Create a deployment named my-dep that runs multiple containers\n  kubectl create deployment my-dep --image=busybox:latest --image=ubuntu:latest --image=nginx',
    flags: { ...createCommon, image: F('stringArray', null, 'Image names to run. A deployment can have multiple images set for multi-container pod.'), port: F('int', null, 'The containerPort that this deployment exposes.'), replicas: F('int', 'r', 'Number of replicas to create. Default is 1.') },
    async run(c) {
      const name = needName(c);
      if (!(c.flags.image || []).length) c.fail('required flag(s) "image" not set');
      const containers = c.flags.image.map((img) => {
        const ct = { image: img, name: containerName(img), resources: {} };
        if (c.dash) ct.command = c.dash;
        if (c.flags.port !== undefined) ct.ports = [{ containerPort: c.flags.port }];
        return ct;
      });
      const labels = { app: name };
      finishCreate(c, {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { creationTimestamp: null, labels, name, ...(c.nsExplicit() ? { namespace: c.ns() } : {}) },
        spec: { replicas: c.flags.replicas ?? 1, selector: { matchLabels: { ...labels } }, strategy: {}, template: { metadata: { creationTimestamp: null, labels: { ...labels } }, spec: { containers } } },
        status: {},
      });
    },
  };
  const svcCreate = (type) => ({
    short: `Create a ${type} service`,
    usage: `kubectl create service ${type.toLowerCase()} NAME ${type === 'ExternalName' ? '--external-name external.name' : '[--tcp=<port>:<targetPort>]'} [--dry-run=server|client|none] [flags] [options]`,
    flags: { ...createCommon, tcp: F('strings', null, 'Port pairs can be specified as \'<port>:<targetPort>\'.'), ...(type === 'ClusterIP' ? { clusterip: F('string', null, 'Assign your own ClusterIP or set to \'None\' for a \'headless\' service (no loadbalancing).') } : {}), ...(type === 'NodePort' ? { 'node-port': F('int', null, 'Port used to expose the service on each node in a cluster.') } : {}), ...(type === 'ExternalName' ? { 'external-name': F('string', null, 'External name of service') } : {}) },
    async run(c) {
      const name = needName(c);
      const spec = { type };
      if (type === 'ExternalName') {
        if (!c.flags['external-name']) c.fail('required flag(s) "external-name" not set');
        spec.externalName = c.flags['external-name'];
      } else {
        const tcp = c.flags.tcp || [];
        if (!tcp.length && !(type === 'ClusterIP' && c.flags.clusterip === 'None')) c.fail('at least one tcp port specifier must be provided');
        spec.ports = tcp.map((p) => {
          const [port, target] = p.split(':');
          const o = { name: `${port}-${target || port}`, port: Number(port), protocol: 'TCP', targetPort: /^\d+$/.test(target || port) ? Number(target || port) : target };
          if (c.flags['node-port']) o.nodePort = c.flags['node-port'];
          return o;
        });
        spec.selector = { app: name };
        if (c.flags.clusterip) spec.clusterIP = c.flags.clusterip;
      }
      const obj = { apiVersion: 'v1', kind: 'Service', metadata: { creationTimestamp: null, labels: { app: name }, name }, spec, status: { loadBalancer: {} } };
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      const order = {};
      for (const k of ['ports', 'selector', 'type', 'clusterIP', 'externalName']) if (spec[k] !== undefined) order[k] = spec[k];
      obj.spec = order;
      finishCreate(c, obj);
    },
  });
  CS.service = {
    alias: ['svc'],
    short: 'Create a service using a specified subcommand',
    usage: 'kubectl create service [flags] [options]',
    sub: { clusterip: svcCreate('ClusterIP'), nodeport: svcCreate('NodePort'), loadbalancer: svcCreate('LoadBalancer'), externalname: svcCreate('ExternalName') },
    async run(c) { K.printHelp(c, 'kubectl create service', CS.service); },
  };
  const fromFileEntries = (c, specs, forSecret) => {
    const out = {};
    for (const sp of specs || []) {
      let key = null, path = sp;
      if (sp.includes('=')) { [key, path] = [sp.slice(0, sp.indexOf('=')), sp.slice(sp.indexOf('=') + 1)]; }
      if (c.env.fs.isDir(path)) {
        for (const n of c.env.fs.list(path)) {
          const p = path.replace(/\/$/, '') + '/' + n;
          if (c.env.fs.isDir(p)) continue;
          out[n] = c.env.fs.read(p);
        }
        continue;
      }
      const content = c.env.fs.read(path);
      if (content === null) c.fail(`error reading ${path}: no such file or directory`);
      out[key || path.split('/').pop()] = content;
    }
    return out;
  };
  const envFileEntries = (c, files) => {
    const out = {};
    for (const f of files || []) {
      const txt = c.env.fs.read(f);
      if (txt === null) c.fail(`error reading ${f}: no such file or directory`);
      for (const line of txt.split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#')) continue;
        const i = l.indexOf('=');
        if (i < 0) { out[l] = c.env.vars[l] || ''; continue; }
        out[l.slice(0, i)] = l.slice(i + 1);
      }
    }
    return out;
  };
  const literalEntries = (c, lits) => {
    const out = {};
    for (const l of lits || []) {
      const i = l.indexOf('=');
      if (i <= 0) c.fail(`invalid literal source ${l}, expected key=value`);
      const k = l.slice(0, i);
      if (k in out) c.fail(`cannot add key ${k}, another key by that name already exists in Data for ConfigMap "${c.pos[0]}"`);
      out[k] = l.slice(i + 1);
    }
    return out;
  };
  const appendHash = (name, data) => `${name}-${U.safeHash(JSON.stringify(PR.sortKeys(data))).slice(0, 10)}`;
  CS.configmap = {
    alias: ['cm'],
    short: 'Create a config map from a local file, directory or literal value',
    usage: 'kubectl create configmap NAME [--from-file=[key=]source] [--from-literal=key1=value1] [--dry-run=server|client|none] [flags] [options]',
    example: '  # Create a new config map named my-config based on folder bar\n  kubectl create configmap my-config --from-file=path/to/bar\n  \n  # Create a new config map named my-config with specified keys instead of file basenames on disk\n  kubectl create configmap my-config --from-file=key1=/path/to/bar/file1.txt --from-file=key2=/path/to/bar/file2.txt\n  \n  # Create a new config map named my-config with key1=config1 and key2=config2\n  kubectl create configmap my-config --from-literal=key1=config1 --from-literal=key2=config2\n  \n  # Create a new config map from an env file\n  kubectl create configmap my-config --from-env-file=path/to/foo.env --from-env-file=path/to/bar.env',
    flags: { ...createCommon, 'from-literal': F('stringArray', null, 'Specify a key and literal value to insert in configmap (i.e. mykey=somevalue)'), 'from-file': F('stringArray', null, 'Key file can be specified using its file path, in which case file basename will be used as configmap key, or optionally with a key and file path, in which case the given key will be used.'), 'from-env-file': F('stringArray', null, 'Specify the path to a file to read lines of key=val pairs to create a configmap.'), 'append-hash': F('bool', null, 'Append a hash of the configmap to its name.') },
    async run(c) {
      const name = needName(c);
      const data = { ...fromFileEntries(c, c.flags['from-file']), ...literalEntries(c, c.flags['from-literal']), ...envFileEntries(c, c.flags['from-env-file']) };
      const obj = { apiVersion: 'v1', data, kind: 'ConfigMap', metadata: { creationTimestamp: null, name: c.flags['append-hash'] ? appendHash(name, data) : name } };
      if (!Object.keys(data).length) delete obj.data;
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.secret = {
    short: 'Create a secret using a specified subcommand',
    usage: 'kubectl create secret (docker-registry | generic | tls) [flags] [options]',
    sub: {
      generic: {
        short: 'Create a secret from a local file, directory, or literal value',
        usage: 'kubectl create secret generic NAME [--type=string] [--from-file=[key=]source] [--from-literal=key1=value1] [--dry-run=server|client|none] [flags] [options]',
        example: "  # Create a new secret named my-secret with keys for each file in folder bar\n  kubectl create secret generic my-secret --from-file=path/to/bar\n  \n  # Create a new secret named my-secret with key1=supersecret and key2=topsecret\n  kubectl create secret generic my-secret --from-literal=key1=supersecret --from-literal=key2=topsecret",
        flags: { ...createCommon, 'from-literal': F('stringArray', null, 'Specify a key and literal value to insert in secret (i.e. mykey=somevalue)'), 'from-file': F('stringArray', null, 'Key files can be specified using their file path.'), 'from-env-file': F('stringArray', null, 'Specify the path to a file to read lines of key=val pairs to create a secret.'), type: F('string', null, 'The type of secret to create'), 'append-hash': F('bool', null, 'Append a hash of the secret to its name.') },
        async run(c) {
          const name = needName(c);
          const raw = { ...fromFileEntries(c, c.flags['from-file']), ...literalEntries(c, c.flags['from-literal']), ...envFileEntries(c, c.flags['from-env-file']) };
          const data = {};
          for (const [k, v] of Object.entries(raw)) data[k] = U.b64e(v);
          const obj = { apiVersion: 'v1', data, kind: 'Secret', metadata: { creationTimestamp: null, name: c.flags['append-hash'] ? appendHash(name, data) : name } };
          if (c.flags.type) obj.type = c.flags.type;
          if (!Object.keys(data).length) delete obj.data;
          if (c.nsExplicit()) obj.metadata.namespace = c.ns();
          finishCreate(c, obj);
        },
      },
      tls: {
        short: 'Create a TLS secret',
        usage: 'kubectl create secret tls NAME --cert=path/to/cert/file --key=path/to/key/file [--dry-run=server|client|none] [flags] [options]',
        flags: { ...createCommon, cert: F('string', null, 'Path to PEM encoded public key certificate.'), key: F('string', null, 'Path to private key associated with given certificate.'), 'append-hash': F('bool', null, 'Append a hash of the secret to its name.') },
        async run(c) {
          const name = needName(c);
          if (!c.flags.cert || !c.flags.key) c.fail('load key pair error: open : no such file or directory');
          const cert = c.env.fs.read(c.flags.cert), key = c.env.fs.read(c.flags.key);
          if (cert === null) c.fail(`open ${c.flags.cert}: no such file or directory`);
          if (key === null) c.fail(`open ${c.flags.key}: no such file or directory`);
          if (!/BEGIN CERTIFICATE/.test(cert) || !/BEGIN .*PRIVATE KEY/.test(key)) c.fail('failed to load key pair tls: failed to find any PEM data in certificate input');
          const obj = { apiVersion: 'v1', data: { 'tls.crt': U.b64e(cert), 'tls.key': U.b64e(key) }, kind: 'Secret', metadata: { creationTimestamp: null, name }, type: 'kubernetes.io/tls' };
          if (c.nsExplicit()) obj.metadata.namespace = c.ns();
          finishCreate(c, obj);
        },
      },
      'docker-registry': {
        short: 'Create a secret for use with a Docker registry',
        usage: 'kubectl create secret docker-registry NAME --docker-username=user --docker-password=password --docker-email=email [--docker-server=string] [--from-file=[key=]source] [--dry-run=server|client|none] [flags] [options]',
        flags: { ...createCommon, 'docker-server': F('string', null, 'Server location for Docker registry'), 'docker-username': F('string', null, 'Username for Docker registry authentication'), 'docker-password': F('string', null, 'Password for Docker registry authentication'), 'docker-email': F('string', null, 'Email for Docker registry'), 'from-file': F('stringArray', null, 'Key files can be specified using their file path.'), 'append-hash': F('bool', null, 'Append a hash of the secret to its name.') },
        async run(c) {
          const name = needName(c);
          let data;
          if ((c.flags['from-file'] || []).length) {
            const f = fromFileEntries(c, c.flags['from-file']);
            data = { '.dockerconfigjson': U.b64e(Object.values(f)[0]) };
          } else {
            if (!c.flags['docker-username']) c.fail('required flag(s) "docker-username" not set');
            if (!c.flags['docker-password']) c.fail('required flag(s) "docker-password" not set');
            const server = c.flags['docker-server'] || 'https://index.docker.io/v1/';
            const auth = { username: c.flags['docker-username'], password: c.flags['docker-password'], ...(c.flags['docker-email'] ? { email: c.flags['docker-email'] } : {}), auth: U.b64e(`${c.flags['docker-username']}:${c.flags['docker-password']}`) };
            data = { '.dockerconfigjson': U.b64e(JSON.stringify({ auths: { [server]: auth } })) };
          }
          const obj = { apiVersion: 'v1', data, kind: 'Secret', metadata: { creationTimestamp: null, name }, type: 'kubernetes.io/dockerconfigjson' };
          if (c.nsExplicit()) obj.metadata.namespace = c.ns();
          finishCreate(c, obj);
        },
      },
    },
    async run(c) { K.printHelp(c, 'kubectl create secret', CS.secret); },
  };
  CS.namespace = {
    alias: ['ns'],
    short: 'Create a namespace with the specified name',
    usage: 'kubectl create namespace NAME [--dry-run=server|client|none] [flags] [options]',
    example: '  # Create a new namespace named my-namespace\n  kubectl create namespace my-namespace',
    flags: createCommon,
    async run(c) {
      const name = needName(c);
      finishCreate(c, { apiVersion: 'v1', kind: 'Namespace', metadata: { creationTimestamp: null, name }, spec: {}, status: {} });
    },
  };
  CS.serviceaccount = {
    alias: ['sa'],
    short: 'Create a service account with the specified name',
    usage: 'kubectl create serviceaccount NAME [--dry-run=server|client|none] [flags] [options]',
    flags: createCommon,
    async run(c) {
      const name = needName(c);
      const obj = { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { creationTimestamp: null, name } };
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.job = {
    short: 'Create a job with the specified name',
    usage: 'kubectl create job NAME --image=image [--from=cronjob/name] -- [COMMAND] [args...] [flags] [options]',
    example: '  # Create a job\n  kubectl create job my-job --image=busybox\n  \n  # Create a job with a command\n  kubectl create job my-job --image=busybox -- date\n  \n  # Create a job from a cron job named "a-cronjob"\n  kubectl create job test-job --from=cronjob/a-cronjob',
    flags: { ...createCommon, image: F('string', null, 'Image name to run.'), from: F('string', null, 'The name of the resource to create a Job from (only cronjob is supported).') },
    async run(c) {
      const name = needName(c);
      let obj;
      if (c.flags.from) {
        const [tn, cn] = c.flags.from.split('/');
        const t = c.type(tn);
        if (t.id !== 'cronjobs.batch') c.fail(`from must be an existing cronjob: ${c.flags.from}`);
        const cj = c.get(t, c.ns(), cn);
        obj = {
          apiVersion: 'batch/v1', kind: 'Job',
          metadata: { annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' }, creationTimestamp: null, labels: { ...((cj.spec.jobTemplate.metadata || {}).labels || {}) }, name, ownerReferences: [{ apiVersion: 'batch/v1', blockOwnerDeletion: true, controller: true, kind: 'CronJob', name: cj.metadata.name, uid: cj.metadata.uid }] },
          spec: U.clone(cj.spec.jobTemplate.spec), status: {},
        };
        if (!Object.keys(obj.metadata.labels).length) delete obj.metadata.labels;
      } else {
        if (!c.flags.image) c.fail('--image must be specified');
        const ct = { image: c.flags.image, name, resources: {} };
        if (c.dash) ct.command = c.dash;
        obj = { apiVersion: 'batch/v1', kind: 'Job', metadata: { creationTimestamp: null, name }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [ct], restartPolicy: 'Never' } } }, status: {} };
      }
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.cronjob = {
    alias: ['cj'],
    short: 'Create a cron job with the specified name',
    usage: 'kubectl create cronjob NAME --image=image --schedule=\'0/5 * * * ?\' -- [COMMAND] [args...] [flags] [options]',
    example: '  # Create a cron job\n  kubectl create cronjob my-job --image=busybox --schedule="*/1 * * * *"\n  \n  # Create a cron job with a command\n  kubectl create cronjob my-job --image=busybox --schedule="*/1 * * * *" -- date',
    flags: { ...createCommon, image: F('string', null, 'Image name to run.'), schedule: F('string', null, 'A schedule in the Cron format the job should be run with.'), restart: F('string', null, 'job\'s restart policy. supported values: OnFailure, Never') },
    async run(c) {
      const name = needName(c);
      if (!c.flags.image) c.fail('required flag(s) "image" not set');
      if (!c.flags.schedule) c.fail('required flag(s) "schedule" not set');
      const ct = { image: c.flags.image, name, resources: {} };
      if (c.dash) ct.command = c.dash;
      const obj = { apiVersion: 'batch/v1', kind: 'CronJob', metadata: { creationTimestamp: null, name }, spec: { jobTemplate: { metadata: { creationTimestamp: null, name }, spec: { template: { metadata: { creationTimestamp: null }, spec: { containers: [ct], restartPolicy: c.flags.restart || 'OnFailure' } } } }, schedule: c.flags.schedule }, status: {} };
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  const ruleFromFlags = (c) => {
    const verbs = (c.flags.verb || []).flatMap((v) => v.split(','));
    const valid = ['*', 'get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'use', 'bind', 'escalate', 'impersonate', 'approve', 'sign'];
    if (!verbs.length) c.fail('at least one verb must be specified');
    for (const v of verbs) if (!valid.includes(v)) c.fail(`invalid verb: '${v}'`);
    const resources = (c.flags.resource || []).flatMap((r) => r.split(','));
    const rules = [];
    const groups = {};
    for (const r of resources) {
      if (r === '*') { (groups['*'] = groups['*'] || []).push('*'); continue; }
      const [base, sub] = r.split('/');
      const t = S.resolve(base);
      if (!t) c.fail(`the server doesn't have a resource type "${base}"`);
      (groups[t.group] = groups[t.group] || []).push(sub ? `${t.plural}/${sub}` : t.plural);
    }
    for (const [g, rs] of Object.entries(groups)) {
      const rule = { apiGroups: [g === '*' ? '*' : g], resources: rs, verbs };
      if ((c.flags['resource-name'] || []).length) rule.resourceNames = c.flags['resource-name'];
      rules.push(rule);
    }
    if ((c.flags['non-resource-url'] || []).length) rules.push({ nonResourceURLs: c.flags['non-resource-url'], verbs });
    if (!rules.length) c.fail('at least one resource must be specified');
    return rules;
  };
  const roleFlags = { ...createCommon, verb: F('strings', null, 'Verb that applies to the resources contained in the rule'), resource: F('strings', null, 'Resource that the rule applies to'), 'resource-name': F('stringArray', null, 'Resource in the white list that the rule applies to, repeat this flag for multiple items') };
  CS.role = {
    short: 'Create a role with single rule',
    usage: 'kubectl create role NAME --verb=verb --resource=resource.group/subresource [--resource-name=resourcename] [--dry-run=server|client|none] [flags] [options]',
    example: '  # Create a role named "pod-reader" that allows user to perform "get", "watch" and "list" on pods\n  kubectl create role pod-reader --verb=get --verb=list --verb=watch --resource=pods\n  \n  # Create a role named "pod-reader" with ResourceName specified\n  kubectl create role pod-reader --verb=get --resource=pods --resource-name=readablepod --resource-name=anotherpod\n  \n  # Create a role named "foo" with API Group specified\n  kubectl create role foo --verb=get,list,watch --resource=rs.apps\n  \n  # Create a role named "foo" with SubResource specified\n  kubectl create role foo --verb=get,list,watch --resource=pods,pods/status',
    flags: roleFlags,
    async run(c) {
      const name = needName(c);
      const obj = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { creationTimestamp: null, name }, rules: ruleFromFlags(c) };
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.clusterrole = {
    short: 'Create a cluster role',
    usage: 'kubectl create clusterrole NAME --verb=verb --resource=resource.group [--resource-name=resourcename] [--dry-run=server|client|none] [flags] [options]',
    flags: { ...roleFlags, 'non-resource-url': F('strings', null, 'A partial url that user should have access to.'), 'aggregation-rule': F('string', null, 'An aggregation label selector for combining ClusterRoles.') },
    async run(c) {
      const name = needName(c);
      const obj = { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { creationTimestamp: null, name } };
      if (c.flags['aggregation-rule']) {
        const ml = {};
        for (const kv of c.flags['aggregation-rule'].split(',')) { const [k, v] = kv.split('='); ml[k] = v; }
        obj.aggregationRule = { clusterRoleSelectors: [{ matchLabels: ml }] };
      } else obj.rules = ruleFromFlags(c);
      finishCreate(c, obj);
    },
  };
  const bindingRun = (kind) => async (c) => {
    const name = needName(c);
    const role = c.flags.role, cr = c.flags.clusterrole;
    if (!role && !cr) c.fail('exactly one of clusterrole or role must be specified');
    if (role && cr) c.fail('exactly one of clusterrole or role must be specified');
    const subjects = [];
    for (const u of c.flags.user || []) subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
    for (const g of c.flags.group || []) subjects.push({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
    for (const sa of c.flags.serviceaccount || []) {
      const [n, s] = sa.split(':');
      if (!s) c.fail(`serviceaccount must be <namespace>:<name>`);
      subjects.push({ kind: 'ServiceAccount', name: s, namespace: n });
    }
    const obj = { apiVersion: 'rbac.authorization.k8s.io/v1', kind, metadata: { creationTimestamp: null, name }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: role ? 'Role' : 'ClusterRole', name: role || cr } };
    if (subjects.length) obj.subjects = subjects;
    if (kind === 'RoleBinding' && c.nsExplicit()) obj.metadata.namespace = c.ns();
    finishCreate(c, obj);
  };
  const bindFlags = { ...createCommon, clusterrole: F('string', null, 'ClusterRole this RoleBinding should reference'), user: F('stringArray', null, 'Usernames to bind to the role. The flag can be repeated to add multiple users.'), group: F('stringArray', null, 'Groups to bind to the role. The flag can be repeated to add multiple groups.'), serviceaccount: F('stringArray', null, 'Service accounts to bind to the role, in the format <namespace>:<name>. The flag can be repeated to add multiple service accounts.') };
  CS.rolebinding = { short: 'Create a role binding for a particular role or cluster role', usage: 'kubectl create rolebinding NAME --clusterrole=NAME|--role=NAME [--user=username] [--group=groupname] [--serviceaccount=namespace:serviceaccountname] [--dry-run=server|client|none] [flags] [options]', example: '  # Create a role binding for user1, user2, and group1 using the admin cluster role\n  kubectl create rolebinding admin --clusterrole=admin --user=user1 --user=user2 --group=group1\n  \n  # Create a role binding for serviceaccount monitoring:sa-dev using the admin role\n  kubectl create rolebinding admin-binding --role=admin --serviceaccount=monitoring:sa-dev', flags: { ...bindFlags, role: F('string', null, 'Role this RoleBinding should reference') }, run: bindingRun('RoleBinding') };
  CS.clusterrolebinding = { short: 'Create a cluster role binding for a particular cluster role', usage: 'kubectl create clusterrolebinding NAME --clusterrole=NAME [--user=username] [--group=groupname] [--serviceaccount=namespace:serviceaccountname] [--dry-run=server|client|none] [flags] [options]', example: '  # Create a cluster role binding for user1, user2, and group1 using the cluster-admin cluster role\n  kubectl create clusterrolebinding cluster-admin --clusterrole=cluster-admin --user=user1 --user=user2 --group=group1', flags: bindFlags, run: bindingRun('ClusterRoleBinding') };
  CS.quota = {
    alias: ['resourcequota'],
    short: 'Create a quota with the specified name',
    usage: 'kubectl create quota NAME [--hard=key1=value1,key2=value2] [--scopes=Scope1,Scope2] [--dry-run=server|client|none] [flags] [options]',
    flags: { ...createCommon, hard: F('string', null, 'A comma-delimited set of resource=quantity pairs that define a hard limit.'), scopes: F('string', null, 'A comma-delimited set of quota scopes that must all match each object tracked by the quota.') },
    async run(c) {
      const name = needName(c);
      const hard = {};
      for (const kv of (c.flags.hard || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); hard[k] = v; }
      const obj = { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { creationTimestamp: null, name }, spec: { hard }, status: {} };
      if (c.flags.scopes) obj.spec.scopes = c.flags.scopes.split(',');
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.priorityclass = {
    alias: ['pc'],
    short: 'Create a priority class with the specified name',
    usage: 'kubectl create priorityclass NAME --value=VALUE --global-default=BOOL [--dry-run=server|client|none] [flags] [options]',
    flags: { ...createCommon, value: F('int', null, 'the value of this priority class.'), 'global-default': F('bool', null, 'global-default specifies whether this PriorityClass should be considered as the default priority.'), description: F('string', null, 'description is an arbitrary string that usually provides guidelines on when this priority class should be used.'), 'preemption-policy': F('string', null, 'preemption-policy is the policy for preempting pods with lower priority.') },
    async run(c) {
      const name = needName(c);
      const obj = { apiVersion: 'scheduling.k8s.io/v1', description: c.flags.description || '', globalDefault: !!c.flags['global-default'], kind: 'PriorityClass', metadata: { creationTimestamp: null, name }, preemptionPolicy: c.flags['preemption-policy'] || 'PreemptLowerPriority', value: c.flags.value || 0 };
      finishCreate(c, obj);
    },
  };
  CS.poddisruptionbudget = {
    alias: ['pdb'],
    short: 'Create a pod disruption budget with the specified name',
    usage: 'kubectl create poddisruptionbudget NAME --selector=SELECTOR --min-available=N [--dry-run=server|client|none] [flags] [options]',
    flags: { ...createCommon, selector: F('string', null, 'A label selector to use for this budget.'), 'min-available': F('string', null, 'The minimum number or percentage of available pods this budget requires.'), 'max-unavailable': F('string', null, 'The maximum number or percentage of unavailable pods this budget requires.') },
    async run(c) {
      const name = needName(c);
      if (!c.flags.selector) c.fail('a selector must be specified');
      if (!c.flags['min-available'] && !c.flags['max-unavailable']) c.fail('one of min-available or max-unavailable must be specified');
      const ml = {};
      for (const kv of c.flags.selector.split(',')) { const [k, v] = kv.split('='); ml[k] = v; }
      const val = (v) => (/^\d+$/.test(v) ? Number(v) : v);
      const spec = { selector: { matchLabels: ml } };
      if (c.flags['min-available']) spec.minAvailable = val(c.flags['min-available']);
      if (c.flags['max-unavailable']) spec.maxUnavailable = val(c.flags['max-unavailable']);
      const obj = { apiVersion: 'policy/v1', kind: 'PodDisruptionBudget', metadata: { creationTimestamp: null, name }, spec, status: { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 } };
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.ingress = {
    alias: ['ing'],
    short: 'Create an ingress with the specified name',
    usage: 'kubectl create ingress NAME --rule=host/path=service:port[,tls[=secret]]  [flags] [options]',
    example: '  # Create a single ingress called \'simple\' that directs requests to foo.com/bar to svc\n  # svc1:8080 with a TLS secret "my-cert"\n  kubectl create ingress simple --rule="foo.com/bar=svc1:8080,tls=my-cert"\n  \n  # Create a catch all ingress of "/path" pointing to service svc:port and Ingress Class as "otheringress"\n  kubectl create ingress catch-all --class=otheringress --rule="/path=svc:port"',
    flags: { ...createCommon, rule: F('stringArray', null, 'Rule in format host/path=service:port[,tls=secretname].'), class: F('string', null, 'Ingress Class to be used'), 'default-backend': F('string', null, 'Default service for backend, in format of svcname:port'), annotation: F('stringArray', null, 'Annotation to insert in the ingress object, in the format annotation=value') },
    async run(c) {
      const name = needName(c);
      const rules = [], tls = [];
      const backend = (s) => {
        const [svc, port] = s.split(':');
        return { service: { name: svc, port: /^\d+$/.test(port) ? { number: Number(port) } : { name: port } } };
      };
      for (const r of c.flags.rule || []) {
        const [main, ...opts] = r.split(',');
        const eq = main.indexOf('=');
        const hp = main.slice(0, eq), be = main.slice(eq + 1);
        const slash = hp.indexOf('/');
        const host = slash >= 0 ? hp.slice(0, slash) : hp;
        let path = slash >= 0 ? hp.slice(slash) : '/';
        let pathType = 'Exact';
        if (path.endsWith('*')) { path = path.slice(0, -1); pathType = 'Prefix'; }
        let rule = rules.find((x) => (x.host || '') === host);
        if (!rule) { rule = { ...(host ? { host } : {}), http: { paths: [] } }; rules.push(rule); }
        rule.http.paths.push({ backend: backend(be), path, pathType });
        for (const o of opts) if (o.startsWith('tls')) tls.push({ ...(host ? { hosts: [host] } : {}), ...(o.includes('=') ? { secretName: o.split('=')[1] } : {}) });
      }
      const spec = {};
      if (c.flags.class) spec.ingressClassName = c.flags.class;
      if (c.flags['default-backend']) spec.defaultBackend = backend(c.flags['default-backend']);
      if (rules.length) spec.rules = rules;
      if (tls.length) spec.tls = tls;
      const obj = { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { creationTimestamp: null, name }, spec, status: { loadBalancer: {} } };
      for (const a of c.flags.annotation || []) { const i = a.indexOf('='); obj.metadata.annotations = { ...(obj.metadata.annotations || {}), [a.slice(0, i)]: a.slice(i + 1) }; }
      if (c.nsExplicit()) obj.metadata.namespace = c.ns();
      finishCreate(c, obj);
    },
  };
  CS.token = {
    short: 'Request a service account token',
    usage: 'kubectl create token SERVICE_ACCOUNT_NAME [flags] [options]',
    example: '  # Request a token to authenticate to the kube-apiserver as the service account "myapp" in the current namespace\n  kubectl create token myapp\n  \n  # Request a token for a service account in a custom namespace\n  kubectl create token myapp --namespace myns\n  \n  # Request a token with a custom expiration\n  kubectl create token myapp --duration 10m\n  \n  # Request a token with a custom audience\n  kubectl create token myapp --audience https://example.com',
    flags: { ...PRINT, audience: F('stringArray', null, 'Audience of the requested token.'), duration: F('string', null, 'Requested lifetime of the issued token.'), 'bound-object-kind': F('string', null, 'Kind of an object to bind the token to.'), 'bound-object-name': F('string', null, 'Name of an object to bind the token to.'), 'bound-object-uid': F('string', null, 'UID of an object to bind the token to.') },
    async run(c) {
      const name = needName(c);
      const ns = c.ns();
      c.get(S.byId('serviceaccounts'), ns, name);
      const dur = c.flags.duration ? U.parseDuration(c.flags.duration) : 3600;
      c.out(c.cluster.saToken(ns, name, null, c.flags.audience, dur) + '\n');
    },
  };

  // ---------------- DELETE ----------------
  K.def('delete', {
    short: 'Delete resources by file names, stdin, resources and names, or by resources and label selector',
    usage: 'kubectl delete ([-f FILENAME] | [-k DIRECTORY] | TYPE [(NAME | -l label | --all)]) [flags] [options]',
    long: " Delete resources by file names, stdin, resources and names, or by resources and label selector.\n\n JSON and YAML formats are accepted. Only one type of argument may be specified: file names, resources and names, or resources and label selector.\n\n Some resources, such as pods, support graceful deletion. These resources define a default period before they are forcibly terminated (the grace period) but you may override that value with the --grace-period flag, or pass --now to set a grace-period of 1. Because these resources often represent entities in the cluster, deletion may not be acknowledged immediately. If the node hosting a pod is down or cannot reach the API server, termination may take significantly longer than the grace period. To force delete a resource, you must specify the --force flag. Note: only a subset of resources support graceful deletion. In absence of the support, the --grace-period flag is ignored.\n\n IMPORTANT: Force deleting pods does not wait for confirmation that the pod's processes have been terminated, which can leave those processes running until the node detects the deletion and completes graceful deletion. If your processes use shared storage or talk to a remote API and depend on the name of the pod to identify themselves, force deleting those pods may result in multiple processes running on different machines using the same identification which may lead to data corruption or inconsistency. Only force delete pods when you are sure the pod is terminated, or if your application can tolerate multiple copies of the same pod running at once. Also, if you force delete pods, the scheduler may place new pods on those nodes before the node has released those resources and causing those pods to be evicted immediately.\n\n Note that the delete command does NOT do resource version checks, so if someone submits an update to a resource right when you submit a delete, their update will be lost along with the rest of the resource.\n\n After a CustomResourceDefinition is deleted, invalidation of discovery cache may take up to 6 hours. If you don't want to wait, you might want to run \"kubectl api-resources\" to refresh the discovery cache.",
    example: '  # Delete a pod using the type and name specified in pod.json\n  kubectl delete -f ./pod.json\n  \n  # Delete resources from a directory containing kustomization.yaml - e.g. dir/kustomization.yaml\n  kubectl delete -k dir\n  \n  # Delete resources from all files that end with \'.json\'\n  kubectl delete -f \'*.json\'\n  \n  # Delete a pod based on the type and name in the JSON passed into stdin\n  cat pod.json | kubectl delete -f -\n  \n  # Delete pods and services with same names "baz" and "foo"\n  kubectl delete pod,service baz foo\n  \n  # Delete pods and services with label name=myLabel\n  kubectl delete pods,services -l name=myLabel\n  \n  # Delete a pod with minimal delay\n  kubectl delete pod foo --now\n  \n  # Force delete a pod on a dead node\n  kubectl delete pod foo --force\n  \n  # Delete all pods\n  kubectl delete pods --all\n  \n  # Delete all pods only if the user confirms the deletion\n  kubectl delete pods --all --interactive',
    flags: { ...FILES, ...SEL, ...DRY, output: F('string', 'o', 'Output mode. Use "-o name" for shorter output (resource/name).'), all: F('bool', null, 'Delete all resources, in the namespace of the specified resource types.'), 'grace-period': F('int', null, 'Period of time in seconds given to the resource to terminate gracefully. Ignored if negative. Set to 1 for immediate shutdown. Can only be set to 0 when --force is true (force deletion).'), force: F('bool', null, 'If true, immediately remove resources from API and bypass graceful deletion. Note that immediate deletion of some resources may result in inconsistency or data loss and requires confirmation.'), now: F('bool', null, 'If true, resources are signaled for immediate shutdown (same as --grace-period=1).'), wait: F('bool', null, 'If true, wait for resources to be gone before returning. This waits for finalizers.'), timeout: F('string', null, 'The length of time to wait before giving up on a delete, zero means determine a timeout from the size of the object'), cascade: F('string', null, 'Must be "background", "orphan", or "foreground". Selects the deletion cascading strategy for the dependents (e.g. Pods created by a ReplicationController). Defaults to background.', 'background'), 'ignore-not-found': F('bool', null, 'Treat "resource not found" as a successful delete. Defaults to "true" when --all is specified.'), interactive: F('bool', 'i', 'If true, delete resource only when user confirms.'), raw: F('string', null, 'Raw URI to DELETE to the server.  Uses the transport specified by the kubeconfig file.') },
    async run(c) {
      if (c.flags.raw) {
        const r = c.cluster.rest('DELETE', c.flags.raw, null, c.auth());
        if (r.status >= 400) throw Object.assign(new KS.ApiError(r.status, r.body.reason, r.body.message), { raw: true });
        c.out(JSON.stringify(r.body) + '\n');
        return;
      }
      if (c.pos.length && c.pos[0] === 'all' && !c.flags.all && c.pos.length === 1 && !c.flags.selector) c.fail('resource(s) were provided, but no name was specified');
      let grace = c.flags['grace-period'];
      if (c.flags.now) grace = 1;
      if (grace === 0 && !c.flags.force) grace = 1;
      if (c.flags.force && grace === undefined) grace = 0;
      if (c.flags.force && grace === 0) c.err('Warning: Immediate deletion does not wait for confirmation that the running resource has been terminated. The resource may continue to run on the cluster indefinitely.\n');
      let cascade = c.flags.cascade || 'background';
      if (cascade === 'true') cascade = 'background';
      if (cascade === 'false') { cascade = 'orphan'; c.err('warning: --cascade=false is deprecated (boolean value) and can be replaced with --cascade=orphan.\n'); }
      if (!['background', 'orphan', 'foreground'].includes(cascade)) c.fail(`invalid cascade value (${cascade}). Must be "background", "foreground", or "orphan".`);
      const policy = { background: 'Background', orphan: 'Orphan', foreground: 'Foreground' }[cascade];
      const list = c.collect({ verb: 'delete' });
      const ignoreNF = c.flags['ignore-not-found'] ?? !!c.flags.all;
      if (!list.length) {
        if (!ignoreNF || !c.flags.all) c.err(c.flags['all-namespaces'] ? 'No resources found\n' : `No resources found\n`);
        return;
      }
      if (c.flags.interactive) {
        c.out(`You are about to delete the following ${list.length} resource(s):\n${list.map((r) => `${r.t.kindRef}/${r.name}`).join('\n')}\n`);
        const ans = await c.env.readLine('Do you want to continue? (y/n): ');
        if (!/^y(es)?$/i.test((ans || '').trim())) { c.out('deletion is cancelled\n'); return; }
      }
      const dry = c.dryRun();
      let failed = false;
      const waitFor = [];
      for (const r of list) {
        try {
          if (dry === 'client') c.get(r.t, r.ns, r.name);
          else c.del(r.t, r.ns, r.name, { gracePeriodSeconds: grace, propagationPolicy: policy, dryRun: dry === 'server' });
          if (c.flags.force && grace === 0 && !dry) {
            const still = c.cluster.raw(r.t, r.ns, r.name);
            if (still) c.cluster.removeRaw(r.t, still);
          }
          if (c.flags.output === 'name') c.out(`${r.t.kindRef}/${r.name}\n`);
          else c.out(`${r.t.kindRef} "${r.name}" ${c.flags.force && grace === 0 ? 'force deleted' : 'deleted'}${c.drySuffix()}\n`);
          if (!dry) waitFor.push(r);
        } catch (e) {
          if (e instanceof KS.ApiError && e.code === 404 && ignoreNF) continue;
          failed = true;
          c.err(K.formatError(e, e.file ? { file: r.source, verb: 'deleting' } : {}) + '\n');
        }
      }
      if (c.flags.wait !== false && !(c.flags.force && grace === 0)) {
        const timeout = c.flags.timeout ? U.parseDuration(c.flags.timeout) * 1000 : 0;
        const start = Date.now();
        while (waitFor.some((r) => c.cluster.raw(r.t, r.ns, r.name))) {
          if (timeout && Date.now() - start > timeout) c.fail(`timed out waiting for the condition on ${waitFor[0].t.plural}/${waitFor[0].name}`);
          await c.sleep(200);
        }
      }
      if (failed) throw new Exit(1);
    },
  });

  // ---------------- EDIT ----------------
  K.editLoop = async (c, targets, opts = {}) => {
    const fmt = c.flags.output === 'json' ? 'json' : 'yaml';
    const objs = targets.map((r) => ({ r, o: c.get(r.t, r.ns, r.name) }));
    const header = "# Please edit the object below. Lines beginning with a '#' will be ignored,\n# and an empty file will abort the edit. If an error occurs while saving this file will be\n# reopened with the relevant failures.\n#\n";
    const render = (list) => {
      const clean = list.map(({ o }) => { const x = U.clone(o); delete x.metadata.managedFields; return x; });
      const data = clean.length === 1 ? clean[0] : { apiVersion: 'v1', items: clean, kind: 'List', metadata: { resourceVersion: '' } };
      return fmt === 'json' ? PR.json(data) : PR.yaml(data);
    };
    let original = render(objs);
    let content = header + original;
    const file = `/tmp/kubectl-edit-${U.rand(10)}.${fmt}`;
    for (;;) {
      const edited = await c.env.editor(file, content);
      if (edited === null) { c.out('Edit cancelled, no changes made.\n'); return; }
      const stripped = edited.split('\n').filter((l) => !l.startsWith('#')).join('\n');
      if (!stripped.trim()) { c.out('Edit cancelled, no changes made.\n'); return; }
      if (stripped.trim() === original.trim()) { c.out('Edit cancelled, no changes made.\n'); return; }
      let parsed;
      try {
        parsed = fmt === 'json' ? JSON.parse(stripped) : globalThis.jsyaml.load(stripped);
      } catch (e) {
        content = `# Edit cancelled, error parsing file: ${e.message.split('\n')[0]}\n#\n` + stripped;
        c.err(`error: error parsing ${file}: error converting YAML to JSON: yaml: ${(e.reason || e.message).split('\n')[0]}\n`);
        continue;
      }
      const items = parsed.kind === 'List' ? parsed.items : [parsed];
      const errors = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const orig = objs[i];
        if (!orig) continue;
        if (JSON.stringify(PR.sortKeys(it)) === JSON.stringify(PR.sortKeys(orig.o))) { c.out(`${orig.r.t.kindRef}/${orig.r.name} skipped\n`); continue; }
        if (it.metadata && it.metadata.name !== orig.o.metadata.name) { errors.push({ r: orig.r, msg: `the name of the object cannot be changed` }); continue; }
        try {
          if (c.flags['save-config']) it.metadata.annotations = { ...(it.metadata.annotations || {}), [LAST]: lastApplied(it) };
          if (opts.subresource === 'status') c.cluster.update(it, c.auth(), { subresource: 'status' });
          else c.update(it, {});
          c.out(`${orig.r.t.kindRef}/${orig.r.name} edited\n`);
        } catch (e) {
          errors.push({ r: orig.r, e });
        }
      }
      if (!errors.length) return;
      const lines = [];
      for (const er of errors) {
        if (er.e && er.e.causes) {
          lines.push(`# ${er.r.t.qualified} "${er.r.name}" was not valid:`);
          for (const cz of er.e.causes) lines.push(`# * ${cz}`);
        } else lines.push(`# ${er.e ? er.e.message : er.msg}`);
        lines.push('#');
      }
      const again = await c.env.confirmReopen?.();
      const tmp = `/tmp/kubectl-edit-${U.rand(10)}.yaml`;
      c.env.fs.write(tmp, stripped);
      if (again === false) {
        for (const er of errors) c.err(er.e ? K.formatError(er.e) + '\n' : `error: ${er.msg}\n`);
        c.err(`A copy of your changes has been stored to "${tmp}"\nerror: Edit cancelled, no valid changes were saved.\n`);
        throw new Exit(1);
      }
      content = lines.join('\n') + '\n' + header + stripped;
      original = stripped;
      const result = await c.env.editor(file, content);
      if (result === null || result.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim() === stripped.trim()) {
        for (const er of errors) c.err(er.e ? K.formatError(er.e) + '\n' : `error: ${er.msg}\n`);
        c.err(`A copy of your changes has been stored to "${tmp}"\nerror: Edit cancelled, no valid changes were saved.\n`);
        throw new Exit(1);
      }
      content = result;
      // reprocessa a versão editada novamente
      const again2 = result.split('\n').filter((l) => !l.startsWith('#')).join('\n');
      let p2;
      try { p2 = globalThis.jsyaml.load(again2); } catch (e) { c.fail(`error parsing edited file: ${e.message}`); }
      const its = p2.kind === 'List' ? p2.items : [p2];
      let bad = false;
      for (let i = 0; i < its.length; i++) {
        const orig = objs[i];
        try { c.update(its[i], {}); c.out(`${orig.r.t.kindRef}/${orig.r.name} edited\n`); } catch (e) { bad = true; c.err(K.formatError(e) + '\n'); }
      }
      if (bad) {
        c.env.fs.write(tmp, again2);
        c.err(`A copy of your changes has been stored to "${tmp}"\nerror: Edit cancelled, no valid changes were saved.\n`);
        throw new Exit(1);
      }
      return;
    }
  };
  K.def('edit', {
    short: 'Edit a resource on the server',
    usage: 'kubectl edit (RESOURCE/NAME | -f FILENAME) [flags] [options]',
    long: ' Edit a resource from the default editor.\n\n The edit command allows you to directly edit any API resource you can retrieve via the command-line tools. It will open the editor defined by your KUBE_EDITOR, or EDITOR environment variables, or fall back to \'vi\' for Linux or \'notepad\' for Windows. When attempting to open the editor, it will first attempt to use the shell that has been defined in the \'SHELL\' environment variable. If this is not defined, the default shell will be used, which is \'/bin/bash\' for Linux or \'cmd\' for Windows.\n\n You can edit multiple objects, although changes are applied one at a time. The command accepts file names as well as command-line arguments, although the files you point to must be previously saved versions of resources.\n\n Editing is done with the API version used to fetch the resource. To edit using a specific API version, fully-qualify the resource, version, and group.\n\n The default format is YAML. To edit in JSON, specify "-o json".\n\n The flag --windows-line-endings can be used to force Windows line endings, otherwise the default for your operating system will be used.\n\n In the event an error occurs while updating, a temporary file will be created on disk that contains your unapplied changes. The most common error when updating a resource is another editor changing the resource on the server. When this occurs, you will have to apply your changes to the newer version of the resource, or update your temporary saved copy to include the latest resource version.',
    example: '  # Edit the service named \'registry\'\n  kubectl edit svc/registry\n  \n  # Use an alternative editor\n  KUBE_EDITOR="nano" kubectl edit svc/registry\n  \n  # Edit the job \'myjob\' in JSON using the v1 API format\n  kubectl edit job.v1.batch/myjob -o json\n  \n  # Edit the deployment \'mydeployment\' in YAML and save the modified config in its annotation\n  kubectl edit deployment/mydeployment -o yaml --save-config\n  \n  # Edit the \'status\' subresource for the \'mydeployment\' deployment\n  kubectl edit deployment mydeployment --subresource=\'status\'',
    flags: { ...FILES, ...PRINT, ...COMMON_W, 'output-patch': F('bool', null, 'Output the patch if the resource is edited.'), 'windows-line-endings': F('bool', null, 'Defaults to the line ending native to your platform.'), subresource: F('string', null, 'If specified, edit will operate on the subresource of the requested object. Must be one of [status].') },
    async run(c) {
      const list = c.collect({ verb: 'edit' });
      await K.editLoop(c, list, { subresource: c.flags.subresource });
    },
  });

  // ---------------- PATCH ----------------
  K.def('patch', {
    short: 'Update fields of a resource',
    usage: 'kubectl patch (-f FILENAME | TYPE NAME) [-p PATCH|--patch-file FILE] [flags] [options]',
    long: ' Update fields of a resource using strategic merge patch, a JSON merge patch, or a JSON patch.\n\n JSON and YAML formats are accepted.\n\n Note: Strategic merge patch is not supported for custom resources.',
    example: '  # Partially update a node using a strategic merge patch, specifying the patch as JSON\n  kubectl patch node k8s-node-1 -p \'{"spec":{"unschedulable":true}}\'\n  \n  # Partially update a node using a strategic merge patch, specifying the patch as YAML\n  kubectl patch node k8s-node-1 -p $\'spec:\\n unschedulable: true\'\n  \n  # Partially update a node identified by the type and name specified in "node.json" using strategic merge patch\n  kubectl patch -f node.json -p \'{"spec":{"unschedulable":true}}\'\n  \n  # Update a container\'s image; spec.containers[*].name is required because it\'s a merge key\n  kubectl patch pod valid-pod -p \'{"spec":{"containers":[{"name":"kubernetes-serve-hostname","image":"new image"}]}}\'\n  \n  # Update a container\'s image using a JSON patch with positional arrays\n  kubectl patch pod valid-pod --type=\'json\' -p=\'[{"op": "replace", "path": "/spec/containers/0/image", "value":"new image"}]\'\n  \n  # Update a deployment\'s replicas through the \'scale\' subresource using a merge patch\n  kubectl patch deployment nginx-deployment --subresource=\'scale\' --type=\'merge\' -p \'{"spec":{"replicas":2}}\'',
    flags: { ...FILES, ...PRINT, ...DRY, patch: F('string', 'p', 'The patch to be applied to the resource JSON file.'), 'patch-file': F('string', null, 'A file containing a patch to be applied to the resource.'), type: F('string', null, 'The type of patch being provided; one of [json merge strategic]'), local: F('bool', null, 'If true, patch will operate on the content of the file, not the server-side resource.'), subresource: F('string', null, 'If specified, patch will operate on the subresource of the requested object. Must be one of [status scale].'), 'field-manager': F('string', null, 'Name of the manager used to track field ownership.'), record: COMMON_W.record },
    async run(c) {
      let ptxt = c.flags.patch;
      if (c.flags['patch-file']) { ptxt = c.env.fs.read(c.flags['patch-file']); if (ptxt === null) c.fail(`unable to read patch file: open ${c.flags['patch-file']}: no such file or directory`); }
      if (!ptxt) c.fail('must specify -p to patch');
      let p;
      try { p = JSON.parse(ptxt); } catch (e) {
        try { p = globalThis.jsyaml.load(ptxt); } catch (e2) { c.fail(`unable to parse "${ptxt}": yaml: ${e2.reason || e2.message}`); }
      }
      const type = c.flags.type || 'strategic';
      if (!['json', 'merge', 'strategic'].includes(type)) c.fail(`--type must be one of [json merge strategic], not "${type}"`);
      const list = c.collect({ verb: 'patch', noNameMsg: 'resource(s) were provided, but no name was specified' });
      for (const r of list) {
        const before = c.get(r.t, r.ns, r.name);
        let res;
        try {
          if (c.dryRun() === 'client' || c.flags.local) {
            res = type === 'json' ? U.jsonPatch(before, p) : type === 'merge' ? U.mergePatch(before, p) : U.strategicMerge(before, p);
          } else res = c.patch(r.t, r.ns, r.name, p, type, { dryRun: c.dryRun() === 'server', subresource: c.flags.subresource });
        } catch (e) {
          if (e instanceof KS.ApiError) throw e;
          throw new Exit(1, `The request is invalid: ${e.message}`);
        }
        const changed = res._changed || JSON.stringify(PR.sortKeys({ ...res, metadata: { ...res.metadata, resourceVersion: '' } })) !== JSON.stringify(PR.sortKeys({ ...before, metadata: { ...before.metadata, resourceVersion: '' } }));
        delete res._changed;
        if (c.flags.output && c.flags.output !== 'name') c.printObjects([{ t: r.t, o: res }], { single: true });
        else if (c.flags.output === 'name') c.out(`${r.t.kindRef}/${r.name}\n`);
        else c.out(`${r.t.kindRef}/${r.name} patched${changed ? '' : ' (no change)'}${c.drySuffix()}\n`);
      }
    },
  });

  // ---------------- REPLACE ----------------
  K.def('replace', {
    short: 'Replace a resource by file name or stdin',
    usage: 'kubectl replace -f FILENAME [flags] [options]',
    long: ' Replace a resource by file name or stdin.\n\n JSON and YAML formats are accepted. If replacing an existing resource, the complete resource spec must be provided. This can be obtained by\n\n        $ kubectl get TYPE NAME -o yaml',
    example: '  # Replace a pod using the data in pod.json\n  kubectl replace -f ./pod.json\n  \n  # Replace a pod based on the JSON passed into stdin\n  cat pod.json | kubectl replace -f -\n  \n  # Update a single-container pod\'s image version (tag) to v4\n  kubectl get pod mypod -o yaml | sed \'s/\\(image: myimage\\):.*$/\\1:v4/\' | kubectl replace -f -\n  \n  # Force replace, delete and then re-create the resource\n  kubectl replace --force -f ./pod.json',
    flags: { ...FILES, ...PRINT, ...DRY, ...COMMON_W, force: F('bool', null, 'If true, immediately remove resources from API and bypass graceful deletion.'), 'grace-period': F('int', null, 'Period of time in seconds given to the resource to terminate gracefully.'), cascade: F('string', null, 'Must be "background", "orphan", or "foreground".', 'background'), wait: F('bool', null, 'If true, wait for resources to be gone before returning.'), timeout: F('string', null, 'The length of time to wait before giving up on a delete'), raw: F('string', null, 'Raw URI to PUT to the server.'), subresource: F('string', null, 'If specified, replace will operate on the subresource of the requested object.') },
    async run(c) {
      if (c.flags.raw) {
        const obj = PR.parseYAMLDocs(c.readSource((c.flags.filename || [])[0] || '-'))[0];
        const r = c.cluster.rest('PUT', c.flags.raw, obj, c.auth());
        if (r.status >= 400) throw Object.assign(new KS.ApiError(r.status, r.body.reason, r.body.message), { raw: true });
        c.out(JSON.stringify(r.body) + '\n');
        return;
      }
      if (!(c.flags.filename || []).length) c.fail('must specify --filename to replace');
      let failed = false;
      for (const m of c.manifests({ verb: 'replace' })) {
        const obj = U.clone(m.obj);
        const t = c.mapObj(obj, m.source);
        if (t.namespaced) obj.metadata.namespace = obj.metadata.namespace || c.ns();
        try {
          if (c.flags.force) {
            try {
              c.del(t, obj.metadata.namespace, obj.metadata.name, { gracePeriodSeconds: c.flags['grace-period'] ?? 1 });
              c.out(`${t.singular} "${obj.metadata.name}" deleted\n`);
              while (c.cluster.raw(t, obj.metadata.namespace, obj.metadata.name)) await c.sleep(150);
            } catch (e) { if (!(e instanceof KS.ApiError && e.code === 404)) throw e; }
            delete obj.metadata.resourceVersion;
            const r = c.create(obj, {});
            c.printOp(t, r, 'replaced');
            continue;
          }
          c.strictCheck(t, obj, m.source, 'replacing');
          if (c.flags['save-config']) obj.metadata.annotations = { ...(obj.metadata.annotations || {}), [LAST]: lastApplied(obj) };
          const r = c.dryRun() === 'client' ? obj : c.update(obj, { dryRun: c.dryRun() === 'server', subresource: c.flags.subresource });
          c.printOp(t, r, 'replaced');
        } catch (e) {
          failed = true;
          c.err(K.formatError(e, { file: m.source, verb: 'replacing' }) + '\n');
        }
      }
      if (failed) throw new Exit(1);
    },
  });

  // ---------------- LABEL / ANNOTATE ----------------
  const labelLike = (field, verbPast, isLabel) => async (c) => {
    const args = [...c.pos];
    const changes = [];
    while (args.length && /=|-$/.test(args[args.length - 1]) && !(args.length === 1 && !(c.flags.filename || []).length)) changes.unshift(args.pop());
    if (!changes.length && !c.flags.list) c.fail(`at least one ${isLabel ? 'label' : 'annotation'} update is required`);
    const sets = {}, removes = [];
    for (const ch of changes) {
      if (ch.endsWith('-') && !ch.includes('=')) { removes.push(ch.slice(0, -1)); continue; }
      const i = ch.indexOf('=');
      const k = ch.slice(0, i), v = ch.slice(i + 1);
      if (isLabel) {
        if (!U.validLabelKey(k)) c.fail(`invalid label spec: ${ch}`);
        if (!U.validLabelValue(v)) c.fail(`invalid label value: "${ch}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
      }
      sets[k] = v;
    }
    const list = c.collect({ args, verb: isLabel ? 'label' : 'annotate' });
    if (!list.length) { c.err('No resources found\n'); return; }
    for (const r of list) {
      const o = r.obj || c.get(r.t, r.ns, r.name);
      const cur = { ...(o.metadata[field] || {}) };
      if (c.flags.list) {
        for (const [k, v] of Object.entries(cur).sort()) c.out(`${k}=${v}\n`);
        continue;
      }
      if (c.flags['resource-version'] && o.metadata.resourceVersion !== c.flags['resource-version'])
        throw new KS.ApiError(409, 'Conflict', `Operation cannot be fulfilled on ${r.t.qualified} "${r.name}": the object has been modified; please apply your changes to the latest version and try again`);
      for (const [k, v] of Object.entries(sets)) {
        if (k in cur && cur[k] !== v && !c.flags.overwrite) c.fail(`'${k}' already has a value (${cur[k]}), and --overwrite is false`);
      }
      const next = { ...cur, ...sets };
      let removedMissing = false;
      for (const k of removes) {
        if (!(k in next)) { c.out(`${isLabel ? 'label' : 'annotation'} "${k}" not found.\n`); removedMissing = true; }
        delete next[k];
      }
      const changed = JSON.stringify(next) !== JSON.stringify(cur);
      if (changed && !c.dryRun()) {
        const patch = { metadata: { [field]: {} } };
        for (const k of Object.keys(sets)) patch.metadata[field][k] = sets[k];
        for (const k of removes) patch.metadata[field][k] = null;
        c.patch(r.t, r.ns, r.name, patch, 'merge', {});
      }
      if (c.flags.output && c.flags.output !== 'name') { o.metadata[field] = next; c.printObjects([{ t: r.t, o }], { single: true }); continue; }
      const word = !changed ? `not ${verbPast}` : Object.keys(sets).length ? verbPast : `un${verbPast}`;
      c.out(`${r.t.kindRef}/${r.name} ${word}${c.drySuffix()}\n`);
      void removedMissing;
    }
  };
  const labelFlags = { ...FILES, ...PRINT, ...DRY, selector: SEL.selector, 'field-selector': SEL['field-selector'], 'all-namespaces': SEL['all-namespaces'], all: F('bool', null, 'Select all resources, in the namespace of the specified resource types'), overwrite: F('bool', null, 'If true, allow labels to be overwritten, otherwise reject label updates that overwrite existing labels.'), list: F('bool', null, 'If true, display the labels for a given resource.'), local: F('bool', null, 'If true, label will NOT contact api-server but run locally.'), 'resource-version': F('string', null, 'If non-empty, the labels update will only succeed if this is the current resource-version for the object. Only valid when specifying a single resource.'), 'field-manager': F('string', null, 'Name of the manager used to track field ownership.') };
  K.def('label', {
    short: 'Update the labels on a resource',
    usage: 'kubectl label [--overwrite] (-f FILENAME | TYPE NAME) KEY_1=VAL_1 ... KEY_N=VAL_N [--resource-version=version] [flags] [options]',
    long: ' Update the labels on a resource.\n\n  *  A label key and value must begin with a letter or number, and may contain letters, numbers, hyphens, dots, and underscores, up to 63 characters each.\n  *  Optionally, the key can begin with a DNS subdomain prefix and a single \'/\', like example.com/my-app.\n  *  If --overwrite is true, then existing labels can be overwritten, otherwise attempting to overwrite a label will result in an error.\n  *  If --resource-version is specified, then updates will use this resource version, otherwise the existing resource-version will be used.',
    example: '  # Update pod \'foo\' with the label \'unhealthy\' and the value \'true\'\n  kubectl label pods foo unhealthy=true\n  \n  # Update pod \'foo\' with the label \'status\' and the value \'unhealthy\', overwriting any existing value\n  kubectl label --overwrite pods foo status=unhealthy\n  \n  # Update all pods in the namespace\n  kubectl label pods --all status=unhealthy\n  \n  # Update a pod identified by the type and name in "pod.json"\n  kubectl label -f pod.json status=unhealthy\n  \n  # Update pod \'foo\' only if the resource is unchanged from version 1\n  kubectl label pods foo status=unhealthy --resource-version=1\n  \n  # Update pod \'foo\' by removing a label named \'bar\' if it exists\n  # Does not require the --overwrite flag\n  kubectl label pods foo bar-',
    flags: labelFlags,
    run: labelLike('labels', 'labeled', true),
  });
  K.def('annotate', {
    short: 'Update the annotations on a resource',
    usage: 'kubectl annotate [--overwrite] (-f FILENAME | TYPE NAME) KEY_1=VAL_1 ... KEY_N=VAL_N [--resource-version=version] [flags] [options]',
    long: ' Update the annotations on one or more resources.\n\n All Kubernetes objects support the ability to store additional data with the object as annotations. Annotations are key/value pairs that can be larger than labels and include arbitrary string values such as structured JSON. Tools and system extensions may use annotations to store their own data.\n\n Attempting to set an annotation that already exists will fail unless --overwrite is set. If --resource-version is specified and does not match the current resource version on the server the command will fail.\n\nUse "kubectl api-resources" for a complete list of supported resources.',
    example: "  # Update pod 'foo' with the annotation 'description' and the value 'my frontend'\n  # If the same annotation is set multiple times, only the last value will be applied\n  kubectl annotate pods foo description='my frontend'\n  \n  # Update pod 'foo' with the annotation 'description' and the value 'my frontend running nginx', overwriting any existing value\n  kubectl annotate --overwrite pods foo description='my frontend running nginx'\n  \n  # Update all pods in the namespace\n  kubectl annotate pods --all description='my frontend running nginx'\n  \n  # Update pod 'foo' by removing an annotation named 'description' if it exists\n  # Does not require the --overwrite flag\n  kubectl annotate pods foo description-",
    flags: labelFlags,
    run: labelLike('annotations', 'annotated', false),
  });

  // ---------------- SCALE / AUTOSCALE ----------------
  K.def('scale', {
    short: 'Set a new size for a deployment, replica set, or replication controller',
    usage: 'kubectl scale [--resource-version=version] [--current-replicas=count] --replicas=COUNT (-f FILENAME | TYPE NAME) [flags] [options]',
    long: ' Set a new size for a deployment, replica set, replication controller, or stateful set.\n\n Scale also allows users to specify one or more preconditions for the scale action.\n\n If --current-replicas or --resource-version is specified, it is validated before the scale is attempted, and it is guaranteed that the precondition holds true when the scale is sent to the server.',
    example: '  # Scale a replica set named \'foo\' to 3\n  kubectl scale --replicas=3 rs/foo\n  \n  # Scale a resource identified by type and name specified in "foo.yaml" to 3\n  kubectl scale --replicas=3 -f foo.yaml\n  \n  # If the deployment named mysql\'s current size is 2, scale mysql to 3\n  kubectl scale --current-replicas=2 --replicas=3 deployment/mysql\n  \n  # Scale multiple replication controllers\n  kubectl scale --replicas=5 rc/example1 rc/example2 rc/example3\n  \n  # Scale stateful set named \'web\' to 3\n  kubectl scale --replicas=3 statefulset/web',
    flags: { ...FILES, ...PRINT, ...DRY, selector: SEL.selector, all: F('bool', null, 'Select all resources in the namespace of the specified resource types'), replicas: F('int', null, 'The new desired number of replicas. Required.'), 'current-replicas': F('int', null, 'Precondition for current size. Requires that the current size of the resource match this value in order to scale.'), 'resource-version': F('string', null, 'Precondition for resource version.'), timeout: F('string', null, 'The length of time to wait before giving up on a scale operation, zero means don\'t wait.') },
    async run(c) {
      if (c.flags.replicas === undefined) c.fail('required flag(s) "replicas" not set');
      if (c.flags.replicas < 0) c.fail('The --replicas=COUNT flag is required, and COUNT must be greater than or equal to 0');
      const list = c.collect({ verb: 'scale' });
      for (const r of list) {
        const o = c.get(r.t, r.ns, r.name);
        if (!['deployments.apps', 'replicasets.apps', 'statefulsets.apps', 'replicationcontrollers'].includes(r.t.id) && !(r.t.crd && o.spec && 'replicas' in o.spec))
          throw Object.assign(new KS.ApiError(404, 'NotFound', 'the server could not find the requested resource'), { raw: true });
        if (c.flags['current-replicas'] !== undefined && o.spec.replicas !== c.flags['current-replicas']) c.fail(`Expected replicas to be ${c.flags['current-replicas']}, was ${o.spec.replicas}`);
        if (!c.dryRun()) c.patch(r.t, r.ns, r.name, { spec: { replicas: c.flags.replicas } }, 'merge', { subresource: 'scale' });
        c.printOp(r.t, { ...o, spec: { ...o.spec, replicas: c.flags.replicas } }, 'scaled');
      }
    },
  });
  K.def('autoscale', {
    short: 'Auto-scale a deployment, replica set, stateful set, or replication controller',
    usage: 'kubectl autoscale (-f FILENAME | TYPE NAME | TYPE/NAME) [--min=MINPODS] --max=MAXPODS [--cpu-percent=CPU] [flags] [options]',
    long: ' Creates an autoscaler that automatically chooses and sets the number of pods that run in a Kubernetes cluster.\n\n Looks up a deployment, replica set, stateful set, or replication controller by name and creates an autoscaler that uses the given resource as a reference. An autoscaler can automatically increase or decrease number of pods deployed within the system as needed.',
    example: '  # Auto scale a deployment "foo", with the number of pods between 2 and 10, no target CPU utilization specified so a default autoscaling policy will be used\n  kubectl autoscale deployment foo --min=2 --max=10\n  \n  # Auto scale a replication controller "foo", with the number of pods between 1 and 5, target CPU utilization at 80%\n  kubectl autoscale rc foo --max=5 --cpu-percent=80',
    flags: { ...FILES, ...PRINT, ...DRY, ...COMMON_W, min: F('int', null, 'The lower limit for the number of pods that can be set by the autoscaler. If it\'s not specified or negative, the server will apply a default value.'), max: F('int', null, 'The upper limit for the number of pods that can be set by the autoscaler. Required.'), 'cpu-percent': F('int', null, 'The target average CPU utilization (represented as a percent of requested CPU) over all the pods. If it\'s not specified or negative, a default autoscaling policy will be used.'), name: F('string', null, 'The name for the newly created object. If not specified, the name of the input resource will be used.') },
    async run(c) {
      if (!c.flags.max || c.flags.max < 1) c.fail(`--max=MAXPODS is required and must be at least 1, max: ${c.flags.max || 0}`);
      if (c.flags.min !== undefined && c.flags.min > c.flags.max) c.fail(`--max=MAXPODS must be larger or equal to --min=MINPODS, max: ${c.flags.max}, min: ${c.flags.min}`);
      for (const r of c.collect({ verb: 'autoscale' })) {
        if (!['deployments.apps', 'replicasets.apps', 'statefulsets.apps', 'replicationcontrollers'].includes(r.t.id)) c.fail(`cannot autoscale a ${r.t.kind}: ${r.t.kind} is not a scalable resource`);
        const o = c.get(r.t, r.ns, r.name);
        const hpa = {
          apiVersion: 'autoscaling/v2', kind: 'HorizontalPodAutoscaler',
          metadata: { creationTimestamp: null, name: c.flags.name || r.name, namespace: r.ns },
          spec: { maxReplicas: c.flags.max, ...(c.flags.min !== undefined && c.flags.min > 0 ? { minReplicas: c.flags.min } : {}), scaleTargetRef: { apiVersion: o.apiVersion, kind: o.kind, name: r.name } },
          status: { currentMetrics: null, desiredReplicas: 0 },
        };
        if (c.flags['cpu-percent'] !== undefined && c.flags['cpu-percent'] >= 0) hpa.spec.metrics = [{ resource: { name: 'cpu', target: { averageUtilization: c.flags['cpu-percent'], type: 'Utilization' } }, type: 'Resource' }];
        if (!c.nsExplicit()) delete hpa.metadata.namespace;
        const t = S.byId('horizontalpodautoscalers.autoscaling');
        if (c.dryRun() === 'client') { if (c.flags.output) c.printObjects([{ t, o: hpa }], { single: true }); else c.out(`${t.kindRef}/${hpa.metadata.name} autoscaled (dry run)\n`); continue; }
        const created = c.create(hpa, { dryRun: c.dryRun() === 'server' });
        c.printOp(t, created, 'autoscaled');
      }
    },
  });

  // ---------------- EXPOSE ----------------
  K.def('expose', {
    short: 'Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service',
    usage: 'kubectl expose (-f FILENAME | TYPE NAME) [--port=port] [--protocol=TCP|UDP|SCTP] [--target-port=number-or-name] [--name=name] [--external-ip=external-ip-of-service] [--type=type] [flags] [options]',
    long: " Expose a resource as a new Kubernetes service.\n\n Looks up a deployment, service, replica set, replication controller or pod by name and uses the selector for that resource as the selector for a new service on the specified port. A deployment or replica set will be exposed as a service only if its selector is convertible to a selector that service supports, i.e. when the selector contains only the matchLabels component. Note that if no port is specified via --port and the exposed resource has multiple ports, all will be re-used by the new service. Also if no labels are specified, the new service will re-use the labels from the resource it exposes.\n\n Possible resources include (case insensitive):\n\n pod (po), service (svc), replicationcontroller (rc), deployment (deploy), replicaset (rs)",
    example: '  # Create a service for a replicated nginx, which serves on port 80 and connects to the containers on port 8000\n  kubectl expose rc nginx --port=80 --target-port=8000\n  \n  # Create a service for a replication controller identified by type and name specified in "nginx-controller.yaml", which serves on port 80 and connects to the containers on port 8000\n  kubectl expose -f nginx-controller.yaml --port=80 --target-port=8000\n  \n  # Create a service for a pod valid-pod, which serves on port 444 with the name "frontend"\n  kubectl expose pod valid-pod --port=444 --name=frontend\n  \n  # Create a second service based on the above service, exposing the container port 8443 as port 443 with the name "nginx-https"\n  kubectl expose service nginx --port=443 --target-port=8443 --name=nginx-https\n  \n  # Create a service for a replicated streaming application on port 4100 balancing UDP traffic and named \'video-stream\'.\n  kubectl expose rc streamer --port=4100 --protocol=UDP --name=video-stream\n  \n  # Create a service for a replicated nginx using replica set, which serves on port 80 and connects to the containers on port 8000\n  kubectl expose rs nginx --port=80 --target-port=8000\n  \n  # Create a service for an nginx deployment, which serves on port 80 and connects to the containers on port 8000\n  kubectl expose deployment nginx --port=80 --target-port=8000',
    flags: { ...FILES, ...PRINT, ...DRY, ...COMMON_W, port: F('string', null, 'The port that the service should serve on. Copied from the resource being exposed, if unspecified'), 'target-port': F('string', null, 'Name or number for the port on the container that the service should direct traffic to. Optional.'), protocol: F('string', null, 'The network protocol for the service to be created. Default is \'TCP\'.'), name: F('string', null, 'The name for the newly created object.'), type: F('string', null, 'Type for this service: ClusterIP, NodePort, LoadBalancer, or ExternalName. Default is \'ClusterIP\'.'), selector: F('string', null, 'A label selector to use for this service. Only equality-based selector requirements are supported. If empty (the default) infer the selector from the replication controller or replica set.)'), labels: F('string', 'l', 'Labels to apply to the service created by this call.'), 'external-ip': F('string', null, 'Additional external IP address (not managed by Kubernetes) to accept for the service.'), 'cluster-ip': F('string', null, 'ClusterIP to be assigned to the service. Leave empty to auto-allocate, or set to \'None\' to create a headless service.'), 'load-balancer-ip': F('string', null, 'IP to assign to the LoadBalancer. If empty, an ephemeral IP will be created and used (cloud-provider specific).'), 'session-affinity': F('string', null, 'If non-empty, set the session affinity for the service to this; legal values: \'None\', \'ClientIP\''), overrides: F('string', null, 'An inline JSON override for the generated object.') },
    async run(c) {
      const list = c.collect({ verb: 'expose' });
      for (const r of list) {
        const o = c.get(r.t, r.ns, r.name);
        let selector;
        let ports = [];
        const tplSpec = r.t.id === 'pods' ? o.spec : o.spec.template ? o.spec.template.spec : null;
        if (c.flags.selector) { selector = {}; for (const kv of c.flags.selector.split(',')) { const [k, v] = kv.split('='); selector[k] = v; } }
        else if (r.t.id === 'pods') {
          selector = o.metadata.labels;
          if (!selector || !Object.keys(selector).length) c.fail(`couldn't retrieve selectors via --selector flag or introspection: the pod has no labels and cannot be exposed`);
        } else if (r.t.id === 'services') selector = o.spec.selector;
        else if (r.t.id === 'replicationcontrollers') selector = o.spec.selector;
        else if (['deployments.apps', 'replicasets.apps', 'statefulsets.apps', 'daemonsets.apps'].includes(r.t.id)) {
          if ((o.spec.selector.matchExpressions || []).length) c.fail(`couldn't convert expressions - "${U.selectorString(o.spec.selector)}" to map: operator "${o.spec.selector.matchExpressions[0].operator}" without a single value cannot be converted into the old label selector format`);
          selector = o.spec.selector.matchLabels;
        } else c.fail(`cannot expose a ${r.t.kind}`);
        if (c.flags.port) {
          for (const p of c.flags.port.split(',')) ports.push({ port: Number(p), protocol: c.flags.protocol || 'TCP', targetPort: c.flags['target-port'] ? (/^\d+$/.test(c.flags['target-port']) ? Number(c.flags['target-port']) : c.flags['target-port']) : Number(p) });
        } else if (r.t.id === 'services') {
          ports = (o.spec.ports || []).map((p) => ({ name: p.name, port: p.port, protocol: p.protocol, targetPort: c.flags['target-port'] ? (/^\d+$/.test(c.flags['target-port']) ? Number(c.flags['target-port']) : c.flags['target-port']) : p.targetPort }));
        } else {
          const cps = [];
          for (const ct of (tplSpec && tplSpec.containers) || []) for (const p of ct.ports || []) cps.push(p);
          if (!cps.length) c.fail("couldn't find port via --port flag or introspection\nSee 'kubectl expose -h' for help and examples");
          ports = cps.map((p, i) => ({ ...(cps.length > 1 ? { name: p.name || `port-${i + 1}` } : {}), port: p.containerPort, protocol: c.flags.protocol || p.protocol || 'TCP', targetPort: c.flags['target-port'] ? (/^\d+$/.test(c.flags['target-port']) ? Number(c.flags['target-port']) : c.flags['target-port']) : p.containerPort }));
        }
        if (ports.length > 1) ports.forEach((p, i) => (p.name = p.name || `port-${i + 1}`));
        const labels = {};
        if (c.flags.labels) for (const kv of c.flags.labels.split(',')) { const [k, v] = kv.split('='); labels[k] = v; }
        else Object.assign(labels, o.metadata.labels || {});
        const svc = {
          apiVersion: 'v1', kind: 'Service',
          metadata: { creationTimestamp: null, ...(Object.keys(labels).length ? { labels } : {}), name: c.flags.name || r.name, ...(c.nsExplicit() || true ? { namespace: r.ns } : {}) },
          spec: { ports, selector: { ...selector }, ...(c.flags.type ? { type: c.flags.type } : {}), ...(c.flags['cluster-ip'] ? { clusterIP: c.flags['cluster-ip'] } : {}), ...(c.flags['external-ip'] ? { externalIPs: [c.flags['external-ip']] } : {}), ...(c.flags['session-affinity'] ? { sessionAffinity: c.flags['session-affinity'] } : {}) },
          status: { loadBalancer: {} },
        };
        if (c.flags.type && !['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'].includes(c.flags.type)) c.fail(`invalid type: ${c.flags.type}`);
        if (c.dryRun() === 'client') delete svc.metadata.namespace;
        const t = S.byId('services');
        if (c.dryRun() === 'client') { if (c.flags.output) c.printObjects([{ t, o: svc }], { single: true }); else c.out(`service/${svc.metadata.name} exposed (dry run)\n`); continue; }
        const created = c.create(svc, { dryRun: c.dryRun() === 'server' });
        c.printOp(t, created, 'exposed');
      }
    },
  });

  // ---------------- RUN ----------------
  K.def('run', {
    short: 'Run a particular image on the cluster',
    usage: 'kubectl run NAME --image=image [--env="key=value"] [--port=port] [--dry-run=server|client] [--overrides=inline-json] [--command] -- [COMMAND] [args...] [options]',
    long: ' Create and run a particular image in a pod.',
    example: '  # Start a nginx pod\n  kubectl run nginx --image=nginx\n  \n  # Start a hazelcast pod and let the container expose port 5701\n  kubectl run hazelcast --image=hazelcast/hazelcast --port=5701\n  \n  # Start a hazelcast pod and set environment variables "DNS_DOMAIN=cluster" and "POD_NAMESPACE=default" in the container\n  kubectl run hazelcast --image=hazelcast/hazelcast --env="DNS_DOMAIN=cluster" --env="POD_NAMESPACE=default"\n  \n  # Start a hazelcast pod and set labels "app=hazelcast" and "env=prod" in the container\n  kubectl run hazelcast --image=hazelcast/hazelcast --labels="app=hazelcast,env=prod"\n  \n  # Dry run; print the corresponding API objects without creating them\n  kubectl run nginx --image=nginx --dry-run=client\n  \n  # Start a nginx pod, but overload the spec with a partial set of values parsed from JSON\n  kubectl run nginx --image=nginx --overrides=\'{ "apiVersion": "v1", "spec": { ... } }\'\n  \n  # Start a busybox pod and keep it in the foreground, don\'t restart it if it exits\n  kubectl run -i -t busybox --image=busybox --restart=Never\n  \n  # Start the nginx pod using the default command, but use custom arguments (arg1 .. argN) for that command\n  kubectl run nginx --image=nginx -- <arg1> <arg2> ... <argN>\n  \n  # Start the nginx pod using a different command and custom arguments\n  kubectl run nginx --image=nginx --command -- <cmd> <arg1> ... <argN>',
    flags: { ...PRINT, ...DRY, ...COMMON_W, image: F('string', null, 'The image for the container to run.'), env: F('stringArray', null, 'Environment variables to set in the container.'), port: F('string', null, 'The port that this container exposes.'), labels: F('string', 'l', 'Comma separated labels to apply to the pod. Will override previous values.'), annotations: F('stringArray', null, 'Annotations to apply to the pod.'), restart: F('string', null, 'The restart policy for this Pod.  Legal values [Always, OnFailure, Never].'), command: F('bool', null, 'If true and extra arguments are present, use them as the \'command\' field in the container, rather than the \'args\' field which is the default.'), stdin: F('bool', 'i', 'Keep stdin open on the container in the pod, even if nothing is attached.'), tty: F('bool', 't', 'Allocate a TTY for the container in the pod.'), rm: F('bool', null, 'If true, delete the pod after it exits.  Only valid when attaching to the container, e.g. with \'--attach\' or with \'-i/--stdin\'.'), attach: F('bool', null, 'If true, wait for the Pod to start running, and then attach to the Pod as if \'kubectl attach ...\' were called.'), quiet: F('bool', 'q', 'If true, suppress prompt messages.'), expose: F('bool', null, 'If true, create a ClusterIP service associated with the pod.  Requires `--port`.'), overrides: F('string', null, 'An inline JSON override for the generated object.'), 'image-pull-policy': F('string', null, 'The image pull policy for the container.'), privileged: F('bool', null, 'If true, run the container in privileged mode.'), 'pod-running-timeout': F('string', null, 'The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running'), timeout: F('string', null, 'The length of time to wait before giving up on a delete'), cascade: F('string', null, 'Must be "background", "orphan", or "foreground".', 'background'), filename: F('strings', 'f', 'to use to replace the resource.'), force: F('bool', null, 'If true, immediately remove resources from API and bypass graceful deletion.'), 'grace-period': F('int', null, 'Period of time in seconds given to the resource to terminate gracefully.'), 'leave-stdin-open': F('bool', null, 'If the pod is started in interactive mode or with stdin, leave stdin open after the first attach completes.'), wait: F('bool', null, 'If true, wait for resources to be gone before returning. This waits for finalizers.') },
    async run(c) {
      if (!c.pos.length) c.usageFail('NAME is required for run');
      const name = c.pos[0];
      if (!c.flags.image) c.fail('required flag(s) "image" not set');
      const restart = c.flags.restart || 'Always';
      if (!['Always', 'OnFailure', 'Never'].includes(restart)) c.fail(`invalid restart policy: ${restart}`);
      const labels = {};
      if (c.flags.labels) for (const kv of c.flags.labels.split(',')) { const [k, v] = kv.split('='); labels[k] = v; }
      else labels.run = name;
      const ct = { image: c.flags.image, name, resources: {} };
      const extra = [...c.pos.slice(1), ...(c.dash || [])];
      if (extra.length) { if (c.flags.command) ct.command = extra; else ct.args = extra; }
      if (c.flags.env) ct.env = c.flags.env.map((e) => { const i = e.indexOf('='); return { name: e.slice(0, i), value: e.slice(i + 1) }; });
      if (c.flags.port) ct.ports = [{ containerPort: Number(c.flags.port) }];
      if (c.flags['image-pull-policy']) ct.imagePullPolicy = c.flags['image-pull-policy'];
      if (c.flags.privileged) ct.securityContext = { privileged: true };
      if (c.flags.stdin) { ct.stdin = true; if (!c.flags.rm && !c.flags.tty) ct.stdinOnce = true; }
      if (c.flags.tty) { if (!c.flags.stdin) c.fail('-i/--stdin is required for containers with -t/--tty=true'); ct.tty = true; ct.stdinOnce = true; }
      if (c.flags.stdin && !c.flags.tty) ct.stdinOnce = true;
      let pod = {
        apiVersion: 'v1', kind: 'Pod',
        metadata: { creationTimestamp: null, labels, name, ...(c.flags.annotations ? { annotations: Object.fromEntries(c.flags.annotations.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)])) } : {}) },
        spec: { containers: [ct], dnsPolicy: 'ClusterFirst', restartPolicy: restart },
        status: {},
      };
      if (c.flags.overrides) {
        let ov;
        try { ov = JSON.parse(c.flags.overrides); } catch (e) { c.fail(`error: invalid character in overrides: ${e.message}`); }
        pod = U.strategicMerge(pod, ov);
      }
      if (c.nsExplicit()) pod.metadata.namespace = c.ns();
      if (c.flags.expose && !c.flags.port) c.fail('--port must be set when exposing a service');
      if (c.flags.rm && !c.flags.stdin && !c.flags.attach) c.fail('--rm should only be used for attached containers');
      const dry = c.dryRun();
      const t = S.byId('pods');
      if (c.flags.expose) {
        const svc = { apiVersion: 'v1', kind: 'Service', metadata: { creationTimestamp: null, name, ...(pod.metadata.namespace ? { namespace: pod.metadata.namespace } : {}) }, spec: { ports: [{ port: Number(c.flags.port), protocol: 'TCP', targetPort: Number(c.flags.port) }], selector: { ...labels } }, status: { loadBalancer: {} } };
        if (dry === 'client') { if (c.flags.output) c.printObjects([{ t: S.byId('services'), o: svc }], { single: true }); else c.out(`service/${name} created (dry run)\n`); }
        else { const s = c.create(svc, { dryRun: dry === 'server' }); c.printOp(S.byId('services'), s, 'created'); }
      }
      if (dry === 'client') {
        if (c.flags.output) c.printObjects([{ t, o: pod }], { single: true });
        else c.out(`pod/${name} created (dry run)\n`);
        return;
      }
      if (c.flags['save-config']) pod.metadata.annotations = { ...(pod.metadata.annotations || {}), [LAST]: lastApplied(pod) };
      const created = c.create(pod, { dryRun: dry === 'server' });
      const attach = c.flags.attach || c.flags.stdin;
      if (!attach || dry) { c.printOp(t, created, 'created'); return; }
      // aguarda o pod iniciar
      const ns = created.metadata.namespace;
      const timeout = (U.parseDuration(c.flags['pod-running-timeout'] || '1m') || 60) * 1000;
      const start = Date.now();
      for (;;) {
        const p = c.cluster.raw(t, ns, name);
        if (!p) c.fail(`pod ${name} was deleted`);
        const cs = (p.status.containerStatuses || [])[0];
        if (p.status.phase === 'Succeeded' || p.status.phase === 'Failed' || (cs && (cs.state.running || cs.state.terminated || (cs.state.waiting && cs.state.waiting.reason === 'CrashLoopBackOff')))) break;
        if (cs && cs.state.waiting && /ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError/.test(cs.state.waiting.reason) && Date.now() - start > 8000) {
          c.fail(`timed out waiting for the condition`);
        }
        if (Date.now() - start > timeout) c.fail('timed out waiting for the condition');
        await c.sleep(200);
      }
      const p = c.cluster.raw(t, ns, name);
      let exitCode = 0;
      if (c.flags.tty && p.status.phase === 'Running' && KS.PodShell) {
        if (!c.flags.quiet) c.err("If you don't see a command prompt, try pressing enter.\n");
        await c.env.interactive({ pod: p, container: name, argv: extra.length ? (c.flags.command ? extra : extra) : null, attach: true });
      } else {
        // anexa à saída do container
        exitCode = await K.followLogs(c, p, name, { untilExit: true });
        if (restart === 'Always' && !c.flags.rm) c.err(`Session ended, resume using 'kubectl attach ${name} -c ${name} -i -t' command when the pod is running\n`);
      }
      if (c.flags.rm) {
        c.del(t, ns, name, { gracePeriodSeconds: c.flags['grace-period'] });
        c.out(`pod "${name}" deleted\n`);
        while (c.cluster.raw(t, ns, name)) await c.sleep(150);
      } else if (c.flags.tty) c.err(`Session ended, resume using 'kubectl attach ${name} -c ${name} -i -t' command when the pod is running\n`);
      if (exitCode && !c.flags.tty) throw new Exit(exitCode);
    },
  });

  // segue logs de um container (usado por run/attach/logs -f)
  K.followLogs = async (c, pod, cname, opts = {}) => {
    const ns = pod.metadata.namespace, name = pod.metadata.name;
    let printed = 0;
    let lastRun = null;
    for (;;) {
      const cur = c.cluster.raw(S.byId('pods'), ns, name);
      if (!cur) return 0;
      let lines;
      try { lines = c.cluster.podLogs(ns, name, { container: cname, allowDefault: true, tail: opts.tail, timestamps: opts.timestamps, sinceSeconds: opts.sinceSeconds }); } catch (e) {
        if (opts.untilExit) { await c.sleep(300); continue; }
        throw e;
      }
      if (lastRun && lines.run !== lastRun && lines.run.start !== lastRun.start) printed = 0;
      lastRun = lines.run;
      if (lines.length > printed) {
        c.out(lines.slice(printed).map((l) => (opts.prefix || '') + l).join('\n') + '\n');
        printed = lines.length;
      }
      if (opts.tail !== undefined && opts.tail >= 0) {
        opts.tail = undefined;
        try { printed = c.cluster.podLogs(ns, name, { container: cname, allowDefault: true, timestamps: opts.timestamps }).length; } catch (e) { /* */ }
      }
      const rec = lines.rec;
      if (rec && rec.stage !== 'running' && lines.run.end !== undefined) {
        if (opts.untilExit || !opts.follow) return lines.run.code || 0;
        if (c.cluster.raw(S.byId('pods'), ns, name).status.phase !== 'Running') return lines.run.code || 0;
      }
      if (c.aborted) throw new Exit(130);
      await c.sleep(400);
    }
  };

  // ---------------- SET ----------------
  const containersOf = (o) => {
    if (o.kind === 'Pod') return { spec: o.spec, path: 'spec' };
    if (o.kind === 'CronJob') return { spec: o.spec.jobTemplate.spec.template.spec, path: 'spec.jobTemplate.spec.template.spec' };
    if (o.spec && o.spec.template) return { spec: o.spec.template.spec, path: 'spec.template.spec' };
    return null;
  };
  K.containersOf = containersOf;
  const setCmd = (short, usage, flags, apply, verb) => ({
    short, usage, flags: { ...FILES, ...PRINT, ...DRY, selector: SEL.selector, all: F('bool', null, "Select all resources, in the namespace of the specified resource types"), local: F('bool', null, 'If true, set will NOT contact api-server but run locally.'), 'field-manager': F('string', null, 'Name of the manager used to track field ownership.'), ...flags },
    async run(c) {
      const { targets, extra } = apply.split(c);
      const list = c.collect({ args: targets, verb: 'set' });
      let any = false;
      for (const r of list) {
        const o = r.obj || c.get(r.t, r.ns, r.name);
        const before = JSON.stringify(o);
        const res = apply.mutate(c, o, extra, r);
        if (res === 'skip') continue;
        any = true;
        if (res && res.list) continue;
        const changed = JSON.stringify(o) !== before;
        if (changed && !c.dryRun()) { recordCause(c, o); c.update(o, {}); }
        if (c.flags.output) c.printObjects([{ t: r.t, o }], { single: true });
        else c.out(`${r.t.kindRef}/${r.name} ${changed ? verb : verb}${c.drySuffix()}\n`);
      }
      void any;
    },
  });
  const splitKV = (c) => {
    const targets = [], extra = [];
    for (const a of c.pos) (a.includes('=') || /^[\w.-]+-$/.test(a) ? extra : targets).push(a);
    return { targets, extra };
  };
  K.def('set', {
    short: 'Set specific features on objects',
    usage: 'kubectl set SUBCOMMAND [options]',
    long: ' Configure application resources.\n\n These commands help you make changes to existing application resources.',
    sub: {
      image: setCmd('Update the image of a pod template', 'kubectl set image (-f FILENAME | TYPE NAME) CONTAINER_NAME_1=CONTAINER_IMAGE_1 ... CONTAINER_NAME_N=CONTAINER_IMAGE_N [flags] [options]', { record: COMMON_W.record }, {
        split: splitKV,
        mutate(c, o, extra) {
          if (!extra.length) c.fail('at least one image update is required');
          const cs = containersOf(o);
          if (!cs) c.fail(`${o.kind} has no containers`);
          for (const kv of extra) {
            const [cn, img] = [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)];
            const all = [...(cs.spec.containers || []), ...(cs.spec.initContainers || [])];
            const hit = cn === '*' ? all : all.filter((x) => x.name === cn);
            if (!hit.length) c.fail(`unable to find container named "${cn}"`);
            for (const x of hit) x.image = img;
          }
        },
      }, 'image updated'),
      env: setCmd('Update environment variables on a pod template', 'kubectl set env RESOURCE/NAME KEY_1=VAL_1 ... KEY_N=VAL_N [flags] [options]', { container: F('string', 'c', 'The names of containers in the selected pod templates to change - may use wildcards'), env: F('stringArray', 'e', 'Specify a key-value pair for an environment variable to set into each container.'), from: F('string', null, 'The name of a resource from which to inject environment variables'), prefix: F('string', null, 'Prefix to append to variable names'), keys: F('strings', null, 'Comma-separated list of keys to import from specified resource'), list: F('bool', null, 'If true, display the environment and any changes in the standard format.'), resolve: F('bool', null, 'If true, show secret or configmap references when listing variables'), overwrite: F('bool', null, 'If true, allow environment to be overwritten, otherwise reject updates that overwrite existing environment.'), containers: F('string', null, 'The names of containers in the selected pod templates to change') }, {
        split: splitKV,
        mutate(c, o, extra) {
          const cs = containersOf(o);
          const sel = c.flags.container || c.flags.containers || '*';
          const cons = cs.spec.containers.filter((x) => sel === '*' || x.name === sel);
          if (!cons.length) c.fail(`unable to find container named ${sel}`);
          if (c.flags.list) {
            for (const ct of cons) {
              c.out(`# ${o.kind} ${o.metadata.name}, container ${ct.name}\n`);
              for (const e of ct.envFrom || []) c.out(`# ${e.configMapRef ? 'configmap' : 'secret'} ${(e.configMapRef || e.secretRef).name}\n`);
              for (const e of ct.env || []) {
                if (e.valueFrom) c.out(`# ${e.name} from ${e.valueFrom.configMapKeyRef ? `configmap ${e.valueFrom.configMapKeyRef.name}, key ${e.valueFrom.configMapKeyRef.key}` : e.valueFrom.secretKeyRef ? `secret ${e.valueFrom.secretKeyRef.name}, key ${e.valueFrom.secretKeyRef.key}` : `field path ${e.valueFrom.fieldRef.fieldPath}`}\n`);
                else c.out(`${e.name}=${e.value ?? ''}\n`);
              }
            }
            return { list: true };
          }
          const sets = [...extra, ...(c.flags.env || [])];
          for (const ct of cons) {
            ct.env = ct.env || [];
            for (const kv of sets) {
              if (kv.endsWith('-') && !kv.includes('=')) { ct.env = ct.env.filter((e) => e.name !== kv.slice(0, -1)); continue; }
              const i = kv.indexOf('=');
              const k = kv.slice(0, i), v = kv.slice(i + 1);
              const ex = ct.env.find((e) => e.name === k);
              if (ex) { ex.value = v; delete ex.valueFrom; } else ct.env.push({ name: k, value: v });
            }
            if (c.flags.from) {
              const [tn, nm] = c.flags.from.split('/');
              const t = c.type(tn);
              const src = c.get(t, o.metadata.namespace, nm);
              const keys = c.flags.keys || Object.keys(src.data || {});
              for (const k of keys) {
                const name = (c.flags.prefix || '') + k.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                const ref = t.id === 'secrets' ? { secretKeyRef: { key: k, name: nm } } : { configMapKeyRef: { key: k, name: nm } };
                const ex = ct.env.find((e) => e.name === name);
                if (ex) { ex.valueFrom = ref; delete ex.value; } else ct.env.push({ name, valueFrom: ref });
              }
            }
            if (!ct.env.length) delete ct.env;
          }
        },
      }, 'env updated'),
      resources: setCmd('Update resource requests/limits on objects with pod templates', 'kubectl set resources (-f FILENAME | TYPE NAME)  ([--limits=LIMITS & --requests=REQUESTS] [flags] [options]', { containers: F('string', 'c', 'The names of containers in the selected pod templates to change, all containers are selected by default - may use wildcards'), limits: F('string', null, 'The resource requirement requests for this container.  For example, \'cpu=100m,memory=256Mi\'.'), requests: F('string', null, 'The resource requirement requests for this container.  For example, \'cpu=100m,memory=256Mi\'.'), record: COMMON_W.record }, {
        split: (c) => ({ targets: c.pos, extra: [] }),
        mutate(c, o) {
          if (!c.flags.limits && !c.flags.requests) c.fail('you must specify an update to requests or limits (in the form of --requests/--limits)');
          const cs = containersOf(o);
          const sel = c.flags.containers || '*';
          const parse = (s) => Object.fromEntries((s || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
          for (const ct of cs.spec.containers.filter((x) => sel === '*' || x.name === sel)) {
            ct.resources = ct.resources || {};
            if (c.flags.limits) ct.resources.limits = { ...(ct.resources.limits || {}), ...parse(c.flags.limits) };
            if (c.flags.requests) ct.resources.requests = { ...(ct.resources.requests || {}), ...parse(c.flags.requests) };
          }
        },
      }, 'resource requirements updated'),
      selector: setCmd('Set the selector on a resource', 'kubectl set selector (-f FILENAME | TYPE NAME) EXPRESSIONS [--resource-version=version] [flags] [options]', { 'resource-version': F('string', null, 'If non-empty, the selectors update will only succeed if this is the current resource-version for the object.') }, {
        split: splitKV,
        mutate(c, o, extra) {
          const sel = {};
          for (const kv of extra.join(',').split(',').filter(Boolean)) { const [k, v] = kv.split('='); sel[k] = v; }
          if (o.kind === 'Service') o.spec.selector = sel;
          else c.fail(`the ${o.kind.toLowerCase()} is not supported. Supported types are services`);
        },
      }, 'selector updated'),
      serviceaccount: setCmd('Update the service account of a resource', 'kubectl set serviceaccount (-f FILENAME | TYPE NAME) SERVICE_ACCOUNT [flags] [options]', { record: COMMON_W.record }, {
        split: (c) => ({ targets: c.pos.slice(0, -1), extra: c.pos.slice(-1) }),
        mutate(c, o, extra) {
          const cs = containersOf(o);
          cs.spec.serviceAccountName = extra[0];
          delete cs.spec.serviceAccount;
        },
      }, 'serviceaccount updated'),
      subject: setCmd('Update the user, group, or service account in a role binding or cluster role binding', 'kubectl set subject (-f FILENAME | TYPE NAME) [--user=username] [--group=groupname] [--serviceaccount=namespace:serviceaccountname] [--dry-run=server|client|none] [flags] [options]', { user: F('stringArray', null, 'Usernames to bind to the role'), group: F('stringArray', null, 'Groups to bind to the role'), serviceaccount: F('stringArray', null, 'Service accounts to bind to the role') }, {
        split: (c) => ({ targets: c.pos, extra: [] }),
        mutate(c, o) {
          o.subjects = o.subjects || [];
          const add = (s) => { if (!o.subjects.some((x) => x.kind === s.kind && x.name === s.name && (x.namespace || '') === (s.namespace || ''))) o.subjects.push(s); };
          for (const u of c.flags.user || []) add({ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: u });
          for (const g of c.flags.group || []) add({ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: g });
          for (const sa of c.flags.serviceaccount || []) { const [n, s] = sa.split(':'); add({ kind: 'ServiceAccount', name: s, namespace: n }); }
        },
      }, 'subjects updated'),
    },
    async run(c) { K.printHelp(c, 'kubectl set', CMD.set); },
  });
  CMD.set.sub.env.aliasOnly = false;

  // ---------------- ROLLOUT ----------------
  const rolloutTargets = (c) => {
    const list = c.collect({ verb: 'rollout' });
    for (const r of list) if (!['deployments.apps', 'daemonsets.apps', 'statefulsets.apps'].includes(r.t.id)) c.fail(`no ${c.cmdPath.split(' ').pop() === 'status' ? 'status viewer' : 'history viewer'} has been implemented for "${r.t.kind}"`.replace('no history viewer has been implemented for', 'no history viewer has been implemented for'));
    return list;
  };
  const rsRevision = (rs) => Number((rs.metadata.annotations || {})['deployment.kubernetes.io/revision'] || 0);
  const describeTemplate = (tpl) => {
    const w = new PR.DW();
    const fakeParent = { spec: { template: tpl } };
    void fakeParent;
    w.w(0, 'Pod Template:');
    w.map(1, 'Labels', (tpl.metadata || {}).labels);
    const anns = (tpl.metadata || {}).annotations;
    if (anns && Object.keys(anns).length) w.map(1, 'Annotations', anns, ': ');
    w.w(1, 'Containers:');
    for (const ct of tpl.spec.containers) {
      w.w(2, ` ${ct.name}:`);
      w.w(3, `Image:\t${ct.image}`);
      const ports = (ct.ports || []).map((p) => `${p.containerPort}/${p.protocol || 'TCP'}`);
      w.w(3, `Port:\t${ports[0] || '<none>'}`);
      w.w(3, `Host Port:\t${ports.length ? '0/TCP' : '<none>'}`);
      if (ct.command) { w.w(3, 'Command:'); for (const x of ct.command) w.w(4, x); }
      if (ct.args) { w.w(3, 'Args:'); for (const x of ct.args) w.w(4, x); }
      w.w(3, `Environment:\t${(ct.env || []).length ? '' : '<none>'}`);
      for (const e of ct.env || []) w.w(4, `${e.name}:\t${e.value ?? ''}`);
      w.w(3, `Mounts:\t${(ct.volumeMounts || []).length ? '' : '<none>'}`);
      for (const m of ct.volumeMounts || []) w.w(4, `${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'})`);
    }
    w.w(1, `Volumes:\t${(tpl.spec.volumes || []).length ? (tpl.spec.volumes || []).map((v) => v.name).join(', ') : '<none>'}`);
    w.w(1, `Node-Selectors:\t${U.mapSelectorString(tpl.spec.nodeSelector)}`);
    w.w(1, `Tolerations:\t${(tpl.spec.tolerations || []).length ? tpl.spec.tolerations.map((t) => t.key).join(', ') : '<none>'}`);
    return w.toString();
  };
  K.def('rollout', {
    short: 'Manage the rollout of a resource',
    usage: 'kubectl rollout SUBCOMMAND [options]',
    long: " Manage the rollout of one or many resources.\n        \n Valid resource types include:\n\n  *  deployments\n  *  daemonsets\n  *  statefulsets",
    example: '  # Rollback to the previous deployment\n  kubectl rollout undo deployment/abc\n  \n  # Check the rollout status of a daemonset\n  kubectl rollout status daemonset/foo\n  \n  # Restart a deployment\n  kubectl rollout restart deployment/abc\n  \n  # Restart deployments with the \'app=nginx\' label\n  kubectl rollout restart deployment --selector=app=nginx',
    sub: {
      status: {
        short: 'Show the status of the rollout',
        usage: 'kubectl rollout status (TYPE NAME | TYPE/NAME) [flags] [options]',
        flags: { ...FILES, selector: SEL.selector, watch: F('bool', 'w', 'Watch the status of the rollout until it\'s done.'), revision: F('int', null, 'Pin to a specific revision for showing its status. Defaults to 0 (last revision).'), timeout: F('string', null, 'The length of time to wait before ending watch, zero means never. Any other values should contain a corresponding time unit (e.g. 1s, 2m, 3h).') },
        async run(c) {
          const list = rolloutTargets(c);
          if (!list.length) c.fail('required resource not specified');
          const watch = c.flags.watch !== false;
          const timeout = c.flags.timeout ? U.parseDuration(c.flags.timeout) * 1000 : 0;
          for (const r of list) {
            let last = '';
            const start = Date.now();
            for (;;) {
              const o = c.get(r.t, r.ns, r.name);
              let msg, done = false;
              if (r.t.id === 'deployments.apps') {
                const st = o.status;
                const prog = (st.conditions || []).find((x) => x.type === 'Progressing');
                if (prog && prog.reason === 'ProgressDeadlineExceeded') c.fail(`deployment "${r.name}" exceeded its progress deadline`);
                if (o.metadata.generation > (st.observedGeneration || 0)) msg = 'Waiting for deployment spec update to be observed...';
                else if ((st.updatedReplicas || 0) < o.spec.replicas) msg = `Waiting for deployment "${r.name}" rollout to finish: ${st.updatedReplicas || 0} out of ${o.spec.replicas} new replicas have been updated...`;
                else if ((st.replicas || 0) > (st.updatedReplicas || 0)) msg = `Waiting for deployment "${r.name}" rollout to finish: ${(st.replicas || 0) - (st.updatedReplicas || 0)} old replicas are pending termination...`;
                else if ((st.availableReplicas || 0) < (st.updatedReplicas || 0)) msg = `Waiting for deployment "${r.name}" rollout to finish: ${st.availableReplicas || 0} of ${st.updatedReplicas || 0} updated replicas are available...`;
                else { msg = `deployment "${r.name}" successfully rolled out`; done = true; }
              } else if (r.t.id === 'daemonsets.apps') {
                const st = o.status;
                if (o.metadata.generation > (st.observedGeneration || 0)) msg = 'Waiting for daemon set spec update to be observed...';
                else if ((st.updatedNumberScheduled || 0) < st.desiredNumberScheduled) msg = `Waiting for daemon set "${r.name}" rollout to finish: ${st.updatedNumberScheduled || 0} out of ${st.desiredNumberScheduled} new pods have been updated...`;
                else if ((st.numberAvailable || 0) < st.desiredNumberScheduled) msg = `Waiting for daemon set "${r.name}" rollout to finish: ${st.numberAvailable || 0} of ${st.desiredNumberScheduled} updated pods are available...`;
                else { msg = `daemon set "${r.name}" successfully rolled out`; done = true; }
              } else {
                const st = o.status;
                if (o.spec.updateStrategy.type === 'OnDelete') c.fail(`rollout status is only available for RollingUpdate strategy type`);
                if (o.metadata.generation > (st.observedGeneration || 0)) msg = 'Waiting for statefulset spec update to be observed...';
                else if ((st.readyReplicas || 0) < o.spec.replicas) msg = `Waiting for ${o.spec.replicas - (st.readyReplicas || 0)} pods to be ready...`;
                else if ((o.spec.updateStrategy.rollingUpdate || {}).partition > 0) {
                  const want = o.spec.replicas - o.spec.updateStrategy.rollingUpdate.partition;
                  if ((st.updatedReplicas || 0) < want) msg = `Waiting for partitioned roll out to finish: ${st.updatedReplicas || 0} out of ${want} new pods have been updated...`;
                  else { msg = `partitioned roll out complete: ${st.updatedReplicas || 0} new pods have been updated...`; done = true; }
                } else if (st.updateRevision !== st.currentRevision) msg = `waiting for statefulset rolling update to complete ${st.updatedReplicas || 0} pods at revision ${st.updateRevision}...`;
                else { msg = `statefulset rolling update complete ${st.currentReplicas || st.replicas} pods at revision ${st.currentRevision}...`; done = true; }
              }
              if (msg !== last) { c.out(msg + '\n'); last = msg; }
              if (done || !watch) break;
              if (timeout && Date.now() - start > timeout) c.fail('timed out waiting for the condition');
              await c.sleep(300);
            }
          }
        },
      },
      history: {
        short: 'View rollout history',
        usage: 'kubectl rollout history (TYPE NAME | TYPE/NAME) [flags] [options]',
        flags: { ...FILES, ...PRINT, selector: SEL.selector, revision: F('int', null, 'See the details, including podTemplate of the revision specified') },
        async run(c) {
          for (const r of rolloutTargets(c)) {
            const o = c.get(r.t, r.ns, r.name);
            let revs = [];
            if (r.t.id === 'deployments.apps') {
              for (const rs of c.cluster.controlledBy(S.byId('replicasets.apps'), r.ns, c.cluster.raw(r.t, r.ns, r.name))) revs.push({ rev: rsRevision(rs), cause: (rs.metadata.annotations || {})['kubernetes.io/change-cause'], tpl: rs.spec.template });
            } else {
              for (const cr of c.cluster.controlledBy(S.byId('controllerrevisions.apps'), r.ns, c.cluster.raw(r.t, r.ns, r.name))) revs.push({ rev: cr.revision, cause: (cr.metadata.annotations || {})['kubernetes.io/change-cause'], tpl: cr.data.spec.template });
            }
            revs.sort((a, b) => a.rev - b.rev);
            if (c.flags.revision) {
              const hit = revs.find((x) => x.rev === c.flags.revision);
              if (!hit) c.fail(`unable to find the specified revision`);
              const tpl = U.clone(hit.tpl);
              delete tpl.$patch;
              if (c.flags.output) { c.printObjects([{ t: r.t, o: { ...o, spec: { ...o.spec, template: tpl } } }], { single: true }); continue; }
              c.out(`${r.t.kindRef}/${r.name} with revision #${hit.rev}\n${describeTemplate(tpl)}`);
              continue;
            }
            const rows = [['REVISION', 'CHANGE-CAUSE'], ...revs.map((x) => [String(x.rev), x.cause || '<none>'])];
            c.out(`${r.t.kindRef}/${r.name} \n${U.tabwrite(rows.map((x) => x.join('\t')).join('\n'), 0, 2)}\n\n`);
          }
        },
      },
      undo: {
        short: 'Undo a previous rollout',
        usage: 'kubectl rollout undo (TYPE NAME | TYPE/NAME) [flags] [options]',
        flags: { ...FILES, ...PRINT, ...DRY, selector: SEL.selector, 'to-revision': F('int', null, 'The revision to rollback to. Default to 0 (last revision).') },
        async run(c) {
          for (const r of rolloutTargets(c)) {
            const raw = c.cluster.raw(r.t, r.ns, r.name);
            if (!raw) throw KS.errors.notFound(r.t, r.name);
            const o = c.get(r.t, r.ns, r.name);
            let revs;
            if (r.t.id === 'deployments.apps') {
              if (o.spec.paused) c.fail(`you cannot rollback a paused deployment; resume it first with 'kubectl rollout resume' and try again`);
              revs = c.cluster.controlledBy(S.byId('replicasets.apps'), r.ns, raw).map((rs) => ({ rev: rsRevision(rs), tpl: rs.spec.template }));
            } else revs = c.cluster.controlledBy(S.byId('controllerrevisions.apps'), r.ns, raw).map((cr) => ({ rev: cr.revision, tpl: cr.data.spec.template }));
            revs.sort((a, b) => b.rev - a.rev);
            let target;
            if (c.flags['to-revision']) {
              target = revs.find((x) => x.rev === c.flags['to-revision']);
              if (!target) c.fail(`unable to find specified revision ${c.flags['to-revision']} in history`);
            } else {
              target = revs[1];
              if (!target) c.fail(`no rollout history found for ${r.t.kind.toLowerCase()} "${r.name}"`);
            }
            const tpl = U.clone(target.tpl);
            delete tpl.$patch;
            if (tpl.metadata && tpl.metadata.labels) delete tpl.metadata.labels['pod-template-hash'];
            if (tpl.metadata && tpl.metadata.labels) delete tpl.metadata.labels['controller-revision-hash'];
            if (JSON.stringify(PR.sortKeys(tpl)) === JSON.stringify(PR.sortKeys(o.spec.template))) {
              c.out(`${r.t.kindRef}/${r.name} skipped rollback (current template already matches revision ${target.rev})\n`);
              continue;
            }
            o.spec.template = tpl;
            if (!c.dryRun()) c.update(o, {});
            c.out(`${r.t.kindRef}/${r.name} rolled back${c.drySuffix()}\n`);
          }
        },
      },
      pause: {
        short: 'Mark the provided resource as paused',
        usage: 'kubectl rollout pause RESOURCE [flags] [options]',
        flags: { ...FILES, ...PRINT, selector: SEL.selector, 'field-manager': COMMON_W['field-manager'] },
        async run(c) {
          for (const r of rolloutTargets(c)) {
            if (r.t.id !== 'deployments.apps') c.fail(`${r.t.kindRef}/${r.name} pausing is not supported`);
            const o = c.get(r.t, r.ns, r.name);
            if (o.spec.paused) c.fail(`${r.t.qualified} "${r.name}" is already paused`);
            c.patch(r.t, r.ns, r.name, { spec: { paused: true } }, 'strategic');
            c.out(`${r.t.kindRef}/${r.name} paused\n`);
          }
        },
      },
      resume: {
        short: 'Resume a paused resource',
        usage: 'kubectl rollout resume RESOURCE [flags] [options]',
        flags: { ...FILES, ...PRINT, selector: SEL.selector, 'field-manager': COMMON_W['field-manager'] },
        async run(c) {
          for (const r of rolloutTargets(c)) {
            if (r.t.id !== 'deployments.apps') c.fail(`${r.t.kindRef}/${r.name} resuming is not supported`);
            const o = c.get(r.t, r.ns, r.name);
            if (!o.spec.paused) c.fail(`${r.t.qualified} "${r.name}" is not paused`);
            c.patch(r.t, r.ns, r.name, { spec: { paused: null } }, 'merge');
            c.out(`${r.t.kindRef}/${r.name} resumed\n`);
          }
        },
      },
      restart: {
        short: 'Restart a resource',
        usage: 'kubectl rollout restart RESOURCE [flags] [options]',
        flags: { ...FILES, ...PRINT, ...DRY, selector: SEL.selector, 'field-manager': COMMON_W['field-manager'] },
        async run(c) {
          const list = c.collect({ verb: 'restart', listOk: true });
          for (const r of list) {
            if (!['deployments.apps', 'daemonsets.apps', 'statefulsets.apps'].includes(r.t.id)) c.fail(`restarting is not supported`);
            const o = c.get(r.t, r.ns, r.name);
            if (o.spec.paused) c.fail(`${r.t.qualified} "${r.name}" can't restart paused deployment (run rollout resume first)`);
            if (!c.dryRun()) c.patch(r.t, r.ns, r.name, { spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString().replace(/\.\d+Z$/, 'Z') } } } } }, 'strategic');
            c.out(`${r.t.kindRef}/${r.name} restarted${c.drySuffix()}\n`);
          }
        },
      },
    },
    async run(c) { K.printHelp(c, 'kubectl rollout', CMD.rollout); },
  });

  // ---------------- utilitários de ajuda ----------------
  const lev = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  K.lev = lev;
  const wrap = (text, width, indent) => {
    const out = [];
    for (const para of String(text).split('\n')) {
      let line = '';
      for (const w of para.split(' ')) {
        if ((line + ' ' + w).trim().length > width) { out.push(indent + line.trim()); line = w; } else line += ' ' + w;
      }
      out.push(indent + line.trim());
    }
    return out.join('\n');
  };
  K.wrap = wrap;
  K.flagHelp = (flags) => {
    const rows = Object.entries(flags).filter(([n]) => !GLOBAL[n]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([n, f]) => {
      const head = `    ${f.s ? '-' + f.s + ', ' : ''}--${n}${f.t === 'bool' ? '=false' : f.t === 'int' ? '=-1' : f.t === 'strings' || f.t === 'stringArray' ? '=[]' : f.o !== undefined ? `='${f.o === 'unchanged' ? 'none' : f.o}'` : "=''"}:`;
      return head + '\n' + wrap(f.d || '', 70, '\t');
    });
    return rows.join('\n\n');
  };
  K.printHelp = (c, path, def) => {
    let s = '';
    if (def.long) s += def.long + '\n\n';
    else if (def.short) s += def.short + '.\n\n';
    if (def.sub && Object.keys(def.sub).length) {
      s += 'Available Commands:\n';
      const names = Object.keys(def.sub).sort();
      const w = Math.max(...names.map((n) => n.length)) + 2;
      for (const n of names) s += `  ${n.padEnd(w)}${def.sub[n].short || ''}\n`;
      s += '\n';
    }
    if (def.example) s += 'Examples:\n' + def.example + '\n\n';
    if (def.flags && Object.keys(def.flags).filter((n) => !GLOBAL[n]).length) s += 'Options:\n' + K.flagHelp(def.flags) + '\n\n';
    s += `Usage:\n  ${def.usage || path + ' [flags] [options]'}\n\n`;
    if (def.sub && Object.keys(def.sub).length) s += `Use "${path} <command> --help" for more information about a given command.\n`;
    s += 'Use "kubectl options" for a list of global command-line options (applies to all commands).\n';
    c.out(s);
  };

  // ---------------- execução ----------------
  const TOP_HELP = `kubectl controls the Kubernetes cluster manager.

 Find more information at: https://kubernetes.io/docs/reference/kubectl/

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service
  run             Run a particular image on the cluster
  set             Set specific features on objects

Basic Commands (Intermediate):
  explain         Get documentation for a resource
  get             Display one or many resources
  edit            Edit a resource on the server
  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector

Deploy Commands:
  rollout         Manage the rollout of a resource
  scale           Set a new size for a deployment, replica set, or replication controller
  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller

Cluster Management Commands:
  certificate     Modify certificate resources
  cluster-info    Display cluster information
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  taint           Update the taints on one or more nodes

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  attach          Attach to a running container
  exec            Execute a command in a container
  port-forward    Forward one or more local ports to a pod
  proxy           Run a proxy to the Kubernetes API server
  cp              Copy files and directories to and from containers
  auth            Inspect authorization
  debug           Create debugging sessions for troubleshooting workloads and nodes
  events          List events

Advanced Commands:
  diff            Diff the live version against a would-be applied version
  apply           Apply a configuration to a resource by file name or stdin
  patch           Update fields of a resource
  replace         Replace a resource by file name or stdin
  wait            Experimental: Wait for a specific condition on one or many resources
  kustomize       Build a kustomization target from a directory or URL

Settings Commands:
  label           Update the labels on a resource
  annotate        Update the annotations on a resource
  completion      Output shell completion code for the specified shell (bash, zsh, fish, or powershell)

Subcommands provided by plugins:

Other Commands:
  api-resources   Print the supported API resources on the server
  api-versions    Print the supported API versions on the server, in the form of "group/version"
  config          Modify kubeconfig files
  plugin          Provides utilities for interacting with plugins
  version         Print the client and server version information

Usage:
  kubectl [flags] [options]

Use "kubectl <command> --help" for more information about a given command.
Use "kubectl options" for a list of global command-line options (applies to all commands).
`;
  K.TOP_HELP = TOP_HELP;

  // env: {cluster, fs, vars, stdin, out, err, signal, editor, interactive, readLine, forwards}
  K.run = async (argv, env) => {
    const raw = [...argv];
    // localiza o comando (flags globais podem vir antes)
    let i = 0;
    const pre = [];
    while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') {
      const a = argv[i];
      pre.push(a);
      const name = a.startsWith('--') ? a.slice(2).split('=')[0] : a.slice(1, 2);
      const f = a.startsWith('--') ? GLOBAL[name] : Object.values(GLOBAL).find((x) => x.s === name);
      if (f && f.t !== 'bool' && !a.includes('=') && !(a.length > 2 && !a.startsWith('--'))) { pre.push(argv[i + 1]); i++; }
      i++;
    }
    const cmdName = argv[i];
    const rest = [...pre, ...argv.slice(i + 1)];
    K._cmdPath = 'kubectl';
    try {
      if (!cmdName) {
        if (pre.some((a) => a === '-h' || a === '--help') || !pre.length) { env.out(TOP_HELP); return 0; }
        const p = parseArgs(pre, GLOBAL);
        void p;
        env.out(TOP_HELP);
        return 0;
      }
      let def = CMD[cmdName];
      let path = 'kubectl ' + cmdName;
      if (!def) {
        const alias = Object.entries(CMD).find(([, d]) => (d.alias || []).includes(cmdName));
        if (alias) { def = alias[1]; path = 'kubectl ' + alias[0]; }
      }
      if (!def) {
        if (cmdName === 'help') {
          const target = argv[i + 1];
          if (target && CMD[target]) { const c = new Ctx(env, 'kubectl ' + target, { flags: {}, pos: [], seen: {} }, raw); K.printHelp(c, 'kubectl ' + target, CMD[target]); return 0; }
          env.out(TOP_HELP);
          return 0;
        }
        // plugins kubectl-<nome> (ex.: kubectl-ns) não existem
        const sugg = Object.keys(CMD).filter((n) => lev(n, cmdName) <= 2 || n.startsWith(cmdName.slice(0, 3)) && cmdName.length > 3);
        env.err(`error: unknown command "${cmdName}" for "kubectl"${sugg.length ? `\n\nDid you mean this?\n${sugg.slice(0, 3).map((s) => '\t' + s).join('\n')}\n` : ''}\n`);
        return 1;
      }
      // subcomandos
      let args = rest;
      const findSub = (d, a) => {
        const spec = { ...GLOBAL, ...(d.flags || {}) };
        let idx = -1;
        for (let j = 0; j < a.length; j++) {
          const x = a[j];
          if (x === '--') break;
          if (x.startsWith('-') && x.length > 1) {
            if (x.includes('=')) continue;
            const f = x.startsWith('--') ? spec[x.slice(2)] : x.length === 2 ? Object.values(spec).find((y) => y.s === x[1]) : null;
            if (f && f.t !== 'bool' && f.o === undefined) j++;
            continue;
          }
          idx = j;
          break;
        }
        if (!d.sub || idx < 0) return null;
        const nm = a[idx];
        let s = d.sub[nm];
        if (!s) { const e = Object.entries(d.sub).find(([, x]) => (x.alias || []).includes(nm)); if (e) s = e[1]; }
        if (!s) return null;
        // o argumento antes do subcomando precisa ser uma flag com valor, não posicional
        return { s, name: nm, args: [...a.slice(0, idx), ...a.slice(idx + 1)] };
      };
      for (;;) {
        const sub = findSub(def, args);
        if (!sub) break;
        def = sub.s;
        path += ' ' + (Object.entries(CMD[cmdName] ? {} : {}).length ? sub.name : sub.name);
        args = sub.args;
      }
      K._cmdPath = path;
      const spec = { ...GLOBAL, ...(def.flags || {}) };
      const parsed = parseArgs(args, spec);
      const c = new Ctx(env, path, parsed, raw);
      c.localFlags = def.flags || {};
      if (parsed.flags.help) { K.printHelp(c, path, def); return 0; }
      if (def.sub && !def.run) { K.printHelp(c, path, def); return 0; }
      await def.run(c);
      return c.code || 0;
    } catch (e) {
      if (e instanceof Exit) {
        if (e.message) env.err(e.message.replace(/\n?$/, '\n'));
        return e.exitCode;
      }
      if (e instanceof KS.ApiError) {
        env.err(K.formatError(e, { file: e.file, verb: e.verb }) + '\n');
        return 1;
      }
      if (e && e.selector) { env.err(`error: ${e.message}\n`); return 1; }
      env.err(`error: ${e && e.message ? e.message : e}\n`);
      if (globalThis.console && e && e.stack && !(e instanceof SyntaxError)) console.error(e);
      return 1;
    }
  };
})();
