// Controllers, scheduler, kubelet, rede/DNS, métricas, logs e bootstrap do cluster.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, S = KS.schema, IM = KS.images;
  const C = KS.Cluster.prototype;
  const SYSTEM = KS.SYSTEM;
  const T = (id) => S.byId(id);
  const MiB = 1024 * 1024;

  const stable = (o) => {
    if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
    if (U.isObj(o)) return '{' + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
    return JSON.stringify(o);
  };
  C.stable = stable;
  const setCond = (conds, now, type, status, reason, message, withUpdate) => {
    conds = conds || [];
    const iso = U.iso(now);
    let c = conds.find((x) => x.type === type);
    if (!c) {
      c = { type };
      conds.push(c);
    }
    if (c.status !== status) c.lastTransitionTime = iso;
    if (withUpdate && (c.status !== status || c.reason !== reason || c.message !== message)) c.lastUpdateTime = iso;
    c.status = status;
    if (reason !== undefined) c.reason = reason;
    else delete c.reason;
    if (message !== undefined) c.message = message;
    else delete c.message;
    return conds;
  };
  const omitZero = (o) => {
    for (const k of Object.keys(o)) if (o[k] === 0 || o[k] === undefined) delete o[k];
    return o;
  };

  // ---------- helpers ----------
  C.isReady = (p) => (p.status.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
  C.isActive = (p) => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed';
  C.ownerRef = (o) => ({ apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name, uid: o.metadata.uid, controller: true, blockOwnerDeletion: true });
  C.controlledBy = function (t, ns, owner) {
    return this.rawList(t, ns).filter((o) => (o.metadata.ownerReferences || []).some((r) => r.uid === owner.metadata.uid && r.controller));
  };
  C.podRequests = (p) => {
    let cpu = 0, mem = 0;
    for (const c of p.spec.containers || []) {
      const r = (c.resources && c.resources.requests) || {};
      cpu += U.cpuMilli(r.cpu || 0);
      mem += U.parseQuantity(r.memory || 0);
    }
    for (const c of p.spec.initContainers || []) {
      const r = (c.resources && c.resources.requests) || {};
      cpu = Math.max(cpu, U.cpuMilli(r.cpu || 0));
      mem = Math.max(mem, U.parseQuantity(r.memory || 0));
    }
    return { cpu, mem };
  };
  C.podLimits = (p) => {
    let cpu = 0, mem = 0;
    for (const c of p.spec.containers || []) {
      const r = (c.resources && c.resources.limits) || {};
      cpu += U.cpuMilli(r.cpu || 0);
      mem += U.parseQuantity(r.memory || 0);
    }
    return { cpu, mem };
  };
  C.podsOnNode = function (node) {
    return this.rawList(T('pods')).filter((p) => p.spec.nodeName === node && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
  };
  C.nodeAllocated = function (node) {
    let cpu = 0, mem = 0, n = 0, lcpu = 0, lmem = 0;
    for (const p of this.podsOnNode(node)) {
      const r = this.podRequests(p);
      const l = this.podLimits(p);
      cpu += r.cpu;
      mem += r.mem;
      lcpu += l.cpu;
      lmem += l.mem;
      n++;
    }
    return { cpu, mem, pods: n, lcpu, lmem };
  };
  C.nodeCap = (n) => ({
    cpu: U.cpuMilli(n.status.allocatable.cpu),
    mem: U.parseQuantity(n.status.allocatable.memory),
    pods: Number(n.status.allocatable.pods),
  });

  // ---------- loop principal ----------
  const CTRL = ['ctlNamespaces', 'ctlGC', 'ctlDeployments', 'ctlReplicaSets', 'ctlRCs', 'ctlStatefulSets', 'ctlDaemonSets', 'ctlCronJobs', 'ctlJobs', 'ctlTTL', 'ctlPV', 'scheduler', 'kubelets', 'ctlEndpoints', 'ctlServices', 'ctlIngress', 'ctlHPA', 'ctlNodeLifecycle', 'ctlPDB', 'ctlQuota', 'ctlCSR', 'ctlEventsGC'];
  const ALWAYS = new Set(['kubelets', 'scheduler', 'ctlEventsGC']);
  // componentes do control plane rodam como pods estáticos; se o pod cair, o componente para
  C.componentUp = function (comp) {
    const list = this.misc.staticPods;
    if (!list) return true;
    if (!list.some((sp) => (sp.metadata.labels || {}).component === comp)) return false;
    const p = this.raw(T('pods'), 'kube-system', `${comp}-sim-control-plane`);
    return !!p && p.status.phase === 'Running' && (p.status.containerStatuses || []).every((c) => c.ready);
  };
  C.tick = function () {
    this.misc.tickN = (this.misc.tickN || 0) + 1;
    const kcm = this.componentUp('kube-controller-manager');
    this.schedUp = this.componentUp('kube-scheduler');
    for (const c of CTRL) {
      if (!kcm && !ALWAYS.has(c)) continue;
      if (c === 'scheduler' && !this.schedUp) continue;
      try {
        this[c]();
      } catch (e) {
        if (globalThis.console) console.error('[controller ' + c + ']', e);
      }
    }
  };

  // ---------- namespaces ----------
  C.ctlNamespaces = function () {
    const nsT = T('namespaces');
    for (const ns of this.rawList(nsT)) {
      const name = ns.metadata.name;
      if (ns.status.phase === 'Active') {
        if (!this.raw(T('serviceaccounts'), name, 'default') || !this.raw(T('configmaps'), name, 'kube-root-ca.crt')) this.ensureNamespaceDefaults(ns);
        continue;
      }
      let remaining = 0;
      for (const t of S.types) {
        if (!t.namespaced || t.group === 'metrics.k8s.io' || (t.group === 'events.k8s.io')) continue;
        for (const o of this.rawList(t, name)) {
          remaining++;
          if (!o.metadata.deletionTimestamp) {
            try {
              this.delete(t, name, o.metadata.name, {}, SYSTEM);
            } catch (e) { /* ignora */ }
          }
        }
      }
      if (!remaining) this.removeRaw(nsT, ns);
    }
  };

  // ---------- garbage collector ----------
  C.ctlGC = function () {
    const uids = new Set();
    const all = [];
    for (const t of S.types) {
      if (t.group === 'metrics.k8s.io' || t.group === 'events.k8s.io') continue;
      for (const o of Object.values(this.data[t.id] || {})) {
        uids.add(o.metadata.uid);
        all.push([t, o]);
      }
    }
    const nodes = new Set(this.rawList(T('nodes')).map((n) => n.metadata.name));
    const pvcT = T('persistentvolumeclaims'), pvT = T('persistentvolumes'), pT = T('pods');
    for (const [t, o] of all) {
      const refs = o.metadata.ownerReferences;
      if (refs && refs.length && !o.metadata.deletionTimestamp) {
        const alive = refs.filter((r) => uids.has(r.uid));
        if (!alive.length) {
          try {
            this.delete(t, o.metadata.namespace, o.metadata.name, {}, SYSTEM);
          } catch (e) { /* já removido */ }
          continue;
        }
      }
      if (o.metadata.deletionTimestamp) {
        const fins = o.metadata.finalizers || [];
        if (fins.includes('foregroundDeletion')) {
          const deps = this.dependents(o);
          if (deps.length) {
            for (const [dt, d] of deps) if (!d.metadata.deletionTimestamp) { try { this.delete(dt, d.metadata.namespace, d.metadata.name, { propagationPolicy: 'Foreground' }, SYSTEM); } catch (e) { /* */ } }
          } else {
            o.metadata.finalizers = fins.filter((f) => f !== 'foregroundDeletion');
            if (!o.metadata.finalizers.length) delete o.metadata.finalizers;
            this.put(t, o);
          }
        }
        if (t === pvcT && fins.includes('kubernetes.io/pvc-protection')) {
          const inUse = this.rawList(pT, o.metadata.namespace).some((p) => (p.spec.volumes || []).some((v) => v.persistentVolumeClaim && v.persistentVolumeClaim.claimName === o.metadata.name) && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
          if (!inUse) {
            o.metadata.finalizers = fins.filter((f) => f !== 'kubernetes.io/pvc-protection');
            this.put(t, o);
          }
        }
        if (t === pvT && fins.includes('kubernetes.io/pv-protection') && o.status.phase !== 'Bound') {
          o.metadata.finalizers = fins.filter((f) => f !== 'kubernetes.io/pv-protection');
          this.put(t, o);
        }
        if (t !== pT && t.id !== 'namespaces' && !(o.metadata.finalizers || []).length) this.removeRaw(t, o);
      }
      if (t === pT && o.spec.nodeName && !nodes.has(o.spec.nodeName)) this.removeRaw(t, o);
    }
  };

  // ---------- Deployment ----------
  C.tplHash = function (tpl) {
    const c = U.clone(tpl);
    if (c.metadata && c.metadata.labels) delete c.metadata.labels['pod-template-hash'];
    return U.safeHash(stable(c)).slice(0, 10);
  };
  C.scaleRS = function (d, rs, n, now) {
    const from = rs.spec.replicas;
    if (from === n) return;
    rs.spec.replicas = n;
    rs.metadata.annotations = { ...(rs.metadata.annotations || {}), 'deployment.kubernetes.io/desired-replicas': String(d.spec.replicas) };
    this.put(T('replicasets.apps'), rs);
    this.event(d, 'Normal', 'ScalingReplicaSet', `Scaled ${n > from ? 'up' : 'down'} replica set ${rs.metadata.name} from ${from} to ${n}`, 'deployment-controller');
    this.misc.progress = this.misc.progress || {};
    this.misc.progress[d.metadata.uid] = now;
  };
  C.ctlDeployments = function () {
    const dT = T('deployments.apps'), rsT = T('replicasets.apps'), pT = T('pods');
    const now = this.now();
    this.misc.progress = this.misc.progress || {};
    for (const d of this.rawList(dT)) {
      if (d.metadata.deletionTimestamp) continue;
      const ns = d.metadata.namespace;
      const before = JSON.stringify(d);
      let rss = this.controlledBy(rsT, ns, d);
      // adoção de ReplicaSets órfãos (ex.: após --cascade=orphan)
      for (const rs of this.rawList(rsT, ns)) {
        if (rss.includes(rs) || (rs.metadata.ownerReferences || []).some((r) => r.controller)) continue;
        if (U.matchSelector(d.spec.selector, (rs.spec.template.metadata || {}).labels) && rs.spec.template && this.tplHash(rs.spec.template)) {
          rs.metadata.ownerReferences = [this.ownerRef(d)];
          this.put(rsT, rs);
          rss.push(rs);
        }
      }
      const hash = this.tplHash(d.spec.template);
      let newRS = rss.find((rs) => this.tplHash(rs.spec.template) === hash);
      const rev = (rs) => Number((rs.metadata.annotations || {})['deployment.kubernetes.io/revision'] || 0);
      const maxRev = rss.reduce((m, rs) => Math.max(m, rev(rs)), 0);
      const replicas = d.spec.replicas;
      const ru = (d.spec.strategy && d.spec.strategy.rollingUpdate) || {};
      const surge = d.spec.strategy.type === 'Recreate' ? 0 : U.intOrPercent(ru.maxSurge, replicas, true);
      let unav = d.spec.strategy.type === 'Recreate' ? 0 : U.intOrPercent(ru.maxUnavailable, replicas, false);
      if (!surge && !unav && d.spec.strategy.type !== 'Recreate') unav = 1;
      const cause = (d.metadata.annotations || {})['kubernetes.io/change-cause'];
      d.status = d.status || {};
      let conds = d.status.conditions || [];
      if (!newRS && !d.spec.paused) {
        const tpl = U.clone(d.spec.template);
        tpl.metadata = tpl.metadata || {};
        tpl.metadata.labels = { ...(tpl.metadata.labels || {}), 'pod-template-hash': hash };
        const anns = {
          'deployment.kubernetes.io/desired-replicas': String(replicas),
          'deployment.kubernetes.io/max-replicas': String(replicas + surge),
          'deployment.kubernetes.io/revision': String(maxRev + 1),
        };
        if (cause) anns['kubernetes.io/change-cause'] = cause;
        const sel = U.clone(d.spec.selector);
        sel.matchLabels = { ...(sel.matchLabels || {}), 'pod-template-hash': hash };
        try {
          newRS = this.raw(rsT, ns, `${d.metadata.name}-${hash}`);
          if (!newRS) {
            this.create({
              apiVersion: 'apps/v1', kind: 'ReplicaSet',
              metadata: { name: `${d.metadata.name}-${hash}`, namespace: ns, labels: { ...tpl.metadata.labels }, annotations: anns, ownerReferences: [this.ownerRef(d)] },
              spec: { replicas: 0, minReadySeconds: d.spec.minReadySeconds || undefined, selector: sel, template: tpl },
            }, SYSTEM);
            newRS = this.raw(rsT, ns, `${d.metadata.name}-${hash}`);
            conds = setCond(conds, now, 'Progressing', 'True', 'NewReplicaSetCreated', `Created new replica set "${newRS.metadata.name}"`, true);
            this.misc.progress[d.metadata.uid] = now;
          }
        } catch (e) {
          conds = setCond(conds, now, 'ReplicaFailure', 'True', 'FailedCreate', e.message, true);
        }
        rss = this.controlledBy(rsT, ns, d);
      } else if (newRS && rev(newRS) < maxRev) {
        // rollback para um template antigo: vira a nova revisão
        const old = rev(newRS);
        const hist = (newRS.metadata.annotations || {})['deployment.kubernetes.io/revision-history'];
        newRS.metadata.annotations = {
          ...(newRS.metadata.annotations || {}),
          'deployment.kubernetes.io/revision': String(maxRev + 1),
          'deployment.kubernetes.io/revision-history': hist ? `${hist},${old}` : String(old),
        };
        if (cause) newRS.metadata.annotations['kubernetes.io/change-cause'] = cause;
        this.put(rsT, newRS);
        this.misc.progress[d.metadata.uid] = now;
      }
      const oldRSs = rss.filter((rs) => rs !== newRS).sort((a, b) => rev(a) - rev(b));
      if (newRS) {
        d.metadata.annotations = { ...(d.metadata.annotations || {}), 'deployment.kubernetes.io/revision': String(rev(newRS)) };
      }
      if (!d.spec.paused && newRS) {
        if (d.spec.strategy.type === 'Recreate') {
          const oldActive = oldRSs.filter((rs) => rs.spec.replicas > 0);
          for (const rs of oldActive) this.scaleRS(d, rs, 0, now);
          const oldPods = oldRSs.reduce((n, rs) => n + this.controlledBy(pT, ns, rs).length, 0);
          if (!oldActive.length && !oldPods) this.scaleRS(d, newRS, replicas, now);
        } else {
          const total = () => rss.reduce((n, rs) => n + rs.spec.replicas, 0);
          if (newRS.spec.replicas > replicas) this.scaleRS(d, newRS, replicas, now);
          else if (newRS.spec.replicas < replicas) {
            const allowed = replicas + surge - total();
            const up = Math.min(allowed, replicas - newRS.spec.replicas);
            if (up > 0) this.scaleRS(d, newRS, newRS.spec.replicas + up, now);
          }
          const oldWith = oldRSs.filter((rs) => rs.spec.replicas > 0);
          if (oldWith.length) {
            const minAvailable = replicas - unav;
            const newUnavail = newRS.spec.replicas - (newRS.status.availableReplicas || 0);
            let cleanup = total() - minAvailable - newUnavail;
            for (const rs of oldWith) {
              const unhealthy = rs.spec.replicas - (rs.status.availableReplicas || 0);
              if (unhealthy > 0 && cleanup > 0) {
                const dn = Math.min(unhealthy, cleanup);
                this.scaleRS(d, rs, rs.spec.replicas - dn, now);
                cleanup -= dn;
              }
            }
            const available = rss.reduce((n, rs) => n + Math.min(rs.status.availableReplicas || 0, rs.spec.replicas), 0);
            let can = available - minAvailable;
            for (const rs of oldWith) {
              if (can <= 0) break;
              if (rs.spec.replicas <= 0) continue;
              const dn = Math.min(rs.spec.replicas, can);
              this.scaleRS(d, rs, rs.spec.replicas - dn, now);
              can -= dn;
            }
          }
        }
      }
      // limpeza do histórico
      const idle = oldRSs.filter((rs) => rs.spec.replicas === 0 && !(rs.status.replicas > 0));
      const limit = d.spec.revisionHistoryLimit ?? 10;
      while (idle.length > limit) {
        const rs = idle.shift();
        try { this.delete(rsT, ns, rs.metadata.name, {}, SYSTEM); } catch (e) { /* */ }
      }
      // status
      rss = this.controlledBy(rsT, ns, d);
      const sum = (f) => rss.reduce((n, rs) => n + (rs.status[f] || 0), 0);
      const available = sum('availableReplicas');
      const updated = newRS ? newRS.status.replicas || 0 : 0;
      const st = {
        observedGeneration: d.metadata.generation,
        replicas: sum('replicas'),
        updatedReplicas: updated,
        readyReplicas: sum('readyReplicas'),
        availableReplicas: available,
        unavailableReplicas: Math.max(0, replicas - available),
      };
      omitZero(st);
      st.observedGeneration = d.metadata.generation;
      conds = setCond(conds, now, 'Available', available >= replicas - unav ? 'True' : 'False', available >= replicas - unav ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', available >= replicas - unav ? 'Deployment has minimum availability.' : 'Deployment does not have minimum availability.', true);
      const complete = newRS && updated === replicas && (newRS.status.availableReplicas || 0) >= replicas && sum('replicas') === replicas;
      const prog = conds.find((c) => c.type === 'Progressing');
      if (d.spec.paused) conds = setCond(conds, now, 'Progressing', 'Unknown', 'DeploymentPaused', 'Deployment is paused', true);
      else if (complete) conds = setCond(conds, now, 'Progressing', 'True', 'NewReplicaSetAvailable', `ReplicaSet "${newRS.metadata.name}" has successfully progressed.`, true);
      else if (newRS) {
        const last = this.misc.progress[d.metadata.uid] || U.ms(d.metadata.creationTimestamp);
        const sig = `${updated}/${newRS.status.availableReplicas || 0}/${sum('replicas')}`;
        if (this.misc['psig' + d.metadata.uid] !== sig) {
          this.misc['psig' + d.metadata.uid] = sig;
          this.misc.progress[d.metadata.uid] = now;
        }
        if (now - last > (d.spec.progressDeadlineSeconds || 600) * 1000) {
          if (!prog || prog.reason !== 'ProgressDeadlineExceeded') this.event(d, 'Warning', 'ProgressDeadlineExceeded', `Deployment "${d.metadata.name}" has timed out progressing.`, 'deployment-controller');
          conds = setCond(conds, now, 'Progressing', 'False', 'ProgressDeadlineExceeded', `ReplicaSet "${newRS.metadata.name}" has timed out progressing.`, true);
        } else if (!prog || prog.reason !== 'NewReplicaSetCreated' || now - U.ms(prog.lastUpdateTime) > 1000)
          conds = setCond(conds, now, 'Progressing', 'True', 'ReplicaSetUpdated', `ReplicaSet "${newRS.metadata.name}" is progressing.`, true);
      }
      conds.sort((a, b) => ['Available', 'Progressing', 'ReplicaFailure'].indexOf(a.type) - ['Available', 'Progressing', 'ReplicaFailure'].indexOf(b.type));
      st.conditions = conds;
      d.status = st;
      this.saveIfChanged(dT, d, before);
    }
  };

  // ---------- ReplicaSet / RC ----------
  C.podFromTemplate = function (owner, tpl, ns, name) {
    const meta = {
      namespace: ns,
      labels: { ...((tpl.metadata && tpl.metadata.labels) || {}) },
      ownerReferences: [this.ownerRef(owner)],
    };
    if (name) meta.name = name;
    else meta.generateName = owner.metadata.name + '-';
    if (tpl.metadata && tpl.metadata.annotations) meta.annotations = { ...tpl.metadata.annotations };
    return { apiVersion: 'v1', kind: 'Pod', metadata: meta, spec: U.clone(tpl.spec) };
  };
  C.syncReplicas = function (t, rs, matches, component) {
    const pT = T('pods');
    const ns = rs.metadata.namespace;
    const now = this.now();
    if (rs.metadata.deletionTimestamp) return;
    const before = JSON.stringify(rs);
    let pods = this.controlledBy(pT, ns, rs);
    for (const p of this.rawList(pT, ns)) {
      if (pods.includes(p) || !this.isActive(p)) continue;
      if ((p.metadata.ownerReferences || []).some((r) => r.controller)) continue;
      if (matches(p.metadata.labels || {})) {
        p.metadata.ownerReferences = [...(p.metadata.ownerReferences || []), this.ownerRef(rs)];
        this.put(pT, p);
        pods.push(p);
      }
    }
    const active = pods.filter((p) => this.isActive(p));
    const diff = rs.spec.replicas - active.length;
    let conds = rs.status.conditions;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) {
        try {
          const created = this.create(this.podFromTemplate(rs, rs.spec.template, ns), SYSTEM);
          this.event(rs, 'Normal', 'SuccessfulCreate', `Created pod: ${created.metadata.name}`, component);
          conds = (conds || []).filter((c) => c.type !== 'ReplicaFailure');
        } catch (e) {
          if (!this.misc['fc' + rs.metadata.uid] || now - this.misc['fc' + rs.metadata.uid] > 15000) {
            this.misc['fc' + rs.metadata.uid] = now;
            this.event(rs, 'Warning', 'FailedCreate', `Error creating: ${e.message}`, component);
          }
          conds = setCond(conds, now, 'ReplicaFailure', 'True', 'FailedCreate', e.message);
          break;
        }
      }
    } else if (diff < 0) {
      const rank = (p) => [
        p.spec.nodeName ? 1 : 0,
        { Pending: 0, Unknown: 1, Running: 2 }[p.status.phase] ?? 0,
        this.isReady(p) ? 1 : 0,
        -((p.status.containerStatuses || []).reduce((n, c) => n + c.restartCount, 0)),
        -U.ms(p.metadata.creationTimestamp),
      ];
      const sorted = active.slice().sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
        return 0;
      });
      for (const p of sorted.slice(0, -diff)) {
        try {
          this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          this.event(rs, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`, component);
        } catch (e) { /* */ }
      }
    }
    pods = this.controlledBy(pT, ns, rs).filter((p) => !p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
    const minReady = (rs.spec.minReadySeconds || 0) * 1000;
    const ready = pods.filter((p) => this.isReady(p));
    const avail = ready.filter((p) => {
      const c = (p.status.conditions || []).find((x) => x.type === 'Ready');
      return now - U.ms(c.lastTransitionTime) >= minReady;
    });
    const st = {
      replicas: pods.length,
      fullyLabeledReplicas: pods.filter((p) => matches(p.metadata.labels || {})).length,
      readyReplicas: ready.length,
      availableReplicas: avail.length,
      observedGeneration: rs.metadata.generation,
    };
    omitZero(st);
    st.replicas = pods.length;
    st.observedGeneration = rs.metadata.generation;
    if (conds && conds.length) st.conditions = conds;
    rs.status = st;
    this.saveIfChanged(t, rs, before);
  };
  C.ctlReplicaSets = function () {
    const t = T('replicasets.apps');
    for (const rs of this.rawList(t)) {
      const reqs = U.selectorReqs(rs.spec.selector);
      this.syncReplicas(t, rs, (l) => U.matchReqs(reqs, l), 'replicaset-controller');
    }
  };
  C.ctlRCs = function () {
    const t = T('replicationcontrollers');
    for (const rc of this.rawList(t)) {
      const sel = rc.spec.selector || {};
      this.syncReplicas(t, rc, (l) => Object.entries(sel).every(([k, v]) => l[k] === v), 'replication-controller');
    }
  };

  // ---------- ControllerRevision ----------
  C.ensureRevision = function (owner, tpl, extraData) {
    const crT = T('controllerrevisions.apps');
    const ns = owner.metadata.namespace;
    const hash = U.safeHash(stable(tpl)).slice(0, 10);
    const name = `${owner.metadata.name}-${hash}`;
    const mine = this.controlledBy(crT, ns, owner);
    const maxRev = mine.reduce((m, r) => Math.max(m, r.revision), 0);
    let cr = this.raw(crT, ns, name);
    if (!cr) {
      const labels = { ...((tpl.metadata && tpl.metadata.labels) || {}) };
      labels['controller-revision-hash'] = hash;
      this.put(crT, {
        apiVersion: 'apps/v1', kind: 'ControllerRevision',
        metadata: { name, namespace: ns, uid: U.uid(), creationTimestamp: U.iso(this.now()), labels, ownerReferences: [this.ownerRef(owner)], annotations: extraData || undefined },
        data: { spec: { template: { $patch: 'replace', ...U.clone(tpl) } } },
        revision: maxRev + 1,
      }, 'ADDED');
      if (!extraData) delete this.raw(crT, ns, name).metadata.annotations;
    } else if (cr.revision < maxRev) {
      cr.revision = maxRev + 1;
      this.put(crT, cr);
    }
    const all = this.controlledBy(crT, ns, owner).sort((a, b) => a.revision - b.revision);
    const limit = owner.spec.revisionHistoryLimit ?? 10;
    while (all.length > limit + 1) {
      const old = all.shift();
      if (old.metadata.name !== name) this.removeRaw(crT, old);
    }
    return { name, hash };
  };

  // ---------- StatefulSet ----------
  C.ctlStatefulSets = function () {
    const sT = T('statefulsets.apps'), pT = T('pods'), pvcT = T('persistentvolumeclaims');
    for (const s of this.rawList(sT)) {
      if (s.metadata.deletionTimestamp) continue;
      const ns = s.metadata.namespace;
      const before = JSON.stringify(s);
      const revInfo = this.ensureRevision(s, s.spec.template);
      const rev = revInfo.name;
      const start = (s.spec.ordinals && s.spec.ordinals.start) || 0;
      const n = s.spec.replicas;
      const parallel = s.spec.podManagementPolicy === 'Parallel';
      const pods = this.controlledBy(pT, ns, s);
      const byOrd = {};
      for (const p of pods) {
        const m = p.metadata.name.match(/-(\d+)$/);
        if (m) byOrd[Number(m[1])] = p;
      }
      const ready = (p) => p && this.isReady(p) && !p.metadata.deletionTimestamp;
      let blocked = false;
      for (let i = start; i < start + n; i++) {
        const p = byOrd[i];
        const pname = `${s.metadata.name}-${i}`;
        if (!p) {
          if (blocked) break;
          // PVCs
          let ok = true;
          for (const vct of s.spec.volumeClaimTemplates || []) {
            const cname = `${vct.metadata.name}-${pname}`;
            if (!this.raw(pvcT, ns, cname)) {
              try {
                this.create({
                  apiVersion: 'v1', kind: 'PersistentVolumeClaim',
                  metadata: { name: cname, namespace: ns, labels: { ...((s.spec.selector && s.spec.selector.matchLabels) || {}), ...((vct.metadata && vct.metadata.labels) || {}) } },
                  spec: U.clone(vct.spec),
                }, SYSTEM);
                this.event(s, 'Normal', 'SuccessfulCreate', `create Claim ${cname} Pod ${pname} in StatefulSet ${s.metadata.name} success`, 'statefulset-controller');
              } catch (e) {
                this.event(s, 'Warning', 'FailedCreate', `create Claim ${cname} for Pod ${pname} in StatefulSet ${s.metadata.name} failed error: ${e.message}`, 'statefulset-controller');
                ok = false;
              }
            }
          }
          if (!ok) break;
          const pod = this.podFromTemplate(s, s.spec.template, ns, pname);
          pod.metadata.labels = { ...pod.metadata.labels, 'apps.kubernetes.io/pod-index': String(i), 'controller-revision-hash': rev, 'statefulset.kubernetes.io/pod-name': pname };
          pod.spec.hostname = pname;
          if (s.spec.serviceName) pod.spec.subdomain = s.spec.serviceName;
          pod.spec.volumes = pod.spec.volumes || [];
          for (const vct of s.spec.volumeClaimTemplates || []) {
            if (!pod.spec.volumes.some((v) => v.name === vct.metadata.name)) pod.spec.volumes.push({ name: vct.metadata.name, persistentVolumeClaim: { claimName: `${vct.metadata.name}-${pname}` } });
          }
          try {
            this.create(pod, SYSTEM);
            this.event(s, 'Normal', 'SuccessfulCreate', `create Pod ${pname} in StatefulSet ${s.metadata.name} successful`, 'statefulset-controller');
          } catch (e) {
            this.event(s, 'Warning', 'FailedCreate', `create Pod ${pname} in StatefulSet ${s.metadata.name} failed error: ${e.message}`, 'statefulset-controller');
          }
          if (!parallel) blocked = true;
          continue;
        }
        if (p.metadata.deletionTimestamp) { if (!parallel) blocked = true; continue; }
        if (p.status.phase === 'Failed' || p.status.phase === 'Succeeded') {
          this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          this.event(s, 'Normal', 'SuccessfulDelete', `delete Pod ${p.metadata.name} in StatefulSet ${s.metadata.name} successful`, 'statefulset-controller');
          if (!parallel) blocked = true;
          continue;
        }
        if (!parallel && !ready(p)) blocked = true;
      }
      // scale down
      const extra = Object.keys(byOrd).map(Number).filter((i) => i >= start + n || i < start).sort((a, b) => b - a);
      if (extra.length) {
        const terminating = extra.some((i) => byOrd[i].metadata.deletionTimestamp);
        const allLowerReady = Object.keys(byOrd).map(Number).filter((i) => i >= start && i < start + n).every((i) => ready(byOrd[i]));
        for (const i of extra) {
          const p = byOrd[i];
          if (p.metadata.deletionTimestamp) continue;
          if (!parallel && (terminating || !allLowerReady)) break;
          this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          this.event(s, 'Normal', 'SuccessfulDelete', `delete Pod ${p.metadata.name} in StatefulSet ${s.metadata.name} successful`, 'statefulset-controller');
          if (!parallel) break;
        }
      }
      // rolling update
      if ((s.spec.updateStrategy || {}).type === 'RollingUpdate' && !extra.length) {
        const partition = (s.spec.updateStrategy.rollingUpdate || {}).partition || 0;
        const inRange = Object.keys(byOrd).map(Number).filter((i) => i >= start && i < start + n);
        const allReady = inRange.length === n && inRange.every((i) => ready(byOrd[i]));
        if (allReady) {
          const outdated = inRange.filter((i) => i >= partition && byOrd[i].metadata.labels['controller-revision-hash'] !== rev).sort((a, b) => b - a);
          if (outdated.length) {
            const p = byOrd[outdated[0]];
            this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
            this.event(s, 'Normal', 'SuccessfulDelete', `delete Pod ${p.metadata.name} in StatefulSet ${s.metadata.name} successful`, 'statefulset-controller');
          }
        }
      }
      const cur = this.controlledBy(pT, ns, s).filter((p) => !p.metadata.deletionTimestamp);
      const updated = cur.filter((p) => p.metadata.labels['controller-revision-hash'] === rev).length;
      const st = {
        availableReplicas: cur.filter((p) => this.isReady(p)).length,
        collisionCount: 0,
        currentReplicas: 0,
        currentRevision: s.status.currentRevision || rev,
        observedGeneration: s.metadata.generation,
        readyReplicas: cur.filter((p) => this.isReady(p)).length,
        replicas: cur.length,
        updateRevision: rev,
        updatedReplicas: updated,
      };
      if (updated === n && cur.length === n) st.currentRevision = rev;
      st.currentReplicas = cur.filter((p) => p.metadata.labels['controller-revision-hash'] === st.currentRevision).length;
      for (const k of ['currentReplicas', 'readyReplicas', 'updatedReplicas']) if (!st[k]) delete st[k];
      s.status = st;
      this.saveIfChanged(sT, s, before);
    }
  };

  // ---------- DaemonSet ----------
  C.tolerates = function (tolerations, taint) {
    return (tolerations || []).some((t) => {
      if (t.effect && t.effect !== taint.effect) return false;
      if (!t.key && t.operator === 'Exists') return true;
      if (t.key !== taint.key) return false;
      if (t.operator === 'Exists') return true;
      return (t.value || '') === (taint.value || '');
    });
  };
  C.nodeAffinityMatch = function (affinity, node) {
    const req = affinity && affinity.nodeAffinity && affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    if (!req) return true;
    return (req.nodeSelectorTerms || []).some((term) => {
      const exprOk = (term.matchExpressions || []).every((e) => this.exprMatch(e, (node.metadata.labels || {})[e.key], e.key in (node.metadata.labels || {})));
      const fieldOk = (term.matchFields || []).every((e) => this.exprMatch(e, e.key === 'metadata.name' ? node.metadata.name : undefined, e.key === 'metadata.name'));
      return exprOk && fieldOk;
    });
  };
  C.exprMatch = (e, v, has) => {
    switch (e.operator) {
      case 'In': return has && (e.values || []).includes(v);
      case 'NotIn': return !has || !(e.values || []).includes(v);
      case 'Exists': return has;
      case 'DoesNotExist': return !has;
      case 'Gt': return has && Number(v) > Number(e.values[0]);
      case 'Lt': return has && Number(v) < Number(e.values[0]);
    }
    return false;
  };
  const DS_TOLERATIONS = [
    { effect: 'NoExecute', key: 'node.kubernetes.io/not-ready', operator: 'Exists' },
    { effect: 'NoExecute', key: 'node.kubernetes.io/unreachable', operator: 'Exists' },
    { effect: 'NoSchedule', key: 'node.kubernetes.io/disk-pressure', operator: 'Exists' },
    { effect: 'NoSchedule', key: 'node.kubernetes.io/memory-pressure', operator: 'Exists' },
    { effect: 'NoSchedule', key: 'node.kubernetes.io/pid-pressure', operator: 'Exists' },
    { effect: 'NoSchedule', key: 'node.kubernetes.io/unschedulable', operator: 'Exists' },
  ];
  C.ctlDaemonSets = function () {
    const dsT = T('daemonsets.apps'), pT = T('pods'), nT = T('nodes');
    const nodes = this.rawList(nT);
    for (const ds of this.rawList(dsT)) {
      if (ds.metadata.deletionTimestamp) continue;
      const ns = ds.metadata.namespace;
      const before = JSON.stringify(ds);
      const { hash } = this.ensureRevision(ds, ds.spec.template);
      const tpl = ds.spec.template;
      const tols = [...(tpl.spec.tolerations || []), ...DS_TOLERATIONS];
      const eligible = nodes.filter((n) => {
        if ((n.spec.taints || []).some((tt) => (tt.effect === 'NoSchedule' || tt.effect === 'NoExecute') && !this.tolerates(tols, tt))) return false;
        if (Object.entries(tpl.spec.nodeSelector || {}).some(([k, v]) => (n.metadata.labels || {})[k] !== v)) return false;
        return this.nodeAffinityMatch(tpl.spec.affinity, n);
      });
      const pods = this.controlledBy(pT, ns, ds);
      const nodeOf = (p) => p.spec.nodeName || (((((p.spec.affinity || {}).nodeAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || {}).nodeSelectorTerms || [])[0] || { matchFields: [{ values: [] }] }).matchFields?.[0]?.values?.[0];
      const byNode = {};
      for (const p of pods) {
        if (p.metadata.deletionTimestamp) continue;
        const nn = nodeOf(p);
        (byNode[nn] = byNode[nn] || []).push(p);
      }
      for (const n of eligible) {
        const name = n.metadata.name;
        const list = (byNode[name] || []).filter((p) => p.status.phase !== 'Failed');
        if (!list.length) {
          const pod = this.podFromTemplate(ds, tpl, ns);
          pod.metadata.labels = { ...pod.metadata.labels, 'controller-revision-hash': hash, 'pod-template-generation': String(ds.metadata.generation || 1) };
          pod.spec.tolerations = [...(pod.spec.tolerations || [])];
          for (const t of DS_TOLERATIONS) if (!pod.spec.tolerations.some((x) => x.key === t.key && x.effect === t.effect)) pod.spec.tolerations.push({ ...t });
          const aff = pod.spec.affinity || {};
          aff.nodeAffinity = { ...(aff.nodeAffinity || {}), requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [name] }] }] } };
          pod.spec.affinity = aff;
          try {
            const c = this.create(pod, SYSTEM);
            this.event(ds, 'Normal', 'SuccessfulCreate', `Created pod: ${c.metadata.name}`, 'daemonset-controller');
          } catch (e) {
            this.event(ds, 'Warning', 'FailedCreate', `Error creating: ${e.message}`, 'daemonset-controller');
          }
        } else if (list.length > 1) {
          for (const p of list.slice(1)) this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
        }
        const failed = (byNode[name] || []).filter((p) => p.status.phase === 'Failed');
        for (const p of failed) this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
      }
      const eligibleNames = new Set(eligible.map((n) => n.metadata.name));
      for (const [nn, list] of Object.entries(byNode)) {
        if (eligibleNames.has(nn)) continue;
        for (const p of list) {
          this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          this.event(ds, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`, 'daemonset-controller');
        }
      }
      // rolling update
      const live = this.controlledBy(pT, ns, ds).filter((p) => !p.metadata.deletionTimestamp);
      if ((ds.spec.updateStrategy || {}).type === 'RollingUpdate') {
        const maxU = U.intOrPercent((ds.spec.updateStrategy.rollingUpdate || {}).maxUnavailable ?? 1, eligible.length, true) || 1;
        const unavailable = eligible.length - live.filter((p) => this.isReady(p)).length;
        const outdated = live.filter((p) => p.metadata.labels['controller-revision-hash'] !== hash);
        let budget = maxU - unavailable;
        const terminating = this.controlledBy(pT, ns, ds).filter((p) => p.metadata.deletionTimestamp).length;
        budget -= terminating;
        for (const p of outdated) {
          if (budget <= 0) break;
          this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          this.event(ds, 'Normal', 'SuccessfulDelete', `Deleted pod: ${p.metadata.name}`, 'daemonset-controller');
          budget--;
        }
      }
      const cur = this.controlledBy(pT, ns, ds).filter((p) => !p.metadata.deletionTimestamp);
      const scheduledOn = new Set(cur.map(nodeOf));
      const readyN = cur.filter((p) => this.isReady(p)).length;
      const st = {
        currentNumberScheduled: eligible.filter((n) => scheduledOn.has(n.metadata.name)).length,
        desiredNumberScheduled: eligible.length,
        numberAvailable: readyN,
        numberMisscheduled: cur.filter((p) => !eligibleNames.has(nodeOf(p))).length,
        numberReady: readyN,
        numberUnavailable: Math.max(0, eligible.length - readyN),
        observedGeneration: ds.metadata.generation,
        updatedNumberScheduled: cur.filter((p) => p.metadata.labels['controller-revision-hash'] === hash).length,
      };
      if (!st.numberAvailable) delete st.numberAvailable;
      if (!st.numberUnavailable) delete st.numberUnavailable;
      if (!st.updatedNumberScheduled) delete st.updatedNumberScheduled;
      ds.status = st;
      this.saveIfChanged(dsT, ds, before);
    }
  };

  // ---------- Job ----------
  C.jobFinished = (j) => (j.status.conditions || []).find((c) => (c.type === 'Complete' || c.type === 'Failed') && c.status === 'True');
  C.ctlJobs = function () {
    const jT = T('jobs.batch'), pT = T('pods');
    const now = this.now();
    this.misc.jobs = this.misc.jobs || {};
    for (const j of this.rawList(jT)) {
      if (j.metadata.deletionTimestamp) continue;
      const ns = j.metadata.namespace;
      const before = JSON.stringify(j);
      const rec = (this.misc.jobs[j.metadata.uid] = this.misc.jobs[j.metadata.uid] || { succ: [], fail: [], restarts: {}, lastFail: 0, idx: [] });
      const st = j.status || {};
      const pods = this.controlledBy(pT, ns, j);
      for (const p of pods) {
        if (p.status.phase === 'Succeeded' && !rec.succ.includes(p.metadata.uid)) {
          rec.succ.push(p.metadata.uid);
          const idx = (p.metadata.annotations || {})['batch.kubernetes.io/job-completion-index'];
          if (idx !== undefined && !rec.idx.includes(Number(idx))) rec.idx.push(Number(idx));
        }
        if (p.status.phase === 'Failed' && !rec.fail.includes(p.metadata.uid)) { rec.fail.push(p.metadata.uid); rec.lastFail = now; }
        const rc = (p.status.containerStatuses || []).reduce((n, c) => n + c.restartCount, 0);
        if (rc) rec.restarts[p.metadata.uid] = rc;
      }
      const active = pods.filter((p) => this.isActive(p));
      const terminating = pods.filter((p) => p.metadata.deletionTimestamp && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
      const indexed = j.spec.completionMode === 'Indexed';
      const succeeded = indexed ? rec.idx.length : rec.succ.length;
      const failed = rec.fail.length + Object.values(rec.restarts).reduce((a, b) => a + b, 0);
      let conds = st.conditions || [];
      const finished = this.jobFinished(j);
      const C0 = j.spec.completions;
      if (!finished) {
        if (!st.startTime && !j.spec.suspend) st.startTime = U.iso(now);
        const failJob = (reason, msg) => {
          for (const p of active) this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          conds = setCond(conds, now, 'FailureTarget', 'True', reason, msg);
          conds = setCond(conds, now, 'Failed', 'True', reason, msg);
          for (const c of conds) c.lastProbeTime = U.iso(now);
          this.event(j, 'Warning', reason, msg, 'job-controller');
        };
        if (j.spec.suspend) {
          if (active.length) {
            for (const p of active) this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
            this.event(j, 'Normal', 'Suspended', 'Job suspended', 'job-controller');
          }
          conds = setCond(conds, now, 'Suspended', 'True', 'JobSuspended', 'Job suspended');
        } else if ((C0 !== undefined && succeeded >= C0) || (C0 === undefined && succeeded >= 1 && !active.length)) {
          for (const p of active) this.delete(pT, ns, p.metadata.name, {}, SYSTEM);
          conds = conds.filter((c) => c.type !== 'Suspended');
          conds = setCond(conds, now, 'SuccessCriteriaMet', 'True', 'CompletionsReached', 'Reached expected number of succeeded pods');
          conds = setCond(conds, now, 'Complete', 'True', 'CompletionsReached', 'Reached expected number of succeeded pods');
          for (const c of conds) c.lastProbeTime = U.iso(now);
          st.completionTime = U.iso(now);
          this.event(j, 'Normal', 'Completed', 'Job completed', 'job-controller');
        } else if (failed > j.spec.backoffLimit) {
          failJob('BackoffLimitExceeded', 'Job has reached the specified backoff limit');
        } else if (j.spec.activeDeadlineSeconds && st.startTime && now - U.ms(st.startTime) > j.spec.activeDeadlineSeconds * 1000) {
          failJob('DeadlineExceeded', 'Job was active longer than specified deadline');
        } else {
          if (conds.some((c) => c.type === 'Suspended' && c.status === 'True')) {
            conds = setCond(conds, now, 'Suspended', 'False', 'JobResumed', 'Job resumed');
            this.event(j, 'Normal', 'Resumed', 'Job resumed', 'job-controller');
          }
          const par = j.spec.parallelism ?? 1;
          const want = C0 !== undefined ? Math.min(par, C0 - succeeded) : succeeded > 0 ? 0 : par;
          const backoff = rec.fail.length ? Math.min(10000 * 2 ** (rec.fail.length - 1), 360000) : 0;
          if (active.length + terminating.length < want && now - rec.lastFail >= backoff) {
            const activeIdx = new Set(active.map((p) => Number((p.metadata.annotations || {})['batch.kubernetes.io/job-completion-index'])));
            for (let k = active.length; k < want; k++) {
              const pod = this.podFromTemplate(j, j.spec.template, ns);
              if (indexed) {
                let idx = 0;
                while (rec.idx.includes(idx) || activeIdx.has(idx)) idx++;
                activeIdx.add(idx);
                pod.metadata.generateName = `${j.metadata.name}-${idx}-`;
                pod.metadata.annotations = { ...(pod.metadata.annotations || {}), 'batch.kubernetes.io/job-completion-index': String(idx) };
                pod.metadata.labels['batch.kubernetes.io/job-completion-index'] = String(idx);
                pod.spec.hostname = `${j.metadata.name}-${idx}`;
                for (const c of pod.spec.containers) c.env = [...(c.env || []), { name: 'JOB_COMPLETION_INDEX', valueFrom: { fieldRef: { fieldPath: "metadata.annotations['batch.kubernetes.io/job-completion-index']" } } }];
              }
              try {
                const cp = this.create(pod, SYSTEM);
                this.event(j, 'Normal', 'SuccessfulCreate', `Created pod: ${cp.metadata.name}`, 'job-controller');
              } catch (e) {
                this.event(j, 'Warning', 'FailedCreate', `Error creating: ${e.message}`, 'job-controller');
                break;
              }
            }
          }
        }
      }
      const cur = this.controlledBy(pT, ns, j);
      const act = cur.filter((p) => this.isActive(p));
      const out = {
        active: act.length || undefined,
        completedIndexes: indexed && rec.idx.length ? rec.idx.sort((a, b) => a - b).join(',') : undefined,
        completionTime: st.completionTime,
        conditions: conds.length ? conds : undefined,
        failed: failed || undefined,
        ready: act.filter((p) => this.isReady(p)).length,
        startTime: st.startTime,
        succeeded: succeeded || undefined,
        terminating: cur.filter((p) => p.metadata.deletionTimestamp && this.isActive(p) === false && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed').length,
        uncountedTerminatedPods: {},
      };
      Object.keys(out).forEach((k) => out[k] === undefined && delete out[k]);
      j.status = out;
      this.saveIfChanged(jT, j, before);
    }
  };
  C.ctlTTL = function () {
    const jT = T('jobs.batch');
    const now = this.now();
    for (const j of this.rawList(jT)) {
      if (j.spec.ttlSecondsAfterFinished === undefined || j.metadata.deletionTimestamp) continue;
      const f = this.jobFinished(j);
      if (!f) continue;
      if (now - U.ms(f.lastTransitionTime) >= j.spec.ttlSecondsAfterFinished * 1000) this.delete(jT, j.metadata.namespace, j.metadata.name, { propagationPolicy: 'Background' }, SYSTEM);
    }
  };

  // ---------- CronJob ----------
  C.ctlCronJobs = function () {
    const cjT = T('cronjobs.batch'), jT = T('jobs.batch');
    const now = this.now();
    this.misc.cjSeen = this.misc.cjSeen || {};
    for (const cj of this.rawList(cjT)) {
      if (cj.metadata.deletionTimestamp) continue;
      const ns = cj.metadata.namespace;
      const before = JSON.stringify(cj);
      const st = cj.status || {};
      const jobs = this.controlledBy(jT, ns, cj);
      const active = [];
      for (const j of jobs) {
        const f = this.jobFinished(j);
        if (!f) active.push(j);
        else if (!this.misc.cjSeen[j.metadata.uid]) {
          this.misc.cjSeen[j.metadata.uid] = 1;
          this.event(cj, 'Normal', 'SawCompletedJob', `Saw completed job: ${j.metadata.name}, condition: ${f.type}`, 'cronjob-controller');
          if (f.type === 'Complete') st.lastSuccessfulTime = j.status.completionTime;
        }
      }
      // limpeza do histórico
      const clean = (list, limit) => {
        list.sort((a, b) => U.ms(a.status.startTime || a.metadata.creationTimestamp) - U.ms(b.status.startTime || b.metadata.creationTimestamp));
        while (list.length > limit) {
          const j = list.shift();
          this.delete(jT, ns, j.metadata.name, { propagationPolicy: 'Background' }, SYSTEM);
          this.event(cj, 'Normal', 'SuccessfulDelete', `Deleted job ${j.metadata.name}`, 'cronjob-controller');
        }
      };
      clean(jobs.filter((j) => (this.jobFinished(j) || {}).type === 'Complete' && !j.metadata.deletionTimestamp), cj.spec.successfulJobsHistoryLimit ?? 3);
      clean(jobs.filter((j) => (this.jobFinished(j) || {}).type === 'Failed' && !j.metadata.deletionTimestamp), cj.spec.failedJobsHistoryLimit ?? 1);
      if (!cj.spec.suspend) {
        let cron;
        try { cron = U.parseCron(cj.spec.schedule); } catch (e) { cron = null; }
        if (cron) {
          const last = U.ms(st.lastScheduleTime) || U.ms(cj.metadata.creationTimestamp);
          let t = U.cronNext(cron, last), recent = null, guard = 0;
          while (t && t <= now && guard++ < 200) { recent = t; t = U.cronNext(cron, t); }
          if (recent && recent !== this.misc['cjSkip' + cj.metadata.uid]) {
            const late = cj.spec.startingDeadlineSeconds !== undefined && now - recent > cj.spec.startingDeadlineSeconds * 1000;
            if (late) {
              this.misc['cjSkip' + cj.metadata.uid] = recent;
            } else if (cj.spec.concurrencyPolicy === 'Forbid' && active.length) {
              this.misc['cjSkip' + cj.metadata.uid] = recent;
              this.event(cj, 'Normal', 'JobAlreadyActive', 'Not starting job because prior execution is running and concurrency policy is Forbid', 'cronjob-controller');
            } else {
              if (cj.spec.concurrencyPolicy === 'Replace') {
                for (const j of active) {
                  this.delete(jT, ns, j.metadata.name, { propagationPolicy: 'Background' }, SYSTEM);
                  this.event(cj, 'Normal', 'SuccessfulDelete', `Deleted job ${j.metadata.name}`, 'cronjob-controller');
                }
                active.length = 0;
              }
              const name = `${cj.metadata.name}-${Math.floor(recent / 60000)}`;
              if (!this.raw(jT, ns, name)) {
                try {
                  const jt = cj.spec.jobTemplate;
                  this.create({
                    apiVersion: 'batch/v1', kind: 'Job',
                    metadata: {
                      name, namespace: ns,
                      labels: { ...((jt.metadata && jt.metadata.labels) || {}) },
                      annotations: { ...((jt.metadata && jt.metadata.annotations) || {}), 'batch.kubernetes.io/cronjob-scheduled-timestamp': U.iso(recent) },
                      ownerReferences: [this.ownerRef(cj)],
                    },
                    spec: U.clone(jt.spec),
                  }, SYSTEM);
                  this.event(cj, 'Normal', 'SuccessfulCreate', `Created job ${name}`, 'cronjob-controller');
                  active.push(this.raw(jT, ns, name));
                } catch (e) {
                  this.event(cj, 'Warning', 'FailedCreate', `Error creating job: ${e.message}`, 'cronjob-controller');
                }
              }
              st.lastScheduleTime = U.iso(recent);
            }
          }
        }
      }
      const out = {};
      if (active.length) out.active = active.filter(Boolean).map((j) => ({ apiVersion: 'batch/v1', kind: 'Job', name: j.metadata.name, namespace: ns, resourceVersion: j.metadata.resourceVersion, uid: j.metadata.uid }));
      if (st.lastScheduleTime) out.lastScheduleTime = st.lastScheduleTime;
      if (st.lastSuccessfulTime) out.lastSuccessfulTime = st.lastSuccessfulTime;
      cj.status = out;
      this.saveIfChanged(cjT, cj, before);
    }
  };

  // ---------- PV / PVC ----------
  C.ctlPV = function () {
    const pvcT = T('persistentvolumeclaims'), pvT = T('persistentvolumes'), scT = T('storageclasses.storage.k8s.io');
    const now = this.now();
    const bind = (pvc, pv) => {
      pv.spec.claimRef = { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: pvc.metadata.namespace, resourceVersion: pvc.metadata.resourceVersion, uid: pvc.metadata.uid };
      pv.status = { phase: 'Bound', lastPhaseTransitionTime: U.iso(now) };
      pv.metadata.annotations = { ...(pv.metadata.annotations || {}), 'pv.kubernetes.io/bound-by-controller': 'yes' };
      this.put(pvT, pv);
      pvc.spec.volumeName = pv.metadata.name;
      pvc.metadata.annotations = { ...(pvc.metadata.annotations || {}), 'pv.kubernetes.io/bind-completed': 'yes', 'pv.kubernetes.io/bound-by-controller': 'yes' };
      pvc.status = { phase: 'Bound', accessModes: pv.spec.accessModes, capacity: { ...pv.spec.capacity } };
      this.put(pvcT, pvc);
    };
    for (const pvc of this.rawList(pvcT)) {
      if (pvc.metadata.deletionTimestamp) continue;
      if (pvc.status.phase === 'Bound') {
        // expansão
        const pv = this.raw(pvT, '', pvc.spec.volumeName);
        if (!pv) { pvc.status = { ...pvc.status, phase: 'Lost' }; this.put(pvcT, pvc); this.event(pvc, 'Warning', 'ClaimLost', 'Bound claim has lost its PersistentVolume. Data on the volume is lost!', 'persistentvolume-controller'); continue; }
        const req = pvc.spec.resources.requests.storage;
        if (U.parseQuantity(req) > U.parseQuantity(pv.spec.capacity.storage)) {
          pv.spec.capacity.storage = req;
          this.put(pvT, pv);
          pvc.status.capacity = { storage: req };
          this.put(pvcT, pvc);
          this.event(pvc, 'Normal', 'VolumeResizeSuccessful', 'MountVolume.NodeExpandVolume succeeded for volume "' + pv.metadata.name + '"', 'kubelet');
        }
        continue;
      }
      const need = U.parseQuantity(pvc.spec.resources.requests.storage);
      const scName = pvc.spec.storageClassName;
      const fits = (pv) =>
        pv.status.phase === 'Available' && !pv.metadata.deletionTimestamp &&
        (pv.spec.storageClassName || '') === (scName || '') &&
        (pvc.spec.accessModes || []).every((m) => (pv.spec.accessModes || []).includes(m)) &&
        U.parseQuantity(pv.spec.capacity.storage) >= need &&
        (!pvc.spec.selector || U.matchSelector(pvc.spec.selector, pv.metadata.labels)) &&
        (pv.spec.volumeMode || 'Filesystem') === (pvc.spec.volumeMode || 'Filesystem') &&
        (!pv.spec.claimRef || (pv.spec.claimRef.name === pvc.metadata.name && pv.spec.claimRef.namespace === pvc.metadata.namespace));
      if (pvc.spec.volumeName) {
        const pv = this.raw(pvT, '', pvc.spec.volumeName);
        if (pv && fits(pv)) bind(pvc, pv);
        continue;
      }
      const cands = this.rawList(pvT).filter(fits).sort((a, b) => U.parseQuantity(a.spec.capacity.storage) - U.parseQuantity(b.spec.capacity.storage));
      if (cands.length) { bind(pvc, cands[0]); continue; }
      const key = 'pvcEv' + pvc.metadata.uid;
      const once = (reason, type, msg, comp) => {
        if (this.misc[key] === reason + msg && now - (this.misc[key + 't'] || 0) < 15000) return;
        this.misc[key] = reason + msg;
        this.misc[key + 't'] = now;
        this.event(pvc, type, reason, msg, comp || 'persistentvolume-controller');
      };
      if (!scName) { once('FailedBinding', 'Normal', 'no persistent volumes available for this claim and no storage class is set'); continue; }
      const sc = this.raw(scT, '', scName);
      if (!sc) { once('ProvisioningFailed', 'Warning', `storageclass.storage.k8s.io "${scName}" not found`); continue; }
      const selNode = (pvc.metadata.annotations || {})['volume.kubernetes.io/selected-node'];
      if (sc.volumeBindingMode === 'WaitForFirstConsumer' && !selNode) { once('WaitForFirstConsumer', 'Normal', 'waiting for first consumer to be created before binding'); continue; }
      if (sc.provisioner === 'kubernetes.io/no-provisioner') { once('ProvisioningFailed', 'Warning', 'no volume plugin matched name: kubernetes.io/no-provisioner'); continue; }
      // provisiona
      if (!this.misc['prov' + pvc.metadata.uid]) {
        this.misc['prov' + pvc.metadata.uid] = now;
        pvc.metadata.annotations = { ...(pvc.metadata.annotations || {}), 'volume.beta.kubernetes.io/storage-provisioner': sc.provisioner, 'volume.kubernetes.io/storage-provisioner': sc.provisioner };
        this.put(pvcT, pvc);
        this.event(pvc, 'Normal', 'ExternalProvisioning', `Waiting for a volume to be created either by the external provisioner '${sc.provisioner}' or manually by the system administrator. If volume creation is delayed, please verify that your external provisioner is running and correctly registered.`, 'persistentvolume-controller');
        this.event(pvc, 'Normal', 'Provisioning', `External provisioner is provisioning volume for claim "${pvc.metadata.namespace}/${pvc.metadata.name}"`, `${sc.provisioner}_local-path-provisioner-57c5987fd4-lb4r5_${U.uid()}`);
        continue;
      }
      if (now - this.misc['prov' + pvc.metadata.uid] < 1200) continue;
      const pvName = `pvc-${pvc.metadata.uid}`;
      if (!this.raw(pvT, '', pvName)) {
        const pv = {
          apiVersion: 'v1', kind: 'PersistentVolume',
          metadata: { name: pvName, annotations: { 'local.path.provisioner/selected-node': selNode || 'sim-worker', 'pv.kubernetes.io/provisioned-by': sc.provisioner } },
          spec: {
            accessModes: pvc.spec.accessModes, capacity: { storage: pvc.spec.resources.requests.storage },
            hostPath: { path: `/var/local-path-provisioner/${pvName}_${pvc.metadata.namespace}_${pvc.metadata.name}`, type: 'DirectoryOrCreate' },
            nodeAffinity: selNode ? { required: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'kubernetes.io/hostname', operator: 'In', values: [selNode] }] }] } } : undefined,
            persistentVolumeReclaimPolicy: sc.reclaimPolicy || 'Delete', storageClassName: scName, volumeMode: pvc.spec.volumeMode || 'Filesystem',
            claimRef: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', name: pvc.metadata.name, namespace: pvc.metadata.namespace, resourceVersion: pvc.metadata.resourceVersion, uid: pvc.metadata.uid },
          },
        };
        if (!selNode) delete pv.spec.nodeAffinity;
        this.create(pv, SYSTEM);
        this.event(pvc, 'Normal', 'ProvisioningSucceeded', `Successfully provisioned volume ${pvName}`, `${sc.provisioner}_local-path-provisioner-57c5987fd4-lb4r5_${U.uid()}`);
      }
      const pv = this.raw(pvT, '', pvName);
      if (pv) bind(pvc, pv);
    }
    // PVs liberados
    for (const pv of this.rawList(pvT)) {
      if (pv.status.phase !== 'Bound' || !pv.spec.claimRef) continue;
      const pvc = this.raw(pvcT, pv.spec.claimRef.namespace, pv.spec.claimRef.name);
      if (pvc && pvc.metadata.uid === pv.spec.claimRef.uid) continue;
      if (pv.spec.persistentVolumeReclaimPolicy === 'Delete') {
        pv.status = { phase: 'Released', lastPhaseTransitionTime: U.iso(now) };
        this.put(pvT, pv);
        delete this.vols['pv:' + pv.metadata.name];
        this.delete(pvT, '', pv.metadata.name, {}, SYSTEM);
      } else {
        pv.status = { phase: 'Released', lastPhaseTransitionTime: U.iso(now) };
        this.put(pvT, pv);
      }
    }
  };

  // ---------- Scheduler ----------
  C.podVolumeCheck = function (pod) {
    const pvcT = T('persistentvolumeclaims'), scT = T('storageclasses.storage.k8s.io'), pvT = T('persistentvolumes');
    const res = { error: null, nodeAffinity: [] , wffc: [] };
    for (const v of pod.spec.volumes || []) {
      if (!v.persistentVolumeClaim) continue;
      const pvc = this.raw(pvcT, pod.metadata.namespace, v.persistentVolumeClaim.claimName);
      if (!pvc) { res.error = `persistentvolumeclaim "${v.persistentVolumeClaim.claimName}" not found`; return res; }
      if (pvc.metadata.deletionTimestamp) { res.error = `persistentvolumeclaim "${pvc.metadata.name}" is being deleted`; return res; }
      if (pvc.status.phase === 'Bound') {
        const pv = this.raw(pvT, '', pvc.spec.volumeName);
        if (pv && pv.spec.nodeAffinity) res.nodeAffinity.push(pv.spec.nodeAffinity.required);
        continue;
      }
      const sc = pvc.spec.storageClassName ? this.raw(scT, '', pvc.spec.storageClassName) : null;
      if (sc && sc.volumeBindingMode === 'WaitForFirstConsumer') { res.wffc.push(pvc); continue; }
      res.error = 'pod has unbound immediate PersistentVolumeClaims';
      return res;
    }
    return res;
  };
  C.nodeFit = function (pod, node, req, allPods, vol) {
    const labels = node.metadata.labels || {};
    const taints = [...(node.spec.taints || [])];
    for (const tt of taints) {
      if (tt.effect !== 'NoSchedule' && tt.effect !== 'NoExecute') continue;
      if (!this.tolerates(pod.spec.tolerations, tt)) {
        if (tt.key === 'node.kubernetes.io/unschedulable') return 'node(s) were unschedulable';
        return `node(s) had untolerated taint {${tt.key}: ${tt.value || ''}}`;
      }
    }
    if (node.spec.unschedulable && !this.tolerates(pod.spec.tolerations, { key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' })) return 'node(s) were unschedulable';
    if (Object.entries(pod.spec.nodeSelector || {}).some(([k, v]) => labels[k] !== v) || !this.nodeAffinityMatch(pod.spec.affinity, node)) return "node(s) didn't match Pod's node affinity/selector";
    for (const na of vol.nodeAffinity) if (na && !this.nodeAffinityMatch({ nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: na } }, node)) return 'node(s) had volume node affinity conflict';
    const cap = this.nodeCap(node);
    const onNode = allPods.filter((p) => p.spec.nodeName === node.metadata.name && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
    let cpu = 0, mem = 0;
    for (const p of onNode) { const r = this.podRequests(p); cpu += r.cpu; mem += r.mem; }
    if (onNode.length + 1 > cap.pods) return 'Too many pods';
    if (cpu + req.cpu > cap.cpu) return 'Insufficient cpu';
    if (mem + req.mem > cap.mem) return 'Insufficient memory';
    const hostPorts = [];
    for (const c of pod.spec.containers || []) for (const p of c.ports || []) if (p.hostPort) hostPorts.push(p.hostPort);
    if (hostPorts.length) {
      for (const p of onNode) for (const c of p.spec.containers || []) for (const pp of c.ports || []) if (pp.hostPort && hostPorts.includes(pp.hostPort)) return "node(s) didn't have free ports for the requested pod ports";
    }
    const aff = pod.spec.affinity || {};
    const nodes = this._schedNodes;
    const topoMatch = (term, wantMatch) => {
      const key = term.topologyKey;
      const val = labels[key];
      if (val === undefined) return !wantMatch;
      const nss = term.namespaces && term.namespaces.length ? term.namespaces : [pod.metadata.namespace];
      const sameDomain = new Set(nodes.filter((n) => (n.metadata.labels || {})[key] === val).map((n) => n.metadata.name));
      return allPods.some((p) => p !== pod && p.spec.nodeName && sameDomain.has(p.spec.nodeName) && this.isActive(p) && (term.namespaceSelector ? true : nss.includes(p.metadata.namespace)) && U.matchSelector(term.labelSelector, p.metadata.labels || {}));
    };
    for (const term of ((aff.podAntiAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || [])) if (topoMatch(term, true)) return "node(s) didn't match pod anti-affinity rules";
    for (const term of ((aff.podAffinity || {}).requiredDuringSchedulingIgnoredDuringExecution || [])) {
      if (!topoMatch(term, true)) {
        // se nenhum pod do cluster casa, e o próprio pod casa, é permitido (primeiro da série)
        const any = allPods.some((p) => p !== pod && p.spec.nodeName && U.matchSelector(term.labelSelector, p.metadata.labels || {}));
        if (any || !U.matchSelector(term.labelSelector, pod.metadata.labels || {})) return "node(s) didn't match pod affinity rules";
      }
    }
    for (const tsc of pod.spec.topologySpreadConstraints || []) {
      if (tsc.whenUnsatisfiable !== 'DoNotSchedule') continue;
      const key = tsc.topologyKey;
      const counts = {};
      for (const n of nodes) {
        const v = (n.metadata.labels || {})[key];
        if (v === undefined) continue;
        if ((n.spec.taints || []).some((tt) => tt.effect === 'NoSchedule' && !this.tolerates(pod.spec.tolerations, tt))) continue;
        counts[v] = counts[v] || 0;
      }
      for (const p of allPods) {
        if (p === pod || !p.spec.nodeName || !this.isActive(p) || p.metadata.namespace !== pod.metadata.namespace) continue;
        if (!U.matchSelector(tsc.labelSelector, p.metadata.labels || {})) continue;
        const n = nodes.find((x) => x.metadata.name === p.spec.nodeName);
        const v = n && (n.metadata.labels || {})[key];
        if (v !== undefined && v in counts) counts[v]++;
      }
      const v = labels[key];
      if (v === undefined || !(v in counts)) return "node(s) didn't match pod topology spread constraints (missing required label)";
      const min = Math.min(...Object.values(counts));
      if (counts[v] + 1 - min > (tsc.maxSkew || 1)) return "node(s) didn't match pod topology spread constraints";
    }
    return null;
  };
  C.scheduler = function () {
    const pT = T('pods'), nT = T('nodes');
    const allPods = this.rawList(pT);
    const pending = allPods.filter((p) => !p.spec.nodeName && !p.metadata.deletionTimestamp && (p.spec.schedulerName || 'default-scheduler') === 'default-scheduler');
    if (!pending.length) return;
    const nodes = this.rawList(nT);
    this._schedNodes = nodes;
    const now = this.now();
    pending.sort((a, b) => (b.spec.priority || 0) - (a.spec.priority || 0) || U.ms(a.metadata.creationTimestamp) - U.ms(b.metadata.creationTimestamp));
    for (const pod of pending) {
      const before = JSON.stringify(pod);
      if ((pod.spec.schedulingGates || []).length) {
        pod.status.conditions = setCond(pod.status.conditions, now, 'PodScheduled', 'False', 'SchedulingGated', 'Scheduling is blocked due to non-empty scheduling gates');
        pod.status.conditions.forEach((c) => (c.lastProbeTime = null));
        this.saveIfChanged(pT, pod, before);
        continue;
      }
      const req = this.podRequests(pod);
      const vol = this.podVolumeCheck(pod);
      const reasons = {};
      const feasible = [];
      if (vol.error) reasons[vol.error] = nodes.length;
      else
        for (const n of nodes) {
          const why = this.nodeFit(pod, n, req, allPods, vol);
          if (why) reasons[why] = (reasons[why] || 0) + 1;
          else feasible.push(n);
        }
      if (!feasible.length) {
        // preempção simples por prioridade
        if (!vol.error && (pod.spec.priority || 0) > 0 && pod.spec.preemptionPolicy !== 'Never') {
          const victimNode = nodes.find((n) => {
            const victims = allPods.filter((p) => p.spec.nodeName === n.metadata.name && this.isActive(p) && (p.spec.priority || 0) < pod.spec.priority);
            if (!victims.length) return false;
            const rest = allPods.filter((p) => !victims.includes(p));
            return !this.nodeFit(pod, n, req, rest, vol);
          });
          if (victimNode) {
            const victims = allPods.filter((p) => p.spec.nodeName === victimNode.metadata.name && this.isActive(p) && (p.spec.priority || 0) < pod.spec.priority).sort((a, b) => (a.spec.priority || 0) - (b.spec.priority || 0));
            for (const v of victims) {
              const rest = allPods.filter((p) => p !== v && !p.metadata.deletionTimestamp);
              this.event(v, 'Normal', 'Preempted', `Preempted by pod ${pod.metadata.uid} on node ${victimNode.metadata.name}`, 'default-scheduler');
              v.status.conditions = setCond(v.status.conditions, now, 'DisruptionTarget', 'True', 'PreemptionByScheduler', `${'default-scheduler'}: preempting to accommodate a higher priority pod`);
              this.put(pT, v);
              this.delete(pT, v.metadata.namespace, v.metadata.name, {}, SYSTEM);
              if (!this.nodeFit(pod, victimNode, req, rest.filter((p) => !p.metadata.deletionTimestamp), vol)) break;
            }
            pod.status.nominatedNodeName = victimNode.metadata.name;
          }
        }
        const n = nodes.length;
        const parts = Object.entries(reasons).map(([r, c]) => `${c} ${r}`).sort();
        const res = Object.entries(reasons).filter(([r]) => /^Insufficient|^Too many pods/.test(r)).reduce((a, [, c]) => a + c, 0);
        const other = n - res;
        const pre = [];
        if (res) pre.push(`${res} No preemption victims found for incoming pod`);
        if (other > 0) pre.push(`${other} Preemption is not helpful for scheduling`);
        const msg = vol.error && (vol.error.includes('not found') || vol.error.includes('being deleted'))
          ? `0/${n} nodes are available: ${vol.error}. preemption: 0/${n} nodes are available: ${n} Preemption is not helpful for scheduling.`
          : `0/${n} nodes are available: ${parts.join(', ')}. preemption: 0/${n} nodes are available: ${pre.sort().join(', ')}.`;
        pod.status.conditions = setCond(pod.status.conditions, now, 'PodScheduled', 'False', 'Unschedulable', msg);
        pod.status.conditions.forEach((c) => (c.lastProbeTime = null));
        const k = 'sched' + pod.metadata.uid;
        if (this.misc[k] !== msg || now - (this.misc[k + 't'] || 0) > 60000) {
          this.misc[k] = msg;
          this.misc[k + 't'] = now;
          this.event(pod, 'Warning', 'FailedScheduling', msg, 'default-scheduler');
        }
        this.saveIfChanged(pT, pod, before);
        continue;
      }
      // pontuação
      const score = (n) => {
        const cap = this.nodeCap(n);
        const a = this.nodeAllocated(n.metadata.name);
        let s = ((1 - (a.cpu + req.cpu) / cap.cpu) + (1 - (a.mem + req.mem) / cap.mem)) * 50;
        const owner = (pod.metadata.ownerReferences || [])[0];
        if (owner) s -= allPods.filter((p) => p.spec.nodeName === n.metadata.name && (p.metadata.ownerReferences || []).some((r) => r.uid === owner.uid) && this.isActive(p)).length * 30;
        for (const pref of ((pod.spec.affinity || {}).nodeAffinity || {}).preferredDuringSchedulingIgnoredDuringExecution || [])
          if ((pref.preference.matchExpressions || []).every((e) => this.exprMatch(e, (n.metadata.labels || {})[e.key], e.key in (n.metadata.labels || {})))) s += pref.weight;
        for (const pref of ((pod.spec.affinity || {}).podAntiAffinity || {}).preferredDuringSchedulingIgnoredDuringExecution || []) {
          const t = pref.podAffinityTerm;
          if (allPods.some((p) => p.spec.nodeName === n.metadata.name && this.isActive(p) && U.matchSelector(t.labelSelector, p.metadata.labels || {}))) s -= pref.weight;
        }
        for (const pref of ((pod.spec.affinity || {}).podAffinity || {}).preferredDuringSchedulingIgnoredDuringExecution || []) {
          const t = pref.podAffinityTerm;
          if (allPods.some((p) => p.spec.nodeName === n.metadata.name && this.isActive(p) && U.matchSelector(t.labelSelector, p.metadata.labels || {}))) s += pref.weight;
        }
        for (const tt of n.spec.taints || []) if (tt.effect === 'PreferNoSchedule' && !this.tolerates(pod.spec.tolerations, tt)) s -= 50;
        return s + Math.random();
      };
      feasible.sort((a, b) => score(b) - score(a));
      const node = feasible[0];
      pod.spec.nodeName = node.metadata.name;
      delete pod.status.nominatedNodeName;
      pod.status.conditions = setCond((pod.status.conditions || []).filter((c) => c.type !== 'PodScheduled'), now, 'PodScheduled', 'True');
      pod.status.conditions.forEach((c) => (c.lastProbeTime = null));
      this.put(pT, pod);
      for (const pvc of vol.wffc) {
        pvc.metadata.annotations = { ...(pvc.metadata.annotations || {}), 'volume.kubernetes.io/selected-node': node.metadata.name };
        this.put(T('persistentvolumeclaims'), pvc);
      }
      this.event(pod, 'Normal', 'Scheduled', `Successfully assigned ${pod.metadata.namespace}/${pod.metadata.name} to ${node.metadata.name}`, 'default-scheduler');
      allPods.push(pod);
    }
  };

  // ---------- ambiente e arquivos dos pods ----------
  C.svcEnv = function (pod) {
    const env = {};
    const add = (svc) => {
      if (!svc.spec.clusterIP || svc.spec.clusterIP === 'None' || !(svc.spec.ports || []).length) return;
      const N = svc.metadata.name.toUpperCase().replace(/-/g, '_');
      const ip = svc.spec.clusterIP;
      const p0 = svc.spec.ports[0];
      env[`${N}_SERVICE_HOST`] = ip;
      env[`${N}_SERVICE_PORT`] = String(p0.port);
      for (const p of svc.spec.ports) if (p.name) env[`${N}_SERVICE_PORT_${p.name.toUpperCase().replace(/-/g, '_')}`] = String(p.port);
      env[`${N}_PORT`] = `${p0.protocol.toLowerCase()}://${ip}:${p0.port}`;
      for (const p of svc.spec.ports) {
        const k = `${N}_PORT_${p.port}_${p.protocol}`;
        env[k] = `${p.protocol.toLowerCase()}://${ip}:${p.port}`;
        env[k + '_PROTO'] = p.protocol.toLowerCase();
        env[k + '_PORT'] = String(p.port);
        env[k + '_ADDR'] = ip;
      }
    };
    const k8s = this.raw(T('services'), 'default', 'kubernetes');
    if (k8s) add(k8s);
    if (pod.spec.enableServiceLinks !== false)
      for (const s of this.rawList(T('services'), pod.metadata.namespace)) if (U.ms(s.metadata.creationTimestamp) <= U.ms(pod.metadata.creationTimestamp) && !(pod.metadata.namespace === 'default' && s.metadata.name === 'kubernetes')) add(s);
    return env;
  };
  C.fieldRef = function (pod, path) {
    const m = path.match(/^metadata\.(labels|annotations)\['(.+)'\]$/);
    if (m) return (pod.metadata[m[1]] || {})[m[2]] ?? '';
    const r = this.rt[pod.metadata.uid] || {};
    switch (path) {
      case 'metadata.name': return pod.metadata.name;
      case 'metadata.namespace': return pod.metadata.namespace;
      case 'metadata.uid': return pod.metadata.uid;
      case 'spec.nodeName': return pod.spec.nodeName || '';
      case 'spec.serviceAccountName': return pod.spec.serviceAccountName || '';
      case 'status.podIP': case 'status.podIPs': return r.ip || pod.status.podIP || '';
      case 'status.hostIP': case 'status.hostIPs': return pod.status.hostIP || '';
      case 'metadata.labels': return U.labelsString(pod.metadata.labels).split(',').join('\n');
      case 'metadata.annotations': return Object.entries(pod.metadata.annotations || {}).map(([k, v]) => `${k}="${v}"`).join('\n');
    }
    return '';
  };
  // Retorna {env, error}
  C.podEnv = function (pod, c) {
    const ns = pod.metadata.namespace;
    const cmT = T('configmaps'), sT = T('secrets');
    const env = { ...this.svcEnv(pod) };
    const p = IM.profile(c.image);
    if (p.logs === 'nginx') Object.assign(env, { NGINX_VERSION: '1.27.1', NJS_VERSION: '0.8.5', NJS_RELEASE: '1~bookworm', PKG_RELEASE: '1~bookworm', DYNPKG_RELEASE: '2~bookworm' });
    if (p.logs === 'redis') Object.assign(env, { REDIS_VERSION: '7.4.0', REDIS_DOWNLOAD_URL: 'http://download.redis.io/releases/redis-7.4.0.tar.gz' });
    if (p.logs === 'postgres') Object.assign(env, { PG_MAJOR: '16', PG_VERSION: '16.4-1.pgdg120+2', PGDATA: '/var/lib/postgresql/data', LANG: 'en_US.utf8' });
    for (const ef of c.envFrom || []) {
      const pre = ef.prefix || '';
      if (ef.configMapRef) {
        const cm = this.raw(cmT, ns, ef.configMapRef.name);
        if (!cm) { if (ef.configMapRef.optional) continue; return { error: `configmap "${ef.configMapRef.name}" not found` }; }
        for (const [k, v] of Object.entries(cm.data || {})) env[pre + k] = v;
      }
      if (ef.secretRef) {
        const s = this.raw(sT, ns, ef.secretRef.name);
        if (!s) { if (ef.secretRef.optional) continue; return { error: `secret "${ef.secretRef.name}" not found` }; }
        for (const [k, v] of Object.entries(s.data || {})) env[pre + k] = U.b64d(v);
      }
    }
    for (const e of c.env || []) {
      if (e.valueFrom) {
        const vf = e.valueFrom;
        if (vf.configMapKeyRef) {
          const cm = this.raw(cmT, ns, vf.configMapKeyRef.name);
          if (!cm) { if (vf.configMapKeyRef.optional) continue; return { error: `configmap "${vf.configMapKeyRef.name}" not found` }; }
          if (!((cm.data || {})[vf.configMapKeyRef.key] !== undefined)) { if (vf.configMapKeyRef.optional) continue; return { error: `couldn't find key ${vf.configMapKeyRef.key} in ConfigMap ${ns}/${vf.configMapKeyRef.name}` }; }
          env[e.name] = cm.data[vf.configMapKeyRef.key];
        } else if (vf.secretKeyRef) {
          const s = this.raw(sT, ns, vf.secretKeyRef.name);
          if (!s) { if (vf.secretKeyRef.optional) continue; return { error: `secret "${vf.secretKeyRef.name}" not found` }; }
          if ((s.data || {})[vf.secretKeyRef.key] === undefined) { if (vf.secretKeyRef.optional) continue; return { error: `couldn't find key ${vf.secretKeyRef.key} in Secret ${ns}/${vf.secretKeyRef.name}` }; }
          env[e.name] = U.b64d(s.data[vf.secretKeyRef.key]);
        } else if (vf.fieldRef) env[e.name] = this.fieldRef(pod, vf.fieldRef.fieldPath);
        else if (vf.resourceFieldRef) {
          const res = vf.resourceFieldRef.resource;
          const ctr = vf.resourceFieldRef.containerName ? pod.spec.containers.find((x) => x.name === vf.resourceFieldRef.containerName) : c;
          const [kind, rname] = res.split('.');
          let v = ((ctr && ctr.resources && ctr.resources[kind]) || {})[rname];
          if (v === undefined) {
            const node = this.raw(T('nodes'), '', pod.spec.nodeName);
            v = node ? node.status.allocatable[rname] : '0';
          }
          env[e.name] = rname === 'cpu' ? String(Math.ceil(U.parseQuantity(v) / U.parseQuantity(vf.resourceFieldRef.divisor || '1'))) : String(Math.ceil(U.parseQuantity(v) / U.parseQuantity(vf.resourceFieldRef.divisor || '1')));
        }
      } else {
        env[e.name] = String(e.value ?? '').replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, n) => (n in env ? env[n] : m)).replace(/\$\$/g, '$');
      }
    }
    env.HOSTNAME = pod.spec.hostname || pod.metadata.name;
    return { env };
  };
  C.saToken = function (ns, sa, podName, audience, expSec) {
    const now = Math.floor(this.now() / 1000);
    const header = { alg: 'RS256', kid: 'm3F4GgHn8fO2yVKq7dWkL6c9QpZ0xRbT1sUaNvEwIjY' };
    const payload = {
      aud: audience || ['https://kubernetes.default.svc.cluster.local'], exp: now + (expSec || 3607), iat: now, iss: 'https://kubernetes.default.svc.cluster.local',
      jti: U.uid(),
      'kubernetes.io': { namespace: ns, ...(podName ? { node: { name: 'sim-worker', uid: U.uid() }, pod: { name: podName, uid: U.uid() } } : {}), serviceaccount: { name: sa, uid: (this.raw(T('serviceaccounts'), ns, sa) || { metadata: { uid: U.uid() } }).metadata.uid } },
      nbf: now, sub: `system:serviceaccount:${ns}:${sa}`,
    };
    return U.b64url(JSON.stringify(header)) + '.' + U.b64url(JSON.stringify(payload)) + '.' + U.b64url(U.hex(128));
  };
  // localiza o volume montado em `path` para o container
  C.mountFor = function (pod, cName, path) {
    const c = [...(pod.spec.containers || []), ...(pod.spec.initContainers || []), ...(pod.spec.ephemeralContainers || [])].find((x) => x.name === cName);
    if (!c) return null;
    let best = null;
    for (const m of c.volumeMounts || []) {
      const mp = m.mountPath.replace(/\/$/, '');
      if (path === mp || path.startsWith(mp + '/')) if (!best || mp.length > best.mountPath.replace(/\/$/, '').length) best = m;
    }
    if (!best) return null;
    const vol = (pod.spec.volumes || []).find((v) => v.name === best.name);
    const mp = best.mountPath.replace(/\/$/, '');
    let rel = path === mp ? '' : path.slice(mp.length + 1);
    if (best.subPath) rel = best.subPath + (rel ? '/' + rel : '');
    return { mount: best, vol, rel, mp };
  };
  C.volumeFiles = function (pod, vol) {
    // arquivos (rel -> conteúdo) de volumes somente-leitura derivados de objetos
    const ns = pod.metadata.namespace;
    const out = {};
    if (!vol) return out;
    if (vol.configMap) {
      const cm = this.raw(T('configmaps'), ns, vol.configMap.name);
      if (cm) {
        const data = cm.data || {};
        if (vol.configMap.items) for (const it of vol.configMap.items) { if (data[it.key] !== undefined) out[it.path] = data[it.key]; }
        else Object.assign(out, data);
      }
    } else if (vol.secret) {
      const s = this.raw(T('secrets'), ns, vol.secret.secretName);
      if (s) {
        const data = s.data || {};
        if (vol.secret.items) for (const it of vol.secret.items) { if (data[it.key] !== undefined) out[it.path] = U.b64d(data[it.key]); }
        else for (const [k, v] of Object.entries(data)) out[k] = U.b64d(v);
      }
    } else if (vol.projected) {
      for (const src of vol.projected.sources || []) {
        if (src.serviceAccountToken) out[src.serviceAccountToken.path] = this.saToken(ns, pod.spec.serviceAccountName || 'default', pod.metadata.name, src.serviceAccountToken.audience ? [src.serviceAccountToken.audience] : null, src.serviceAccountToken.expirationSeconds);
        if (src.configMap) {
          const cm = this.raw(T('configmaps'), ns, src.configMap.name);
          if (cm) for (const it of src.configMap.items || Object.keys(cm.data || {}).map((k) => ({ key: k, path: k }))) if ((cm.data || {})[it.key] !== undefined) out[it.path] = cm.data[it.key];
        }
        if (src.secret) {
          const s = this.raw(T('secrets'), ns, src.secret.name);
          if (s) for (const it of src.secret.items || Object.keys(s.data || {}).map((k) => ({ key: k, path: k }))) if ((s.data || {})[it.key] !== undefined) out[it.path] = U.b64d(s.data[it.key]);
        }
        if (src.downwardAPI) for (const it of src.downwardAPI.items || []) if (it.fieldRef) out[it.path] = this.fieldRef(pod, it.fieldRef.fieldPath);
      }
    } else if (vol.downwardAPI) {
      for (const it of vol.downwardAPI.items || []) if (it.fieldRef) out[it.path] = this.fieldRef(pod, it.fieldRef.fieldPath);
    }
    return out;
  };
  C.volStoreKey = function (pod, vol) {
    if (!vol) return null;
    if (vol.emptyDir) return `pod:${pod.metadata.uid}:${vol.name}`;
    if (vol.persistentVolumeClaim) {
      const pvc = this.raw(T('persistentvolumeclaims'), pod.metadata.namespace, vol.persistentVolumeClaim.claimName);
      return pvc && pvc.spec.volumeName ? `pv:${pvc.spec.volumeName}` : null;
    }
    if (vol.hostPath) return `host:${pod.spec.nodeName}:${vol.hostPath.path}`;
    return null;
  };
  C.podFileSystem = function (pod, cName) {
    // mapa de caminho absoluto -> conteúdo (null = removido); inclui diretórios implícitos
    const r = this.rt[pod.metadata.uid] || {};
    const spec = [...(pod.spec.containers || []), ...(pod.spec.initContainers || []), ...(pod.spec.ephemeralContainers || [])].find((x) => x.name === cName);
    const prof = IM.profile(spec ? spec.image : '');
    const files = {};
    Object.assign(files, IM.baseFiles(prof));
    const hn = pod.spec.hostname || pod.metadata.name;
    const fqdn = pod.spec.subdomain ? `${hn}.${pod.spec.subdomain}.${pod.metadata.namespace}.svc.cluster.local` : null;
    files['/etc/hostname'] = hn + '\n';
    files['/etc/hosts'] = `# Kubernetes-managed hosts file.\n127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\nfe00::0\tip6-localnet\nfe00::0\tip6-mcastprefix\nfe00::1\tip6-allnodes\nfe00::2\tip6-allrouters\n${r.ip || pod.status.podIP || ''}\t${fqdn ? fqdn + '\t' : ''}${hn}\n` + (pod.spec.hostAliases || []).map((h) => `\n# Entries added by HostAliases.\n${h.ip}\t${(h.hostnames || []).join('\t')}`).join('') ;
    files['/etc/resolv.conf'] = pod.spec.dnsPolicy === 'Default' ? 'nameserver 172.18.0.1\n' : `search ${pod.metadata.namespace}.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.96.0.10\noptions ndots:5\n`;
    files['/dev/termination-log'] = '';
    // arquivos criados pelo processo principal
    const rec = (r.cs || {})[cName] || (r.ics || {})[cName] || (r.ecs || {})[cName];
    const run = rec && rec.runs && rec.runs[rec.runs.length - 1];
    if (run && run.fsEv) Object.assign(files, IM.fsAt(run.fsEv, (Math.min(this.now(), run.end || Infinity) - run.start) / 1000));
    if (run && run.fsw) Object.assign(files, run.fsw);
    // volumes
    const c = spec;
    for (const m of (c && c.volumeMounts) || []) {
      const vol = (pod.spec.volumes || []).find((v) => v.name === m.name);
      const mp = m.mountPath.replace(/\/$/, '');
      const key = this.volStoreKey(pod, vol);
      let vf;
      if (key) vf = this.vols[key] || {};
      else vf = this.volumeFiles(pod, vol);
      // remove arquivos da imagem que ficaram por baixo do ponto de montagem
      if (!m.subPath) for (const k of Object.keys(files)) if (k.startsWith(mp + '/')) delete files[k];
      if (m.subPath) {
        if (vf[m.subPath] !== undefined) files[mp] = vf[m.subPath];
        else for (const [k, v] of Object.entries(vf)) if (k.startsWith(m.subPath + '/')) files[mp + '/' + k.slice(m.subPath.length + 1)] = v;
      } else {
        files[mp + '/'] = files[mp + '/'] || '';
        for (const [k, v] of Object.entries(vf)) files[mp + '/' + k] = v;
        if (vol && (vol.configMap || vol.secret || vol.projected) && Object.keys(vf).length) {
          files[mp + '/..data/'] = '';
        }
      }
    }
    return files;
  };
  C.podReadFile = function (pod, cName, path) {
    const f = this.podFileSystem(pod, cName);
    const v = f[path];
    return v === undefined ? null : v;
  };
  // grava arquivo (retorna mensagem de erro ou null)
  C.podWriteFile = function (pod, cName, path, content) {
    const mt = this.mountFor(pod, cName, path);
    if (mt) {
      const key = this.volStoreKey(pod, mt.vol);
      if (!key || mt.mount.readOnly) return 'Read-only file system';
      this.vols[key] = this.vols[key] || {};
      if (content === null) delete this.vols[key][mt.rel];
      else this.vols[key][mt.rel] = content;
      this.dirty = true;
      return null;
    }
    const r = this.rt[pod.metadata.uid];
    const rec = r && ((r.cs || {})[cName] || (r.ics || {})[cName] || (r.ecs || {})[cName]);
    const run = rec && rec.runs[rec.runs.length - 1];
    if (!run) return 'No such container';
    run.fsw = run.fsw || {};
    run.fsw[path] = content;
    this.dirty = true;
    return null;
  };

  // ---------- rede ----------
  C.allPodsByIP = function () {
    const m = {};
    for (const p of this.rawList(T('pods'))) {
      const ip = (this.rt[p.metadata.uid] || {}).ip || p.status.podIP;
      if (ip && !p.spec.hostNetwork) m[ip] = p;
    }
    return m;
  };
  // resolve nome -> {ip, svc?, pod?, node?, external?}
  C.resolve = function (host, fromNs) {
    host = String(host || '').replace(/\.$/, '').toLowerCase();
    const svcT = T('services'), nT = T('nodes');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const svc = this.rawList(svcT).find((s) => s.spec.clusterIP === host);
      if (svc) return { ip: host, svc };
      const pod = this.allPodsByIP()[host];
      if (pod) return { ip: host, pod };
      const node = this.rawList(nT).find((n) => (n.status.addresses || []).some((a) => a.address === host));
      if (node) return { ip: host, node };
      if (host === '127.0.0.1') return { ip: host, local: true };
      return { ip: host, external: true };
    }
    if (host === 'localhost') return { ip: '127.0.0.1', local: true };
    const node = this.rawList(nT).find((n) => n.metadata.name === host);
    if (node) return { ip: node.status.addresses[0].address, node };
    const parts = host.split('.');
    const tryFind = (name, ns) => this.raw(svcT, ns, name);
    let svc = null, podHost = null;
    const suffix = 'svc.cluster.local';
    if (parts.length === 1) svc = fromNs ? tryFind(parts[0], fromNs) : null;
    else if (parts.length === 2) {
      svc = tryFind(parts[0], parts[1]);
      if (!svc && fromNs) { const hs = tryFind(parts[1], fromNs); if (hs && hs.spec.clusterIP === 'None') { svc = hs; podHost = parts[0]; } }
    } else if (parts.length === 3 && !host.endsWith('.svc')) {
      const hs = tryFind(parts[1], parts[2]);
      if (hs && hs.spec.clusterIP === 'None') { svc = hs; podHost = parts[0]; }
    }
    if (!svc && (host.endsWith('.svc') || host.endsWith('.' + suffix))) {
      const core = host.endsWith('.svc') ? host.slice(0, -4) : host.slice(0, -suffix.length - 1);
      const cp = core.split('.');
      if (cp.length === 2) svc = tryFind(cp[0], cp[1]);
      else if (cp.length === 3) { podHost = cp[0]; svc = tryFind(cp[1], cp[2]); }
    } else if (host.endsWith('.pod.cluster.local') || host.endsWith('.pod')) {
      const ip = parts[0].replace(/-/g, '.');
      const pod = this.allPodsByIP()[ip];
      if (pod) return { ip, pod };
      return null;
    }
    if (svc) {
      if (svc.spec.type === 'ExternalName') return { ip: null, cname: svc.spec.externalName, svc };
      if (svc.spec.clusterIP === 'None') {
        const pods = this.rawList(T('pods'), svc.metadata.namespace).filter((p) => this.isReady(p) && U.matchLabelString(U.mapSelectorString(svc.spec.selector) === '<none>' ? '' : U.mapSelectorString(svc.spec.selector), p.metadata.labels));
        const target = podHost ? pods.find((p) => (p.spec.hostname || p.metadata.name) === podHost && p.spec.subdomain === svc.metadata.name) : pods[0];
        if (!target) return podHost ? null : { ip: null, svc, headless: true, ips: [] };
        return { ip: this.rt[target.metadata.uid].ip, pod: target, svc, headless: true, ips: pods.map((p) => this.rt[p.metadata.uid].ip) };
      }
      return { ip: svc.spec.clusterIP, svc };
    }
    if (parts.length >= 2 && !host.endsWith('cluster.local') && /\.[a-z]{2,}$/.test(host)) {
      const h = U.fnv(host);
      return { ip: `${93 + (h % 100)}.${(h >> 8) % 255}.${(h >> 16) % 255}.${1 + (h % 250)}`, external: true, host };
    }
    return null;
  };
  C.namedPort = function (pod, target) {
    if (typeof target === 'number' || /^\d+$/.test(String(target))) return Number(target);
    for (const c of pod.spec.containers || []) for (const p of c.ports || []) if (p.name === target) return p.containerPort;
    return null;
  };
  C.peerMatch = function (peer, pod, policyNs) {
    if (peer.ipBlock) {
      const ip = pod ? (this.rt[pod.metadata.uid] || {}).ip : null;
      if (!ip) return false;
      const [base, bits] = peer.ipBlock.cidr.split('/');
      const toN = (x) => x.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
      const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      if (((toN(ip) & mask) >>> 0) !== ((toN(base) & mask) >>> 0)) return false;
      return !(peer.ipBlock.except || []).some((ex) => { const [b2, bt2] = ex.split('/'); const m2 = (~0 << (32 - Number(bt2))) >>> 0; return ((toN(ip) & m2) >>> 0) === ((toN(b2) & m2) >>> 0); });
    }
    if (!pod) return false;
    const nsObj = this.raw(T('namespaces'), '', pod.metadata.namespace);
    if (peer.namespaceSelector) {
      if (!U.matchSelector(peer.namespaceSelector, (nsObj && nsObj.metadata.labels) || {})) return false;
    } else if (pod.metadata.namespace !== policyNs) return false;
    if (peer.podSelector) return U.matchSelector(peer.podSelector, pod.metadata.labels || {});
    return true;
  };
  // verifica NetworkPolicy (src pode ser null = tráfego externo / host)
  C.netAllowed = function (src, dst, port, proto = 'TCP') {
    const npT = T('networkpolicies.networking.k8s.io');
    const portOk = (rulePorts, pod) => !rulePorts || !rulePorts.length || rulePorts.some((rp) => (rp.protocol || 'TCP') === proto && (rp.port === undefined || this.namedPort(pod, rp.port) === port || (rp.endPort && port >= rp.port && port <= rp.endPort)));
    if (dst) {
      const pols = this.rawList(npT, dst.metadata.namespace).filter((np) => (np.spec.policyTypes || ['Ingress']).includes('Ingress') && U.matchSelector(np.spec.podSelector || {}, dst.metadata.labels || {}));
      if (pols.length && !pols.some((np) => (np.spec.ingress || []).some((rule) => (!rule.from || !rule.from.length || rule.from.some((peer) => this.peerMatch(peer, src, np.metadata.namespace))) && portOk(rule.ports, dst)))) return { ok: false, where: 'ingress' };
    }
    if (src) {
      const pols = this.rawList(npT, src.metadata.namespace).filter((np) => (np.spec.policyTypes || []).includes('Egress') && U.matchSelector(np.spec.podSelector || {}, src.metadata.labels || {}));
      if (pols.length && !pols.some((np) => (np.spec.egress || []).some((rule) => (!rule.to || !rule.to.length || rule.to.some((peer) => this.peerMatch(peer, dst, np.metadata.namespace))) && portOk(rule.ports, dst)))) return { ok: false, where: 'egress' };
    }
    return { ok: true };
  };
  C.dnsAllowed = function (src) {
    if (!src || src.spec.dnsPolicy === 'Default') return true;
    const dns = this.rawList(T('pods'), 'kube-system').filter((p) => (p.metadata.labels || {})['k8s-app'] === 'kube-dns' && this.isReady(p));
    if (!dns.length) return false;
    return dns.some((d) => this.netAllowed(src, d, 53, 'UDP').ok);
  };
  C.containerListening = function (pod, port) {
    const r = this.rt[pod.metadata.uid];
    if (!r) return null;
    for (const c of pod.spec.containers || []) {
      const rec = (r.cs || {})[c.name];
      if (!rec || rec.stage !== 'running') continue;
      const run = rec.runs[rec.runs.length - 1];
      const prof = IM.profile(c.image);
      let listen = run.listen && run.listen.length ? run.listen : prof.ports;
      if ((!listen || !listen.length) && (prof.generic || run.server)) listen = (c.ports || []).map((p) => p.containerPort).concat(prof.generic && !(c.ports || []).length ? [80, 8080] : []);
      const readyAt = run.start + (prof.startDelay || { mysql: 12, mariadb: 6, postgres: 2, rabbitmq: 6, jenkins: 12, elasticsearch: 20 }[prof.logs] || 0.2) * 1000;
      if ((listen || []).includes(port) && this.now() >= readyAt) return { c, rec, run, prof };
    }
    return null;
  };
  // Requisição HTTP simulada. opts: {fromPod, method, headers, dry, tool}
  C.http = function (url, opts = {}) {
    const m = String(url).match(/^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([^?#]*)?(\?[^#]*)?/);
    if (!m) return { error: `curl: (3) URL rejected: Malformed input to a URL function`, code: 3 };
    const scheme = m[1] || 'http';
    const host = m[2];
    let port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
    const path = (m[4] || '/') + (m[5] || '');
    const src = opts.fromPod || null;
    const fromNs = src ? src.metadata.namespace : opts.ns || null;
    const tool = opts.tool || 'curl';
    const refused = (ip) => tool === 'wget' ? { error: `wget: can't connect to remote host (${ip}): Connection refused`, code: 1 } : { error: `curl: (7) Failed to connect to ${host} port ${port} after ${1 + Math.floor(Math.random() * 3)} ms: Couldn't connect to server`, code: 7 };
    const timeout = (ip) => tool === 'wget' ? { error: `wget: can't connect to remote host (${ip}): Connection timed out`, code: 1, delay: 3000 } : { error: `curl: (28) Failed to connect to ${host} port ${port} after 130${Math.floor(Math.random() * 900)} ms: Couldn't connect to server`, code: 28, delay: 3000 };
    if (src && !/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== 'localhost' && !this.dnsAllowed(src))
      return tool === 'wget' ? { error: `wget: bad address '${host}'`, code: 1, delay: 5000 } : { error: `curl: (6) Could not resolve host: ${host}`, code: 6, delay: 5000 };
    let res = this.resolve(host, fromNs);
    if (res && res.cname) res = this.resolve(res.cname, fromNs) || { external: true, ip: '93.184.215.14', host: res.cname };
    if (!res) return tool === 'wget' ? { error: `wget: bad address '${host}'`, code: 1 } : { error: `curl: (6) Could not resolve host: ${host}`, code: 6 };
    let target = null, tport = port;
    if (res.local) {
      if (src) {
        target = src;
      } else if (opts.forwards) {
        const fw = opts.forwards.find((f) => f.local === port);
        if (!fw) return { error: `curl: (7) Failed to connect to localhost port ${port} after 0 ms: Couldn't connect to server`, code: 7 };
        if (fw.proxy) return { proxy: true, path };
        target = fw.pod;
        tport = fw.remote;
      } else if (port === 80 || port === 443) {
        return this.ingressRoute(host === 'localhost' ? opts.hostHeader || 'localhost' : host, path, opts);
      } else return { error: `curl: (7) Failed to connect to ${host} port ${port} after 0 ms: Couldn't connect to server`, code: 7 };
    } else if (res.external) {
      if (!src && !opts.allowExternal) { /* terminal local também acessa internet */ }
      const title = res.host === 'example.com' || res.host === 'www.example.com' ? 'Example Domain' : res.host;
      return { status: 200, ip: res.ip, port, body: `<!doctype html>\n<html>\n<head>\n    <title>${title}</title>\n</head>\n<body>\n<div>\n    <h1>${title}</h1>\n    <p>This domain is for use in illustrative examples in documents.</p>\n</div>\n</body>\n</html>\n` };
    } else if (res.svc) {
      const svc = res.svc;
      if (res.headless) {
        if (!res.pod) return refused(host);
        target = res.pod;
        tport = port;
      } else {
        const sp = (svc.spec.ports || []).find((p) => p.port === port);
        if (!sp) return timeout(res.ip);
        const eps = this.readyEndpoints(svc);
        if (!eps.length) return refused(res.ip);
        const pick = eps[Math.floor(Math.random() * eps.length)];
        target = pick;
        tport = this.namedPort(pick, sp.targetPort ?? sp.port);
        if (tport === null) return refused(res.ip);
      }
    } else if (res.pod) {
      target = res.pod;
    } else if (res.node) {
      // NodePort ou hostNetwork
      const svc = this.rawList(T('services')).find((s) => (s.spec.ports || []).some((p) => p.nodePort === port));
      if (svc) {
        const sp = svc.spec.ports.find((p) => p.nodePort === port);
        const eps = this.readyEndpoints(svc);
        if (!eps.length) return refused(res.ip);
        target = eps[Math.floor(Math.random() * eps.length)];
        tport = this.namedPort(target, sp.targetPort ?? sp.port);
      } else if (port === 6443 || port === 10250) {
        return { status: 403, ip: res.ip, port, body: JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: 'forbidden: User "system:anonymous" cannot get path "/"', reason: 'Forbidden', details: {}, code: 403 }, null, 2) + '\n' };
      } else return refused(res.ip);
    }
    if (!target) return refused(host);
    if (res.svc && res.svc.metadata.name === 'kubernetes' && res.svc.metadata.namespace === 'default') {
      return { status: 403, ip: res.ip, port, body: JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: 'forbidden: User "system:anonymous" cannot get path "' + path + '"', reason: 'Forbidden', details: {}, code: 403 }, null, 2) + '\n', raw: true };
    }
    if (target !== src) {
      const na = this.netAllowed(src, target, tport);
      if (!na.ok) return timeout(res.ip || host);
    }
    const l = this.containerListening(target, tport);
    if (!l) return refused(res.ip || host);
    const clientIP = src ? (this.rt[src.metadata.uid] || {}).ip : '10.244.0.1';
    const hk = l.run.httpKind || l.prof.http;
    const prof = hk ? { ...l.prof, http: hk } : l.prof;
    const r = IM.http(prof, { podName: target.metadata.name, readFile: (p) => this.podReadFile(target, l.c.name, p), echoText: l.run.echoText }, { path, method: opts.method || 'GET', host, port, clientIP, ua: tool === 'wget' ? 'Wget' : 'curl/8.10.1' });
    if (r.status === -1) {
      return tool === 'wget' ? { error: 'wget: error getting response: Connection reset by peer', code: 1 } : { error: r.error === 'redis' || r.error === 'mysql' ? 'curl: (1) Received HTTP/0.9 when not allowed' : 'curl: (52) Empty reply from server', code: r.error === 'redis' ? 1 : 52 };
    }
    if (!opts.dry) {
      // access log
      const logLine = hk === 'nginx' || hk === 'ingress'
        ? `${clientIP} - - [${U.clfTime(this.now())}] "${opts.method || 'GET'} ${path} HTTP/1.1" ${r.status} ${r.body.length} "-" "${tool === 'wget' ? 'Wget' : 'curl/8.10.1'}" "-"`
        : hk === 'httpd' || hk === 'php-ok' ? `${clientIP} - - [${U.clfTime(this.now())}] "${opts.method || 'GET'} ${path} HTTP/1.1" ${r.status} ${r.body.length}` : null;
      if (logLine) {
        l.run.extra = l.run.extra || [];
        l.run.extra.push({ t: this.now(), line: logLine });
        if (l.run.extra.length > 2000) l.run.extra.splice(0, 500);
        this.dirty = true;
      }
    }
    return { status: r.status, body: r.body, ip: res.ip || (this.rt[target.metadata.uid] || {}).ip, port, server: r.server, type: r.type, location: r.location, pod: target };
  };
  C.readyEndpoints = function (svc) {
    const sel = svc.spec.selector;
    if (!sel || !Object.keys(sel).length) {
      const ep = this.raw(T('endpoints'), svc.metadata.namespace, svc.metadata.name);
      const ips = ep ? (ep.subsets || []).flatMap((s) => (s.addresses || []).map((a) => a.ip)) : [];
      const byIP = this.allPodsByIP();
      return ips.map((ip) => byIP[ip]).filter(Boolean);
    }
    return this.rawList(T('pods'), svc.metadata.namespace).filter((p) => !p.metadata.deletionTimestamp && (this.isReady(p) || svc.spec.publishNotReadyAddresses) && Object.entries(sel).every(([k, v]) => (p.metadata.labels || {})[k] === v) && (this.rt[p.metadata.uid] || {}).ip);
  };
  C.ingressRoute = function (host, path, opts) {
    const ingT = T('ingresses.networking.k8s.io');
    const ctrl = this.rawList(T('pods'), 'ingress-nginx').find((p) => this.isReady(p));
    if (!ctrl) return { error: `curl: (7) Failed to connect to ${host} port 80 after 0 ms: Couldn't connect to server`, code: 7 };
    const pathOnly = path.split('?')[0];
    let best = null;
    for (const ing of this.rawList(ingT)) {
      if (ing.spec.ingressClassName && ing.spec.ingressClassName !== 'nginx') continue;
      for (const rule of ing.spec.rules || []) {
        if (rule.host && rule.host !== host && !(rule.host.startsWith('*.') && host.endsWith(rule.host.slice(1)))) continue;
        for (const p of (rule.http && rule.http.paths) || []) {
          const pp = p.path || '/';
          const ok = p.pathType === 'Exact' ? pathOnly === pp : pathOnly === pp || pathOnly.startsWith(pp.endsWith('/') ? pp : pp + '/') || pp === '/';
          if (ok && (!best || pp.length > best.len || (rule.host && !best.host))) best = { ing, backend: p.backend, len: pp.length, host: rule.host };
        }
      }
      if (!best && ing.spec.defaultBackend) best = { ing, backend: ing.spec.defaultBackend, len: 0 };
    }
    if (!best) return { status: 404, body: '<html>\n<head><title>404 Not Found</title></head>\n<body>\n<center><h1>404 Not Found</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n', ip: '127.0.0.1', port: 80 };
    const b = best.backend.service;
    const svc = this.raw(T('services'), best.ing.metadata.namespace, b.name);
    if (!svc) return { status: 503, body: '<html>\n<head><title>503 Service Temporarily Unavailable</title></head>\n<body>\n<center><h1>503 Service Temporarily Unavailable</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n', ip: '127.0.0.1', port: 80 };
    const port = b.port.number || ((svc.spec.ports || []).find((p) => p.name === b.port.name) || {}).port;
    const r = this.http(`http://${svc.spec.clusterIP}:${port}${path}`, { ...opts, fromPod: ctrl });
    if (r.error) return { status: 503, body: '<html>\n<head><title>503 Service Temporarily Unavailable</title></head>\n<body>\n<center><h1>503 Service Temporarily Unavailable</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n', ip: '127.0.0.1', port: 80 };
    return { ...r, ip: '127.0.0.1', port: 80 };
  };
  C.nslookup = function (name, src) {
    const lines = ['Server:\t\t10.96.0.10', 'Address:\t10.96.0.10:53', ''];
    if (src && !this.dnsAllowed(src)) return { out: ';; connection timed out; no servers could be reached\n\n', code: 1, delay: 5000 };
    const ns = src ? src.metadata.namespace : 'default';
    const r = this.resolve(name, ns);
    if (!r || (r.headless && !r.ips.length && !r.ip)) {
      const search = name.includes('.') ? [name] : [`${name}.${ns}.svc.cluster.local`, `${name}.svc.cluster.local`, `${name}.cluster.local`];
      for (const s of search) lines.push(`** server can't find ${s}: NXDOMAIN`, '');
      return { out: lines.join('\n') + '\n', code: 1 };
    }
    let fq = name;
    if (r.svc && !name.endsWith('.cluster.local')) fq = `${r.svc.metadata.name}.${r.svc.metadata.namespace}.svc.cluster.local`;
    if (r.external) { lines.splice(0, 3, 'Server:\t\t10.96.0.10', 'Address:\t10.96.0.10:53', '', 'Non-authoritative answer:'); }
    if (r.cname) lines.push(`${fq}\tcanonical name = ${r.cname}`);
    const ips = r.headless && r.ips ? (name.split('.').length > 4 ? [r.ip] : r.ips) : [r.ip];
    for (const ip of ips) lines.push(`Name:\t${fq}`, `Address: ${ip}`);
    lines.push('');
    return { out: lines.join('\n') + '\n', code: 0 };
  };

  // ---------- kubelet ----------
  C.containerCtx = function (pod, c, env, start) {
    const r = this.rt[pod.metadata.uid] || {};
    return {
      podName: pod.metadata.name, ns: pod.metadata.namespace, podIP: r.ip, hostIP: pod.status.hostIP, env, startTime: start,
      readFile: (p) => this.podReadFile(pod, c.name, p),
      http: (url, o) => { const res = this.http(url, { fromPod: pod, dry: true, tool: o && o.tool }); return res.error ? { error: res.error, code: res.code } : res; },
      exec: (argv) => (argv[0] === 'nslookup' ? this.nslookup(argv[argv.length - 1], pod) : { out: `PING ${argv[argv.length - 1]}: 56 data bytes\n`, code: 0 }),
    };
  };
  C.checkVolumes = function (pod) {
    const ns = pod.metadata.namespace;
    for (const v of pod.spec.volumes || []) {
      if (v.configMap && !v.configMap.optional && !this.raw(T('configmaps'), ns, v.configMap.name)) return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${v.configMap.name}" not found`;
      if (v.secret && !v.secret.optional && !this.raw(T('secrets'), ns, v.secret.secretName)) return `MountVolume.SetUp failed for volume "${v.name}" : secret "${v.secret.secretName}" not found`;
      if (v.projected) for (const s of v.projected.sources || []) {
        if (s.configMap && !s.configMap.optional && !this.raw(T('configmaps'), ns, s.configMap.name)) return `MountVolume.SetUp failed for volume "${v.name}" : configmap "${s.configMap.name}" not found`;
        if (s.secret && !s.secret.optional && !this.raw(T('secrets'), ns, s.secret.name)) return `MountVolume.SetUp failed for volume "${v.name}" : secret "${s.secret.name}" not found`;
      }
      if (v.persistentVolumeClaim) {
        const pvc = this.raw(T('persistentvolumeclaims'), ns, v.persistentVolumeClaim.claimName);
        if (!pvc || pvc.status.phase !== 'Bound') return `Unable to attach or mount volumes: unmounted volumes=[${v.name}], unattached volumes=[], failed to process volumes=[]: timed out waiting for the condition`;
      }
      if (v.hostPath && v.hostPath.type === 'File' && !this.vols[`host:${pod.spec.nodeName}:${v.hostPath.path}`]) return `MountVolume.SetUp failed for volume "${v.name}" : hostPath type check failed: ${v.hostPath.path} is not a file`;
    }
    return null;
  };
  C.newRec = (c) => ({ name: c.name, image: c.image, stage: 'init', restartCount: 0, runs: [], pullAttempts: 0 });
  C.throttleEvent = function (pod, key, ms, fn) {
    const k = 'ev' + pod.metadata.uid + key;
    const now = this.now();
    if (this.misc[k] && now - this.misc[k] < ms) return;
    this.misc[k] = now;
    fn();
  };
  C.fieldPath = (c, isInit, eph) => `spec.${eph ? 'ephemeralContainers' : isInit ? 'initContainers' : 'containers'}{${c.name}}`;
  C.startRun = function (pod, r, c, rec, now, env, isInit) {
    const node = pod.spec.nodeName;
    const ctx = this.containerCtx(pod, c, env, now);
    const sim = IM.run(c, ctx, 1e7, { maxLines: 20 });
    const run = { start: now, id: U.hex(64), env };
    if (sim.exit && sim.exit.reason === 'StartError') {
      this.event(pod, 'Normal', 'Created', `Created container ${c.name}`, 'kubelet', node, this.fieldPath(c, isInit, rec.eph));
      this.event(pod, 'Warning', 'Failed', `Error: ${sim.exit.message}`, 'kubelet', node, this.fieldPath(c, isInit, rec.eph));
      Object.assign(run, { end: now, code: 128, reason: 'StartError', message: sim.exit.message });
      rec.runs.push(run);
      this.terminateRec(pod, r, c, rec, now, 'StartError', 128, isInit, sim.exit.message);
      return;
    }
    this.event(pod, 'Normal', 'Created', `Created container ${c.name}`, 'kubelet', node, this.fieldPath(c, isInit, rec.eph));
    this.event(pod, 'Normal', 'Started', `Started container ${c.name}`, 'kubelet', node, this.fieldPath(c, isInit, rec.eph));
    run.exitAt = sim.exit ? now + sim.exit.t * 1000 : null;
    run.code = sim.exit ? sim.exit.code : null;
    run.listen = sim.listen || null;
    run.server = sim.server;
    run.cpu = sim.cpu ?? (sim.spin ? 1000 : null);
    run.mem = sim.mem;
    run.load = [...(sim.load || [])];
    run.fsEv = sim.fs && sim.fs.length ? sim.fs.slice(0, 200) : undefined;
    run.echoText = sim.echoText;
    run.httpKind = sim.httpKind;
    const prof = IM.profile(c.image);
    const limit = U.parseQuantity(((c.resources || {}).limits || {}).memory || 0);
    const usage = run.mem ?? prof.mem * MiB;
    if (limit && usage > limit) run.oomAt = now + 1200 + Math.random() * 800;
    rec.runs.push(run);
    if (rec.runs.length > 3) rec.runs.splice(0, rec.runs.length - 3);
    rec.stage = 'running';
    rec.containerID = 'containerd://' + run.id;
    rec.startupOk = !c.startupProbe;
    rec.probe = { live: { f: 0, last: 0 }, ready: { s: 0, f: 0, last: 0 }, start: { f: 0, last: 0 } };
    rec.ready = !c.readinessProbe && !c.startupProbe;
    if (!rec.ready) rec.readyPending = true;
    rec.backoffEvented = false;
  };
  C.terminateRec = function (pod, r, c, rec, now, reason, code, isInit, message) {
    const run = rec.runs[rec.runs.length - 1];
    if (run && run.end === undefined) Object.assign(run, { end: now, code, reason, message });
    rec.stage = 'terminated';
    rec.ready = false;
    const policy = pod.spec.restartPolicy;
    let restart;
    if (rec.eph) restart = false;
    else if (isInit) restart = code !== 0 && policy !== 'Never';
    else restart = policy === 'Always' || (policy === 'OnFailure' && code !== 0);
    if (restart) {
      const delay = rec.restartCount === 0 ? 800 : Math.min(10000 * 2 ** (rec.restartCount - 1), 300000);
      rec.restartAt = now + delay;
      rec.backoffDelay = rec.restartCount === 0 ? 0 : Math.min(10 * 2 ** (rec.restartCount - 1), 300);
      rec.showBackoffAt = now + Math.min(delay, 1500);
      rec.stage = 'backoff';
    }
  };
  C.runProbe = function (pod, c, rec, probe, now) {
    const run = rec.runs[rec.runs.length - 1];
    const ip = (this.rt[pod.metadata.uid] || {}).ip;
    if (probe.exec) {
      const fake = { image: c.image, command: probe.exec.command };
      const ctx = this.containerCtx(pod, c, run.env || {}, now);
      const res = IM.run(fake, ctx, probe.timeoutSeconds || 1, { maxLines: 20 });
      if (res.exit && res.exit.reason === 'StartError') return { ok: false, msg: `rpc error: code = Unknown desc = failed to exec in container: failed to start exec "${U.hex(64)}": OCI runtime exec failed: exec failed: unable to start container process: exec: "${probe.exec.command[0]}": executable file not found in $PATH: unknown` };
      if (!res.exit) return { ok: false, msg: `command ${JSON.stringify((probe.exec.command || []).join(' '))} timed out` };
      const out = res.logs.map((l) => l.line).join('\n');
      return res.exit.code === 0 ? { ok: true } : { ok: false, msg: out || `command "${(probe.exec.command || []).join(' ')}" exited with ${res.exit.code}` };
    }
    const portOf = (p) => this.namedPort(pod, p);
    if (probe.httpGet) {
      const port = portOf(probe.httpGet.port);
      const url = `${(probe.httpGet.scheme || 'HTTP').toLowerCase()}://${ip}:${port}${probe.httpGet.path || '/'}`;
      const l = this.containerListening(pod, port);
      if (!l) return { ok: false, msg: `Get "${url}": dial tcp ${ip}:${port}: connect: connection refused` };
      const prof = { ...l.prof, http: l.run.httpKind || l.prof.http };
      const r = IM.http(prof, { podName: pod.metadata.name, readFile: (p) => this.podReadFile(pod, l.c.name, p), echoText: l.run.echoText }, { path: probe.httpGet.path || '/', method: 'GET', host: ip, port, clientIP: pod.status.hostIP, ua: 'kube-probe/1.31' });
      if (r.status === -1) return { ok: false, msg: `Get "${url}": net/http: HTTP/1.x transport connection broken: malformed HTTP response` };
      if (r.status >= 200 && r.status < 400) return { ok: true };
      return { ok: false, msg: `HTTP probe failed with statuscode: ${r.status}` };
    }
    if (probe.tcpSocket || probe.grpc) {
      const port = portOf((probe.tcpSocket || probe.grpc).port);
      if (this.containerListening(pod, port)) return { ok: true };
      return { ok: false, msg: `dial tcp ${ip}:${port}: connect: connection refused` };
    }
    return { ok: true };
  };
  C.stepContainer = function (pod, r, c, rec, now, isInit) {
    const node = pod.spec.nodeName;
    const fp = this.fieldPath(c, isInit, rec.eph);
    if (rec.image !== c.image) {
      if (rec.stage === 'running') {
        this.event(pod, 'Normal', 'Killing', `Container ${c.name} definition changed, will be restarted`, 'kubelet', node, fp);
        const run = rec.runs[rec.runs.length - 1];
        Object.assign(run, { end: now, code: 0, reason: 'Completed' });
        rec.restartCount++;
      }
      rec.image = c.image;
      rec.stage = 'init';
      rec.pullAttempts = 0;
    }
    switch (rec.stage) {
      case 'init': {
        const cached = (this.nodeImages[node] || []).includes(c.image);
        const sa = this.raw(T('serviceaccounts'), pod.metadata.namespace, pod.spec.serviceAccountName || 'default');
        const hasSecret = (pod.spec.imagePullSecrets || []).some((s) => this.raw(T('secrets'), pod.metadata.namespace, s.name)) || ((sa && sa.imagePullSecrets) || []).length > 0;
        if (c.imagePullPolicy === 'Never' && !cached) {
          rec.stage = 'waiting';
          rec.reason = 'ErrImageNeverPull';
          rec.message = `Container image "${c.image}" is not present with pull policy of Never`;
          this.event(pod, 'Warning', 'ErrImageNeverPull', rec.message, 'kubelet', node, fp);
          this.event(pod, 'Warning', 'Failed', 'Error: ErrImageNeverPull', 'kubelet', node, fp);
          return;
        }
        if (cached && c.imagePullPolicy !== 'Always') {
          this.event(pod, 'Normal', 'Pulled', `Container image "${c.image}" already present on machine`, 'kubelet', node, fp);
          rec.imageID = IM.imageID(c.image);
          rec.stage = 'create';
          rec.createAt = now + 150;
          return;
        }
        rec.check = IM.pullCheck(c.image, { hasPullSecret: hasSecret });
        if (rec.check && rec.check.reason === 'InvalidImageName') {
          rec.stage = 'waiting';
          rec.reason = 'InvalidImageName';
          rec.message = rec.check.message;
          this.event(pod, 'Warning', 'InspectFailed', rec.check.message, 'kubelet', node, fp);
          this.event(pod, 'Warning', 'Failed', 'Error: InvalidImageName', 'kubelet', node, fp);
          return;
        }
        this.event(pod, 'Normal', 'Pulling', `Pulling image "${c.image}"`, 'kubelet', node, fp);
        rec.stage = 'pulling';
        rec.pullStart = now;
        rec.pullDone = now + (rec.check ? 700 + Math.random() * 800 : IM.pullSeconds(c.image) * 1000 * (cached ? 0.25 : 1));
        return;
      }
      case 'pulling': {
        if (now < rec.pullDone) return;
        if (rec.check) {
          rec.pullAttempts++;
          const msg = `${rec.check.code === 'NotFound' ? 'rpc error: code = NotFound desc = ' : ''}${rec.check.message}`;
          this.event(pod, 'Warning', 'Failed', `Failed to pull image "${c.image}": ${msg}`, 'kubelet', node, fp);
          this.event(pod, 'Warning', 'Failed', 'Error: ErrImagePull', 'kubelet', node, fp);
          rec.stage = 'pullerr';
          rec.reason = 'ErrImagePull';
          rec.message = msg;
          rec.errAt = now;
          rec.backoffUntil = now + Math.min(10000 * 2 ** (rec.pullAttempts - 1), 300000);
          return;
        }
        const secs = ((now - rec.pullStart) / 1000).toFixed(3);
        const prof = IM.profile(c.image);
        this.event(pod, 'Normal', 'Pulled', `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${prof.sizeBytes} bytes.`, 'kubelet', node, fp);
        this.nodeImages[node] = [...new Set([...(this.nodeImages[node] || []), c.image])];
        rec.imageID = IM.imageID(c.image);
        rec.stage = 'create';
        rec.createAt = now + 120;
        return;
      }
      case 'pullerr':
        if (rec.reason === 'ErrImagePull' && now - rec.errAt > 1500) {
          rec.reason = 'ImagePullBackOff';
          rec.message = `Back-off pulling image "${c.image}"`;
          this.event(pod, 'Normal', 'BackOff', `Back-off pulling image "${c.image}"`, 'kubelet', node, fp);
          this.event(pod, 'Warning', 'Failed', 'Error: ImagePullBackOff', 'kubelet', node, fp);
        }
        if (now >= rec.backoffUntil) rec.stage = 'init';
        return;
      case 'waiting':
        return;
      case 'create': {
        if (now < rec.createAt) return;
        const envR = this.podEnv(pod, c);
        if (envR.error) {
          if (rec.reason !== 'CreateContainerConfigError' || rec.message !== envR.error) {
            rec.reason = 'CreateContainerConfigError';
            rec.message = envR.error;
          }
          this.throttleEvent(pod, 'cfg' + c.name, 10000, () => this.event(pod, 'Warning', 'Failed', `Error: ${envR.error}`, 'kubelet', node, fp));
          return;
        }
        rec.reason = undefined;
        rec.message = undefined;
        this.startRun(pod, r, c, rec, now, envR.env, isInit);
        return;
      }
      case 'running': {
        const run = rec.runs[rec.runs.length - 1];
        if (run.oomAt && now >= run.oomAt) return this.terminateRec(pod, r, c, rec, run.oomAt, 'OOMKilled', 137, isInit);
        if (run.exitAt !== null && run.exitAt !== undefined && now >= run.exitAt) return this.terminateRec(pod, r, c, rec, run.exitAt, run.code === 0 ? 'Completed' : 'Error', run.code, isInit);
        const elapsed = (now - run.start) / 1000;
        const due = (probe, st) => elapsed >= (probe.initialDelaySeconds || 0) && (!st.last || now - st.last >= (probe.periodSeconds || 10) * 1000);
        if (c.startupProbe && !rec.startupOk) {
          const pr = c.startupProbe, st = rec.probe.start;
          if (due(pr, st)) {
            st.last = now;
            const res = this.runProbe(pod, c, rec, pr, now);
            if (res.ok) { rec.startupOk = true; st.f = 0; }
            else {
              st.f++;
              this.event(pod, 'Warning', 'Unhealthy', `Startup probe failed: ${res.msg}`, 'kubelet', node, fp);
              if (st.f >= (pr.failureThreshold || 3)) {
                this.event(pod, 'Normal', 'Killing', `Container ${c.name} failed startup probe, will be restarted`, 'kubelet', node, fp);
                return this.terminateRec(pod, r, c, rec, now, 'Error', 137, isInit);
              }
            }
          }
          return;
        }
        if (c.livenessProbe) {
          const pr = c.livenessProbe, st = rec.probe.live;
          if (due(pr, st)) {
            st.last = now;
            const res = this.runProbe(pod, c, rec, pr, now);
            if (res.ok) st.f = 0;
            else {
              st.f++;
              this.event(pod, 'Warning', 'Unhealthy', `Liveness probe failed: ${res.msg}`, 'kubelet', node, fp);
              if (st.f >= (pr.failureThreshold || 3)) {
                this.event(pod, 'Normal', 'Killing', `Container ${c.name} failed liveness probe, will be restarted`, 'kubelet', node, fp);
                return this.terminateRec(pod, r, c, rec, now, run.server ? 'Completed' : 'Error', run.server ? 0 : 137, isInit);
              }
            }
          }
        }
        if (c.readinessProbe) {
          const pr = c.readinessProbe, st = rec.probe.ready;
          if (due(pr, st)) {
            st.last = now;
            const res = this.runProbe(pod, c, rec, pr, now);
            if (res.ok) {
              st.s++;
              st.f = 0;
              if (st.s >= (pr.successThreshold || 1)) rec.ready = true;
            } else {
              st.f++;
              st.s = 0;
              this.event(pod, 'Warning', 'Unhealthy', `Readiness probe failed: ${res.msg}`, 'kubelet', node, fp);
              if (st.f >= (pr.failureThreshold || 3) || !rec.ready) rec.ready = false;
            }
          }
        } else if (rec.startupOk) rec.ready = true;
        return;
      }
      case 'backoff': {
        if (now >= rec.restartAt) {
          rec.restartCount++;
          if (c.imagePullPolicy === 'Always') {
            this.event(pod, 'Normal', 'Pulling', `Pulling image "${c.image}"`, 'kubelet', node, fp);
            const secs = (0.3 + Math.random() * 0.5).toFixed(3);
            this.event(pod, 'Normal', 'Pulled', `Successfully pulled image "${c.image}" in ${secs}s (${secs}s including waiting). Image size: ${IM.profile(c.image).sizeBytes} bytes.`, 'kubelet', node, fp);
          } else this.event(pod, 'Normal', 'Pulled', `Container image "${c.image}" already present on machine`, 'kubelet', node, fp);
          const envR = this.podEnv(pod, c);
          if (envR.error) { rec.stage = 'create'; rec.createAt = now; return; }
          this.startRun(pod, r, c, rec, now, envR.env, isInit);
        } else if (now >= rec.showBackoffAt && !rec.backoffEvented && rec.restartCount > 0) {
          rec.backoffEvented = true;
          this.event(pod, 'Warning', 'BackOff', `Back-off restarting failed container ${c.name} in pod ${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`, 'kubelet', node, fp);
        }
        return;
      }
    }
  };
  C.containerStatus = function (pod, c, rec, now, initWaiting, isInit) {
    const cs = { containerID: undefined, image: c.image, imageID: rec ? rec.imageID || '' : '', lastState: {}, name: c.name, ready: false, restartCount: rec ? rec.restartCount : 0, started: false, state: {} };
    const runs = rec ? rec.runs : [];
    const run = runs[runs.length - 1];
    const term = (x) => {
      const t = { containerID: 'containerd://' + x.id, exitCode: x.code, finishedAt: U.iso(x.end), reason: x.reason, startedAt: U.iso(x.start) };
      if (x.message) t.message = x.message;
      return { terminated: t };
    };
    if (!rec || ['init', 'pulling', 'create'].includes(rec.stage)) {
      if (rec && rec.stage === 'create' && rec.reason === 'CreateContainerConfigError') cs.state = { waiting: { message: rec.message, reason: 'CreateContainerConfigError' } };
      else cs.state = { waiting: { reason: initWaiting ? 'PodInitializing' : 'ContainerCreating' } };
      if (rec && rec.restartCount && run) cs.lastState = term(run);
    } else if (rec.stage === 'pullerr' || rec.stage === 'waiting') {
      cs.state = { waiting: { message: rec.message, reason: rec.reason } };
    } else if (rec.stage === 'running') {
      cs.state = { running: { startedAt: U.iso(run.start) } };
      cs.ready = !!rec.ready;
      cs.started = !!rec.startupOk;
      if (runs.length > 1) cs.lastState = term(runs[runs.length - 2]);
    } else if (rec.stage === 'terminated') {
      cs.state = term(run);
      if (runs.length > 1) cs.lastState = term(runs[runs.length - 2]);
    } else if (rec.stage === 'backoff') {
      if (now < rec.showBackoffAt || rec.restartCount === 0) {
        cs.state = term(run);
        if (runs.length > 1) cs.lastState = term(runs[runs.length - 2]);
      } else {
        cs.state = { waiting: { message: `back-off ${rec.backoffDelay}s restarting failed container=${c.name} pod=${pod.metadata.name}_${pod.metadata.namespace}(${pod.metadata.uid})`, reason: 'CrashLoopBackOff' } };
        cs.lastState = term(run);
      }
    }
    if (rec && rec.containerID && rec.stage !== 'init' && rec.stage !== 'pulling' && rec.stage !== 'pullerr' && rec.stage !== 'create') cs.containerID = run ? 'containerd://' + run.id : rec.containerID;
    if (!cs.containerID) delete cs.containerID;
    if (rec && rec.stage !== 'running') cs.started = false;
    const mounts = (c.volumeMounts || []).map((m) => ({ mountPath: m.mountPath, name: m.name, ...(m.readOnly ? { readOnly: true, recursiveReadOnly: 'Disabled' } : {}) }));
    if (mounts.length) cs.volumeMounts = mounts;
    return cs;
  };
  C.kubelets = function () {
    const pT = T('pods'), nT = T('nodes');
    const now = this.now();
    this.ensureStaticPods();
    for (const pod of this.rawList(pT)) {
      if (!pod.spec.nodeName) continue;
      const node = this.raw(nT, '', pod.spec.nodeName);
      if (!node) continue;
      const ready = (node.status.conditions || []).find((c) => c.type === 'Ready');
      if (!ready || ready.status !== 'True') continue;
      try {
        this.kubeletPod(pod, node, now);
      } catch (e) {
        if (globalThis.console) console.error('[kubelet]', pod.metadata.name, e);
      }
    }
  };
  C.kubeletPod = function (pod, node, now) {
    const uid = pod.metadata.uid;
    const pT = T('pods');
    const before = JSON.stringify(pod.status);
    let r = this.rt[uid];
    if (!r) r = this.rt[uid] = { bound: now, sandboxAt: now + 300 + Math.random() * 500, cs: {}, ics: {}, ecs: {}, initIdx: 0 };
    if (pod.metadata.deletionTimestamp) return this.kubeletTerminate(pod, node, r, now);
    if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') return;
    if (!r.volOk) {
      const err = this.checkVolumes(pod);
      if (err) {
        this.throttleEvent(pod, 'mount', 30000, () => this.event(pod, 'Warning', 'FailedMount', err, 'kubelet', node.metadata.name));
        this.buildPodStatus(pod, node, r, now);
        if (JSON.stringify(pod.status) !== before) this.put(pT, pod);
        return;
      }
      r.volOk = true;
    }
    if (now >= r.sandboxAt && !r.ip) {
      if (pod.spec.hostNetwork) r.ip = node.status.addresses[0].address;
      else {
        const cidr = node.spec.podCIDR || '10.244.9.0/24';
        const base = cidr.split('.').slice(0, 3).join('.');
        const used = new Set(Object.values(this.rt).map((x) => x.ip));
        let n = this.misc.ipCounters[node.metadata.name] || 1;
        let ip;
        for (let i = 0; i < 254; i++) {
          n = (n % 253) + 1;
          ip = `${base}.${n + 1}`;
          if (!used.has(ip)) break;
        }
        this.misc.ipCounters[node.metadata.name] = n;
        r.ip = ip;
      }
    }
    if (r.ip) {
      if (pod.spec.activeDeadlineSeconds && now - r.bound > pod.spec.activeDeadlineSeconds * 1000 && !r.failed) {
        r.failed = { reason: 'DeadlineExceeded', message: `Pod was active on the node longer than the specified deadline` };
        this.event(pod, 'Normal', 'DeadlineExceeded', 'Pod was active on the node longer than the specified deadline', 'kubelet', node.metadata.name);
        for (const rec of Object.values(r.cs)) if (rec.stage === 'running') { const run = rec.runs[rec.runs.length - 1]; Object.assign(run, { end: now, code: 137, reason: 'Error' }); rec.stage = 'terminated'; rec.ready = false; }
      }
      if (!r.failed) {
        const inits = pod.spec.initContainers || [];
        const sidecars = inits.filter((ic) => ic.restartPolicy === 'Always');
        while (r.initIdx < inits.length) {
          const ic = inits[r.initIdx];
          const rec = (r.ics[ic.name] = r.ics[ic.name] || this.newRec(ic));
          this.stepContainer(pod, r, ic, rec, now, true);
          if (ic.restartPolicy === 'Always' && rec.stage === 'running') { r.initIdx++; continue; }
          if (rec.stage === 'terminated' && (rec.runs[rec.runs.length - 1] || {}).code === 0) { r.initIdx++; continue; }
          if (rec.stage === 'terminated' && pod.spec.restartPolicy === 'Never') r.failed = { reason: '', message: '' };
          break;
        }
        for (const sc of sidecars) {
          const rec = r.ics[sc.name];
          if (rec && inits.indexOf(sc) < r.initIdx) this.stepContainer(pod, r, sc, rec, now, true);
        }
        if (r.initIdx >= inits.length) {
          for (const c of pod.spec.containers) {
            const rec = (r.cs[c.name] = r.cs[c.name] || this.newRec(c));
            this.stepContainer(pod, r, c, rec, now, false);
          }
        }
        for (const ec of pod.spec.ephemeralContainers || []) {
          const rec = (r.ecs[ec.name] = r.ecs[ec.name] || Object.assign(this.newRec(ec), { eph: true }));
          if (rec.stage !== 'terminated') this.stepContainer(pod, r, ec, rec, now, false);
        }
      }
    }
    this.buildPodStatus(pod, node, r, now);
    if (JSON.stringify(pod.status) !== before) this.put(pT, pod);
  };
  C.buildPodStatus = function (pod, node, r, now) {
    const st = pod.status;
    const inits = pod.spec.initContainers || [];
    const initDone = r.initIdx >= inits.length;
    st.hostIP = node.status.addresses[0].address;
    st.hostIPs = [{ ip: st.hostIP }];
    if (r.ip) {
      st.podIP = r.ip;
      st.podIPs = [{ ip: r.ip }];
    }
    st.startTime = st.startTime || U.iso(r.bound);
    st.qosClass = st.qosClass || this.qosClass(pod.spec);
    if (inits.length) st.initContainerStatuses = inits.map((c, i) => this.containerStatus(pod, c, r.ics[c.name], now, i > r.initIdx || !r.ip, true));
    st.containerStatuses = pod.spec.containers.map((c) => this.containerStatus(pod, c, r.cs[c.name], now, !initDone, false));
    if ((pod.spec.ephemeralContainers || []).length) st.ephemeralContainerStatuses = pod.spec.ephemeralContainers.map((c) => this.containerStatus(pod, c, r.ecs[c.name], now, false, false));
    // fase
    const recs = pod.spec.containers.map((c) => r.cs[c.name]);
    const policy = pod.spec.restartPolicy;
    let phase = 'Pending';
    if (r.failed) phase = 'Failed';
    else if (initDone && recs.every((x) => x && x.stage === 'terminated')) phase = recs.every((x) => x.runs[x.runs.length - 1].code === 0) ? 'Succeeded' : 'Failed';
    else if (initDone && recs.some((x) => x && (x.stage === 'running' || x.stage === 'backoff' || x.stage === 'terminated'))) phase = 'Running';
    else if (initDone && recs.some((x) => x && x.restartCount > 0)) phase = 'Running';
    st.phase = phase;
    if (r.failed && r.failed.reason) { st.reason = r.failed.reason; st.message = r.failed.message; }
    const unready = pod.spec.containers.filter((c) => !(r.cs[c.name] && r.cs[c.name].ready && r.cs[c.name].stage === 'running')).map((c) => c.name);
    const incomplete = inits.filter((c, i) => i >= r.initIdx).map((c) => c.name);
    let conds = (st.conditions || []).filter((c) => c.type === 'PodScheduled' || c.type === 'DisruptionTarget' || !['PodReadyToStartContainers', 'Initialized', 'Ready', 'ContainersReady'].includes(c.type) );
    const keep = st.conditions || [];
    const set = (type, status, reason, message) => {
      const old = keep.find((c) => c.type === type);
      const c = { lastProbeTime: null, lastTransitionTime: old && old.status === status ? old.lastTransitionTime : U.iso(now), status, type };
      if (reason) c.reason = reason;
      if (message) c.message = message;
      return c;
    };
    const done = phase === 'Succeeded' || phase === 'Failed';
    const out = [];
    out.push(set('PodReadyToStartContainers', r.ip && !done ? 'True' : r.ip ? 'False' : 'False'));
    out.push(set('Initialized', initDone ? 'True' : 'False', initDone ? (done && inits.length ? 'PodCompleted' : undefined) : 'ContainersNotInitialized', initDone ? undefined : `containers with incomplete status: [${incomplete.join(' ')}]`));
    const allReady = !unready.length && !done;
    const rg = (pod.spec.readinessGates || []).filter((g) => !(keep.find((c) => c.type === g.conditionType) || {}).status || (keep.find((c) => c.type === g.conditionType) || {}).status !== 'True');
    out.push(set('Ready', allReady && !rg.length ? 'True' : 'False', done ? 'PodCompleted' : !allReady ? 'ContainersNotReady' : rg.length ? 'ReadinessGatesNotReady' : undefined, done ? undefined : !allReady ? `containers with unready status: [${unready.join(' ')}]` : rg.length ? `corresponding condition of pod readiness gate "${rg[0].conditionType}" does not exist.` : undefined));
    out.push(set('ContainersReady', allReady ? 'True' : 'False', done ? 'PodCompleted' : allReady ? undefined : 'ContainersNotReady', done || allReady ? undefined : `containers with unready status: [${unready.join(' ')}]`));
    if (!r.ip) out[0] = set('PodReadyToStartContainers', 'False');
    const other = conds.filter((c) => c.type !== 'PodScheduled');
    const sched = conds.find((c) => c.type === 'PodScheduled') || { lastProbeTime: null, lastTransitionTime: U.iso(r.bound), status: 'True', type: 'PodScheduled' };
    st.conditions = [...out, ...other, sched];
  };
  C.kubeletTerminate = function (pod, node, r, now) {
    const pT = T('pods');
    if (!r.killStart) {
      r.killStart = now;
      let quick = true;
      for (const c of [...pod.spec.containers, ...(pod.spec.initContainers || [])]) {
        const rec = r.cs[c.name] || r.ics[c.name];
        if (!rec || rec.stage !== 'running') continue;
        this.event(pod, 'Normal', 'Killing', `Stopping container ${c.name}`, 'kubelet', node.metadata.name, this.fieldPath(c, !!r.ics[c.name]));
        const run = rec.runs[rec.runs.length - 1];
        if (!run.server) quick = false;
      }
      r.killDone = quick ? now + 300 + Math.random() * 700 : U.ms(pod.metadata.deletionTimestamp);
    }
    const until = Math.min(r.killDone, U.ms(pod.metadata.deletionTimestamp));
    if (now >= until) {
      this.removeRaw(pT, pod);
      return;
    }
    // durante a finalização os containers deixam de estar prontos
    let changed = false;
    for (const rec of Object.values(r.cs)) if (rec.ready) { rec.ready = false; changed = true; }
    if (changed) {
      this.buildPodStatus(pod, node, r, now);
      this.put(pT, pod);
    }
  };
  // Pods estáticos do control plane (recriados pelo kubelet se apagados)
  C.ensureStaticPods = function () {
    const pT = T('pods');
    for (const sp of this.misc.staticPods || []) {
      if (!this.raw(pT, sp.metadata.namespace, sp.metadata.name)) {
        if (!this.misc['static' + sp.metadata.name]) { this.misc['static' + sp.metadata.name] = this.now(); continue; }
        if (this.now() - this.misc['static' + sp.metadata.name] < 1500) continue;
        delete this.misc['static' + sp.metadata.name];
        const node = this.raw(T('nodes'), '', sp.spec.nodeName);
        const p = U.clone(sp);
        delete p.file;
        if (node) p.metadata.ownerReferences = [{ apiVersion: 'v1', controller: true, kind: 'Node', name: node.metadata.name, uid: node.metadata.uid }];
        try { this.create(p, SYSTEM); } catch (e) { /* */ }
      }
    }
  };

  // ---------- Endpoints / EndpointSlices ----------
  C.ctlEndpoints = function () {
    const svcT = T('services'), epT = T('endpoints'), esT = T('endpointslices.discovery.k8s.io'), pT = T('pods');
    for (const svc of this.rawList(svcT)) {
      const ns = svc.metadata.namespace;
      if (svc.metadata.name === 'kubernetes' && ns === 'default') continue;
      const sel = svc.spec.selector;
      if (!sel || !Object.keys(sel).length || svc.spec.type === 'ExternalName') continue;
      const pods = this.rawList(pT, ns).filter((p) => Object.entries(sel).every(([k, v]) => (p.metadata.labels || {})[k] === v) && (this.rt[p.metadata.uid] || {}).ip && p.status.phase !== 'Succeeded' && p.status.phase !== 'Failed');
      const ports = svc.spec.ports || [];
      const subsetsMap = {};
      const esEndpoints = [];
      for (const p of pods) {
        const ip = this.rt[p.metadata.uid].ip;
        const resolved = ports.map((sp) => ({ name: sp.name, port: this.namedPort(p, sp.targetPort ?? sp.port), protocol: sp.protocol || 'TCP', appProtocol: sp.appProtocol }));
        if (resolved.some((x) => x.port === null)) continue;
        const key = JSON.stringify(resolved);
        const subset = (subsetsMap[key] = subsetsMap[key] || { addresses: [], notReadyAddresses: [], ports: resolved.map((x) => { const o = { port: x.port, protocol: x.protocol }; if (x.name) o.name = x.name; return o; }) });
        const terminating = !!p.metadata.deletionTimestamp;
        const ready = this.isReady(p) && !terminating;
        const addr = { ip, nodeName: p.spec.nodeName, targetRef: { kind: 'Pod', name: p.metadata.name, namespace: ns, uid: p.metadata.uid } };
        if (p.spec.hostname && p.spec.subdomain === svc.metadata.name) addr.hostname = p.spec.hostname;
        if (!terminating || svc.spec.publishNotReadyAddresses) (ready || svc.spec.publishNotReadyAddresses ? subset.addresses : subset.notReadyAddresses).push(addr);
        esEndpoints.push({ addresses: [ip], conditions: { ready, serving: this.isReady(p), terminating }, nodeName: p.spec.nodeName, targetRef: addr.targetRef, ...(addr.hostname ? { hostname: addr.hostname } : {}) });
      }
      const subsets = Object.values(subsetsMap).map((s) => {
        const o = { ...s };
        if (!o.addresses.length) delete o.addresses;
        if (!o.notReadyAddresses.length) delete o.notReadyAddresses;
        if (o.addresses) o.addresses.sort((a, b) => (a.ip < b.ip ? -1 : 1));
        return o;
      }).filter((s) => s.addresses || s.notReadyAddresses);
      let ep = this.raw(epT, ns, svc.metadata.name);
      const labels = { ...(svc.metadata.labels || {}) };
      if (svc.spec.clusterIP === 'None') labels['service.kubernetes.io/headless'] = '';
      if (!ep) {
        this.put(epT, { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: svc.metadata.name, namespace: ns, uid: U.uid(), creationTimestamp: U.iso(this.now()), labels, annotations: { 'endpoints.kubernetes.io/last-change-trigger-time': U.iso(this.now()) } }, ...(subsets.length ? { subsets } : {}) }, 'ADDED');
      } else if (JSON.stringify(ep.subsets || []) !== JSON.stringify(subsets)) {
        if (subsets.length) ep.subsets = subsets;
        else delete ep.subsets;
        ep.metadata.annotations = { ...(ep.metadata.annotations || {}), 'endpoints.kubernetes.io/last-change-trigger-time': U.iso(this.now()) };
        this.put(epT, ep);
      }
      // EndpointSlice
      const esName = (this.misc['es' + svc.metadata.uid] = this.misc['es' + svc.metadata.uid] || `${svc.metadata.name}-${U.rand(5)}`);
      const es = this.raw(esT, ns, esName);
      const esPorts = ports.map((sp) => ({ name: sp.name || '', port: pods.length ? this.namedPort(pods[0], sp.targetPort ?? sp.port) : null, protocol: sp.protocol || 'TCP' }));
      const body = { addressType: 'IPv4', endpoints: esEndpoints.length ? esEndpoints : null, ports: pods.length ? esPorts : null };
      if (!es) {
        this.put(esT, {
          apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice',
          metadata: { name: esName, generateName: svc.metadata.name + '-', namespace: ns, uid: U.uid(), creationTimestamp: U.iso(this.now()), generation: 1, labels: { ...labels, 'endpointslice.kubernetes.io/managed-by': 'endpointslice-controller.k8s.io', 'kubernetes.io/service-name': svc.metadata.name }, annotations: { 'endpoints.kubernetes.io/last-change-trigger-time': U.iso(this.now()) }, ownerReferences: [{ ...this.ownerRef(svc) }] },
          ...body,
        }, 'ADDED');
      } else if (JSON.stringify({ a: es.addressType, e: es.endpoints, p: es.ports }) !== JSON.stringify({ a: body.addressType, e: body.endpoints, p: body.ports })) {
        Object.assign(es, body);
        es.metadata.generation = (es.metadata.generation || 1) + 1;
        this.put(esT, es);
      }
    }
    // remove endpoints órfãos gerenciados
    for (const ep of this.rawList(epT)) {
      const svc = this.raw(svcT, ep.metadata.namespace, ep.metadata.name);
      if (!svc && (ep.metadata.annotations || {})['endpoints.kubernetes.io/last-change-trigger-time']) this.removeRaw(epT, ep);
    }
  };

  // ---------- Services (LoadBalancer) ----------
  C.ctlServices = function () {
    const svcT = T('services');
    const now = this.now();
    for (const svc of this.rawList(svcT)) {
      if (svc.spec.type !== 'LoadBalancer') {
        if (svc.status && svc.status.loadBalancer && svc.status.loadBalancer.ingress) { svc.status.loadBalancer = {}; this.put(svcT, svc); }
        continue;
      }
      if (svc.status.loadBalancer && svc.status.loadBalancer.ingress) continue;
      const k = 'lb' + svc.metadata.uid;
      if (!this.misc[k]) {
        this.misc[k] = now;
        this.event(svc, 'Normal', 'EnsuringLoadBalancer', 'Ensuring load balancer', 'service-controller');
        continue;
      }
      if (now - this.misc[k] < 2500) continue;
      this.misc.lbCounter = (this.misc.lbCounter || 0) + 1;
      svc.status.loadBalancer = { ingress: [{ ip: `172.18.255.${199 + this.misc.lbCounter}`, ipMode: 'VIP' }] };
      this.put(svcT, svc);
      this.event(svc, 'Normal', 'EnsuredLoadBalancer', 'Ensured load balancer', 'service-controller');
    }
  };
  C.ctlIngress = function () {
    const ingT = T('ingresses.networking.k8s.io');
    const now = this.now();
    const ctrlReady = this.rawList(T('pods'), 'ingress-nginx').some((p) => this.isReady(p));
    for (const ing of this.rawList(ingT)) {
      if (ing.spec.ingressClassName !== 'nginx' || !ctrlReady) continue;
      const k = 'ing' + ing.metadata.uid + ing.metadata.generation;
      if (!this.misc[k]) {
        this.misc[k] = now;
        this.event(ing, 'Normal', 'Sync', 'Scheduled for sync', 'nginx-ingress-controller');
        continue;
      }
      if (now - this.misc[k] < 3000) continue;
      if (!(ing.status.loadBalancer && ing.status.loadBalancer.ingress)) {
        ing.status = { loadBalancer: { ingress: [{ hostname: 'localhost' }] } };
        this.put(ingT, ing);
      }
    }
  };

  // ---------- métricas ----------
  C.loadOn = function (pod) {
    // soma de clientes gerando carga contínua contra serviços que selecionam este pod
    let clients = 0;
    for (const p of this.rawList(T('pods'))) {
      if (p === pod || p.status.phase !== 'Running') continue;
      const r = this.rt[p.metadata.uid];
      if (!r) continue;
      for (const rec of Object.values(r.cs || {})) {
        if (rec.stage !== 'running') continue;
        const run = rec.runs[rec.runs.length - 1];
        if (!run.load || !run.load.length || run.exitAt) continue;
        for (const url of run.load) {
          const host = url.replace(/^https?:\/\//, '').split(/[/:]/)[0];
          const res = this.resolve(host, p.metadata.namespace);
          if (!res || !res.svc) continue;
          const eps = this.readyEndpoints(res.svc);
          if (eps.some((e) => e.metadata.uid === pod.metadata.uid)) clients += 1 / eps.length;
        }
      }
    }
    return clients;
  };
  C.podMetrics = function (p) {
    if (p.status.phase !== 'Running') return null;
    const r = this.rt[p.metadata.uid];
    if (!r) return null;
    const now = this.now();
    const out = [];
    const window = Math.floor(now / 15000);
    const clients = this.loadOn(p);
    for (const c of p.spec.containers) {
      const rec = (r.cs || {})[c.name];
      if (!rec || rec.stage !== 'running') continue;
      const run = rec.runs[rec.runs.length - 1];
      if (now - run.start < 15000) continue;
      const prof = IM.profile(c.image);
      const jitter = 0.75 + U.seeded(p.metadata.uid + c.name + window) * 0.5;
      let cpu = (run.cpu ?? prof.cpu) * jitter;
      cpu += clients * (prof.cpuPerClient || 60) * (0.9 + U.seeded('l' + window + p.metadata.uid) * 0.2);
      const lim = U.cpuMilli(((c.resources || {}).limits || {}).cpu || 0);
      if (lim) cpu = Math.min(cpu, lim);
      let mem = run.mem ?? prof.mem * MiB * (0.95 + U.seeded(p.metadata.uid + 'm') * 0.1);
      mem += Math.min(40 * MiB, (now - run.start) / 1000 / 3600 * 2 * MiB);
      if (clients) mem += 4 * MiB;
      out.push({ name: c.name, cpu: cpu / 1000, mem });
    }
    if (!out.length) return null;
    return out;
  };
  C.nodeUsage = function (name) {
    let cpu = 0, mem = 0;
    for (const p of this.rawList(T('pods'))) {
      if (p.spec.nodeName !== name) continue;
      const m = this.podMetrics(p);
      if (m) for (const c of m) { cpu += c.cpu; mem += c.mem; }
    }
    const cp = name.includes('control-plane');
    const w = Math.floor(this.now() / 15000);
    cpu += (cp ? 0.09 : 0.025) * (0.8 + U.seeded(name + w) * 0.4);
    mem += (cp ? 520 : 190) * MiB * (0.97 + U.seeded(name + 'm' + w) * 0.06);
    return { cpu, mem };
  };

  // ---------- HPA ----------
  C.ctlHPA = function () {
    const hT = T('horizontalpodautoscalers.autoscaling');
    const now = this.now();
    this.misc.hpa = this.misc.hpa || {};
    for (const h of this.rawList(hT)) {
      const ns = h.metadata.namespace;
      const st = this.misc.hpa[h.metadata.uid] = this.misc.hpa[h.metadata.uid] || { last: 0, recs: [] };
      if (now - st.last < 15000 && st.last) continue;
      st.last = now;
      const before = JSON.stringify(h);
      const ref = h.spec.scaleTargetRef;
      const tt = S.types.find((t) => t.kind === ref.kind && (!ref.apiVersion || t.apiVersion === ref.apiVersion || (ref.apiVersion || '').split('/')[0] === t.group));
      const target = tt ? this.raw(tt, ns, ref.name) : null;
      let conds = h.status.conditions || [];
      if (!target) {
        conds = setCond(conds, now, 'AbleToScale', 'False', 'FailedGetScale', `the HPA controller was unable to get the target's current scale: ${tt ? tt.qualified : ref.kind.toLowerCase() + 's'} "${ref.name}" not found`);
        this.throttleEvent(h, 'noscale', 60000, () => this.event(h, 'Warning', 'FailedGetScale', `${tt ? tt.qualified : ref.kind.toLowerCase()} "${ref.name}" not found`, 'horizontal-pod-autoscaler'));
        h.status = { ...h.status, conditions: conds };
        this.saveIfChanged(hT, h, before);
        continue;
      }
      conds = setCond(conds, now, 'AbleToScale', 'True', 'SucceededGetScale', 'the HPA controller was able to get the target\'s current scale');
      const cur = target.spec.replicas;
      const pods = this.rawList(T('pods'), ns).filter((p) => U.matchSelector(target.spec.selector, p.metadata.labels) && this.isActive(p));
      const metricsOut = [];
      let desired = null, failed = null;
      for (const m of h.spec.metrics || []) {
        if (m.type !== 'Resource' && m.type !== 'ContainerResource') continue;
        const res = (m.resource || m.containerResource).name;
        const tgt = (m.resource || m.containerResource).target;
        let usage = 0, reqs = 0, n = 0, missingReq = null;
        for (const p of pods) {
          const pm = this.podMetrics(p);
          if (!pm) continue;
          n++;
          for (const c of p.spec.containers) {
            const cm = pm.find((x) => x.name === c.name);
            if (!cm) continue;
            usage += res === 'cpu' ? cm.cpu * 1000 : cm.mem;
            const rq = ((c.resources || {}).requests || {})[res];
            if (rq === undefined) missingReq = missingReq || `missing request for ${res} in container ${c.name} of Pod ${p.metadata.name}`;
            else reqs += res === 'cpu' ? U.cpuMilli(rq) : U.parseQuantity(rq);
          }
        }
        if (!this.metricsAvailable() || !n) {
          failed = `failed to get ${res} utilization: unable to get metrics for resource ${res}: no metrics returned from resource metrics API`;
          metricsOut.push({ type: 'Resource', resource: { name: res, current: {} } });
          continue;
        }
        if (tgt.type === 'Utilization') {
          if (missingReq) { failed = `failed to get ${res} utilization: ${missingReq}`; metricsOut.push({ type: 'Resource', resource: { name: res, current: {} } }); continue; }
          const util = Math.round((usage / reqs) * 100);
          metricsOut.push({ type: 'Resource', resource: { name: res, current: { averageUtilization: util, averageValue: res === 'cpu' ? Math.round(usage / n) + 'm' : Math.round(usage / n / 1024) + 'Ki' } } });
          const ratio = util / tgt.averageUtilization;
          const d = Math.abs(1 - ratio) <= 0.1 ? cur : Math.ceil(n * ratio);
          desired = Math.max(desired ?? 0, d);
        } else {
          const avg = usage / n;
          const tv = res === 'cpu' ? U.cpuMilli(tgt.averageValue) : U.parseQuantity(tgt.averageValue);
          metricsOut.push({ type: 'Resource', resource: { name: res, current: { averageValue: res === 'cpu' ? Math.round(avg) + 'm' : Math.round(avg / 1024) + 'Ki' } } });
          const ratio = avg / tv;
          const d = Math.abs(1 - ratio) <= 0.1 ? cur : Math.ceil(n * ratio);
          desired = Math.max(desired ?? 0, d);
        }
      }
      let newReplicas = cur;
      if (failed && desired === null) {
        conds = setCond(conds, now, 'ScalingActive', 'False', 'FailedGetResourceMetric', `the HPA was unable to compute the replica count: ${failed}`);
        this.throttleEvent(h, 'fm', 60000, () => {
          this.event(h, 'Warning', 'FailedGetResourceMetric', failed, 'horizontal-pod-autoscaler');
          this.event(h, 'Warning', 'FailedComputeMetricsReplicas', `invalid metrics (1 invalid out of 1), first error is: ${failed}`, 'horizontal-pod-autoscaler');
        });
      } else if (desired !== null) {
        conds = setCond(conds, now, 'ScalingActive', 'True', 'ValidMetricFound', 'the HPA was able to successfully calculate a replica count from cpu resource utilization (percentage of request)');
        st.recs.push({ t: now, d: desired });
        const win = ((((h.spec.behavior || {}).scaleDown || {}).stabilizationWindowSeconds) ?? 300) * 1000;
        st.recs = st.recs.filter((x) => now - x.t <= Math.max(win, 1000));
        let rec = desired;
        if (desired < cur) rec = Math.max(...st.recs.map((x) => x.d), desired);
        if (rec > cur) rec = Math.min(rec, Math.max(cur * 2, cur + 4));
        const min = h.spec.minReplicas ?? 1, max = h.spec.maxReplicas;
        const clamped = Math.min(max, Math.max(min, rec));
        conds = setCond(conds, now, 'ScalingLimited', clamped !== rec ? 'True' : 'False', clamped !== rec ? (rec > max ? 'TooManyReplicas' : 'TooFewReplicas') : 'DesiredWithinRange', clamped !== rec ? `the desired replica count is ${rec > max ? 'more' : 'less'} than the ${rec > max ? 'maximum' : 'minimum'} replica count` : 'the desired count is within the acceptable range');
        newReplicas = clamped;
        if (cur === 0) newReplicas = cur;
        if (newReplicas !== cur) {
          target.spec.replicas = newReplicas;
          target.metadata.generation = (target.metadata.generation || 1) + 1;
          this.put(tt, target);
          const util = metricsOut[0] && metricsOut[0].resource.current.averageUtilization;
          this.event(h, 'Normal', 'SuccessfulRescale', `New size: ${newReplicas}; reason: ${newReplicas > cur ? `cpu resource utilization (percentage of request) above target` : 'All metrics below target'}`, 'horizontal-pod-autoscaler');
          h.status.lastScaleTime = U.iso(now);
          void util;
        }
      }
      conds.sort((a, b) => ['AbleToScale', 'ScalingActive', 'ScalingLimited'].indexOf(a.type) - ['AbleToScale', 'ScalingActive', 'ScalingLimited'].indexOf(b.type));
      h.status = { conditions: conds, currentMetrics: metricsOut, currentReplicas: cur, desiredReplicas: newReplicas, ...(h.status.lastScaleTime ? { lastScaleTime: h.status.lastScaleTime } : {}) };
      this.saveIfChanged(hT, h, before);
    }
  };

  // ---------- nós ----------
  C.ctlNodeLifecycle = function () {
    const nT = T('nodes'), pT = T('pods');
    const now = this.now();
    for (const n of this.rawList(nT)) {
      const before = JSON.stringify(n);
      // taint de unschedulable acompanha spec.unschedulable
      const taints = (n.spec.taints || []).filter((t) => t.key !== 'node.kubernetes.io/unschedulable');
      if (n.spec.unschedulable) taints.push({ effect: 'NoSchedule', key: 'node.kubernetes.io/unschedulable', timeAdded: (n.spec.taints || []).find((t) => t.key === 'node.kubernetes.io/unschedulable')?.timeAdded || U.iso(now) });
      if (taints.length) n.spec.taints = taints;
      else delete n.spec.taints;
      // heartbeats a cada ~40s
      const hb = (n.status.conditions || [])[0];
      if (hb && now - U.ms(hb.lastHeartbeatTime) > 40000) for (const c of n.status.conditions) c.lastHeartbeatTime = U.iso(now);
      n.status.images = (this.nodeImages[n.metadata.name] || []).map((img) => {
        const ref = IM.parseRef(img);
        return { names: [IM.imageID(img), `${ref.registry}/${ref.path}:${ref.tag || 'latest'}`], sizeBytes: IM.profile(img).sizeBytes };
      });
      this.saveIfChanged(nT, n, before);
      // NoExecute
      for (const t of n.spec.taints || []) {
        if (t.effect !== 'NoExecute') continue;
        for (const p of this.rawList(pT)) {
          if (p.spec.nodeName !== n.metadata.name || p.metadata.deletionTimestamp) continue;
          const tol = (p.spec.tolerations || []).find((x) => this.tolerates([x], t));
          if (tol && tol.tolerationSeconds === undefined) continue;
          const added = U.ms(t.timeAdded) || now;
          if (tol && now - added < tol.tolerationSeconds * 1000) continue;
          this.event(p, 'Normal', 'TaintManagerEviction', `Marking for deletion Pod ${p.metadata.namespace}/${p.metadata.name}`, 'taint-eviction-controller');
          p.status.conditions = setCond(p.status.conditions, now, 'DisruptionTarget', 'True', 'DeletionByTaintManager', 'Taint manager: deleting due to NoExecute taint');
          this.put(pT, p);
          this.delete(pT, p.metadata.namespace, p.metadata.name, {}, SYSTEM);
        }
      }
      if ((n.spec.taints || []).some((t) => !t.timeAdded && t.effect === 'NoExecute')) {
        for (const t of n.spec.taints) if (t.effect === 'NoExecute' && !t.timeAdded) t.timeAdded = U.iso(now);
        this.put(nT, n);
      }
    }
  };

  // ---------- PDB / Quota / CSR / eventos ----------
  C.ctlPDB = function () {
    const t = T('poddisruptionbudgets.policy');
    for (const pdb of this.rawList(t)) {
      const before = JSON.stringify(pdb);
      const pods = this.rawList(T('pods'), pdb.metadata.namespace).filter((p) => U.matchSelector(pdb.spec.selector, p.metadata.labels) && !p.metadata.deletionTimestamp);
      const healthy = pods.filter((p) => this.isReady(p)).length;
      const expected = pods.length;
      let desired;
      if (pdb.spec.minAvailable !== undefined) desired = U.intOrPercent(pdb.spec.minAvailable, expected, true);
      else if (pdb.spec.maxUnavailable !== undefined) desired = Math.max(0, expected - U.intOrPercent(pdb.spec.maxUnavailable, expected, true));
      else desired = expected;
      const allowed = Math.max(0, healthy - desired);
      pdb.status = {
        conditions: setCond(pdb.status.conditions, this.now(), 'DisruptionAllowed', allowed > 0 ? 'True' : 'False', allowed > 0 ? 'SufficientPods' : 'InsufficientPods', ''),
        currentHealthy: healthy, desiredHealthy: desired, disruptionsAllowed: allowed, expectedPods: expected, observedGeneration: pdb.metadata.generation,
      };
      pdb.status.conditions.forEach((c) => { c.observedGeneration = pdb.metadata.generation; });
      this.saveIfChanged(t, pdb, before);
    }
  };
  C.ctlQuota = function () {
    const t = T('resourcequotas');
    for (const q of this.rawList(t)) {
      const before = JSON.stringify(q);
      const used = this.quotaUsed(q.metadata.namespace);
      const hard = (q.spec && q.spec.hard) || {};
      const u = {};
      for (const k of Object.keys(hard)) {
        const v = used[k] || 0;
        u[k] = /cpu/.test(k) ? U.fmtCPU(Math.round(v * 1000)) || '0' : /memory|storage/.test(k) ? (v ? U.fmtMem(v) : '0') : String(v);
        if (/cpu/.test(k) && !v) u[k] = '0';
      }
      q.status = { hard: { ...hard }, used: u };
      this.saveIfChanged(t, q, before);
    }
  };
  C.ctlCSR = function () {
    const t = T('certificatesigningrequests.certificates.k8s.io');
    for (const csr of this.rawList(t)) {
      const approved = (csr.status.conditions || []).some((c) => c.type === 'Approved');
      if (!approved || csr.status.certificate) continue;
      if (!['kubernetes.io/kube-apiserver-client', 'kubernetes.io/kube-apiserver-client-kubelet', 'kubernetes.io/kubelet-serving'].includes(csr.spec.signerName)) continue;
      let subject = { CN: csr.spec.username, O: [] };
      try {
        const pem = U.b64d(csr.spec.request);
        const dec = U.b64d(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
        const m = dec.match(/SIMSUBJECT:([^:]+)/);
        if (m) subject = JSON.parse(U.b64d(m[1]));
      } catch (e) { /* CSR externo: usa o solicitante */ }
      const certBody = U.b64e('SIMCERT:' + U.b64e(JSON.stringify(subject)) + ':' + U.hex(300));
      const pem = '-----BEGIN CERTIFICATE-----\n' + certBody.match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n';
      csr.status.certificate = U.b64e(pem);
      this.put(t, csr);
    }
  };
  C.ctlEventsGC = function () {
    if ((this.misc.tickN || 0) % 40) return;
    const t = T('events');
    const now = this.now();
    for (const e of this.rawList(t)) if (now - U.ms(e.lastTimestamp || e.metadata.creationTimestamp) > 3600 * 1000) this.removeRaw(t, e);
  };

  // ---------- logs ----------
  C.podLogs = function (ns, name, o = {}) {
    const pT = T('pods');
    const pod = this.raw(pT, ns, name);
    if (!pod) throw KS.errors.notFound(pT, name);
    const all = [...pod.spec.containers, ...(pod.spec.initContainers || []), ...(pod.spec.ephemeralContainers || [])];
    let cname = o.container;
    if (!cname) {
      if (pod.spec.containers.length > 1 && !o.allowDefault) throw new KS.ApiError(400, 'BadRequest', `a container name must be specified for pod ${name}, choose one of: [${pod.spec.containers.map((c) => c.name).join(' ')}]${(pod.spec.initContainers || []).length ? ` or one of the init containers: [${pod.spec.initContainers.map((c) => c.name).join(' ')}]` : ''}`);
      cname = pod.spec.containers[0].name;
    }
    const c = all.find((x) => x.name === cname);
    if (!c) throw new KS.ApiError(400, 'BadRequest', `container ${cname} is not valid for pod ${name}`);
    const r = this.rt[pod.metadata.uid] || {};
    const rec = (r.cs || {})[cname] || (r.ics || {})[cname] || (r.ecs || {})[cname];
    const now = this.now();
    if (!rec || !rec.runs.length) {
      const why = !rec || rec.stage === 'init' || rec.stage === 'pulling' || rec.stage === 'create'
        ? (rec && rec.reason === 'CreateContainerConfigError' ? 'CreateContainerConfigError' : (pod.spec.initContainers || []).length && !(r.initIdx >= pod.spec.initContainers.length) && !(r.ics || {})[cname] ? 'PodInitializing' : 'ContainerCreating')
        : rec.reason === 'ImagePullBackOff' ? 'trying and failing to pull image' : rec.reason === 'ErrImagePull' ? 'image can\'t be pulled' : rec.reason;
      throw new KS.ApiError(400, 'BadRequest', `container "${cname}" in pod "${name}" is waiting to start: ${why}`);
    }
    let run;
    if (o.previous) {
      const idx = rec.stage === 'running' || rec.stage === 'create' ? rec.runs.length - 2 : rec.stage === 'backoff' ? rec.runs.length - 1 : rec.runs.length - 2;
      run = rec.runs[idx];
      if (!run || (rec.stage === 'backoff' && rec.restartCount === 0 && idx === rec.runs.length - 1 && false)) throw new KS.ApiError(400, 'BadRequest', `previous terminated container "${cname}" in pod "${name}" not found`);
    } else run = rec.runs[rec.runs.length - 1];
    const end = run.end ?? now;
    const horizon = Math.max(0, (end - run.start) / 1000);
    const ctx = this.containerCtx(pod, c, run.env || {}, run.start);
    const sim = IM.run({ ...c, image: rec.image || c.image }, ctx, horizon, { maxLines: 20000 });
    let lines = sim.logs.map((l) => ({ t: run.start + l.t * 1000, line: l.line }));
    if (run.reason === 'StartError') lines = [];
    if (run.extra) lines = lines.concat(run.extra).sort((a, b) => a.t - b.t);
    if (o.sinceSeconds) lines = lines.filter((l) => l.t >= now - o.sinceSeconds * 1000);
    if (o.sinceTime) lines = lines.filter((l) => l.t >= U.ms(o.sinceTime));
    if (o.tail !== undefined && o.tail >= 0) lines = o.tail === 0 ? [] : lines.slice(-o.tail);
    const fmt = (l) => (o.timestamps ? new Date(l.t).toISOString().replace('Z', '') + String(Math.floor(U.seeded(l.line) * 1e6)).padStart(6, '0') + 'Z ' : '') + l.line;
    const out = lines.map(fmt);
    out.lastT = lines.length ? lines[lines.length - 1].t : run.start;
    out.run = run;
    out.rec = rec;
    return out;
  };

  // ---------- bootstrap ----------
  C.bootstrap = function () {
    const boot = Date.now() - 47 * 60 * 1000 - 13 * 1000;
    this.fakeNow = boot;
    const put = (obj) => this.create(obj, SYSTEM);
    const nsList = ['default', 'kube-system', 'kube-public', 'kube-node-lease', 'local-path-storage', 'ingress-nginx'];
    for (const n of nsList) put({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: n, ...(n === 'ingress-nginx' ? { labels: { 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' } } : {}) } });
    // prioridades
    put({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-cluster-critical' }, value: 2000000000, description: 'Used for system critical pods that must run in the cluster, but can be moved to another node if necessary.' });
    put({ apiVersion: 'scheduling.k8s.io/v1', kind: 'PriorityClass', metadata: { name: 'system-node-critical' }, value: 2000001000, description: 'Used for system critical pods that must not be moved from their current node.' });
    // nós
    const mkNode = (name, ip, cidr, cp) => ({
      apiVersion: 'v1', kind: 'Node',
      metadata: {
        name,
        labels: { 'beta.kubernetes.io/arch': 'amd64', 'beta.kubernetes.io/os': 'linux', 'kubernetes.io/arch': 'amd64', 'kubernetes.io/hostname': name, 'kubernetes.io/os': 'linux', ...(cp ? { 'node-role.kubernetes.io/control-plane': '', 'node.kubernetes.io/exclude-from-external-load-balancers': '' } : {}) },
        annotations: { 'kubeadm.alpha.kubernetes.io/cri-socket': 'unix:///run/containerd/containerd.sock', 'node.alpha.kubernetes.io/ttl': '0', 'volumes.kubernetes.io/controller-managed-attach-detach': 'true' },
      },
      spec: { podCIDR: cidr, podCIDRs: [cidr], providerID: `kind://docker/sim/${name}`, ...(cp ? { taints: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }] } : {}) },
      status: {
        addresses: [{ address: ip, type: 'InternalIP' }, { address: name, type: 'Hostname' }],
        allocatable: { cpu: '4', 'ephemeral-storage': '61202244Ki', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: '8024128Ki', pods: '110' },
        capacity: { cpu: '4', 'ephemeral-storage': '61202244Ki', 'hugepages-1Gi': '0', 'hugepages-2Mi': '0', memory: '8024128Ki', pods: '110' },
        conditions: [
          { lastHeartbeatTime: U.iso(boot), lastTransitionTime: U.iso(boot), message: 'kubelet has sufficient memory available', reason: 'KubeletHasSufficientMemory', status: 'False', type: 'MemoryPressure' },
          { lastHeartbeatTime: U.iso(boot), lastTransitionTime: U.iso(boot), message: 'kubelet has no disk pressure', reason: 'KubeletHasNoDiskPressure', status: 'False', type: 'DiskPressure' },
          { lastHeartbeatTime: U.iso(boot), lastTransitionTime: U.iso(boot), message: 'kubelet has sufficient PID available', reason: 'KubeletHasSufficientPID', status: 'False', type: 'PIDPressure' },
          { lastHeartbeatTime: U.iso(boot), lastTransitionTime: U.iso(boot + (cp ? 21000 : 34000)), message: 'kubelet is posting ready status', reason: 'KubeletReady', status: 'True', type: 'Ready' },
        ],
        daemonEndpoints: { kubeletEndpoint: { Port: 10250 } },
        nodeInfo: { architecture: 'amd64', bootID: U.uid(), containerRuntimeVersion: 'containerd://1.7.18', kernelVersion: '6.10.14-linuxkit', kubeProxyVersion: 'v1.31.0', kubeletVersion: 'v1.31.0', machineID: U.hex(32), operatingSystem: 'linux', osImage: 'Debian GNU/Linux 12 (bookworm)', systemUUID: U.uid() },
      },
    });
    const nodes = [mkNode('sim-control-plane', '172.18.0.2', '10.244.0.0/24', true), mkNode('sim-worker', '172.18.0.3', '10.244.1.0/24'), mkNode('sim-worker2', '172.18.0.4', '10.244.2.0/24')];
    for (const n of nodes) {
      const st = n.status;
      const o = put(n);
      const raw = this.raw(T('nodes'), '', o.metadata.name);
      raw.status = st;
      this.put(T('nodes'), raw);
      this.misc.ipCounters[n.metadata.name] = 1;
    }
    // imagens pré-carregadas (kind)
    const sysImgs = ['registry.k8s.io/kube-proxy:v1.31.0', 'docker.io/kindest/kindnetd:v20240813-c6f155d6', 'registry.k8s.io/pause:3.10'];
    for (const n of nodes) this.nodeImages[n.metadata.name] = [...sysImgs];
    this.nodeImages['sim-control-plane'].push('registry.k8s.io/etcd:3.5.15-0', 'registry.k8s.io/kube-apiserver:v1.31.0', 'registry.k8s.io/kube-controller-manager:v1.31.0', 'registry.k8s.io/kube-scheduler:v1.31.0', 'registry.k8s.io/coredns/coredns:v1.11.3', 'docker.io/kindest/local-path-provisioner:v20240813-c6f155d6', 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', 'registry.k8s.io/ingress-nginx/controller:v1.11.2');
    // RBAC
    this.bootstrapRBAC(put);
    // ServiceAccounts de controllers
    for (const sa of ['attachdetach-controller', 'bootstrap-signer', 'certificate-controller', 'clusterrole-aggregation-controller', 'coredns', 'cronjob-controller', 'daemon-set-controller', 'deployment-controller', 'disruption-controller', 'endpoint-controller', 'endpointslice-controller', 'endpointslicemirroring-controller', 'ephemeral-volume-controller', 'expand-controller', 'generic-garbage-collector', 'horizontal-pod-autoscaler', 'job-controller', 'kindnet', 'kube-proxy', 'legacy-service-account-token-cleaner', 'metrics-server', 'namespace-controller', 'node-controller', 'persistent-volume-binder', 'pod-garbage-collector', 'pv-protection-controller', 'pvc-protection-controller', 'replicaset-controller', 'replication-controller', 'resourcequota-controller', 'root-ca-cert-publisher', 'service-account-controller', 'service-cidrs-controller', 'statefulset-controller', 'token-cleaner', 'ttl-after-finished-controller', 'ttl-controller', 'validatingadmissionpolicy-status-controller'])
      put({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: sa, namespace: 'kube-system' } });
    put({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'local-path-provisioner-service-account', namespace: 'local-path-storage' } });
    put({ apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'ingress-nginx', namespace: 'ingress-nginx', labels: { 'app.kubernetes.io/name': 'ingress-nginx' } } });
    // ConfigMaps
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'coredns', namespace: 'kube-system' }, data: { Corefile: '.:53 {\n    errors\n    health {\n       lameduck 5s\n    }\n    ready\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n       pods insecure\n       fallthrough in-addr.arpa ip6.arpa\n       ttl 30\n    }\n    prometheus :9153\n    forward . /etc/resolv.conf {\n       max_concurrent 1000\n    }\n    cache 30\n    loop\n    reload\n    loadbalance\n}\n' } });
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kube-proxy', namespace: 'kube-system', labels: { app: 'kube-proxy' } }, data: { 'config.conf': 'apiVersion: kubeproxy.config.k8s.io/v1alpha1\nbindAddress: 0.0.0.0\nclusterCIDR: 10.244.0.0/16\nkind: KubeProxyConfiguration\nmode: iptables\n', 'kubeconfig.conf': 'apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority: /var/lib/kube-proxy/ca.crt\n    server: https://sim-control-plane:6443\n  name: default\n' } });
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kubeadm-config', namespace: 'kube-system' }, data: { ClusterConfiguration: 'apiServer:\n  certSANs:\n  - localhost\n  - 127.0.0.1\napiVersion: kubeadm.k8s.io/v1beta3\nclusterName: sim\ncontrolPlaneEndpoint: sim-control-plane:6443\nkind: ClusterConfiguration\nkubernetesVersion: v1.31.0\nnetworking:\n  dnsDomain: cluster.local\n  podSubnet: 10.244.0.0/16\n  serviceSubnet: 10.96.0.0/16\n' } });
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'kubelet-config', namespace: 'kube-system' }, data: { kubelet: 'apiVersion: kubelet.config.k8s.io/v1beta1\nauthentication:\n  anonymous:\n    enabled: false\ncgroupDriver: systemd\nclusterDNS:\n- 10.96.0.10\nclusterDomain: cluster.local\nkind: KubeletConfiguration\nstaticPodPath: /etc/kubernetes/manifests\n' } });
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'extension-apiserver-authentication', namespace: 'kube-system' }, data: { 'client-ca-file': KS.CA_CRT, 'requestheader-allowed-names': '["front-proxy-client"]', 'requestheader-extra-headers-prefix': '["X-Remote-Extra-"]', 'requestheader-group-headers': '["X-Remote-Group"]', 'requestheader-username-headers': '["X-Remote-User"]' } });
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'cluster-info', namespace: 'kube-public' }, data: { kubeconfig: `apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: ${U.b64e(KS.CA_CRT)}\n    server: https://sim-control-plane:6443\n  name: ""\ncontexts: null\ncurrent-context: ""\nkind: Config\npreferences: {}\nusers: null\n` } });
    put({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'local-path-config', namespace: 'local-path-storage' }, data: { 'config.json': '{\n        "nodePathMap":[\n        {\n                "node":"DEFAULT_PATH_FOR_NON_LISTED_NODES",\n                "paths":["/var/local-path-provisioner"]\n        }\n        ]\n}', 'helperPod.yaml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: helper-pod\nspec:\n  containers:\n  - name: helper-pod\n    image: docker.io/kindest/local-path-helper:v20230510-486859a6\n    imagePullPolicy: IfNotPresent', setup: '#!/bin/sh\nset -eu\nmkdir -m 0777 -p "$VOL_DIR"', teardown: '#!/bin/sh\nset -eu\nrm -rf "$VOL_DIR"' } });
    put({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'bootstrap-token-abcdef', namespace: 'kube-system' }, type: 'bootstrap.kubernetes.io/token', data: { 'auth-extra-groups': U.b64e('system:bootstrappers:kubeadm:default-node-token'), expiration: U.b64e(U.iso(boot + 86400000)), 'token-id': U.b64e('abcdef'), 'token-secret': U.b64e('0123456789abcdef'), 'usage-bootstrap-authentication': U.b64e('true'), 'usage-bootstrap-signing': U.b64e('true') } });
    // StorageClass, IngressClass, CSI
    put({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', volumeBindingMode: 'WaitForFirstConsumer' });
    put({ apiVersion: 'networking.k8s.io/v1', kind: 'IngressClass', metadata: { name: 'nginx', labels: { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' }, annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' } }, spec: { controller: 'k8s.io/ingress-nginx' } });
    for (const n of nodes) put({ apiVersion: 'storage.k8s.io/v1', kind: 'CSINode', metadata: { name: n.metadata.name }, spec: { drivers: null } });
    // Services
    const svc = (name, ns, spec, labels) => {
      const o = put({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels }, spec });
      return o;
    };
    svc('kubernetes', 'default', { clusterIP: '10.96.0.1', ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 6443 }] }, { component: 'apiserver', provider: 'kubernetes' });
    this.put(T('endpoints'), { apiVersion: 'v1', kind: 'Endpoints', metadata: { name: 'kubernetes', namespace: 'default', uid: U.uid(), creationTimestamp: U.iso(boot), labels: { 'endpointslice.kubernetes.io/skip-mirror': 'true' } }, subsets: [{ addresses: [{ ip: '172.18.0.2' }], ports: [{ name: 'https', port: 6443, protocol: 'TCP' }] }] }, 'ADDED');
    this.put(T('endpointslices.discovery.k8s.io'), { apiVersion: 'discovery.k8s.io/v1', kind: 'EndpointSlice', metadata: { name: 'kubernetes', namespace: 'default', uid: U.uid(), creationTimestamp: U.iso(boot), generation: 1, labels: { 'kubernetes.io/service-name': 'kubernetes' } }, addressType: 'IPv4', endpoints: [{ addresses: ['172.18.0.2'], conditions: { ready: true } }], ports: [{ name: 'https', port: 6443, protocol: 'TCP' }] }, 'ADDED');
    svc('kube-dns', 'kube-system', { clusterIP: '10.96.0.10', selector: { 'k8s-app': 'kube-dns' }, ports: [{ name: 'dns', port: 53, protocol: 'UDP', targetPort: 53 }, { name: 'dns-tcp', port: 53, protocol: 'TCP', targetPort: 53 }, { name: 'metrics', port: 9153, protocol: 'TCP', targetPort: 9153 }] }, { 'k8s-app': 'kube-dns', 'kubernetes.io/cluster-service': 'true', 'kubernetes.io/name': 'CoreDNS' });
    this.raw(T('services'), 'kube-system', 'kube-dns').metadata.annotations = { 'prometheus.io/port': '9153', 'prometheus.io/scrape': 'true' };
    svc('metrics-server', 'kube-system', { selector: { 'k8s-app': 'metrics-server' }, ports: [{ name: 'https', port: 443, protocol: 'TCP', targetPort: 'https' }] }, { 'k8s-app': 'metrics-server' });
    svc('ingress-nginx-controller', 'ingress-nginx', { type: 'NodePort', selector: { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' }, ports: [{ appProtocol: 'http', name: 'http', port: 80, protocol: 'TCP', targetPort: 'http' }, { appProtocol: 'https', name: 'https', port: 443, protocol: 'TCP', targetPort: 'https' }] }, { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' });
    svc('ingress-nginx-controller-admission', 'ingress-nginx', { selector: { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' }, ports: [{ appProtocol: 'https', name: 'https-webhook', port: 443, targetPort: 'webhook' }] }, { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' });
    // Workloads do sistema
    const crit = { priorityClassName: 'system-cluster-critical' };
    put({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'coredns', namespace: 'kube-system', labels: { 'k8s-app': 'kube-dns' } },
      spec: {
        replicas: 2, selector: { matchLabels: { 'k8s-app': 'kube-dns' } }, strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: '25%', maxUnavailable: 1 } },
        template: {
          metadata: { labels: { 'k8s-app': 'kube-dns' } },
          spec: {
            ...crit, serviceAccountName: 'coredns', dnsPolicy: 'Default', nodeSelector: { 'kubernetes.io/os': 'linux' },
            tolerations: [{ key: 'CriticalAddonsOnly', operator: 'Exists' }, { effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane' }],
            affinity: { podAntiAffinity: { preferredDuringSchedulingIgnoredDuringExecution: [{ weight: 100, podAffinityTerm: { labelSelector: { matchExpressions: [{ key: 'k8s-app', operator: 'In', values: ['kube-dns'] }] }, topologyKey: 'kubernetes.io/hostname' } }] } },
            volumes: [{ name: 'config-volume', configMap: { name: 'coredns', items: [{ key: 'Corefile', path: 'Corefile' }] } }],
            containers: [{
              name: 'coredns', image: 'registry.k8s.io/coredns/coredns:v1.11.3', imagePullPolicy: 'IfNotPresent', args: ['-conf', '/etc/coredns/Corefile'],
              resources: { limits: { memory: '170Mi' }, requests: { cpu: '100m', memory: '70Mi' } },
              ports: [{ containerPort: 53, name: 'dns', protocol: 'UDP' }, { containerPort: 53, name: 'dns-tcp', protocol: 'TCP' }, { containerPort: 9153, name: 'metrics', protocol: 'TCP' }],
              volumeMounts: [{ mountPath: '/etc/coredns', name: 'config-volume', readOnly: true }],
              livenessProbe: { httpGet: { path: '/health', port: 8080, scheme: 'HTTP' }, initialDelaySeconds: 60, timeoutSeconds: 5, successThreshold: 1, failureThreshold: 5 },
              readinessProbe: { httpGet: { path: '/ready', port: 8181, scheme: 'HTTP' }, periodSeconds: 10 },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { add: ['NET_BIND_SERVICE'], drop: ['ALL'] }, readOnlyRootFilesystem: true },
            }],
          },
        },
      },
    });
    // coredns responde /health e /ready
    IM.catalog.coredns.ports = [53, 8080, 8181, 9153];
    IM.catalog.coredns.http = 'coredns';
    put({
      apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'kube-proxy', namespace: 'kube-system', labels: { 'k8s-app': 'kube-proxy' } },
      spec: {
        selector: { matchLabels: { 'k8s-app': 'kube-proxy' } },
        template: {
          metadata: { labels: { 'k8s-app': 'kube-proxy' } },
          spec: {
            priorityClassName: 'system-node-critical', serviceAccountName: 'kube-proxy', hostNetwork: true, nodeSelector: { 'kubernetes.io/os': 'linux' }, tolerations: [{ operator: 'Exists' }],
            volumes: [{ name: 'kube-proxy', configMap: { name: 'kube-proxy' } }, { name: 'xtables-lock', hostPath: { path: '/run/xtables.lock', type: 'FileOrCreate' } }, { name: 'lib-modules', hostPath: { path: '/lib/modules', type: '' } }],
            containers: [{
              name: 'kube-proxy', image: 'registry.k8s.io/kube-proxy:v1.31.0', imagePullPolicy: 'IfNotPresent', command: ['/usr/local/bin/kube-proxy', '--config=/var/lib/kube-proxy/config.conf', '--hostname-override=$(NODE_NAME)'],
              env: [{ name: 'NODE_NAME', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'spec.nodeName' } } }],
              securityContext: { privileged: true },
              volumeMounts: [{ mountPath: '/var/lib/kube-proxy', name: 'kube-proxy' }, { mountPath: '/run/xtables.lock', name: 'xtables-lock' }, { mountPath: '/lib/modules', name: 'lib-modules', readOnly: true }],
            }],
          },
        },
      },
    });
    put({
      apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'kindnet', namespace: 'kube-system', labels: { app: 'kindnet', 'k8s-app': 'kindnet', tier: 'node' } },
      spec: {
        selector: { matchLabels: { app: 'kindnet' } },
        template: {
          metadata: { labels: { app: 'kindnet', 'k8s-app': 'kindnet', tier: 'node' } },
          spec: {
            serviceAccountName: 'kindnet', hostNetwork: true, tolerations: [{ effect: 'NoSchedule', operator: 'Exists' }],
            volumes: [{ name: 'cni-cfg', hostPath: { path: '/etc/cni/net.d', type: '' } }, { name: 'xtables-lock', hostPath: { path: '/run/xtables.lock', type: 'FileOrCreate' } }, { name: 'lib-modules', hostPath: { path: '/lib/modules', type: '' } }],
            containers: [{
              name: 'kindnet-cni', image: 'docker.io/kindest/kindnetd:v20240813-c6f155d6', imagePullPolicy: 'IfNotPresent',
              env: [{ name: 'HOST_IP', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'status.hostIP' } } }, { name: 'POD_IP', valueFrom: { fieldRef: { apiVersion: 'v1', fieldPath: 'status.podIP' } } }, { name: 'POD_SUBNET', value: '10.244.0.0/16' }, { name: 'CONTROL_PLANE_ENDPOINT', value: 'sim-control-plane:6443' }],
              resources: { limits: { cpu: '100m', memory: '50Mi' }, requests: { cpu: '100m', memory: '50Mi' } },
              securityContext: { capabilities: { add: ['NET_RAW', 'NET_ADMIN'] }, privileged: false },
              volumeMounts: [{ mountPath: '/etc/cni/net.d', name: 'cni-cfg' }, { mountPath: '/run/xtables.lock', name: 'xtables-lock' }, { mountPath: '/lib/modules', name: 'lib-modules', readOnly: true }],
            }],
          },
        },
      },
    });
    IM.catalog.kindnetd.server = true;
    put({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'metrics-server', namespace: 'kube-system', labels: { 'k8s-app': 'metrics-server' } },
      spec: {
        replicas: 1, selector: { matchLabels: { 'k8s-app': 'metrics-server' } }, strategy: { rollingUpdate: { maxUnavailable: 0 } },
        template: {
          metadata: { labels: { 'k8s-app': 'metrics-server' } },
          spec: {
            ...crit, serviceAccountName: 'metrics-server', nodeSelector: { 'kubernetes.io/os': 'linux' },
            volumes: [{ name: 'tmp-dir', emptyDir: {} }],
            containers: [{
              name: 'metrics-server', image: 'registry.k8s.io/metrics-server/metrics-server:v0.7.2', imagePullPolicy: 'IfNotPresent',
              args: ['--cert-dir=/tmp', '--secure-port=10250', '--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname', '--kubelet-use-node-status-port', '--metric-resolution=15s', '--kubelet-insecure-tls'],
              ports: [{ containerPort: 10250, name: 'https', protocol: 'TCP' }],
              resources: { requests: { cpu: '100m', memory: '200Mi' } },
              volumeMounts: [{ mountPath: '/tmp', name: 'tmp-dir' }],
            }],
          },
        },
      },
    });
    put({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'local-path-provisioner', namespace: 'local-path-storage' },
      spec: {
        replicas: 1, selector: { matchLabels: { app: 'local-path-provisioner' } },
        template: {
          metadata: { labels: { app: 'local-path-provisioner' } },
          spec: {
            serviceAccountName: 'local-path-provisioner-service-account', nodeSelector: { 'kubernetes.io/os': 'linux' },
            tolerations: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane', operator: 'Equal' }],
            volumes: [{ name: 'config-volume', configMap: { name: 'local-path-config' } }],
            containers: [{
              name: 'local-path-provisioner', image: 'docker.io/kindest/local-path-provisioner:v20240813-c6f155d6', imagePullPolicy: 'IfNotPresent',
              command: ['local-path-provisioner', '--debug', 'start', '--helper-image', 'docker.io/kindest/local-path-helper:v20230510-486859a6', '--config', '/etc/config/config.json'],
              env: [{ name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } }],
              volumeMounts: [{ mountPath: '/etc/config/', name: 'config-volume' }],
            }],
          },
        },
      },
    });
    put({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ingress-nginx-controller', namespace: 'ingress-nginx', labels: { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/version': '1.11.2' } },
      spec: {
        replicas: 1, revisionHistoryLimit: 10, selector: { matchLabels: { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx' } },
        strategy: { rollingUpdate: { maxUnavailable: 1 }, type: 'RollingUpdate' },
        template: {
          metadata: { labels: { 'app.kubernetes.io/component': 'controller', 'app.kubernetes.io/instance': 'ingress-nginx', 'app.kubernetes.io/name': 'ingress-nginx', 'app.kubernetes.io/version': '1.11.2' } },
          spec: {
            serviceAccountName: 'ingress-nginx', nodeSelector: { 'ingress-ready': 'true', 'kubernetes.io/os': 'linux' }, terminationGracePeriodSeconds: 0,
            tolerations: [{ effect: 'NoSchedule', key: 'node-role.kubernetes.io/master', operator: 'Equal' }, { effect: 'NoSchedule', key: 'node-role.kubernetes.io/control-plane', operator: 'Equal' }],
            containers: [{
              name: 'controller', image: 'registry.k8s.io/ingress-nginx/controller:v1.11.2', imagePullPolicy: 'IfNotPresent',
              args: ['/nginx-ingress-controller', '--election-id=ingress-nginx-leader', '--controller-class=k8s.io/ingress-nginx', '--ingress-class=nginx', '--configmap=$(POD_NAMESPACE)/ingress-nginx-controller', '--validating-webhook=:8443', '--watch-ingress-without-class=true', '--publish-status-address=localhost'],
              env: [{ name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }, { name: 'POD_NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } }, { name: 'LD_PRELOAD', value: '/usr/local/lib/libmimalloc.so' }],
              ports: [{ containerPort: 80, hostPort: 80, name: 'http', protocol: 'TCP' }, { containerPort: 443, hostPort: 443, name: 'https', protocol: 'TCP' }, { containerPort: 8443, name: 'webhook', protocol: 'TCP' }],
              resources: { requests: { cpu: '100m', memory: '90Mi' } },
            }],
          },
        },
      },
    });
    const cpNode = this.raw(T('nodes'), '', 'sim-control-plane');
    cpNode.metadata.labels['ingress-ready'] = 'true';
    this.put(T('nodes'), cpNode);
    // pods estáticos
    const staticPod = (component, image, cmd, req, extraLabels) => ({
      apiVersion: 'v1', kind: 'Pod',
      metadata: {
        name: `${component}-sim-control-plane`, namespace: 'kube-system',
        labels: { component, tier: 'control-plane', ...(extraLabels || {}) },
        annotations: { 'kubernetes.io/config.hash': U.hex(32), 'kubernetes.io/config.mirror': U.hex(32), 'kubernetes.io/config.seen': U.iso(boot), 'kubernetes.io/config.source': 'file', ...(component === 'kube-apiserver' ? { 'kubeadm.kubernetes.io/kube-apiserver.advertise-address.endpoint': '172.18.0.2:6443' } : {}), ...(component === 'etcd' ? { 'kubeadm.kubernetes.io/etcd.advertise-client-urls': 'https://172.18.0.2:2379' } : {}) },
      },
      spec: {
        nodeName: 'sim-control-plane', hostNetwork: true, priorityClassName: 'system-node-critical', automountServiceAccountToken: false, enableServiceLinks: true,
        securityContext: { seccompProfile: { type: 'RuntimeDefault' } }, tolerations: [{ effect: 'NoExecute', operator: 'Exists' }],
        containers: [{ name: component, image, imagePullPolicy: 'IfNotPresent', command: cmd, resources: { requests: req } }],
      },
    });
    const statics = [
      staticPod('etcd', 'registry.k8s.io/etcd:3.5.15-0', ['etcd', '--advertise-client-urls=https://172.18.0.2:2379', '--cert-file=/etc/kubernetes/pki/etcd/server.crt', '--client-cert-auth=true', '--data-dir=/var/lib/etcd', '--listen-client-urls=https://127.0.0.1:2379,https://172.18.0.2:2379', '--name=sim-control-plane'], { cpu: '100m', memory: '100Mi' }),
      staticPod('kube-apiserver', 'registry.k8s.io/kube-apiserver:v1.31.0', ['kube-apiserver', '--advertise-address=172.18.0.2', '--allow-privileged=true', '--authorization-mode=Node,RBAC', '--client-ca-file=/etc/kubernetes/pki/ca.crt', '--enable-admission-plugins=NodeRestriction', '--etcd-servers=https://127.0.0.1:2379', '--runtime-config=', '--secure-port=6443', '--service-account-issuer=https://kubernetes.default.svc.cluster.local', '--service-cluster-ip-range=10.96.0.0/16'], { cpu: '250m' }),
      staticPod('kube-controller-manager', 'registry.k8s.io/kube-controller-manager:v1.31.0', ['kube-controller-manager', '--allocate-node-cidrs=true', '--cluster-cidr=10.244.0.0/16', '--cluster-name=sim', '--controllers=*,bootstrapsigner,tokencleaner', '--leader-elect=true', '--service-cluster-ip-range=10.96.0.0/16', '--use-service-account-credentials=true'], { cpu: '200m' }),
      staticPod('kube-scheduler', 'registry.k8s.io/kube-scheduler:v1.31.0', ['kube-scheduler', '--authentication-kubeconfig=/etc/kubernetes/scheduler.conf', '--authorization-kubeconfig=/etc/kubernetes/scheduler.conf', '--bind-address=127.0.0.1', '--kubeconfig=/etc/kubernetes/scheduler.conf', '--leader-elect=true'], { cpu: '100m' }),
    ];
    this.misc.staticPods = statics;
    for (const s of statics) {
      const p = U.clone(s);
      p.metadata.ownerReferences = [{ apiVersion: 'v1', controller: true, kind: 'Node', name: 'sim-control-plane', uid: cpNode.metadata.uid }];
      put(p);
    }
    // leases e objetos diversos
    for (const n of nodes) this.put(T('leases.coordination.k8s.io'), { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: n.metadata.name, namespace: 'kube-node-lease', uid: U.uid(), creationTimestamp: U.iso(boot), ownerReferences: [{ apiVersion: 'v1', kind: 'Node', name: n.metadata.name, uid: this.raw(T('nodes'), '', n.metadata.name).metadata.uid }] }, spec: { holderIdentity: n.metadata.name, leaseDurationSeconds: 40, renewTime: U.iso(Date.now()) } }, 'ADDED');
    for (const [nm, holder] of [['kube-controller-manager', 'sim-control-plane_' + U.uid()], ['kube-scheduler', 'sim-control-plane_' + U.uid()], ['apiserver-' + U.rand(26).slice(0, 26), 'apiserver-' + U.uid()]])
      this.put(T('leases.coordination.k8s.io'), { apiVersion: 'coordination.k8s.io/v1', kind: 'Lease', metadata: { name: nm, namespace: 'kube-system', uid: U.uid(), creationTimestamp: U.iso(boot) }, spec: { acquireTime: U.iso(boot), holderIdentity: holder, leaseDurationSeconds: nm.startsWith('apiserver') ? 3600 : 15, leaseTransitions: 0, renewTime: U.iso(Date.now()) } }, 'ADDED');
    for (const [nm, st] of [['scheduler', 'ok'], ['controller-manager', 'ok'], ['etcd-0', 'ok']])
      this.put(T('componentstatuses'), { apiVersion: 'v1', kind: 'ComponentStatus', metadata: { name: nm, uid: U.uid(), creationTimestamp: null }, conditions: [{ message: st, status: 'True', type: 'Healthy' }] }, 'ADDED');
    for (const fs of [['exempt', 1, 'exempt'], ['probes', 2, 'exempt'], ['system-leader-election', 100, 'leader-election'], ['endpoint-controller', 150, 'workload-high'], ['workload-leader-election', 200, 'leader-election'], ['system-node-high', 400, 'node-high'], ['system-nodes', 500, 'system'], ['kube-controller-manager', 800, 'workload-high'], ['kube-scheduler', 800, 'workload-high'], ['kube-system-service-accounts', 900, 'workload-high'], ['service-accounts', 9000, 'workload-low'], ['global-default', 9900, 'global-default'], ['catch-all', 10000, 'catch-all']])
      this.put(T('flowschemas.flowcontrol.apiserver.k8s.io'), { apiVersion: 'flowcontrol.apiserver.k8s.io/v1', kind: 'FlowSchema', metadata: { name: fs[0], uid: U.uid(), creationTimestamp: U.iso(boot), annotations: { 'apf.kubernetes.io/autoupdate-spec': 'true' } }, spec: { matchingPrecedence: fs[1], priorityLevelConfiguration: { name: fs[2] }, distinguisherMethod: { type: 'ByUser' }, rules: [] }, status: { conditions: [{ lastTransitionTime: U.iso(boot), message: 'This FlowSchema references the PriorityLevelConfiguration object named "' + fs[2] + '" and it exists', reason: 'Found', status: 'False', type: 'Dangling' }] } }, 'ADDED');
    for (const pl of [['catch-all', 5], ['exempt', 0], ['global-default', 20], ['leader-election', 10], ['node-high', 40], ['system', 30], ['workload-high', 40], ['workload-low', 100]])
      this.put(T('prioritylevelconfigurations.flowcontrol.apiserver.k8s.io'), { apiVersion: 'flowcontrol.apiserver.k8s.io/v1', kind: 'PriorityLevelConfiguration', metadata: { name: pl[0], uid: U.uid(), creationTimestamp: U.iso(boot) }, spec: pl[0] === 'exempt' ? { type: 'Exempt', exempt: { nominalConcurrencyShares: 0, lendablePercent: 0 } } : { type: 'Limited', limited: { nominalConcurrencyShares: pl[1], lendablePercent: 0, limitResponse: { type: pl[0] === 'catch-all' ? 'Reject' : 'Queue' } } }, status: {} }, 'ADDED');
    const groups = new Set(S.types.map((t) => t.apiVersion));
    for (const gv of [...groups].sort()) {
      const [g, v] = gv.includes('/') ? gv.split('/') : ['', gv];
      const isMetrics = g === 'metrics.k8s.io';
      this.put(T('apiservices.apiregistration.k8s.io'), {
        apiVersion: 'apiregistration.k8s.io/v1', kind: 'APIService',
        metadata: { name: g ? `${v}.${g}` : v, uid: U.uid(), creationTimestamp: U.iso(boot), labels: isMetrics ? { 'k8s-app': 'metrics-server' } : { 'kube-aggregator.kubernetes.io/automanaged': 'onstart' } },
        spec: { ...(g ? { group: g } : {}), version: v, groupPriorityMinimum: isMetrics ? 100 : 18000, versionPriority: 15, ...(isMetrics ? { service: { name: 'metrics-server', namespace: 'kube-system', port: 443 }, insecureSkipTLSVerify: true } : {}) },
        status: { conditions: [{ lastTransitionTime: U.iso(boot), message: isMetrics ? 'all checks passed' : 'Local APIServices are always available', reason: 'Passed', status: 'True', type: 'Available' }] },
      }, 'ADDED');
    }
    // avança o relógio simulando os primeiros minutos do cluster
    for (let i = 0; i < 160; i++) {
      this.fakeNow += 500;
      this.tick();
    }
    // ajusta horários de criação dos objetos de bootstrap
    for (const t of S.types) for (const o of Object.values(this.data[t.id] || {})) {
      const ct = U.ms(o.metadata.creationTimestamp);
      if (ct && ct < boot + 20000) o.metadata.creationTimestamp = U.iso(boot + Math.floor((ct - boot) / 4));
    }
    this.fakeNow = null;
    // os eventos de bootstrap envelhecem além do TTL
    for (const e of this.rawList(T('events'))) {
      if (e.metadata.namespace === 'kube-system' || e.metadata.namespace === 'default' || e.metadata.namespace === 'local-path-storage' || e.metadata.namespace === 'ingress-nginx') this.removeRaw(T('events'), e);
    }
    this.dirty = true;
  };
  C.bootstrapRBAC = function (put) {
    const cr = (name, rules, labels, extra) => put({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', metadata: { name, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults', ...(labels || {}) }, annotations: { 'rbac.authorization.kubernetes.io/autoupdate': 'true' } }, rules, ...(extra || {}) });
    const crb = (name, role, subjects) => put({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name, labels: { 'kubernetes.io/bootstrapping': 'rbac-defaults' }, annotations: { 'rbac.authorization.kubernetes.io/autoupdate': 'true' } }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: role }, subjects });
    const R = (apiGroups, resources, verbs, extra) => ({ apiGroups, resources, verbs, ...(extra || {}) });
    const RO = ['get', 'list', 'watch'];
    const RW = ['create', 'delete', 'deletecollection', 'patch', 'update'];
    cr('cluster-admin', [R(['*'], ['*'], ['*']), { nonResourceURLs: ['*'], verbs: ['*'] }], {});
    const view = [
      R([''], ['configmaps', 'endpoints', 'persistentvolumeclaims', 'persistentvolumeclaims/status', 'pods', 'replicationcontrollers', 'replicationcontrollers/scale', 'serviceaccounts', 'services', 'services/status'], RO),
      R([''], ['bindings', 'events', 'limitranges', 'namespaces/status', 'pods/log', 'pods/status', 'replicationcontrollers/status', 'resourcequotas', 'resourcequotas/status'], RO),
      R([''], ['namespaces'], RO),
      R(['discovery.k8s.io'], ['endpointslices'], RO),
      R(['apps'], ['controllerrevisions', 'daemonsets', 'daemonsets/status', 'deployments', 'deployments/scale', 'deployments/status', 'replicasets', 'replicasets/scale', 'replicasets/status', 'statefulsets', 'statefulsets/scale', 'statefulsets/status'], RO),
      R(['autoscaling'], ['horizontalpodautoscalers', 'horizontalpodautoscalers/status'], RO),
      R(['batch'], ['cronjobs', 'cronjobs/status', 'jobs', 'jobs/status'], RO),
      R(['policy'], ['poddisruptionbudgets', 'poddisruptionbudgets/status'], RO),
      R(['networking.k8s.io'], ['ingresses', 'ingresses/status', 'networkpolicies'], RO),
      R(['metrics.k8s.io'], ['pods', 'nodes'], RO),
    ];
    const editExtra = [
      R([''], ['pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy', 'secrets', 'services/proxy'], RO),
      R([''], ['serviceaccounts'], ['impersonate']),
      R([''], ['pods', 'pods/attach', 'pods/exec', 'pods/portforward', 'pods/proxy'], RW),
      R([''], ['pods/eviction'], ['create']),
      R([''], ['configmaps', 'events', 'persistentvolumeclaims', 'replicationcontrollers', 'replicationcontrollers/scale', 'secrets', 'serviceaccounts', 'services', 'services/proxy'], RW),
      R([''], ['serviceaccounts/token'], ['create']),
      R(['apps'], ['daemonsets', 'deployments', 'deployments/rollback', 'deployments/scale', 'replicasets', 'replicasets/scale', 'statefulsets', 'statefulsets/scale'], RW),
      R(['autoscaling'], ['horizontalpodautoscalers'], RW),
      R(['batch'], ['cronjobs', 'jobs'], RW),
      R(['networking.k8s.io'], ['ingresses', 'networkpolicies'], RW),
      R(['policy'], ['poddisruptionbudgets'], RW),
      R(['discovery.k8s.io'], ['endpointslices'], RW),
    ];
    cr('view', view, { 'rbac.authorization.k8s.io/aggregate-to-edit': 'true' });
    cr('edit', [...view, ...editExtra], { 'rbac.authorization.k8s.io/aggregate-to-admin': 'true' });
    cr('admin', [...view, ...editExtra, R(['rbac.authorization.k8s.io'], ['rolebindings', 'roles'], [...RO, ...RW]), R(['authorization.k8s.io'], ['localsubjectaccessreviews'], ['create'])], {});
    cr('system:basic-user', [R(['authorization.k8s.io'], ['selfsubjectaccessreviews', 'selfsubjectrulesreviews'], ['create']), R(['authentication.k8s.io'], ['selfsubjectreviews'], ['create'])]);
    cr('system:discovery', [{ nonResourceURLs: ['/api', '/api/*', '/apis', '/apis/*', '/healthz', '/livez', '/openapi', '/openapi/*', '/readyz', '/version', '/version/'], verbs: ['get'] }]);
    cr('system:public-info-viewer', [{ nonResourceURLs: ['/healthz', '/livez', '/readyz', '/version', '/version/'], verbs: ['get'] }]);
    cr('system:node', [R([''], ['nodes', 'nodes/status'], ['get', 'list', 'watch', 'patch', 'update']), R([''], ['pods'], ['get', 'list', 'watch', 'create', 'delete'])]);
    cr('system:node-proxier', [R([''], ['endpoints', 'services'], RO), R([''], ['nodes'], RO), R(['discovery.k8s.io'], ['endpointslices'], RO)]);
    cr('system:kube-scheduler', [R([''], ['pods'], ['delete', 'get', 'list', 'watch']), R([''], ['bindings', 'pods/binding'], ['create']), R([''], ['nodes'], RO)]);
    cr('system:kube-controller-manager', [R(['*'], ['*'], RO)]);
    cr('system:kube-dns', [R([''], ['endpoints', 'services'], ['list', 'watch'])]);
    cr('system:coredns', [R([''], ['endpoints', 'services', 'pods', 'namespaces'], ['list', 'watch']), R(['discovery.k8s.io'], ['endpointslices'], ['list', 'watch'])], {}, {});
    cr('system:metrics-server', [R([''], ['nodes/metrics'], ['get']), R([''], ['pods', 'nodes'], RO)], { 'k8s-app': 'metrics-server' });
    cr('system:aggregated-metrics-reader', [R(['metrics.k8s.io'], ['pods', 'nodes'], RO)], { 'k8s-app': 'metrics-server', 'rbac.authorization.k8s.io/aggregate-to-admin': 'true', 'rbac.authorization.k8s.io/aggregate-to-edit': 'true', 'rbac.authorization.k8s.io/aggregate-to-view': 'true' });
    cr('kindnet', [R([''], ['nodes'], ['list', 'watch', 'patch']), R(['networking.k8s.io'], ['networkpolicies'], ['list', 'watch'])]);
    cr('local-path-provisioner-role', [R([''], ['nodes', 'persistentvolumeclaims', 'configmaps', 'pods', 'pods/log'], RO), R([''], ['persistentvolumes'], ['get', 'list', 'watch', 'create', 'patch', 'update', 'delete']), R([''], ['events'], ['create', 'patch']), R(['storage.k8s.io'], ['storageclasses'], RO)]);
    cr('ingress-nginx', [R([''], ['configmaps', 'endpoints', 'nodes', 'pods', 'secrets', 'namespaces'], ['list', 'watch']), R(['networking.k8s.io'], ['ingresses', 'ingressclasses'], RO), R(['networking.k8s.io'], ['ingresses/status'], ['update'])]);
    for (const c of ['attachdetach-controller', 'certificate-controller', 'clusterrole-aggregation-controller', 'cronjob-controller', 'daemon-set-controller', 'deployment-controller', 'disruption-controller', 'endpoint-controller', 'endpointslice-controller', 'expand-controller', 'generic-garbage-collector', 'horizontal-pod-autoscaler', 'job-controller', 'namespace-controller', 'node-controller', 'persistent-volume-binder', 'pod-garbage-collector', 'pv-protection-controller', 'pvc-protection-controller', 'replicaset-controller', 'replication-controller', 'resourcequota-controller', 'root-ca-cert-publisher', 'service-account-controller', 'statefulset-controller', 'ttl-after-finished-controller', 'ttl-controller']) {
      cr(`system:controller:${c}`, [R(['*'], ['*'], RO)]);
      crb(`system:controller:${c}`, `system:controller:${c}`, [{ kind: 'ServiceAccount', name: c, namespace: 'kube-system' }]);
    }
    crb('cluster-admin', 'cluster-admin', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:masters' }]);
    put({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding', metadata: { name: 'kubeadm:cluster-admins' }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' }, subjects: [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'kubeadm:cluster-admins' }] });
    crb('system:basic-user', 'system:basic-user', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:authenticated' }]);
    crb('system:discovery', 'system:discovery', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:authenticated' }]);
    crb('system:public-info-viewer', 'system:public-info-viewer', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:authenticated' }, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:unauthenticated' }]);
    crb('system:kube-scheduler', 'system:kube-scheduler', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'system:kube-scheduler' }]);
    crb('system:kube-controller-manager', 'system:kube-controller-manager', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'system:kube-controller-manager' }]);
    crb('system:node-proxier', 'system:node-proxier', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'system:kube-proxy' }]);
    crb('kubeadm:node-proxier', 'system:node-proxier', [{ kind: 'ServiceAccount', name: 'kube-proxy', namespace: 'kube-system' }]);
    crb('system:coredns', 'system:coredns', [{ kind: 'ServiceAccount', name: 'coredns', namespace: 'kube-system' }]);
    crb('system:metrics-server', 'system:metrics-server', [{ kind: 'ServiceAccount', name: 'metrics-server', namespace: 'kube-system' }]);
    crb('kindnet', 'kindnet', [{ kind: 'ServiceAccount', name: 'kindnet', namespace: 'kube-system' }]);
    crb('local-path-provisioner-bind', 'local-path-provisioner-role', [{ kind: 'ServiceAccount', name: 'local-path-provisioner-service-account', namespace: 'local-path-storage' }]);
    crb('ingress-nginx', 'ingress-nginx', [{ kind: 'ServiceAccount', name: 'ingress-nginx', namespace: 'ingress-nginx' }]);
    const role = (name, ns, rules) => put({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'Role', metadata: { name, namespace: ns }, rules });
    role('extension-apiserver-authentication-reader', 'kube-system', [R([''], ['configmaps'], ['get', 'list', 'watch'], { resourceNames: ['extension-apiserver-authentication'] })]);
    role('kube-proxy', 'kube-system', [R([''], ['configmaps'], ['get'], { resourceNames: ['kube-proxy'] })]);
    role('kubeadm:kubelet-config', 'kube-system', [R([''], ['configmaps'], ['get'], { resourceNames: ['kubelet-config'] })]);
    role('kubeadm:nodes-kubeadm-config', 'kube-system', [R([''], ['configmaps'], ['get'], { resourceNames: ['kubeadm-config'] })]);
    role('system::leader-locking-kube-controller-manager', 'kube-system', [R(['coordination.k8s.io'], ['leases'], ['watch']), R(['coordination.k8s.io'], ['leases'], ['get', 'update'], { resourceNames: ['kube-controller-manager'] })]);
    role('system::leader-locking-kube-scheduler', 'kube-system', [R(['coordination.k8s.io'], ['leases'], ['watch']), R(['coordination.k8s.io'], ['leases'], ['get', 'update'], { resourceNames: ['kube-scheduler'] })]);
    role('system:controller:bootstrap-signer', 'kube-system', [R([''], ['secrets'], ['get', 'list', 'watch'])]);
    role('system:controller:token-cleaner', 'kube-system', [R([''], ['secrets'], ['delete', 'get', 'list', 'watch'])]);
    role('system:controller:bootstrap-signer', 'kube-public', [R([''], ['configmaps'], ['get', 'list', 'watch']), R([''], ['configmaps'], ['update'], { resourceNames: ['cluster-info'] })]);
    role('kubeadm:bootstrap-signer-clusterinfo', 'kube-public', [R([''], ['configmaps'], ['get'], { resourceNames: ['cluster-info'] })]);
    const rb = (name, ns, kind, rname, subjects) => put({ apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'RoleBinding', metadata: { name, namespace: ns }, roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind, name: rname }, subjects });
    rb('kube-proxy', 'kube-system', 'Role', 'kube-proxy', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:bootstrappers:kubeadm:default-node-token' }]);
    rb('kubeadm:kubelet-config', 'kube-system', 'Role', 'kubeadm:kubelet-config', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:nodes' }]);
    rb('kubeadm:nodes-kubeadm-config', 'kube-system', 'Role', 'kubeadm:nodes-kubeadm-config', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'Group', name: 'system:nodes' }]);
    rb('system::leader-locking-kube-controller-manager', 'kube-system', 'Role', 'system::leader-locking-kube-controller-manager', [{ kind: 'ServiceAccount', name: 'kube-controller-manager', namespace: 'kube-system' }]);
    rb('system::leader-locking-kube-scheduler', 'kube-system', 'Role', 'system::leader-locking-kube-scheduler', [{ kind: 'ServiceAccount', name: 'kube-scheduler', namespace: 'kube-system' }]);
    rb('metrics-server-auth-reader', 'kube-system', 'Role', 'extension-apiserver-authentication-reader', [{ kind: 'ServiceAccount', name: 'metrics-server', namespace: 'kube-system' }]);
    rb('kubeadm:bootstrap-signer-clusterinfo', 'kube-public', 'Role', 'kubeadm:bootstrap-signer-clusterinfo', [{ apiGroup: 'rbac.authorization.k8s.io', kind: 'User', name: 'system:anonymous' }]);
  };
})();
