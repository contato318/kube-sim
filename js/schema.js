// Registro de tipos da API (discovery) e documentação para `kubectl explain`.
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const S = (KS.schema = {});

  const RW = ['create', 'delete', 'deletecollection', 'get', 'list', 'patch', 'update', 'watch'];
  const RO = ['get', 'list'];
  const CR = ['create'];
  // [plural, singular, shortNames, group, version, namespaced, kind, verbs, categories]
  const BUILTIN = [
    ['bindings', 'binding', [], '', 'v1', true, 'Binding', CR],
    ['componentstatuses', 'componentstatus', ['cs'], '', 'v1', false, 'ComponentStatus', RO],
    ['configmaps', 'configmap', ['cm'], '', 'v1', true, 'ConfigMap', RW],
    ['endpoints', 'endpoints', ['ep'], '', 'v1', true, 'Endpoints', RW],
    ['events', 'event', ['ev'], '', 'v1', true, 'Event', RW],
    ['limitranges', 'limitrange', ['limits'], '', 'v1', true, 'LimitRange', RW],
    ['namespaces', 'namespace', ['ns'], '', 'v1', false, 'Namespace', ['create', 'delete', 'get', 'list', 'patch', 'update', 'watch']],
    ['nodes', 'node', ['no'], '', 'v1', false, 'Node', RW],
    ['persistentvolumeclaims', 'persistentvolumeclaim', ['pvc'], '', 'v1', true, 'PersistentVolumeClaim', RW],
    ['persistentvolumes', 'persistentvolume', ['pv'], '', 'v1', false, 'PersistentVolume', RW],
    ['pods', 'pod', ['po'], '', 'v1', true, 'Pod', RW, ['all']],
    ['podtemplates', 'podtemplate', [], '', 'v1', true, 'PodTemplate', RW],
    ['replicationcontrollers', 'replicationcontroller', ['rc'], '', 'v1', true, 'ReplicationController', RW, ['all']],
    ['resourcequotas', 'resourcequota', ['quota'], '', 'v1', true, 'ResourceQuota', RW],
    ['secrets', 'secret', [], '', 'v1', true, 'Secret', RW],
    ['serviceaccounts', 'serviceaccount', ['sa'], '', 'v1', true, 'ServiceAccount', RW],
    ['services', 'service', ['svc'], '', 'v1', true, 'Service', RW, ['all']],
    ['mutatingwebhookconfigurations', 'mutatingwebhookconfiguration', [], 'admissionregistration.k8s.io', 'v1', false, 'MutatingWebhookConfiguration', RW, ['api-extensions']],
    ['validatingadmissionpolicies', 'validatingadmissionpolicy', [], 'admissionregistration.k8s.io', 'v1', false, 'ValidatingAdmissionPolicy', RW, ['api-extensions']],
    ['validatingadmissionpolicybindings', 'validatingadmissionpolicybinding', [], 'admissionregistration.k8s.io', 'v1', false, 'ValidatingAdmissionPolicyBinding', RW, ['api-extensions']],
    ['validatingwebhookconfigurations', 'validatingwebhookconfiguration', [], 'admissionregistration.k8s.io', 'v1', false, 'ValidatingWebhookConfiguration', RW, ['api-extensions']],
    ['customresourcedefinitions', 'customresourcedefinition', ['crd', 'crds'], 'apiextensions.k8s.io', 'v1', false, 'CustomResourceDefinition', RW, ['api-extensions']],
    ['apiservices', 'apiservice', [], 'apiregistration.k8s.io', 'v1', false, 'APIService', RW, ['api-extensions']],
    ['controllerrevisions', 'controllerrevision', [], 'apps', 'v1', true, 'ControllerRevision', RW],
    ['daemonsets', 'daemonset', ['ds'], 'apps', 'v1', true, 'DaemonSet', RW, ['all']],
    ['deployments', 'deployment', ['deploy'], 'apps', 'v1', true, 'Deployment', RW, ['all']],
    ['replicasets', 'replicaset', ['rs'], 'apps', 'v1', true, 'ReplicaSet', RW, ['all']],
    ['statefulsets', 'statefulset', ['sts'], 'apps', 'v1', true, 'StatefulSet', RW, ['all']],
    ['selfsubjectreviews', 'selfsubjectreview', [], 'authentication.k8s.io', 'v1', false, 'SelfSubjectReview', CR],
    ['tokenreviews', 'tokenreview', [], 'authentication.k8s.io', 'v1', false, 'TokenReview', CR],
    ['localsubjectaccessreviews', 'localsubjectaccessreview', [], 'authorization.k8s.io', 'v1', true, 'LocalSubjectAccessReview', CR],
    ['selfsubjectaccessreviews', 'selfsubjectaccessreview', [], 'authorization.k8s.io', 'v1', false, 'SelfSubjectAccessReview', CR],
    ['selfsubjectrulesreviews', 'selfsubjectrulesreview', [], 'authorization.k8s.io', 'v1', false, 'SelfSubjectRulesReview', CR],
    ['subjectaccessreviews', 'subjectaccessreview', [], 'authorization.k8s.io', 'v1', false, 'SubjectAccessReview', CR],
    ['horizontalpodautoscalers', 'horizontalpodautoscaler', ['hpa'], 'autoscaling', 'v2', true, 'HorizontalPodAutoscaler', RW, ['all']],
    ['cronjobs', 'cronjob', ['cj'], 'batch', 'v1', true, 'CronJob', RW, ['all']],
    ['jobs', 'job', [], 'batch', 'v1', true, 'Job', RW, ['all']],
    ['certificatesigningrequests', 'certificatesigningrequest', ['csr'], 'certificates.k8s.io', 'v1', false, 'CertificateSigningRequest', RW],
    ['leases', 'lease', [], 'coordination.k8s.io', 'v1', true, 'Lease', RW],
    ['endpointslices', 'endpointslice', [], 'discovery.k8s.io', 'v1', true, 'EndpointSlice', RW],
    ['events', 'event', ['ev'], 'events.k8s.io', 'v1', true, 'Event', RW],
    ['flowschemas', 'flowschema', [], 'flowcontrol.apiserver.k8s.io', 'v1', false, 'FlowSchema', RW],
    ['prioritylevelconfigurations', 'prioritylevelconfiguration', [], 'flowcontrol.apiserver.k8s.io', 'v1', false, 'PriorityLevelConfiguration', RW],
    ['nodes', 'nodemetrics', [], 'metrics.k8s.io', 'v1beta1', false, 'NodeMetrics', RO],
    ['pods', 'podmetrics', [], 'metrics.k8s.io', 'v1beta1', true, 'PodMetrics', RO],
    ['ingressclasses', 'ingressclass', [], 'networking.k8s.io', 'v1', false, 'IngressClass', RW],
    ['ingresses', 'ingress', ['ing'], 'networking.k8s.io', 'v1', true, 'Ingress', RW],
    ['networkpolicies', 'networkpolicy', ['netpol'], 'networking.k8s.io', 'v1', true, 'NetworkPolicy', RW],
    ['runtimeclasses', 'runtimeclass', [], 'node.k8s.io', 'v1', false, 'RuntimeClass', RW],
    ['poddisruptionbudgets', 'poddisruptionbudget', ['pdb'], 'policy', 'v1', true, 'PodDisruptionBudget', RW],
    ['clusterrolebindings', 'clusterrolebinding', [], 'rbac.authorization.k8s.io', 'v1', false, 'ClusterRoleBinding', RW],
    ['clusterroles', 'clusterrole', [], 'rbac.authorization.k8s.io', 'v1', false, 'ClusterRole', RW],
    ['rolebindings', 'rolebinding', [], 'rbac.authorization.k8s.io', 'v1', true, 'RoleBinding', RW],
    ['roles', 'role', [], 'rbac.authorization.k8s.io', 'v1', true, 'Role', RW],
    ['priorityclasses', 'priorityclass', ['pc'], 'scheduling.k8s.io', 'v1', false, 'PriorityClass', RW],
    ['csidrivers', 'csidriver', [], 'storage.k8s.io', 'v1', false, 'CSIDriver', RW],
    ['csinodes', 'csinode', [], 'storage.k8s.io', 'v1', false, 'CSINode', RW],
    ['csistoragecapacities', 'csistoragecapacity', [], 'storage.k8s.io', 'v1', true, 'CSIStorageCapacity', RW],
    ['storageclasses', 'storageclass', ['sc'], 'storage.k8s.io', 'v1', false, 'StorageClass', RW],
    ['volumeattachments', 'volumeattachment', [], 'storage.k8s.io', 'v1', false, 'VolumeAttachment', RW],
  ];

  S.types = [];
  S.add = (d) => {
    const t = {
      plural: d[0], singular: d[1], short: d[2] || [], group: d[3], version: d[4], namespaced: d[5], kind: d[6],
      verbs: d[7] || RW, categories: d[8] || [], crd: !!d[9],
    };
    t.apiVersion = t.group ? `${t.group}/${t.version}` : t.version;
    t.id = t.group ? `${t.plural}.${t.group}` : t.plural;
    t.qualified = t.id; // usado nas mensagens de erro: deployments.apps "x" not found
    t.kindRef = t.group ? `${t.kind.toLowerCase()}.${t.group}` : t.kind.toLowerCase(); // pod/x, deployment.apps/x
    S.types = S.types.filter((x) => x.id !== t.id);
    S.types.push(t);
    return t;
  };
  S.remove = (id) => (S.types = S.types.filter((x) => x.id !== id));
  BUILTIN.forEach(S.add);

  S.byId = (id) => S.types.find((t) => t.id === id);
  S.byKind = (apiVersion, kind) => {
    const group = apiVersion && apiVersion.includes('/') ? apiVersion.split('/')[0] : '';
    return S.types.find((t) => t.kind === kind && t.group === group) || null;
  };
  S.byKindAny = (kind) =>
    S.types.find((t) => t.kind === kind && t.group !== 'metrics.k8s.io' && t.group !== 'events.k8s.io') || S.types.find((t) => t.kind === kind);

  // resolve "po", "pods", "Pod", "deployments.apps", "deploy.v1.apps", "hpa"
  S.resolve = (str) => {
    if (!str) return null;
    const s = str.toLowerCase();
    const pool = S.types.filter((t) => t.group !== 'metrics.k8s.io');
    const pref = (list) => list.find((t) => t.group === '') || list.find((t) => t.group !== 'events.k8s.io') || list[0];
    let m = pool.filter((t) => t.plural === s || t.singular === s || t.short.includes(s) || t.kind.toLowerCase() === s);
    if (m.length) return pref(m);
    const parts = s.split('.');
    for (let i = 1; i < parts.length; i++) {
      const res = parts.slice(0, i).join('.');
      let rest = parts.slice(i).join('.');
      let ver = null;
      if (/^v\d+((alpha|beta)\d+)?$/.test(parts[i])) {
        ver = parts[i];
        rest = parts.slice(i + 1).join('.');
      }
      m = S.types.filter(
        (t) =>
          (t.plural === res || t.singular === res || t.short.includes(res) || t.kind.toLowerCase() === res) &&
          t.group === rest &&
          (!ver || t.version === ver)
      );
      if (m.length) return m[0];
    }
    return null;
  };
  S.expandCategory = (cat) => S.types.filter((t) => t.categories.includes(cat));
  S.apiVersions = () => {
    const out = new Set();
    for (const t of S.types) out.add(t.apiVersion);
    for (const extra of ['autoscaling/v1', 'flowcontrol.apiserver.k8s.io/v1beta3']) out.add(extra);
    return [...out].sort();
  };
  S.subresources = {
    pods: ['attach', 'binding', 'ephemeralcontainers', 'eviction', 'exec', 'log', 'portforward', 'proxy', 'resize', 'status'],
    deployments: ['scale', 'status'], replicasets: ['scale', 'status'], statefulsets: ['scale', 'status'],
    replicationcontrollers: ['scale', 'status'], daemonsets: ['status'], jobs: ['status'], cronjobs: ['status'],
    nodes: ['proxy', 'status'], services: ['proxy', 'status'], namespaces: ['finalize', 'status'], serviceaccounts: ['token'],
    persistentvolumeclaims: ['status'], persistentvolumes: ['status'], horizontalpodautoscalers: ['status'],
    certificatesigningrequests: ['approval', 'status'], customresourcedefinitions: ['status'], ingresses: ['status'],
    poddisruptionbudgets: ['status'], resourcequotas: ['status'], apiservices: ['status'],
  };

  // ------------------------------------------------------------------
  // Documentação para `kubectl explain` (subconjunto da OpenAPI oficial).
  // tipo -> { desc, fields: { nome: [tipo, descrição, required?] } }
  // ------------------------------------------------------------------
  const D = (S.docs = {});
  const meta = ['ObjectMeta', "Standard object's metadata. More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#metadata"];
  const apiV = ['string', 'APIVersion defines the versioned schema of this representation of an object. Servers should convert recognized schemas to the latest internal value, and may reject unrecognized values. More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources'];
  const kindF = ['string', 'Kind is a string value representing the REST resource this object represents. Servers may infer this from the endpoint the client submits requests to. Cannot be updated. In CamelCase. More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds'];
  const top = (desc, spec, status, specDesc, statusDesc) => ({
    desc,
    fields: {
      apiVersion: apiV,
      kind: kindF,
      metadata: meta,
      ...(spec ? { spec: [spec, specDesc || 'Specification of the desired behavior. More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#spec-and-status'] } : {}),
      ...(status ? { status: [status, statusDesc || 'Most recently observed status. This data may not be up to date. Populated by the system. Read-only. More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#spec-and-status'] } : {}),
    },
  });

  D.ObjectMeta = {
    desc: 'ObjectMeta is metadata that all persisted resources must have, which includes all objects users must create.',
    fields: {
      annotations: ['map[string]string', 'Annotations is an unstructured key value map stored with a resource that may be set by external tools to store and retrieve arbitrary metadata. They are not queryable and should be preserved when modifying objects.'],
      creationTimestamp: ['string', 'CreationTimestamp is a timestamp representing the server time when this object was created. Populated by the system. Read-only.'],
      deletionGracePeriodSeconds: ['integer', 'Number of seconds allowed for this object to gracefully terminate before it will be removed from the system. Only set when deletionTimestamp is also set.'],
      deletionTimestamp: ['string', 'DeletionTimestamp is RFC 3339 date and time at which this resource will be deleted. This field is set by the server when a graceful deletion is requested by the user.'],
      finalizers: ['[]string', 'Must be empty before the object is deleted from the registry. Each entry is an identifier for the responsible component that will remove the entry from the list.'],
      generateName: ['string', 'GenerateName is an optional prefix, used by the server, to generate a unique name ONLY IF the Name field has not been provided.'],
      generation: ['integer', 'A sequence number representing a specific generation of the desired state. Populated by the system. Read-only.'],
      labels: ['map[string]string', 'Map of string keys and values that can be used to organize and categorize (scope and select) objects.'],
      managedFields: ['[]ManagedFieldsEntry', 'ManagedFields maps workflow-id and version to the set of fields that are managed by that workflow.'],
      name: ['string', 'Name must be unique within a namespace. Is required when creating resources, although some resources may allow a client to request the generation of an appropriate name automatically.'],
      namespace: ['string', 'Namespace defines the space within which each name must be unique. An empty namespace is equivalent to the "default" namespace.'],
      ownerReferences: ['[]OwnerReference', 'List of objects depended by this object. If ALL objects in the list have been deleted, this object will be garbage collected.'],
      resourceVersion: ['string', 'An opaque value that represents the internal version of this object that can be used by clients to determine when objects have changed.'],
      selfLink: ['string', 'Deprecated: selfLink is a legacy read-only field that is no longer populated by the system.'],
      uid: ['string', 'UID is the unique in time and space value for this object. It is typically generated by the server on successful creation of a resource.'],
    },
  };
  D.OwnerReference = {
    desc: 'OwnerReference contains enough information to let you identify an owning object.',
    fields: {
      apiVersion: ['string', 'API version of the referent.', true],
      blockOwnerDeletion: ['boolean', 'If true, AND if the owner has the "foregroundDeletion" finalizer, then the owner cannot be deleted from the key-value store until this reference is removed.'],
      controller: ['boolean', 'If true, this reference points to the managing controller.'],
      kind: ['string', 'Kind of the referent.', true],
      name: ['string', 'Name of the referent.', true],
      uid: ['string', 'UID of the referent.', true],
    },
  };
  D.LabelSelector = {
    desc: 'A label selector is a label query over a set of resources. The result of matchLabels and matchExpressions are ANDed. An empty label selector matches all objects. A null label selector matches no objects.',
    fields: {
      matchExpressions: ['[]LabelSelectorRequirement', 'matchExpressions is a list of label selector requirements. The requirements are ANDed.'],
      matchLabels: ['map[string]string', 'matchLabels is a map of {key,value} pairs.'],
    },
  };
  D.LabelSelectorRequirement = {
    desc: 'A label selector requirement is a selector that contains values, a key, and an operator that relates the key and values.',
    fields: {
      key: ['string', 'key is the label key that the selector applies to.', true],
      operator: ['string', "operator represents a key's relationship to a set of values. Valid operators are In, NotIn, Exists and DoesNotExist.", true],
      values: ['[]string', 'values is an array of string values.'],
    },
  };
  D.Pod = top('Pod is a collection of containers that can run on a host. This resource is created by clients and scheduled onto hosts.', 'PodSpec', 'PodStatus');
  D.PodSpec = {
    desc: 'PodSpec is a description of a pod.',
    fields: {
      activeDeadlineSeconds: ['integer', 'Optional duration in seconds the pod may be active on the node relative to StartTime before the system will actively try to mark it failed and kill associated containers.'],
      affinity: ['Affinity', "If specified, the pod's scheduling constraints"],
      automountServiceAccountToken: ['boolean', 'AutomountServiceAccountToken indicates whether a service account token should be automatically mounted.'],
      containers: ['[]Container', 'List of containers belonging to the pod. Containers cannot currently be added or removed. There must be at least one container in a Pod. Cannot be updated.', true],
      dnsConfig: ['PodDNSConfig', 'Specifies the DNS parameters of a pod.'],
      dnsPolicy: ['string', "Set DNS policy for the pod. Defaults to \"ClusterFirst\". Valid values are 'ClusterFirstWithHostNet', 'ClusterFirst', 'Default' or 'None'."],
      enableServiceLinks: ['boolean', "EnableServiceLinks indicates whether information about services should be injected into pod's environment variables. Optional: Defaults to true."],
      ephemeralContainers: ['[]EphemeralContainer', 'List of ephemeral containers run in this pod. Ephemeral containers may be run in an existing pod to perform user-initiated actions such as debugging.'],
      hostAliases: ['[]HostAlias', "HostAliases is an optional list of hosts and IPs that will be injected into the pod's hosts file if specified."],
      hostIPC: ['boolean', "Use the host's ipc namespace. Optional: Default to false."],
      hostNetwork: ['boolean', "Host networking requested for this pod. Use the host's network namespace. Default to false."],
      hostPID: ['boolean', "Use the host's pid namespace. Optional: Default to false."],
      hostname: ['string', "Specifies the hostname of the Pod If not specified, the pod's hostname will be set to a system-defined value."],
      imagePullSecrets: ['[]LocalObjectReference', 'ImagePullSecrets is an optional list of references to secrets in the same namespace to use for pulling any of the images used by this PodSpec.'],
      initContainers: ['[]Container', 'List of initialization containers belonging to the pod. Init containers are executed in order prior to containers being started.'],
      nodeName: ['string', 'NodeName indicates in which node this pod is scheduled. If empty, this pod is a candidate for scheduling by the scheduler defined in schedulerName.'],
      nodeSelector: ['map[string]string', "NodeSelector is a selector which must be true for the pod to fit on a node. Selector which must match a node's labels for the pod to be scheduled on that node."],
      preemptionPolicy: ['string', 'PreemptionPolicy is the Policy for preempting pods with lower priority. One of Never, PreemptLowerPriority. Defaults to PreemptLowerPriority if unset.'],
      priority: ['integer', 'The priority value. Various system components use this field to find the priority of the pod.'],
      priorityClassName: ['string', 'If specified, indicates the pod\'s priority. "system-node-critical" and "system-cluster-critical" are two special keywords which indicate the highest priorities.'],
      readinessGates: ['[]PodReadinessGate', 'If specified, all readiness gates will be evaluated for pod readiness.'],
      restartPolicy: ['string', 'Restart policy for all containers within the pod. One of Always, OnFailure, Never. Default to Always.\n\nPossible enum values:\n - `"Always"`\n - `"Never"`\n - `"OnFailure"`'],
      runtimeClassName: ['string', 'RuntimeClassName refers to a RuntimeClass object in the node.k8s.io group, which should be used to run this pod.'],
      schedulerName: ['string', 'If specified, the pod will be dispatched by specified scheduler. If not specified, the pod will be dispatched by default scheduler.'],
      securityContext: ['PodSecurityContext', 'SecurityContext holds pod-level security attributes and common container settings. Optional: Defaults to empty.'],
      serviceAccount: ['string', 'DeprecatedServiceAccount is a deprecated alias for ServiceAccountName. Deprecated: Use serviceAccountName instead.'],
      serviceAccountName: ['string', 'ServiceAccountName is the name of the ServiceAccount to use to run this pod.'],
      shareProcessNamespace: ['boolean', 'Share a single process namespace between all of the containers in a pod.'],
      subdomain: ['string', 'If specified, the fully qualified Pod hostname will be "<hostname>.<subdomain>.<pod namespace>.svc.<cluster domain>".'],
      terminationGracePeriodSeconds: ['integer', 'Optional duration in seconds the pod needs to terminate gracefully. May be decreased in delete request. Defaults to 30 seconds.'],
      tolerations: ['[]Toleration', "If specified, the pod's tolerations."],
      topologySpreadConstraints: ['[]TopologySpreadConstraint', 'TopologySpreadConstraints describes how a group of pods ought to spread across topology domains.'],
      volumes: ['[]Volume', 'List of volumes that can be mounted by containers belonging to the pod.'],
    },
  };
  D.Container = {
    desc: 'A single application container that you want to run within a pod.',
    fields: {
      args: ['[]string', "Arguments to the entrypoint. The container image's CMD is used if this is not provided."],
      command: ['[]string', "Entrypoint array. Not executed within a shell. The container image's ENTRYPOINT is used if this is not provided."],
      env: ['[]EnvVar', 'List of environment variables to set in the container. Cannot be updated.'],
      envFrom: ['[]EnvFromSource', 'List of sources to populate environment variables in the container.'],
      image: ['string', 'Container image name. More info: https://kubernetes.io/docs/concepts/containers/images'],
      imagePullPolicy: ['string', 'Image pull policy. One of Always, Never, IfNotPresent. Defaults to Always if :latest tag is specified, or IfNotPresent otherwise. Cannot be updated.'],
      lifecycle: ['Lifecycle', 'Actions that the management system should take in response to container lifecycle events. Cannot be updated.'],
      livenessProbe: ['Probe', 'Periodic probe of container liveness. Container will be restarted if the probe fails. Cannot be updated.'],
      name: ['string', 'Name of the container specified as a DNS_LABEL. Each container in a pod must have a unique name (DNS_LABEL). Cannot be updated.', true],
      ports: ['[]ContainerPort', 'List of ports to expose from the container. Not specifying a port here DOES NOT prevent that port from being exposed.'],
      readinessProbe: ['Probe', 'Periodic probe of container service readiness. Container will be removed from service endpoints if the probe fails. Cannot be updated.'],
      resources: ['ResourceRequirements', 'Compute Resources required by this container. Cannot be updated.'],
      securityContext: ['SecurityContext', 'SecurityContext defines the security options the container should be run with.'],
      startupProbe: ['Probe', 'StartupProbe indicates that the Pod has successfully initialized. If specified, no other probes are executed until this completes successfully.'],
      stdin: ['boolean', 'Whether this container should allocate a buffer for stdin in the container runtime.'],
      stdinOnce: ['boolean', 'Whether the container runtime should close the stdin channel after it has been opened by a single attach.'],
      terminationMessagePath: ['string', "Optional: Path at which the file to which the container's termination message will be written is mounted into the container's filesystem. Defaults to /dev/termination-log."],
      terminationMessagePolicy: ['string', 'Indicate how the termination message should be populated. File will use the contents of terminationMessagePath. Defaults to File.'],
      tty: ['boolean', "Whether this container should allocate a TTY for itself, also requires 'stdin' to be true. Default is false."],
      volumeMounts: ['[]VolumeMount', "Pod volumes to mount into the container's filesystem. Cannot be updated."],
      workingDir: ['string', "Container's working directory. If not specified, the container runtime's default will be used."],
    },
  };
  D.EnvVar = {
    desc: 'EnvVar represents an environment variable present in a Container.',
    fields: {
      name: ['string', 'Name of the environment variable. Must be a C_IDENTIFIER.', true],
      value: ['string', 'Variable references $(VAR_NAME) are expanded using the previously defined environment variables in the container and any service environment variables.'],
      valueFrom: ['EnvVarSource', "Source for the environment variable's value. Cannot be used if value is not empty."],
    },
  };
  D.EnvVarSource = {
    desc: 'EnvVarSource represents a source for the value of an EnvVar.',
    fields: {
      configMapKeyRef: ['ConfigMapKeySelector', 'Selects a key of a ConfigMap.'],
      fieldRef: ['ObjectFieldSelector', "Selects a field of the pod: supports metadata.name, metadata.namespace, `metadata.labels['<KEY>']`, spec.nodeName, spec.serviceAccountName, status.hostIP, status.podIP, status.podIPs."],
      resourceFieldRef: ['ResourceFieldSelector', 'Selects a resource of the container: only resources limits and requests are currently supported.'],
      secretKeyRef: ['SecretKeySelector', "Selects a key of a secret in the pod's namespace"],
    },
  };
  D.ContainerPort = {
    desc: 'ContainerPort represents a network port in a single container.',
    fields: {
      containerPort: ['integer', "Number of port to expose on the pod's IP address. This must be a valid port number, 0 < x < 65536.", true],
      hostIP: ['string', 'What host IP to bind the external port to.'],
      hostPort: ['integer', 'Number of port to expose on the host. If specified, this must be a valid port number, 0 < x < 65536.'],
      name: ['string', 'If specified, this must be an IANA_SVC_NAME and unique within the pod. Each named port in a pod must have a unique name.'],
      protocol: ['string', 'Protocol for port. Must be UDP, TCP, or SCTP. Defaults to "TCP".'],
    },
  };
  D.ResourceRequirements = {
    desc: 'ResourceRequirements describes the compute resource requirements.',
    fields: {
      claims: ['[]ResourceClaim', 'Claims lists the names of resources, defined in spec.resourceClaims, that are used by this container.'],
      limits: ['map[string]Quantity', 'Limits describes the maximum amount of compute resources allowed.'],
      requests: ['map[string]Quantity', 'Requests describes the minimum amount of compute resources required. If Requests is omitted for a container, it defaults to Limits if that is explicitly specified.'],
    },
  };
  D.Probe = {
    desc: 'Probe describes a health check to be performed against a container to determine whether it is alive or ready to receive traffic.',
    fields: {
      exec: ['ExecAction', 'Exec specifies the action to take.'],
      failureThreshold: ['integer', 'Minimum consecutive failures for the probe to be considered failed after having succeeded. Defaults to 3. Minimum value is 1.'],
      grpc: ['GRPCAction', 'GRPC specifies an action involving a GRPC port.'],
      httpGet: ['HTTPGetAction', 'HTTPGet specifies the http request to perform.'],
      initialDelaySeconds: ['integer', 'Number of seconds after the container has started before liveness probes are initiated.'],
      periodSeconds: ['integer', 'How often (in seconds) to perform the probe. Default to 10 seconds. Minimum value is 1.'],
      successThreshold: ['integer', 'Minimum consecutive successes for the probe to be considered successful after having failed. Defaults to 1.'],
      tcpSocket: ['TCPSocketAction', 'TCPSocket specifies an action involving a TCP port.'],
      terminationGracePeriodSeconds: ['integer', 'Optional duration in seconds the pod needs to terminate gracefully upon probe failure.'],
      timeoutSeconds: ['integer', 'Number of seconds after which the probe times out. Defaults to 1 second. Minimum value is 1.'],
    },
  };
  D.VolumeMount = {
    desc: 'VolumeMount describes a mounting of a Volume within a container.',
    fields: {
      mountPath: ['string', "Path within the container at which the volume should be mounted.  Must not contain ':'.", true],
      mountPropagation: ['string', 'mountPropagation determines how mounts are propagated from the host to container and the other way around.'],
      name: ['string', 'This must match the Name of a Volume.', true],
      readOnly: ['boolean', 'Mounted read-only if true, read-write otherwise (false or unspecified). Defaults to false.'],
      subPath: ['string', "Path within the volume from which the container's volume should be mounted. Defaults to \"\" (volume's root)."],
    },
  };
  D.Volume = {
    desc: 'Volume represents a named volume in a pod that may be accessed by any container in the pod.',
    fields: {
      configMap: ['ConfigMapVolumeSource', 'configMap represents a configMap that should populate this volume'],
      downwardAPI: ['DownwardAPIVolumeSource', 'downwardAPI represents downward API about the pod that should populate this volume'],
      emptyDir: ['EmptyDirVolumeSource', "emptyDir represents a temporary directory that shares a pod's lifetime."],
      hostPath: ['HostPathVolumeSource', 'hostPath represents a pre-existing file or directory on the host machine that is directly exposed to the container.'],
      name: ['string', 'name of the volume. Must be a DNS_LABEL and unique within the pod.', true],
      nfs: ['NFSVolumeSource', "nfs represents an NFS mount on the host that shares a pod's lifetime"],
      persistentVolumeClaim: ['PersistentVolumeClaimVolumeSource', 'persistentVolumeClaimVolumeSource represents a reference to a PersistentVolumeClaim in the same namespace.'],
      projected: ['ProjectedVolumeSource', 'projected items for all in one resources secrets, configmaps, and downward API'],
      secret: ['SecretVolumeSource', 'secret represents a secret that should populate this volume.'],
    },
  };
  D.Toleration = {
    desc: 'The pod this Toleration is attached to tolerates any taint that matches the triple <key,value,effect> using the matching operator <operator>.',
    fields: {
      effect: ['string', 'Effect indicates the taint effect to match. Empty means match all taint effects. When specified, allowed values are NoSchedule, PreferNoSchedule and NoExecute.'],
      key: ['string', 'Key is the taint key that the toleration applies to. Empty means match all taint keys.'],
      operator: ['string', "Operator represents a key's relationship to the value. Valid operators are Exists and Equal. Defaults to Equal."],
      tolerationSeconds: ['integer', 'TolerationSeconds represents the period of time the toleration (which must be of effect NoExecute, otherwise this field is ignored) tolerates the taint.'],
      value: ['string', 'Value is the taint value the toleration matches to.'],
    },
  };
  D.PodStatus = {
    desc: 'PodStatus represents information about the status of a pod. Status may trail the actual state of a system.',
    fields: {
      conditions: ['[]PodCondition', 'Current service state of pod.'],
      containerStatuses: ['[]ContainerStatus', 'The list has one entry per container in the manifest.'],
      hostIP: ['string', 'hostIP holds the IP address of the host to which the pod is assigned.'],
      initContainerStatuses: ['[]ContainerStatus', 'The list has one entry per init container in the manifest.'],
      message: ['string', 'A human readable message indicating details about why the pod is in this condition.'],
      phase: ['string', 'The phase of a Pod is a simple, high-level summary of where the Pod is in its lifecycle.\n\nPossible enum values:\n - `"Failed"`\n - `"Pending"`\n - `"Running"`\n - `"Succeeded"`\n - `"Unknown"`'],
      podIP: ['string', 'podIP address allocated to the pod. Routable at least within the cluster.'],
      podIPs: ['[]PodIP', 'podIPs holds the IP addresses allocated to the pod.'],
      qosClass: ['string', 'The Quality of Service (QOS) classification assigned to the pod based on resource requirements.'],
      reason: ['string', "A brief CamelCase message indicating details about why the pod is in this state. e.g. 'Evicted'"],
      startTime: ['string', 'RFC 3339 date and time at which the object was acknowledged by the Kubelet.'],
    },
  };
  D.PodTemplateSpec = { desc: 'PodTemplateSpec describes the data a pod should have when created from a template', fields: { metadata: meta, spec: ['PodSpec', 'Specification of the desired behavior of the pod.'] } };
  D.Deployment = top('Deployment enables declarative updates for Pods and ReplicaSets.', 'DeploymentSpec', 'DeploymentStatus', 'Specification of the desired behavior of the Deployment.', 'Most recently observed status of the Deployment.');
  D.DeploymentSpec = {
    desc: 'DeploymentSpec is the specification of the desired behavior of the Deployment.',
    fields: {
      minReadySeconds: ['integer', 'Minimum number of seconds for which a newly created pod should be ready without any of its container crashing, for it to be considered available. Defaults to 0.'],
      paused: ['boolean', 'Indicates that the deployment is paused.'],
      progressDeadlineSeconds: ['integer', 'The maximum time in seconds for a deployment to make progress before it is considered to be failed. Defaults to 600s.'],
      replicas: ['integer', 'Number of desired pods. This is a pointer to distinguish between explicit zero and not specified. Defaults to 1.'],
      revisionHistoryLimit: ['integer', 'The number of old ReplicaSets to retain to allow rollback. Defaults to 10.'],
      selector: ['LabelSelector', "Label selector for pods. Existing ReplicaSets whose pods are selected by this will be the ones affected by this deployment. It must match the pod template's labels.", true],
      strategy: ['DeploymentStrategy', 'The deployment strategy to use to replace existing pods with new ones.'],
      template: ['PodTemplateSpec', 'Template describes the pods that will be created. The only allowed template.spec.restartPolicy value is "Always".', true],
    },
  };
  D.DeploymentStrategy = {
    desc: 'DeploymentStrategy describes how to replace existing pods with new ones.',
    fields: {
      rollingUpdate: ['RollingUpdateDeployment', 'Rolling update config params. Present only if DeploymentStrategyType = RollingUpdate.'],
      type: ['string', 'Type of deployment. Can be "Recreate" or "RollingUpdate". Default is RollingUpdate.\n\nPossible enum values:\n - `"Recreate"` Kill all existing pods before creating new ones.\n - `"RollingUpdate"` Replace the old ReplicaSets by new one using rolling update i.e gradually scale down the old ReplicaSets and scale up the new one.'],
    },
  };
  D.RollingUpdateDeployment = {
    desc: 'Spec to control the desired behavior of rolling update.',
    fields: {
      maxSurge: ['IntOrString', 'The maximum number of pods that can be scheduled above the desired number of pods. Value can be an absolute number (ex: 5) or a percentage of desired pods (ex: 10%). Defaults to 25%.'],
      maxUnavailable: ['IntOrString', 'The maximum number of pods that can be unavailable during the update. Value can be an absolute number (ex: 5) or a percentage of desired pods (ex: 10%). Defaults to 25%.'],
    },
  };
  D.DeploymentStatus = {
    desc: 'DeploymentStatus is the most recently observed status of the Deployment.',
    fields: {
      availableReplicas: ['integer', 'Total number of available pods (ready for at least minReadySeconds) targeted by this deployment.'],
      collisionCount: ['integer', 'Count of hash collisions for the Deployment.'],
      conditions: ['[]DeploymentCondition', "Represents the latest available observations of a deployment's current state."],
      observedGeneration: ['integer', 'The generation observed by the deployment controller.'],
      readyReplicas: ['integer', 'readyReplicas is the number of pods targeted by this Deployment with a Ready Condition.'],
      replicas: ['integer', 'Total number of non-terminated pods targeted by this deployment (their labels match the selector).'],
      unavailableReplicas: ['integer', 'Total number of unavailable pods targeted by this deployment.'],
      updatedReplicas: ['integer', 'Total number of non-terminated pods targeted by this deployment that have the desired template spec.'],
    },
  };
  D.ReplicaSet = top('ReplicaSet ensures that a specified number of pod replicas are running at any given time.', 'ReplicaSetSpec', 'ReplicaSetStatus');
  D.ReplicaSetSpec = {
    desc: 'ReplicaSetSpec is the specification of a ReplicaSet.',
    fields: {
      minReadySeconds: ['integer', 'Minimum number of seconds for which a newly created pod should be ready without any of its container crashing, for it to be considered available.'],
      replicas: ['integer', 'Replicas is the number of desired pods. Defaults to 1.'],
      selector: ['LabelSelector', 'Selector is a label query over pods that should match the replica count.', true],
      template: ['PodTemplateSpec', 'Template is the object that describes the pod that will be created if insufficient replicas are detected.'],
    },
  };
  D.StatefulSet = top('StatefulSet represents a set of pods with consistent identities. Identities are defined as:\n  - Network: A single stable DNS and hostname.\n  - Storage: As many VolumeClaims as requested.\n\nThe StatefulSet guarantees that a given network identity will always map to the same storage identity.', 'StatefulSetSpec', 'StatefulSetStatus');
  D.StatefulSetSpec = {
    desc: 'A StatefulSetSpec is the specification of a StatefulSet.',
    fields: {
      minReadySeconds: ['integer', 'Minimum number of seconds for which a newly created pod should be ready without any of its container crashing for it to be considered available.'],
      ordinals: ['StatefulSetOrdinals', 'ordinals controls the numbering of replica indices in a StatefulSet.'],
      persistentVolumeClaimRetentionPolicy: ['StatefulSetPersistentVolumeClaimRetentionPolicy', 'persistentVolumeClaimRetentionPolicy describes the lifecycle of persistent volume claims created from volumeClaimTemplates.'],
      podManagementPolicy: ['string', 'podManagementPolicy controls how pods are created during initial scale up, when replacing pods on nodes, or when scaling down. The default policy is `OrderedReady`.'],
      replicas: ['integer', 'replicas is the desired number of replicas of the given Template. Defaults to 1.'],
      revisionHistoryLimit: ['integer', "revisionHistoryLimit is the maximum number of revisions that will be maintained in the StatefulSet's revision history."],
      selector: ['LabelSelector', "selector is a label query over pods that should match the replica count. It must match the pod template's labels.", true],
      serviceName: ['string', 'serviceName is the name of the service that governs this StatefulSet.'],
      template: ['PodTemplateSpec', 'template is the object that describes the pod that will be created if insufficient replicas are detected.', true],
      updateStrategy: ['StatefulSetUpdateStrategy', 'updateStrategy indicates the StatefulSetUpdateStrategy that will be employed to update Pods in the StatefulSet when a revision is made to Template.'],
      volumeClaimTemplates: ['[]PersistentVolumeClaim', 'volumeClaimTemplates is a list of claims that pods are allowed to reference.'],
    },
  };
  D.DaemonSet = top('DaemonSet represents the configuration of a daemon set.', 'DaemonSetSpec', 'DaemonSetStatus');
  D.DaemonSetSpec = {
    desc: 'DaemonSetSpec is the specification of a daemon set.',
    fields: {
      minReadySeconds: ['integer', 'The minimum number of seconds for which a newly created DaemonSet pod should be ready without any of its container crashing, for it to be considered available.'],
      revisionHistoryLimit: ['integer', 'The number of old history to retain to allow rollback. Defaults to 10.'],
      selector: ['LabelSelector', 'A label query over pods that are managed by the daemon set. Must match in order to be controlled.', true],
      template: ['PodTemplateSpec', 'An object that describes the pod that will be created.', true],
      updateStrategy: ['DaemonSetUpdateStrategy', 'An update strategy to replace existing DaemonSet pods with new pods.'],
    },
  };
  D.Service = top('Service is a named abstraction of software service (for example, mysql) consisting of local port (for example 3306) that the proxy listens on, and the selector that determines which pods will answer requests sent through the proxy.', 'ServiceSpec', 'ServiceStatus');
  D.ServiceSpec = {
    desc: 'ServiceSpec describes the attributes that a user creates on a service.',
    fields: {
      allocateLoadBalancerNodePorts: ['boolean', 'allocateLoadBalancerNodePorts defines if NodePorts will be automatically allocated for services with type LoadBalancer. Default is "true".'],
      clusterIP: ['string', 'clusterIP is the IP address of the service and is usually assigned randomly. "None" can be specified for headless services.'],
      clusterIPs: ['[]string', 'ClusterIPs is a list of IP addresses assigned to this service.'],
      externalIPs: ['[]string', 'externalIPs is a list of IP addresses for which nodes in the cluster will also accept traffic for this service.'],
      externalName: ['string', 'externalName is the external reference that discovery mechanisms will return as an alias for this service (e.g. a DNS CNAME record). Requires `type` to be "ExternalName".'],
      externalTrafficPolicy: ['string', 'externalTrafficPolicy describes how nodes distribute service traffic they receive on one of the Service\'s "externally-facing" addresses.'],
      internalTrafficPolicy: ['string', 'InternalTrafficPolicy describes how nodes distribute service traffic they receive on the ClusterIP.'],
      ipFamilies: ['[]string', 'IPFamilies is a list of IP families (e.g. IPv4, IPv6) assigned to this service.'],
      ipFamilyPolicy: ['string', 'IPFamilyPolicy represents the dual-stack-ness requested or required by this Service.'],
      loadBalancerClass: ['string', 'loadBalancerClass is the class of the load balancer implementation this Service belongs to.'],
      ports: ['[]ServicePort', 'The list of ports that are exposed by this service.'],
      publishNotReadyAddresses: ['boolean', 'publishNotReadyAddresses indicates that any agent which deals with endpoints for this Service should disregard any indications of ready/not-ready.'],
      selector: ['map[string]string', 'Route service traffic to pods with label keys and values matching this selector. If empty or not present, the service is assumed to have an external process managing its endpoints.'],
      sessionAffinity: ['string', 'Supports "ClientIP" and "None". Used to maintain session affinity. Defaults to None.'],
      type: ['string', 'type determines how the Service is exposed. Defaults to ClusterIP. Valid options are ExternalName, ClusterIP, NodePort, and LoadBalancer.\n\nPossible enum values:\n - `"ClusterIP"`\n - `"ExternalName"`\n - `"LoadBalancer"`\n - `"NodePort"`'],
    },
  };
  D.ServicePort = {
    desc: "ServicePort contains information on service's port.",
    fields: {
      appProtocol: ['string', 'The application protocol for this port.'],
      name: ['string', 'The name of this port within the service. This must be a DNS_LABEL. All ports within a ServiceSpec must have unique names.'],
      nodePort: ['integer', 'The port on each node on which this service is exposed when type is NodePort or LoadBalancer.'],
      port: ['integer', 'The port that will be exposed by this service.', true],
      protocol: ['string', 'The IP protocol for this port. Supports "TCP", "UDP", and "SCTP". Default is TCP.'],
      targetPort: ['IntOrString', "Number or name of the port to access on the pods targeted by the service. If this is a string, it will be looked up as a named port in the target Pod's container ports. If this is not specified, the value of the 'port' field is used."],
    },
  };
  D.ConfigMap = {
    desc: 'ConfigMap holds configuration data for pods to consume.',
    fields: {
      apiVersion: apiV,
      binaryData: ['map[string]string', "BinaryData contains the binary data. Each key must consist of alphanumeric characters, '-', '_' or '.'."],
      data: ['map[string]string', "Data contains the configuration data. Each key must consist of alphanumeric characters, '-', '_' or '.'."],
      immutable: ['boolean', 'Immutable, if set to true, ensures that data stored in the ConfigMap cannot be updated (only object metadata can be modified).'],
      kind: kindF,
      metadata: meta,
    },
  };
  D.Secret = {
    desc: 'Secret holds secret data of a certain type. The total bytes of the values in the Data field must be less than MaxSecretSize bytes.',
    fields: {
      apiVersion: apiV,
      data: ['map[string]string', 'Data contains the secret data. The serialized form of the secret data is a base64 encoded string.'],
      immutable: ['boolean', 'Immutable, if set to true, ensures that data stored in the Secret cannot be updated (only object metadata can be modified).'],
      kind: kindF,
      metadata: meta,
      stringData: ['map[string]string', 'stringData allows specifying non-binary secret data in string form. It is provided as a write-only input field for convenience.'],
      type: ['string', 'Used to facilitate programmatic handling of secret data.'],
    },
  };
  D.Namespace = top('Namespace provides a scope for Names. Use of multiple namespaces is optional.', 'NamespaceSpec', 'NamespaceStatus');
  D.NamespaceSpec = { desc: 'NamespaceSpec describes the attributes on a Namespace.', fields: { finalizers: ['[]string', 'Finalizers is an opaque list of values that must be empty to permanently remove object from storage.'] } };
  D.Node = top('Node is a worker node in Kubernetes. Each node will have a unique identifier in the cache (i.e. in etcd).', 'NodeSpec', 'NodeStatus');
  D.NodeSpec = {
    desc: 'NodeSpec describes the attributes that a node is created with.',
    fields: {
      podCIDR: ['string', 'PodCIDR represents the pod IP range assigned to the node.'],
      podCIDRs: ['[]string', 'podCIDRs represents the IP ranges assigned to the node for usage by Pods on that node.'],
      providerID: ['string', 'ID of the node assigned by the cloud provider in the format: <ProviderName>://<ProviderSpecificNodeID>'],
      taints: ['[]Taint', "If specified, the node's taints."],
      unschedulable: ['boolean', 'Unschedulable controls node schedulability of new pods. By default, node is schedulable.'],
    },
  };
  D.Job = top('Job represents the configuration of a single job.', 'JobSpec', 'JobStatus');
  D.JobSpec = {
    desc: 'JobSpec describes how the job execution will look like.',
    fields: {
      activeDeadlineSeconds: ['integer', 'Specifies the duration in seconds relative to the startTime that the job may be continuously active before the system tries to terminate it.'],
      backoffLimit: ['integer', 'Specifies the number of retries before marking this job failed. Defaults to 6'],
      completionMode: ['string', 'completionMode specifies how Pod completions are tracked. It can be `NonIndexed` (default) or `Indexed`.'],
      completions: ['integer', 'Specifies the desired number of successfully finished pods the job should be run with.'],
      manualSelector: ['boolean', 'manualSelector controls generation of pod labels and pod selectors.'],
      parallelism: ['integer', 'Specifies the maximum desired number of pods the job should run at any given time.'],
      podFailurePolicy: ['PodFailurePolicy', 'Specifies the policy of handling failed pods.'],
      selector: ['LabelSelector', 'A label query over pods that should match the pod count.'],
      suspend: ['boolean', 'suspend specifies whether the Job controller should create Pods or not.'],
      template: ['PodTemplateSpec', 'Describes the pod that will be created when executing a job. The only allowed template.spec.restartPolicy values are "Never" or "OnFailure".', true],
      ttlSecondsAfterFinished: ['integer', 'ttlSecondsAfterFinished limits the lifetime of a Job that has finished execution (either Complete or Failed).'],
    },
  };
  D.CronJob = top('CronJob represents the configuration of a single cron job.', 'CronJobSpec', 'CronJobStatus');
  D.CronJobSpec = {
    desc: 'CronJobSpec describes how the job execution will look like and when it will actually run.',
    fields: {
      concurrencyPolicy: ['string', 'Specifies how to treat concurrent executions of a Job. Valid values are:\n\n- "Allow" (default): allows CronJobs to run concurrently; - "Forbid": forbids concurrent runs, skipping next run if previous run hasn\'t finished yet; - "Replace": cancels currently running job and replaces it with a new one'],
      failedJobsHistoryLimit: ['integer', 'The number of failed finished jobs to retain. Value must be non-negative integer. Defaults to 1.'],
      jobTemplate: ['JobTemplateSpec', 'Specifies the job that will be created when executing a CronJob.', true],
      schedule: ['string', 'The schedule in Cron format, see https://en.wikipedia.org/wiki/Cron.', true],
      startingDeadlineSeconds: ['integer', 'Optional deadline in seconds for starting the job if it misses scheduled time for any reason.'],
      successfulJobsHistoryLimit: ['integer', 'The number of successful finished jobs to retain. Value must be non-negative integer. Defaults to 3.'],
      suspend: ['boolean', 'This flag tells the controller to suspend subsequent executions, it does not apply to already started executions. Defaults to false.'],
      timeZone: ['string', 'The time zone name for the given schedule, see https://en.wikipedia.org/wiki/List_of_tz_database_time_zones.'],
    },
  };
  D.JobTemplateSpec = { desc: 'JobTemplateSpec describes the data a Job should have when created from a template', fields: { metadata: meta, spec: ['JobSpec', 'Specification of the desired behavior of the job.'] } };
  D.Ingress = top('Ingress is a collection of rules that allow inbound connections to reach the endpoints defined by a backend. An Ingress can be configured to give services externally-reachable urls, load balance traffic, terminate SSL, offer name based virtual hosting etc.', 'IngressSpec', 'IngressStatus');
  D.IngressSpec = {
    desc: 'IngressSpec describes the Ingress the user wishes to exist.',
    fields: {
      defaultBackend: ['IngressBackend', "defaultBackend is the backend that should handle requests that don't match any rule."],
      ingressClassName: ['string', 'ingressClassName is the name of an IngressClass cluster resource.'],
      rules: ['[]IngressRule', 'rules is a list of host rules used to configure the Ingress. If unspecified, or no rule matches, all traffic is sent to the default backend.'],
      tls: ['[]IngressTLS', 'tls represents the TLS configuration.'],
    },
  };
  D.PersistentVolumeClaim = top("PersistentVolumeClaim is a user's request for and claim to a persistent volume", 'PersistentVolumeClaimSpec', 'PersistentVolumeClaimStatus');
  D.PersistentVolumeClaimSpec = {
    desc: 'PersistentVolumeClaimSpec describes the common attributes of storage devices and allows a Source for provider-specific attributes',
    fields: {
      accessModes: ['[]string', 'accessModes contains the desired access modes the volume should have.'],
      dataSource: ['TypedLocalObjectReference', 'dataSource field can be used to specify either an existing VolumeSnapshot object or an existing PVC.'],
      resources: ['VolumeResourceRequirements', 'resources represents the minimum resources the volume should have.'],
      selector: ['LabelSelector', 'selector is a label query over volumes to consider for binding.'],
      storageClassName: ['string', 'storageClassName is the name of the StorageClass required by the claim.'],
      volumeMode: ['string', 'volumeMode defines what type of volume is required by the claim. Value of Filesystem is implied when not included in claim spec.'],
      volumeName: ['string', 'volumeName is the binding reference to the PersistentVolume backing this claim.'],
    },
  };
  D.PersistentVolume = top('PersistentVolume (PV) is a storage resource provisioned by an administrator. It is analogous to a node.', 'PersistentVolumeSpec', 'PersistentVolumeStatus');
  D.HorizontalPodAutoscaler = top('HorizontalPodAutoscaler is the configuration for a horizontal pod autoscaler, which automatically manages the replica count of any resource implementing the scale subresource based on the metrics specified.', 'HorizontalPodAutoscalerSpec', 'HorizontalPodAutoscalerStatus');
  D.HorizontalPodAutoscalerSpec = {
    desc: 'HorizontalPodAutoscalerSpec describes the desired functionality of the HorizontalPodAutoscaler.',
    fields: {
      behavior: ['HorizontalPodAutoscalerBehavior', 'behavior configures the scaling behavior of the target in both Up and Down directions.'],
      maxReplicas: ['integer', 'maxReplicas is the upper limit for the number of replicas to which the autoscaler can scale up.', true],
      metrics: ['[]MetricSpec', 'metrics contains the specifications for which to use to calculate the desired replica count.'],
      minReplicas: ['integer', 'minReplicas is the lower limit for the number of replicas to which the autoscaler can scale down. It defaults to 1 pod.'],
      scaleTargetRef: ['CrossVersionObjectReference', 'scaleTargetRef points to the target resource to scale.', true],
    },
  };
  D.ServiceAccount = { desc: 'ServiceAccount binds together: * a name, understood by users, and perhaps by peripheral systems, for an identity * a principal that can be authenticated and authorized * a set of secrets', fields: { apiVersion: apiV, automountServiceAccountToken: ['boolean', 'AutomountServiceAccountToken indicates whether pods running as this service account should have an API token automatically mounted.'], imagePullSecrets: ['[]LocalObjectReference', 'ImagePullSecrets is a list of references to secrets in the same namespace to use for pulling any images in pods that reference this ServiceAccount.'], kind: kindF, metadata: meta, secrets: ['[]ObjectReference', 'Secrets is a list of the secrets in the same namespace that pods running using this ServiceAccount are allowed to use.'] } };
  D.Role = { desc: 'Role is a namespaced, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding.', fields: { apiVersion: apiV, kind: kindF, metadata: meta, rules: ['[]PolicyRule', 'Rules holds all the PolicyRules for this Role'] } };
  D.ClusterRole = { desc: 'ClusterRole is a cluster level, logical grouping of PolicyRules that can be referenced as a unit by a RoleBinding or ClusterRoleBinding.', fields: { aggregationRule: ['AggregationRule', 'AggregationRule is an optional field that describes how to build the Rules for this ClusterRole.'], apiVersion: apiV, kind: kindF, metadata: meta, rules: ['[]PolicyRule', 'Rules holds all the PolicyRules for this ClusterRole'] } };
  D.PolicyRule = { desc: 'PolicyRule holds information that describes a policy rule, but does not contain information about who the rule applies to or which namespace the rule applies to.', fields: { apiGroups: ['[]string', 'APIGroups is the name of the APIGroup that contains the resources. "" represents the core API group and "*" represents all API groups.'], nonResourceURLs: ['[]string', 'NonResourceURLs is a set of partial urls that a user should have access to.'], resourceNames: ['[]string', 'ResourceNames is an optional white list of names that the rule applies to. An empty set means that everything is allowed.'], resources: ['[]string', "Resources is a list of resources this rule applies to. '*' represents all resources."], verbs: ['[]string', "Verbs is a list of Verbs that apply to ALL the ResourceKinds contained in this rule. '*' represents all verbs.", true] } };
  D.RoleBinding = { desc: 'RoleBinding references a role, but does not contain it. It can reference a Role in the same namespace or a ClusterRole in the global namespace.', fields: { apiVersion: apiV, kind: kindF, metadata: meta, roleRef: ['RoleRef', 'RoleRef can reference a Role in the current namespace or a ClusterRole in the global namespace. This field is immutable.', true], subjects: ['[]Subject', 'Subjects holds references to the objects the role applies to.'] } };
  D.ClusterRoleBinding = { desc: 'ClusterRoleBinding references a ClusterRole, but not contain it. It can reference a ClusterRole in the global namespace, and adds who information via Subject.', fields: D.RoleBinding.fields };
  D.NetworkPolicy = top('NetworkPolicy describes what network traffic is allowed for a set of Pods', 'NetworkPolicySpec', null, 'spec represents the specification of the desired behavior for this NetworkPolicy.');
  D.NetworkPolicySpec = {
    desc: 'NetworkPolicySpec provides the specification of a NetworkPolicy',
    fields: {
      egress: ['[]NetworkPolicyEgressRule', 'egress is a list of egress rules to be applied to the selected pods.'],
      ingress: ['[]NetworkPolicyIngressRule', 'ingress is a list of ingress rules to be applied to the selected pods.'],
      podSelector: ['LabelSelector', 'podSelector selects the pods to which this NetworkPolicy object applies. An empty podSelector selects all pods in the namespace.', true],
      policyTypes: ['[]string', 'policyTypes is a list of rule types that the NetworkPolicy relates to. Valid options are ["Ingress"], ["Egress"], or ["Ingress", "Egress"].'],
    },
  };
  D.PodDisruptionBudget = top('PodDisruptionBudget is an object to define the max disruption that can be caused to a collection of pods', 'PodDisruptionBudgetSpec', 'PodDisruptionBudgetStatus');
  D.StorageClass = { desc: 'StorageClass describes the parameters for a class of storage for which PersistentVolumes can be dynamically provisioned.', fields: { allowVolumeExpansion: ['boolean', 'allowVolumeExpansion shows whether the storage class allow volume expand.'], apiVersion: apiV, kind: kindF, metadata: meta, mountOptions: ['[]string', 'mountOptions controls the mountOptions for dynamically provisioned PersistentVolumes of this storage class.'], parameters: ['map[string]string', 'parameters holds the parameters for the provisioner that should create volumes of this storage class.'], provisioner: ['string', 'provisioner indicates the type of the provisioner.', true], reclaimPolicy: ['string', 'reclaimPolicy controls the reclaimPolicy for dynamically provisioned PersistentVolumes of this storage class. Defaults to Delete.'], volumeBindingMode: ['string', 'volumeBindingMode indicates how PersistentVolumeClaims should be provisioned and bound. When unset, VolumeBindingImmediate is used.'] } };
})();
