// kubectl simulado — parte 2: depuração, cluster, config, auth, explain, wait, diff, kustomize etc.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, S = KS.schema, PR = KS.printers;
  const K = KS.kubectl, CMD = K.CMD, Exit = K.Exit;
  const F = (t, s, d, o) => ({ t, s, d, o });
  const SERVER = K.SERVER;
  const PRINT = { output: F('string', 'o', 'Output format.'), template: F('string', null, 'Template string or path to template file.'), 'show-managed-fields': F('bool', null, 'If true, keep the managedFields when printing objects in JSON or YAML format.'), 'allow-missing-template-keys': F('bool', null, 'If true, ignore any errors in templates when a field or map key is missing in the template.') };
  const DRY = { 'dry-run': F('string', null, 'Must be "none", "server", or "client".', 'unchanged') };
  const FILES = { filename: F('strings', 'f', 'Filename, directory, or URL to files.'), recursive: F('bool', 'R', 'Process the directory used in -f, --filename recursively.'), kustomize: F('string', 'k', 'Process a kustomization directory.') };
  const pT = () => S.byId('pods');

  // resolve "pod", "deploy/x", "svc/x", "job/x" -> pod
  K.podFor = (c, arg, ns, opts = {}) => {
    let t = pT(), name = arg;
    if (arg.includes('/')) {
      const [tn, n] = arg.split('/');
      t = c.type(tn);
      name = n;
    }
    if (t.id === 'pods') return c.get(t, ns, name);
    const o = c.get(t, ns, name);
    let sel;
    if (t.id === 'services') {
      if (!o.spec.selector) c.fail(`cannot attach to ${t.kindRef}: the service has no selector`);
      sel = U.mapSelectorString(o.spec.selector);
    } else if (o.spec && o.spec.selector) sel = o.spec.selector.matchLabels || o.spec.selector.matchExpressions ? U.selectorString(o.spec.selector) : U.mapSelectorString(o.spec.selector);
    else c.fail(`cannot attach to ${t.kindRef}: selector for ${t.kindRef} not implemented`);
    const pods = c.list(pT(), ns, { labelSelector: sel }).filter((p) => !p.metadata.deletionTimestamp);
    if (!pods.length) c.fail(`timed out waiting for the condition`);
    pods.sort((a, b) => (a.status.phase === 'Running' ? -1 : 1) - (b.status.phase === 'Running' ? -1 : 1) || U.ms(b.metadata.creationTimestamp) - U.ms(a.metadata.creationTimestamp));
    if (opts.announce && pods.length > 1) c.err(`Found ${pods.length} pods, using pod/${pods[0].metadata.name}\n`);
    return pods[0];
  };
  const defaultContainer = (c, pod, flag, quiet) => {
    if (flag) {
      const all = [...pod.spec.containers, ...(pod.spec.initContainers || []), ...(pod.spec.ephemeralContainers || [])];
      if (!all.some((x) => x.name === flag)) c.fail(`container ${flag} not found in pod ${pod.metadata.name}`);
      return flag;
    }
    const ann = (pod.metadata.annotations || {})['kubectl.kubernetes.io/default-container'];
    const name = ann && pod.spec.containers.some((x) => x.name === ann) ? ann : pod.spec.containers[0].name;
    if (pod.spec.containers.length > 1 && !quiet && !ann) {
      const others = [...pod.spec.containers.map((x) => x.name), ...(pod.spec.initContainers || []).map((x) => `${x.name} (init)`), ...(pod.spec.ephemeralContainers || []).map((x) => `${x.name} (ephem)`)];
      c.err(`Defaulted container "${name}" out of: ${others.join(', ')}\n`);
    }
    return name;
  };
  K.defaultContainer = defaultContainer;

  // ---------------- LOGS ----------------
  K.def('logs', {
    short: 'Print the logs for a container in a pod',
    usage: 'kubectl logs [-f] [-p] (POD | TYPE/NAME) [-c CONTAINER] [flags] [options]',
    long: ' Print the logs for a container in a pod or specified resource. If the pod has only one container, the container name is optional.',
    example: '  # Return snapshot logs from pod nginx with only one container\n  kubectl logs nginx\n  \n  # Return snapshot logs from pod nginx with multi containers\n  kubectl logs nginx --all-containers=true\n  \n  # Return snapshot logs from all containers in pods defined by label app=nginx\n  kubectl logs -l app=nginx --all-containers=true\n  \n  # Return snapshot of previous terminated ruby container logs from pod web-1\n  kubectl logs -p -c ruby web-1\n  \n  # Begin streaming the logs of the ruby container in pod web-1\n  kubectl logs -f -c ruby web-1\n  \n  # Display only the most recent 20 lines of output in pod nginx\n  kubectl logs --tail=20 nginx\n  \n  # Show all logs from pod nginx written in the last hour\n  kubectl logs --since=1h nginx\n  \n  # Return snapshot logs from first container of a job named hello\n  kubectl logs job/hello\n  \n  # Return snapshot logs from container nginx-1 of a deployment named nginx\n  kubectl logs deployment/nginx -c nginx-1',
    flags: {
      container: F('string', 'c', 'Print the logs of this container'), follow: F('bool', 'f', 'Specify if the logs should be streamed.'), previous: F('bool', 'p', 'If true, print the logs for the previous instance of the container in a pod if it exists.'),
      tail: F('int', null, 'Lines of recent log file to display. Defaults to -1 with no selector, showing all log lines otherwise 10, if a selector is provided.'), since: F('string', null, 'Only return logs newer than a relative duration like 5s, 2m, or 3h. Defaults to all logs.'), 'since-time': F('string', null, 'Only return logs after a specific date (RFC3339).'),
      timestamps: F('bool', null, 'Include timestamps on each line in the log output'), 'all-containers': F('bool', null, 'Get all containers\' logs in the pod(s).'), selector: F('string', 'l', 'Selector (label query) to filter on.'), prefix: F('bool', null, 'Prefix each log line with the log source (pod name and container name)'),
      'max-log-requests': F('int', null, 'Specify maximum number of concurrent logs to follow when using by a selector. Defaults to 5.'), 'limit-bytes': F('int', null, 'Maximum bytes of logs to return. Defaults to no limit.'), 'pod-running-timeout': F('string', null, 'The length of time to wait until at least one pod is running'), 'ignore-errors': F('bool', null, 'If watching / following pod logs, allow for any errors that occur to be non-fatal'), 'insecure-skip-tls-verify-backend': F('bool', null, 'Skip verifying the identity of the kubelet that logs are requested from.'),
    },
    async run(c) {
      const ns = c.ns();
      let targets = [];
      if (c.flags.selector) {
        if (c.pos.length) c.fail('only a selector (-l) or a POD name is allowed');
        const pods = c.list(pT(), ns, { labelSelector: c.flags.selector });
        if (!pods.length) { c.err(`No resources found in ${ns} namespace.\n`); return; }
        const max = c.flags['max-log-requests'] || 5;
        if (c.flags.follow && pods.length > max) c.fail(`you are attempting to follow ${pods.length} log streams, but maximum allowed concurrency is ${max}, use --max-log-requests to increase the limit`);
        for (const p of pods) for (const ct of c.flags['all-containers'] ? p.spec.containers : [{ name: defaultContainer(c, p, c.flags.container, true) }]) targets.push({ p, cn: ct.name });
        if (c.flags.tail === undefined) c.flags.tail = 10;
      } else {
        if (!c.pos.length) c.usageFail('expected POD, TYPE/NAME, or --selector argument');
        let cont = c.flags.container;
        if (c.pos.length > 1) cont = c.pos[1];
        const pod = K.podFor(c, c.pos[0], ns, { announce: true });
        if (c.flags['all-containers']) for (const ct of [...(pod.spec.initContainers || []), ...pod.spec.containers]) targets.push({ p: pod, cn: ct.name });
        else targets.push({ p: pod, cn: defaultContainer(c, pod, cont) });
      }
      const prefixed = c.flags.prefix;
      const opts = { tail: c.flags.tail !== undefined && c.flags.tail >= 0 ? c.flags.tail : undefined, timestamps: c.flags.timestamps, sinceSeconds: c.flags.since ? U.parseDuration(c.flags.since) : undefined };
      if (!c.flags.follow) {
        for (const tg of targets) {
          let lines;
          try {
            lines = c.cluster.podLogs(ns, tg.p.metadata.name, { container: tg.cn, previous: c.flags.previous, allowDefault: true, ...opts, sinceTime: c.flags['since-time'] });
          } catch (e) {
            if (c.flags['ignore-errors']) continue;
            throw e;
          }
          c.logReq('GET', `${SERVER}/api/v1/namespaces/${ns}/pods/${tg.p.metadata.name}/log?container=${tg.cn}`, 200);
          let text = lines.map((l) => (prefixed ? `[pod/${tg.p.metadata.name}/${tg.cn}] ` : '') + l).join('\n');
          if (c.flags['limit-bytes']) text = text.slice(0, c.flags['limit-bytes']);
          if (text) c.out(text + (c.flags['limit-bytes'] ? '' : '\n'));
        }
        return;
      }
      // follow: vários fluxos em paralelo
      await Promise.all(targets.map((tg) => K.followLogs(c, tg.p, tg.cn, { ...opts, follow: true, prefix: prefixed ? `[pod/${tg.p.metadata.name}/${tg.cn}] ` : '' }).catch((e) => { if (!(e instanceof Exit)) throw e; })));
    },
  });

  // ---------------- EXEC / ATTACH ----------------
  const checkRunning = (c, pod, cn) => {
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') c.fail(`cannot exec into a container in a completed pod; current phase is ${pod.status.phase}`);
    const st = [...(pod.status.containerStatuses || []), ...(pod.status.ephemeralContainerStatuses || []), ...(pod.status.initContainerStatuses || [])].find((x) => x.name === cn);
    if (!st || !st.state.running) {
      if (pod.status.phase === 'Pending' && (!st || !st.containerID)) c.fail(`unable to upgrade connection: container not found ("${cn}")`);
      c.fail(`Internal error occurred: unable to upgrade connection: container not found ("${cn}")`);
    }
  };
  K.def('exec', {
    short: 'Execute a command in a container',
    usage: 'kubectl exec (POD | TYPE/NAME) [-c CONTAINER] [flags] -- COMMAND [args...] [options]',
    long: ' Execute a command in a container.',
    example: '  # Get output from running the \'date\' command from pod mypod, using the first container by default\n  kubectl exec mypod -- date\n  \n  # Get output from running the \'date\' command in ruby-container from pod mypod\n  kubectl exec mypod -c ruby-container -- date\n  \n  # Switch to raw terminal mode; sends stdin to \'bash\' in ruby-container from pod mypod\n  # and sends stdout/stderr from \'bash\' back to the client\n  kubectl exec mypod -c ruby-container -i -t -- bash -il\n  \n  # List contents of /usr from the first container of pod mypod and sort by modification time\n  # If the command you want to execute in the pod has any flags in common (e.g. -i),\n  # you must use two dashes (--) to separate your command\'s flags/arguments\n  # Also note, do not surround your command and its flags/arguments with quotes\n  # unless that is how you would execute it normally (i.e., do ls -t /usr, not "ls -t /usr")\n  kubectl exec mypod -i -t -- ls -t /usr\n  \n  # Get output from running \'date\' command from the first pod of the deployment mydeployment, using the first container by default\n  kubectl exec deploy/mydeployment -- date\n  \n  # Get output from running \'date\' command from the first pod of the service myservice, using the first container by default\n  kubectl exec svc/myservice -- date',
    flags: { container: F('string', 'c', 'Container name. If omitted, use the kubectl.kubernetes.io/default-container annotation for selecting the container to be attached or the first container in the pod will be chosen'), stdin: F('bool', 'i', 'Pass stdin to the container'), tty: F('bool', 't', 'Stdin is a TTY'), quiet: F('bool', 'q', 'Only print output from the remote session'), filename: F('strings', 'f', 'to use to exec into the resource'), 'pod-running-timeout': F('string', null, 'The length of time to wait until at least one pod is running') },
    async run(c) {
      if (!c.pos.length) c.usageFail('pod, type/name or --filename must be specified');
      if (c.pos.length > 1 && !c.dash) throw new Exit(1, `error: exec [POD] [COMMAND] is not supported anymore. Use exec [POD] -- [COMMAND] instead\nSee 'kubectl exec -h' for help and examples`);
      if (!c.dash || !c.dash.length) c.usageFail('you must specify at least one command for the container');
      const ns = c.ns();
      const pod = K.podFor(c, c.pos[0], ns);
      const cn = defaultContainer(c, pod, c.flags.container, c.flags.quiet);
      c.auth();
      const a = c.cluster.authorize(c.auth(), { verb: 'create', group: '', resource: 'pods', subresource: 'exec', name: pod.metadata.name, namespace: ns });
      if (!a.allowed) throw new KS.ApiError(403, 'Forbidden', `pods "${pod.metadata.name}" is forbidden: User "${c.auth().user}" cannot create resource "pods/exec" in API group "" in the namespace "${ns}"`);
      checkRunning(c, pod, cn);
      if (c.flags.tty && !c.flags.stdin) c.err('Unable to use a TTY - input is not a terminal or the right kind of file\n');
      let code;
      if (c.flags.stdin && c.flags.tty) code = await c.env.interactive({ pod, container: cn, argv: c.dash });
      else {
        const sh = new KS.PodShell(c.cluster, pod, cn, { out: (s) => c.out(s), err: (s) => c.err(s), signal: c.env.signal });
        code = await sh.execArgv(c.dash, c.flags.stdin ? c.env.stdin || '' : '');
      }
      if (code === 'notfound') {
        c.fail(`Internal error occurred: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${U.hex(64)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${c.dash[0]}": executable file not found in $PATH: unknown`);
      }
      if (code) { c.err(`command terminated with exit code ${code}\n`); throw new Exit(code); }
    },
  });
  K.def('attach', {
    short: 'Attach to a running container',
    usage: 'kubectl attach (POD | TYPE/NAME) -c CONTAINER [flags] [options]',
    long: ' Attach to a process that is already running inside an existing container.',
    example: '  # Get output from running pod mypod; use the \'kubectl.kubernetes.io/default-container\' annotation\n  # for selecting the container to be attached or the first container in the pod will be chosen\n  kubectl attach mypod\n  \n  # Get output from ruby-container from pod mypod\n  kubectl attach mypod -c ruby-container\n  \n  # Switch to raw terminal mode; sends stdin to \'bash\' in ruby-container from pod mypod\n  # and sends stdout/stderr from \'bash\' back to the client\n  kubectl attach mypod -c ruby-container -i -t',
    flags: { container: F('string', 'c', 'Container name.'), stdin: F('bool', 'i', 'Pass stdin to the container'), tty: F('bool', 't', 'Stdin is a TTY'), quiet: F('bool', 'q', 'Only print output from the remote session'), 'pod-running-timeout': F('string', null, 'The length of time to wait until at least one pod is running') },
    async run(c) {
      if (c.pos.length !== 1) c.usageFail('expected POD, TYPE/NAME, or -f');
      const pod = K.podFor(c, c.pos[0], c.ns());
      const cn = defaultContainer(c, pod, c.flags.container, c.flags.quiet);
      checkRunning(c, pod, cn);
      const spec = pod.spec.containers.find((x) => x.name === cn) || {};
      if (c.flags.stdin && c.flags.tty && spec.tty) {
        if (!c.flags.quiet) c.err("If you don't see a command prompt, try pressing enter.\n");
        await c.env.interactive({ pod, container: cn, argv: null, attach: true });
        return;
      }
      if (c.flags.stdin && !spec.stdin) c.err(`Unable to use a TTY - container ${cn} did not allocate one\n`);
      await K.followLogs(c, pod, cn, { follow: true });
    },
  });

  // ---------------- PORT-FORWARD / PROXY ----------------
  K.def('port-forward', {
    short: 'Forward one or more local ports to a pod',
    usage: 'kubectl port-forward TYPE/NAME [options] [LOCAL_PORT:]REMOTE_PORT [...[LOCAL_PORT_N:]REMOTE_PORT_N]',
    long: ' Forward one or more local ports to a pod.\n\n Use resource type/name such as deployment/mydeployment to select a pod. Resource type defaults to \'pod\' if omitted.\n\n If there are multiple pods matching the criteria, a pod will be selected automatically. The forwarding session ends when the selected pod terminates, and a rerun of the command is needed to resume forwarding.',
    example: '  # Listen on ports 5000 and 6000 locally, forwarding data to/from ports 5000 and 6000 in the pod\n  kubectl port-forward pod/mypod 5000 6000\n  \n  # Listen on ports 5000 and 6000 locally, forwarding data to/from ports 5000 and 6000 in a pod selected by the deployment\n  kubectl port-forward deployment/mydeployment 5000 6000\n  \n  # Listen on port 8443 locally, forwarding to the targetPort of the service\'s port named "https" in a pod selected by the service\n  kubectl port-forward service/myservice 8443:https\n  \n  # Listen on port 8888 locally, forwarding to 5000 in the pod\n  kubectl port-forward pod/mypod 8888:5000\n  \n  # Listen on port 8888 on all addresses, forwarding to 5000 in the pod\n  kubectl port-forward --address 0.0.0.0 pod/mypod 8888:5000\n  \n  # Listen on a random port locally, forwarding to 5000 in the pod\n  kubectl port-forward pod/mypod :5000',
    flags: { address: F('strings', null, 'Addresses to listen on (comma separated). Only accepts IP addresses or localhost as a value.'), 'pod-running-timeout': F('string', null, 'The length of time (like 5s, 2m, or 3h, higher than zero) to wait until at least one pod is running') },
    async run(c) {
      if (c.pos.length < 2) c.usageFail('TYPE/NAME and list of ports are required for port-forward');
      const ns = c.ns();
      const target = c.pos[0];
      let svc = null;
      if (/^(svc|service|services)\//.test(target)) svc = c.get(S.byId('services'), ns, target.split('/')[1]);
      const pod = K.podFor(c, target, ns);
      if (pod.status.phase !== 'Running') c.fail(`unable to forward port because pod is not running. Current status=${pod.status.phase}`);
      const maps = c.pos.slice(1).map((p) => {
        let [l, r] = p.includes(':') ? p.split(':') : [p, p];
        if (svc) {
          const sp = (svc.spec.ports || []).find((x) => String(x.port) === r || x.name === r);
          if (!sp) c.fail(`Service ${svc.metadata.name} does not have a service port ${r}`);
          r = String(c.cluster.namedPort(pod, sp.targetPort ?? sp.port));
          if (!p.includes(':')) l = String(sp.port);
        } else if (!/^\d+$/.test(r)) {
          const np = c.cluster.namedPort(pod, r);
          if (np === null) c.fail(`Pod '${pod.metadata.name}' does not have a named port '${r}'`);
          r = String(np);
        }
        if (l === '') l = String(30000 + Math.floor(Math.random() * 30000));
        return { local: Number(l), remote: Number(r) };
      });
      const addrs = (c.flags.address || ['localhost']).flatMap((a) => a.split(','));
      for (const m of maps) {
        if ((c.env.forwards || []).some((f) => f.local === m.local)) c.fail(`Unable to listen on port ${m.local}: Listeners failed to create with the following errors: [unable to create listener: Error listen tcp4 127.0.0.1:${m.local}: bind: address already in use unable to create listener: Error listen tcp6 [::1]:${m.local}: bind: address already in use]\nerror: unable to listen on any of the requested ports: [{${m.local} ${m.remote}}]`);
      }
      const regs = [];
      for (const m of maps) {
        for (const a of addrs) {
          if (a === 'localhost') { c.out(`Forwarding from 127.0.0.1:${m.local} -> ${m.remote}\nForwarding from [::1]:${m.local} -> ${m.remote}\n`); }
          else c.out(`Forwarding from ${a}:${m.local} -> ${m.remote}\n`);
        }
        const reg = { local: m.local, remote: m.remote, pod, onConnect: () => c.out(`Handling connection for ${m.local}\n`) };
        c.env.forwards.push(reg);
        regs.push(reg);
      }
      try {
        while (!c.aborted) {
          const cur = c.cluster.raw(pT(), ns, pod.metadata.name);
          if (!cur || cur.metadata.uid !== pod.metadata.uid || cur.metadata.deletionTimestamp) {
            c.err(`E${new Date().toTimeString().slice(0, 8)} portforward.go:413] "Unhandled Error" err="an error occurred forwarding ${maps[0].local} -> ${maps[0].remote}: error forwarding port ${maps[0].remote} to pod ${pod.metadata.uid}, uid : failed to find sandbox \\"${U.hex(64)}\\" in store: not found"\nerror: lost connection to pod\n`);
            throw new Exit(1);
          }
          await c.sleep(300);
        }
      } finally {
        for (const r of regs) c.env.forwards.splice(c.env.forwards.indexOf(r), 1);
      }
    },
  });
  K.def('proxy', {
    short: 'Run a proxy to the Kubernetes API server',
    usage: 'kubectl proxy [--port=PORT] [--www=static-dir] [--www-prefix=prefix] [--api-prefix=prefix] [flags] [options]',
    long: ' Creates a proxy server or application-level gateway between localhost and the Kubernetes API server. It also allows serving static content over specified HTTP path. All incoming data enters through one port and gets forwarded to the remote Kubernetes API server port, except for the path matching the static content path.',
    example: '  # To proxy all of the Kubernetes API and nothing else\n  kubectl proxy --api-prefix=/\n  \n  # Run a proxy to the Kubernetes API server on port 8011, serving static content from ./local/www/\n  kubectl proxy --port=8011 --www=./local/www/\n  \n  # Run a proxy to the Kubernetes API server on an arbitrary local port\n  # The chosen port for the server will be output to stdout\n  kubectl proxy --port=0',
    flags: { port: F('int', 'p', 'The port on which to run the proxy. Set to 0 to pick a random port.'), address: F('string', null, 'The IP address on which to serve on.'), 'api-prefix': F('string', null, 'Prefix to serve the proxied API under.'), 'accept-hosts': F('string', null, 'Regular expression for hosts that the proxy should accept.'), 'accept-paths': F('string', null, 'Regular expression for paths that the proxy should accept.'), 'reject-paths': F('string', null, 'Regular expression for paths that the proxy should reject.'), 'reject-methods': F('string', null, 'Regular expression for HTTP methods that the proxy should reject'), www: F('string', 'w', 'Also serve static files from the given directory under the specified prefix.'), 'www-prefix': F('string', 'P', 'Prefix to serve static files under, if static file directory is specified.'), 'disable-filter': F('bool', null, 'If true, disable request filtering in the proxy.'), 'unix-socket': F('string', 'u', 'Unix socket on which to run the proxy.'), 'keepalive': F('string', null, 'keepalive specifies the keep-alive period for an active network connection.'), 'append-server-path': F('bool', null, 'If true, enables automatic path appending of the kube context server path to each request.') },
    async run(c) {
      c.auth();
      let port = c.flags.port ?? 8001;
      if (port === 0) port = 30000 + Math.floor(Math.random() * 30000);
      if ((c.env.forwards || []).some((f) => f.local === port)) c.fail(`listen tcp 127.0.0.1:${port}: bind: address already in use`);
      c.out(`Starting to serve on ${c.flags.address || '127.0.0.1'}:${port}\n`);
      const reg = { local: port, proxy: true, prefix: c.flags['api-prefix'] || '/', auth: c.auth() };
      c.env.forwards.push(reg);
      try { while (!c.aborted) await c.sleep(300); } finally { c.env.forwards.splice(c.env.forwards.indexOf(reg), 1); }
    },
  });

  // ---------------- CP ----------------
  K.def('cp', {
    short: 'Copy files and directories to and from containers',
    usage: 'kubectl cp <file-spec-src> <file-spec-dest> [flags] [options]',
    long: ' Copy files and directories to and from containers.',
    example: "  # !!!Important Note!!!\n  # Requires that the 'tar' binary is present in your container\n  # image.  If 'tar' is not present, 'kubectl cp' will fail.\n  #\n  # For advanced use cases, such as symlinks, wildcard expansion or\n  # file mode preservation, consider using 'kubectl exec'.\n  \n  # Copy /tmp/foo local file to /tmp/bar in a remote pod in namespace <some-namespace>\n  tar cf - /tmp/foo | kubectl exec -i -n <some-namespace> <some-pod> -- tar xf - -C /tmp/bar\n  \n  # Copy /tmp/foo from a remote pod to /tmp/bar locally\n  kubectl exec -n <some-namespace> <some-pod> -- tar cf - /tmp/foo | tar xf - -C /tmp/bar\n  \n  # Copy /tmp/foo_dir local directory to /tmp/bar_dir in a remote pod in the default namespace\n  kubectl cp /tmp/foo_dir <some-pod>:/tmp/bar_dir\n  \n  # Copy /tmp/foo local file to /tmp/bar in a remote pod in a specific container\n  kubectl cp /tmp/foo <some-pod>:/tmp/bar -c <specific-container>\n  \n  # Copy /tmp/foo local file to /tmp/bar in a remote pod in namespace <some-namespace>\n  kubectl cp /tmp/foo <some-namespace>/<some-pod>:/tmp/bar\n  \n  # Copy /tmp/foo from a remote pod to /tmp/bar locally\n  kubectl cp <some-namespace>/<some-pod>:/tmp/foo /tmp/bar",
    flags: { container: F('string', 'c', 'Container name. If omitted, use the kubectl.kubernetes.io/default-container annotation for selecting the container to be attached or the first container in the pod will be chosen'), 'no-preserve': F('bool', null, 'The copied file/directory\'s ownership and permissions will not be preserved in the container'), retries: F('int', null, 'Set number of retries to complete a copy operation from a container.') },
    async run(c) {
      if (c.pos.length !== 2) c.usageFail('source and destination are required');
      const parse = (s) => {
        const m = s.match(/^(?:([^/:]+)\/)?([^/:]+):(.*)$/);
        if (!m || s.startsWith('/') || s.startsWith('.')) return { local: s };
        return { ns: m[1] || c.ns(), pod: m[2], path: m[3] };
      };
      const src = parse(c.pos[0]), dst = parse(c.pos[1]);
      if (src.local && dst.local) c.fail('one of src or dest must be a local file specification');
      if (!src.local && !dst.local) c.fail('one of src or dest must be a local file specification');
      const remote = src.local ? dst : src;
      if (!remote.path) c.fail('remote path cannot be empty');
      const pod = c.get(pT(), remote.ns, remote.pod);
      const cn = defaultContainer(c, pod, c.flags.container);
      checkRunning(c, pod, cn);
      const spec = pod.spec.containers.find((x) => x.name === cn);
      const prof = KS.images.profile(spec.image);
      if (!prof.tools.has('tar')) c.fail(`Internal error occurred: error executing command in container: failed to exec in container: failed to start exec "${U.hex(64)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "tar": executable file not found in $PATH: unknown`);
      if (src.local) {
        const files = c.env.fs.isDir(src.local) ? c.env.fs.walk(src.local) : null;
        if (files) {
          for (const [rel, content] of Object.entries(files)) {
            const e = c.cluster.podWriteFile(pod, cn, dst.path.replace(/\/$/, '') + '/' + rel, content);
            if (e) c.fail(`tar: can't create '${rel}': ${e}`);
          }
        } else {
          const content = c.env.fs.read(src.local);
          if (content === null) c.fail(`${src.local} doesn't exist in local filesystem`);
          const e = c.cluster.podWriteFile(pod, cn, dst.path, content);
          if (e) c.fail(`tar: can't create '${dst.path}': ${e}`);
        }
      } else {
        const fsys = c.cluster.podFileSystem(pod, cn);
        const path = src.path.replace(/\/$/, '');
        if (src.path.startsWith('/')) c.err("tar: removing leading '/' from member names\n");
        if (typeof fsys[path] === 'string') c.env.fs.write(dst.local, fsys[path]);
        else {
          const under = Object.keys(fsys).filter((k) => k.startsWith(path + '/') && typeof fsys[k] === 'string' && !k.endsWith('/'));
          if (!under.length) c.fail(`${path}: No such file or directory`);
          for (const k of under) c.env.fs.write(dst.local.replace(/\/$/, '') + '/' + k.slice(path.length + 1), fsys[k]);
        }
      }
    },
  });

  // ---------------- TOP ----------------
  const topRows = (rows) => U.tabwrite(rows.map((r) => r.join('\t') + '\t').join('\n'), 0, 3);
  K.def('top', {
    short: 'Display resource (CPU/memory) usage',
    usage: 'kubectl top [flags] [options]',
    long: ' Display resource (CPU/memory) usage.\n\n The top command allows you to see the resource consumption for nodes or pods.\n\n This command requires Metrics Server to be correctly configured and working on the server.',
    sub: {
      node: {
        alias: ['nodes', 'no'],
        short: 'Display resource (CPU/memory) usage of nodes',
        usage: 'kubectl top node [NAME | -l label] [flags] [options]',
        flags: { selector: F('string', 'l', 'Selector (label query) to filter on.'), 'sort-by': F('string', null, "If non-empty, sort nodes list using specified field. The field can be either 'cpu' or 'memory'."), 'no-headers': F('bool', null, 'If present, print output without headers'), 'show-capacity': F('bool', null, 'Print node resources based on Capacity instead of Allocatable(default) of the nodes.'), 'use-protocol-buffers': F('bool', null, 'Enables using protocol-buffers to access Metrics API.') },
        async run(c) {
          c.auth();
          if (!c.cluster.metricsAvailable()) c.fail('Metrics API not available');
          let nodes = c.list(S.byId('nodes'), null, { labelSelector: c.flags.selector });
          if (c.pos[0]) nodes = [c.get(S.byId('nodes'), '', c.pos[0])];
          const rows = nodes.map((n) => {
            const u = c.cluster.nodeUsage(n.metadata.name);
            const cap = c.flags['show-capacity'] ? n.status.capacity : n.status.allocatable;
            const cpuM = Math.round(u.cpu * 1000);
            return { n: n.metadata.name, cpu: cpuM, mem: u.mem, r: [n.metadata.name, cpuM + 'm', Math.round((cpuM / U.cpuMilli(cap.cpu)) * 100) + '%', U.topMem(u.mem), Math.round((u.mem / U.parseQuantity(cap.memory)) * 100) + '%'] };
          });
          if (c.flags['sort-by'] === 'cpu') rows.sort((a, b) => b.cpu - a.cpu);
          if (c.flags['sort-by'] === 'memory') rows.sort((a, b) => b.mem - a.mem);
          const out = rows.map((x) => x.r);
          if (!c.flags['no-headers']) out.unshift(['NAME', 'CPU(cores)', 'CPU(%)', 'MEMORY(bytes)', 'MEMORY(%)']);
          c.out(topRows(out) + '\n');
        },
      },
      pod: {
        alias: ['pods', 'po'],
        short: 'Display resource (CPU/memory) usage of pods',
        usage: 'kubectl top pod [NAME | -l label] [flags] [options]',
        flags: { selector: F('string', 'l', 'Selector (label query) to filter on.'), 'field-selector': F('string', null, 'Selector (field query) to filter on.'), 'all-namespaces': F('bool', 'A', 'If present, list the requested object(s) across all namespaces.'), containers: F('bool', null, 'If present, print usage of containers within a pod.'), 'sort-by': F('string', null, "If non-empty, sort pods list using specified field. The field can be either 'cpu' or 'memory'."), 'no-headers': F('bool', null, 'If present, print output without headers.'), sum: F('bool', null, 'Print the sum of the resource usage'), 'use-protocol-buffers': F('bool', null, 'Enables using protocol-buffers to access Metrics API.') },
        async run(c) {
          c.auth();
          if (!c.cluster.metricsAvailable()) c.fail('Metrics API not available');
          const ns = c.ns();
          const allNs = c.flags['all-namespaces'];
          let pods;
          if (c.pos[0]) pods = [c.get(pT(), ns, c.pos[0])];
          else pods = c.list(pT(), allNs ? null : ns, { labelSelector: c.flags.selector, fieldSelector: c.flags['field-selector'] });
          const rows = [];
          for (const p of pods) {
            const m = c.cluster.podMetrics(p);
            if (!m) {
              if (c.pos[0]) c.fail(`Metrics not available for pod ${p.metadata.namespace}/${p.metadata.name}, age: ${((Date.now() - U.ms(p.metadata.creationTimestamp)) / 1000).toFixed(9)}s`);
              continue;
            }
            if (c.flags.containers) for (const x of m) rows.push({ cpu: x.cpu, mem: x.mem, r: [...(allNs ? [p.metadata.namespace] : []), p.metadata.name, x.name, Math.round(x.cpu * 1000) + 'm', U.topMem(x.mem)] });
            else {
              const cpu = m.reduce((a, x) => a + x.cpu, 0), mem = m.reduce((a, x) => a + x.mem, 0);
              rows.push({ cpu, mem, r: [...(allNs ? [p.metadata.namespace] : []), p.metadata.name, Math.round(cpu * 1000) + 'm', U.topMem(mem)] });
            }
          }
          if (!rows.length) { c.err(allNs ? 'No resources found\n' : `No resources found in ${ns} namespace.\n`); return; }
          if (c.flags['sort-by'] === 'cpu') rows.sort((a, b) => b.cpu - a.cpu);
          if (c.flags['sort-by'] === 'memory') rows.sort((a, b) => b.mem - a.mem);
          const out = rows.map((x) => x.r);
          if (!c.flags['no-headers']) out.unshift([...(allNs ? ['NAMESPACE'] : []), ...(c.flags.containers ? ['POD', 'NAME'] : ['NAME']), 'CPU(cores)', 'MEMORY(bytes)']);
          if (c.flags.sum) {
            const n = out[0].length;
            const cpu = rows.reduce((a, x) => a + x.cpu, 0), mem = rows.reduce((a, x) => a + x.mem, 0);
            out.push(Array(n).fill('').map((_, i) => (i === n - 2 ? '________' : i === n - 1 ? '________' : '')));
            out.push(Array(n).fill('').map((_, i) => (i === n - 2 ? Math.round(cpu * 1000) + 'm' : i === n - 1 ? U.topMem(mem) : '')));
          }
          c.out(topRows(out) + '\n');
        },
      },
    },
    async run(c) { K.printHelp(c, 'kubectl top', CMD.top); },
  });

  // ---------------- CORDON / UNCORDON / DRAIN / TAINT ----------------
  const cordon = (on) => async (c) => {
    const nodes = c.flags.selector ? c.list(S.byId('nodes'), null, { labelSelector: c.flags.selector }) : c.pos.map((n) => c.get(S.byId('nodes'), '', n));
    if (!nodes.length) c.usageFail('USAGE: ' + (on ? 'cordon' : 'uncordon') + ' NODE [flags]');
    for (const n of nodes) {
      if (!!n.spec.unschedulable === on) { c.out(`node/${n.metadata.name} already ${on ? 'cordoned' : 'uncordoned'}\n`); continue; }
      if (!c.dryRun()) c.patch(S.byId('nodes'), '', n.metadata.name, { spec: { unschedulable: on ? true : null } }, 'merge');
      c.out(`node/${n.metadata.name} ${on ? 'cordoned' : 'uncordoned'}${c.drySuffix()}\n`);
    }
  };
  const cordonFlags = { ...DRY, selector: F('string', 'l', 'Selector (label query) to filter on') };
  K.def('cordon', { short: 'Mark node as unschedulable', usage: 'kubectl cordon NODE [flags] [options]', long: ' Mark node as unschedulable.', example: '  # Mark node "foo" as unschedulable\n  kubectl cordon foo', flags: cordonFlags, run: cordon(true) });
  K.def('uncordon', { short: 'Mark node as schedulable', usage: 'kubectl uncordon NODE [flags] [options]', long: ' Mark node as schedulable.', example: '  # Mark node "foo" as schedulable\n  kubectl uncordon foo', flags: cordonFlags, run: cordon(false) });
  K.def('drain', {
    short: 'Drain node in preparation for maintenance',
    usage: 'kubectl drain NODE [flags] [options]',
    long: " Drain node in preparation for maintenance.\n\n The given node will be marked unschedulable to prevent new pods from arriving. 'drain' evicts the pods if the API server supports https://kubernetes.io/docs/concepts/workloads/pods/disruptions/ eviction https://kubernetes.io/docs/concepts/workloads/pods/disruptions/ . Otherwise, it will use normal DELETE to delete the pods. The 'drain' evicts or deletes all pods except mirror pods (which cannot be deleted through the API server).  If there are daemon set-managed pods, drain will not proceed without --ignore-daemonsets, and regardless it will not delete any daemon set-managed pods, because those pods would be immediately replaced by the daemon set controller, which ignores unschedulable markings.  If there are any pods that are neither mirror pods nor managed by a replication controller, replica set, daemon set, stateful set, or job, then drain will not delete any pods unless you use --force.  --force will also allow deletion to proceed if the managing resource of one or more pods is missing.\n\n 'drain' waits for graceful termination. You should not operate on the machine until the command completes.\n\n When you are ready to put the node back into service, use kubectl uncordon, which will make the node schedulable again.",
    example: '  # Drain node "foo", even if there are pods not managed by a replication controller, replica set, job, daemon set, or stateful set on it\n  kubectl drain foo --force\n  \n  # As above, but abort if there are pods not managed by a replication controller, replica set, job, daemon set, or stateful set, and use a grace period of 15 minutes\n  kubectl drain foo --grace-period=900',
    flags: { ...DRY, force: F('bool', null, 'Continue even if there are pods that do not declare a controller.'), 'ignore-daemonsets': F('bool', null, 'Ignore DaemonSet-managed pods.'), 'delete-emptydir-data': F('bool', null, 'Continue even if there are pods using emptyDir (local data that will be deleted when the node is drained).'), 'delete-local-data': F('bool', null, 'deprecated'), 'grace-period': F('int', null, 'Period of time in seconds given to each pod to terminate gracefully. If negative, the default value specified in the pod will be used.'), timeout: F('string', null, 'The length of time to wait before giving up, zero means infinite'), 'pod-selector': F('string', null, 'Label selector to filter pods on the node'), selector: F('string', 'l', 'Selector (label query) to filter on'), 'disable-eviction': F('bool', null, 'Force drain to use delete, even if eviction is supported.'), 'skip-wait-for-delete-timeout': F('int', null, 'If pod DeletionTimestamp older than N seconds, skip waiting for the pod.'), 'chunk-size': F('int', null, 'Return large lists in chunks rather than all at once.') },
    async run(c) {
      if (!c.pos.length && !c.flags.selector) c.usageFail('USAGE: drain NODE [flags]');
      const nodes = c.pos.length ? c.pos.map((n) => c.get(S.byId('nodes'), '', n)) : c.list(S.byId('nodes'), null, { labelSelector: c.flags.selector });
      const dry = c.dryRun();
      for (const n of nodes) {
        const name = n.metadata.name;
        if (!n.spec.unschedulable) { if (!dry) c.patch(S.byId('nodes'), '', name, { spec: { unschedulable: true } }, 'merge'); c.out(`node/${name} cordoned${c.drySuffix()}\n`); }
        else c.out(`node/${name} already cordoned\n`);
        let pods = c.cluster.rawList(pT()).filter((p) => p.spec.nodeName === name && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
        if (c.flags['pod-selector']) pods = pods.filter((p) => U.matchLabelString(c.flags['pod-selector'], p.metadata.labels));
        const ds = [], bare = [], local = [], evict = [];
        for (const p of pods) {
          const id = `${p.metadata.namespace}/${p.metadata.name}`;
          if ((p.metadata.annotations || {})['kubernetes.io/config.mirror']) continue;
          const owner = (p.metadata.ownerReferences || []).find((r) => r.controller);
          if (owner && owner.kind === 'DaemonSet') { ds.push(id); continue; }
          if (!owner) bare.push(id);
          if ((p.spec.volumes || []).some((v) => v.emptyDir)) local.push(id);
          evict.push(p);
        }
        const errs = [];
        if (ds.length && !c.flags['ignore-daemonsets']) errs.push(`cannot delete DaemonSet-managed Pods (use --ignore-daemonsets to ignore): ${ds.join(', ')}`);
        if (bare.length && !c.flags.force) errs.push(`cannot delete Pods that declare no controller (use --force to override): ${bare.join(', ')}`);
        if (local.length && !(c.flags['delete-emptydir-data'] || c.flags['delete-local-data'])) errs.push(`cannot delete Pods with local storage (use --delete-emptydir-data to override): ${local.join(', ')}`);
        if (errs.length) {
          c.err(`error: unable to drain node "${name}" due to error: ${errs.join(', ')}, continuing command...\nThere are pending nodes to be drained:\n ${name}\n${errs.join('\n')}\n`);
          throw new Exit(1);
        }
        const warns = [];
        if (ds.length) warns.push(`ignoring DaemonSet-managed Pods: ${ds.join(', ')}`);
        if (bare.length) warns.push(`deleting Pods that declare no controller: ${bare.join(', ')}`);
        if (warns.length) c.err(`Warning: ${warns.join('; ')}\n`);
        if (dry) { for (const p of evict) c.out(`evicting pod ${p.metadata.namespace}/${p.metadata.name} (dry run)\n`); c.out(`node/${name} drained (dry run)\n`); continue; }
        const timeout = c.flags.timeout ? U.parseDuration(c.flags.timeout) * 1000 : 0;
        const start = Date.now();
        const pending = new Set(evict.map((p) => p.metadata.uid));
        const evicted = new Set();
        for (const p of evict) c.out(`evicting pod ${p.metadata.namespace}/${p.metadata.name}\n`);
        while (pending.size) {
          for (const p of evict) {
            if (!pending.has(p.metadata.uid) || evicted.has(p.metadata.uid)) continue;
            try {
              if (c.flags['disable-eviction']) c.del(pT(), p.metadata.namespace, p.metadata.name, { gracePeriodSeconds: c.flags['grace-period'] >= 0 ? c.flags['grace-period'] : undefined });
              else c.cluster.evict(p.metadata.namespace, p.metadata.name, c.auth());
              evicted.add(p.metadata.uid);
            } catch (e) {
              if (e.code === 429) c.err(`error when evicting pods/"${p.metadata.name}" -n "${p.metadata.namespace}" (will retry after 5s): ${e.message}\n`);
              else if (e.code === 404) { evicted.add(p.metadata.uid); }
              else throw e;
            }
          }
          for (const p of evict) {
            if (!pending.has(p.metadata.uid) || !evicted.has(p.metadata.uid)) continue;
            const cur = c.cluster.raw(pT(), p.metadata.namespace, p.metadata.name);
            if (!cur || cur.metadata.uid !== p.metadata.uid) { pending.delete(p.metadata.uid); c.out(`pod/${p.metadata.name} evicted\n`); }
          }
          if (!pending.size) break;
          if (timeout && Date.now() - start > timeout) {
            c.err(`There are pending pods in node "${name}" when an error occurred: [error when waiting for pod "${evict.find((p) => pending.has(p.metadata.uid)).metadata.name}" in namespace "${evict[0].metadata.namespace}" to terminate: global timeout reached: ${c.flags.timeout}]\nerror: unable to drain node "${name}" due to error: [error when waiting for pod to terminate: global timeout reached: ${c.flags.timeout}], continuing command...\nThere are pending nodes to be drained:\n ${name}\n`);
            throw new Exit(1);
          }
          await c.sleep(evicted.size < evict.length ? 1500 : 250);
        }
        c.out(`node/${name} drained\n`);
      }
    },
  });
  K.def('taint', {
    short: 'Update the taints on one or more nodes',
    usage: 'kubectl taint NODE NAME KEY_1=VAL_1:TAINT_EFFECT_1 ... KEY_N=VAL_N:TAINT_EFFECT_N [flags] [options]',
    long: ' Update the taints on one or more nodes.\n\n  *  A taint consists of a key, value, and effect. As an argument here, it is expressed as key=value:effect.\n  *  The key must begin with a letter or number, and may contain letters, numbers, hyphens, dots, and underscores, up to 253 characters.\n  *  Optionally, the key can begin with a DNS subdomain prefix and a single \'/\', like example.com/my-app.\n  *  The value is optional. If given, it must begin with a letter or number, and may contain letters, numbers, hyphens, dots, and underscores, up to 63 characters.\n  *  The effect must be NoSchedule, PreferNoSchedule or NoExecute.\n  *  Currently taint can only apply to node.',
    example: "  # Update node 'foo' with a taint with key 'dedicated' and value 'special-user' and effect 'NoSchedule'\n  # If a taint with that key and effect already exists, its value is replaced as specified\n  kubectl taint nodes foo dedicated=special-user:NoSchedule\n  \n  # Remove from node 'foo' the taint with key 'dedicated' and effect 'NoSchedule' if one exists\n  kubectl taint nodes foo dedicated:NoSchedule-\n  \n  # Remove from node 'foo' all the taints with key 'dedicated'\n  kubectl taint nodes foo dedicated-\n  \n  # Add a taint with key 'dedicated' on nodes having label myLabel=X\n  kubectl taint node -l myLabel=X  dedicated=foo:PreferNoSchedule\n  \n  # Add to node 'foo' a taint with key 'bar' and no value\n  kubectl taint nodes foo bar:NoSchedule",
    flags: { ...PRINT, ...DRY, selector: F('string', 'l', 'Selector (label query) to filter on'), all: F('bool', null, 'Select all nodes in the cluster'), overwrite: F('bool', null, 'If true, allow taints to be overwritten, otherwise reject taint updates that overwrite existing taints.'), validate: F('string', null, 'Must be one of: strict (or true), warn, ignore (or false).', 'strict'), 'field-manager': F('string', null, 'Name of the manager used to track field ownership.') },
    async run(c) {
      const args = [...c.pos];
      if (!args.length) c.usageFail('at least one taint update is required');
      const t = c.type(args.shift());
      if (t.id !== 'nodes') c.fail(`invalid resource type ${t.plural}, only node types are supported`);
      let names = [];
      const specs = [];
      for (const a of args) (/[=:]|-$/.test(a) ? specs : names).push(a);
      if (!specs.length) c.fail('at least one taint update is required');
      let nodes;
      if (c.flags.all) nodes = c.list(t, null, {});
      else if (c.flags.selector) nodes = c.list(t, null, { labelSelector: c.flags.selector });
      else nodes = names.map((n) => c.get(t, '', n));
      const adds = [], dels = [];
      for (const s of specs) {
        if (s.endsWith('-')) {
          const [kv, eff] = s.slice(0, -1).split(':');
          dels.push({ key: kv.split('=')[0], effect: eff });
          continue;
        }
        const m = s.match(/^([^=:]+)(?:=([^:]*))?:(.*)$/);
        if (!m) c.fail(`invalid taint spec: ${s}, unknown taint spec: ${s}`);
        if (!['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(m[3])) c.fail(`invalid taint spec: ${s}, invalid taint effect: ${m[3]}, unsupported taint effect`);
        adds.push({ key: m[1], ...(m[2] ? { value: m[2] } : {}), effect: m[3] });
      }
      for (const n of nodes) {
        let taints = [...(n.spec.taints || [])];
        let op = null;
        for (const a of adds) {
          const ex = taints.find((x) => x.key === a.key && x.effect === a.effect);
          if (ex) {
            if (!c.flags.overwrite) c.fail(`node ${n.metadata.name} already has ${a.key} taint(s) with same effect(s) and --overwrite is false`);
            Object.assign(ex, a);
            op = 'modified';
          } else { taints.push(a); op = op || 'tainted'; }
        }
        for (const d of dels) {
          const before = taints.length;
          taints = taints.filter((x) => !(x.key === d.key && (!d.effect || x.effect === d.effect)));
          if (taints.length === before) c.fail(`taint "${d.key}${d.effect ? ':' + d.effect : ''}" not found`);
          op = op === 'tainted' ? 'modified' : 'untainted';
        }
        if (!c.dryRun()) c.patch(t, '', n.metadata.name, { spec: { taints: taints.length ? taints : null } }, 'merge');
        c.out(`node/${n.metadata.name} ${op}${c.drySuffix()}\n`);
      }
    },
  });

  // ---------------- CERTIFICATE ----------------
  const csrAct = (approve) => ({
    short: approve ? 'Approve a certificate signing request' : 'Deny a certificate signing request',
    usage: `kubectl certificate ${approve ? 'approve' : 'deny'} (-f FILENAME | NAME) [flags] [options]`,
    flags: { ...FILES, ...PRINT, force: F('bool', null, `Update the CSR even if it is already ${approve ? 'approved' : 'denied'}.`) },
    async run(c) {
      const t = S.byId('certificatesigningrequests.certificates.k8s.io');
      const names = (c.flags.filename || []).length ? c.manifests().map((m) => m.obj.metadata.name) : c.pos;
      if (!names.length) c.usageFail('one or more CSRs must be specified as <name> or -f <filename>');
      for (const name of names) {
        const o = c.get(t, '', name);
        const conds = o.status.conditions || [];
        if (conds.some((x) => x.type === (approve ? 'Approved' : 'Denied')) && !c.flags.force) { c.out(`${t.kindRef}/${name} ${approve ? 'approved' : 'denied'}\n`); continue; }
        if (conds.some((x) => x.type === (approve ? 'Denied' : 'Approved'))) c.fail(`certificate signing request "${name}" is already ${approve ? 'denied' : 'approved'}`);
        const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        conds.push({ lastTransitionTime: now, lastUpdateTime: now, message: `This CSR was ${approve ? 'approved' : 'denied'} by kubectl certificate ${approve ? 'approve' : 'deny'}.`, reason: approve ? 'KubectlApprove' : 'KubectlDeny', status: 'True', type: approve ? 'Approved' : 'Denied' });
        o.status.conditions = conds;
        c.cluster.update(o, c.auth(), { subresource: 'status' });
        c.out(`${t.kindRef}/${name} ${approve ? 'approved' : 'denied'}\n`);
      }
    },
  });
  K.def('certificate', { short: 'Modify certificate resources', usage: 'kubectl certificate SUBCOMMAND [options]', long: ' Modify certificate resources.', sub: { approve: csrAct(true), deny: csrAct(false) }, async run(c) { K.printHelp(c, 'kubectl certificate', CMD.certificate); } });

  // ---------------- CLUSTER-INFO ----------------
  K.def('cluster-info', {
    short: 'Display cluster information',
    usage: 'kubectl cluster-info [flags] [options]',
    long: " Display addresses of the control plane and services with label kubernetes.io/cluster-service=true. To further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.",
    example: '  # Print the address of the control plane and cluster services\n  kubectl cluster-info',
    sub: {
      dump: {
        short: 'Dump relevant information for debugging and diagnosis',
        usage: 'kubectl cluster-info dump [flags] [options]',
        flags: { ...PRINT, 'all-namespaces': F('bool', 'A', 'If true, dump all namespaces.'), namespaces: F('strings', null, 'A comma separated list of namespaces to dump.'), 'output-directory': F('string', null, 'Where to output the files.'), 'pod-running-timeout': F('string', null, 'The length of time to wait until at least one pod is running') },
        async run(c) {
          c.auth();
          const nss = c.flags['all-namespaces'] ? c.cluster.rawList(S.byId('namespaces')).map((n) => n.metadata.name) : c.flags.namespaces || ['default', 'kube-system'];
          const list = (t, ns) => ({ kind: t.kind + 'List', apiVersion: t.apiVersion, metadata: { resourceVersion: String(c.cluster.rv) }, items: c.cluster.list(t, ns, {}) });
          let out = JSON.stringify(list(S.byId('nodes'), null), null, 4) + '\n';
          for (const ns of nss) {
            for (const id of ['events', 'replicationcontrollers', 'services', 'daemonsets.apps', 'deployments.apps', 'replicasets.apps', 'pods']) out += JSON.stringify(list(S.byId(id), ns), null, 4) + '\n';
            for (const p of c.cluster.rawList(pT(), ns)) for (const ct of p.spec.containers) {
              out += `==== START logs for container ${ct.name} of pod ${ns}/${p.metadata.name} ====\n`;
              try { out += c.cluster.podLogs(ns, p.metadata.name, { container: ct.name }).join('\n') + '\n'; } catch (e) { out += `Request log error: ${e.message}\n`; }
              out += `==== END logs for container ${ct.name} of pod ${ns}/${p.metadata.name} ====\n`;
            }
          }
          if (c.flags['output-directory']) {
            c.env.fs.write(c.flags['output-directory'].replace(/\/$/, '') + '/nodes.json', out);
            c.out(`Cluster info dumped to ${c.flags['output-directory']}\n`);
          } else c.out(out);
        },
      },
    },
    async run(c) {
      c.auth();
      const g = (s) => `\x1b[0;32m${s}\x1b[0m`, y = (s) => `\x1b[0;33m${s}\x1b[0m`;
      let s = `${g('Kubernetes control plane')} is running at ${y(SERVER)}\n`;
      for (const svc of c.cluster.rawList(S.byId('services'), 'kube-system')) {
        if ((svc.metadata.labels || {})['kubernetes.io/cluster-service'] !== 'true') continue;
        const p = (svc.spec.ports || [])[0];
        s += `${g((svc.metadata.labels || {})['kubernetes.io/name'] || svc.metadata.name)} is running at ${y(`${SERVER}/api/v1/namespaces/kube-system/services/${svc.metadata.name}:${p.name || p.port}/proxy`)}\n`;
      }
      s += "\nTo further debug and diagnose cluster problems, use 'kubectl cluster-info dump'.\n";
      c.out(s);
    },
  });

  // ---------------- API-RESOURCES / API-VERSIONS ----------------
  K.def('api-resources', {
    short: 'Print the supported API resources on the server',
    usage: 'kubectl api-resources [flags] [options]',
    long: ' Print the supported API resources on the server.',
    example: '  # Print the supported API resources\n  kubectl api-resources\n  \n  # Print the supported API resources with more information\n  kubectl api-resources -o wide\n  \n  # Print the supported API resources sorted by a column\n  kubectl api-resources --sort-by=name\n  \n  # Print the supported namespaced resources\n  kubectl api-resources --namespaced=true\n  \n  # Print the supported non-namespaced resources\n  kubectl api-resources --namespaced=false\n  \n  # Print the supported API resources with a specific APIGroup\n  kubectl api-resources --api-group=rbac.authorization.k8s.io',
    flags: { output: F('string', 'o', 'Output format. One of: (wide, name).'), 'api-group': F('string', null, 'Limit to resources in the specified API group.'), namespaced: F('bool', null, 'If false, non-namespaced resources will be returned, otherwise returning namespaced resources by default.'), verbs: F('strings', null, 'Limit to resources that support the specified verbs.'), 'sort-by': F('string', null, "If non-empty, sort list of resources using specified field. The field can be either 'name' or 'kind'."), 'no-headers': F('bool', null, "When using the default or custom-column output format, don't print headers (default print headers)."), cached: F('bool', null, 'Use the cached list of resources if available.'), categories: F('strings', null, 'Limit to resources that belong to the specified categories.') },
    async run(c) {
      c.auth();
      let types = S.types.slice();
      if (c.flags['api-group'] !== undefined) types = types.filter((t) => t.group === c.flags['api-group']);
      if (c.seen.namespaced) types = types.filter((t) => t.namespaced === c.flags.namespaced);
      if (c.flags.verbs) types = types.filter((t) => c.flags.verbs.every((v) => t.verbs.includes(v)));
      if (c.flags.categories) types = types.filter((t) => c.flags.categories.some((x) => t.categories.includes(x)));
      types.sort((a, b) => {
        if (c.flags['sort-by'] === 'name') return a.plural < b.plural ? -1 : a.plural > b.plural ? 1 : 0;
        if (c.flags['sort-by'] === 'kind') return a.kind < b.kind ? -1 : 1;
        if (a.group !== b.group) return a.group === '' ? -1 : b.group === '' ? 1 : a.group < b.group ? -1 : 1;
        return a.plural < b.plural ? -1 : a.plural > b.plural ? 1 : 0;
      });
      if (c.flags.output === 'name') { for (const t of types) c.out(`${t.plural}${t.group ? '.' + t.group : ''}\n`); return; }
      const wide = c.flags.output === 'wide';
      const rows = types.map((t) => [t.plural, t.short.join(','), t.apiVersion, String(t.namespaced), t.kind, ...(wide ? [`[${t.verbs.join(' ')}]`, t.categories.join(',')] : [])]);
      if (!c.flags['no-headers']) rows.unshift(['NAME', 'SHORTNAMES', 'APIVERSION', 'NAMESPACED', 'KIND', ...(wide ? ['VERBS', 'CATEGORIES'] : [])]);
      c.out(U.table(rows) + '\n');
    },
  });
  K.def('api-versions', {
    short: 'Print the supported API versions on the server, in the form of "group/version"',
    usage: 'kubectl api-versions [flags] [options]',
    long: ' Print the supported API versions on the server, in the form of "group/version".',
    example: '  # Print the supported API versions\n  kubectl api-versions',
    flags: {},
    async run(c) { c.auth(); c.out(S.apiVersions().join('\n') + '\n'); },
  });

  // ---------------- EXPLAIN ----------------
  const docKindFor = (t) => (S.docs[t.kind] ? t.kind : null);
  K.def('explain', {
    short: 'Get documentation for a resource',
    usage: 'kubectl explain TYPE [--recursive=FALSE|TRUE] [--api-version=api-version-group] [--output=plaintext|plaintext-openapiv2] [options]',
    long: ' Describe fields and structure of various resources.\n\n This command describes the fields associated with each supported API resource. Fields are identified via a simple JSONPath identifier:\n\n        <type>.<fieldName>[.<fieldName>]\n        \n Information about each field is retrieved from the server in OpenAPI format.\n\nUse "kubectl api-resources" for a complete list of supported resources.',
    example: '  # Get the documentation of the resource and its fields\n  kubectl explain pods\n  \n  # Get all the fields in the resource\n  kubectl explain pods --recursive\n  \n  # Get the explanation for deployment in supported api versions\n  kubectl explain deployments --api-version=apps/v1\n  \n  # Get the documentation of a specific field of a resource\n  kubectl explain pods.spec.containers\n  \n  # Get the documentation of resources in different format\n  kubectl explain deployment --output=plaintext-openapiv2',
    flags: { recursive: F('bool', null, 'When true, print the name of all the fields recursively. Otherwise, print the available fields with their description.'), 'api-version': F('string', null, 'Use given api-version (group/version) of the resource.'), output: F('string', null, 'Format in which to render the schema. Valid values are: (plaintext, plaintext-openapiv2).') },
    async run(c) {
      c.auth();
      if (!c.pos.length) c.fail('You must specify the type of resource to explain. Use "kubectl api-resources" for a complete list of supported resources.');
      const [res, ...path] = c.pos[0].split('.');
      let t = S.resolve(res);
      if (c.flags['api-version']) {
        const [g, v] = c.flags['api-version'].includes('/') ? c.flags['api-version'].split('/') : ['', c.flags['api-version']];
        t = S.types.find((x) => (x.plural === (t ? t.plural : res)) && x.group === g && x.version === v) || null;
        if (!t) c.fail(`couldn't find resource for "${res}"`);
      }
      if (!t) c.fail(`the server doesn't have a resource type "${res}"`);
      const w = (s, ind) => K.wrap(s, 76, ind);
      let type = docKindFor(t);
      let field = null, fieldType = null, fieldDesc = null;
      for (let i = 0; i < path.length; i++) {
        const doc = type && S.docs[type];
        const f = doc && doc.fields[path[i]];
        if (!f) c.fail(`field "${path[i]}" does not exist`);
        field = path[i];
        fieldType = f[0];
        fieldDesc = f[1];
        type = f[0].replace(/^\[\]/, '').replace(/^map\[string\]/, '');
      }
      let out = `GROUP:      ${t.group}\nKIND:       ${t.kind}\nVERSION:    ${t.version}\n\n`;
      if (!t.group) out = out.replace(/^GROUP:.*\n/, '');
      const doc = type ? S.docs[type] : null;
      if (field) out += `FIELD: ${field} <${fieldType}>\n\n`;
      if (field && !doc) out += '\n';
      out += 'DESCRIPTION:\n';
      if (field) out += w(fieldDesc, '    ') + '\n';
      if (doc) out += w(doc.desc, '    ') + '\n';
      if (!doc && !field) out += w(`${t.kind} is a Kubernetes resource.`, '    ') + '\n';
      out += '    \n';
      if (doc) {
        out += 'FIELDS:\n';
        const walk = (d, ind, depth) => {
          for (const k of Object.keys(d.fields).sort()) {
            const f = d.fields[k];
            out += `${' '.repeat(ind)}${k}\t<${f[0]}>${f[2] ? ' -required-' : ''}\n`;
            if (c.flags.recursive) {
              const sub = S.docs[f[0].replace(/^\[\]/, '').replace(/^map\[string\]/, '')];
              if (sub && depth < 6) walk(sub, ind + 2, depth + 1);
            } else out += w(f[1], ' '.repeat(ind + 2)) + '\n\n';
          }
        };
        walk(doc, 2, 0);
      }
      c.out(out.replace(/\n+$/, '\n') + (c.flags.recursive ? '\n' : '\n'));
    },
  });

  // ---------------- CONFIG ----------------
  const kcPath = (c) => c.kcPath();
  const redact = (kc, raw) => {
    const o = U.clone(kc);
    if (raw) return o;
    for (const cl of o.clusters || []) if (cl.cluster && cl.cluster['certificate-authority-data']) cl.cluster['certificate-authority-data'] = 'DATA+OMITTED';
    for (const u of o.users || []) {
      if (!u.user) continue;
      for (const k of ['client-certificate-data', 'client-key-data']) if (u.user[k]) u.user[k] = 'DATA+OMITTED';
      if (u.user.token) u.user.token = 'REDACTED';
      if (u.user.password) u.user.password = 'REDACTED';
    }
    return o;
  };
  const cfgSub = {
    view: {
      short: 'Display merged kubeconfig settings or a specified kubeconfig file',
      usage: 'kubectl config view [flags] [options]',
      flags: { ...PRINT, minify: F('bool', null, 'Remove all information not used by current-context from the output'), raw: F('bool', null, 'Display raw byte data and sensitive data'), flatten: F('bool', null, 'Flatten the resulting kubeconfig file into self-contained output (useful for creating portable kubeconfig files)'), merge: F('bool', null, 'Merge the full hierarchy of kubeconfig files') },
      async run(c) {
        let kc = c.kubeconfig();
        if (c.flags.minify) {
          const cur = kc['current-context'];
          if (!cur) c.fail('current-context must exist in order to minify');
          const ctx = kc.contexts.find((x) => x.name === cur);
          kc = { ...kc, contexts: [ctx], clusters: kc.clusters.filter((x) => x.name === ctx.context.cluster), users: kc.users.filter((x) => x.name === ctx.context.user) };
        }
        const data = redact(kc, c.flags.raw || c.flags.flatten);
        const order = { apiVersion: data.apiVersion || 'v1', clusters: data.clusters, contexts: data.contexts, 'current-context': data['current-context'] || '', kind: 'Config', preferences: data.preferences || {}, users: data.users };
        if (!c.flags.output) c.flags.output = 'yaml';
        c.printObjects([{ t: { kindRef: 'config' }, o: order }], { single: true });
      },
    },
    'current-context': { short: 'Display the current-context', usage: 'kubectl config current-context [options]', async run(c) { const cur = c.kubeconfig()['current-context']; if (!cur) c.fail('current-context is not set'); c.out(cur + '\n'); } },
    'get-contexts': {
      short: 'Describe one or many contexts',
      usage: 'kubectl config get-contexts [(-o|--output=)name)] [options]',
      flags: { output: F('string', 'o', 'Output format. One of: (name).'), 'no-headers': F('bool', null, "When using the default or custom-column output format, don't print headers (default print headers).") },
      async run(c) {
        const kc = c.kubeconfig();
        let ctxs = kc.contexts;
        if (c.pos.length) { ctxs = ctxs.filter((x) => c.pos.includes(x.name)); if (!ctxs.length) c.fail(`context ${c.pos[0]} not found`); }
        if (c.flags.output === 'name') { for (const x of ctxs) c.out(x.name + '\n'); return; }
        const rows = ctxs.map((x) => [x.name === kc['current-context'] ? '*' : '', x.name, x.context.cluster || '', x.context.user || '', x.context.namespace || '']);
        if (!c.flags['no-headers']) rows.unshift(['CURRENT', 'NAME', 'CLUSTER', 'AUTHINFO', 'NAMESPACE']);
        c.out(U.tabwrite(rows.map((r) => r.join('\t')).join('\n'), 6, 3) + '\n');
      },
    },
    'get-clusters': { short: 'Display clusters defined in the kubeconfig', usage: 'kubectl config get-clusters [options]', async run(c) { c.out('NAME\n' + c.kubeconfig().clusters.map((x) => x.name + '\n').join('')); } },
    'get-users': { short: 'Display users defined in the kubeconfig', usage: 'kubectl config get-users [options]', async run(c) { c.out('NAME\n' + c.kubeconfig().users.map((x) => x.name + '\n').join('')); } },
    'use-context': {
      alias: ['use'], short: 'Set the current-context in a kubeconfig file', usage: 'kubectl config use-context CONTEXT_NAME [options]',
      async run(c) {
        const kc = c.kubeconfig();
        const n = c.pos[0];
        if (!n) c.fail('empty context names are not allowed');
        if (!kc.contexts.some((x) => x.name === n)) c.fail(`no context exists with the name: "${n}"`);
        kc['current-context'] = n;
        c.saveKubeconfig(kc);
        c.out(`Switched to context "${n}".\n`);
      },
    },
    'set-context': {
      short: 'Set a context entry in kubeconfig', usage: 'kubectl config set-context [NAME | --current] [--cluster=cluster_nickname] [--user=user_nickname] [--namespace=namespace] [options]',
      flags: { current: F('bool', null, 'Modify the current context'), namespace: F('string', 'n', 'namespace for the context entry in kubeconfig'), cluster: F('string', null, 'cluster for the context entry in kubeconfig'), user: F('string', null, 'user for the context entry in kubeconfig') },
      async run(c) {
        const kc = c.kubeconfig();
        const name = c.flags.current ? kc['current-context'] : c.pos[0];
        if (c.flags.current && c.pos.length) c.fail('you cannot specify both a context name and --current');
        if (!name) c.fail(c.flags.current ? 'no current context is set' : 'you must specify a non-empty context name or --current');
        let ctx = kc.contexts.find((x) => x.name === name);
        const created = !ctx;
        if (!ctx) { ctx = { name, context: {} }; kc.contexts.push(ctx); }
        ctx.context = ctx.context || {};
        for (const k of ['namespace', 'cluster', 'user']) if (c.seen[k]) { if (c.flags[k]) ctx.context[k] = c.flags[k]; else delete ctx.context[k]; }
        c.saveKubeconfig(kc);
        c.out(`Context "${name}" ${created ? 'created' : 'modified'}.\n`);
      },
    },
    'delete-context': { short: 'Delete the specified context from the kubeconfig', usage: 'kubectl config delete-context CONTEXT_NAME [options]', async run(c) { const kc = c.kubeconfig(); const n = c.pos[0]; if (!kc.contexts.some((x) => x.name === n)) c.fail(`cannot delete context ${n}, not in ${kcPath(c)}`); if (kc['current-context'] === n) c.err('warning: this removed your active context, use "kubectl config use-context" to select a different one\n'); kc.contexts = kc.contexts.filter((x) => x.name !== n); c.saveKubeconfig(kc); c.out(`deleted context ${n} from ${kcPath(c)}\n`); } },
    'delete-cluster': { short: 'Delete the specified cluster from the kubeconfig', usage: 'kubectl config delete-cluster NAME [options]', async run(c) { const kc = c.kubeconfig(); const n = c.pos[0]; if (!kc.clusters.some((x) => x.name === n)) c.fail(`cannot delete cluster ${n}, not in ${kcPath(c)}`); kc.clusters = kc.clusters.filter((x) => x.name !== n); c.saveKubeconfig(kc); c.out(`deleted cluster ${n} from ${kcPath(c)}\n`); } },
    'delete-user': { short: 'Delete the specified user from the kubeconfig', usage: 'kubectl config delete-user NAME [options]', async run(c) { const kc = c.kubeconfig(); const n = c.pos[0]; if (!kc.users.some((x) => x.name === n)) c.fail(`cannot delete user ${n}, not in ${kcPath(c)}`); kc.users = kc.users.filter((x) => x.name !== n); c.saveKubeconfig(kc); c.out(`deleted user ${n} from ${kcPath(c)}\n`); } },
    'rename-context': { short: 'Rename a context from the kubeconfig file', usage: 'kubectl config rename-context CONTEXT_NAME NEW_NAME [options]', async run(c) { const kc = c.kubeconfig(); const [a, b] = c.pos; const ctx = kc.contexts.find((x) => x.name === a); if (!ctx) c.fail(`cannot rename the context "${a}", it's not in ${kcPath(c)}`); if (kc.contexts.some((x) => x.name === b)) c.fail(`cannot rename the context "${a}", the context "${b}" already exists in ${kcPath(c)}`); ctx.name = b; if (kc['current-context'] === a) kc['current-context'] = b; c.saveKubeconfig(kc); c.out(`Context "${a}" renamed to "${b}".\n`); } },
    'set-cluster': {
      short: 'Set a cluster entry in kubeconfig', usage: 'kubectl config set-cluster NAME [--server=server] [--certificate-authority=path/to/certificate/authority] [--insecure-skip-tls-verify=true] [--tls-server-name=example.com] [options]',
      flags: { server: F('string', null, 'server for the cluster entry in kubeconfig'), 'certificate-authority': F('string', null, 'Path to certificate-authority file for the cluster entry in kubeconfig'), 'insecure-skip-tls-verify': F('bool', null, 'insecure-skip-tls-verify for the cluster entry in kubeconfig'), 'tls-server-name': F('string', null, 'tls-server-name for the cluster entry in kubeconfig'), 'embed-certs': F('bool', null, 'embed-certs for the cluster entry in kubeconfig'), 'proxy-url': F('string', null, 'proxy-url for the cluster entry in kubeconfig') },
      async run(c) {
        const kc = c.kubeconfig();
        const n = c.pos[0];
        if (!n) c.usageFail('Unexpected args: []');
        let cl = kc.clusters.find((x) => x.name === n);
        if (!cl) { cl = { name: n, cluster: {} }; kc.clusters.push(cl); }
        if (c.flags.server) cl.cluster.server = c.flags.server;
        if (c.flags['certificate-authority']) { if (c.flags['embed-certs']) cl.cluster['certificate-authority-data'] = U.b64e(c.env.fs.read(c.flags['certificate-authority']) || ''); else cl.cluster['certificate-authority'] = c.flags['certificate-authority']; }
        if (c.seen['insecure-skip-tls-verify']) cl.cluster['insecure-skip-tls-verify'] = c.flags['insecure-skip-tls-verify'];
        if (c.flags['tls-server-name']) cl.cluster['tls-server-name'] = c.flags['tls-server-name'];
        c.saveKubeconfig(kc);
        c.out(`Cluster "${n}" set.\n`);
      },
    },
    'set-credentials': {
      short: 'Set a user entry in kubeconfig', usage: 'kubectl config set-credentials NAME [--client-certificate=path/to/certfile] [--client-key=path/to/keyfile] [--token=bearer_token] [--username=basic_user] [--password=basic_password] [--auth-provider=provider_name] [--auth-provider-arg=key=value] [--exec-command=exec_command] [--exec-api-version=exec_api_version] [--exec-arg=arg] [--exec-env=key=value] [options]',
      flags: { 'client-certificate': F('string', null, 'Path to client-certificate file for the user entry in kubeconfig'), 'client-key': F('string', null, 'Path to client-key file for the user entry in kubeconfig'), token: F('string', null, 'token for the user entry in kubeconfig'), username: F('string', null, 'username for the user entry in kubeconfig'), password: F('string', null, 'password for the user entry in kubeconfig'), 'embed-certs': F('bool', null, 'Embed client cert/key for the user entry in kubeconfig') },
      async run(c) {
        const kc = c.kubeconfig();
        const n = c.pos[0];
        if (!n) c.usageFail('Unexpected args: []');
        let u = kc.users.find((x) => x.name === n);
        if (!u) { u = { name: n, user: {} }; kc.users.push(u); }
        for (const [flag, key] of [['client-certificate', 'client-certificate'], ['client-key', 'client-key']]) {
          if (!c.flags[flag]) continue;
          if (c.flags['embed-certs']) {
            const d = c.env.fs.read(c.flags[flag]);
            if (d === null) c.fail(`open ${c.flags[flag]}: no such file or directory`);
            u.user[key + '-data'] = U.b64e(d);
            delete u.user[key];
          } else { u.user[key] = c.flags[flag]; delete u.user[key + '-data']; }
        }
        if (c.flags.token) u.user.token = c.flags.token;
        if (c.flags.username) u.user.username = c.flags.username;
        if (c.flags.password) u.user.password = c.flags.password;
        c.saveKubeconfig(kc);
        c.out(`User "${n}" set.\n`);
      },
    },
    set: {
      short: 'Set an individual value in a kubeconfig file', usage: 'kubectl config set PROPERTY_NAME PROPERTY_VALUE [options]',
      flags: { 'set-raw-bytes': F('bool', null, 'When writing a []byte PROPERTY_VALUE, write the given string directly without base64 decoding.') },
      async run(c) {
        const [prop, val] = c.pos;
        if (!prop || val === undefined) c.usageFail('Unexpected args: ' + JSON.stringify(c.pos));
        const kc = c.kubeconfig();
        const parts = prop.split('.');
        const listName = { clusters: 'clusters', contexts: 'contexts', users: 'users' }[parts[0]];
        if (listName) {
          let ent = kc[listName].find((x) => x.name === parts[1]);
          if (!ent) { ent = { name: parts[1], [listName.slice(0, -1)]: {} }; kc[listName].push(ent); }
          let cur = ent[listName.slice(0, -1)];
          for (let i = 2; i < parts.length - 1; i++) cur = cur[parts[i]] = cur[parts[i]] || {};
          cur[parts[parts.length - 1]] = val === 'true' ? true : val === 'false' ? false : val;
        } else kc[prop] = val;
        c.saveKubeconfig(kc);
        c.out(`Property "${prop}" set.\n`);
      },
    },
    unset: {
      short: 'Unset an individual value in a kubeconfig file', usage: 'kubectl config unset PROPERTY_NAME [options]',
      async run(c) {
        const prop = c.pos[0];
        const kc = c.kubeconfig();
        const parts = prop.split('.');
        if (['clusters', 'contexts', 'users'].includes(parts[0])) {
          if (parts.length === 2) kc[parts[0]] = kc[parts[0]].filter((x) => x.name !== parts[1]);
          else { const ent = kc[parts[0]].find((x) => x.name === parts[1]); if (!ent) c.fail(`current map key \`${parts[1]}\` is invalid`); let cur = ent[parts[0].slice(0, -1)]; for (let i = 2; i < parts.length - 1; i++) cur = cur[parts[i]] || {}; delete cur[parts[parts.length - 1]]; }
        } else delete kc[prop];
        c.saveKubeconfig(kc);
        c.out(`Property "${prop}" unset.\n`);
      },
    },
  };
  K.def('config', {
    short: 'Modify kubeconfig files',
    usage: 'kubectl config SUBCOMMAND [options]',
    long: ' Modify kubeconfig files using subcommands like "kubectl config set current-context my-context".\n\n The loading order follows these rules:\n\n  1.  If the --kubeconfig flag is set, then only that file is loaded. The flag may only be set once and no merging takes place.\n  2.  If $KUBECONFIG environment variable is set, then it is used as a list of paths (normal path delimiting rules for your system). These paths are merged. When a value is modified, it is modified in the file that defines the stanza. When a value is created, it is created in the first file that exists. If no files in the chain exist, then it creates the last file in the list.\n  3.  Otherwise, ${HOME}/.kube/config is used and no merging takes place.',
    sub: cfgSub,
    async run(c) { K.printHelp(c, 'kubectl config', CMD.config); },
  });

  // ---------------- VERSION ----------------
  K.def('version', {
    short: 'Print the client and server version information',
    usage: 'kubectl version [flags] [options]',
    long: ' Print the client and server version information for the current context.',
    example: '  # Print the client and server versions for the current context\n  kubectl version',
    flags: { client: F('bool', null, 'If true, shows client version only (no server required).'), output: F('string', 'o', "One of 'yaml' or 'json'.") },
    async run(c) {
      const data = { clientVersion: K.CLIENT_VERSION, kustomizeVersion: 'v5.4.2' };
      if (!c.flags.client) { c.auth(); data.serverVersion = KS.serverVersion(); }
      if (c.flags.output === 'json') { c.out(JSON.stringify(data, null, 2) + '\n'); return; }
      if (c.flags.output === 'yaml') { c.out(PR.yaml(data)); return; }
      if (c.flags.output) c.fail("--output must be 'yaml' or 'json'");
      c.out(`Client Version: v1.31.0\nKustomize Version: v5.4.2\n${c.flags.client ? '' : 'Server Version: v1.31.0\n'}`);
    },
  });

  // ---------------- AUTH ----------------
  K.def('auth', {
    short: 'Inspect authorization',
    usage: 'kubectl auth [flags] [options]',
    long: ' Inspect authorization.',
    sub: {
      'can-i': {
        short: 'Check whether an action is allowed',
        usage: 'kubectl auth can-i VERB [TYPE | TYPE/NAME | NONRESOURCEURL] [flags] [options]',
        long: " Check whether an action is allowed.\n\n VERB is a logical Kubernetes API verb like 'get', 'list', 'watch', 'delete', etc. TYPE is a Kubernetes resource. Shortcuts and groups will be resolved. NONRESOURCEURL is a partial URL that starts with \"/\". NAME is the name of a particular Kubernetes resource. This command pairs nicely with impersonation. See --as global flag.",
        example: '  # Check to see if I can create pods in any namespace\n  kubectl auth can-i create pods --all-namespaces\n  \n  # Check to see if I can list deployments in my current namespace\n  kubectl auth can-i list deployments.apps\n  \n  # Check to see if service account "foo" of namespace "dev" can list pods in the namespace "prod"\n  # You must be allowed to use impersonation for the global option "--as"\n  kubectl auth can-i list pods --as=system:serviceaccount:dev:foo -n prod\n  \n  # Check to see if I can do everything in my current namespace ("*" means all)\n  kubectl auth can-i \'*\' \'*\'\n  \n  # Check to see if I can get the job named "bar" in namespace "foo"\n  kubectl auth can-i list jobs.batch/bar -n foo\n  \n  # Check to see if I can read pod logs\n  kubectl auth can-i get pods --subresource=log\n  \n  # Check to see if I can access the URL /logs/\n  kubectl auth can-i get /logs/\n  \n  # List all allowed actions in namespace "foo"\n  kubectl auth can-i --list --namespace=foo',
        flags: { 'all-namespaces': F('bool', 'A', 'If true, check the specified action in all namespaces.'), quiet: F('bool', 'q', 'If true, suppress output and just return the exit code.'), subresource: F('string', null, 'SubResource such as pod/log or deployment/scale'), list: F('bool', null, 'If true, prints all allowed actions.'), 'no-headers': F('bool', null, 'If true, prints allowed actions without headers') },
        async run(c) {
          const who = c.auth();
          const ns = c.flags['all-namespaces'] ? '' : c.ns();
          if (c.flags.list) {
            const rules = c.cluster.rulesFor(who, ns || 'default');
            const rows = [];
            const seen = new Set();
            for (const r of rules) {
              const res = r.resources ? r.resources.flatMap((x) => (r.apiGroups || ['']).map((g) => (g && g !== '' ? `${x}.${g}` : x))) : [''];
              for (const x of res) {
                const row = [x === '*.*' ? '*.*' : x === '*' && (r.apiGroups || []).includes('*') ? '*.*' : x, `[${(r.nonResourceURLs || []).join(' ')}]`, `[${(r.resourceNames || []).join(' ')}]`, `[${r.verbs.join(' ')}]`];
                const k = row.join('|');
                if (!seen.has(k)) { seen.add(k); rows.push(row); }
              }
            }
            rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            if (!c.flags['no-headers']) rows.unshift(['Resources', 'Non-Resource URLs', 'Resource Names', 'Verbs']);
            c.out(U.tabwrite(rows.map((r) => r.join('\t')).join('\n'), 0, 3) + '\n');
            return;
          }
          const [verb, target] = c.pos;
          if (!verb || !target) c.usageFail('you must specify two arguments: verb resource or verb resource/resourceName.');
          let a;
          if (target.startsWith('/')) a = { verb, nonResourceURL: target };
          else {
            const [res, name] = target.split('/');
            let group = '', resource = res;
            if (res !== '*') {
              const t = S.resolve(res);
              if (!t) { c.err(`Warning: the server doesn't have a resource type '${res}'\n\n`); } else { group = t.group; resource = t.plural; }
            } else group = '*';
            a = { verb, group, resource, subresource: c.flags.subresource, name, namespace: ns };
          }
          const r = c.cluster.authorize(who, a);
          if (!c.flags.quiet) c.out(r.allowed ? 'yes\n' : 'no\n');
          if (!r.allowed) throw new Exit(1);
        },
      },
      whoami: {
        short: 'Experimental: Check self subject attributes',
        usage: 'kubectl auth whoami [flags] [options]',
        flags: { ...PRINT },
        async run(c) {
          const who = c.auth();
          const obj = { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview', metadata: { creationTimestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }, status: { userInfo: { groups: who.groups, username: who.user } } };
          if (c.flags.output) { c.printObjects([{ t: { kindRef: 'selfsubjectreview' }, o: obj }], { single: true }); return; }
          c.out(U.tabwrite(`ATTRIBUTE\tVALUE\nUsername\t${who.user}\nGroups\t[${who.groups.join(' ')}]`, 0, 3) + '\n');
        },
      },
      reconcile: {
        short: 'Reconciles rules for RBAC role, role binding, cluster role, and cluster role binding objects',
        usage: 'kubectl auth reconcile -f FILENAME [flags] [options]',
        flags: { ...FILES, ...PRINT, ...DRY, 'remove-extra-permissions': F('bool', null, 'If true, removes extra permissions added to roles'), 'remove-extra-subjects': F('bool', null, 'If true, removes extra subjects added to rolebindings') },
        async run(c) {
          for (const m of c.manifests()) {
            const t = c.mapObj(m.obj, m.source);
            if (!t.group.startsWith('rbac')) continue;
            const obj = U.clone(m.obj);
            if (t.namespaced) obj.metadata.namespace = obj.metadata.namespace || c.ns();
            const ex = c.cluster.raw(t, obj.metadata.namespace, obj.metadata.name);
            if (!ex) { c.create(obj, {}); c.out(`${t.kindRef}/${obj.metadata.name} reconciled\n\treconciliation required create\n`); continue; }
            const merged = U.clone(ex);
            if (obj.rules) merged.rules = c.flags['remove-extra-permissions'] ? obj.rules : [...(ex.rules || []), ...obj.rules.filter((r) => !(ex.rules || []).some((e) => JSON.stringify(e) === JSON.stringify(r)))];
            if (obj.subjects) merged.subjects = c.flags['remove-extra-subjects'] ? obj.subjects : [...(ex.subjects || []), ...obj.subjects.filter((s) => !(ex.subjects || []).some((e) => JSON.stringify(e) === JSON.stringify(s)))];
            c.update(merged, {});
            c.out(`${t.kindRef}/${obj.metadata.name} reconciled\n`);
          }
        },
      },
    },
    async run(c) { K.printHelp(c, 'kubectl auth', CMD.auth); },
  });

  // ---------------- WAIT ----------------
  K.def('wait', {
    short: 'Experimental: Wait for a specific condition on one or many resources',
    usage: "kubectl wait ([-f FILENAME] | resource.group/resource.name | resource.group [(-l label | --all)]) [--for=create|--for=delete|--for condition=available|--for=jsonpath='{}'[=value]] [options]",
    long: ' Experimental: Wait for a specific condition on one or many resources.\n\n The command takes multiple resources and waits until the specified condition is seen in the Status field of every given resource.\n\n Alternatively, the command can wait for the given set of resources to be created or deleted by providing the "create" or "delete" keyword as the value to the --for flag.\n\n A successful message will be printed to stdout indicating when the specified condition has been met. You can use -o option to change to output destination.',
    example: "  # Wait for the pod \"busybox1\" to contain the status condition of type \"Ready\"\n  kubectl wait --for=condition=Ready pod/busybox1\n  \n  # The default value of status condition is true; you can wait for other targets after an equal delimiter (compared after Unicode simple case folding, which is a more general form of case-insensitivity)\n  kubectl wait --for=condition=Ready=false pod/busybox1\n  \n  # Wait for the pod \"busybox1\" to contain the status phase to be \"Running\"\n  kubectl wait --for=jsonpath='{.status.phase}'=Running pod/busybox1\n  \n  # Wait for pod \"busybox1\" to be Ready\n  kubectl wait --for='jsonpath={.status.conditions[?(@.type==\"Ready\")].status}=True' pod/busybox1\n  \n  # Wait for the service \"loadbalancer\" to have ingress\n  kubectl wait --for=jsonpath='{.status.loadBalancer.ingress}' service/loadbalancer\n  \n  # Wait for the secret \"busybox1\" to be created, with a timeout of 30 seconds\n  kubectl create secret generic busybox1\n  kubectl wait --for=create secret/busybox1 --timeout=30s\n  \n  # Wait for the pod \"busybox1\" to be deleted, with a timeout of 60s, after having issued the \"delete\" command\n  kubectl delete pod/busybox1\n  kubectl wait --for=delete pod/busybox1 --timeout=60s",
    flags: { ...FILES, ...PRINT, for: F('string', null, "The condition to wait on: [create|delete|condition=condition-name[=condition-value]|jsonpath='{JSONPath expression}'=[JSONPath value]]."), timeout: F('string', null, 'The length of time to wait before giving up.  Zero means check once and don\'t wait, negative means wait for a week.'), selector: F('string', 'l', 'Selector (label query) to filter on'), 'field-selector': F('string', null, 'Selector (field query) to filter on'), all: F('bool', null, 'Select all resources in the namespace of the specified resource types'), 'all-namespaces': F('bool', 'A', 'If present, list the requested object(s) across all namespaces.'), local: F('bool', null, 'If true, annotation will NOT contact api-server but run locally.') },
    async run(c) {
      const cond = c.flags.for;
      if (!cond) c.fail('--for must be specified');
      const timeout = c.flags.timeout !== undefined ? U.parseDuration(c.flags.timeout) * 1000 : 30000;
      let check;
      const q = (s) => s.replace(/^'|'$/g, '');
      if (cond === 'delete') check = (o) => !o;
      else if (cond === 'create') check = (o) => !!o;
      else if (/^condition=/i.test(cond)) {
        const [, rest] = cond.split('=').length ? [null, cond.slice(10)] : [];
        let [type, val] = rest.split('=');
        val = val === undefined ? 'true' : val;
        check = (o) => {
          if (!o) return false;
          const conds = ((o.status || {}).conditions || []);
          const x = conds.find((k) => k.type.toLowerCase() === type.toLowerCase());
          return !!x && String(x.status).toLowerCase() === val.toLowerCase();
        };
      } else if (/^jsonpath=/i.test(cond)) {
        const body = q(cond.slice(9));
        const m = body.match(/^(\{.*\})(?:=(.*))?$/) || body.match(/^([^=]+)(?:=(.*))?$/);
        if (!m) c.fail(`unrecognized condition: "${cond}"`);
        const expr = m[1].replace(/^\{|\}$/g, '');
        const want = m[2] !== undefined ? q(m[2]) : undefined;
        check = (o) => {
          if (!o) return false;
          const v = U.jsonpath.evalPath(expr.startsWith('.') ? expr : '.' + expr, o, o);
          if (!v.length) return false;
          if (want === undefined) return v.some((x) => x !== undefined && x !== null && !(Array.isArray(x) && !x.length));
          return v.some((x) => String(typeof x === 'object' ? JSON.stringify(x) : x) === want);
        };
      } else c.fail(`unrecognized condition: "${cond}"`);
      const ns = c.ns();
      let targets;
      if (cond === 'create') targets = c.resolveArgs(c.pos).map((r) => ({ t: r.t, ns: r.t.namespaced ? ns : '', name: r.name }));
      else targets = c.collect({ verb: 'wait', noNameMsg: 'resource(s) were provided, but no name was specified' });
      if (!targets.length) c.fail('no matching resources found');
      const start = Date.now();
      const pending = new Set(targets);
      for (;;) {
        for (const r of [...pending]) {
          const o = c.cluster.raw(r.t, r.ns, r.name);
          if (check(o ? U.clone(o) : null)) {
            pending.delete(r);
            c.out(c.flags.output === 'name' ? `${r.t.kindRef}/${r.name}\n` : `${r.t.kindRef}/${r.name} condition met\n`);
          } else if (!o && cond !== 'delete' && cond !== 'create' && !pending.notfoundShown) {
            c.err(`Error from server (NotFound): ${r.t.qualified} "${r.name}" not found\n`);
            throw new Exit(1);
          }
        }
        if (!pending.size) return;
        if (Date.now() - start >= timeout) {
          const r = [...pending][0];
          c.fail(`timed out waiting for the condition on ${r.t.plural}/${r.name}`);
        }
        await c.sleep(200);
      }
    },
  });

  // ---------------- DIFF ----------------
  K.def('diff', {
    short: 'Diff the live version against a would-be applied version',
    usage: 'kubectl diff -f FILENAME [flags] [options]',
    long: " Diff configurations specified by file name or stdin between the current online configuration, and the configuration as it would be if applied.\n\n The output is always YAML.\n\n KUBECTL_EXTERNAL_DIFF environment variable can be used to select your own diff command. Users can use external commands with params too, example: KUBECTL_EXTERNAL_DIFF=\"colordiff -N -u\"\n\n By default, the \"diff\" command available in your path will be run with the \"-u\" (unified diff) and \"-N\" (treat absent files as empty) options.\n\n Exit status: 0 No differences were found. 1 Differences were found. >1 Kubectl or diff failed with an error.\n\n Note: KUBECTL_EXTERNAL_DIFF, if used, is expected to follow that convention.",
    example: '  # Diff resources included in pod.json\n  kubectl diff -f pod.json\n  \n  # Diff file read from stdin\n  cat service.yaml | kubectl diff -f -',
    flags: { ...FILES, 'server-side': F('bool', null, 'If true, apply runs in the server instead of the client.'), 'field-manager': F('string', null, 'Name of the manager used to track field ownership.'), 'force-conflicts': F('bool', null, 'If true, server-side apply will force the changes against conflicts.'), prune: F('bool', null, 'Include resources that would be deleted by pruning.'), selector: F('string', 'l', 'Selector (label query) to filter on'), 'show-managed-fields': F('bool', null, 'If true, include managed fields in the diff.'), concurrency: F('int', null, 'Number of objects to process in parallel when diffing against the live version.') },
    async run(c) {
      if (!(c.flags.filename || []).length && !c.flags.kustomize) c.fail('one of -f or -k must be specified');
      let any = false;
      const live = `/tmp/LIVE-${Math.floor(Math.random() * 1e9)}`, merged = `/tmp/MERGED-${Math.floor(Math.random() * 1e9)}`;
      const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, '.000000000 +0000');
      for (const m of c.manifests()) {
        const t = c.mapObj(m.obj, m.source);
        const obj = U.clone(m.obj);
        if (t.namespaced) obj.metadata.namespace = obj.metadata.namespace || c.ns();
        const ex = c.cluster.raw(t, obj.metadata.namespace, obj.metadata.name);
        let after;
        const withAnn = U.clone(obj);
        withAnn.metadata.annotations = { ...(withAnn.metadata.annotations || {}), [K.LAST]: K.lastApplied(obj) };
        if (!ex) after = c.cluster.create(withAnn, c.auth(), { dryRun: true });
        else {
          let prev = null;
          try { prev = JSON.parse((ex.metadata.annotations || {})[K.LAST] || 'null'); } catch (e) { prev = null; }
          const mg = U.threeWay(ex, prev || {}, withAnn);
          mg.metadata.resourceVersion = ex.metadata.resourceVersion;
          after = c.cluster.update(mg, c.auth(), { dryRun: true });
          delete after._changed;
        }
        const strip = (o) => { if (!o) return ''; const x = U.clone(o); delete x.metadata.managedFields; if (x.metadata) delete x.metadata.resourceVersion; return PR.yaml(x); };
        const a = strip(ex), b = strip(after);
        if (a === b) continue;
        any = true;
        const fname = `${t.group ? t.group + '.' : ''}${t.version}.${t.kind}.${obj.metadata.namespace ? obj.metadata.namespace + '.' : ''}${obj.metadata.name}`;
        c.out(`diff -u -N ${live}/${fname} ${merged}/${fname}\n--- ${live}/${fname}\t${stamp}\n+++ ${merged}/${fname}\t${stamp}\n`);
        c.out(U.unifiedDiff(a.replace(/\n$/, ''), b.replace(/\n$/, '')));
      }
      if (any) throw new Exit(1);
    },
  });

  // ---------------- DEBUG ----------------
  K.def('debug', {
    short: 'Create debugging sessions for troubleshooting workloads and nodes',
    usage: 'kubectl debug (POD | TYPE[[.VERSION].GROUP]/NAME) [ -- COMMAND [args...] ] [options]',
    long: ' Debug cluster resources using interactive debugging containers.\n\n \'debug\' provides automation for common debugging tasks for cluster objects identified by resource and name. Pods will be used by default if no resource is specified.\n\n The action taken by \'debug\' varies depending on what resource is specified. Supported actions include:\n\n  *  Workload: Create a copy of an existing pod with certain attributes changed, for example changing the image tag to a new version.\n  *  Workload: Add an ephemeral container to an already running pod, for example to add debugging utilities without restarting the pod.\n  *  Node: Create a new pod that runs in the node\'s host namespaces and can access the node\'s filesystem.',
    example: '  # Create an interactive debugging session in pod mypod and immediately attach to it.\n  kubectl debug mypod -it --image=busybox\n  \n  # Create an interactive debugging session for the pod in the file pod.yaml and immediately attach to it.\n  # (requires the EphemeralContainers feature to be enabled in the cluster)\n  kubectl debug -f pod.yaml -it --image=busybox\n  \n  # Create a debug container named debugger using a custom automated debugging image.\n  kubectl debug --image=myproj/debug-tools -c debugger mypod\n  \n  # Create a copy of mypod adding a debug container and attach to it\n  kubectl debug mypod -it --image=busybox --copy-to=my-debugger\n  \n  # Create a copy of mypod changing the command of mycontainer\n  kubectl debug mypod -it --copy-to=my-debugger --container=mycontainer -- sh\n  \n  # Create a copy of mypod changing all container images to busybox\n  kubectl debug mypod --copy-to=my-debugger --set-image=*=busybox\n  \n  # Create a copy of mypod adding a debug container and changing container images\n  kubectl debug mypod -it --copy-to=my-debugger --image=debian --set-image=app=app:debug,sidecar=sidecar:debug\n  \n  # Create an interactive debugging session on a node and immediately attach to it.\n  # The container will run in the host namespaces and the host\'s filesystem will be mounted at /host\n  kubectl debug node/mynode -it --image=busybox',
    flags: { ...FILES, image: F('string', null, 'Container image to use for debug container.'), container: F('string', 'c', 'Container name to use for debug container.'), stdin: F('bool', 'i', 'Keep stdin open on the container(s) in the pod, even if nothing is attached.'), tty: F('bool', 't', 'Allocate a TTY for the debugging container.'), target: F('string', null, 'When using an ephemeral container, target processes in this container name.'), 'copy-to': F('string', null, 'Create a copy of the target Pod with this name.'), 'set-image': F('strings', null, 'When used with \'--copy-to\', a list of name=image pairs for changing container images'), 'share-processes': F('bool', null, 'When used with \'--copy-to\', enable process namespace sharing in the copy.'), replace: F('bool', null, 'When used with \'--copy-to\', delete the original Pod.'), 'same-node': F('bool', null, 'When used with \'--copy-to\', schedule the copy of target Pod on the same node.'), profile: F('string', null, 'Options are "legacy", "general", "baseline", "netadmin", "restricted" or "sysadmin".'), quiet: F('bool', 'q', 'If true, suppress informational messages.'), attach: F('bool', null, 'If true, wait for the container to start running, and then attach as if \'kubectl attach ...\' were called.'), 'image-pull-policy': F('string', null, "The image pull policy for the container."), env: F('stringArray', null, 'Environment variables to set in the container.'), arguments: F('bool', null, 'deprecated') },
    async run(c) {
      if (!c.pos.length) c.usageFail('NAME is required for debug');
      const ns = c.ns();
      const target = c.pos[0];
      const pT0 = pT();
      const waitRun = async (ns2, name, cn, eph) => {
        const start = Date.now();
        for (;;) {
          const p = c.cluster.raw(pT0, ns2, name);
          const st = p && [...(p.status.containerStatuses || []), ...(p.status.ephemeralContainerStatuses || [])].find((x) => x.name === cn);
          if (st && st.state.running) return p;
          if (st && st.state.terminated) return p;
          if (Date.now() - start > 60000) c.fail('timed out waiting for the condition');
          await c.sleep(200);
          void eph;
        }
      };
      if (target.startsWith('node/') || target.startsWith('nodes/')) {
        if (!c.flags.image) c.fail('--image is required for node debugging');
        const node = c.get(S.byId('nodes'), '', target.split('/')[1]);
        const pname = `node-debugger-${node.metadata.name}-${U.rand(5)}`;
        c.err(`Creating debugging pod ${pname} with container debugger on node ${node.metadata.name}.\n`);
        c.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: pname, namespace: ns }, spec: { nodeName: node.metadata.name, hostIPC: true, hostNetwork: true, hostPID: true, restartPolicy: 'Never', tolerations: [{ operator: 'Exists' }], volumes: [{ name: 'host-root', hostPath: { path: '/' } }], containers: [{ name: 'debugger', image: c.flags.image, stdin: !!c.flags.stdin, tty: !!c.flags.tty, ...(c.dash ? { command: c.dash } : {}), volumeMounts: [{ mountPath: '/host', name: 'host-root' }] }] } }, {});
        if (c.flags.stdin && c.flags.tty) {
          const p = await waitRun(ns, pname, 'debugger');
          if (!c.flags.quiet) c.err("If you don't see a command prompt, try pressing enter.\n");
          await c.env.interactive({ pod: p, container: 'debugger', argv: c.dash || null, attach: true });
        }
        return;
      }
      const pod = K.podFor(c, target, ns);
      if (c.flags['copy-to']) {
        const copy = { apiVersion: 'v1', kind: 'Pod', metadata: { name: c.flags['copy-to'], namespace: ns, labels: {} }, spec: U.clone(pod.spec) };
        delete copy.spec.nodeName;
        delete copy.spec.ephemeralContainers;
        copy.spec.volumes = (copy.spec.volumes || []).filter((v) => !v.name.startsWith('kube-api-access-'));
        for (const ct of [...copy.spec.containers, ...(copy.spec.initContainers || [])]) ct.volumeMounts = (ct.volumeMounts || []).filter((m) => !m.name.startsWith('kube-api-access-'));
        if (c.flags['same-node']) copy.spec.nodeName = pod.spec.nodeName;
        if (c.flags['share-processes'] !== false) copy.spec.shareProcessNamespace = true;
        for (const kv of c.flags['set-image'] || []) { const [n, img] = kv.split('='); for (const ct of copy.spec.containers) if (n === '*' || ct.name === n) ct.image = img; }
        let cn = c.flags.container;
        const existing = cn && copy.spec.containers.find((x) => x.name === cn);
        if (existing) { if (c.dash) { existing.command = c.dash; delete existing.args; } if (c.flags.image) existing.image = c.flags.image; existing.stdin = !!c.flags.stdin; existing.tty = !!c.flags.tty; }
        else if (c.flags.image) {
          cn = cn || `debugger-${U.rand(5)}`;
          if (!c.flags.container && !c.flags.quiet) c.err(`Defaulting debug container name to ${cn}.\n`);
          copy.spec.containers.push({ name: cn, image: c.flags.image, stdin: !!c.flags.stdin, tty: !!c.flags.tty, ...(c.dash ? { command: c.dash } : {}), terminationMessagePolicy: 'File' });
        }
        c.create(copy, {});
        if (c.flags.replace) c.del(pT0, ns, pod.metadata.name, {});
        if (c.flags.stdin && c.flags.tty && cn) {
          const p = await waitRun(ns, copy.metadata.name, cn);
          if (!c.flags.quiet) c.err("If you don't see a command prompt, try pressing enter.\n");
          await c.env.interactive({ pod: p, container: cn, argv: c.dash || null, attach: true });
        }
        return;
      }
      if (!c.flags.image) c.fail('--image is required when --copy-to is not specified');
      const cn = c.flags.container || `debugger-${U.rand(5)}`;
      if (!c.flags.container && !c.flags.quiet) c.err(`Defaulting debug container name to ${cn}.\n`);
      if (c.flags.target && !pod.spec.containers.some((x) => x.name === c.flags.target)) c.fail(`container "${c.flags.target}" not found in pod`);
      const raw = c.cluster.raw(pT0, ns, pod.metadata.name);
      raw.spec.ephemeralContainers = [...(raw.spec.ephemeralContainers || []), { name: cn, image: c.flags.image, imagePullPolicy: c.flags['image-pull-policy'] || 'IfNotPresent', resources: {}, stdin: !!c.flags.stdin, tty: !!c.flags.tty, terminationMessagePath: '/dev/termination-log', terminationMessagePolicy: 'File', ...(c.flags.target ? { targetContainerName: c.flags.target } : {}), ...(c.dash ? { command: c.dash } : {}) }];
      c.cluster.put(pT0, raw);
      if (c.flags.stdin && c.flags.tty) {
        const p = await waitRun(ns, pod.metadata.name, cn, true);
        if (!c.flags.quiet) c.err("If you don't see a command prompt, try pressing enter.\n");
        await c.env.interactive({ pod: p, container: cn, argv: c.dash || null, attach: true });
      }
    },
  });

  // ---------------- EVENTS ----------------
  K.def('events', {
    short: 'List events',
    usage: 'kubectl events [(-o|--output=)json|yaml|name|go-template|go-template-file|template|templatefile|jsonpath|jsonpath-as-json|jsonpath-file] [--for TYPE/NAME] [--watch] [--types=Normal,Warning] [flags] [options]',
    long: ' Display events.\n\n Prints a table of the most important information about events. You can request events for a namespace, for all namespace, or filtered to only those pertaining to a specified resource.',
    example: '  # List recent events in the default namespace\n  kubectl events\n  \n  # List recent events in all namespaces\n  kubectl events --all-namespaces\n  \n  # List recent events for the specified pod, then wait for more events and list them as they arrive\n  kubectl events --for pod/web-pod-13je7 --watch\n  \n  # List recent events in YAML format\n  kubectl events -oyaml\n  \n  # List recent only events of type \'Warning\' or \'Normal\'\n  kubectl events --types=Warning,Normal',
    flags: { ...PRINT, 'all-namespaces': F('bool', 'A', 'If present, list the requested object(s) across all namespaces.'), for: F('string', null, 'Filter events to only those pertaining to the specified resource.'), types: F('strings', null, 'Output only events of given types.'), watch: F('bool', 'w', 'After listing the requested events, watch for more events.'), 'no-headers': F('bool', null, "When using the default output format, don't print headers."), 'chunk-size': F('int', null, 'Return large lists in chunks rather than all at once.') },
    async run(c) {
      const ns = c.ns();
      const allNs = c.flags['all-namespaces'];
      const evT = S.byId('events');
      let filt = () => true;
      if (c.flags.for) {
        const [tn, name] = c.flags.for.includes('/') ? c.flags.for.split('/') : ['pod', c.flags.for];
        const t = c.type(tn);
        filt = (e) => e.involvedObject.kind === t.kind && e.involvedObject.name === name;
      }
      const types = (c.flags.types || []).map((x) => x.toLowerCase());
      for (const ty of types) if (!['normal', 'warning'].includes(ty)) c.fail(`valid --types are Normal or Warning`);
      const pass = (e) => filt(e) && (!types.length || types.includes(e.type.toLowerCase()));
      const evs = c.list(evT, allNs ? null : ns, {}).filter(pass).sort((a, b) => U.ms(a.lastTimestamp || a.eventTime) - U.ms(b.lastTimestamp || b.eventTime));
      const row = (e) => [...(allNs ? [e.metadata.namespace] : []), e.count > 1 ? `${U.age(e.lastTimestamp)} (x${e.count} over ${U.age(e.firstTimestamp)})` : U.age(e.lastTimestamp), e.type, e.reason, `${e.involvedObject.kind}/${e.involvedObject.name}`, e.message.replace(/\n/g, ' ')];
      const head = [...(allNs ? ['NAMESPACE'] : []), 'LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'];
      if (c.flags.output) c.printObjects(evs.map((o) => ({ t: evT, o })), {});
      else if (!evs.length && !c.flags.watch) { c.err(allNs ? 'No events found.\n' : `No events found in ${ns} namespace.\n`); return; }
      else if (evs.length) c.out(U.table([...(c.flags['no-headers'] ? [] : [head]), ...evs.map(row)]) + '\n');
      if (!c.flags.watch) return;
      const q = [];
      const unsub = c.cluster.watch((type, t, o) => { if (t === evT && type !== 'DELETED' && (allNs || o.metadata.namespace === ns) && pass(o)) q.push(U.clone(o)); });
      try {
        while (!c.aborted) {
          while (q.length) c.out(U.table([row(q.shift())]) + '\n');
          await c.sleep(200);
        }
      } finally { unsub(); }
    },
  });

  // ---------------- KUSTOMIZE ----------------
  K.kustomizeBuild = (c, dir) => {
    dir = dir.replace(/\/$/, '');
    const kfile = ['kustomization.yaml', 'kustomization.yml', 'Kustomization'].map((f) => dir + '/' + f).find((p) => c.env.fs.read(p) !== null);
    if (!kfile) c.fail(`unable to find one of 'kustomization.yaml', 'kustomization.yml' or 'Kustomization' in directory '${dir}'`);
    let k;
    try { k = globalThis.jsyaml.load(c.env.fs.read(kfile)) || {}; } catch (e) { c.fail(`invalid Kustomization: ${e.message}`); }
    let docs = [];
    for (const r of k.resources || k.bases || []) {
      const p = r.startsWith('/') ? r : dir + '/' + r;
      if (c.env.fs.isDir(p)) docs.push(...K.kustomizeBuild(c, p));
      else {
        const txt = c.env.fs.read(p);
        if (txt === null) c.fail(`accumulating resources: accumulation err='accumulating resources from '${r}': open ${p}: no such file or directory'`);
        docs.push(...PR.parseYAMLDocs(txt));
      }
    }
    const hashOff = k.generatorOptions && k.generatorOptions.disableNameSuffixHash;
    const renames = {};
    const gen = (list, kind) => {
      for (const g of list || []) {
        const data = {};
        for (const l of g.literals || []) { const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); }
        for (const f of g.files || []) {
          const [key, path] = f.includes('=') ? f.split('=') : [f.split('/').pop(), f];
          const txt = c.env.fs.read(dir + '/' + path);
          if (txt === null) c.fail(`evalsymlink failure on '${dir}/${path}' : lstat ${dir}/${path}: no such file or directory`);
          data[key] = txt;
        }
        for (const f of g.envs || (g.env ? [g.env] : [])) {
          for (const line of (c.env.fs.read(dir + '/' + f) || '').split('\n')) { const l = line.trim(); if (!l || l.startsWith('#')) continue; const i = l.indexOf('='); data[l.slice(0, i)] = l.slice(i + 1); }
        }
        const obj = { apiVersion: 'v1', kind, metadata: { name: g.name, ...(g.namespace ? { namespace: g.namespace } : {}) } };
        if (kind === 'Secret') { obj.type = g.type || 'Opaque'; obj.data = Object.fromEntries(Object.entries(data).map(([a, b]) => [a, U.b64e(b)])); }
        else obj.data = data;
        const opts = { ...(k.generatorOptions || {}), ...(g.options || {}) };
        if (opts.labels) obj.metadata.labels = opts.labels;
        if (!hashOff && !opts.disableNameSuffixHash) {
          const nn = `${g.name}-${U.safeHash(JSON.stringify(PR.sortKeys(obj))).slice(0, 10)}`;
          renames[`${kind}/${g.name}`] = nn;
          obj.metadata.name = nn;
        }
        docs.push(obj);
      }
    };
    gen(k.configMapGenerator, 'ConfigMap');
    gen(k.secretGenerator, 'Secret');
    // patches
    const patches = [...(k.patchesStrategicMerge || []).map((p) => ({ path: p })), ...(k.patches || [])];
    for (const p of patches) {
      let body = p.patch || (p.path ? c.env.fs.read(dir + '/' + p.path) : null);
      if (body === null) c.fail(`trouble configuring builtin PatchTransformer: open ${dir}/${p.path}: no such file or directory`);
      const parsed = typeof body === 'string' ? globalThis.jsyaml.load(body) : body;
      const target = p.target || (U.isObj(parsed) ? { kind: parsed.kind, name: parsed.metadata && parsed.metadata.name } : {});
      docs = docs.map((d) => {
        if ((target.kind && d.kind !== target.kind) || (target.name && d.metadata.name !== target.name) || (target.labelSelector && !U.matchLabelString(target.labelSelector, d.metadata.labels))) return d;
        return Array.isArray(parsed) ? U.jsonPatch(d, parsed) : U.strategicMerge(d, parsed);
      });
    }
    for (const d of docs) {
      d.metadata = d.metadata || {};
      if (k.namespace && S.byKind(d.apiVersion, d.kind) && S.byKind(d.apiVersion, d.kind).namespaced) d.metadata.namespace = k.namespace;
      if (!renames[`${d.kind}/${d.metadata.name}`] && !(d.kind === 'ConfigMap' || d.kind === 'Secret') || !renames[`${d.kind}/${(d.metadata.name || '').replace(/-[a-z0-9]{10}$/, '')}`]) {
        if (k.namePrefix || k.nameSuffix) d.metadata.name = `${k.namePrefix || ''}${d.metadata.name}${k.nameSuffix || ''}`;
      }
      const lbl = { ...(k.commonLabels || {}) };
      for (const l of k.labels || []) Object.assign(lbl, l.pairs || {});
      if (Object.keys(lbl).length) {
        d.metadata.labels = { ...(d.metadata.labels || {}), ...lbl };
        const sel = { ...(k.commonLabels || {}) };
        for (const l of k.labels || []) if (l.includeSelectors) Object.assign(sel, l.pairs || {});
        if (d.spec && d.spec.selector && Object.keys(sel).length) {
          if (d.kind === 'Service') d.spec.selector = { ...d.spec.selector, ...sel };
          else if (d.spec.selector.matchLabels) d.spec.selector.matchLabels = { ...d.spec.selector.matchLabels, ...sel };
        }
        if (d.spec && d.spec.template && d.spec.template.metadata) d.spec.template.metadata.labels = { ...(d.spec.template.metadata.labels || {}), ...(Object.keys(sel).length ? sel : {}), ...((k.labels || []).filter((l) => l.includeTemplates).reduce((a, l) => ({ ...a, ...l.pairs }), {})) };
      }
      if (k.commonAnnotations) {
        d.metadata.annotations = { ...(d.metadata.annotations || {}), ...k.commonAnnotations };
        if (d.spec && d.spec.template && d.spec.template.metadata) d.spec.template.metadata.annotations = { ...(d.spec.template.metadata.annotations || {}), ...k.commonAnnotations };
      }
      const cs = K.containersOf(d);
      if (cs) {
        for (const ct of [...(cs.spec.containers || []), ...(cs.spec.initContainers || [])]) {
          for (const im of k.images || []) {
            const base = ct.image.split('@')[0].replace(/:[^/:]+$/, '');
            if (base !== im.name) continue;
            ct.image = `${im.newName || base}${im.digest ? '@' + im.digest : ':' + (im.newTag || (ct.image.match(/:([^/:]+)$/) || [])[1] || 'latest')}`;
          }
          for (const ef of ct.envFrom || []) { if (ef.configMapRef && renames['ConfigMap/' + ef.configMapRef.name]) ef.configMapRef.name = renames['ConfigMap/' + ef.configMapRef.name]; if (ef.secretRef && renames['Secret/' + ef.secretRef.name]) ef.secretRef.name = renames['Secret/' + ef.secretRef.name]; }
          for (const e of ct.env || []) { const v = e.valueFrom || {}; if (v.configMapKeyRef && renames['ConfigMap/' + v.configMapKeyRef.name]) v.configMapKeyRef.name = renames['ConfigMap/' + v.configMapKeyRef.name]; if (v.secretKeyRef && renames['Secret/' + v.secretKeyRef.name]) v.secretKeyRef.name = renames['Secret/' + v.secretKeyRef.name]; }
        }
        for (const v of cs.spec.volumes || []) { if (v.configMap && renames['ConfigMap/' + v.configMap.name]) v.configMap.name = renames['ConfigMap/' + v.configMap.name]; if (v.secret && renames['Secret/' + v.secret.secretName]) v.secret.secretName = renames['Secret/' + v.secret.secretName]; }
      }
      for (const r of k.replicas || []) if (d.metadata.name === `${k.namePrefix || ''}${r.name}${k.nameSuffix || ''}` && d.spec && 'replicas' in (d.spec || {}) || d.metadata.name === r.name) { if (d.spec) d.spec.replicas = r.count; }
    }
    return docs;
  };
  K.def('kustomize', {
    short: 'Build a kustomization target from a directory or URL',
    usage: 'kubectl kustomize DIR [flags] [options]',
    long: " Build a set of KRM resources using a 'kustomization.yaml' file. The DIR argument must be a path to a directory containing 'kustomization.yaml', or a git repository URL with a path suffix specifying same with respect to the repository root. If DIR is omitted, '.' is assumed.",
    example: '  # Build the current working directory\n  kubectl kustomize\n  \n  # Build some shared configuration directory\n  kubectl kustomize /home/config/production\n  \n  # Build from github\n  kubectl kustomize https://github.com/kubernetes-sigs/kustomize.git/examples/helloWorld?ref=v1.0.6',
    flags: { output: F('string', 'o', 'If specified, write output to this path.'), 'enable-helm': F('bool', null, 'Enable use of the Helm chart inflator generator.'), 'load-restrictor': F('string', null, 'if set to \'LoadRestrictionsNone\', local kustomizations may load files from outside their root.'), 'enable-alpha-plugins': F('bool', null, 'enable kustomize plugins') },
    async run(c) {
      const docs = K.kustomizeBuild(c, c.pos[0] || c.env.fs.cwd());
      const txt = docs.map((d) => PR.yaml(d)).join('---\n');
      if (c.flags.output) c.env.fs.write(c.flags.output, txt);
      else c.out(txt);
    },
  });

  // ---------------- COMPLETION / PLUGIN / OPTIONS ----------------
  K.def('completion', {
    short: 'Output shell completion code for the specified shell (bash, zsh, fish, or powershell)',
    usage: 'kubectl completion SHELL [options]',
    long: ' Output shell completion code for the specified shell (bash, zsh, fish, or powershell). The shell code must be evaluated to provide interactive completion of kubectl commands.  This can be done by sourcing it from the .bash_profile.',
    flags: {},
    async run(c) {
      const sh = c.pos[0];
      if (!sh) c.fail('Shell not specified.');
      if (!['bash', 'zsh', 'fish', 'powershell'].includes(sh)) c.fail(`Unsupported shell type "${sh}".`);
      c.out(`# ${sh} completion for kubectl                                 -*- shell-script -*-\n\n__kubectl_debug()\n{\n    if [[ -n \${BASH_COMP_DEBUG_FILE-} ]]; then\n        echo "$*" >> "\${BASH_COMP_DEBUG_FILE}"\n    fi\n}\n\n# (Neste simulador o autocompletar já funciona com a tecla Tab.)\n`);
    },
  });
  K.def('plugin', {
    short: 'Provides utilities for interacting with plugins',
    usage: 'kubectl plugin [flags] [options]',
    long: ' Provides utilities for interacting with plugins.\n\n Plugins provide extended functionality that is not part of the major command-line distribution. Please refer to the documentation and examples for more information about how write your own plugins.\n\n The easiest way to discover and install plugins is via the kubernetes sub-project krew: [krew.sigs.k8s.io]. To install krew, visit https://krew.sigs.k8s.io/docs/user-guide/setup/install',
    sub: { list: { short: 'List all visible plugin executables on a user\'s PATH', usage: 'kubectl plugin list [flags] [options]', flags: { 'name-only': F('bool', null, 'If true, display only the binary name of each plugin, rather than its full path') }, async run(c) { c.fail('unable to find any kubectl plugins in your PATH'); } } },
    async run(c) { K.printHelp(c, 'kubectl plugin', CMD.plugin); },
  });
  K.def('options', {
    short: 'Print the list of flags inherited by all commands',
    usage: 'kubectl options [flags] [options]',
    async run(c) {
      const rows = Object.entries(K.GLOBAL).filter(([n]) => n !== 'help').sort().map(([n, f]) => `    ${f.s ? '-' + f.s + ', ' : ''}--${n}=${f.t === 'bool' ? 'false' : f.t === 'int' ? '0' : f.t === 'strings' ? '[]' : "''"}:\n${K.wrap(f.d || '', 70, '\t')}`);
      c.out(`The following options can be passed to any command:\n\n${rows.join('\n\n')}\n`);
    },
  });
  K.def('alpha', { short: 'Commands for features in alpha', usage: 'kubectl alpha [flags] [options]', long: ' These commands correspond to alpha features that are not enabled in Kubernetes clusters by default.', sub: {}, async run(c) { K.printHelp(c, 'kubectl alpha', CMD.alpha); } });
})();
