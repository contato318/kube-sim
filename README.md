# kube-sim

Um cluster Kubernetes v1.31 simulado inteiramente no navegador, com um terminal onde o `kubectl` se comporta como num cluster real, e 23 missões guiadas para aprender Kubernetes na prática.

Não há backend, container ou máquina virtual: o API server, os controllers, o scheduler, o kubelet e a rede do cluster são simulados em JavaScript. Tudo roda na página e o estado fica salvo no navegador.

## Como usar

Abra o `index.html` no navegador. Não precisa de servidor nem de build.

A página carrega duas coisas da internet: a biblioteca [js-yaml](https://github.com/nodeca/js-yaml) (pelo cdnjs) e as fontes IBM Plex (pelo Google Fonts). Sem conexão, o terminal não consegue ler YAML.

Ao abrir, você está no nó de control plane de um cluster com três nós (`sim-control-plane`, `sim-worker` e `sim-worker2`), com o `kubectl` já configurado no contexto `kind-sim`. Digite `help` para ver sugestões de comandos.

```bash
kubectl get nodes -o wide
kubectl apply -f examples/nginx-deployment.yaml
kubectl get pods -w                         # Ctrl+C para parar
kubectl exec -it deploy/nginx-deployment -- bash
kubectl port-forward svc/nginx 8080:80 &
curl localhost:8080
```

Atalhos do terminal: `Tab` completa comandos, recursos e nomes; `↑`/`↓` navegam no histórico; `Ctrl+C` interrompe; `Ctrl+L` limpa a tela; `Ctrl+D` sai de um shell dentro de container.

Para recomeçar do zero, use o botão **Recriar cluster** ou o comando `reset-cluster`.

## Missões

A aba **Missões** do painel lateral traz 23 missões em cinco níveis:

| Nível | Missões |
|---|---|
| Básico | Conheça o cluster · Seu primeiro Pod · Labels e seletores |
| Aplicações | Deployments e réplicas · Services e DNS · Rolling update e rollback · YAML declarativo |
| Configuração e acesso | ConfigMaps e Secrets · Namespaces e contexto · RBAC com ServiceAccount · Probes e recursos |
| Troubleshooting | O deploy que não sobe · Banco em CrashLoopBackOff · Service sem destino · Pod preso em Pending |
| Operação do cluster | Jobs e CronJobs · Volumes persistentes · Taints e tolerations · Manutenção de nó · Autoscaling · NetworkPolicy · Ingress por host · Scheduler quebrado |

Cada missão tem objetivos que o simulador confere sozinho, a cada segundo, olhando o estado do cluster e os comandos digitados. Cada objetivo tem uma dica e uma solução; clicar na solução coloca o comando no terminal.

As missões marcadas como **cenário** têm o botão **Preparar cenário**, que cria um problema no cluster para o aluno investigar e corrigir: uma imagem com erro de digitação, um banco sem a variável de senha, um Service com seletor errado, um Pod que pede CPU demais ou um manifesto do `kube-scheduler` quebrado.

## O que é simulado

**kubectl.** `get` (com `-o yaml`, `json`, `wide`, `name`, `jsonpath`, `custom-columns` e `go-template`, além de `-w`, `--sort-by`, `-l`, `--field-selector` e `-A`), `describe`, `create` e seus subcomandos, `apply` (inclusive `-k`, `--prune` e `--server-side`), `delete`, `edit`, `patch` (strategic, merge e JSON patch), `replace`, `label`, `annotate`, `scale`, `autoscale`, `expose`, `run`, `set`, `rollout`, `logs`, `exec`, `attach`, `port-forward`, `proxy`, `cp`, `top`, `cordon`, `uncordon`, `drain`, `taint`, `certificate`, `cluster-info`, `api-resources`, `api-versions`, `explain`, `config`, `version`, `auth`, `wait`, `diff`, `debug`, `events` e `kustomize`. As saídas e as mensagens de erro seguem o formato do kubectl real.

**API.** Todos os tipos nativos aceitam CRUD, e a API REST responde em `/api`, `/apis`, `/healthz`, `/version` e nos caminhos de cada recurso (`kubectl get --raw`, `kubectl proxy` + `curl` ou `curl` com token). Há admissão com defaults, validação e mensagens de campo inválido, campos imutáveis, ResourceQuota, LimitRange, RBAC com impersonação (`--as`) e CRDs que viram tipos novos na hora.

**Controllers e nós.**
- Deployments com rolling update, histórico e rollback.
- ReplicaSets, StatefulSets com DNS por Pod, DaemonSets, Jobs, CronJobs e HPA.
- Garbage collector, Endpoints e EndpointSlices, e PVCs provisionados dinamicamente pela StorageClass padrão.
- Scheduler com taints, afinidade, anti-afinidade, recursos, topology spread e preempção.
- Kubelet com pull de imagem, `ImagePullBackOff`, `CrashLoopBackOff`, `OOMKilled`, probes, init containers e encerramento gracioso.

**Rede.** DNS do cluster, Services (ClusterIP, NodePort, LoadBalancer e headless), NetworkPolicy, `ingress-nginx` respondendo em `localhost:80`, `port-forward`, e `curl`, `wget` e `nslookup` de dentro dos Pods.

**Control plane.** O terminal é o nó de control plane. Os componentes rodam como Pods estáticos definidos em `/etc/kubernetes/manifests`; editar um desses arquivos recria o Pod, e quebrar o do API server, do scheduler ou do controller-manager para o componente correspondente.

**Shell.** Pipes, redirecionamentos, heredoc, `$(...)`, `&&`, `||`, `for`, `while`, `if`, variáveis, aliases e jobs em background (`&`, `jobs`, `kill`, `fg`). Há um sistema de arquivos virtual com os exemplos em `~/examples`, um editor (`vi`, que também é usado pelo `kubectl edit`) e utilitários como `grep`, `awk`, `sed`, `jq`, `base64`, `watch`, `openssl` e `crictl`.

## Limitações

- O kubectl real tem centenas de flags e comportamentos de borda; alguns casos raros podem ter diferenças.
- As imagens seguem um catálogo de imagens conhecidas (nginx, busybox, redis, postgres, mysql e outras). Uma imagem fora dele se comporta como um servidor genérico.
- Dentro dos containers existe um conjunto limitado de comandos, e o shell interativo do Pod não tem editor.
- A saída de um comando redirecionado para arquivo só é gravada quando o comando termina.
- `kubectl explain` cobre os tipos principais, não o schema OpenAPI completo.

## Estrutura

```
index.html            página, painel lateral e editor
css/style.css         estilos
js/
  util.js             tempo, quantidades, seletores, JSONPath, patches, tabwriter, diff, cron
  schema.js           tipos da API (discovery) e documentação do explain
  sh.js               lexer, parser e expansão de palavras do shell
  images.js           catálogo de imagens e simulação dos processos dos containers
  cluster.js          API server: armazenamento, admissão, validação, RBAC e REST
  controllers.js      controllers, scheduler, kubelet, rede, métricas, logs e bootstrap
  printers.js         tabelas, describe, YAML e JSON no formato do kubectl
  kubectl.js          parser de flags e comandos de recursos
  kubectl2.js         comandos de depuração, config, auth, explain, wait, diff e kustomize
  examples.js         manifestos em ~/examples
  shell.js            shell do terminal, shell dos Pods e sistema de arquivos virtual
  terminal.js         interface do terminal, editor, painel do cluster e persistência
  missions.js         missões guiadas
```

Os scripts usam um namespace global (`KS`) e são carregados na ordem acima pelo `index.html`. Não há dependências além do js-yaml.

O tempo do cluster é o relógio real. `terminal.js` chama `cluster.tick()` a cada 500 ms, e cada tick roda os controllers, o scheduler e o kubelet. Ao iniciar, o cluster é criado com 47 minutos de idade, com os Pods de sistema já rodando.

O estado é salvo no `localStorage` do navegador:
- `ks-state-v1`: cluster, arquivos e histórico;
- `ks-missions-v1`: progresso das missões.

## Criar uma missão

Acrescente um objeto ao array `M` em `js/missions.js`:

```js
{
  id: 'minha-missao',
  level: 'basico',          // basico | workloads | config | trouble | avancado
  title: 'Título curto',
  intro: 'O que o aluno vai aprender e por quê.',
  setup: (term) => { /* opcional: cria um cenário quebrado */ },
  cleanup: [['deployments.apps', 'default', 'nome']], // opcional
  tasks: [
    {
      text: 'Objetivo visível para o aluno',
      check: (h) => h.available('default', 'nome', 1), // true quando cumprido
      hint: 'Dica sem entregar o comando',
      sol: 'kubectl ...',
    },
  ],
}
```

O objeto `h` recebido pelas checagens tem, entre outros:

| Helper | Retorna |
|---|---|
| `h.obj(tipo, ns, nome)` | objeto do cluster |
| `h.pods(ns, seletor)` | Pods que casam com o seletor |
| `h.running(ns, nome)` | Pod rodando e pronto |
| `h.available(ns, deploy, n)` | Deployment com `n` réplicas disponíveis |
| `h.eps(ns, svc)` | endereços dos endpoints do Service |
| `h.ran(regex)` | se algum comando digitado casa com a regex |
| `h.can(user, groups, atributos)` | decisão do RBAC |
| `h.ns()` | namespace do contexto atual |

## Testes

O núcleo roda também no Node, sem o navegador. Para testar, carregue os scripts em ordem, definindo antes `globalThis.jsyaml = require('js-yaml')`. Depois crie o cluster e o shell:

```js
const cluster = new KS.Cluster();
const vfs = new KS.VFS();
KS.bootstrapFS(vfs, cluster);
const sh = new KS.HostShell({ cluster, fs: vfs, term: { clear() {}, editor: async () => null, interactive: async () => 0, readLine: async () => '' } });
setInterval(() => cluster.tick(), 100);
await sh.runLine('kubectl get pods -A', { out: console.log, err: console.log, stdin: null, signal: { aborted: false } });
```

As soluções de todas as missões foram executadas assim e passaram nas respectivas checagens.
