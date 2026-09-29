// API server simulado: armazenamento, admissão, defaults, validação, RBAC, eventos e API REST.
// Controllers, scheduler e kubelet ficam em controllers.js (estendem Cluster.prototype).
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const U = KS.util, S = KS.schema, IM = KS.images;

  class ApiError extends Error {
    constructor(code, reason, message) {
      super(message);
      this.code = code;
      this.reason = reason;
    }
  }
  KS.ApiError = ApiError;
  const E = (KS.errors = {
    notFound: (t, name) => new ApiError(404, 'NotFound', `${t.qualified} "${name}" not found`),
    exists: (t, name) => new ApiError(409, 'AlreadyExists', `${t.qualified} "${name}" already exists`),
    conflict: (t, name) =>
      new ApiError(409, 'Conflict', `Operation cannot be fulfilled on ${t.qualified} "${name}": the object has been modified; please apply your changes to the latest version and try again`),
    invalid: (t, name, causes) => {
      const e = new ApiError(422, 'Invalid', `${t.kind}${t.group ? '.' + t.group : ''} "${name}" is invalid: ${causes.join(', ')}`);
      e.kind = t.kind;
      e.objName = name;
      e.causes = causes;
      return e;
    },
    forbidden: (msg) => new ApiError(403, 'Forbidden', msg),
    badRequest: (msg) => new ApiError(400, 'BadRequest', msg),
  });

  const SYSTEM = { user: 'system:admin', groups: ['system:masters'], system: true };
  KS.SYSTEM = SYSTEM;
  const PROTECTED_NS = ['default', 'kube-system', 'kube-public', 'kube-node-lease'];
  const byNsName = (a, b) => {
    const an = (a.metadata.namespace || '') + '/' + a.metadata.name;
    const bn = (b.metadata.namespace || '') + '/' + b.metadata.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  };

  class Cluster {
    constructor(state) {
      this.data = {};
      this.rt = {}; // runtime dos pods por uid
      this.vols = {}; // conteúdo persistente de PVs e emptyDirs
      this.nodeImages = {};
      this.rv = 1000;
      this.listeners = new Set();
      this.misc = { lbCounter: 0, ipCounters: {} };
      this.name = 'sim';
      this.version = 'v1.31.0';
      if (state) this.restore(state);
      else this.bootstrap();
    }

    now() {
      return this.fakeNow ?? Date.now();
    }

    // ---------- persistência ----------
    serialize() {
      return JSON.stringify({ v: 1, data: this.data, rt: this.rt, vols: this.vols, nodeImages: this.nodeImages, rv: this.rv, misc: this.misc });
    }
    restore(state) {
      const s = typeof state === 'string' ? JSON.parse(state) : state;
      this.data = s.data;
      this.rt = s.rt || {};
      this.vols = s.vols || {};
      this.nodeImages = s.nodeImages || {};
      this.rv = s.rv || 1000;
      this.misc = s.misc || { lbCounter: 0, ipCounters: {} };
      // reidrata o cache de execução
      for (const r of Object.values(this.rt)) for (const c of Object.values({ ...(r.cs || {}), ...(r.ics || {}) })) for (const run of c.runs || []) delete run._sim;
      // registra CRDs
      const crdT = S.byId('customresourcedefinitions.apiextensions.k8s.io');
      for (const crd of Object.values(this.data[crdT.id] || {})) this.registerCRD(crd);
    }

    // ---------- armazenamento ----------
    bucket(t) {
      return this.data[t.id] || (this.data[t.id] = {});
    }
    key(t, ns, name) {
      return (t.namespaced ? ns || '' : '') + '/' + name;
    }
    raw(t, ns, name) {
      return this.bucket(t)[this.key(t, ns, name)] || null;
    }
    rawList(t, ns) {
      const b = this.bucket(t);
      const out = [];
      for (const k in b) {
        const o = b[k];
        if (ns && t.namespaced && o.metadata.namespace !== ns) continue;
        out.push(o);
      }
      return out.sort(byNsName);
    }
    T(id) {
      return S.byId(id);
    }
    typeOf(obj) {
      if (!obj || !obj.kind) return null;
      return S.byKind(obj.apiVersion, obj.kind);
    }
    nextRV() {
      return String(++this.rv);
    }
    put(t, obj, type = 'MODIFIED') {
      obj.metadata.resourceVersion = this.nextRV();
      this.bucket(t)[this.key(t, obj.metadata.namespace, obj.metadata.name)] = obj;
      this.emit(type, t, obj);
      return obj;
    }
    removeRaw(t, obj) {
      const k = this.key(t, obj.metadata.namespace, obj.metadata.name);
      if (!this.bucket(t)[k]) return;
      delete this.bucket(t)[k];
      obj.metadata.resourceVersion = this.nextRV();
      this.emit('DELETED', t, obj);
      if (t.plural === 'pods') {
        delete this.rt[obj.metadata.uid];
      }
      if (t.id === 'customresourcedefinitions.apiextensions.k8s.io') this.unregisterCRD(obj);
    }
    emit(type, t, obj) {
      this.dirty = true;
      for (const l of [...this.listeners]) {
        try {
          l(type, t, obj);
        } catch (e) {
          /* listener com erro não derruba o cluster */
        }
      }
    }
    watch(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    // grava se mudou (evita churn de resourceVersion)
    saveIfChanged(t, obj, before) {
      if (JSON.stringify(obj) !== before) this.put(t, obj, 'MODIFIED');
    }
    setStatus(t, obj, status) {
      const before = JSON.stringify(obj.status);
      const after = JSON.stringify(status);
      if (before !== after) {
        obj.status = status;
        this.put(t, obj, 'MODIFIED');
        return true;
      }
      return false;
    }

    // ---------- CRDs ----------
    registerCRD(crd) {
      const sp = crd.spec || {};
      const names = sp.names || {};
      const served = (sp.versions || []).filter((v) => v.served !== false);
      const storage = served.find((v) => v.storage) || served[0];
      if (!storage) return;
      const t = S.add([names.plural, names.singular || names.kind.toLowerCase(), names.shortNames || [], sp.group, storage.name, sp.scope !== 'Cluster', names.kind, undefined, names.categories || [], true]);
      t.crd = crd.metadata.name;
      t.printerColumns = storage.additionalPrinterColumns || null;
      t.versions = served.map((v) => v.name);
    }
    unregisterCRD(crd) {
      const sp = crd.spec || {};
      S.remove(`${sp.names.plural}.${sp.group}`);
      delete this.data[`${sp.names.plural}.${sp.group}`];
    }

    // ---------- eventos ----------
    event(obj, type, reason, message, component = 'kubelet', host) {
      const evT = this.T('events');
      const ns = obj.metadata.namespace || 'default';
      const inv = obj.metadata;
      const now = U.iso(this.now());
      const list = this.bucket(evT);
      for (const k in list) {
        const e = list[k];
        if (e.involvedObject.uid === inv.uid && e.reason === reason && e.message === message && e.source.component === component) {
          e.count = (e.count || 1) + 1;
          e.lastTimestamp = now;
          this.put(evT, e);
          return e;
        }
      }
      const t = this.typeOf(obj);
      const ev = {
        apiVersion: 'v1',
        kind: 'Event',
        metadata: { name: `${inv.name}.${U.hex(16)}`, namespace: ns, uid: U.uid(), creationTimestamp: now },
        involvedObject: {
          apiVersion: obj.apiVersion,
          kind: obj.kind,
          name: inv.name,
          namespace: inv.namespace,
          uid: inv.uid,
          resourceVersion: inv.resourceVersion,
        },
        reason,
        message,
        source: host ? { component, host } : { component },
        firstTimestamp: now,
        lastTimestamp: now,
        count: 1,
        type,
        eventTime: null,
        reportingComponent: component,
        reportingInstance: host || '',
      };
      if (!inv.namespace) delete ev.involvedObject.namespace;
      if (t && t.plural === 'pods' && arguments[6]) ev.involvedObject.fieldPath = arguments[6];
      return this.put(evT, ev, 'ADDED');
    }
    eventsFor(obj) {
      const evT = this.T('events');
      return this.rawList(evT, obj.metadata.namespace || 'default')
        .filter((e) => e.involvedObject.uid === obj.metadata.uid || (e.involvedObject.name === obj.metadata.name && e.involvedObject.kind === obj.kind && !e.involvedObject.uid))
        .sort((a, b) => U.ms(a.firstTimestamp) - U.ms(b.firstTimestamp));
    }

    // ---------- RBAC ----------
    subjectsMatch(subjects, user, groups) {
      return (subjects || []).some((s) => {
        if (s.kind === 'User') return s.name === user;
        if (s.kind === 'Group') return groups.includes(s.name);
        if (s.kind === 'ServiceAccount') return user === `system:serviceaccount:${s.namespace}:${s.name}`;
        return false;
      });
    }
    rulesOf(role) {
      if (role.kind === 'ClusterRole' && role.aggregationRule) {
        const rules = [];
        const crT = this.T('clusterroles.rbac.authorization.k8s.io');
        for (const sel of role.aggregationRule.clusterRoleSelectors || [])
          for (const cr of this.rawList(crT)) if (cr !== role && U.matchSelector(sel, cr.metadata.labels)) rules.push(...(cr.rules || []));
        return rules.concat(role.rules || []);
      }
      return role.rules || [];
    }
    ruleAllows(rule, a) {
      const has = (arr, v) => (arr || []).includes('*') || (arr || []).includes(v);
      if (!has(rule.verbs, a.verb)) return false;
      if (a.nonResourceURL) {
        return (rule.nonResourceURLs || []).some((u) => u === '*' || u === a.nonResourceURL || (u.endsWith('*') && a.nonResourceURL.startsWith(u.slice(0, -1))));
      }
      if (!rule.resources) return false;
      if (!has(rule.apiGroups, a.group)) return false;
      const res = a.subresource ? `${a.resource}/${a.subresource}` : a.resource;
      const resOk = (rule.resources || []).some((r) => r === '*' || r === res || (r === `${a.resource}/*` && a.subresource) || (r === `*/${a.subresource}` && a.subresource));
      if (!resOk) return false;
      if (rule.resourceNames && rule.resourceNames.length) return !!a.name && rule.resourceNames.includes(a.name);
      return true;
    }
    // Retorna {allowed, reason}
    authorize(ctx, a) {
      if (!ctx || ctx.system) return { allowed: true };
      const groups = ctx.groups || [];
      if (groups.includes('system:masters')) return { allowed: true, reason: '' };
      const crbT = this.T('clusterrolebindings.rbac.authorization.k8s.io');
      const crT = this.T('clusterroles.rbac.authorization.k8s.io');
      const rbT = this.T('rolebindings.rbac.authorization.k8s.io');
      const rT = this.T('roles.rbac.authorization.k8s.io');
      for (const b of this.rawList(crbT)) {
        if (!this.subjectsMatch(b.subjects, ctx.user, groups)) continue;
        const role = this.raw(crT, '', b.roleRef.name);
        if (role && this.rulesOf(role).some((r) => this.ruleAllows(r, a)))
          return { allowed: true, reason: `RBAC: allowed by ClusterRoleBinding "${b.metadata.name}" of ClusterRole "${b.roleRef.name}" to ${groups.length ? 'Group' : 'User'}` };
      }
      if (a.namespace) {
        for (const b of this.rawList(rbT, a.namespace)) {
          if (!this.subjectsMatch(b.subjects, ctx.user, groups)) continue;
          const role = b.roleRef.kind === 'ClusterRole' ? this.raw(crT, '', b.roleRef.name) : this.raw(rT, a.namespace, b.roleRef.name);
          if (role && this.rulesOf(role).some((r) => this.ruleAllows(r, a)))
            return { allowed: true, reason: `RBAC: allowed by RoleBinding "${b.metadata.name}/${a.namespace}" of ${b.roleRef.kind} "${b.roleRef.name}"` };
        }
      }
      return { allowed: false };
    }
    // Regras efetivas (para auth can-i --list)
    rulesFor(ctx, ns) {
      const groups = ctx.groups || [];
      if (groups.includes('system:masters')) return [{ verbs: ['*'], apiGroups: ['*'], resources: ['*'] }, { verbs: ['*'], nonResourceURLs: ['*'] }];
      const out = [];
      const crbT = this.T('clusterrolebindings.rbac.authorization.k8s.io');
      const crT = this.T('clusterroles.rbac.authorization.k8s.io');
      const rbT = this.T('rolebindings.rbac.authorization.k8s.io');
      const rT = this.T('roles.rbac.authorization.k8s.io');
      for (const b of this.rawList(crbT)) {
        if (!this.subjectsMatch(b.subjects, ctx.user, groups)) continue;
        const role = this.raw(crT, '', b.roleRef.name);
        if (role) out.push(...this.rulesOf(role));
      }
      for (const b of this.rawList(rbT, ns)) {
        if (!this.subjectsMatch(b.subjects, ctx.user, groups)) continue;
        const role = b.roleRef.kind === 'ClusterRole' ? this.raw(crT, '', b.roleRef.name) : this.raw(rT, ns, b.roleRef.name);
        if (role) out.push(...this.rulesOf(role));
      }
      return out;
    }
    authz(ctx, verb, t, ns, name, sub) {
      if (!ctx || ctx.system) return;
      const a = { verb, group: t.group, resource: t.plural, subresource: sub, name, namespace: t.namespaced ? ns : '' };
      const r = this.authorize(ctx, a);
      if (r.allowed) return;
      const what = `User "${ctx.user}" cannot ${verb} resource "${t.plural}${sub ? '/' + sub : ''}" in API group "${t.group}"`;
      const where = t.namespaced && ns ? ` in the namespace "${ns}"` : ' at the cluster scope';
      if (name) throw E.forbidden(`${t.qualified} "${name}" is forbidden: ${what}${where}`);
      throw E.forbidden(`${t.qualified} is forbidden: ${what}${where}`);
    }

    // ---------- defaults ----------
    containerDefaults(c) {
      const ref = IM.parseRef(c.image || '');
      if (c.image && !c.imagePullPolicy) c.imagePullPolicy = !ref.digest && (ref.tag === 'latest' || !c.image.split('/').pop().includes(':')) ? 'Always' : 'IfNotPresent';
      if (!c.resources) c.resources = {};
      if (c.resources.limits && !c.resources.requests) c.resources.requests = { ...c.resources.limits };
      else if (c.resources.limits && c.resources.requests) {
        for (const [k, v] of Object.entries(c.resources.limits)) if (!(k in c.resources.requests)) c.resources.requests[k] = v;
      }
      c.terminationMessagePath = c.terminationMessagePath || '/dev/termination-log';
      c.terminationMessagePolicy = c.terminationMessagePolicy || 'File';
      for (const p of c.ports || []) if (!p.protocol) p.protocol = 'TCP';
      for (const pr of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
        const p = c[pr];
        if (!p) continue;
        p.timeoutSeconds ??= 1;
        p.periodSeconds ??= 10;
        p.successThreshold ??= 1;
        p.failureThreshold ??= 3;
        if (p.httpGet) p.httpGet.scheme ??= 'HTTP';
      }
      for (const e of c.env || []) if (e.valueFrom && e.valueFrom.fieldRef && !e.valueFrom.fieldRef.apiVersion) e.valueFrom.fieldRef.apiVersion = 'v1';
    }
    podSpecDefaults(spec) {
      spec.restartPolicy ??= 'Always';
      spec.dnsPolicy ??= 'ClusterFirst';
      spec.schedulerName ??= 'default-scheduler';
      spec.securityContext ??= {};
      spec.terminationGracePeriodSeconds ??= 30;
      for (const c of spec.containers || []) this.containerDefaults(c);
      for (const c of spec.initContainers || []) this.containerDefaults(c);
      for (const v of spec.volumes || []) {
        if (v.configMap) v.configMap.defaultMode ??= 420;
        if (v.secret) v.secret.defaultMode ??= 420;
        if (v.hostPath) v.hostPath.type ??= '';
      }
    }
    templateDefaults(tpl) {
      if (!tpl) return;
      tpl.metadata ??= {};
      tpl.spec ??= {};
      if (tpl.metadata.creationTimestamp === undefined) tpl.metadata.creationTimestamp = null;
      this.podSpecDefaults(tpl.spec);
    }
    qosClass(spec) {
      let any = false, guaranteed = true;
      for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
        const r = c.resources || {};
        const req = r.requests || {}, lim = r.limits || {};
        if (Object.keys(req).length || Object.keys(lim).length) any = true;
        for (const k of ['cpu', 'memory']) {
          if (!lim[k] || U.parseQuantity(lim[k]) !== U.parseQuantity(req[k] ?? lim[k])) guaranteed = false;
        }
      }
      if (!any) return 'BestEffort';
      return guaranteed ? 'Guaranteed' : 'Burstable';
    }
    applyDefaults(t, obj) {
      const s = obj.spec;
      switch (t.id) {
        case 'pods': {
          this.podSpecDefaults(s);
          s.serviceAccountName ??= s.serviceAccount || 'default';
          s.serviceAccount = s.serviceAccountName;
          s.enableServiceLinks ??= true;
          s.preemptionPolicy ??= 'PreemptLowerPriority';
          s.priority ??= 0;
          s.tolerations ??= [];
          for (const key of ['node.kubernetes.io/not-ready', 'node.kubernetes.io/unreachable']) {
            if (!s.tolerations.some((x) => x.key === key && x.effect === 'NoExecute'))
              s.tolerations.push({ effect: 'NoExecute', key, operator: 'Exists', tolerationSeconds: 300 });
          }
          if (s.automountServiceAccountToken !== false) {
            s.volumes ??= [];
            if (!s.volumes.some((v) => v.name.startsWith('kube-api-access-'))) {
              const vn = 'kube-api-access-' + U.rand(5);
              s.volumes.push({
                name: vn,
                projected: {
                  defaultMode: 420,
                  sources: [
                    { serviceAccountToken: { expirationSeconds: 3607, path: 'token' } },
                    { configMap: { items: [{ key: 'ca.crt', path: 'ca.crt' }], name: 'kube-root-ca.crt' } },
                    { downwardAPI: { items: [{ fieldRef: { apiVersion: 'v1', fieldPath: 'metadata.namespace' }, path: 'namespace' }] } },
                  ],
                },
              });
              for (const c of [...(s.containers || []), ...(s.initContainers || [])]) {
                c.volumeMounts ??= [];
                c.volumeMounts.push({ mountPath: '/var/run/secrets/kubernetes.io/serviceaccount', name: vn, readOnly: true });
              }
            }
          }
          obj.status = { phase: 'Pending', qosClass: this.qosClass(s) };
          break;
        }
        case 'podtemplates':
          this.templateDefaults(obj.template);
          break;
        case 'deployments.apps':
          s.replicas ??= 1;
          s.revisionHistoryLimit ??= 10;
          s.progressDeadlineSeconds ??= 600;
          s.strategy ??= { type: 'RollingUpdate' };
          s.strategy.type ??= 'RollingUpdate';
          if (s.strategy.type === 'RollingUpdate') s.strategy.rollingUpdate = { maxSurge: '25%', maxUnavailable: '25%', ...(s.strategy.rollingUpdate || {}) };
          this.templateDefaults(s.template);
          obj.status = {};
          break;
        case 'replicasets.apps':
        case 'replicationcontrollers':
          s.replicas ??= 1;
          if (t.id === 'replicationcontrollers') {
            s.selector ??= { ...((s.template && s.template.metadata && s.template.metadata.labels) || {}) };
            obj.metadata.labels ??= { ...s.selector };
          }
          this.templateDefaults(s.template);
          obj.status = { replicas: 0 };
          break;
        case 'statefulsets.apps':
          s.replicas ??= 1;
          s.podManagementPolicy ??= 'OrderedReady';
          s.updateStrategy ??= { type: 'RollingUpdate' };
          if (s.updateStrategy.type === 'RollingUpdate') s.updateStrategy.rollingUpdate = { partition: 0, ...(s.updateStrategy.rollingUpdate || {}) };
          s.revisionHistoryLimit ??= 10;
          s.persistentVolumeClaimRetentionPolicy ??= { whenDeleted: 'Retain', whenScaled: 'Retain' };
          for (const v of s.volumeClaimTemplates || []) {
            v.apiVersion ??= 'v1';
            v.kind ??= 'PersistentVolumeClaim';
            v.metadata ??= {};
            v.metadata.creationTimestamp ??= null;
            v.spec ??= {};
            v.spec.volumeMode ??= 'Filesystem';
            v.status ??= { phase: 'Pending' };
          }
          this.templateDefaults(s.template);
          obj.status = { replicas: 0, availableReplicas: 0 };
          break;
        case 'daemonsets.apps':
          s.updateStrategy ??= { type: 'RollingUpdate' };
          if (s.updateStrategy.type === 'RollingUpdate') s.updateStrategy.rollingUpdate = { maxSurge: 0, maxUnavailable: 1, ...(s.updateStrategy.rollingUpdate || {}) };
          s.revisionHistoryLimit ??= 10;
          this.templateDefaults(s.template);
          obj.status = { currentNumberScheduled: 0, desiredNumberScheduled: 0, numberMisscheduled: 0, numberReady: 0 };
          break;
        case 'jobs.batch': {
          s.parallelism ??= 1;
          if (s.completions === undefined) s.completions = s.parallelism === 1 || s.completionMode === 'Indexed' ? 1 : null;
          if (s.completions === null) delete s.completions;
          s.backoffLimit ??= s.backoffLimitPerIndex !== undefined ? 2147483647 : 6;
          s.completionMode ??= 'NonIndexed';
          s.suspend ??= false;
          s.podReplacementPolicy ??= 'TerminatingOrFailed';
          s.manualSelector ??= undefined;
          if (!s.manualSelector) {
            const uid = obj.metadata.uid;
            s.selector = { matchLabels: { 'batch.kubernetes.io/controller-uid': uid } };
            s.template.metadata ??= {};
            s.template.metadata.labels = {
              ...(s.template.metadata.labels || {}),
              'batch.kubernetes.io/controller-uid': uid,
              'batch.kubernetes.io/job-name': obj.metadata.name,
              'controller-uid': uid,
              'job-name': obj.metadata.name,
            };
          }
          delete s.manualSelector;
          this.templateDefaults(s.template);
          obj.status = {};
          break;
        }
        case 'cronjobs.batch':
          s.concurrencyPolicy ??= 'Allow';
          s.suspend ??= false;
          s.successfulJobsHistoryLimit ??= 3;
          s.failedJobsHistoryLimit ??= 1;
          s.jobTemplate ??= { spec: {} };
          s.jobTemplate.metadata ??= { creationTimestamp: null };
          if (s.jobTemplate.spec) this.templateDefaults(s.jobTemplate.spec.template);
          obj.status = {};
          break;
        case 'services': {
          s.type ??= 'ClusterIP';
          s.sessionAffinity ??= 'None';
          for (const p of s.ports || []) {
            p.protocol ??= 'TCP';
            if (p.targetPort === undefined && s.type !== 'ExternalName') p.targetPort = p.port;
          }
          if (s.type !== 'ExternalName') {
            s.ipFamilies ??= ['IPv4'];
            s.ipFamilyPolicy ??= 'SingleStack';
            s.internalTrafficPolicy ??= 'Cluster';
          }
          if (s.type === 'NodePort' || s.type === 'LoadBalancer') s.externalTrafficPolicy ??= 'Cluster';
          if (s.type === 'LoadBalancer') s.allocateLoadBalancerNodePorts ??= true;
          obj.status = { loadBalancer: {} };
          break;
        }
        case 'namespaces':
          obj.spec = { finalizers: ['kubernetes'], ...(s || {}) };
          obj.metadata.labels = { ...(obj.metadata.labels || {}), 'kubernetes.io/metadata.name': obj.metadata.name };
          obj.status = { phase: 'Active' };
          break;
        case 'secrets':
          obj.type ??= 'Opaque';
          if (obj.stringData) {
            obj.data = obj.data || {};
            for (const [k, v] of Object.entries(obj.stringData)) obj.data[k] = U.b64e(String(v));
            delete obj.stringData;
          }
          break;
        case 'persistentvolumeclaims': {
          s.volumeMode ??= 'Filesystem';
          if (s.storageClassName === undefined) {
            const def = this.defaultStorageClass();
            if (def) s.storageClassName = def.metadata.name;
          }
          obj.metadata.finalizers = [...new Set([...(obj.metadata.finalizers || []), 'kubernetes.io/pvc-protection'])];
          obj.status = { phase: 'Pending' };
          break;
        }
        case 'persistentvolumes':
          s.persistentVolumeReclaimPolicy ??= 'Retain';
          s.volumeMode ??= 'Filesystem';
          obj.metadata.finalizers = [...new Set([...(obj.metadata.finalizers || []), 'kubernetes.io/pv-protection'])];
          obj.status = { phase: 'Available', lastPhaseTransitionTime: U.iso(this.now()) };
          break;
        case 'storageclasses.storage.k8s.io':
          obj.reclaimPolicy ??= 'Delete';
          obj.volumeBindingMode ??= 'Immediate';
          break;
        case 'priorityclasses.scheduling.k8s.io':
          obj.preemptionPolicy ??= 'PreemptLowerPriority';
          break;
        case 'networkpolicies.networking.k8s.io':
          s.podSelector ??= {};
          if (!s.policyTypes) s.policyTypes = s.egress ? ['Ingress', 'Egress'] : ['Ingress'];
          break;
        case 'ingresses.networking.k8s.io':
          if (!s.ingressClassName) {
            const icT = this.T('ingressclasses.networking.k8s.io');
            const def = this.rawList(icT).find((ic) => (ic.metadata.annotations || {})['ingressclass.kubernetes.io/is-default-class'] === 'true');
            if (def) s.ingressClassName = def.metadata.name;
          }
          for (const r of s.rules || []) for (const p of (r.http && r.http.paths) || []) p.pathType ??= 'ImplementationSpecific';
          obj.status = { loadBalancer: {} };
          break;
        case 'horizontalpodautoscalers.autoscaling':
          s.minReplicas ??= 1;
          s.metrics ??= [{ type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 80 } } }];
          obj.status = { currentReplicas: 0, desiredReplicas: 0 };
          break;
        case 'poddisruptionbudgets.policy':
          obj.status = { currentHealthy: 0, desiredHealthy: 0, disruptionsAllowed: 0, expectedPods: 0 };
          break;
        case 'resourcequotas':
          obj.status = { hard: { ...((s && s.hard) || {}) }, used: {} };
          break;
        case 'certificatesigningrequests.certificates.k8s.io':
          s.usages ??= ['client auth'];
          obj.status = {};
          break;
        case 'customresourcedefinitions.apiextensions.k8s.io':
          obj.status = {
            acceptedNames: { ...s.names },
            conditions: [
              { lastTransitionTime: U.iso(this.now()), message: 'no conflicts found', reason: 'NoConflicts', status: 'True', type: 'NamesAccepted' },
              { lastTransitionTime: U.iso(this.now()), message: 'the initial names have been accepted', reason: 'InitialNamesAccepted', status: 'True', type: 'Established' },
            ],
            storedVersions: (s.versions || []).filter((v) => v.storage).map((v) => v.name),
          };
          break;
      }
    }
    defaultStorageClass() {
      const scT = this.T('storageclasses.storage.k8s.io');
      return this.rawList(scT).find((sc) => (sc.metadata.annotations || {})['storageclass.kubernetes.io/is-default-class'] === 'true');
    }

    // ---------- validação ----------
    validateName(t, name) {
      if (!name) return 'metadata.name: Required value: name or generateName is required';
      if (t.plural === 'services' || t.plural === 'namespaces' ? false : false) return null;
      if (t.plural === 'services' && !U.dns1035Label(name))
        return `metadata.name: Invalid value: "${name}": a DNS-1035 label must consist of lower case alphanumeric characters or '-', start with an alphabetic character, and end with an alphanumeric character (e.g. 'my-name',  or 'abc-123', regex used for validation is '[a-z]([-a-z0-9]*[a-z0-9])?')`;
      if (t.plural === 'namespaces' && !U.dns1123Label(name))
        return `metadata.name: Invalid value: "${name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`;
      if (t.plural !== 'services' && t.plural !== 'namespaces' && !(t.plural === 'roles' || t.plural === 'clusterroles' || t.plural === 'rolebindings' || t.plural === 'clusterrolebindings' ? /^[^/%]+$/.test(name) && name !== '.' && name !== '..' : U.dns1123Subdomain(name)))
        return `metadata.name: Invalid value: "${name}": a lowercase RFC 1123 subdomain must consist of lower case alphanumeric characters, '-' or '.', and must start and end with an alphanumeric character (e.g. 'example.com', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*')`;
      return null;
    }
    validateMeta(obj, errs) {
      for (const [k, v] of Object.entries(obj.metadata.labels || {})) {
        if (!U.validLabelKey(k))
          errs.push(`metadata.labels: Invalid value: "${k}": name part must consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyName',  or 'my.name',  or '123-abc', regex used for validation is '([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9]')`);
        if (typeof v !== 'string') errs.push(`metadata.labels: Invalid value: ${JSON.stringify(v)}: label values must be strings`);
        else if (!U.validLabelValue(v))
          errs.push(`metadata.labels: Invalid value: "${v}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
      }
      for (const [k, v] of Object.entries(obj.metadata.annotations || {})) if (typeof v !== 'string') errs.push(`metadata.annotations: Invalid value: ${JSON.stringify(v)}: annotation values must be strings`);
    }
    validateContainer(c, path, volNames, errs, isInit) {
      if (!c.name) errs.push(`${path}.name: Required value`);
      else if (!U.dns1123Label(c.name))
        errs.push(`${path}.name: Invalid value: "${c.name}": a lowercase RFC 1123 label must consist of lower case alphanumeric characters or '-', and must start and end with an alphanumeric character (e.g. 'my-name',  or '123-abc', regex used for validation is '[a-z0-9]([-a-z0-9]*[a-z0-9])?')`);
      if (!c.image) errs.push(`${path}.image: Required value`);
      const res = c.resources || {};
      for (const kind of ['requests', 'limits'])
        for (const [k, v] of Object.entries(res[kind] || {})) {
          if (!U.validQuantity(v)) errs.push(`${path}.resources.${kind}[${k}]: Invalid value: "${v}": must be a valid quantity`);
          else if (U.parseQuantity(v) < 0) errs.push(`${path}.resources.${kind}[${k}]: Invalid value: "${v}": must be greater than or equal to 0`);
        }
      for (const k of ['cpu', 'memory']) {
        const r = (res.requests || {})[k], l = (res.limits || {})[k];
        if (r !== undefined && l !== undefined && U.validQuantity(r) && U.validQuantity(l) && U.parseQuantity(r) > U.parseQuantity(l))
          errs.push(`${path}.resources.requests: Invalid value: "${r}": must be less than or equal to ${k} limit of ${l}`);
      }
      (c.ports || []).forEach((p, i) => {
        if (p.containerPort === undefined) errs.push(`${path}.ports[${i}].containerPort: Required value`);
        else if (!(p.containerPort > 0 && p.containerPort < 65536)) errs.push(`${path}.ports[${i}].containerPort: Invalid value: ${p.containerPort}: must be between 1 and 65535, inclusive`);
        if (p.protocol && !['TCP', 'UDP', 'SCTP'].includes(p.protocol)) errs.push(`${path}.ports[${i}].protocol: Unsupported value: "${p.protocol}": supported values: "SCTP", "TCP", "UDP"`);
      });
      (c.volumeMounts || []).forEach((m, i) => {
        if (!volNames.has(m.name)) errs.push(`${path}.volumeMounts[${i}].name: Not found: "${m.name}"`);
        if (!m.mountPath) errs.push(`${path}.volumeMounts[${i}].mountPath: Required value`);
      });
      (c.env || []).forEach((e, i) => {
        if (!e.name) errs.push(`${path}.env[${i}].name: Required value`);
        else if (!/^[-._a-zA-Z][-._a-zA-Z0-9]*$/.test(e.name))
          errs.push(`${path}.env[${i}].name: Invalid value: "${e.name}": a valid environment variable name must consist of alphabetic characters, digits, '_', '-', or '.', and must not start with a digit (e.g. 'my.env-name',  or 'MY_ENV.NAME',  or 'MyEnvName1', regex used for validation is '[-._a-zA-Z][-._a-zA-Z0-9]*')`);
        if (e.value !== undefined && typeof e.value !== 'string') errs.push(`${path}.env[${i}].value: Invalid value: ${JSON.stringify(e.value)}: must be a string`);
      });
      for (const pr of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
        const p = c[pr];
        if (!p) continue;
        const handlers = ['exec', 'httpGet', 'tcpSocket', 'grpc'].filter((h) => p[h]);
        if (!handlers.length) errs.push(`${path}.${pr}: Required value: must specify a handler type`);
        if (handlers.length > 1) errs.push(`${path}.${pr}.${handlers[1]}: Forbidden: may not specify more than 1 handler type`);
        if (isInit) errs.push(`${path}.${pr}: Forbidden: may not be set for init containers without restartPolicy=Always`);
        if (pr === 'livenessProbe' && p.successThreshold > 1) errs.push(`${path}.livenessProbe.successThreshold: Invalid value: ${p.successThreshold}: must be 1`);
      }
    }
    validatePodSpec(spec, path, errs, opts = {}) {
      if (!spec) { errs.push(`${path}: Required value`); return; }
      const volNames = new Set([...(spec.volumes || []).map((v) => v.name), ...(opts.extraVolumes || [])]);
      if (!spec.containers || !spec.containers.length) errs.push(`${path}.containers: Required value`);
      const seen = new Set();
      [...(spec.initContainers || []).map((c, i) => [c, `${path}.initContainers[${i}]`, true]), ...(spec.containers || []).map((c, i) => [c, `${path}.containers[${i}]`, false])].forEach(([c, p, init]) => {
        this.validateContainer(c, p, volNames, errs, init && c.restartPolicy !== 'Always');
        if (c.name && seen.has(c.name)) errs.push(`${p}.name: Duplicate value: "${c.name}"`);
        seen.add(c.name);
      });
      const vseen = new Set();
      (spec.volumes || []).forEach((v, i) => {
        if (!v.name) errs.push(`${path}.volumes[${i}].name: Required value`);
        if (vseen.has(v.name)) errs.push(`${path}.volumes[${i}].name: Duplicate value: "${v.name}"`);
        vseen.add(v.name);
        const srcs = Object.keys(v).filter((k) => k !== 'name');
        if (!srcs.length) errs.push(`${path}.volumes[${i}]: Required value: must specify a volume type`);
      });
      if (spec.restartPolicy && !['Always', 'OnFailure', 'Never'].includes(spec.restartPolicy))
        errs.push(`${path}.restartPolicy: Unsupported value: "${spec.restartPolicy}": supported values: "Always", "OnFailure", "Never"`);
      if (opts.restart && spec.restartPolicy && !opts.restart.includes(spec.restartPolicy))
        errs.push(`${path}.restartPolicy: Unsupported value: "${spec.restartPolicy}": supported values: ${opts.restart.map((r) => `"${r}"`).join(', ')}`);
      if (spec.dnsPolicy && !['ClusterFirst', 'ClusterFirstWithHostNet', 'Default', 'None'].includes(spec.dnsPolicy))
        errs.push(`${path}.dnsPolicy: Unsupported value: "${spec.dnsPolicy}": supported values: "ClusterFirst", "ClusterFirstWithHostNet", "Default", "None"`);
      (spec.tolerations || []).forEach((tl, i) => {
        if (tl.operator === 'Exists' && tl.value) errs.push(`${path}.tolerations[${i}].operator: Invalid value: "${tl.value}": value must be empty when \`operator\` is 'Exists'`);
        if (tl.effect && !['NoSchedule', 'PreferNoSchedule', 'NoExecute'].includes(tl.effect)) errs.push(`${path}.tolerations[${i}].effect: Unsupported value: "${tl.effect}": supported values: "NoExecute", "NoSchedule", "PreferNoSchedule"`);
      });
    }
    validateSelectorMatches(sel, labels, path, errs) {
      if (!sel) { errs.push(`spec.selector: Required value`); return; }
      if (!Object.keys(sel.matchLabels || {}).length && !(sel.matchExpressions || []).length) {
        errs.push(`spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string(nil), MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: empty selector is invalid for deployment`);
        return;
      }
      if (!U.matchSelector(sel, labels || {}))
        errs.push(`${path}.metadata.labels: Invalid value: map[string]string{${Object.entries(labels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}: \`selector\` does not match template \`labels\``);
    }
    validate(t, obj) {
      const errs = [];
      const n = this.validateName(t, obj.metadata.name);
      if (n) errs.push(n);
      this.validateMeta(obj, errs);
      const s = obj.spec || {};
      switch (t.id) {
        case 'pods':
          this.validatePodSpec(obj.spec, 'spec', errs);
          break;
        case 'deployments.apps':
        case 'replicasets.apps':
        case 'daemonsets.apps':
        case 'statefulsets.apps':
          if (!s.template) errs.push('spec.template: Required value');
          this.validateSelectorMatches(s.selector, s.template && s.template.metadata && s.template.metadata.labels, 'spec.template', errs);
          if (s.template) this.validatePodSpec(s.template.spec, 'spec.template.spec', errs, { restart: ['Always'], extraVolumes: (s.volumeClaimTemplates || []).map((v) => v.metadata && v.metadata.name) });
          if (s.replicas !== undefined && (s.replicas < 0 || !Number.isInteger(s.replicas))) errs.push(`spec.replicas: Invalid value: ${s.replicas}: must be greater than or equal to 0`);
          if (t.id === 'deployments.apps' && s.strategy) {
            if (!['RollingUpdate', 'Recreate'].includes(s.strategy.type)) errs.push(`spec.strategy.type: Unsupported value: "${s.strategy.type}": supported values: "Recreate", "RollingUpdate"`);
            if (s.strategy.type === 'Recreate' && s.strategy.rollingUpdate) errs.push('spec.strategy.rollingUpdate: Forbidden: may not be specified when strategy `type` is \'Recreate\'');
            const ru = s.strategy.rollingUpdate;
            if (ru && U.intOrPercent(ru.maxSurge, 100) === 0 && U.intOrPercent(ru.maxUnavailable, 100) === 0) errs.push('spec.strategy.rollingUpdate.maxUnavailable: Invalid value: 0: may not be 0 when `maxSurge` is 0');
          }
          if (t.id === 'statefulsets.apps' && s.podManagementPolicy && !['OrderedReady', 'Parallel'].includes(s.podManagementPolicy)) errs.push(`spec.podManagementPolicy: Unsupported value: "${s.podManagementPolicy}": supported values: "OrderedReady", "Parallel"`);
          break;
        case 'replicationcontrollers':
          if (s.template) this.validatePodSpec(s.template.spec, 'spec.template.spec', errs, { restart: ['Always'] });
          break;
        case 'jobs.batch':
          if (!s.template) errs.push('spec.template: Required value');
          else {
            if (!s.template.spec || !['Never', 'OnFailure'].includes(s.template.spec.restartPolicy))
              errs.push(`spec.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"`);
            this.validatePodSpec(s.template.spec, 'spec.template.spec', errs);
          }
          if (s.completionMode && !['NonIndexed', 'Indexed'].includes(s.completionMode)) errs.push(`spec.completionMode: Unsupported value: "${s.completionMode}": supported values: "NonIndexed", "Indexed"`);
          if (s.parallelism !== undefined && s.parallelism < 0) errs.push(`spec.parallelism: Invalid value: ${s.parallelism}: must be greater than or equal to 0`);
          break;
        case 'cronjobs.batch':
          if (!s.schedule) errs.push('spec.schedule: Required value');
          else {
            try {
              U.parseCron(s.schedule);
            } catch (e) {
              errs.push(`spec.schedule: Invalid value: "${s.schedule}": ${e.message}`);
            }
          }
          if (!s.jobTemplate || !s.jobTemplate.spec || !s.jobTemplate.spec.template) errs.push('spec.jobTemplate.spec.template: Required value');
          else {
            const tp = s.jobTemplate.spec.template.spec;
            if (!tp || !['Never', 'OnFailure'].includes(tp.restartPolicy)) errs.push(`spec.jobTemplate.spec.template.spec.restartPolicy: Required value: valid values: "OnFailure", "Never"`);
            this.validatePodSpec(tp, 'spec.jobTemplate.spec.template.spec', errs);
          }
          if (s.concurrencyPolicy && !['Allow', 'Forbid', 'Replace'].includes(s.concurrencyPolicy)) errs.push(`spec.concurrencyPolicy: Unsupported value: "${s.concurrencyPolicy}": supported values: "Allow", "Forbid", "Replace"`);
          break;
        case 'services': {
          const types = ['ClusterIP', 'NodePort', 'LoadBalancer', 'ExternalName'];
          if (s.type && !types.includes(s.type)) errs.push(`spec.type: Unsupported value: "${s.type}": supported values: "ClusterIP", "ExternalName", "LoadBalancer", "NodePort"`);
          if (s.type === 'ExternalName' && !s.externalName) errs.push('spec.externalName: Required value');
          if ((!s.ports || !s.ports.length) && s.type !== 'ExternalName' && s.clusterIP !== 'None') errs.push('spec.ports: Required value');
          const names = new Set();
          (s.ports || []).forEach((p, i) => {
            if (!(p.port > 0 && p.port < 65536)) errs.push(`spec.ports[${i}].port: ${p.port === undefined ? 'Required value' : `Invalid value: ${p.port}: must be between 1 and 65535, inclusive`}`);
            if (s.ports.length > 1 && !p.name) errs.push(`spec.ports[${i}].name: Required value`);
            if (p.name && names.has(p.name)) errs.push(`spec.ports[${i}].name: Duplicate value: "${p.name}"`);
            names.add(p.name);
            if (p.nodePort !== undefined && (s.type === 'ClusterIP' || !s.type)) errs.push(`spec.ports[${i}].nodePort: Forbidden: may not be used when \`type\` is 'ClusterIP'`);
            if (p.nodePort !== undefined && s.type !== 'ClusterIP' && (p.nodePort < 30000 || p.nodePort > 32767))
              errs.push(`spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is not in the valid range. The range of valid ports is 30000-32767`);
            if (typeof p.targetPort === 'number' && !(p.targetPort > 0 && p.targetPort < 65536)) errs.push(`spec.ports[${i}].targetPort: Invalid value: ${p.targetPort}: must be between 1 and 65535, inclusive`);
          });
          for (const [k, v] of Object.entries(s.selector || {})) if (!U.validLabelValue(v)) errs.push(`spec.selector: Invalid value: "${v}": a valid label must be an empty string or consist of alphanumeric characters, '-', '_' or '.', and must start and end with an alphanumeric character (e.g. 'MyValue',  or 'my_value',  or '12345', regex used for validation is '(([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?')`);
          break;
        }
        case 'configmaps':
        case 'secrets':
          for (const k of Object.keys(obj.data || {}).concat(Object.keys(obj.stringData || {})))
            if (!/^[-._a-zA-Z0-9]+$/.test(k))
              errs.push(`data[${k}]: Invalid value: "${k}": a valid config key must consist of alphanumeric characters, '-', '_' or '.' (e.g. 'key.name',  or 'KEY_NAME',  or 'key-name', regex used for validation is '[-._a-zA-Z0-9]+')`);
          if (t.id === 'secrets') {
            for (const [k, v] of Object.entries(obj.data || {})) {
              try {
                atob(String(v).replace(/\s/g, ''));
              } catch {
                errs.push(`data[${k}]: Invalid value: "<secret contents redacted>": illegal base64 data at input byte ${String(v).search(/[^A-Za-z0-9+/=]/)}`);
              }
            }
            if (obj.type === 'kubernetes.io/tls' && !(obj.data || {})['tls.crt']) errs.push('data[tls.crt]: Required value');
            if (obj.type === 'kubernetes.io/dockerconfigjson' && !(obj.data || {})['.dockerconfigjson']) errs.push('data[.dockerconfigjson]: Required value');
          } else {
            for (const [k, v] of Object.entries(obj.data || {})) if (typeof v !== 'string') errs.push(`data[${k}]: Invalid value: ${JSON.stringify(v)}: must be a string`);
          }
          break;
        case 'rolebindings.rbac.authorization.k8s.io':
        case 'clusterrolebindings.rbac.authorization.k8s.io':
          if (!obj.roleRef || !obj.roleRef.name) errs.push('roleRef.name: Required value');
          if (obj.roleRef && !['Role', 'ClusterRole'].includes(obj.roleRef.kind)) errs.push(`roleRef.kind: Unsupported value: "${obj.roleRef.kind}": supported values: "ClusterRole", "Role"`);
          if (t.id.startsWith('clusterrolebindings') && obj.roleRef && obj.roleRef.kind !== 'ClusterRole') errs.push(`roleRef.kind: Unsupported value: "${obj.roleRef.kind}": supported values: "ClusterRole"`);
          (obj.subjects || []).forEach((sb, i) => {
            if (!['User', 'Group', 'ServiceAccount'].includes(sb.kind)) errs.push(`subjects[${i}].kind: Unsupported value: "${sb.kind}": supported values: "Group", "ServiceAccount", "User"`);
            if (sb.kind === 'ServiceAccount' && !sb.namespace && t.id.startsWith('cluster')) errs.push(`subjects[${i}].namespace: Required value`);
          });
          break;
        case 'roles.rbac.authorization.k8s.io':
        case 'clusterroles.rbac.authorization.k8s.io':
          (obj.rules || []).forEach((r, i) => {
            if (!r.verbs || !r.verbs.length) errs.push(`rules[${i}].verbs: Required value: verbs must contain at least one value`);
            if (!r.nonResourceURLs && (!r.apiGroups || !r.apiGroups.length)) errs.push(`rules[${i}].apiGroups: Required value: resource rules must supply at least one api group`);
          });
          break;
        case 'persistentvolumeclaims':
          if (!s.accessModes || !s.accessModes.length) errs.push('spec.accessModes: Required value: at least 1 access mode is required');
          if (!s.resources || !s.resources.requests || !s.resources.requests.storage) errs.push('spec.resources[storage]: Required value');
          break;
        case 'persistentvolumes':
          if (!s.capacity || !s.capacity.storage) errs.push('spec.capacity: Required value');
          if (!s.accessModes || !s.accessModes.length) errs.push('spec.accessModes: Required value');
          if (!['hostPath', 'local', 'nfs', 'csi', 'awsElasticBlockStore', 'gcePersistentDisk', 'azureDisk', 'iscsi', 'fc', 'cephfs', 'rbd'].some((k) => s[k]))
            errs.push('spec: Required value: must specify a volume type');
          if (s.local && !s.nodeAffinity) errs.push('spec.nodeAffinity: Required value: Local volume requires node affinity');
          break;
        case 'ingresses.networking.k8s.io':
          (s.rules || []).forEach((r, i) =>
            ((r.http && r.http.paths) || []).forEach((p, j) => {
              if (!p.backend) errs.push(`spec.rules[${i}].http.paths[${j}].backend: Required value`);
              if (!p.pathType) errs.push(`spec.rules[${i}].http.paths[${j}].pathType: Required value: pathType must be specified`);
              else if (!['Exact', 'Prefix', 'ImplementationSpecific'].includes(p.pathType)) errs.push(`spec.rules[${i}].http.paths[${j}].pathType: Unsupported value: "${p.pathType}": supported values: "Exact", "ImplementationSpecific", "Prefix"`);
              if (p.path && !p.path.startsWith('/')) errs.push(`spec.rules[${i}].http.paths[${j}].path: Invalid value: "${p.path}": must be an absolute path`);
            })
          );
          if (!s.defaultBackend && !(s.rules || []).length) errs.push('spec: Invalid value: {"defaultBackend":null}: either `defaultBackend` or `rules` must be specified');
          break;
        case 'horizontalpodautoscalers.autoscaling':
          if (!s.scaleTargetRef) errs.push('spec.scaleTargetRef.kind: Required value');
          if (!s.maxReplicas) errs.push('spec.maxReplicas: Invalid value: 0: must be greater than or equal to 1');
          if (s.minReplicas > s.maxReplicas) errs.push(`spec.minReplicas: Invalid value: ${s.minReplicas}: must be less than or equal to maxReplicas`);
          break;
        case 'poddisruptionbudgets.policy':
          if (s.minAvailable !== undefined && s.maxUnavailable !== undefined) errs.push('spec: Invalid value: policy.PodDisruptionBudgetSpec{...}: minAvailable and maxUnavailable cannot be both set');
          break;
        case 'priorityclasses.scheduling.k8s.io':
          if (obj.value === undefined) errs.push('value: Required value');
          if (obj.value > 1000000000 && !obj.metadata.name.startsWith('system-')) errs.push(`value: Forbidden: maximum allowed value of a user defined priority is 1000000000`);
          break;
        case 'customresourcedefinitions.apiextensions.k8s.io': {
          const nm = s.names || {};
          if (!s.group) errs.push('spec.group: Required value');
          if (!nm.plural) errs.push('spec.names.plural: Required value');
          if (!nm.kind) errs.push('spec.names.kind: Required value');
          if (nm.plural && s.group && obj.metadata.name !== `${nm.plural}.${s.group}`) errs.push(`metadata.name: Invalid value: "${obj.metadata.name}": must be spec.names.plural+"."+spec.group`);
          if (!(s.versions || []).length) errs.push('spec.versions: Invalid value: []apiextensions.CustomResourceDefinitionVersion(nil): must have exactly one version marked as storage version');
          else if ((s.versions || []).filter((v) => v.storage).length !== 1) errs.push('spec.versions: Invalid value: ...: must have exactly one version marked as storage version');
          if (!['Namespaced', 'Cluster'].includes(s.scope)) errs.push(`spec.scope: Unsupported value: "${s.scope || ''}": supported values: "Cluster", "Namespaced"`);
          for (const v of s.versions || []) if (!v.schema || !v.schema.openAPIV3Schema) errs.push(`spec.versions[0].schema.openAPIV3Schema: Required value: schemas are required`);
          break;
        }
        case 'limitranges':
          if (!s.limits) errs.push('spec.limits: Required value');
          break;
        case 'resourcequotas':
          for (const [k, v] of Object.entries((s && s.hard) || {})) if (!U.validQuantity(v)) errs.push(`spec.hard[${k}]: Invalid value: "${v}": must be a valid quantity`);
          break;
        case 'networkpolicies.networking.k8s.io':
          for (const pt of s.policyTypes || []) if (!['Ingress', 'Egress'].includes(pt)) errs.push(`spec.policyTypes: Unsupported value: "${pt}": supported values: "Ingress", "Egress"`);
          break;
      }
      if (t.crd) this.validateCR(t, obj, errs);
      return errs;
    }
    // validação estrutural simples com o openAPIV3Schema do CRD
    validateCR(t, obj, errs) {
      const crd = this.raw(this.T('customresourcedefinitions.apiextensions.k8s.io'), '', t.crd);
      if (!crd) return;
      const ver = (crd.spec.versions || []).find((v) => v.name === (obj.apiVersion || '').split('/')[1]);
      if (!ver) return;
      const check = (schema, val, path) => {
        if (!schema || val === undefined || val === null) return;
        const type = schema.type;
        const actual = Array.isArray(val) ? 'array' : Number.isInteger(val) ? 'integer' : typeof val;
        if (type && !(type === actual || (type === 'number' && (actual === 'integer' || actual === 'number')) || (type === 'object' && actual === 'object'))) {
          errs.push(`${path}: Invalid value: "${actual}": ${path} in body must be of type ${type}: "${actual}"`);
          return;
        }
        if (schema.enum && !schema.enum.includes(val)) errs.push(`${path}: Unsupported value: ${JSON.stringify(val)}: supported values: ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
        if (schema.minimum !== undefined && val < schema.minimum) errs.push(`${path}: Invalid value: ${val}: ${path} in body should be greater than or equal to ${schema.minimum}`);
        if (schema.maximum !== undefined && val > schema.maximum) errs.push(`${path}: Invalid value: ${val}: ${path} in body should be less than or equal to ${schema.maximum}`);
        if (type === 'object' && schema.properties) {
          for (const r of schema.required || []) if (val[r] === undefined) errs.push(`${path}.${r}: Required value`);
          for (const [k, sub] of Object.entries(schema.properties)) check(sub, val[k], `${path}.${k}`);
        }
        if (type === 'array' && schema.items) val.forEach((x, i) => check(schema.items, x, `${path}[${i}]`));
      };
      const sch = ver.schema && ver.schema.openAPIV3Schema;
      if (!sch || !sch.properties) return;
      for (const r of sch.required || []) if (obj[r] === undefined) errs.push(`${r}: Required value`);
      for (const [k, sub] of Object.entries(sch.properties)) if (!['apiVersion', 'kind', 'metadata'].includes(k)) check(sub, obj[k], k);
    }
    validateUpdate(t, old, neu) {
      const errs = [];
      const os = old.spec || {}, ns = neu.spec || {};
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      switch (t.id) {
        case 'pods': {
          const strip = (sp) => {
            const c = U.clone(sp || {});
            for (const k of ['containers', 'initContainers']) for (const x of c[k] || []) delete x.image;
            delete c.activeDeadlineSeconds;
            delete c.tolerations;
            delete c.terminationGracePeriodSeconds;
            delete c.ephemeralContainers;
            if (!old.spec.nodeName) delete c.nodeName;
            delete c.schedulingGates;
            return c;
          };
          if (!same(strip(os), strip(ns)))
            errs.push('spec: Forbidden: pod updates may not change fields other than `spec.containers[*].image`,`spec.initContainers[*].image`,`spec.activeDeadlineSeconds`,`spec.tolerations` (only additions to existing tolerations),`spec.terminationGracePeriodSeconds` (allow it to be set to 1 if it was previously negative)');
          break;
        }
        case 'deployments.apps':
        case 'replicasets.apps':
        case 'daemonsets.apps':
          if (!same(os.selector, ns.selector)) errs.push(`spec.selector: Invalid value: v1.LabelSelector{MatchLabels:map[string]string{${Object.entries((ns.selector || {}).matchLabels || {}).map(([k, v]) => `"${k}":"${v}"`).join(', ')}}, MatchExpressions:[]v1.LabelSelectorRequirement(nil)}: field is immutable`);
          break;
        case 'statefulsets.apps': {
          const strip = (sp) => {
            const c = U.clone(sp);
            for (const k of ['replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy', 'minReadySeconds']) delete c[k];
            return c;
          };
          if (!same(strip(os), strip(ns)))
            errs.push("spec: Forbidden: updates to statefulset spec for fields other than 'replicas', 'ordinals', 'template', 'updateStrategy', 'persistentVolumeClaimRetentionPolicy' and 'minReadySeconds' are forbidden");
          break;
        }
        case 'jobs.batch':
          if (!same(os.selector, ns.selector)) errs.push('spec.selector: Invalid value: ...: field is immutable');
          if (!same(os.template, ns.template) && !ns.suspend) errs.push('spec.template: Invalid value: core.PodTemplateSpec{...}: field is immutable');
          if (os.completions !== ns.completions && !(ns.completionMode === 'Indexed' && ns.completions === ns.parallelism)) errs.push(`spec.completions: Invalid value: ${ns.completions}: field is immutable`);
          break;
        case 'services':
          if (os.clusterIP && ns.clusterIP && os.clusterIP !== ns.clusterIP) errs.push(`spec.clusterIPs[0]: Invalid value: []string{"${ns.clusterIP}"}: may not change once set`);
          break;
        case 'configmaps':
        case 'secrets':
          if (old.immutable && (!same(old.data, neu.data) || !same(old.binaryData, neu.binaryData))) errs.push('data: Forbidden: field is immutable when `immutable` is set');
          if (old.immutable && !neu.immutable) errs.push('immutable: Forbidden: field is immutable when `immutable` is set');
          if (t.id === 'secrets' && old.type !== neu.type) errs.push(`type: Invalid value: "${neu.type}": field is immutable`);
          break;
        case 'rolebindings.rbac.authorization.k8s.io':
        case 'clusterrolebindings.rbac.authorization.k8s.io':
          if (!same(old.roleRef, neu.roleRef)) errs.push(`roleRef: Invalid value: rbac.RoleRef{APIGroup:"rbac.authorization.k8s.io", Kind:"${neu.roleRef.kind}", Name:"${neu.roleRef.name}"}: cannot change roleRef`);
          break;
        case 'persistentvolumeclaims': {
          const strip = (sp) => {
            const c = U.clone(sp || {});
            if (c.resources) delete c.resources.requests;
            delete c.volumeName;
            delete c.storageClassName;
            return c;
          };
          if (!same(strip(os), strip(ns))) errs.push('spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims');
          if (os.storageClassName && os.storageClassName !== ns.storageClassName) errs.push('spec: Forbidden: spec is immutable after creation except resources.requests and volumeAttributesClassName for bound claims');
          const oReq = U.parseQuantity((os.resources || {}).requests?.storage), nReq = U.parseQuantity((ns.resources || {}).requests?.storage);
          if (nReq < oReq) errs.push(`spec.resources.requests.storage: Forbidden: field can not be less than status.capacity`);
          if (nReq > oReq) {
            const sc = this.raw(this.T('storageclasses.storage.k8s.io'), '', ns.storageClassName);
            if (!sc || !sc.allowVolumeExpansion) errs.push('spec: Forbidden: only dynamically provisioned pvc can be resized and the storageclass that provisions the pvc must support resize');
          }
          break;
        }
        case 'storageclasses.storage.k8s.io':
          if (old.provisioner !== neu.provisioner || !same(old.parameters, neu.parameters) || old.reclaimPolicy !== neu.reclaimPolicy || old.volumeBindingMode !== neu.volumeBindingMode)
            errs.push('parameters: Forbidden: updates to parameters are forbidden.');
          break;
        case 'priorityclasses.scheduling.k8s.io':
          if (old.value !== neu.value) errs.push('Value: Forbidden: may not be changed in an update.');
          break;
      }
      return errs;
    }

    // ---------- admissão ----------
    admit(t, obj, ctx, isUpdate, old) {
      const ns = obj.metadata.namespace;
      if (t.plural === 'pods' && !isUpdate) {
        // ServiceAccount
        const sa = obj.spec.serviceAccountName;
        if (!this.raw(this.T('serviceaccounts'), ns, sa))
          throw E.forbidden(`pods "${obj.metadata.name || obj.metadata.generateName}" is forbidden: error looking up service account ${ns}/${sa}: serviceaccount "${sa}" not found`);
        // PriorityClass
        if (obj.spec.priorityClassName) {
          const pc = this.raw(this.T('priorityclasses.scheduling.k8s.io'), '', obj.spec.priorityClassName);
          if (!pc) throw E.forbidden(`pods "${obj.metadata.name}" is forbidden: no PriorityClass with name ${obj.spec.priorityClassName} was found`);
          obj.spec.priority = pc.value;
          if (pc.preemptionPolicy) obj.spec.preemptionPolicy = pc.preemptionPolicy;
        } else {
          const def = this.rawList(this.T('priorityclasses.scheduling.k8s.io')).find((p) => p.globalDefault);
          if (def) { obj.spec.priorityClassName = def.metadata.name; obj.spec.priority = def.value; }
        }
        // LimitRanger
        const lrs = this.rawList(this.T('limitranges'), ns);
        for (const lr of lrs) {
          for (const lim of (lr.spec && lr.spec.limits) || []) {
            if (lim.type !== 'Container') continue;
            for (const c of [...(obj.spec.containers || []), ...(obj.spec.initContainers || [])]) {
              c.resources ??= {};
              if (lim.default) {
                c.resources.limits ??= {};
                for (const [k, v] of Object.entries(lim.default)) if (c.resources.limits[k] === undefined) c.resources.limits[k] = v;
              }
              if (lim.defaultRequest || lim.default) {
                c.resources.requests ??= {};
                for (const [k, v] of Object.entries(lim.defaultRequest || lim.default)) if (c.resources.requests[k] === undefined) c.resources.requests[k] = v;
              }
              for (const [k, v] of Object.entries(lim.max || {})) {
                const l = (c.resources.limits || {})[k];
                if (l !== undefined && U.parseQuantity(l) > U.parseQuantity(v))
                  throw E.forbidden(`pods "${obj.metadata.name}" is forbidden: maximum ${k} usage per Container is ${v}, but limit is ${l}`);
              }
              for (const [k, v] of Object.entries(lim.min || {})) {
                const r = (c.resources.requests || {})[k];
                if (r === undefined || U.parseQuantity(r) < U.parseQuantity(v))
                  throw E.forbidden(`pods "${obj.metadata.name}" is forbidden: minimum ${k} usage per Container is ${v}, but request is ${r ?? 0}`);
              }
            }
            const anns = [];
            if (lim.defaultRequest || lim.default) anns.push('LimitRanger plugin set: cpu, memory request for container');
          }
        }
        if (lrs.length) obj.status.qosClass = this.qosClass(obj.spec);
      }
      // ResourceQuota
      if (!isUpdate && t.namespaced) this.checkQuota(t, obj);
    }
    usageOf(t, obj) {
      const u = {};
      const add = (k, v) => (u[k] = (u[k] || 0) + v);
      add(`count/${t.group ? t.plural + '.' + t.group : t.plural}`, 1);
      if (t.plural === 'pods') {
        add('pods', 1);
        for (const c of obj.spec.containers || []) {
          const r = c.resources || {};
          for (const k of ['cpu', 'memory', 'ephemeral-storage']) {
            if ((r.requests || {})[k] !== undefined) { add(`requests.${k}`, U.parseQuantity(r.requests[k])); if (k !== 'ephemeral-storage') add(k, U.parseQuantity(r.requests[k])); }
            if ((r.limits || {})[k] !== undefined) add(`limits.${k}`, U.parseQuantity(r.limits[k]));
          }
        }
      }
      if (t.plural === 'services') {
        add('services', 1);
        if (obj.spec.type === 'NodePort') add('services.nodeports', (obj.spec.ports || []).length);
        if (obj.spec.type === 'LoadBalancer') { add('services.loadbalancers', 1); add('services.nodeports', (obj.spec.ports || []).length); }
      }
      if (t.plural === 'configmaps') add('configmaps', 1);
      if (t.plural === 'secrets') add('secrets', 1);
      if (t.plural === 'replicationcontrollers') add('replicationcontrollers', 1);
      if (t.plural === 'resourcequotas') add('resourcequotas', 1);
      if (t.plural === 'persistentvolumeclaims') {
        add('persistentvolumeclaims', 1);
        add('requests.storage', U.parseQuantity(obj.spec.resources.requests.storage));
      }
      return u;
    }
    quotaUsed(ns) {
      const used = {};
      for (const t of S.types) {
        if (!t.namespaced || t.group === 'metrics.k8s.io' || t.plural === 'events') continue;
        for (const o of this.rawList(t, ns)) {
          if (t.plural === 'pods' && (o.status.phase === 'Succeeded' || o.status.phase === 'Failed')) continue;
          for (const [k, v] of Object.entries(this.usageOf(t, o))) used[k] = (used[k] || 0) + v;
        }
      }
      return used;
    }
    checkQuota(t, obj) {
      const quotas = this.rawList(this.T('resourcequotas'), obj.metadata.namespace);
      if (!quotas.length) return;
      const add = this.usageOf(t, obj);
      const used = this.quotaUsed(obj.metadata.namespace);
      for (const q of quotas) {
        const hard = (q.spec && q.spec.hard) || {};
        // pods sem requests quando a quota exige
        if (t.plural === 'pods') {
          const needs = ['requests.cpu', 'requests.memory', 'limits.cpu', 'limits.memory', 'cpu', 'memory'].filter((k) => k in hard);
          const missing = needs.filter((k) => !(k in add));
          if (missing.length)
            throw E.forbidden(`pods "${obj.metadata.name || obj.metadata.generateName}" is forbidden: failed quota: ${q.metadata.name}: must specify ${[...new Set(missing)].sort().join(',')}`);
        }
        const exceeded = [];
        for (const [k, v] of Object.entries(add)) {
          if (!(k in hard)) continue;
          const lim = U.parseQuantity(hard[k]);
          if ((used[k] || 0) + v > lim) exceeded.push(k);
        }
        if (exceeded.length) {
          const fmt = (k, v) => (/cpu/.test(k) ? U.fmtCPU(Math.round(v * 1000)) : /memory|storage/.test(k) ? U.fmtMem(v) : String(v));
          const req = exceeded.map((k) => `${k}=${fmt(k, add[k])}`).join(',');
          const us = exceeded.map((k) => `${k}=${fmt(k, used[k] || 0)}`).join(',');
          const lm = exceeded.map((k) => `${k}=${hard[k]}`).join(',');
          throw E.forbidden(`${t.qualified} "${obj.metadata.name || obj.metadata.generateName}" is forbidden: exceeded quota: ${q.metadata.name}, requested: ${req}, used: ${us}, limited: ${lm}`);
        }
      }
    }
    allocServiceIPs(obj, old) {
      const s = obj.spec;
      const svcs = this.rawList(this.T('services')).filter((x) => !old || x.metadata.uid !== old.metadata.uid);
      if (s.type === 'ExternalName') {
        delete s.clusterIP;
        delete s.clusterIPs;
      } else if (old && old.spec.clusterIP && !s.clusterIP) {
        s.clusterIP = old.spec.clusterIP;
      } else if (!s.clusterIP) {
        const used = new Set(svcs.map((x) => x.spec.clusterIP));
        let ip;
        do ip = `10.96.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 253)}`;
        while (used.has(ip) || ip === '10.96.0.1' || ip === '10.96.0.10');
        s.clusterIP = ip;
      } else if (s.clusterIP !== 'None') {
        if (!/^10\.(9[6-9]|10[0-9]|11[01])\.\d+\.\d+$/.test(s.clusterIP))
          throw E.invalid(this.T('services'), obj.metadata.name, [`spec.clusterIPs: Invalid value: []string{"${s.clusterIP}"}: failed to allocate IP ${s.clusterIP}: the provided IP (${s.clusterIP}) is not in the valid range. The range of valid IPs is 10.96.0.0/12`]);
        if (svcs.some((x) => x.spec.clusterIP === s.clusterIP))
          throw E.invalid(this.T('services'), obj.metadata.name, [`spec.clusterIPs: Invalid value: []string{"${s.clusterIP}"}: failed to allocate IP ${s.clusterIP}: provided IP is already allocated`]);
      }
      if (s.clusterIP) s.clusterIPs = [s.clusterIP];
      if (s.type === 'NodePort' || s.type === 'LoadBalancer') {
        const used = new Set();
        svcs.forEach((x) => (x.spec.ports || []).forEach((p) => p.nodePort && used.add(p.nodePort)));
        (s.ports || []).forEach((p, i) => {
          const prev = old && (old.spec.ports || []).find((op) => op.port === p.port && op.nodePort);
          if (!p.nodePort && prev) p.nodePort = prev.nodePort;
          if (p.nodePort) {
            if (used.has(p.nodePort)) throw E.invalid(this.T('services'), obj.metadata.name, [`spec.ports[${i}].nodePort: Invalid value: ${p.nodePort}: provided port is already allocated`]);
          } else {
            let np;
            do np = 30000 + Math.floor(Math.random() * 2768);
            while (used.has(np));
            p.nodePort = np;
          }
          used.add(p.nodePort);
        });
      } else (s.ports || []).forEach((p) => delete p.nodePort);
    }

    // ---------- API pública ----------
    get(t, ns, name, ctx) {
      this.authz(ctx, 'get', t, ns, name);
      const o = this.raw(t, ns, name);
      if (!o) throw E.notFound(t, name);
      return U.clone(o);
    }
    list(t, ns, opts = {}, ctx) {
      this.authz(ctx, 'list', t, ns);
      if (t.namespaced && ns && t.plural !== 'namespaces' && !this.raw(this.T('namespaces'), '', ns) && false) return [];
      let items = t.group === 'metrics.k8s.io' ? this.metricsList(t, ns) : this.rawList(t, ns);
      if (opts.labelSelector) {
        const reqs = U.parseLabelSelector(opts.labelSelector);
        items = items.filter((o) => U.matchReqs(reqs, o.metadata.labels));
      }
      if (opts.fieldSelector) {
        const fs = U.parseFieldSelector(opts.fieldSelector);
        const allowed = this.fieldSelectorFields(t);
        for (const f of fs)
          if (!allowed.includes(f.path))
            throw E.badRequest(`Unable to find "${t.group ? t.group + '/' + t.version : '/' + t.version}, Resource=${t.plural}" that match label selector "${opts.labelSelector || ''}", field selector "${opts.fieldSelector}": field label not supported: ${f.path}`);
        items = items.filter((o) =>
          fs.every((f) => {
            let v = U.getPath(o, f.path);
            if (v === undefined || v === null) v = '';
            v = String(v);
            return f.neg ? v !== f.value : v === f.value;
          })
        );
      }
      return items.map(U.clone);
    }
    fieldSelectorFields(t) {
      const base = ['metadata.name', 'metadata.namespace'];
      const extra = {
        pods: ['spec.nodeName', 'spec.restartPolicy', 'spec.schedulerName', 'spec.serviceAccountName', 'spec.hostNetwork', 'status.phase', 'status.podIP', 'status.podIPs', 'status.nominatedNodeName'],
        events: ['involvedObject.kind', 'involvedObject.namespace', 'involvedObject.name', 'involvedObject.uid', 'involvedObject.apiVersion', 'involvedObject.resourceVersion', 'involvedObject.fieldPath', 'reason', 'reportingComponent', 'source', 'type'],
        secrets: ['type'],
        namespaces: ['status.phase'],
        nodes: ['spec.unschedulable'],
        'jobs.batch': ['status.successful'],
        'replicasets.apps': ['status.replicas'],
        replicationcontrollers: ['status.replicas'],
        'certificatesigningrequests.certificates.k8s.io': ['spec.signerName'],
      };
      return base.concat(extra[t.id] || []);
    }
    prepareNew(t, input, ctx) {
      const obj = U.clone(input);
      obj.metadata ??= {};
      obj.apiVersion = obj.apiVersion || t.apiVersion;
      obj.kind = t.kind;
      const m = obj.metadata;
      if (t.namespaced) m.namespace = m.namespace || 'default';
      else delete m.namespace;
      if (!m.name && m.generateName) m.name = m.generateName + U.rand(5);
      for (const k of ['uid', 'resourceVersion', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'generation', 'selfLink', 'managedFields']) delete m[k];
      if (t.id === 'pods') delete obj.status;
      return obj;
    }
    create(input, ctx = SYSTEM, opts = {}) {
      const t = this.typeOf(input);
      if (!t) throw E.badRequest(`no matches for kind "${input.kind}" in version "${input.apiVersion}"`);
      if (t.verbs && !t.verbs.includes('create')) throw new ApiError(405, 'MethodNotAllowed', `the server does not allow this method on the requested resource`);
      const obj = this.prepareNew(t, input, ctx);
      const ns = obj.metadata.namespace;
      this.authz(ctx, 'create', t, ns, undefined);
      if (t.namespaced) {
        const nso = this.raw(this.T('namespaces'), '', ns);
        if (!nso) throw new ApiError(404, 'NotFound', `namespaces "${ns}" not found`);
        if (nso.status.phase === 'Terminating')
          throw E.forbidden(`${t.qualified} "${obj.metadata.name}" is forbidden: unable to create new content in namespace ${ns} because it is being terminated`);
      }
      const nameErr = this.validateName(t, obj.metadata.name);
      if (!obj.metadata.name) throw E.invalid(t, '', ['metadata.name: Required value: name or generateName is required']);
      if (this.raw(t, ns, obj.metadata.name)) throw E.exists(t, obj.metadata.name);
      obj.metadata.uid = U.uid();
      obj.metadata.creationTimestamp = U.iso(this.now());
      if (obj.spec !== undefined || ['deployments.apps', 'replicasets.apps', 'statefulsets.apps', 'daemonsets.apps', 'jobs.batch', 'cronjobs.batch'].includes(t.id) || t.crd) obj.metadata.generation = 1;
      if (t.id === 'pods' || t.id === 'services' || t.id === 'namespaces' || t.id === 'persistentvolumeclaims' || t.id === 'persistentvolumes') obj.spec ??= {};
      this.applyDefaults(t, obj);
      const errs = this.validate(t, obj);
      if (nameErr && !errs.includes(nameErr)) errs.unshift(nameErr);
      if (errs.length) throw E.invalid(t, obj.metadata.name, errs);
      this.admit(t, obj, ctx, false);
      if (t.id === 'services') this.allocServiceIPs(obj, null);
      if (t.id === 'customresourcedefinitions.apiextensions.k8s.io') {
        const sp = obj.spec;
        const clash = S.types.find((x) => x.plural === sp.names.plural && x.group === sp.group && !x.crd);
        if (clash) throw E.invalid(t, obj.metadata.name, [`spec.names.plural: Invalid value: "${sp.names.plural}": "${sp.names.plural}" is already in use`]);
      }
      if (t.id === 'certificatesigningrequests.certificates.k8s.io') {
        obj.spec.username = ctx.user || 'kubernetes-admin';
        obj.spec.groups = ctx.groups || ['kubeadm:cluster-admins', 'system:authenticated'];
      }
      if (opts.dryRun) return obj;
      this.put(t, obj, 'ADDED');
      if (t.id === 'customresourcedefinitions.apiextensions.k8s.io') this.registerCRD(obj);
      this.afterCreate(t, obj);
      return U.clone(obj);
    }
    afterCreate(t, obj) {
      if (t.id === 'namespaces') this.ensureNamespaceDefaults(obj);
    }
    ensureNamespaceDefaults(nsObj) {
      const ns = nsObj.metadata.name;
      const saT = this.T('serviceaccounts');
      if (!this.raw(saT, ns, 'default'))
        this.put(saT, { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'default', namespace: ns, uid: U.uid(), creationTimestamp: nsObj.metadata.creationTimestamp } }, 'ADDED');
      const cmT = this.T('configmaps');
      if (!this.raw(cmT, ns, 'kube-root-ca.crt'))
        this.put(cmT, {
          apiVersion: 'v1', kind: 'ConfigMap',
          metadata: { name: 'kube-root-ca.crt', namespace: ns, uid: U.uid(), creationTimestamp: nsObj.metadata.creationTimestamp, annotations: { 'kubernetes.io/description': 'Contains a CA bundle that can be used to verify the kube-apiserver when using internal endpoints such as the internal service IP or kubernetes.default.svc. No other usage is guaranteed across distributions of Kubernetes clusters.' } },
          data: { 'ca.crt': KS.CA_CRT },
        }, 'ADDED');
    }
    specOf(t, o) {
      if (o.spec !== undefined) return o.spec;
      const c = { ...o };
      delete c.metadata;
      delete c.status;
      return c;
    }
    update(input, ctx = SYSTEM, opts = {}) {
      const t = this.typeOf(input);
      if (!t) throw E.badRequest(`no matches for kind "${input.kind}" in version "${input.apiVersion}"`);
      const ns = t.namespaced ? input.metadata.namespace || 'default' : '';
      const name = input.metadata.name;
      this.authz(ctx, opts.subresource === 'status' ? 'update' : 'update', t, ns, name, opts.subresource);
      const old = this.raw(t, ns, name);
      if (!old) throw E.notFound(t, name);
      if (input.metadata.resourceVersion && input.metadata.resourceVersion !== old.metadata.resourceVersion) throw E.conflict(t, name);
      const obj = U.clone(input);
      obj.apiVersion = old.apiVersion.includes('/') || !t.group ? obj.apiVersion || old.apiVersion : old.apiVersion;
      obj.kind = t.kind;
      const m = obj.metadata;
      for (const k of ['uid', 'creationTimestamp', 'deletionTimestamp', 'deletionGracePeriodSeconds', 'generation']) {
        if (old.metadata[k] !== undefined) m[k] = old.metadata[k];
        else delete m[k];
      }
      if (t.namespaced) m.namespace = ns;
      delete m.managedFields;
      const hasStatusSub = !!(S.subresources[t.plural] || []).includes('status') || t.id === 'pods';
      if (opts.subresource === 'status') {
        const keep = U.clone(old);
        keep.status = obj.status;
        return this.commitUpdate(t, old, keep, ctx, opts);
      }
      if (hasStatusSub && old.status !== undefined) obj.status = U.clone(old.status);
      // defaults para spec novo
      if (t.id === 'services') {
        this.applyDefaults(t, obj);
        obj.status = U.clone(old.status);
        this.allocServiceIPs(obj, old);
      } else if (t.id === 'pods') {
        for (const c of obj.spec.containers || []) this.containerDefaults(c);
      } else if (['deployments.apps', 'replicasets.apps', 'statefulsets.apps', 'daemonsets.apps', 'jobs.batch', 'cronjobs.batch', 'replicationcontrollers', 'persistentvolumes', 'persistentvolumeclaims', 'secrets', 'networkpolicies.networking.k8s.io', 'horizontalpodautoscalers.autoscaling', 'storageclasses.storage.k8s.io', 'ingresses.networking.k8s.io'].includes(t.id)) {
        const st = obj.status;
        const fin = obj.metadata.finalizers;
        if (t.id === 'jobs.batch') {
          // preserva seletor/labels gerados
          obj.spec.selector ??= old.spec.selector;
          obj.spec.template.metadata ??= {};
          obj.spec.template.metadata.labels = { ...(old.spec.template.metadata.labels || {}), ...(obj.spec.template.metadata.labels || {}) };
        }
        this.applyDefaults(t, obj);
        obj.status = st;
        if (t.id === 'jobs.batch') obj.spec.selector = old.spec.selector;
        if (fin !== undefined) obj.metadata.finalizers = fin;
        if (t.id === 'persistentvolumeclaims' || t.id === 'persistentvolumes') obj.metadata.finalizers = fin || old.metadata.finalizers;
      }
      return this.commitUpdate(t, old, obj, ctx, opts);
    }
    commitUpdate(t, old, obj, ctx, opts) {
      const errs = this.validate(t, obj).concat(this.validateUpdate(t, old, obj));
      if (errs.length) throw E.invalid(t, obj.metadata.name, errs);
      if (JSON.stringify(this.specOf(t, old)) !== JSON.stringify(this.specOf(t, obj)) && old.metadata.generation !== undefined) obj.metadata.generation = (old.metadata.generation || 1) + 1;
      const changed = JSON.stringify({ ...old, metadata: { ...old.metadata, resourceVersion: '' } }) !== JSON.stringify({ ...obj, metadata: { ...obj.metadata, resourceVersion: '' } });
      if (opts.dryRun) return obj;
      if (!changed) return U.clone(old);
      this.put(t, obj, 'MODIFIED');
      if (t.id === 'customresourcedefinitions.apiextensions.k8s.io') this.registerCRD(obj);
      // remoção pendente de finalizers
      if (obj.metadata.deletionTimestamp && !(obj.metadata.finalizers || []).length && t.id !== 'pods' && t.id !== 'namespaces') this.removeRaw(t, obj);
      const out = U.clone(obj);
      out._changed = true;
      return out;
    }
    patch(t, ns, name, patch, type = 'strategic', ctx = SYSTEM, opts = {}) {
      this.authz(ctx, 'patch', t, ns, name, opts.subresource);
      const old = this.raw(t, ns, name);
      if (!old) throw E.notFound(t, name);
      let next;
      if (type === 'json') next = U.jsonPatch(old, patch);
      else if (type === 'merge') next = U.mergePatch(old, patch);
      else {
        if (t.crd) throw new ApiError(415, 'UnsupportedMediaType', 'the body of the request was in an unknown format - accepted media types include: application/json-patch+json, application/merge-patch+json, application/apply-patch+yaml');
        next = U.strategicMerge(old, patch);
      }
      if (!next || !next.metadata) throw E.badRequest('invalid patch result');
      if (!patch || !patch.metadata || !patch.metadata.resourceVersion) next.metadata.resourceVersion = old.metadata.resourceVersion;
      next.metadata.name = old.metadata.name;
      if (opts.subresource === 'status') {
        const keep = U.clone(old);
        keep.status = next.status;
        return this.commitUpdate(t, old, keep, ctx, opts);
      }
      if (opts.subresource === 'scale') {
        const keep = U.clone(old);
        keep.spec.replicas = next.spec.replicas;
        return this.commitUpdate(t, old, keep, ctx, opts);
      }
      return this.update(next, SYSTEM, opts);
    }
    delete(t, ns, name, opts = {}, ctx = SYSTEM) {
      this.authz(ctx, 'delete', t, ns, name);
      const o = this.raw(t, ns, name);
      if (!o) throw E.notFound(t, name);
      if (t.id === 'namespaces' && PROTECTED_NS.includes(name)) throw E.forbidden(`namespaces "${name}" is forbidden: this namespace may not be deleted`);
      if (t.id === 'services' && name === 'kubernetes' && ns === 'default' && false) return U.clone(o);
      if (opts.dryRun) return U.clone(o);
      const now = this.now();
      if (o.metadata.deletionTimestamp) {
        if (t.id === 'pods' && opts.gracePeriodSeconds === 0) {
          this.removeRaw(t, o);
          return U.clone(o);
        }
        return U.clone(o);
      }
      const policy = opts.propagationPolicy || 'Background';
      if (policy === 'Orphan') this.orphanDependents(o);
      if (policy === 'Foreground' && this.hasDependents(o)) {
        o.metadata.finalizers = [...new Set([...(o.metadata.finalizers || []), 'foregroundDeletion'])];
      }
      let grace = 0;
      let graceful = false;
      if (t.id === 'pods') {
        grace = opts.gracePeriodSeconds ?? o.spec.terminationGracePeriodSeconds ?? 30;
        const finished = o.status.phase === 'Succeeded' || o.status.phase === 'Failed';
        graceful = !!o.spec.nodeName && grace > 0 && !finished && !!this.raw(this.T('nodes'), '', o.spec.nodeName);
      }
      if (t.id === 'namespaces') {
        o.metadata.deletionTimestamp = U.iso(now);
        o.status.phase = 'Terminating';
        this.put(t, o);
        return U.clone(o);
      }
      if ((o.metadata.finalizers || []).length || graceful) {
        o.metadata.deletionTimestamp = U.iso(now + grace * 1000);
        o.metadata.deletionGracePeriodSeconds = grace;
        this.put(t, o);
        return U.clone(o);
      }
      this.removeRaw(t, o);
      return U.clone(o);
    }
    dependents(o) {
      const out = [];
      for (const t of S.types) {
        if (t.group === 'metrics.k8s.io') continue;
        for (const d of Object.values(this.data[t.id] || {})) if ((d.metadata.ownerReferences || []).some((r) => r.uid === o.metadata.uid)) out.push([t, d]);
      }
      return out;
    }
    hasDependents(o) {
      return this.dependents(o).length > 0;
    }
    orphanDependents(o) {
      for (const [t, d] of this.dependents(o)) {
        d.metadata.ownerReferences = d.metadata.ownerReferences.filter((r) => r.uid !== o.metadata.uid);
        if (!d.metadata.ownerReferences.length) delete d.metadata.ownerReferences;
        this.put(t, d);
      }
    }

    // ---------- metrics.k8s.io ----------
    metricsAvailable() {
      const d = this.raw(this.T('deployments.apps'), 'kube-system', 'metrics-server');
      return !!d && (d.status.availableReplicas || 0) > 0;
    }
    metricsList(t, ns) {
      if (!this.metricsAvailable()) return [];
      const now = U.iso(this.now());
      if (t.kind === 'NodeMetrics') {
        return this.rawList(this.T('nodes')).map((n) => {
          const u = this.nodeUsage(n.metadata.name);
          return {
            apiVersion: 'metrics.k8s.io/v1beta1', kind: 'NodeMetrics',
            metadata: { name: n.metadata.name, creationTimestamp: now, labels: n.metadata.labels },
            timestamp: now, window: '20.05s',
            usage: { cpu: Math.round(u.cpu * 1e6) + 'n', memory: Math.round(u.mem / 1024) + 'Ki' },
          };
        });
      }
      const out = [];
      for (const p of this.rawList(this.T('pods'), ns)) {
        const m = this.podMetrics(p);
        if (!m) continue;
        out.push({
          apiVersion: 'metrics.k8s.io/v1beta1', kind: 'PodMetrics',
          metadata: { name: p.metadata.name, namespace: p.metadata.namespace, creationTimestamp: now, labels: p.metadata.labels },
          timestamp: now, window: '15.012s',
          containers: m.map((c) => ({ name: c.name, usage: { cpu: Math.round(c.cpu * 1e6) + 'n', memory: Math.round(c.mem / 1024) + 'Ki' } })),
        });
      }
      return out;
    }

    // ---------- REST ----------
    // Retorna {status, body(obj|string), contentType}
    rest(method, url, body, ctx = SYSTEM, headers = {}) {
      const u = new URL(url, 'https://127.0.0.1:6443');
      const path = u.pathname.replace(/\/+$/, '') || '/';
      const q = Object.fromEntries(u.searchParams.entries());
      const ok = (b, st = 200) => ({ status: st, body: b });
      const status = (e) => ({
        status: e.code || 500,
        body: {
          kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message: e.message, reason: e.reason || 'InternalError',
          details: e.details, code: e.code || 500,
        },
      });
      try {
        if (path === '/version') return ok(KS.serverVersion());
        if (['/healthz', '/livez', '/readyz'].includes(path)) {
          if ('verbose' in q) {
            const checks = ['ping', 'log', 'etcd', 'poststarthook/start-apiserver-admission-initializer', 'poststarthook/generic-apiserver-start-informers', 'poststarthook/start-kube-aggregator-informers', 'poststarthook/apiservice-registration-controller', 'poststarthook/bootstrap-controller', 'poststarthook/rbac/bootstrap-roles', 'poststarthook/scheduling/bootstrap-system-priority-classes'];
            if (path === '/readyz') checks.splice(3, 0, 'etcd-readiness', 'informer-sync', 'shutdown');
            return ok(checks.map((c) => `[+]${c} ok`).join('\n') + `\n${path.slice(1)} check passed\n`);
          }
          return ok('ok');
        }
        if (path === '/metrics') return ok('# HELP apiserver_request_total [STABLE] Counter of apiserver requests broken out for each verb, dry run value, group, version, resource, scope, component, and HTTP response code.\n# TYPE apiserver_request_total counter\napiserver_request_total{code="200",component="apiserver",dry_run="",group="",resource="pods",scope="namespace",subresource="",verb="LIST",version="v1"} ' + (this.rv % 997) + '\n');
        if (path === '/') return ok({ paths: ['/api', '/api/v1', '/apis', ...this.apiGroupList().groups.map((g) => '/apis/' + g.name), '/healthz', '/livez', '/metrics', '/openapi/v2', '/openapi/v3', '/readyz', '/version'] });
        if (path === '/api') return ok({ kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [{ clientCIDR: '0.0.0.0/0', serverAddress: '172.18.0.2:6443' }] });
        if (path === '/apis') return ok(this.apiGroupList());
        if (path.startsWith('/openapi')) return ok({ swagger: '2.0', info: { title: 'Kubernetes', version: this.version }, paths: {} });
        let m = path.match(/^\/apis\/([^/]+)$/);
        if (m) {
          const g = this.apiGroupList().groups.find((x) => x.name === m[1]);
          if (!g) throw new ApiError(404, 'NotFound', 'the server could not find the requested resource');
          return ok({ kind: 'APIGroup', apiVersion: 'v1', ...g });
        }
        let group, version, rest;
        if ((m = path.match(/^\/api\/(v1)(\/.*)?$/))) { group = ''; version = m[1]; rest = m[2] || ''; }
        else if ((m = path.match(/^\/apis\/([^/]+)\/([^/]+)(\/.*)?$/))) { group = m[1]; version = m[2]; rest = m[3] || ''; }
        else throw new ApiError(404, 'NotFound', 'the server could not find the requested resource');
        if (!rest) return ok(this.resourceList(group, version));
        const parts = rest.split('/').filter(Boolean);
        let ns = null;
        if (parts[0] === 'namespaces' && parts.length >= 3) { ns = parts[1]; parts.splice(0, 2); }
        const [res, name, sub] = parts;
        const t = S.types.find((x) => x.plural === res && x.group === group && (x.version === version || (x.versions || []).includes(version)));
        if (!t) throw new ApiError(404, 'NotFound', 'the server could not find the requested resource');
        const listOpts = { labelSelector: q.labelSelector, fieldSelector: q.fieldSelector };
        const wrapList = (items) => ({ kind: t.kind + 'List', apiVersion: t.apiVersion, metadata: { resourceVersion: String(this.rv) }, items: items.map((i) => ({ ...i, apiVersion: undefined, kind: undefined, ...i })) });
        const dry = q.dryRun === 'All';
        switch (method) {
          case 'GET':
            if (!name) {
              let items = this.list(t, ns, listOpts, ctx);
              if (q.limit) items = items.slice(0, Number(q.limit));
              return ok(wrapList(items));
            }
            if (sub === 'log') return ok(this.podLogs(ns, name, { container: q.container, tail: q.tailLines ? Number(q.tailLines) : undefined, previous: q.previous === 'true', timestamps: q.timestamps === 'true' }).join('\n') + '\n');
            if (sub === 'scale') {
              const o = this.get(t, ns, name, ctx);
              return ok({ kind: 'Scale', apiVersion: 'autoscaling/v1', metadata: { name, namespace: ns, uid: o.metadata.uid, resourceVersion: o.metadata.resourceVersion, creationTimestamp: o.metadata.creationTimestamp }, spec: { replicas: o.spec.replicas }, status: { replicas: o.status.replicas || 0, selector: U.selectorString(o.spec.selector) } });
            }
            if (t.group === 'metrics.k8s.io') {
              const it = this.metricsList(t, ns).find((x) => x.metadata.name === name);
              if (!it) throw new ApiError(404, 'NotFound', `${t.kind === 'NodeMetrics' ? 'nodemetrics' : 'podmetrics'}.metrics.k8s.io "${name}" not found`);
              return ok(it);
            }
            return ok(this.get(t, ns, name, ctx));
          case 'POST': {
            const obj = typeof body === 'string' ? JSON.parse(body) : body;
            if (ns && t.namespaced) { obj.metadata ??= {}; obj.metadata.namespace ??= ns; }
            if (sub === 'eviction') return ok(this.evict(ns, name, ctx), 201);
            return ok(this.create(obj, ctx, { dryRun: dry }), 201);
          }
          case 'PUT': {
            const obj = typeof body === 'string' ? JSON.parse(body) : body;
            return ok(this.update(obj, ctx, { dryRun: dry, subresource: sub }));
          }
          case 'PATCH': {
            const obj = typeof body === 'string' ? JSON.parse(body) : body;
            const ct = headers['Content-Type'] || headers['content-type'] || 'application/strategic-merge-patch+json';
            const type = ct.includes('json-patch') ? 'json' : ct.includes('merge-patch+json') && !ct.includes('strategic') ? 'merge' : 'strategic';
            return ok(this.patch(t, ns, name, obj, type, ctx, { dryRun: dry, subresource: sub }));
          }
          case 'DELETE': {
            if (!name) {
              const items = this.list(t, ns, listOpts, ctx);
              for (const it of items) this.delete(t, it.metadata.namespace, it.metadata.name, {}, ctx);
              return ok(wrapList(items));
            }
            const o = typeof body === 'string' && body ? JSON.parse(body) : body || {};
            const r = this.delete(t, ns, name, { gracePeriodSeconds: o.gracePeriodSeconds ?? (q.gracePeriodSeconds !== undefined ? Number(q.gracePeriodSeconds) : undefined), propagationPolicy: o.propagationPolicy || q.propagationPolicy, dryRun: dry }, ctx);
            return ok(r.metadata.deletionTimestamp ? r : { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success', details: { name, group: t.group, kind: t.plural, uid: r.metadata.uid } });
          }
        }
        throw new ApiError(405, 'MethodNotAllowed', 'the server does not allow this method on the requested resource');
      } catch (e) {
        if (e instanceof ApiError) return status(e);
        if (e instanceof SyntaxError) return status(new ApiError(400, 'BadRequest', `the object provided is unrecognized (must be of type ...): ${e.message}`));
        return status(new ApiError(500, 'InternalError', e.message));
      }
    }
    apiGroupList() {
      const groups = {};
      for (const t of S.types) {
        if (!t.group) continue;
        groups[t.group] ??= new Set();
        groups[t.group].add(t.version);
        for (const v of t.versions || []) groups[t.group].add(v);
      }
      if (groups.autoscaling) groups.autoscaling.add('v1');
      return {
        kind: 'APIGroupList',
        apiVersion: 'v1',
        groups: Object.keys(groups).sort().map((g) => {
          const vs = [...groups[g]].sort().reverse();
          return { name: g, versions: vs.map((v) => ({ groupVersion: `${g}/${v}`, version: v })), preferredVersion: { groupVersion: `${g}/${vs[0]}`, version: vs[0] } };
        }),
      };
    }
    resourceList(group, version) {
      const types = S.types.filter((t) => t.group === group && (t.version === version || (t.versions || []).includes(version)));
      if (!types.length) throw new ApiError(404, 'NotFound', 'the server could not find the requested resource');
      const resources = [];
      for (const t of types) {
        resources.push({ name: t.plural, singularName: t.singular, namespaced: t.namespaced, kind: t.kind, verbs: t.verbs, ...(t.short.length ? { shortNames: t.short } : {}), ...(t.categories.length ? { categories: t.categories } : {}), storageVersionHash: U.b64e(t.id).slice(0, 11) });
        for (const sub of S.subresources[t.plural] || []) resources.push({ name: `${t.plural}/${sub}`, singularName: '', namespaced: t.namespaced, kind: sub === 'scale' ? 'Scale' : sub === 'eviction' ? 'Eviction' : t.kind, verbs: sub === 'status' || sub === 'scale' ? ['get', 'patch', 'update'] : ['create', 'get'] });
      }
      return { kind: 'APIResourceList', apiVersion: 'v1', groupVersion: group ? `${group}/${version}` : version, resources };
    }
    evict(ns, name, ctx) {
      const t = this.T('pods');
      this.authz(ctx, 'create', t, ns, name, 'eviction');
      const p = this.raw(t, ns, name);
      if (!p) throw E.notFound(t, name);
      const pdbT = this.T('poddisruptionbudgets.policy');
      for (const pdb of this.rawList(pdbT, ns)) {
        if (!U.matchSelector(pdb.spec.selector, p.metadata.labels)) continue;
        if ((pdb.status.disruptionsAllowed || 0) <= 0 && p.status.phase === 'Running') {
          const e = new ApiError(429, 'TooManyRequests', 'Cannot evict pod as it would violate the pod\'s disruption budget.');
          e.pdb = pdb.metadata.name;
          throw e;
        }
        pdb.status.disruptionsAllowed = Math.max(0, (pdb.status.disruptionsAllowed || 0) - 1);
      }
      this.delete(t, ns, name, {}, SYSTEM);
      return { kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Success', code: 201 };
    }
  }
  KS.Cluster = Cluster;

  KS.serverVersion = () => ({
    major: '1', minor: '31', gitVersion: 'v1.31.0', gitCommit: '9edcffcde5595e8a5b1a35f88c421764e575afce', gitTreeState: 'clean',
    buildDate: '2024-08-13T07:28:49Z', goVersion: 'go1.22.5', compiler: 'gc', platform: 'linux/amd64',
  });
  KS.CA_CRT = `-----BEGIN CERTIFICATE-----
MIIDBTCCAe2gAwIBAgIIQ7Ug3fHzk5owDQYJKoZIhvcNAQELBQAwFTETMBEGA1UE
AxMKa3ViZXJuZXRlczAeFw0yNjA5MjgxMTU1MDBaFw0zNjA5MjYxMjAwMDBaMBUx
EzARBgNVBAMTCmt1YmVybmV0ZXMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQDKs2m5Tq1vA8xk4cU3u7b1k0Yx0PqN2Hc7rVh5o9pWf3g6wqz3xP4mQy7T
0p0x4aHq9mS7eJvX8YwR2m3cF5nK1u7bQ9tP0dA2sLz6Vq8fXc4Jk3n1Y6wR5eH2
kX3mN8pQ7vB1sT4yU9oI0lK2jH5gF6dS3aA8zX7cV4bN1mQ9wE2rT6yU8iO0pL3k
J5hG7fD9sA1zX3cV6bN8mQ4wE7rT2yU5iO9pL6kJ8hG3fD1sA4zX7cV2bN5mQ8wE
1rT3yU6iO2pL9kJ4hG7fD5sA8zX1cV3bN6mQ2wE9rT7yU1iO4pL5kJ2hG8fD6sA3
zX9cV1bN4mQ7wE5rT8yU3iO6pL1kJ9hG2fD4sA7zAgMBAAGjWTBXMA4GA1UdDwEB
/wQEAwICpDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRk3n5o0Yx7Vh2q9pWf
3g6wqz3xPjAVBgNVHREEDjAMggprdWJlcm5ldGVzMA0GCSqGSIb3DQEBCwUAA4IB
AQBn5o0Yx7Vh2q9pWf3g6wqz3xP4mQy7T0p0x4aHq9mS7eJvX8YwR2m3cF5nK1u7
bQ9tP0dA2sLz6Vq8fXc4Jk3n1Y6wR5eH2kX3mN8pQ7vB1sT4yU9oI0lK2jH5gF6d
-----END CERTIFICATE-----
`;
})();
