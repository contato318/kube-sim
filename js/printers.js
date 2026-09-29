// Impressão no formato do kubectl: tabelas (get), describe, yaml e json.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, S = KS.schema;
  const P = (KS.printers = {});
  const age = (ts) => U.age(ts);
  const none = (v) => (v === undefined || v === null || v === '' ? '<none>' : v);

  // ---------------- YAML (estilo sigs.k8s.io/yaml) ----------------
  const RESOLVES = /^(~|null|Null|NULL|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF|[-+]?(\.inf|\.Inf|\.INF)|\.nan|\.NaN|\.NAN|[-+]?[0-9][0-9_]*(\.[0-9_]*)?([eE][-+]?[0-9]+)?|[-+]?\.[0-9_]+([eE][-+]?[0-9]+)?|0x[0-9a-fA-F_]+|0o?[0-7_]+|0b[01_]+|[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+(\.[0-9_]*)?|\d{4}-\d\d?-\d\d?([Tt ]\d\d?:\d\d:\d\d(\.\d*)?\s*(Z|[-+]\d\d?(:\d\d)?)?)?|<<|=)$/;
  const plainOk = (s) => {
    if (s === '') return false;
    if (/^[\s]|[\s]$/.test(s)) return false;
    if (/^[?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
    if (s[0] === '-' && (s.length === 1 || s[1] === ' ' || s.startsWith('---'))) return false;
    if (/: |:$| #|\t/.test(s)) return false;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return false;
    return true;
  };
  const dq = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) + '"';
  const scalar = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? '+Inf' : v < 0 ? '-Inf' : 'NaN';
    const s = String(v);
    if (RESOLVES.test(s)) return dq(s);
    if (plainOk(s)) return s;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return dq(s);
    return "'" + s.replace(/'/g, "''") + "'";
  };
  const keyStr = (k) => {
    const s = scalar(k);
    return s;
  };
  function yamlLines(v, indent, out, inList) {
    const pad = ' '.repeat(indent);
    if (Array.isArray(v)) {
      for (const it of v) {
        if (U.isObj(it) && Object.keys(it).length) {
          const sub = [];
          yamlLines(it, indent + 2, sub, true);
          sub[0] = pad + '- ' + sub[0].slice(indent + 2);
          out.push(...sub);
        } else if (Array.isArray(it) && it.length) {
          const sub = [];
          yamlLines(it, indent + 2, sub, true);
          sub[0] = pad + '- ' + sub[0].slice(indent + 2);
          out.push(...sub);
        } else out.push(pad + '- ' + inlineVal(it, indent + 2));
      }
      return;
    }
    const keys = Object.keys(v).sort();
    for (const k of keys) {
      const val = v[k];
      if (val === undefined) continue;
      if (U.isObj(val) && Object.keys(val).length) {
        out.push(pad + keyStr(k) + ':');
        yamlLines(val, indent + 2, out);
      } else if (Array.isArray(val) && val.length) {
        out.push(pad + keyStr(k) + ':');
        yamlLines(val, indent, out, true);
      } else out.push(pad + keyStr(k) + ': ' + inlineVal(val, indent + 2));
    }
  }
  function inlineVal(v, indent) {
    if (U.isObj(v)) return '{}';
    if (Array.isArray(v)) return '[]';
    if (typeof v === 'string' && v.includes('\n') && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v) && !/[ \t]\n/.test(v) && !/^\s/.test(v)) {
      const trailing = v.match(/\n*$/)[0].length;
      const ind = ' '.repeat(indent);
      const body = v.replace(/\n+$/, '');
      const hdr = trailing === 0 ? '|-' : trailing === 1 ? '|' : '|+';
      const lines = body.split('\n').map((l) => (l ? ind + l : ''));
      if (trailing > 1) for (let i = 1; i < trailing; i++) lines.push('');
      return hdr + '\n' + lines.join('\n');
    }
    return scalar(v);
  }
  P.yaml = (obj) => {
    if (obj === null || typeof obj !== 'object') return scalar(obj) + '\n';
    if (Array.isArray(obj) && !obj.length) return '[]\n';
    if (U.isObj(obj) && !Object.keys(obj).length) return '{}\n';
    const out = [];
    yamlLines(obj, 0, out, Array.isArray(obj));
    return out.join('\n') + '\n';
  };
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (U.isObj(v)) {
      const o = {};
      for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = sortKeys(v[k]);
      return o;
    }
    return v;
  };
  P.json = (obj) => JSON.stringify(sortKeys(obj), null, 4) + '\n';
  P.sortKeys = sortKeys;
  P.parseYAMLDocs = (text) => {
    const Y = globalThis.jsyaml;
    if (!Y) throw new Error('YAML parser not loaded');
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const j = JSON.parse(t);
        return Array.isArray(j) ? j : [j];
      } catch (e) { /* cai para YAML */ }
    }
    return Y.loadAll(text, null, { schema: Y.CORE_SCHEMA || Y.DEFAULT_SCHEMA }).filter((d) => d !== null && d !== undefined);
  };

  // ---------------- STATUS de pod (printPod do kubectl) ----------------
  P.podStatus = (p) => {
    let reason = p.status.reason || p.status.phase || 'Pending';
    let initializing = false;
    const inits = p.status.initContainerStatuses || [];
    const initSpecs = p.spec.initContainers || [];
    for (let i = 0; i < inits.length; i++) {
      const c = inits[i];
      const st = c.state || {};
      const isSidecar = (initSpecs[i] || {}).restartPolicy === 'Always';
      if (st.terminated && st.terminated.exitCode === 0) continue;
      if (isSidecar && st.running && c.started) continue;
      if (st.terminated) {
        reason = st.terminated.reason ? 'Init:' + st.terminated.reason : st.terminated.signal ? `Init:Signal:${st.terminated.signal}` : `Init:ExitCode:${st.terminated.exitCode}`;
      } else if (st.waiting && st.waiting.reason && st.waiting.reason !== 'PodInitializing') reason = 'Init:' + st.waiting.reason;
      else reason = `Init:${i}/${initSpecs.length}`;
      initializing = true;
      break;
    }
    let restarts = 0, ready = 0, lastRestart = 0;
    const all = (p.status.containerStatuses || []);
    for (const c of inits) {
      restarts += c.restartCount;
      if (c.lastState && c.lastState.terminated) lastRestart = Math.max(lastRestart, U.ms(c.lastState.terminated.finishedAt));
    }
    if (!initializing) {
      restarts = 0;
      let hasRunning = false;
      for (let i = all.length - 1; i >= 0; i--) {
        const c = all[i];
        const st = c.state || {};
        restarts += c.restartCount;
        if (c.lastState && c.lastState.terminated) lastRestart = Math.max(lastRestart, U.ms(c.lastState.terminated.finishedAt));
        if (st.waiting && st.waiting.reason) reason = st.waiting.reason;
        else if (st.terminated && st.terminated.reason) reason = st.terminated.reason;
        else if (st.terminated && !st.terminated.reason) reason = st.terminated.signal ? `Signal:${st.terminated.signal}` : `ExitCode:${st.terminated.exitCode}`;
        else if (c.ready && st.running) { hasRunning = true; ready++; }
      }
      if (reason === 'Completed' && hasRunning) {
        const rc = (p.status.conditions || []).find((c) => c.type === 'Ready');
        reason = rc && rc.status === 'True' ? 'Running' : 'NotReady';
      }
    } else {
      for (const c of all) if (c.ready && (c.state || {}).running) ready++;
    }
    if (p.metadata.deletionTimestamp) reason = p.status.reason === 'NodeLost' ? 'Unknown' : 'Terminating';
    const rs = lastRestart ? `${restarts} (${U.age(new Date(lastRestart).toISOString())} ago)` : String(restarts);
    return { status: reason, ready: `${ready}/${p.spec.containers.length}`, restarts: rs };
  };

  // ---------------- colunas por tipo ----------------
  const containersImages = (tpl) => {
    const cs = ((tpl && tpl.spec) || {}).containers || [];
    return [cs.map((c) => c.name).join(','), cs.map((c) => c.image).join(',')];
  };
  const svcPorts = (s) => {
    const ps = s.spec.ports || [];
    if (!ps.length) return '<none>';
    return ps.map((p) => `${p.port}${p.nodePort ? ':' + p.nodePort : ''}/${p.protocol || 'TCP'}`).join(',');
  };
  const svcExternal = (s) => {
    const t = s.spec.type;
    if (t === 'ExternalName') return s.spec.externalName;
    const ext = s.spec.externalIPs || [];
    if (t === 'LoadBalancer') {
      const ing = ((s.status.loadBalancer || {}).ingress || []).map((i) => i.ip || i.hostname);
      const all = [...ing, ...ext];
      return all.length ? all.join(',') : '<pending>';
    }
    return ext.length ? ext.join(',') : '<none>';
  };
  const nodeRoles = (n) => {
    const roles = Object.keys(n.metadata.labels || {}).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1]).filter(Boolean);
    if ((n.metadata.labels || {})['kubernetes.io/role']) roles.push(n.metadata.labels['kubernetes.io/role']);
    return roles.length ? roles.sort().join(',') : '<none>';
  };
  const nodeStatus = (n) => {
    const ready = (n.status.conditions || []).find((c) => c.type === 'Ready');
    let s = !ready ? 'Unknown' : ready.status === 'True' ? 'Ready' : ready.status === 'False' ? 'NotReady' : 'Unknown';
    if (n.spec.unschedulable) s += ',SchedulingDisabled';
    return s;
  };
  const jobDuration = (j) => {
    if (!j.status.startTime) return '';
    const end = j.status.completionTime ? U.ms(j.status.completionTime) : Date.now();
    return U.human((end - U.ms(j.status.startTime)) / 1000);
  };
  const jobStatus = (j) => {
    const c = j.status.conditions || [];
    const has = (t) => c.some((x) => x.type === t && x.status === 'True');
    if (has('Complete')) return 'Complete';
    if (has('Failed')) return 'Failed';
    if (j.metadata.deletionTimestamp) return 'Terminating';
    if (has('SuccessCriteriaMet')) return 'SuccessCriteriaMet';
    if (has('FailureTarget')) return 'FailureTarget';
    if (has('Suspended')) return 'Suspended';
    return 'Running';
  };
  const hpaTargets = (h) => {
    const cur = h.status.currentMetrics || [];
    return (h.spec.metrics || []).map((m, i) => {
      const r = m.resource || m.containerResource;
      if (!r) return `<unknown>/<unknown>`;
      const c = (cur[i] || {}).resource || {};
      const cc = c.current || {};
      if (r.target.type === 'Utilization') return `${r.name}: ${cc.averageUtilization !== undefined ? cc.averageUtilization + '%' : '<unknown>'}/${r.target.averageUtilization}%`;
      return `${r.name}: ${cc.averageValue !== undefined ? cc.averageValue : '<unknown>'}/${r.target.averageValue}`;
    }).join(', ') || '<none>';
  };
  const epString = (ep) => {
    const out = [];
    for (const s of ep.subsets || []) for (const a of s.addresses || []) for (const p of s.ports || [{}]) out.push(`${a.ip}${p.port ? ':' + p.port : ''}`);
    if (!out.length) return '<none>';
    return out.length > 3 ? out.slice(0, 3).join(',') + ` + ${out.length - 3} more...` : out.join(',');
  };
  const subjectsOf = (b, kind) => (b.subjects || []).filter((s) => s.kind === kind).map((s) => (kind === 'ServiceAccount' ? `${s.namespace || b.metadata.namespace}/${s.name}` : s.name)).join(', ');
  const COLS = {
    pods: {
      h: ['NAME', 'READY', 'STATUS', 'RESTARTS', 'AGE'],
      f: (p) => { const s = P.podStatus(p); return [p.metadata.name, s.ready, s.status, s.restarts, age(p.metadata.creationTimestamp)]; },
      wh: ['IP', 'NODE', 'NOMINATED NODE', 'READINESS GATES'],
      wf: (p) => [p.status.podIP || '<none>', p.spec.nodeName || '<none>', p.status.nominatedNodeName || '<none>', (p.spec.readinessGates || []).length ? `${(p.spec.readinessGates || []).filter((g) => (p.status.conditions || []).some((c) => c.type === g.conditionType && c.status === 'True')).length}/${p.spec.readinessGates.length}` : '<none>'],
    },
    'deployments.apps': {
      h: ['NAME', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'AGE'],
      f: (d) => [d.metadata.name, `${d.status.readyReplicas || 0}/${d.spec.replicas}`, String(d.status.updatedReplicas || 0), String(d.status.availableReplicas || 0), age(d.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES', 'SELECTOR'],
      wf: (d) => [...containersImages(d.spec.template), U.selectorString(d.spec.selector)],
    },
    'replicasets.apps': {
      h: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
      f: (r) => [r.metadata.name, String(r.spec.replicas), String(r.status.replicas || 0), String(r.status.readyReplicas || 0), age(r.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES', 'SELECTOR'],
      wf: (r) => [...containersImages(r.spec.template), U.selectorString(r.spec.selector)],
    },
    replicationcontrollers: {
      h: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'AGE'],
      f: (r) => [r.metadata.name, String(r.spec.replicas), String(r.status.replicas || 0), String(r.status.readyReplicas || 0), age(r.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES', 'SELECTOR'],
      wf: (r) => [...containersImages(r.spec.template), U.mapSelectorString(r.spec.selector)],
    },
    'statefulsets.apps': {
      h: ['NAME', 'READY', 'AGE'],
      f: (s) => [s.metadata.name, `${s.status.readyReplicas || 0}/${s.spec.replicas}`, age(s.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES'],
      wf: (s) => containersImages(s.spec.template),
    },
    'daemonsets.apps': {
      h: ['NAME', 'DESIRED', 'CURRENT', 'READY', 'UP-TO-DATE', 'AVAILABLE', 'NODE SELECTOR', 'AGE'],
      f: (d) => [d.metadata.name, String(d.status.desiredNumberScheduled || 0), String(d.status.currentNumberScheduled || 0), String(d.status.numberReady || 0), String(d.status.updatedNumberScheduled || 0), String(d.status.numberAvailable || 0), U.mapSelectorString(d.spec.template.spec.nodeSelector), age(d.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES', 'SELECTOR'],
      wf: (d) => [...containersImages(d.spec.template), U.selectorString(d.spec.selector)],
    },
    'jobs.batch': {
      h: ['NAME', 'STATUS', 'COMPLETIONS', 'DURATION', 'AGE'],
      f: (j) => [j.metadata.name, jobStatus(j), `${j.status.succeeded || 0}/${j.spec.completions ?? 1}${j.spec.completions === undefined && (j.spec.parallelism || 1) > 1 ? ' of ' + j.spec.parallelism : ''}`, jobDuration(j), age(j.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES', 'SELECTOR'],
      wf: (j) => [...containersImages(j.spec.template), U.selectorString(j.spec.selector)],
    },
    'cronjobs.batch': {
      h: ['NAME', 'SCHEDULE', 'TIMEZONE', 'SUSPEND', 'ACTIVE', 'LAST SCHEDULE', 'AGE'],
      f: (c) => [c.metadata.name, c.spec.schedule, c.spec.timeZone || '<none>', String(!!c.spec.suspend), String((c.status.active || []).length), c.status.lastScheduleTime ? age(c.status.lastScheduleTime) : '<none>', age(c.metadata.creationTimestamp)],
      wh: ['CONTAINERS', 'IMAGES', 'SELECTOR'],
      wf: (c) => [...containersImages(c.spec.jobTemplate.spec.template), U.selectorString(c.spec.jobTemplate.spec.selector)],
    },
    services: {
      h: ['NAME', 'TYPE', 'CLUSTER-IP', 'EXTERNAL-IP', 'PORT(S)', 'AGE'],
      f: (s) => [s.metadata.name, s.spec.type, s.spec.type === 'ExternalName' ? '<none>' : s.spec.clusterIP || '<none>', svcExternal(s), svcPorts(s), age(s.metadata.creationTimestamp)],
      wh: ['SELECTOR'],
      wf: (s) => [U.mapSelectorString(s.spec.selector)],
    },
    endpoints: { h: ['NAME', 'ENDPOINTS', 'AGE'], f: (e) => [e.metadata.name, epString(e), age(e.metadata.creationTimestamp)] },
    'endpointslices.discovery.k8s.io': {
      h: ['NAME', 'ADDRESSTYPE', 'PORTS', 'ENDPOINTS', 'AGE'],
      f: (e) => {
        const ports = (e.ports || []).map((p) => p.port).filter((x) => x !== null && x !== undefined);
        const eps = (e.endpoints || []).flatMap((x) => x.addresses);
        return [e.metadata.name, e.addressType, ports.length ? ports.join(',') : '<unset>', eps.length ? (eps.length > 3 ? eps.slice(0, 3).join(',') + ` + ${eps.length - 3} more...` : eps.join(',')) : '<unset>', age(e.metadata.creationTimestamp)];
      },
    },
    nodes: {
      h: ['NAME', 'STATUS', 'ROLES', 'AGE', 'VERSION'],
      f: (n) => [n.metadata.name, nodeStatus(n), nodeRoles(n), age(n.metadata.creationTimestamp), n.status.nodeInfo.kubeletVersion],
      wh: ['INTERNAL-IP', 'EXTERNAL-IP', 'OS-IMAGE', 'KERNEL-VERSION', 'CONTAINER-RUNTIME'],
      wf: (n) => [((n.status.addresses || []).find((a) => a.type === 'InternalIP') || {}).address || '<none>', ((n.status.addresses || []).find((a) => a.type === 'ExternalIP') || {}).address || '<none>', n.status.nodeInfo.osImage, n.status.nodeInfo.kernelVersion, n.status.nodeInfo.containerRuntimeVersion],
    },
    namespaces: { h: ['NAME', 'STATUS', 'AGE'], f: (n) => [n.metadata.name, n.status.phase, age(n.metadata.creationTimestamp)] },
    configmaps: { h: ['NAME', 'DATA', 'AGE'], f: (c) => [c.metadata.name, String(Object.keys(c.data || {}).length + Object.keys(c.binaryData || {}).length), age(c.metadata.creationTimestamp)] },
    secrets: { h: ['NAME', 'TYPE', 'DATA', 'AGE'], f: (s) => [s.metadata.name, s.type, String(Object.keys(s.data || {}).length), age(s.metadata.creationTimestamp)] },
    serviceaccounts: { h: ['NAME', 'SECRETS', 'AGE'], f: (s) => [s.metadata.name, String((s.secrets || []).length), age(s.metadata.creationTimestamp)] },
    persistentvolumeclaims: {
      h: ['NAME', 'STATUS', 'VOLUME', 'CAPACITY', 'ACCESS MODES', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'AGE'],
      f: (c) => {
        const bound = c.status.phase === 'Bound';
        const am = (bound ? c.status.accessModes : []) || [];
        return [c.metadata.name, c.metadata.deletionTimestamp ? 'Terminating' : c.status.phase, c.spec.volumeName || '', bound ? ((c.status.capacity || {}).storage || '') : '', am.map((m) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m])).join(','), c.spec.storageClassName ?? '<unset>', c.spec.volumeAttributesClassName || '<unset>', age(c.metadata.creationTimestamp)];
      },
      wh: ['VOLUMEMODE'],
      wf: (c) => [c.spec.volumeMode || 'Filesystem'],
    },
    persistentvolumes: {
      h: ['NAME', 'CAPACITY', 'ACCESS MODES', 'RECLAIM POLICY', 'STATUS', 'CLAIM', 'STORAGECLASS', 'VOLUMEATTRIBUTESCLASS', 'REASON', 'AGE'],
      f: (v) => [v.metadata.name, (v.spec.capacity || {}).storage, (v.spec.accessModes || []).map((m) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m])).join(','), v.spec.persistentVolumeReclaimPolicy, v.metadata.deletionTimestamp ? 'Terminating' : v.status.phase, v.spec.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : '', v.spec.storageClassName || '', v.spec.volumeAttributesClassName || '<unset>', v.status.reason || '', age(v.metadata.creationTimestamp)],
      wh: ['VOLUMEMODE'],
      wf: (v) => [v.spec.volumeMode || 'Filesystem'],
    },
    'storageclasses.storage.k8s.io': {
      h: ['NAME', 'PROVISIONER', 'RECLAIMPOLICY', 'VOLUMEBINDINGMODE', 'ALLOWVOLUMEEXPANSION', 'AGE'],
      f: (s) => [s.metadata.name + ((s.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true' ? ' (default)' : ''), s.provisioner, s.reclaimPolicy || 'Delete', s.volumeBindingMode || 'Immediate', String(!!s.allowVolumeExpansion), age(s.metadata.creationTimestamp)],
    },
    'ingresses.networking.k8s.io': {
      h: ['NAME', 'CLASS', 'HOSTS', 'ADDRESS', 'PORTS', 'AGE'],
      f: (i) => {
        const hosts = [...new Set((i.spec.rules || []).map((r) => r.host || '*'))];
        const addr = ((i.status.loadBalancer || {}).ingress || []).map((x) => x.ip || x.hostname).join(',');
        return [i.metadata.name, i.spec.ingressClassName || '<none>', hosts.length ? hosts.join(',') : '*', addr, (i.spec.tls || []).length ? '80, 443' : '80', age(i.metadata.creationTimestamp)];
      },
    },
    'ingressclasses.networking.k8s.io': { h: ['NAME', 'CONTROLLER', 'PARAMETERS', 'AGE'], f: (i) => [i.metadata.name, i.spec.controller, i.spec.parameters ? `${i.spec.parameters.kind}/${i.spec.parameters.name}` : '<none>', age(i.metadata.creationTimestamp)] },
    'networkpolicies.networking.k8s.io': { h: ['NAME', 'POD-SELECTOR', 'AGE'], f: (n) => [n.metadata.name, U.selectorString(n.spec.podSelector) === '<none>' ? '<none>' : U.selectorString(n.spec.podSelector), age(n.metadata.creationTimestamp)] },
    'horizontalpodautoscalers.autoscaling': {
      h: ['NAME', 'REFERENCE', 'TARGETS', 'MINPODS', 'MAXPODS', 'REPLICAS', 'AGE'],
      f: (h) => [h.metadata.name, `${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`, hpaTargets(h), String(h.spec.minReplicas ?? 1), String(h.spec.maxReplicas), String(h.status.currentReplicas ?? 0), age(h.metadata.creationTimestamp)],
    },
    'roles.rbac.authorization.k8s.io': { h: ['NAME', 'CREATED AT'], f: (r) => [r.metadata.name, r.metadata.creationTimestamp] },
    'clusterroles.rbac.authorization.k8s.io': { h: ['NAME', 'CREATED AT'], f: (r) => [r.metadata.name, r.metadata.creationTimestamp] },
    'rolebindings.rbac.authorization.k8s.io': {
      h: ['NAME', 'ROLE', 'AGE'],
      f: (b) => [b.metadata.name, `${b.roleRef.kind}/${b.roleRef.name}`, age(b.metadata.creationTimestamp)],
      wh: ['USERS', 'GROUPS', 'SERVICEACCOUNTS'],
      wf: (b) => [subjectsOf(b, 'User'), subjectsOf(b, 'Group'), subjectsOf(b, 'ServiceAccount')],
    },
    'clusterrolebindings.rbac.authorization.k8s.io': {
      h: ['NAME', 'ROLE', 'AGE'],
      f: (b) => [b.metadata.name, `${b.roleRef.kind}/${b.roleRef.name}`, age(b.metadata.creationTimestamp)],
      wh: ['USERS', 'GROUPS', 'SERVICEACCOUNTS'],
      wf: (b) => [subjectsOf(b, 'User'), subjectsOf(b, 'Group'), subjectsOf(b, 'ServiceAccount')],
    },
    events: {
      h: ['LAST SEEN', 'TYPE', 'REASON', 'OBJECT', 'MESSAGE'],
      f: (e) => [e.count > 1 ? `${age(e.lastTimestamp)} (x${e.count} over ${age(e.firstTimestamp)})` : age(e.lastTimestamp || e.eventTime), e.type, e.reason, `${e.involvedObject.kind.toLowerCase()}/${e.involvedObject.name}`, e.message.replace(/\n/g, ' ')],
      wh: ['SUBOBJECT', 'SOURCE', 'FIRST SEEN', 'COUNT', 'NAME'],
      wf: (e) => [e.involvedObject.fieldPath || '', `${e.source.component}${e.source.host ? ', ' + e.source.host : ''}`, age(e.firstTimestamp), String(e.count || 1), e.metadata.name],
    },
    resourcequotas: {
      h: ['NAME', 'AGE', 'REQUEST', 'LIMIT'],
      f: (q) => {
        const hard = q.status.hard || {}, used = q.status.used || {};
        const req = Object.keys(hard).filter((k) => !k.startsWith('limits.')).sort().map((k) => `${k}: ${used[k] ?? '0'}/${hard[k]}`).join(', ');
        const lim = Object.keys(hard).filter((k) => k.startsWith('limits.')).sort().map((k) => `${k}: ${used[k] ?? '0'}/${hard[k]}`).join(', ');
        return [q.metadata.name, age(q.metadata.creationTimestamp), req, lim];
      },
    },
    limitranges: { h: ['NAME', 'CREATED AT'], f: (l) => [l.metadata.name, l.metadata.creationTimestamp] },
    'poddisruptionbudgets.policy': {
      h: ['NAME', 'MIN AVAILABLE', 'MAX UNAVAILABLE', 'ALLOWED DISRUPTIONS', 'AGE'],
      f: (p) => [p.metadata.name, p.spec.minAvailable !== undefined ? String(p.spec.minAvailable) : 'N/A', p.spec.maxUnavailable !== undefined ? String(p.spec.maxUnavailable) : 'N/A', String(p.status.disruptionsAllowed || 0), age(p.metadata.creationTimestamp)],
    },
    'priorityclasses.scheduling.k8s.io': { h: ['NAME', 'VALUE', 'GLOBAL-DEFAULT', 'AGE', 'PREEMPTIONPOLICY'], f: (p) => [p.metadata.name, String(p.value), String(!!p.globalDefault), age(p.metadata.creationTimestamp), p.preemptionPolicy || 'PreemptLowerPriority'] },
    'customresourcedefinitions.apiextensions.k8s.io': { h: ['NAME', 'CREATED AT'], f: (c) => [c.metadata.name, c.metadata.creationTimestamp] },
    'certificatesigningrequests.certificates.k8s.io': {
      h: ['NAME', 'AGE', 'SIGNERNAME', 'REQUESTOR', 'REQUESTEDDURATION', 'CONDITION'],
      f: (c) => {
        const conds = (c.status.conditions || []).map((x) => x.type);
        let cond = conds.length ? conds.join(',') : 'Pending';
        if (c.status.certificate) cond += ',Issued';
        return [c.metadata.name, age(c.metadata.creationTimestamp), c.spec.signerName, c.spec.username, c.spec.expirationSeconds ? U.human(c.spec.expirationSeconds) : '<none>', cond];
      },
    },
    'leases.coordination.k8s.io': { h: ['NAME', 'HOLDER', 'AGE'], f: (l) => [l.metadata.name, l.spec.holderIdentity || '', age(l.metadata.creationTimestamp)] },
    'controllerrevisions.apps': { h: ['NAME', 'CONTROLLER', 'REVISION', 'AGE'], f: (c) => { const o = (c.metadata.ownerReferences || [])[0]; return [c.metadata.name, o ? `${o.kind.toLowerCase()}.${o.apiVersion.split('/')[0]}/${o.name}` : '<none>', String(c.revision), age(c.metadata.creationTimestamp)]; } },
    componentstatuses: { h: ['NAME', 'STATUS', 'MESSAGE', 'ERROR'], f: (c) => [c.metadata.name, (c.conditions || [])[0].status === 'True' ? 'Healthy' : 'Unhealthy', (c.conditions || [])[0].message || '', (c.conditions || [])[0].error || ''] },
    'apiservices.apiregistration.k8s.io': { h: ['NAME', 'SERVICE', 'AVAILABLE', 'AGE'], f: (a) => [a.metadata.name, a.spec.service ? `${a.spec.service.namespace}/${a.spec.service.name}` : 'Local', ((a.status.conditions || [])[0] || {}).status === 'True' ? 'True' : 'False', age(a.metadata.creationTimestamp)] },
    'flowschemas.flowcontrol.apiserver.k8s.io': { h: ['NAME', 'PRIORITYLEVEL', 'MATCHINGPRECEDENCE', 'DISTINGUISHERMETHOD', 'AGE', 'MISSINGPL'], f: (f) => [f.metadata.name, f.spec.priorityLevelConfiguration.name, String(f.spec.matchingPrecedence), f.spec.distinguisherMethod ? f.spec.distinguisherMethod.type : '<none>', age(f.metadata.creationTimestamp), 'False'] },
    'prioritylevelconfigurations.flowcontrol.apiserver.k8s.io': { h: ['NAME', 'TYPE', 'NOMINALCONCURRENCYSHARES', 'QUEUES', 'HANDSIZE', 'QUEUELENGTHLIMIT', 'AGE'], f: (p) => [p.metadata.name, p.spec.type, p.spec.limited ? String(p.spec.limited.nominalConcurrencyShares) : '<none>', p.spec.limited && p.spec.limited.limitResponse.type === 'Queue' ? '64' : '<none>', p.spec.limited && p.spec.limited.limitResponse.type === 'Queue' ? '6' : '<none>', p.spec.limited && p.spec.limited.limitResponse.type === 'Queue' ? '50' : '<none>', age(p.metadata.creationTimestamp)] },
    'csinodes.storage.k8s.io': { h: ['NAME', 'DRIVERS', 'AGE'], f: (c) => [c.metadata.name, String((c.spec.drivers || []).length), age(c.metadata.creationTimestamp)] },
    'runtimeclasses.node.k8s.io': { h: ['NAME', 'HANDLER', 'AGE'], f: (r) => [r.metadata.name, r.handler, age(r.metadata.creationTimestamp)] },
    'mutatingwebhookconfigurations.admissionregistration.k8s.io': { h: ['NAME', 'WEBHOOKS', 'AGE'], f: (w) => [w.metadata.name, String((w.webhooks || []).length), age(w.metadata.creationTimestamp)] },
    'validatingwebhookconfigurations.admissionregistration.k8s.io': { h: ['NAME', 'WEBHOOKS', 'AGE'], f: (w) => [w.metadata.name, String((w.webhooks || []).length), age(w.metadata.creationTimestamp)] },
    podtemplates: { h: ['NAME', 'CONTAINERS', 'IMAGES', 'POD LABELS'], f: (p) => [p.metadata.name, ...containersImages(p.template), U.labelsString((p.template.metadata || {}).labels)] },
    'volumeattachments.storage.k8s.io': { h: ['NAME', 'ATTACHER', 'PV', 'NODE', 'ATTACHED', 'AGE'], f: (v) => [v.metadata.name, v.spec.attacher, (v.spec.source || {}).persistentVolumeName || '', v.spec.nodeName, String(!!(v.status || {}).attached), age(v.metadata.creationTimestamp)] },
  };
  COLS['events.events.k8s.io'] = COLS.events;
  const DEFAULT = { h: ['NAME', 'AGE'], f: (o) => [o.metadata.name, age(o.metadata.creationTimestamp)] };
  P.columnsFor = (t) => {
    if (COLS[t.id]) return COLS[t.id];
    if (t.crd && t.printerColumns && t.printerColumns.length) {
      const cols = t.printerColumns;
      const val = (o, c) => {
        let v;
        try { v = U.jsonpath.evalPath(c.jsonPath.startsWith('.') ? c.jsonPath : '.' + c.jsonPath, o, o)[0]; } catch (e) { v = undefined; }
        if (v === undefined || v === null) return '';
        if (c.type === 'date') return age(v);
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      };
      const main = cols.filter((c) => !c.priority);
      const wide = cols.filter((c) => c.priority);
      return {
        h: ['NAME', ...main.map((c) => c.name.toUpperCase())],
        f: (o) => [o.metadata.name, ...main.map((c) => val(o, c))],
        wh: wide.map((c) => c.name.toUpperCase()),
        wf: (o) => wide.map((c) => val(o, c)),
      };
    }
    return DEFAULT;
  };

  // rows: arrays de células; opts: {wide, withKind, allNs, showLabels, labelCols, noHeaders}
  P.tableRows = (t, items, opts = {}) => {
    const cols = P.columnsFor(t);
    const head = [...cols.h];
    if (opts.wide && cols.wh) head.push(...cols.wh);
    if (opts.allNs && t.namespaced) head.unshift('NAMESPACE');
    for (const l of opts.labelCols || []) head.push(l.split('/').pop().toUpperCase());
    if (opts.showLabels) head.push('LABELS');
    const rows = [];
    for (const o of items) {
      let r = cols.f(o);
      if (opts.wide && cols.wf) r = r.concat(cols.wf(o));
      if (opts.withKind) r[0] = `${t.kindRef}/${r[0]}`;
      if (opts.allNs && t.namespaced) r.unshift(o.metadata.namespace);
      for (const l of opts.labelCols || []) r.push((o.metadata.labels || {})[l] ?? '');
      if (opts.showLabels) r.push(U.labelsString(o.metadata.labels));
      rows.push(r.map((x) => (x === undefined || x === null ? '' : String(x))));
    }
    return { head, rows };
  };
  P.table = (t, items, opts = {}) => {
    const { head, rows } = P.tableRows(t, items, opts);
    const all = opts.noHeaders ? rows : [head, ...rows];
    return U.table(all);
  };

  // ---------------- describe ----------------
  class DW {
    constructor() { this.lines = []; }
    w(level, text) { this.lines.push('  '.repeat(level) + text); }
    map(level, label, m, sep = '=') {
      const e = Object.entries(m || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      if (!e.length) { this.w(level, `${label}:\t<none>`); return; }
      e.forEach(([k, v], i) => this.w(level, `${i === 0 ? label + ':' : ''}\t${k}${sep}${sep === ': ' && String(v).includes('\n') ? '\n' + String(v) : v}`));
    }
    list(level, label, arr) {
      if (!arr || !arr.length) { this.w(level, `${label}:\t<none>`); return; }
      arr.forEach((v, i) => this.w(level, `${i === 0 ? label + ':' : ''}\t${v}`));
    }
    toString() { return U.tabwrite(this.lines.join('\n'), 0, 2) + '\n'; }
  }
  P.DW = DW;
  const fmtTime = (ts) => (ts ? U.rfc1123z(ts) : '<unset>');
  const annotations = (w, level, m, label = 'Annotations') => {
    const skip = ['kubectl.kubernetes.io/last-applied-configuration'];
    const e = Object.fromEntries(Object.entries(m || {}).filter(([k]) => !skip.includes(k)));
    w.map(level, label, e, ': ');
  };
  const describeEvents = (w, cluster, obj) => {
    const evs = cluster ? cluster.eventsFor(obj) : [];
    if (!evs.length) { w.w(0, 'Events:\t<none>'); return; }
    w.w(0, 'Events:');
    w.w(1, 'Type\tReason\tAge\tFrom\tMessage');
    w.w(1, '----\t------\t----\t----\t-------');
    for (const e of evs) {
      const a = e.count > 1 ? `${age(e.lastTimestamp)} (x${e.count} over ${age(e.firstTimestamp)})` : age(e.firstTimestamp);
      const from = e.source.component + (e.source.host && e.source.component === 'kubelet' ? '' : '');
      w.w(1, `${e.type}\t${e.reason}\t${a}\t${from}\t${e.message.replace(/\n/g, ' ')}`);
    }
  };
  const probeStr = (p) => {
    let h = '';
    if (p.httpGet) h = `http-get ${(p.httpGet.scheme || 'HTTP').toLowerCase()}://${p.httpGet.host || ''}:${p.httpGet.port}${p.httpGet.path || ''}`;
    else if (p.tcpSocket) h = `tcp-socket ${p.tcpSocket.host || ''}:${p.tcpSocket.port}`;
    else if (p.exec) h = `exec [${(p.exec.command || []).join(' ')}]`;
    else if (p.grpc) h = `grpc <pod>:${p.grpc.port} ${p.grpc.service || ''}`;
    return `${h} delay=${p.initialDelaySeconds || 0}s timeout=${p.timeoutSeconds || 1}s period=${p.periodSeconds || 10}s #success=${p.successThreshold || 1} #failure=${p.failureThreshold || 3}`;
  };
  const resourceBlock = (w, level, res) => {
    for (const [lbl, key] of [['Limits', 'limits'], ['Requests', 'requests']]) {
      const m = (res || {})[key];
      if (!m || !Object.keys(m).length) continue;
      w.w(level, `${lbl}:`);
      for (const [k, v] of Object.entries(m).sort()) w.w(level + 1, `${k}:\t${v}`);
    }
  };
  const describeContainer = (w, level, c, cs, pod, isTemplate) => {
    w.w(level, `${c.name}:`);
    const L = level + 1;
    if (cs && !isTemplate) w.w(L, `Container ID:\t${cs.containerID || ''}`);
    w.w(L, `Image:\t${c.image}`);
    if (cs && !isTemplate) w.w(L, `Image ID:\t${cs.imageID || ''}`);
    const ports = (c.ports || []).map((p) => `${p.containerPort}/${p.protocol || 'TCP'}${p.name ? ` (${p.name})` : ''}`);
    const hports = (c.ports || []).map((p) => `${p.hostPort || 0}/${p.protocol || 'TCP'}`);
    if (ports.length > 1) { w.w(L, `Ports:\t${ports.join(', ')}`); w.w(L, `Host Ports:\t${hports.join(', ')}`); }
    else { w.w(L, `Port:\t${ports[0] || '<none>'}`); w.w(L, `Host Port:\t${hports[0] || '<none>'}`); }
    if (c.command) { w.w(L, 'Command:'); for (const x of c.command) w.w(L + 1, x.replace(/\n/g, '\n' + '  '.repeat(L + 1))); }
    if (c.args) { w.w(L, 'Args:'); for (const x of c.args) w.w(L + 1, x.replace(/\n/g, '\n' + '  '.repeat(L + 1))); }
    const stateBlock = (label, st) => {
      if (!st || !Object.keys(st).length) return;
      if (st.running) { w.w(L, `${label}:\tRunning`); w.w(L + 1, `Started:\t${fmtTime(st.running.startedAt)}`); }
      else if (st.waiting) { w.w(L, `${label}:\tWaiting`); w.w(L + 1, `Reason:\t${st.waiting.reason || ''}`); if (st.waiting.message && label === 'State' && false) w.w(L + 1, `Message:\t${st.waiting.message}`); }
      else if (st.terminated) {
        const t = st.terminated;
        w.w(L, `${label}:\tTerminated`);
        w.w(L + 1, `Reason:\t${t.reason || ''}`);
        if (t.message) w.w(L + 1, `Message:\t${t.message}`);
        w.w(L + 1, `Exit Code:\t${t.exitCode}`);
        w.w(L + 1, `Started:\t${fmtTime(t.startedAt)}`);
        w.w(L + 1, `Finished:\t${fmtTime(t.finishedAt)}`);
      }
    };
    if (cs && !isTemplate) {
      stateBlock('State', cs.state);
      stateBlock('Last State', cs.lastState);
      w.w(L, `Ready:\t${cs.ready ? 'True' : 'False'}`);
      w.w(L, `Restart Count:\t${cs.restartCount}`);
    } else if (!isTemplate && pod) {
      w.w(L, 'State:\tWaiting');
      w.w(L + 1, 'Reason:\tContainerCreating');
      w.w(L, 'Ready:\tFalse');
      w.w(L, 'Restart Count:\t0');
    }
    resourceBlock(w, L, c.resources);
    if (c.livenessProbe) w.w(L, `Liveness:\t${probeStr(c.livenessProbe)}`);
    if (c.readinessProbe) w.w(L, `Readiness:\t${probeStr(c.readinessProbe)}`);
    if (c.startupProbe) w.w(L, `Startup:\t${probeStr(c.startupProbe)}`);
    if ((c.envFrom || []).length) {
      w.w(L, 'Environment Variables from:');
      for (const ef of c.envFrom) {
        if (ef.configMapRef) w.w(L + 1, `${ef.configMapRef.name}\tConfigMap\t${ef.prefix ? `with prefix '${ef.prefix}'\t` : ''}Optional: ${!!ef.configMapRef.optional}`);
        if (ef.secretRef) w.w(L + 1, `${ef.secretRef.name}\tSecret\t${ef.prefix ? `with prefix '${ef.prefix}'\t` : ''}Optional: ${!!ef.secretRef.optional}`);
      }
    }
    if (!(c.env || []).length) w.w(L, 'Environment:\t<none>');
    else {
      w.w(L, 'Environment:');
      for (const e of c.env) {
        if (e.valueFrom) {
          const v = e.valueFrom;
          if (v.configMapKeyRef) w.w(L + 1, `${e.name}:\t<set to the key '${v.configMapKeyRef.key}' of config map '${v.configMapKeyRef.name}'>\tOptional: ${!!v.configMapKeyRef.optional}`);
          else if (v.secretKeyRef) w.w(L + 1, `${e.name}:\t<set to the key '${v.secretKeyRef.key}' in secret '${v.secretKeyRef.name}'>\tOptional: ${!!v.secretKeyRef.optional}`);
          else if (v.fieldRef) w.w(L + 1, `${e.name}:\t${pod && !isTemplate ? (KS.currentCluster ? KS.currentCluster.fieldRef(pod, v.fieldRef.fieldPath) + ' ' : '') : ''}(${v.fieldRef.apiVersion || 'v1'}:${v.fieldRef.fieldPath})`);
          else if (v.resourceFieldRef) w.w(L + 1, `${e.name}:\t${v.resourceFieldRef.resource}`);
        } else w.w(L + 1, `${e.name}:\t${e.value ?? ''}`);
      }
    }
    if (!(c.volumeMounts || []).length) w.w(L, 'Mounts:\t<none>');
    else {
      w.w(L, 'Mounts:');
      for (const m of c.volumeMounts) w.w(L + 1, `${m.mountPath} from ${m.name} (${m.readOnly ? 'ro' : 'rw'}${m.subPath ? `,path="${m.subPath}"` : ''})`);
    }
  };
  const describeVolumes = (w, level, vols) => {
    if (!vols || !vols.length) { w.w(level, 'Volumes:\t<none>'); return; }
    w.w(level, 'Volumes:');
    const L = level + 1;
    for (const v of vols) {
      w.w(L, `${v.name}:`);
      const V = L + 1;
      if (v.projected) {
        w.w(V, 'Type:\tProjected (a volume that contains injected data from multiple sources)');
        for (const s of v.projected.sources || []) {
          if (s.serviceAccountToken) w.w(V, `TokenExpirationSeconds:\t${s.serviceAccountToken.expirationSeconds}`);
          if (s.configMap) { w.w(V, `ConfigMapName:\t${s.configMap.name}`); w.w(V, `ConfigMapOptional:\t${s.configMap.optional === undefined ? '<nil>' : s.configMap.optional}`); }
          if (s.secret) { w.w(V, `SecretName:\t${s.secret.name}`); w.w(V, `SecretOptionalName:\t${s.secret.optional === undefined ? '<nil>' : s.secret.optional}`); }
          if (s.downwardAPI) w.w(V, 'DownwardAPI:\ttrue');
        }
      } else if (v.configMap) {
        w.w(V, 'Type:\tConfigMap (a volume populated by a ConfigMap)');
        w.w(V, `Name:\t${v.configMap.name}`);
        w.w(V, `Optional:\t${!!v.configMap.optional}`);
      } else if (v.secret) {
        w.w(V, 'Type:\tSecret (a volume populated by a Secret)');
        w.w(V, `SecretName:\t${v.secret.secretName}`);
        w.w(V, `Optional:\t${!!v.secret.optional}`);
      } else if (v.emptyDir) {
        w.w(V, "Type:\tEmptyDir (a temporary directory that shares a pod's lifetime)");
        w.w(V, `Medium:\t${v.emptyDir.medium || ''}`);
        w.w(V, `SizeLimit:\t${v.emptyDir.sizeLimit || '<unset>'}`);
      } else if (v.persistentVolumeClaim) {
        w.w(V, 'Type:\tPersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)');
        w.w(V, `ClaimName:\t${v.persistentVolumeClaim.claimName}`);
        w.w(V, `ReadOnly:\t${!!v.persistentVolumeClaim.readOnly}`);
      } else if (v.hostPath) {
        w.w(V, 'Type:\tHostPath (bare host directory volume)');
        w.w(V, `Path:\t${v.hostPath.path}`);
        w.w(V, `HostPathType:\t${v.hostPath.type || ''}`);
      } else if (v.downwardAPI) {
        w.w(V, 'Type:\tDownwardAPI (a volume populated by information about the pod)');
        w.w(V, 'Items:');
        for (const it of v.downwardAPI.items || []) w.w(V + 1, `${it.fieldRef ? it.fieldRef.fieldPath : it.resourceFieldRef.resource} -> ${it.path}`);
      } else if (v.nfs) {
        w.w(V, "Type:\tNFS (an NFS mount that lasts the lifetime of a pod)");
        w.w(V, `Server:\t${v.nfs.server}`);
        w.w(V, `Path:\t${v.nfs.path}`);
        w.w(V, `ReadOnly:\t${!!v.nfs.readOnly}`);
      } else w.w(V, `Type:\t${Object.keys(v).filter((k) => k !== 'name')[0]}`);
    }
  };
  const tolerationsStr = (tols) =>
    (tols || []).map((t) => {
      let s = t.key || '';
      if (t.value) s += '=' + t.value;
      if (t.effect) s += ':' + t.effect;
      if (t.operator === 'Exists' && !t.key && !t.effect) s = '';
      if (t.operator === 'Exists') s += ' op=Exists';
      if (t.tolerationSeconds !== undefined) s += ` for ${t.tolerationSeconds}s`;
      return s.trim();
    });
  const podTemplate = (w, level, tpl) => {
    w.w(level, 'Pod Template:');
    const L = level + 1;
    w.map(L, 'Labels', (tpl.metadata || {}).labels);
    const anns = (tpl.metadata || {}).annotations;
    if (anns && Object.keys(anns).length) annotations(w, L, anns);
    if (tpl.spec.serviceAccountName && tpl.spec.serviceAccountName !== 'default') w.w(L, `Service Account:\t${tpl.spec.serviceAccountName}`);
    if (tpl.spec.priorityClassName) w.w(L, `Priority Class Name:\t${tpl.spec.priorityClassName}`);
    if ((tpl.spec.initContainers || []).length) {
      w.w(L, 'Init Containers:');
      for (const c of tpl.spec.initContainers) describeContainer(w, L, { ...c, name: ' ' + c.name }, null, null, true);
    }
    w.w(L, 'Containers:');
    for (const c of tpl.spec.containers || []) describeContainer(w, L, { ...c, name: ' ' + c.name }, null, null, true);
    describeVolumes(w, L, tpl.spec.volumes);
    w.w(L, `Node-Selectors:\t${U.mapSelectorString(tpl.spec.nodeSelector)}`);
    w.list(L, 'Tolerations', tolerationsStr(tpl.spec.tolerations));
  };
  const controlledBy = (w, o) => {
    const c = (o.metadata.ownerReferences || []).find((r) => r.controller);
    if (c) w.w(0, `Controlled By:\t${c.kind}/${c.name}`);
  };
  const header = (w, o, withNs = true) => {
    w.w(0, `Name:\t${o.metadata.name}`);
    if (withNs && o.metadata.namespace) w.w(0, `Namespace:\t${o.metadata.namespace}`);
  };
  const conditionsTable = (w, conds, cols) => {
    if (!conds || !conds.length) return;
    w.w(0, 'Conditions:');
    w.w(1, cols.join('\t'));
    w.w(1, cols.map((c) => '-'.repeat(c.length)).join('\t'));
    for (const c of conds) w.w(1, cols.map((k) => c[k.toLowerCase()] ?? '').join('\t'));
  };

  const D = {};
  D.pods = (p, cl) => {
    const w = new DW();
    header(w, p);
    w.w(0, `Priority:\t${p.spec.priority || 0}`);
    if (p.spec.priorityClassName) w.w(0, `Priority Class Name:\t${p.spec.priorityClassName}`);
    if (p.spec.runtimeClassName) w.w(0, `Runtime Class Name:\t${p.spec.runtimeClassName}`);
    w.w(0, `Service Account:\t${p.spec.serviceAccountName || 'default'}`);
    w.w(0, `Node:\t${p.spec.nodeName ? `${p.spec.nodeName}/${p.status.hostIP || ''}` : '<none>'}`);
    if (p.status.startTime) w.w(0, `Start Time:\t${fmtTime(p.status.startTime)}`);
    w.map(0, 'Labels', p.metadata.labels);
    annotations(w, 0, p.metadata.annotations);
    if (p.metadata.deletionTimestamp) {
      w.w(0, `Status:\tTerminating (lasts ${U.human((Date.now() - U.ms(p.metadata.deletionTimestamp)) / 1000 * -1 > 0 ? (U.ms(p.metadata.deletionTimestamp) - Date.now()) / 1000 : 0)})`);
      w.w(0, `Termination Grace Period:\t${p.metadata.deletionGracePeriodSeconds}s`);
    } else w.w(0, `Status:\t${p.status.phase}`);
    if (p.status.reason) w.w(0, `Reason:\t${p.status.reason}`);
    if (p.status.message) w.w(0, `Message:\t${p.status.message}`);
    if (p.spec.securityContext && p.spec.securityContext.seccompProfile) w.w(0, `SeccompProfile:\t${p.spec.securityContext.seccompProfile.type}`);
    w.w(0, `IP:\t${p.status.podIP || ''}`);
    if ((p.status.podIPs || []).length) { w.w(0, 'IPs:'); for (const ip of p.status.podIPs) w.w(1, `IP:\t${ip.ip}`); }
    else w.w(0, 'IPs:\t<none>');
    controlledBy(w, p);
    if ((p.spec.initContainers || []).length) {
      w.w(0, 'Init Containers:');
      for (const c of p.spec.initContainers) describeContainer(w, 1, c, (p.status.initContainerStatuses || []).find((x) => x.name === c.name), p);
    }
    w.w(0, 'Containers:');
    for (const c of p.spec.containers) describeContainer(w, 1, c, (p.status.containerStatuses || []).find((x) => x.name === c.name), p);
    if ((p.spec.ephemeralContainers || []).length) {
      w.w(0, 'Ephemeral Containers:');
      for (const c of p.spec.ephemeralContainers) describeContainer(w, 1, c, (p.status.ephemeralContainerStatuses || []).find((x) => x.name === c.name), p);
    }
    if ((p.status.conditions || []).length) {
      w.w(0, 'Conditions:');
      w.w(1, 'Type\tStatus');
      for (const c of p.status.conditions) w.w(1, `${c.type} \t${c.status} `);
    }
    describeVolumes(w, 0, p.spec.volumes);
    w.w(0, `QoS Class:\t${p.status.qosClass || 'BestEffort'}`);
    w.w(0, `Node-Selectors:\t${U.mapSelectorString(p.spec.nodeSelector)}`);
    w.list(0, 'Tolerations', tolerationsStr(p.spec.tolerations));
    describeEvents(w, cl, p);
    return w.toString();
  };
  D['deployments.apps'] = (d, cl) => {
    const w = new DW();
    header(w, d);
    w.w(0, `CreationTimestamp:\t${fmtTime(d.metadata.creationTimestamp)}`);
    w.map(0, 'Labels', d.metadata.labels);
    annotations(w, 0, d.metadata.annotations);
    w.w(0, `Selector:\t${U.selectorString(d.spec.selector)}`);
    const st = d.status;
    w.w(0, `Replicas:\t${d.spec.replicas} desired | ${st.updatedReplicas || 0} updated | ${st.replicas || 0} total | ${st.availableReplicas || 0} available | ${st.unavailableReplicas || 0} unavailable`);
    w.w(0, `StrategyType:\t${d.spec.strategy.type}`);
    w.w(0, `MinReadySeconds:\t${d.spec.minReadySeconds || 0}`);
    if (d.spec.strategy.rollingUpdate) w.w(0, `RollingUpdateStrategy:\t${d.spec.strategy.rollingUpdate.maxUnavailable} max unavailable, ${d.spec.strategy.rollingUpdate.maxSurge} max surge`);
    podTemplate(w, 0, d.spec.template);
    conditionsTable(w, st.conditions, ['Type', 'Status', 'Reason']);
    if (cl) {
      const rss = cl.controlledBy(S.byId('replicasets.apps'), d.metadata.namespace, d);
      const hash = cl.tplHash(d.spec.template);
      const newRS = rss.find((r) => cl.tplHash(r.spec.template) === hash);
      const old = rss.filter((r) => r !== newRS && (r.spec.replicas > 0 || (r.status.replicas || 0) > 0));
      w.w(0, `OldReplicaSets:\t${old.length ? old.map((r) => `${r.metadata.name} (${r.status.replicas || 0}/${r.spec.replicas} replicas created)`).join(', ') : '<none>'}`);
      w.w(0, `NewReplicaSet:\t${newRS ? `${newRS.metadata.name} (${newRS.status.replicas || 0}/${newRS.spec.replicas} replicas created)` : '<none>'}`);
    }
    describeEvents(w, cl, d);
    return w.toString();
  };
  const describeRSLike = (kindLabel) => (r, cl) => {
    const w = new DW();
    header(w, r);
    w.w(0, `Selector:\t${r.spec.selector && r.spec.selector.matchLabels ? U.selectorString(r.spec.selector) : U.mapSelectorString(r.spec.selector)}`);
    w.map(0, 'Labels', r.metadata.labels);
    annotations(w, 0, r.metadata.annotations);
    controlledBy(w, r);
    w.w(0, `Replicas:\t${r.status.replicas || 0} current / ${r.spec.replicas} desired`);
    if (cl) {
      const pods = cl.controlledBy(S.byId('pods'), r.metadata.namespace, r);
      const c = (ph) => pods.filter((p) => p.status.phase === ph).length;
      w.w(0, `Pods Status:\t${c('Running')} Running / ${c('Pending')} Waiting / ${c('Succeeded')} Succeeded / ${c('Failed')} Failed`);
    }
    podTemplate(w, 0, r.spec.template);
    conditionsTable(w, r.status.conditions, ['Type', 'Status', 'Reason']);
    describeEvents(w, cl, r);
    return w.toString();
  };
  D['replicasets.apps'] = describeRSLike('ReplicaSet');
  D.replicationcontrollers = describeRSLike('ReplicationController');
  D['statefulsets.apps'] = (s, cl) => {
    const w = new DW();
    header(w, s);
    w.w(0, `CreationTimestamp:\t${fmtTime(s.metadata.creationTimestamp)}`);
    w.w(0, `Selector:\t${U.selectorString(s.spec.selector)}`);
    w.map(0, 'Labels', s.metadata.labels);
    annotations(w, 0, s.metadata.annotations);
    w.w(0, `Replicas:\t${s.spec.replicas} desired | ${s.status.replicas || 0} total`);
    w.w(0, `Update Strategy:\t${s.spec.updateStrategy.type}`);
    if (s.spec.updateStrategy.rollingUpdate) w.w(1, `Partition:\t${s.spec.updateStrategy.rollingUpdate.partition || 0}`);
    if (cl) {
      const pods = cl.controlledBy(S.byId('pods'), s.metadata.namespace, s);
      const c = (ph) => pods.filter((p) => p.status.phase === ph).length;
      w.w(0, `Pods Status:\t${c('Running')} Running / ${c('Pending')} Waiting / ${c('Succeeded')} Succeeded / ${c('Failed')} Failed`);
    }
    podTemplate(w, 0, s.spec.template);
    if ((s.spec.volumeClaimTemplates || []).length) {
      w.w(0, 'Volume Claims:');
      for (const v of s.spec.volumeClaimTemplates) {
        w.w(1, `Name:\t${v.metadata.name}`);
        w.w(1, `StorageClass:\t${v.spec.storageClassName || ''}`);
        w.map(1, 'Labels', v.metadata.labels);
        w.map(1, 'Annotations', v.metadata.annotations, ': ');
        w.w(1, `Capacity:\t${((v.spec.resources || {}).requests || {}).storage || ''}`);
        w.w(1, `Access Modes:\t[${(v.spec.accessModes || []).join(' ')}]`);
      }
    } else w.w(0, 'Volume Claims:\t<none>');
    describeEvents(w, cl, s);
    return w.toString();
  };
  D['daemonsets.apps'] = (d, cl) => {
    const w = new DW();
    header(w, d);
    w.w(0, `Selector:\t${U.selectorString(d.spec.selector)}`);
    w.w(0, `Node-Selector:\t${U.mapSelectorString(d.spec.template.spec.nodeSelector)}`);
    w.map(0, 'Labels', d.metadata.labels);
    annotations(w, 0, { 'deprecated.daemonset.template.generation': String(d.metadata.generation || 1), ...(d.metadata.annotations || {}) });
    w.w(0, `Desired Number of Nodes Scheduled: ${d.status.desiredNumberScheduled || 0}`);
    w.w(0, `Current Number of Nodes Scheduled: ${d.status.currentNumberScheduled || 0}`);
    w.w(0, `Number of Nodes Scheduled with Up-to-date Pods: ${d.status.updatedNumberScheduled || 0}`);
    w.w(0, `Number of Nodes Scheduled with Available Pods: ${d.status.numberAvailable || 0}`);
    w.w(0, `Number of Nodes Misscheduled: ${d.status.numberMisscheduled || 0}`);
    if (cl) {
      const pods = cl.controlledBy(S.byId('pods'), d.metadata.namespace, d);
      const c = (ph) => pods.filter((p) => p.status.phase === ph).length;
      w.w(0, `Pods Status:\t${c('Running')} Running / ${c('Pending')} Waiting / ${c('Succeeded')} Succeeded / ${c('Failed')} Failed`);
    }
    podTemplate(w, 0, d.spec.template);
    describeEvents(w, cl, d);
    return w.toString();
  };
  D['jobs.batch'] = (j, cl) => {
    const w = new DW();
    header(w, j);
    w.w(0, `Selector:\t${U.selectorString(j.spec.selector)}`);
    w.map(0, 'Labels', j.metadata.labels);
    annotations(w, 0, j.metadata.annotations);
    controlledBy(w, j);
    w.w(0, `Parallelism:\t${j.spec.parallelism}`);
    w.w(0, `Completions:\t${j.spec.completions ?? '<unset>'}`);
    w.w(0, `Completion Mode:\t${j.spec.completionMode}`);
    w.w(0, `Suspend:\t${!!j.spec.suspend}`);
    w.w(0, `Backoff Limit:\t${j.spec.backoffLimit}`);
    if (j.spec.ttlSecondsAfterFinished !== undefined) w.w(0, `TTL Seconds After Finished:\t${j.spec.ttlSecondsAfterFinished}`);
    if (j.status.startTime) w.w(0, `Start Time:\t${fmtTime(j.status.startTime)}`);
    if (j.status.completionTime) { w.w(0, `Completed At:\t${fmtTime(j.status.completionTime)}`); w.w(0, `Duration:\t${U.human((U.ms(j.status.completionTime) - U.ms(j.status.startTime)) / 1000)}`); }
    if (j.spec.activeDeadlineSeconds) w.w(0, `Active Deadline Seconds:\t${j.spec.activeDeadlineSeconds}s`);
    w.w(0, `Pods Statuses:\t${j.status.active || 0} Active (${j.status.ready || 0} Ready) / ${j.status.succeeded || 0} Succeeded / ${j.status.failed || 0} Failed`);
    if (j.status.completedIndexes) w.w(0, `Completed Indexes:\t${j.status.completedIndexes}`);
    podTemplate(w, 0, j.spec.template);
    describeEvents(w, cl, j);
    return w.toString();
  };
  D['cronjobs.batch'] = (c, cl) => {
    const w = new DW();
    header(w, c);
    w.map(0, 'Labels', c.metadata.labels);
    annotations(w, 0, c.metadata.annotations);
    w.w(0, `Schedule:\t${c.spec.schedule}`);
    w.w(0, `Concurrency Policy:\t${c.spec.concurrencyPolicy}`);
    w.w(0, `Suspend:\t${c.spec.suspend ? 'True' : 'False'}`);
    w.w(0, `Successful Job History Limit:\t${c.spec.successfulJobsHistoryLimit}`);
    w.w(0, `Failed Job History Limit:\t${c.spec.failedJobsHistoryLimit}`);
    w.w(0, `Starting Deadline Seconds:\t${c.spec.startingDeadlineSeconds !== undefined ? c.spec.startingDeadlineSeconds + 's' : '<unset>'}`);
    w.w(0, `Selector:\t<unset>`);
    w.w(0, `Parallelism:\t${c.spec.jobTemplate.spec.parallelism ?? '<unset>'}`);
    w.w(0, `Completions:\t${c.spec.jobTemplate.spec.completions ?? '<unset>'}`);
    podTemplate(w, 0, c.spec.jobTemplate.spec.template);
    w.w(0, `Last Schedule Time:\t${c.status.lastScheduleTime ? fmtTime(c.status.lastScheduleTime) : '<unset>'}`);
    w.w(0, `Active Jobs:\t${(c.status.active || []).map((a) => a.name).join(', ') || '<none>'}`);
    describeEvents(w, cl, c);
    return w.toString();
  };
  D.services = (s, cl) => {
    const w = new DW();
    header(w, s);
    w.map(0, 'Labels', s.metadata.labels);
    annotations(w, 0, s.metadata.annotations);
    w.w(0, `Selector:\t${U.mapSelectorString(s.spec.selector)}`);
    w.w(0, `Type:\t${s.spec.type}`);
    if (s.spec.type !== 'ExternalName') {
      w.w(0, `IP Family Policy:\t${s.spec.ipFamilyPolicy}`);
      w.w(0, `IP Families:\t${(s.spec.ipFamilies || []).join(',')}`);
      w.w(0, `IP:\t${s.spec.clusterIP}`);
      w.w(0, `IPs:\t${(s.spec.clusterIPs || []).join(',')}`);
    } else w.w(0, `External Name:\t${s.spec.externalName}`);
    if ((s.spec.externalIPs || []).length) w.w(0, `External IPs:\t${s.spec.externalIPs.join(',')}`);
    const lb = ((s.status.loadBalancer || {}).ingress || []).map((i) => i.ip || i.hostname);
    if (lb.length) w.w(0, `LoadBalancer Ingress:\t${lb.join(', ')}${(s.status.loadBalancer.ingress[0] || {}).ipMode ? ' (' + s.status.loadBalancer.ingress[0].ipMode + ')' : ''}`);
    const ep = cl ? cl.raw(S.byId('endpoints'), s.metadata.namespace, s.metadata.name) : null;
    for (const p of s.spec.ports || []) {
      const name = p.name || '<unset>';
      w.w(0, `Port:\t${name}\t${p.port}/${p.protocol}`);
      w.w(0, `TargetPort:\t${p.targetPort}/${p.protocol}`);
      if (p.nodePort) w.w(0, `NodePort:\t${name}\t${p.nodePort}/${p.protocol}`);
      const ips = [];
      if (ep) for (const sub of ep.subsets || []) { const sp = (sub.ports || []).find((x) => (x.name || '') === (p.name || '')); if (sp) for (const a of sub.addresses || []) ips.push(`${a.ip}:${sp.port}`); }
      w.w(0, `Endpoints:\t${ips.join(',')}`);
    }
    w.w(0, `Session Affinity:\t${s.spec.sessionAffinity}`);
    if (s.spec.externalTrafficPolicy) w.w(0, `External Traffic Policy:\t${s.spec.externalTrafficPolicy}`);
    w.w(0, `Internal Traffic Policy:\t${s.spec.internalTrafficPolicy || 'Cluster'}`);
    describeEvents(w, cl, s);
    return w.toString();
  };
  D.endpoints = (e, cl) => {
    const w = new DW();
    header(w, e);
    w.map(0, 'Labels', e.metadata.labels);
    annotations(w, 0, e.metadata.annotations);
    w.w(0, 'Subsets:');
    for (const s of e.subsets || []) {
      w.w(1, `Addresses:\t${(s.addresses || []).map((a) => a.ip).join(',') || '<none>'}`);
      w.w(1, `NotReadyAddresses:\t${(s.notReadyAddresses || []).map((a) => a.ip).join(',') || '<none>'}`);
      w.w(1, 'Ports:');
      w.w(2, 'Name\tPort\tProtocol');
      w.w(2, '----\t----\t--------');
      for (const p of s.ports || []) w.w(2, `${p.name || '<unset>'}\t${p.port}\t${p.protocol}`);
      w.w(0, '');
    }
    describeEvents(w, cl, e);
    return w.toString();
  };
  D.nodes = (n, cl) => {
    const w = new DW();
    w.w(0, `Name:\t${n.metadata.name}`);
    w.w(0, `Roles:\t${nodeRoles(n)}`);
    w.map(0, 'Labels', n.metadata.labels);
    annotations(w, 0, n.metadata.annotations);
    w.w(0, `CreationTimestamp:\t${fmtTime(n.metadata.creationTimestamp)}`);
    w.list(0, 'Taints', (n.spec.taints || []).map((t) => `${t.key}${t.value ? '=' + t.value : ''}:${t.effect}`));
    w.w(0, `Unschedulable:\t${!!n.spec.unschedulable}`);
    w.w(0, 'Lease:');
    w.w(1, `HolderIdentity:\t${n.metadata.name}`);
    w.w(1, `AcquireTime:\t<unset>`);
    w.w(1, `RenewTime:\t${fmtTime(new Date(Date.now() - 3000).toISOString())}`);
    w.w(0, 'Conditions:');
    w.w(1, 'Type\tStatus\tLastHeartbeatTime\tLastTransitionTime\tReason\tMessage');
    w.w(1, '----\t------\t-----------------\t------------------\t------\t-------');
    for (const c of n.status.conditions || []) w.w(1, `${c.type}\t${c.status}\t${fmtTime(c.lastHeartbeatTime)}\t${fmtTime(c.lastTransitionTime)}\t${c.reason}\t${c.message}`);
    w.w(0, 'Addresses:');
    for (const a of n.status.addresses || []) w.w(1, `${a.type}:\t${a.address}`);
    for (const [lbl, key] of [['Capacity', 'capacity'], ['Allocatable', 'allocatable']]) {
      w.w(0, `${lbl}:`);
      for (const [k, v] of Object.entries(n.status[key]).sort()) w.w(1, `${k}:\t${v}`);
    }
    const ni = n.status.nodeInfo;
    w.w(0, 'System Info:');
    for (const [k, v] of [['Machine ID', ni.machineID], ['System UUID', ni.systemUUID], ['Boot ID', ni.bootID], ['Kernel Version', ni.kernelVersion], ['OS Image', ni.osImage], ['Operating System', ni.operatingSystem], ['Architecture', ni.architecture], ['Container Runtime Version', ni.containerRuntimeVersion], ['Kubelet Version', ni.kubeletVersion], ['Kube-Proxy Version', ni.kubeProxyVersion]]) w.w(1, `${k}:\t${v}`);
    w.w(0, `PodCIDR:\t${n.spec.podCIDR}`);
    w.w(0, `PodCIDRs:\t${(n.spec.podCIDRs || []).join(',')}`);
    w.w(0, `ProviderID:\t${n.spec.providerID || ''}`);
    if (cl) {
      const pods = cl.podsOnNode(n.metadata.name).filter((p) => !p.metadata.deletionTimestamp || true);
      w.w(0, `Non-terminated Pods:\t(${pods.length} in total)`);
      w.w(1, 'Namespace\tName\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge');
      w.w(1, '---------\t----\t------------\t----------\t---------------\t-------------\t---');
      const cap = cl.nodeCap(n);
      const pct = (v, c) => `${Math.floor((v / c) * 100)}%`;
      for (const p of pods) {
        const r = cl.podRequests(p), l = cl.podLimits(p);
        w.w(1, `${p.metadata.namespace}\t${p.metadata.name}\t${U.fmtCPU(r.cpu) === '0m' ? '0' : U.fmtCPU(r.cpu)} (${pct(r.cpu, cap.cpu)})\t${l.cpu ? U.fmtCPU(l.cpu) : '0'} (${pct(l.cpu, cap.cpu)})\t${r.mem ? U.fmtMem(r.mem) : '0'} (${pct(r.mem, cap.mem)})\t${l.mem ? U.fmtMem(l.mem) : '0'} (${pct(l.mem, cap.mem)})\t${age(p.metadata.creationTimestamp)}`);
      }
      const a = cl.nodeAllocated(n.metadata.name);
      w.w(0, 'Allocated resources:');
      w.w(1, '(Total limits may be over 100 percent, i.e., overcommitted.)');
      w.w(1, 'Resource\tRequests\tLimits');
      w.w(1, '--------\t--------\t------');
      w.w(1, `cpu\t${a.cpu ? U.fmtCPU(a.cpu) : '0'} (${pct(a.cpu, cap.cpu)})\t${a.lcpu ? U.fmtCPU(a.lcpu) : '0'} (${pct(a.lcpu, cap.cpu)})`);
      w.w(1, `memory\t${a.mem ? U.fmtMem(a.mem) : '0'} (${pct(a.mem, cap.mem)})\t${a.lmem ? U.fmtMem(a.lmem) : '0'} (${pct(a.lmem, cap.mem)})`);
      w.w(1, 'ephemeral-storage\t0 (0%)\t0 (0%)');
      w.w(1, 'hugepages-1Gi\t0 (0%)\t0 (0%)');
      w.w(1, 'hugepages-2Mi\t0 (0%)\t0 (0%)');
    }
    describeEvents(w, cl, n);
    return w.toString();
  };
  D.namespaces = (n, cl) => {
    const w = new DW();
    w.w(0, `Name:\t${n.metadata.name}`);
    w.map(0, 'Labels', n.metadata.labels);
    annotations(w, 0, n.metadata.annotations);
    w.w(0, `Status:\t${n.status.phase}`);
    w.w(0, '');
    if (cl) {
      const qs = cl.rawList(S.byId('resourcequotas'), n.metadata.name);
      if (!qs.length) w.w(0, 'No resource quota.');
      for (const q of qs) {
        w.w(0, 'Resource Quotas');
        w.w(1, `Name:\t${q.metadata.name}`);
        w.w(1, 'Resource\tUsed\tHard');
        w.w(1, '--------\t---\t---');
        for (const k of Object.keys(q.status.hard || {}).sort()) w.w(1, `${k}\t${(q.status.used || {})[k] ?? '0'}\t${q.status.hard[k]}`);
      }
      w.w(0, '');
      const lrs = cl.rawList(S.byId('limitranges'), n.metadata.name);
      if (!lrs.length) w.w(0, 'No LimitRange resource.');
      for (const lr of lrs) {
        w.w(0, 'Resource Limits');
        w.w(1, 'Type\tResource\tMin\tMax\tDefault Request\tDefault Limit\tMax Limit/Request Ratio');
        w.w(1, '----\t--------\t---\t---\t---------------\t-------------\t-----------------------');
        for (const l of lr.spec.limits || []) {
          const keys = new Set([...Object.keys(l.min || {}), ...Object.keys(l.max || {}), ...Object.keys(l.default || {}), ...Object.keys(l.defaultRequest || {})]);
          for (const k of keys) w.w(1, `${l.type}\t${k}\t${(l.min || {})[k] || '-'}\t${(l.max || {})[k] || '-'}\t${(l.defaultRequest || {})[k] || '-'}\t${(l.default || {})[k] || '-'}\t${(l.maxLimitRequestRatio || {})[k] || '-'}`);
        }
      }
    }
    return w.toString();
  };
  D.configmaps = (c, cl) => {
    const w = new DW();
    header(w, c);
    w.map(0, 'Labels', c.metadata.labels);
    annotations(w, 0, c.metadata.annotations);
    let out = w.toString() + '\nData\n====\n';
    for (const [k, v] of Object.entries(c.data || {}).sort()) out += `${k}:\n----\n${v}${String(v).endsWith('\n') ? '' : '\n'}\n`;
    out += '\nBinaryData\n====\n';
    for (const [k, v] of Object.entries(c.binaryData || {})) out += `${k}: ${Math.floor((String(v).length * 3) / 4)} bytes\n`;
    const ev = new DW();
    describeEvents(ev, cl, c);
    return out + '\n' + ev.toString();
  };
  D.secrets = (s) => {
    const w = new DW();
    header(w, s);
    w.map(0, 'Labels', s.metadata.labels);
    annotations(w, 0, s.metadata.annotations);
    w.w(0, '');
    w.w(0, `Type:\t${s.type}`);
    w.w(0, '');
    w.w(0, 'Data');
    w.w(0, '====');
    for (const [k, v] of Object.entries(s.data || {}).sort()) {
      let len;
      try { len = new TextEncoder().encode(U.b64d(v)).length; } catch (e) { len = 0; }
      w.w(0, `${k}:\t${len} bytes`);
    }
    return w.toString();
  };
  D.serviceaccounts = (s, cl) => {
    const w = new DW();
    header(w, s);
    w.map(0, 'Labels', s.metadata.labels);
    annotations(w, 0, s.metadata.annotations);
    w.w(0, `Image pull secrets:\t${(s.imagePullSecrets || []).map((x) => x.name).join(', ') || '<none>'}`);
    w.w(0, `Mountable secrets:\t${(s.secrets || []).map((x) => x.name).join(', ') || '<none>'}`);
    w.w(0, `Tokens:\t<none>`);
    describeEvents(w, cl, s);
    return w.toString();
  };
  D.persistentvolumeclaims = (c, cl) => {
    const w = new DW();
    header(w, c);
    w.w(0, `StorageClass:\t${c.spec.storageClassName || ''}`);
    w.w(0, `Status:\t${c.metadata.deletionTimestamp ? `Terminating (lasts ${age(c.metadata.deletionTimestamp)})` : c.status.phase}`);
    w.w(0, `Volume:\t${c.spec.volumeName || ''}`);
    w.map(0, 'Labels', c.metadata.labels);
    annotations(w, 0, c.metadata.annotations);
    w.w(0, `Finalizers:\t[${(c.metadata.finalizers || []).join(' ')}]`);
    w.w(0, `Capacity:\t${c.status.phase === 'Bound' ? (c.status.capacity || {}).storage : ''}`);
    w.w(0, `Access Modes:\t${c.status.phase === 'Bound' ? (c.status.accessModes || []).map((m) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m])).join(',') : ''}`);
    w.w(0, `VolumeMode:\t${c.spec.volumeMode}`);
    if (cl) {
      const users = cl.rawList(S.byId('pods'), c.metadata.namespace).filter((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === c.metadata.name));
      w.list(0, 'Used By', users.map((p) => p.metadata.name));
    }
    describeEvents(w, cl, c);
    return w.toString();
  };
  D.persistentvolumes = (v, cl) => {
    const w = new DW();
    w.w(0, `Name:\t${v.metadata.name}`);
    w.map(0, 'Labels', v.metadata.labels);
    annotations(w, 0, v.metadata.annotations);
    w.w(0, `Finalizers:\t[${(v.metadata.finalizers || []).join(' ')}]`);
    w.w(0, `StorageClass:\t${v.spec.storageClassName || ''}`);
    w.w(0, `Status:\t${v.status.phase}`);
    w.w(0, `Claim:\t${v.spec.claimRef ? `${v.spec.claimRef.namespace}/${v.spec.claimRef.name}` : ''}`);
    w.w(0, `Reclaim Policy:\t${v.spec.persistentVolumeReclaimPolicy}`);
    w.w(0, `Access Modes:\t${(v.spec.accessModes || []).map((m) => ({ ReadWriteOnce: 'RWO', ReadOnlyMany: 'ROX', ReadWriteMany: 'RWX', ReadWriteOncePod: 'RWOP' }[m])).join(',')}`);
    w.w(0, `VolumeMode:\t${v.spec.volumeMode}`);
    w.w(0, `Capacity:\t${v.spec.capacity.storage}`);
    if (v.spec.nodeAffinity) {
      w.w(0, 'Node Affinity:');
      w.w(1, 'Required Terms:');
      for (const t of v.spec.nodeAffinity.required.nodeSelectorTerms) w.w(2, `Term 0:\t${(t.matchExpressions || []).map((e) => `${e.key} ${e.operator.toLowerCase()} [${(e.values || []).join(' ')}]`).join(', ')}`);
    } else w.w(0, 'Node Affinity:\t<none>');
    w.w(0, `Message:\t${v.status.message || ''}`);
    w.w(0, 'Source:');
    if (v.spec.hostPath) { w.w(1, 'Type:\tHostPath (bare host directory volume)'); w.w(1, `Path:\t${v.spec.hostPath.path}`); w.w(1, `HostPathType:\t${v.spec.hostPath.type || ''}`); }
    else if (v.spec.nfs) { w.w(1, 'Type:\tNFS (an NFS mount that lasts the lifetime of a pod)'); w.w(1, `Server:\t${v.spec.nfs.server}`); w.w(1, `Path:\t${v.spec.nfs.path}`); w.w(1, `ReadOnly:\t${!!v.spec.nfs.readOnly}`); }
    else if (v.spec.local) { w.w(1, 'Type:\tLocalVolume (a persistent volume backed by local storage on a node)'); w.w(1, `Path:\t${v.spec.local.path}`); }
    else if (v.spec.csi) { w.w(1, 'Type:\tCSI (a Container Storage Interface (CSI) volume source)'); w.w(1, `Driver:\t${v.spec.csi.driver}`); w.w(1, `VolumeHandle:\t${v.spec.csi.volumeHandle}`); }
    describeEvents(w, cl, v);
    return w.toString();
  };
  D['storageclasses.storage.k8s.io'] = (s, cl) => {
    const w = new DW();
    w.w(0, `Name:\t${s.metadata.name}`);
    w.w(0, `IsDefaultClass:\t${(s.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true' ? 'Yes' : 'No'}`);
    annotations(w, 0, s.metadata.annotations);
    w.w(0, `Provisioner:\t${s.provisioner}`);
    w.w(0, `Parameters:\t${Object.entries(s.parameters || {}).map(([k, v]) => `${k}=${v}`).join(',') || '<none>'}`);
    w.w(0, `AllowVolumeExpansion:\t${s.allowVolumeExpansion === undefined ? '<unset>' : s.allowVolumeExpansion ? 'True' : 'False'}`);
    w.w(0, `MountOptions:\t${(s.mountOptions || []).join(', ') || '<none>'}`);
    w.w(0, `ReclaimPolicy:\t${s.reclaimPolicy}`);
    w.w(0, `VolumeBindingMode:\t${s.volumeBindingMode}`);
    describeEvents(w, cl, s);
    return w.toString();
  };
  D['ingresses.networking.k8s.io'] = (i, cl) => {
    const w = new DW();
    header(w, i);
    w.map(0, 'Labels', i.metadata.labels);
    const addr = ((i.status.loadBalancer || {}).ingress || []).map((x) => x.ip || x.hostname).join(',');
    w.w(0, `Address:\t${addr}`);
    w.w(0, `Ingress Class:\t${i.spec.ingressClassName || '<none>'}`);
    const be = (b) => {
      if (!b) return '<default>';
      if (b.resource) return `APIGroup: ${b.resource.apiGroup}, Kind: ${b.resource.kind}, Name: ${b.resource.name}`;
      const svc = b.service;
      const port = svc.port.number || svc.port.name;
      let eps = '';
      if (cl) {
        const s = cl.raw(S.byId('services'), i.metadata.namespace, svc.name);
        if (!s) eps = `<error: services "${svc.name}" not found>`;
        else {
          const ep = cl.raw(S.byId('endpoints'), i.metadata.namespace, svc.name);
          const sp = (s.spec.ports || []).find((p) => p.port === svc.port.number || p.name === svc.port.name);
          const ips = [];
          if (ep && sp) for (const sub of ep.subsets || []) { const pp = (sub.ports || []).find((x) => (x.name || '') === (sp.name || '')); if (pp) for (const a of sub.addresses || []) ips.push(`${a.ip}:${pp.port}`); }
          eps = `(${ips.join(',')})`;
        }
      }
      return `${svc.name}:${port} ${eps}`;
    };
    w.w(0, `Default backend:\t${i.spec.defaultBackend ? be(i.spec.defaultBackend) : '<default>'}`);
    if ((i.spec.tls || []).length) {
      w.w(0, 'TLS:');
      for (const t of i.spec.tls) w.w(1, `${t.secretName || 'SNI'} terminates ${(t.hosts || []).join(',')}`);
    }
    w.w(0, 'Rules:');
    w.w(1, 'Host\tPath\tBackends');
    w.w(1, '----\t----\t--------');
    for (const r of i.spec.rules || []) {
      w.w(1, `${r.host || '*'}\t`);
      for (const p of (r.http && r.http.paths) || []) w.w(1, `\t${p.path || '/'}\t${be(p.backend)}`);
    }
    annotations(w, 0, i.metadata.annotations);
    describeEvents(w, cl, i);
    return w.toString();
  };
  D['horizontalpodautoscalers.autoscaling'] = (h, cl) => {
    const w = new DW();
    header(w, h);
    w.map(0, 'Labels', h.metadata.labels);
    annotations(w, 0, h.metadata.annotations);
    w.w(0, `CreationTimestamp:\t${fmtTime(h.metadata.creationTimestamp)}`);
    w.w(0, `Reference:\t${h.spec.scaleTargetRef.kind}/${h.spec.scaleTargetRef.name}`);
    w.w(0, 'Metrics:\t( current / target )');
    (h.spec.metrics || []).forEach((m, i) => {
      const r = m.resource || m.containerResource;
      if (!r) return;
      const cur = (((h.status.currentMetrics || [])[i] || {}).resource || {}).current || {};
      if (r.target.type === 'Utilization') w.w(1, `resource ${r.name} on pods  (as a percentage of request):\t${cur.averageUtilization !== undefined ? `${cur.averageUtilization}% (${cur.averageValue})` : '<unknown>'} / ${r.target.averageUtilization}%`);
      else w.w(1, `resource ${r.name} on pods:\t${cur.averageValue || '<unknown>'} / ${r.target.averageValue}`);
    });
    w.w(0, `Min replicas:\t${h.spec.minReplicas ?? 1}`);
    w.w(0, `Max replicas:\t${h.spec.maxReplicas}`);
    w.w(0, `${h.spec.scaleTargetRef.kind} pods:\t${h.status.currentReplicas || 0} current / ${h.status.desiredReplicas || 0} desired`);
    conditionsTable(w, h.status.conditions, ['Type', 'Status', 'Reason', 'Message']);
    describeEvents(w, cl, h);
    return w.toString();
  };
  const describeRole = (r, cl) => {
    const w = new DW();
    w.w(0, `Name:\t${r.metadata.name}`);
    w.map(0, 'Labels', r.metadata.labels);
    annotations(w, 0, r.metadata.annotations);
    w.w(0, 'PolicyRule:');
    w.w(1, 'Resources\tNon-Resource URLs\tResource Names\tVerbs');
    w.w(1, '---------\t-----------------\t--------------\t-----');
    const rules = cl ? cl.rulesOf(r) : r.rules || [];
    const rows = [];
    for (const rule of rules) {
      for (const res of rule.resources || []) for (const g of rule.apiGroups || ['']) rows.push([g ? `${res}.${g}` : res, '[]', `[${(rule.resourceNames || []).join(' ')}]`, `[${rule.verbs.join(' ')}]`]);
      for (const u of rule.nonResourceURLs || []) rows.push(['', `[${u}]`, '[]', `[${rule.verbs.join(' ')}]`]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const r2 of rows) w.w(1, r2.join('\t'));
    return w.toString();
  };
  D['roles.rbac.authorization.k8s.io'] = describeRole;
  D['clusterroles.rbac.authorization.k8s.io'] = describeRole;
  const describeBinding = (b) => {
    const w = new DW();
    w.w(0, `Name:\t${b.metadata.name}`);
    w.map(0, 'Labels', b.metadata.labels);
    annotations(w, 0, b.metadata.annotations);
    w.w(0, 'Role:');
    w.w(1, `Kind:\t${b.roleRef.kind}`);
    w.w(1, `Name:\t${b.roleRef.name}`);
    w.w(0, 'Subjects:');
    w.w(1, 'Kind\tName\tNamespace');
    w.w(1, '----\t----\t---------');
    for (const s of b.subjects || []) w.w(1, `${s.kind}\t${s.name}\t${s.namespace || ''}`);
    return w.toString();
  };
  D['rolebindings.rbac.authorization.k8s.io'] = describeBinding;
  D['clusterrolebindings.rbac.authorization.k8s.io'] = describeBinding;
  D['networkpolicies.networking.k8s.io'] = (n) => {
    const w = new DW();
    header(w, n);
    w.w(0, `Created on:\t${n.metadata.creationTimestamp.replace('T', ' ').replace('Z', ' +0000 UTC')}`);
    w.map(0, 'Labels', n.metadata.labels);
    annotations(w, 0, n.metadata.annotations);
    w.w(0, 'Spec:');
    const sel = U.selectorString(n.spec.podSelector);
    w.w(1, `PodSelector:\t${sel === '<none>' ? '<none> (Allowing the specific traffic to all pods in this namespace)' : sel}`);
    const peers = (list, dir) => {
      for (const p of list || []) {
        if (p.podSelector && p.namespaceSelector) { w.w(3, `NamespaceSelector: ${U.selectorString(p.namespaceSelector)}`); w.w(3, `PodSelector: ${U.selectorString(p.podSelector)}`); }
        else if (p.podSelector) w.w(3, `PodSelector: ${U.selectorString(p.podSelector)}`);
        else if (p.namespaceSelector) w.w(3, `NamespaceSelector: ${U.selectorString(p.namespaceSelector)}`);
        else if (p.ipBlock) { w.w(3, 'IPBlock:'); w.w(4, `CIDR: ${p.ipBlock.cidr}`); w.w(4, `Except: ${(p.ipBlock.except || []).join(', ')}`); }
      }
      if (!list || !list.length) w.w(3, `${dir}: <any> (traffic not restricted by ${dir === 'From' ? 'source' : 'destination'})`);
    };
    const ports = (list) => {
      if (!list || !list.length) w.w(2, 'To Port: <any> (traffic allowed to all ports)');
      else for (const p of list) w.w(2, `To Port: ${p.port ?? '<any>'}/${p.protocol || 'TCP'}`);
    };
    const types = n.spec.policyTypes || ['Ingress'];
    if (types.includes('Ingress')) {
      if (!(n.spec.ingress || []).length) w.w(1, 'Allowing ingress traffic:'), w.w(2, '<none> (Selected pods are isolated for ingress connectivity)');
      else {
        w.w(1, 'Allowing ingress traffic:');
        n.spec.ingress.forEach((r, i) => { if (i) w.w(2, '----------'); ports(r.ports); w.w(2, 'From:'); peers(r.from, 'From'); });
      }
    } else w.w(1, 'Not affecting ingress traffic');
    if (types.includes('Egress')) {
      if (!(n.spec.egress || []).length) w.w(1, 'Allowing egress traffic:'), w.w(2, '<none> (Selected pods are isolated for egress connectivity)');
      else {
        w.w(1, 'Allowing egress traffic:');
        n.spec.egress.forEach((r, i) => { if (i) w.w(2, '----------'); ports(r.ports); w.w(2, 'To:'); peers(r.to, 'To'); });
      }
    } else w.w(1, 'Not affecting egress traffic');
    w.w(1, `Policy Types: ${types.join(', ')}`);
    return w.toString();
  };
  D['poddisruptionbudgets.policy'] = (p, cl) => {
    const w = new DW();
    header(w, p);
    if (p.spec.minAvailable !== undefined) w.w(0, `Min available:\t${p.spec.minAvailable}`);
    if (p.spec.maxUnavailable !== undefined) w.w(0, `Max unavailable:\t${p.spec.maxUnavailable}`);
    w.w(0, `Selector:\t${U.selectorString(p.spec.selector)}`);
    w.w(0, 'Status:');
    w.w(2, `Allowed disruptions:\t${p.status.disruptionsAllowed || 0}`);
    w.w(2, `Current:\t${p.status.currentHealthy || 0}`);
    w.w(2, `Desired:\t${p.status.desiredHealthy || 0}`);
    w.w(2, `Total:\t${p.status.expectedPods || 0}`);
    describeEvents(w, cl, p);
    return w.toString();
  };
  D.resourcequotas = (q) => {
    const w = new DW();
    header(w, q);
    w.w(0, 'Resource\tUsed\tHard');
    w.w(0, '--------\t----\t----');
    for (const k of Object.keys(q.status.hard || {}).sort()) w.w(0, `${k}\t${(q.status.used || {})[k] ?? '0'}\t${q.status.hard[k]}`);
    return w.toString();
  };
  D.limitranges = (l) => {
    const w = new DW();
    header(w, l);
    w.w(0, 'Type\tResource\tMin\tMax\tDefault Request\tDefault Limit\tMax Limit/Request Ratio');
    w.w(0, '----\t--------\t---\t---\t---------------\t-------------\t-----------------------');
    for (const x of l.spec.limits || []) {
      const keys = new Set([...Object.keys(x.min || {}), ...Object.keys(x.max || {}), ...Object.keys(x.default || {}), ...Object.keys(x.defaultRequest || {})]);
      for (const k of keys) w.w(0, `${x.type}\t${k}\t${(x.min || {})[k] || '-'}\t${(x.max || {})[k] || '-'}\t${(x.defaultRequest || {})[k] || '-'}\t${(x.default || {})[k] || '-'}\t${(x.maxLimitRequestRatio || {})[k] || '-'}`);
    }
    return w.toString();
  };
  D['priorityclasses.scheduling.k8s.io'] = (p) => {
    const w = new DW();
    w.w(0, `Name:\t${p.metadata.name}`);
    w.w(0, `Value:\t${p.value}`);
    w.w(0, `GlobalDefault:\t${!!p.globalDefault}`);
    w.w(0, `PreemptionPolicy:\t${p.preemptionPolicy}`);
    w.w(0, `Description:\t${p.description || ''}`);
    annotations(w, 0, p.metadata.annotations);
    describeEvents(w, null, p);
    return w.toString();
  };
  // describe genérico (CRDs e demais tipos)
  const title = (k) => k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/\bUid\b/, 'UID').replace(/\bApi\b/, 'API').replace(/\bIp\b/, 'IP');
  const genericWalk = (w, level, v) => {
    if (U.isObj(v)) {
      for (const k of Object.keys(v).sort()) {
        const x = v[k];
        if (U.isObj(x) || Array.isArray(x)) {
          if (Array.isArray(x) && x.every((y) => !U.isObj(y) && !Array.isArray(y))) {
            w.w(level, `${title(k)}:`);
            for (const y of x) w.w(level + 1, String(y));
          } else if (Array.isArray(x) && !x.length) w.w(level, `${title(k)}:\t[]`);
          else if (U.isObj(x) && !Object.keys(x).length) w.w(level, `${title(k)}:`);
          else {
            w.w(level, `${title(k)}:`);
            genericWalk(w, level + 1, x);
          }
        } else w.w(level, `${title(k)}:\t${x}`);
      }
    } else if (Array.isArray(v)) {
      for (const it of v) {
        if (U.isObj(it)) {
          const keys = Object.keys(it).sort();
          keys.forEach((k, i) => {
            const x = it[k];
            if (U.isObj(x) || Array.isArray(x)) {
              w.w(level, `${i === 0 ? '' : ''}${title(k)}:`);
              genericWalk(w, level + 1, x);
            } else w.w(level, `${title(k)}:\t${x}`);
          });
        } else w.w(level, String(it));
      }
    }
  };
  P.describeGeneric = (o, cl) => {
    const w = new DW();
    header(w, o);
    w.map(0, 'Labels', o.metadata.labels);
    annotations(w, 0, o.metadata.annotations);
    w.w(0, `API Version:\t${o.apiVersion}`);
    w.w(0, `Kind:\t${o.kind}`);
    const rest = { ...o };
    delete rest.apiVersion;
    delete rest.kind;
    const meta = { ...o.metadata };
    for (const k of ['name', 'namespace', 'labels', 'annotations']) delete meta[k];
    rest.metadata = meta;
    genericWalk(w, 0, rest);
    describeEvents(w, cl, o);
    return w.toString();
  };
  P.describe = (t, o, cl) => {
    KS.currentCluster = cl;
    const f = D[t.id];
    return f ? f(o, cl) : P.describeGeneric(o, cl);
  };
})();
