// Missões guiadas: objetivos verificados automaticamente contra o estado do cluster simulado.
(function () {
  const KS = globalThis.KS;
  const U = KS.util, S = KS.schema, SYSTEM = KS.SYSTEM;
  const STORE = 'ks-missions-v1';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------- helpers de verificação ----------------
  const mk = (term) => {
    const c = term.cluster;
    const T = (id) => S.byId(id);
    const h = {
      c,
      obj: (id, ns, name) => c.raw(T(id), ns, name),
      pods: (ns, sel) => c.rawList(T('pods'), ns).filter((p) => !p.metadata.deletionTimestamp && (!sel || U.matchLabelString(sel, p.metadata.labels))),
      ready: (p) => !!p && c.isReady(p),
      running: (ns, name) => { const p = c.raw(T('pods'), ns, name); return !!p && p.status.phase === 'Running' && c.isReady(p); },
      deploy: (ns, name) => c.raw(T('deployments.apps'), ns, name),
      available: (ns, name, n = 1) => { const d = c.raw(T('deployments.apps'), ns, name); return !!d && (d.status.availableReplicas || 0) >= n && (d.status.updatedReplicas || 0) >= Math.min(n, d.spec.replicas); },
      ran: (re) => term.history.some((l) => re.test(l)),
      image: (d) => d && d.spec.template.spec.containers[0].image,
      eps: (ns, name) => { const e = c.raw(T('endpoints'), ns, name); return e ? (e.subsets || []).flatMap((s) => s.addresses || []) : []; },
      can: (user, groups, a) => c.authorize({ user, groups }, a).allowed,
      ns: () => term.curNs(),
    };
    return h;
  };

  // ---------------- missões ----------------
  const LEVELS = [
    ['basico', 'Básico'],
    ['workloads', 'Aplicações'],
    ['config', 'Configuração e acesso'],
    ['trouble', 'Troubleshooting'],
    ['avancado', 'Operação do cluster'],
  ];
  const M = [
    {
      id: 'primeiros-passos', level: 'basico', title: 'Conheça o cluster',
      intro: 'Antes de colocar qualquer aplicação no ar, descubra o que já existe. Este cluster tem um nó de control plane e dois workers, com os componentes de sistema rodando no namespace kube-system.',
      tasks: [
        { text: 'Liste os nós do cluster', check: (h) => h.ran(/\b(kubectl|k)\s+get\s+(nodes?|no)\b/), hint: 'Nós são o recurso "nodes" (atalho "no").', sol: 'kubectl get nodes -o wide' },
        { text: 'Liste os pods de todos os namespaces', check: (h) => h.ran(/get\s+(pods?|po)\b.*(-A\b|--all-namespaces)/) || h.ran(/(-A\b|--all-namespaces).*get\s+(pods?|po)\b/), hint: 'A flag -A (ou --all-namespaces) ignora o namespace atual.', sol: 'kubectl get pods -A' },
        { text: 'Veja os endereços do control plane', check: (h) => h.ran(/cluster-info/), hint: 'Existe um comando que mostra onde o API server está respondendo.', sol: 'kubectl cluster-info' },
        { text: 'Descubra os tipos de recurso que a API oferece', check: (h) => h.ran(/api-resources/), hint: 'Esse comando lista nome, abreviação, grupo e se o recurso é namespaced.', sol: 'kubectl api-resources' },
      ],
    },
    {
      id: 'primeiro-pod', level: 'basico', title: 'Seu primeiro Pod',
      intro: 'O Pod é a menor unidade que o Kubernetes agenda. Crie um Pod com o nginx, investigue o que aconteceu com ele e leia os logs do container.',
      tasks: [
        { text: 'Crie um Pod chamado web com a imagem nginx:1.25', check: (h) => { const p = h.obj('pods', 'default', 'web'); return !!p && /nginx:1\.25/.test(p.spec.containers[0].image); }, hint: 'kubectl run cria um Pod a partir de uma imagem.', sol: 'kubectl run web --image=nginx:1.25' },
        { text: 'Espere o Pod ficar Running e pronto (1/1)', check: (h) => h.running('default', 'web'), hint: 'Acompanhe com kubectl get pods -w e pare com Ctrl+C.', sol: 'kubectl get pods -w' },
        { text: 'Veja os eventos do Pod com describe', check: (h) => h.ran(/describe\s+(pods?|po)[\s/]+web\b/), hint: 'A seção Events mostra agendamento, pull da imagem e início do container.', sol: 'kubectl describe pod web' },
        { text: 'Leia os logs do container', check: (h) => h.ran(/logs\s+(pod\/)?web\b/), hint: 'Os logs do nginx mostram o entrypoint iniciando os workers.', sol: 'kubectl logs web' },
        { text: 'Execute um comando dentro do container', check: (h) => h.ran(/exec\s+.*\bweb\b.*--/), hint: 'Use -- para separar o comando do container dos argumentos do kubectl.', sol: 'kubectl exec web -- cat /etc/nginx/conf.d/default.conf' },
      ],
    },
    {
      id: 'labels', level: 'basico', title: 'Labels e seletores',
      intro: 'Labels são pares chave=valor que o Kubernetes usa para agrupar e selecionar objetos. Services, Deployments e NetworkPolicies dependem deles.',
      tasks: [
        { text: 'Adicione o label env=prod ao Pod web', check: (h) => { const p = h.obj('pods', 'default', 'web'); return !!p && (p.metadata.labels || {}).env === 'prod'; }, hint: 'kubectl label <tipo> <nome> chave=valor. Se o Pod web não existe, faça a missão anterior.', sol: 'kubectl label pod web env=prod' },
        { text: 'Liste apenas os pods com env=prod', check: (h) => h.ran(/get\s+(pods?|po).*(-l|--selector)[\s=]+['"]?env=prod/), hint: 'A flag -l aceita um seletor de labels.', sol: 'kubectl get pods -l env=prod --show-labels' },
        { text: 'Remova o label run do Pod web', check: (h) => { const p = h.obj('pods', 'default', 'web'); return !!p && !('run' in (p.metadata.labels || {})); }, hint: 'Um hífen no final da chave remove o label.', sol: 'kubectl label pod web run-' },
      ],
    },
    {
      id: 'deployment', level: 'workloads', title: 'Deployments e réplicas',
      intro: 'Um Deployment mantém um número de réplicas rodando e recria os Pods que somem. Crie um, escale e veja o ReplicaSet por trás dele.',
      tasks: [
        { text: 'Crie o Deployment app com nginx:1.25 e 3 réplicas', check: (h) => { const d = h.deploy('default', 'app'); return !!d && /nginx:1\.25/.test(h.image(d)); }, hint: 'kubectl create deployment aceita --image e --replicas.', sol: 'kubectl create deployment app --image=nginx:1.25 --replicas=3' },
        { text: 'Espere as 3 réplicas ficarem disponíveis', check: (h) => h.available('default', 'app', 3), hint: 'kubectl rollout status espera o Deployment terminar.', sol: 'kubectl rollout status deploy/app' },
        { text: 'Apague um Pod do app e veja outro ser criado', check: (h) => h.ran(/delete\s+(pods?|po)\b.*app/), hint: 'Copie o nome de um Pod de kubectl get pods -l app=app.', sol: 'kubectl delete pod $(kubectl get pods -l app=app -o jsonpath=\'{.items[0].metadata.name}\')' },
        { text: 'Escale o Deployment para 5 réplicas', check: (h) => { const d = h.deploy('default', 'app'); return !!d && d.spec.replicas === 5 && h.available('default', 'app', 5); }, hint: 'kubectl scale muda spec.replicas.', sol: 'kubectl scale deploy app --replicas=5' },
        { text: 'Liste o ReplicaSet criado pelo Deployment', check: (h) => h.ran(/get\s+(rs|replicasets?)\b/), hint: 'O nome do ReplicaSet leva o hash do template do Pod.', sol: 'kubectl get rs -l app=app' },
      ],
    },
    {
      id: 'service', level: 'workloads', title: 'Services e DNS',
      intro: 'Pods mudam de IP o tempo todo. O Service dá um IP e um nome DNS estáveis e distribui o tráfego entre os Pods selecionados pelos labels.',
      tasks: [
        { text: 'Exponha o Deployment app na porta 80 (Service app)', check: (h) => { const s = h.obj('services', 'default', 'app'); return !!s && (s.spec.ports || []).some((p) => p.port === 80); }, hint: 'kubectl expose cria um Service com o seletor do Deployment. Faça antes a missão Deployments.', sol: 'kubectl expose deploy app --port=80' },
        { text: 'Confira que o Service tem endpoints', check: (h) => h.eps('default', 'app').length > 0 && h.ran(/get\s+(endpoints|ep|endpointslices?)\b/), hint: 'Os endpoints são os IPs dos Pods prontos.', sol: 'kubectl get endpoints app' },
        { text: 'Acesse o Service pelo nome a partir de outro Pod', check: (h) => h.ran(/(wget|curl)\s.*\bapp\b/) && h.ran(/run\b|exec\b/), hint: 'Nomes de Service só resolvem dentro do cluster. Use um Pod temporário com busybox.', sol: 'kubectl run tmp --image=busybox:1.36 --rm -i --restart=Never -- wget -qO- http://app' },
        { text: 'Resolva o nome completo do Service com nslookup', check: (h) => h.ran(/nslookup\s+app/), hint: 'O FQDN é <service>.<namespace>.svc.cluster.local.', sol: 'kubectl run dns --image=busybox:1.36 --rm -i --restart=Never -- nslookup app.default.svc.cluster.local' },
      ],
    },
    {
      id: 'rollout', level: 'workloads', title: 'Rolling update e rollback',
      intro: 'Trocar a imagem de um Deployment dispara um rolling update: Pods novos sobem enquanto os antigos saem aos poucos. Se algo der errado, dá para voltar.',
      tasks: [
        { text: 'Atualize o app para nginx:1.27', check: (h) => { const d = h.deploy('default', 'app'); return !!d && h.c.controlledBy(S.byId('replicasets.apps'), 'default', d).some((rs) => /nginx:1\.27/.test(rs.spec.template.spec.containers[0].image)); }, hint: 'kubectl set image deploy/<nome> <container>=<imagem>. O container se chama nginx.', sol: 'kubectl set image deploy/app nginx=nginx:1.27' },
        { text: 'Acompanhe o rollout até terminar', check: (h) => h.ran(/rollout\s+status/), hint: 'O comando mostra quantas réplicas novas já estão disponíveis.', sol: 'kubectl rollout status deploy/app' },
        { text: 'Veja o histórico de revisões', check: (h) => h.ran(/rollout\s+history/), hint: 'Cada template diferente vira uma revisão.', sol: 'kubectl rollout history deploy/app' },
        { text: 'Volte para a versão anterior (nginx:1.25)', check: (h) => { const d = h.deploy('default', 'app'); return !!d && /nginx:1\.25/.test(h.image(d)) && Number((d.metadata.annotations || {})['deployment.kubernetes.io/revision'] || 0) >= 3; }, hint: 'kubectl rollout undo volta para a revisão anterior e cria uma revisão nova.', sol: 'kubectl rollout undo deploy/app' },
      ],
    },
    {
      id: 'declarativo', level: 'workloads', title: 'YAML declarativo',
      intro: 'Em produção, os recursos vivem em arquivos YAML versionados. Gere um manifesto, edite e aplique com kubectl apply.',
      tasks: [
        { text: 'Gere o YAML de um Deployment sem criá-lo e salve em api.yaml', check: (h) => { const t = h.c && KS.term.vfs.read('/root/api.yaml'); return !!t && /kind:\s*Deployment/.test(t); }, hint: 'Combine --dry-run=client -o yaml com um redirecionamento >.', sol: 'kubectl create deployment api --image=nginx:1.25 --dry-run=client -o yaml > api.yaml' },
        { text: 'Mude as réplicas no arquivo para 2 (vi api.yaml)', check: () => { const t = KS.term.vfs.read('/root/api.yaml'); return !!t && /replicas:\s*2\b/.test(t); }, hint: 'Abra o editor com vi api.yaml, altere e salve com Ctrl+S.', sol: "sed -i 's/replicas: 1/replicas: 2/' api.yaml" },
        { text: 'Aplique o arquivo', check: (h) => h.available('default', 'api', 2), hint: 'kubectl apply -f cria ou atualiza o recurso.', sol: 'kubectl apply -f api.yaml' },
        { text: 'Veja a diferença antes de aplicar uma mudança', check: (h) => h.ran(/\bdiff\s+-f/), hint: 'Altere algo no arquivo e use kubectl diff.', sol: 'kubectl diff -f api.yaml' },
      ],
    },
    {
      id: 'config', level: 'config', title: 'ConfigMaps e Secrets',
      intro: 'Configuração não deve ficar dentro da imagem. ConfigMaps guardam valores comuns e Secrets guardam dados sensíveis; os dois podem virar variáveis de ambiente ou arquivos.',
      tasks: [
        { text: 'Crie o ConfigMap app-config com APP_COLOR=blue', check: (h) => { const c = h.obj('configmaps', 'default', 'app-config'); return !!c && (c.data || {}).APP_COLOR === 'blue'; }, hint: 'Use --from-literal=CHAVE=valor.', sol: 'kubectl create configmap app-config --from-literal=APP_COLOR=blue' },
        { text: 'Crie o Secret db-pass com password=s3cr3t', check: (h) => { const s = h.obj('secrets', 'default', 'db-pass'); try { return !!s && U.b64d((s.data || {}).password || '') === 's3cr3t'; } catch (e) { return false; } }, hint: 'kubectl create secret generic também aceita --from-literal.', sol: 'kubectl create secret generic db-pass --from-literal=password=s3cr3t' },
        { text: 'Rode o Pod cfg-pod que recebe os dois como variáveis de ambiente', check: (h) => { const p = h.obj('pods', 'default', 'cfg-pod'); if (!p || !h.running('default', 'cfg-pod')) return false; const c = p.spec.containers[0]; const s = JSON.stringify([c.env || [], c.envFrom || []]); return /app-config/.test(s) && /db-pass/.test(s); }, hint: 'Escreva um YAML com envFrom (configMapRef) e env.valueFrom.secretKeyRef. O container precisa ficar rodando, por exemplo com sleep 3600.', sol: "cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: Pod\nmetadata:\n  name: cfg-pod\nspec:\n  containers:\n  - name: app\n    image: busybox:1.36\n    command: [\"sh\", \"-c\", \"sleep 3600\"]\n    envFrom:\n    - configMapRef:\n        name: app-config\n    env:\n    - name: DB_PASSWORD\n      valueFrom:\n        secretKeyRef:\n          name: db-pass\n          key: password\nEOF" },
        { text: 'Confira as variáveis dentro do container', check: (h) => h.ran(/exec\s+.*cfg-pod.*--\s*(env|printenv)/), hint: 'Rode env dentro do Pod.', sol: 'kubectl exec cfg-pod -- env' },
      ],
    },
    {
      id: 'namespaces', level: 'config', title: 'Namespaces e contexto',
      intro: 'Namespaces separam times e ambientes dentro do mesmo cluster. O contexto do kubeconfig define o namespace padrão dos seus comandos.',
      tasks: [
        { text: 'Crie o namespace staging', check: (h) => !!h.obj('namespaces', '', 'staging'), hint: 'kubectl create namespace <nome>.', sol: 'kubectl create namespace staging' },
        { text: 'Mude o namespace padrão do contexto para staging', check: (h) => h.ns() === 'staging', hint: 'kubectl config set-context --current --namespace=...', sol: 'kubectl config set-context --current --namespace=staging' },
        { text: 'Crie o Deployment api-staging no namespace staging', check: (h) => h.available('staging', 'api-staging', 1), hint: 'Com o contexto em staging, não precisa de -n.', sol: 'kubectl create deployment api-staging --image=nginx:1.25' },
        { text: 'Volte o contexto para o namespace default', check: (h) => h.ns() === 'default' && !!h.deploy('staging', 'api-staging'), hint: 'Mesmo comando, outro namespace.', sol: 'kubectl config set-context --current --namespace=default' },
      ],
    },
    {
      id: 'rbac', level: 'config', title: 'RBAC com ServiceAccount',
      intro: 'Crie uma identidade que só consegue ler Pods. O API server nega tudo o que não foi permitido explicitamente por um Role e um RoleBinding.',
      tasks: [
        { text: 'Crie a ServiceAccount viewer', check: (h) => !!h.obj('serviceaccounts', 'default', 'viewer'), hint: 'kubectl create serviceaccount.', sol: 'kubectl create serviceaccount viewer' },
        { text: 'Crie o Role pod-reader com get e list em pods', check: (h) => { const r = h.obj('roles.rbac.authorization.k8s.io', 'default', 'pod-reader'); return !!r && (r.rules || []).some((x) => (x.resources || []).includes('pods') && ['get', 'list'].every((v) => x.verbs.includes(v) || x.verbs.includes('*'))); }, hint: 'kubectl create role com --verb e --resource.', sol: 'kubectl create role pod-reader --verb=get,list --resource=pods' },
        { text: 'Ligue o Role à ServiceAccount', check: (h) => h.can('system:serviceaccount:default:viewer', ['system:serviceaccounts', 'system:authenticated'], { verb: 'list', group: '', resource: 'pods', namespace: 'default' }), hint: 'O subject de uma ServiceAccount é <namespace>:<nome>.', sol: 'kubectl create rolebinding viewer-pods --role=pod-reader --serviceaccount=default:viewer' },
        { text: 'Prove com auth can-i que ela lista pods mas não apaga', check: (h) => h.ran(/auth\s+can-i\s+(delete|create).*pods.*--as[= ]system:serviceaccount:default:viewer/) || h.ran(/auth\s+can-i.*--as[= ]system:serviceaccount:default:viewer.*(delete|create)/), hint: 'Use --as=system:serviceaccount:default:viewer.', sol: 'kubectl auth can-i delete pods --as=system:serviceaccount:default:viewer' },
      ],
    },
    {
      id: 'probes', level: 'config', title: 'Probes e recursos',
      intro: 'A readinessProbe tira do Service os Pods que não estão prontos. A livenessProbe reinicia containers travados. Requests e limits definem a classe de QoS.',
      tasks: [
        { text: 'Crie o Deployment healthy com readiness e liveness probes HTTP na porta 80', check: (h) => { const d = h.deploy('default', 'healthy'); if (!d) return false; const c = d.spec.template.spec.containers[0]; return !!(c.readinessProbe && c.readinessProbe.httpGet && c.livenessProbe) && h.available('default', 'healthy', 1); }, hint: 'Gere o YAML com --dry-run e adicione readinessProbe/livenessProbe com httpGet path / port 80.', sol: "cat <<EOF | kubectl apply -f -\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: healthy\nspec:\n  replicas: 2\n  selector:\n    matchLabels: {app: healthy}\n  template:\n    metadata:\n      labels: {app: healthy}\n    spec:\n      containers:\n      - name: nginx\n        image: nginx:1.25\n        readinessProbe:\n          httpGet: {path: /, port: 80}\n          periodSeconds: 5\n        livenessProbe:\n          httpGet: {path: /, port: 80}\n          initialDelaySeconds: 5\nEOF" },
        { text: 'Crie o Pod guaranteed com QoS Guaranteed', check: (h) => { const p = h.obj('pods', 'default', 'guaranteed'); return !!p && p.status.qosClass === 'Guaranteed'; }, hint: 'Guaranteed exige requests iguais aos limits de CPU e memória em todos os containers.', sol: "kubectl run guaranteed --image=nginx:1.25 --overrides='{\"spec\":{\"containers\":[{\"name\":\"guaranteed\",\"image\":\"nginx:1.25\",\"resources\":{\"requests\":{\"cpu\":\"100m\",\"memory\":\"64Mi\"},\"limits\":{\"cpu\":\"100m\",\"memory\":\"64Mi\"}}}]}}'" },
        { text: 'Veja a classe de QoS com jsonpath', check: (h) => h.ran(/qosClass/), hint: 'O campo é .status.qosClass.', sol: "kubectl get pod guaranteed -o jsonpath='{.status.qosClass}'" },
      ],
    },
    {
      id: 'image-pull', level: 'trouble', title: 'O deploy que não sobe', scenario: true,
      intro: 'O time publicou o Deployment shop e nenhum Pod fica pronto. Descubra o motivo e corrija sem apagar o Deployment.',
      setup: (term) => {
        term.cluster.create({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'shop', namespace: 'default', labels: { app: 'shop' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'shop' } }, template: { metadata: { labels: { app: 'shop' } }, spec: { containers: [{ name: 'shop', image: 'ngnix:1.25', ports: [{ containerPort: 80 }] }] } } } }, SYSTEM);
      },
      cleanup: [['deployments.apps', 'default', 'shop']],
      tasks: [
        { text: 'Encontre o status de erro dos Pods do shop', check: (h) => h.ran(/get\s+(pods?|po)/) && h.ran(/describe\s+(pods?|po|deploy|deployment)/), hint: 'Olhe a coluna STATUS e os eventos do describe.', sol: 'kubectl describe pod -l app=shop | tail -8' },
        { text: 'Corrija a imagem e deixe as 2 réplicas disponíveis', check: (h) => h.available('default', 'shop', 2) && /^nginx/.test(h.image(h.deploy('default', 'shop'))), hint: 'Há um erro de digitação no nome da imagem.', sol: 'kubectl set image deploy/shop shop=nginx:1.25' },
      ],
    },
    {
      id: 'crashloop', level: 'trouble', title: 'Banco em CrashLoopBackOff', scenario: true,
      intro: 'O Deployment db usa postgres e o Pod reinicia sem parar. Leia os logs do container, entenda o que falta e corrija.',
      setup: (term) => {
        term.cluster.create({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'db', namespace: 'default', labels: { app: 'db' } }, spec: { replicas: 1, selector: { matchLabels: { app: 'db' } }, template: { metadata: { labels: { app: 'db' } }, spec: { containers: [{ name: 'postgres', image: 'postgres:16', ports: [{ containerPort: 5432 }] }] } } } }, SYSTEM);
      },
      cleanup: [['deployments.apps', 'default', 'db']],
      tasks: [
        { text: 'Leia os logs do container que falhou', check: (h) => h.ran(/logs\b.*\b(db|deploy\/db)\b/) || h.ran(/logs\s+db-/), hint: 'kubectl logs aceita deploy/<nome>. Com -p você vê a execução anterior.', sol: 'kubectl logs deploy/db' },
        { text: 'Corrija o Deployment para o postgres subir', check: (h) => h.available('default', 'db', 1), hint: 'A imagem exige a variável POSTGRES_PASSWORD.', sol: 'kubectl set env deploy/db POSTGRES_PASSWORD=secret' },
      ],
    },
    {
      id: 'no-endpoints', level: 'trouble', title: 'Service sem destino', scenario: true,
      intro: 'O Service backend existe e os Pods estão rodando, mas quem chama o backend recebe connection refused.',
      setup: (term) => {
        term.cluster.create({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'backend', namespace: 'default', labels: { app: 'backend' } }, spec: { replicas: 2, selector: { matchLabels: { app: 'backend' } }, template: { metadata: { labels: { app: 'backend' } }, spec: { containers: [{ name: 'api', image: 'nginx:1.25', ports: [{ containerPort: 80 }] }] } } } }, SYSTEM);
        term.cluster.create({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'backend', namespace: 'default' }, spec: { selector: { app: 'backnd' }, ports: [{ port: 80, targetPort: 80 }] } }, SYSTEM);
      },
      cleanup: [['deployments.apps', 'default', 'backend'], ['services', 'default', 'backend']],
      tasks: [
        { text: 'Confirme que o Service não tem endpoints', check: (h) => h.ran(/(get|describe)\s+(endpoints|ep|svc|service|services)\b.*backend/), hint: 'describe svc mostra a linha Endpoints.', sol: 'kubectl describe svc backend' },
        { text: 'Faça o Service encaminhar para os Pods do backend', check: (h) => h.eps('default', 'backend').length >= 2, hint: 'Compare o seletor do Service com os labels dos Pods.', sol: "kubectl patch svc backend -p '{\"spec\":{\"selector\":{\"app\":\"backend\"}}}'" },
      ],
    },
    {
      id: 'pending', level: 'trouble', title: 'Pod preso em Pending', scenario: true,
      intro: 'O Pod bigjob não sai de Pending. O scheduler registrou o motivo nos eventos. Ajuste o Pod para caber no cluster.',
      setup: (term) => {
        term.cluster.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'bigjob', namespace: 'default', labels: { app: 'bigjob' } }, spec: { containers: [{ name: 'worker', image: 'busybox:1.36', command: ['sh', '-c', 'sleep 3600'], resources: { requests: { cpu: '16', memory: '64Mi' } } }] } }, SYSTEM);
      },
      cleanup: [['pods', 'default', 'bigjob']],
      tasks: [
        { text: 'Descubra por que o scheduler não encontra um nó', check: (h) => h.ran(/describe\s+(pods?|po)[\s/]+bigjob/) || h.ran(/get\s+events/), hint: 'Procure o evento FailedScheduling.', sol: 'kubectl describe pod bigjob | tail -4' },
        { text: 'Recrie o Pod pedindo no máximo 500m de CPU e deixe-o Running', check: (h) => { const p = h.obj('pods', 'default', 'bigjob'); return !!p && U.cpuMilli(p.spec.containers[0].resources.requests.cpu || 0) <= 500 && h.running('default', 'bigjob'); }, hint: 'Requests de Pods não podem ser editados: exporte o YAML, corrija e use kubectl replace --force.', sol: "kubectl get pod bigjob -o yaml | sed 's/cpu: \"16\"/cpu: 500m/' | kubectl replace --force -f -" },
      ],
    },
    {
      id: 'jobs', level: 'avancado', title: 'Jobs e CronJobs',
      intro: 'Jobs rodam tarefas até concluir; CronJobs criam Jobs em um horário definido.',
      tasks: [
        { text: 'Rode o Job pi do arquivo de exemplo até completar', check: (h) => { const j = h.obj('jobs.batch', 'default', 'pi'); return !!j && (j.status.conditions || []).some((c) => c.type === 'Complete' && c.status === 'True'); }, hint: 'O arquivo está em examples/job-pi.yaml. A imagem perl leva alguns segundos para baixar.', sol: 'kubectl apply -f examples/job-pi.yaml && kubectl wait --for=condition=Complete job/pi --timeout=60s' },
        { text: 'Leia o resultado do Job', check: (h) => h.ran(/logs\s+(job\/pi|pi-)/), hint: 'kubectl logs aceita job/<nome>.', sol: 'kubectl logs job/pi' },
        { text: 'Crie o CronJob hello que roda a cada minuto e espere a primeira execução', check: (h) => { const cj = h.obj('cronjobs.batch', 'default', 'hello'); return !!cj && !!cj.status.lastScheduleTime; }, hint: 'Use o cron "*/1 * * * *". A execução acontece na virada do minuto.', sol: 'kubectl create cronjob hello --image=busybox:1.36 --schedule="*/1 * * * *" -- date' },
      ],
    },
    {
      id: 'storage', level: 'avancado', title: 'Volumes persistentes',
      intro: 'Um PersistentVolumeClaim pede armazenamento; a StorageClass padrão provisiona o volume quando o primeiro Pod usa o PVC.',
      tasks: [
        { text: 'Crie o PVC data e o Pod writer do exemplo', check: (h) => { const c = h.obj('persistentvolumeclaims', 'default', 'data'); return !!c && c.status.phase === 'Bound' && h.running('default', 'writer'); }, hint: 'O arquivo examples/pvc-pod.yaml tem os dois recursos.', sol: 'kubectl apply -f examples/pvc-pod.yaml' },
        { text: 'Veja o PV criado dinamicamente', check: (h) => h.ran(/get\s+(pv|persistentvolumes?)\b/), hint: 'PVs não têm namespace.', sol: 'kubectl get pv,pvc' },
        { text: 'Recrie o Pod writer e confirme que os dados continuam lá', check: (h) => h.ran(/exec\s+.*writer.*(cat|tail|head).*\/data/) && h.ran(/delete\s+(pods?|po)[\s/]+writer/), hint: 'Apague o Pod, aplique de novo o exemplo e leia /data/log.txt.', sol: 'kubectl delete pod writer && kubectl apply -f examples/pvc-pod.yaml && sleep 3 && kubectl exec writer -- cat /data/log.txt' },
      ],
    },
    {
      id: 'scheduling', level: 'avancado', title: 'Taints, tolerations e nodeSelector',
      intro: 'Reserve o nó sim-worker2 para cargas especiais: nada entra lá sem tolerar o taint.',
      tasks: [
        { text: 'Aplique o taint dedicated=gpu:NoSchedule no sim-worker2', check: (h) => ((h.obj('nodes', '', 'sim-worker2') || { spec: {} }).spec.taints || []).some((t) => t.key === 'dedicated' && t.value === 'gpu' && t.effect === 'NoSchedule'), hint: 'kubectl taint nodes <nó> chave=valor:efeito.', sol: 'kubectl taint nodes sim-worker2 dedicated=gpu:NoSchedule' },
        { text: 'Rode o Pod gpu-job com toleration, fixado no sim-worker2', check: (h) => { const p = h.obj('pods', 'default', 'gpu-job'); return !!p && p.spec.nodeName === 'sim-worker2' && h.running('default', 'gpu-job'); }, hint: 'Use tolerations para o taint e nodeSelector kubernetes.io/hostname: sim-worker2.', sol: "cat <<EOF | kubectl apply -f -\napiVersion: v1\nkind: Pod\nmetadata:\n  name: gpu-job\nspec:\n  nodeSelector:\n    kubernetes.io/hostname: sim-worker2\n  tolerations:\n  - key: dedicated\n    operator: Equal\n    value: gpu\n    effect: NoSchedule\n  containers:\n  - name: job\n    image: busybox:1.36\n    command: [\"sh\", \"-c\", \"sleep 3600\"]\nEOF" },
        { text: 'Remova o taint do nó', check: (h) => h.ran(/taint\s+(nodes?|no)\s+sim-worker2\s+dedicated.*-\s*$/) && !((h.obj('nodes', '', 'sim-worker2') || { spec: {} }).spec.taints || []).some((t) => t.key === 'dedicated'), hint: 'Um hífen no final remove o taint.', sol: 'kubectl taint nodes sim-worker2 dedicated=gpu:NoSchedule-' },
      ],
    },
    {
      id: 'manutencao', level: 'avancado', title: 'Manutenção de nó',
      intro: 'Antes de desligar um nó, drene-o: os Pods são despejados com respeito aos PodDisruptionBudgets e recriados em outro lugar.',
      tasks: [
        { text: 'Drene o nó sim-worker', check: (h) => h.ran(/drain\s+sim-worker\b(?!2)/) && (h.obj('nodes', '', 'sim-worker') || { spec: {} }).spec.unschedulable === true && h.c.podsOnNode('sim-worker').filter((p) => !(p.metadata.ownerReferences || []).some((r) => r.kind === 'DaemonSet')).length === 0, hint: 'DaemonSets não podem ser removidos; use --ignore-daemonsets. Pods sem controller exigem --force.', sol: 'kubectl drain sim-worker --ignore-daemonsets --delete-emptydir-data --force' },
        { text: 'Devolva o nó ao agendamento', check: (h) => h.ran(/uncordon\s+sim-worker\b/) && !(h.obj('nodes', '', 'sim-worker') || { spec: {} }).spec.unschedulable, hint: 'O oposto de cordon.', sol: 'kubectl uncordon sim-worker' },
      ],
    },
    {
      id: 'hpa', level: 'avancado', title: 'Autoscaling horizontal',
      intro: 'O HPA ajusta as réplicas pelo uso de CPU medido pelo metrics-server. Gere carga e veja o Deployment crescer.',
      tasks: [
        { text: 'Aplique o exemplo php-apache', check: (h) => h.available('default', 'php-apache', 1), hint: 'O arquivo é examples/hpa-demo.yaml.', sol: 'kubectl apply -f examples/hpa-demo.yaml' },
        { text: 'Crie um HPA de 50% de CPU, entre 1 e 10 réplicas', check: (h) => { const x = h.obj('horizontalpodautoscalers.autoscaling', 'default', 'php-apache'); return !!x && x.spec.maxReplicas === 10; }, hint: 'kubectl autoscale.', sol: 'kubectl autoscale deployment php-apache --cpu-percent=50 --min=1 --max=10' },
        { text: 'Gere carga e faça o HPA passar de 1 réplica', check: (h) => { const x = h.obj('horizontalpodautoscalers.autoscaling', 'default', 'php-apache'); return !!x && (x.status.desiredReplicas || 0) > 1; }, hint: 'Um Pod com wget em loop contra http://php-apache basta. O HPA reavalia a cada 15 segundos.', sol: 'kubectl run load --image=busybox:1.28 --restart=Never -- /bin/sh -c "while sleep 0.01; do wget -q -O- http://php-apache; done"' },
        { text: 'Acompanhe as réplicas e remova a carga', check: (h) => h.ran(/get\s+hpa/) && !h.obj('pods', 'default', 'load'), hint: 'Com a carga removida, o HPA reduz as réplicas depois de 5 minutos de estabilização.', sol: 'kubectl get hpa php-apache && kubectl delete pod load' },
      ],
    },
    {
      id: 'netpol', level: 'avancado', title: 'NetworkPolicy', scenario: true,
      intro: 'O Pod secure (label app=secure) deve aceitar tráfego somente de Pods com role=frontend na porta 80.',
      setup: (term) => {
        term.cluster.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'secure', namespace: 'default', labels: { app: 'secure' } }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.25', ports: [{ containerPort: 80 }] }] } }, SYSTEM);
        term.cluster.create({ apiVersion: 'v1', kind: 'Service', metadata: { name: 'secure', namespace: 'default' }, spec: { selector: { app: 'secure' }, ports: [{ port: 80 }] } }, SYSTEM);
      },
      cleanup: [['pods', 'default', 'secure'], ['services', 'default', 'secure']],
      tasks: [
        { text: 'Crie uma NetworkPolicy que só libera role=frontend na porta 80', check: (h) => {
          const dst = h.obj('pods', 'default', 'secure');
          if (!dst) return false;
          const fake = (labels) => ({ metadata: { name: 'x', namespace: 'default', labels, uid: 'x' }, spec: {} });
          return h.c.netAllowed(fake({ role: 'frontend' }), dst, 80).ok && !h.c.netAllowed(fake({ role: 'other' }), dst, 80).ok && !h.c.netAllowed(fake({ role: 'frontend' }), dst, 8080).ok;
        }, hint: 'podSelector escolhe quem é protegido; ingress.from escolhe quem entra.', sol: "cat <<EOF | kubectl apply -f -\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: secure-frontend\nspec:\n  podSelector:\n    matchLabels: {app: secure}\n  policyTypes: [Ingress]\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels: {role: frontend}\n    ports:\n    - protocol: TCP\n      port: 80\nEOF" },
        { text: 'Teste com um Pod sem o label (deve dar timeout)', check: (h) => h.ran(/run\b.*(wget|curl).*secure/) && h.ran(/role=frontend.*(wget|curl)|(wget|curl).*secure.*role=frontend|--labels[= ]role=frontend/), hint: 'Rode um Pod temporário sem label e outro com --labels=role=frontend.', sol: 'kubectl run t1 --image=busybox:1.36 --rm -i --restart=Never -- wget -qO- -T2 http://secure; kubectl run t2 --labels=role=frontend --image=busybox:1.36 --rm -i --restart=Never -- wget -qO- -T2 http://secure' },
      ],
    },
    {
      id: 'ingress', level: 'avancado', title: 'Ingress por host',
      intro: 'O ingress-nginx já está instalado. Publique o Service app no host demo.local e teste de fora do cluster.',
      tasks: [
        { text: 'Crie um Ingress para o host demo.local apontando para o Service app:80', check: (h) => { if (!h.obj('services', 'default', 'app')) return false; const r = h.c.ingressRoute('demo.local', '/', {}); return r.status === 200; }, hint: 'kubectl create ingress com --rule="host/path*=serviço:porta". O Service app vem da missão Services.', sol: 'kubectl create ingress demo --class=nginx --rule="demo.local/*=app:80"' },
        { text: 'Acesse pelo ingress com o cabeçalho Host', check: (h) => h.ran(/curl\s.*(-H\s*['"]?Host:\s*demo\.local|demo\.local)/), hint: 'O ingress responde em localhost:80.', sol: 'curl -H "Host: demo.local" http://localhost/' },
      ],
    },
    {
      id: 'control-plane', level: 'avancado', title: 'Scheduler quebrado', scenario: true,
      intro: 'Alguém editou o manifesto estático do kube-scheduler e agora nenhum Pod novo é agendado. Este terminal é o nó de control plane.',
      setup: (term) => {
        const f = '/etc/kubernetes/manifests/kube-scheduler.yaml';
        const t = term.vfs.read(f);
        if (t) term.vfs.write(f, t.replace(/image: registry\.k8s\.io\/kube-scheduler:[^\s]+/, 'image: registry.k8s.io/kube-schedular:v1.31.0'));
        term.cluster.create({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'waiting', namespace: 'default' }, spec: { containers: [{ name: 'nginx', image: 'nginx:1.25' }] } }, SYSTEM);
      },
      cleanup: [['pods', 'default', 'waiting']],
      tasks: [
        { text: 'Ache o componente com problema no kube-system', check: (h) => h.ran(/get\s+(pods?|po).*(-n\s*kube-system|--namespace[= ]kube-system|-A\b)/), hint: 'Os componentes do control plane rodam como Pods estáticos.', sol: 'kubectl get pods -n kube-system' },
        { text: 'Corrija o manifesto em /etc/kubernetes/manifests', check: (h) => h.c.componentUp('kube-scheduler'), hint: 'Compare o nome da imagem com a dos outros componentes. O kubelet recria o Pod quando o arquivo muda.', sol: "sed -i 's/kube-schedular/kube-scheduler/' /etc/kubernetes/manifests/kube-scheduler.yaml" },
        { text: 'Confirme que o Pod waiting foi agendado', check: (h) => h.running('default', 'waiting'), hint: 'Com o scheduler de volta, o Pod pendente é atribuído a um nó.', sol: 'kubectl get pod waiting -o wide' },
      ],
    },
  ];

  // ---------------- estado ----------------
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || 'null') || {}; } catch (e) { return {}; } };
  const st = Object.assign({ done: {}, active: null, hints: {}, sols: {} }, load());
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch (e) { /* segue sem persistir */ } };

  // ---------------- UI ----------------
  function init() {
    const term = KS.term;
    if (!term) return setTimeout(init, 50);
    const h = mk(term);
    const view = $('#view-missions');
    const byId = Object.fromEntries(M.map((m) => [m.id, m]));
    const results = {};
    const evalMission = (m) => m.tasks.map((t) => { try { return !!t.check(h); } catch (e) { return false; } });
    let last = '';
    let toastTimer = null;
    const toast = (msg) => {
      const el = $('#toast');
      el.textContent = msg;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.hidden = true), 4500);
    };
    const levelOf = (id) => LEVELS.find((l) => l[0] === id)[1];
    const render = () => {
      const doneCount = M.filter((m) => st.done[m.id]).length;
      let html = '';
      if (!st.active || !byId[st.active]) {
        html += `<div class="m-progress"><div class="m-bar"><i style="width:${Math.round((doneCount / M.length) * 100)}%"></i></div><span>${doneCount} de ${M.length} missões</span></div>`;
        html += '<p class="m-lead">Cada missão tem objetivos que o simulador confere sozinho enquanto você usa o terminal.</p>';
        for (const [lv, name] of LEVELS) {
          html += `<h3 class="m-level">${name}</h3><ol class="m-list">`;
          for (const m of M.filter((x) => x.level === lv)) {
            const d = !!st.done[m.id];
            html += `<li><button type="button" class="m-item${d ? ' done' : ''}" data-open="${m.id}"><span class="m-state" aria-hidden="true">${d ? '✓' : ''}</span><span class="m-title">${esc(m.title)}</span>${m.scenario ? '<span class="m-tag">cenário</span>' : ''}<span class="m-count">${m.tasks.length} passos</span></button></li>`;
          }
          html += '</ol>';
        }
      } else {
        const m = byId[st.active];
        const r = results[m.id] || evalMission(m);
        const n = r.filter(Boolean).length;
        const idx = M.indexOf(m);
        html += `<button type="button" class="m-back" data-back>← Todas as missões</button>`;
        html += `<div class="m-head"><span class="m-lv">${levelOf(m.level)} · ${idx + 1}/${M.length}</span><h3>${esc(m.title)}</h3></div>`;
        html += `<p class="m-intro">${esc(m.intro)}</p>`;
        if (m.setup) html += `<div class="m-setup"><button type="button" class="btn" data-setup>${st.setupDone && st.setupDone[m.id] ? 'Preparar de novo' : 'Preparar cenário'}</button><span>cria os recursos quebrados desta missão</span></div>`;
        html += `<div class="m-progress small"><div class="m-bar"><i style="width:${Math.round((n / m.tasks.length) * 100)}%"></i></div><span>${n}/${m.tasks.length}</span></div>`;
        html += '<ol class="m-tasks">';
        m.tasks.forEach((t, i) => {
          const ok = r[i];
          const hk = `${m.id}:${i}`;
          html += `<li class="${ok ? 'ok' : ''}"><span class="m-check" aria-label="${ok ? 'concluído' : 'pendente'}">${ok ? '✓' : ''}</span><div class="m-body"><p>${esc(t.text)}</p>`;
          if (!ok) {
            html += `<div class="m-help"><button type="button" class="link" data-hint="${hk}">${st.hints[hk] ? 'Ocultar dica' : 'Dica'}</button><button type="button" class="link" data-sol="${hk}">${st.sols[hk] ? 'Ocultar solução' : 'Solução'}</button></div>`;
            if (st.hints[hk]) html += `<p class="m-hint">${esc(t.hint)}</p>`;
            if (st.sols[hk]) html += `<button type="button" class="m-sol" data-insert="${esc(t.sol)}" title="Clique para colocar no terminal"><code>${esc(t.sol)}</code><span>colocar no terminal</span></button>`;
          }
          html += '</div></li>';
        });
        html += '</ol>';
        if (n === m.tasks.length) {
          const next = M.slice(idx + 1).find((x) => !st.done[x.id]) || M.find((x) => !st.done[x.id]);
          html += `<div class="m-done"><strong>Missão concluída.</strong>${next ? ` <button type="button" class="btn primary" data-open="${next.id}">Próxima: ${esc(next.title)}</button>` : ' Você terminou todas as missões.'}</div>`;
          if (m.cleanup) html += `<button type="button" class="link m-clean" data-cleanup>Remover os recursos do cenário</button>`;
        }
      }
      if (html !== last) { view.innerHTML = html; last = html; }
      $('#tab-missions .count').textContent = `${doneCount}/${M.length}`;
    };
    const tick = () => {
      if (st.active && byId[st.active]) {
        const m = byId[st.active];
        const r = evalMission(m);
        results[m.id] = r;
        if (r.every(Boolean) && !st.done[m.id]) {
          st.done[m.id] = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
          save();
          toast(`Missão concluída: ${m.title}`);
        }
      }
      render();
    };
    view.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.open) { st.active = b.dataset.open; save(); last = ''; tick(); view.scrollTop = 0; $('.panel').scrollTop = 0; }
      else if (b.hasAttribute('data-back')) { st.active = null; save(); last = ''; render(); }
      else if (b.dataset.hint) { st.hints[b.dataset.hint] = !st.hints[b.dataset.hint]; save(); render(); }
      else if (b.dataset.sol) { st.sols[b.dataset.sol] = !st.sols[b.dataset.sol]; save(); render(); }
      else if (b.dataset.insert !== undefined) {
        if (b.dataset.insert.includes('\n')) pasteMulti(term, b.dataset.insert);
        else term.insert(b.dataset.insert);
      }
      else if (b.hasAttribute('data-setup')) {
        const m = byId[st.active];
        for (const [id, ns, name] of m.cleanup || []) { const o = term.cluster.raw(S.byId(id), ns, name); if (o) term.cluster.removeRaw(S.byId(id), o); }
        try { m.setup(term); toast('Cenário preparado. Investigue pelo terminal.'); } catch (err) { toast(`Não foi possível preparar: ${err.message}`); }
        st.setupDone = st.setupDone || {};
        st.setupDone[m.id] = true;
        save();
        render();
      } else if (b.hasAttribute('data-cleanup')) {
        const m = byId[st.active];
        for (const [id, ns, name] of m.cleanup || []) { try { term.cluster.delete(S.byId(id), ns, name, {}, SYSTEM); } catch (err) { /* já removido */ } }
        toast('Recursos do cenário removidos.');
      }
    });
    // abas
    const tabs = [['tab-missions', 'view-missions'], ['tab-cluster', 'view-cluster']];
    const show = (tabId) => {
      for (const [t, v] of tabs) {
        const on = t === tabId;
        $('#' + t).setAttribute('aria-selected', on ? 'true' : 'false');
        $('#' + v).hidden = !on;
      }
      try { localStorage.setItem('ks-tab', tabId); } catch (e) { /* */ }
    };
    for (const [t] of tabs) $('#' + t).addEventListener('click', () => show(t));
    let saved = null;
    try { saved = localStorage.getItem('ks-tab'); } catch (e) { saved = null; }
    show(saved === 'tab-cluster' ? 'tab-cluster' : 'tab-missions');
    tick();
    setInterval(tick, 1000);
  }
  // soluções com várias linhas (heredoc) vão direto para o terminal como colagem
  function pasteMulti(term, text) {
    term.input.value = '';
    const lines = text.split('\n');
    (async () => {
      for (const l of lines) {
        while (term.busy && !term.sessions.length && !term.lineWaiter) await U.sleep(40);
        await term.submit(l);
      }
    })();
  }
  KS.missions = M;
  KS.missionHelpers = mk;
  if (typeof document === 'undefined') return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
