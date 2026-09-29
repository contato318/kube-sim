// Manifestos de exemplo disponíveis em /root/examples e URLs conhecidas para `kubectl apply -f <url>`.
(function () {
  const KS = globalThis.KS;
  const files = {
    'nginx-deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-deployment
  labels:
    app: nginx
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.25
        ports:
        - containerPort: 80
`,
    'nginx-service.yaml': `apiVersion: v1
kind: Service
metadata:
  name: nginx
spec:
  selector:
    app: nginx
  ports:
  - port: 80
    targetPort: 80
`,
    'pod.yaml': `apiVersion: v1
kind: Pod
metadata:
  name: nginx
spec:
  containers:
  - name: nginx
    image: nginx:1.14.2
    ports:
    - containerPort: 80
`,
    'broken-image.yaml': `# Imagem com tag inexistente: o pod fica em ErrImagePull/ImagePullBackOff
apiVersion: v1
kind: Pod
metadata:
  name: broken-image
spec:
  containers:
  - name: app
    image: nginx:doesnotexist
`,
    'crashloop.yaml': `# O processo sai com código 1: o pod entra em CrashLoopBackOff
apiVersion: v1
kind: Pod
metadata:
  name: crashloop
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "echo 'iniciando...'; sleep 3; echo 'falha ao conectar no banco' >&2; exit 1"]
`,
    'liveness-exec.yaml': `# Exemplo da documentação: a probe falha após 30s e o container é reiniciado
apiVersion: v1
kind: Pod
metadata:
  labels:
    test: liveness
  name: liveness-exec
spec:
  containers:
  - name: liveness
    image: registry.k8s.io/busybox
    args:
    - /bin/sh
    - -c
    - touch /tmp/healthy; sleep 30; rm -f /tmp/healthy; sleep 600
    livenessProbe:
      exec:
        command:
        - cat
        - /tmp/healthy
      initialDelaySeconds: 5
      periodSeconds: 5
`,
    'job-pi.yaml': `apiVersion: batch/v1
kind: Job
metadata:
  name: pi
spec:
  template:
    spec:
      containers:
      - name: pi
        image: perl:5.34.0
        command: ["perl",  "-Mbignum=bpi", "-wle", "print bpi(2000)"]
      restartPolicy: Never
  backoffLimit: 4
`,
    'cronjob.yaml': `apiVersion: batch/v1
kind: CronJob
metadata:
  name: hello
spec:
  schedule: "* * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: hello
            image: busybox:1.28
            imagePullPolicy: IfNotPresent
            command:
            - /bin/sh
            - -c
            - date; echo Hello from the Kubernetes cluster
          restartPolicy: OnFailure
`,
    'statefulset.yaml': `apiVersion: v1
kind: Service
metadata:
  name: nginx-sts
  labels:
    app: web
spec:
  ports:
  - port: 80
    name: web
  clusterIP: None
  selector:
    app: web
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  selector:
    matchLabels:
      app: web
  serviceName: "nginx-sts"
  replicas: 3
  template:
    metadata:
      labels:
        app: web
    spec:
      terminationGracePeriodSeconds: 10
      containers:
      - name: nginx
        image: registry.k8s.io/nginx-slim:0.24
        ports:
        - containerPort: 80
          name: web
        volumeMounts:
        - name: www
          mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
  - metadata:
      name: www
    spec:
      accessModes: [ "ReadWriteOnce" ]
      resources:
        requests:
          storage: 1Gi
`,
    'daemonset.yaml': `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: kube-system
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      tolerations:
      - key: node-role.kubernetes.io/control-plane
        operator: Exists
        effect: NoSchedule
      containers:
      - name: node-exporter
        image: prom/node-exporter:v1.8.2
        ports:
        - containerPort: 9100
`,
    'configmap-env.yaml': `apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  APP_MODE: production
  APP_COLOR: blue
  app.properties: |
    log.level=info
    cache.size=128
---
apiVersion: v1
kind: Pod
metadata:
  name: config-demo
spec:
  containers:
  - name: app
    image: busybox:1.36
    command: ["sh", "-c", "echo modo=$APP_MODE cor=$APP_COLOR; cat /config/app.properties; sleep 3600"]
    envFrom:
    - configMapRef:
        name: app-config
    volumeMounts:
    - name: cfg
      mountPath: /config
  volumes:
  - name: cfg
    configMap:
      name: app-config
`,
    'pvc-pod.yaml': `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: writer
spec:
  containers:
  - name: writer
    image: busybox:1.36
    command: ["sh", "-c", "while true; do date >> /data/log.txt; sleep 5; done"]
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: data
`,
    'hpa-demo.yaml': `# Demonstração do HPA (walkthrough oficial). Depois de aplicar:
#   kubectl autoscale deployment php-apache --cpu-percent=50 --min=1 --max=10
#   kubectl run -i --tty load-generator --rm --image=busybox:1.28 --restart=Never -- /bin/sh -c "while sleep 0.01; do wget -q -O- http://php-apache; done"
#   kubectl get hpa php-apache --watch
apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
spec:
  selector:
    matchLabels:
      run: php-apache
  template:
    metadata:
      labels:
        run: php-apache
    spec:
      containers:
      - name: php-apache
        image: registry.k8s.io/hpa-example
        ports:
        - containerPort: 80
        resources:
          limits:
            cpu: 500m
          requests:
            cpu: 200m
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
  labels:
    run: php-apache
spec:
  ports:
  - port: 80
  selector:
    run: php-apache
`,
    'ingress.yaml': `# Depois de aplicar: curl http://localhost/app  (ou curl -H "Host: demo.local" http://localhost/)
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo
spec:
  ingressClassName: nginx
  rules:
  - http:
      paths:
      - path: /app
        pathType: Prefix
        backend:
          service:
            name: nginx
            port:
              number: 80
`,
    'networkpolicy.yaml': `# Bloqueia todo tráfego de entrada no namespace default, exceto de pods com role=frontend
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend
spec:
  podSelector:
    matchLabels:
      app: nginx
  policyTypes:
  - Ingress
  ingress:
  - from:
    - podSelector:
        matchLabels:
          role: frontend
    ports:
    - protocol: TCP
      port: 80
`,
    'rbac.yaml': `apiVersion: v1
kind: ServiceAccount
metadata:
  name: pod-reader
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "watch", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
subjects:
- kind: ServiceAccount
  name: pod-reader
  namespace: default
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
`,
    'crd.yaml': `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com
spec:
  group: stable.example.com
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                cronSpec:
                  type: string
                image:
                  type: string
                replicas:
                  type: integer
      additionalPrinterColumns:
      - name: Spec
        type: string
        jsonPath: .spec.cronSpec
      - name: Replicas
        type: integer
        jsonPath: .spec.replicas
      - name: Age
        type: date
        jsonPath: .metadata.creationTimestamp
  scope: Namespaced
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames:
    - ct
`,
    'my-crontab.yaml': `apiVersion: "stable.example.com/v1"
kind: CronTab
metadata:
  name: my-new-cron-object
spec:
  cronSpec: "* * * * */5"
  image: my-awesome-cron-image
  replicas: 1
`,
    'oom.yaml': `# Consome 250Mi com limite de 100Mi: o container é finalizado com OOMKilled
apiVersion: v1
kind: Pod
metadata:
  name: memory-demo
spec:
  containers:
  - name: memory-demo-ctr
    image: polinux/stress
    resources:
      requests:
        memory: "50Mi"
      limits:
        memory: "100Mi"
    command: ["stress"]
    args: ["--vm", "1", "--vm-bytes", "250M", "--vm-hang", "1"]
`,
    'quota.yaml': `apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute
spec:
  hard:
    pods: "5"
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.cpu: "2"
    limits.memory: 2Gi
---
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
spec:
  limits:
  - type: Container
    default:
      cpu: 200m
      memory: 256Mi
    defaultRequest:
      cpu: 100m
      memory: 128Mi
`,
    'kustomize/kustomization.yaml': `namespace: default
namePrefix: dev-
commonLabels:
  env: dev
resources:
- deployment.yaml
configMapGenerator:
- name: app-settings
  literals:
  - LOG_LEVEL=debug
images:
- name: nginx
  newTag: "1.27"
replicas:
- name: web
  count: 2
`,
    'kustomize/deployment.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx
        envFrom:
        - configMapRef:
            name: app-settings
`,
  };
  const urls = {};
  const ex = (p, f) => {
    for (const base of ['https://k8s.io/examples/', 'https://kubernetes.io/examples/', 'https://raw.githubusercontent.com/kubernetes/website/main/content/en/examples/']) urls[base + p] = files[f];
  };
  ex('application/deployment.yaml', 'nginx-deployment.yaml');
  ex('controllers/nginx-deployment.yaml', 'nginx-deployment.yaml');
  ex('pods/simple-pod.yaml', 'pod.yaml');
  ex('pods/probe/exec-liveness.yaml', 'liveness-exec.yaml');
  ex('controllers/job.yaml', 'job-pi.yaml');
  ex('application/job/cronjob.yaml', 'cronjob.yaml');
  ex('application/web/web.yaml', 'statefulset.yaml');
  ex('application/php-apache.yaml', 'hpa-demo.yaml');
  ex('pods/resource/memory-request-limit-2.yaml', 'oom.yaml');
  KS.examples = { files, urls };
})();
