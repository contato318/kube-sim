// Catálogo de imagens e simulação do processo principal dos containers
// (logs, tempo de saída, código de saída, arquivos criados, portas e consumo).
(function () {
  const KS = (globalThis.KS = globalThis.KS || {});
  const U = KS.util;
  const SH = KS.sh;
  const IM = (KS.images = {});

  // ---------------- referência de imagem ----------------
  IM.parseRef = (image) => {
    let s = String(image || '');
    let digest = null;
    if (s.includes('@')) [s, digest] = s.split('@');
    let tag = null;
    const lastSlash = s.lastIndexOf('/');
    const colon = s.lastIndexOf(':');
    if (colon > lastSlash) { tag = s.slice(colon + 1); s = s.slice(0, colon); }
    let registry = 'docker.io', path = s;
    const first = s.split('/')[0];
    if (s.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
      registry = first;
      path = s.slice(first.length + 1);
    }
    if (registry === 'docker.io' && !path.includes('/')) path = 'library/' + path;
    const name = path.split('/').pop();
    const t = tag || (digest ? null : 'latest');
    return { registry, path, name, tag: t, digest, full: `${registry}/${path}${t ? ':' + t : ''}${digest ? '@' + digest : ''}` };
  };

  const BUSYBOX = 'echo printf sleep date hostname cat touch rm mkdir rmdir env printenv true false exit seq expr test [ [[ wget nslookup ping ls ps sh ash whoami id pwd cd head tail grep egrep sed awk wc sort uniq cut tr tee df du free uptime uname kill killall mount find base64 nc telnet ip ifconfig netstat route top watch xargs yes which vi md5sum sha256sum stat ln cp mv chmod chown hexdump od dd gzip gunzip tar less more clear reset nproc arp traceroute sync basename dirname readlink realpath timeout nohup time usleep hwclock dmesg su httpd'.split(' ');
  const COREUTILS = 'echo printf sleep date hostname cat touch rm mkdir rmdir env printenv true false exit seq expr test [ [[ ls pwd cd head tail grep egrep sed awk wc sort uniq cut tr tee df du uname kill mount find base64 id whoami stat ln cp mv chmod chown dd gzip gunzip tar xargs yes md5sum sha256sum bash sh which nproc basename dirname readlink realpath timeout nohup more clear sync apt-get apt dpkg'.split(' ');
  const NETTOOLS = 'curl wget ping nslookup dig host nc telnet ip ifconfig netstat ss traceroute ps top free vi vim less tcpdump iperf3 jq'.split(' ');
  const ALPINE = [...BUSYBOX, 'apk'];

  const OFFICIAL = new Set(('nginx httpd redis postgres mysql mariadb mongo rabbitmq memcached busybox alpine ubuntu debian centos fedora rockylinux almalinux amazonlinux archlinux oraclelinux python node ruby golang openjdk eclipse-temurin amazoncorretto php perl rust gcc bash hello-world wordpress ghost tomcat jetty elasticsearch kibana logstash haproxy traefik caddy consul vault influxdb nextcloud joomla drupal adminer phpmyadmin mongo-express registry zookeeper cassandra couchdb neo4j sonarqube nats solr percona telegraf chronograf kapacitor docker jenkins maven gradle flink spark eclipse-mosquitto couchbase arangodb rethinkdb varnish clojure elixir erlang haskell julia r-base swift dart groovy pypy mono buildpack-deps photon ros matomo odoo redmine mediawiki xwiki yourls rocket.chat emqx kong krakend unit postfixadmin friendica plone backdrop geonetwork api-firewall irssi znc tomee open-liberty websphere-liberty jruby satosa lightstreamer silverpeas convertigo teamspeak nats-streaming storm spiped sapmachine ibm-semeru-runtimes ibmjava bonita monica fluentd kibana memcached').split(' '));

  // perfis: base, portas, consumo (mCPU, MiB), tamanho, comportamento
  const P = (o) => Object.assign({ base: 'debian', ports: [], cpu: 1, mem: 8, size: 50, server: true }, o);
  const CAT = {
    nginx: P({ ports: [80], cpu: 0, mem: 4, size: 72, http: 'nginx', logs: 'nginx', extra: ['curl'], version: '1.27.1' }),
    httpd: P({ ports: [80], cpu: 1, mem: 9, size: 58, http: 'httpd', logs: 'httpd' }),
    redis: P({ ports: [6379], cpu: 2, mem: 4, size: 45, logs: 'redis', proto: 'redis' }),
    postgres: P({ ports: [5432], cpu: 2, mem: 28, size: 158, logs: 'postgres', needEnv: ['POSTGRES_PASSWORD', 'POSTGRES_HOST_AUTH_METHOD'], proto: 'pg' }),
    mysql: P({ base: 'rhel', ports: [3306, 33060], cpu: 6, mem: 380, size: 186, logs: 'mysql', needEnv: ['MYSQL_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD', 'MYSQL_RANDOM_ROOT_PASSWORD'], proto: 'mysql' }),
    mariadb: P({ ports: [3306], cpu: 3, mem: 95, size: 120, logs: 'mariadb', needEnv: ['MARIADB_ROOT_PASSWORD', 'MARIADB_ALLOW_EMPTY_ROOT_PASSWORD', 'MARIADB_RANDOM_ROOT_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_ALLOW_EMPTY_PASSWORD', 'MYSQL_RANDOM_ROOT_PASSWORD'], proto: 'mysql' }),
    mongo: P({ base: 'ubuntu', ports: [27017], cpu: 5, mem: 160, size: 290, logs: 'mongo', proto: 'mongo' }),
    rabbitmq: P({ base: 'ubuntu', ports: [5672, 15672], cpu: 4, mem: 110, size: 95, logs: 'rabbitmq' }),
    memcached: P({ ports: [11211], cpu: 1, mem: 2, size: 30 }),
    busybox: P({ base: 'busybox', server: false, shell: 'sh', size: 2.2, mem: 0.4, cpu: 0 }),
    alpine: P({ base: 'alpine', server: false, shell: 'sh', size: 3.6, mem: 0.4, cpu: 0 }),
    ubuntu: P({ base: 'ubuntu', server: false, shell: 'bash', size: 29, mem: 0.6, cpu: 0 }),
    debian: P({ server: false, shell: 'bash', size: 49, mem: 0.6, cpu: 0 }),
    centos: P({ base: 'rhel', server: false, shell: 'bash', size: 79, mem: 0.6, cpu: 0 }),
    fedora: P({ base: 'rhel', server: false, shell: 'bash', size: 60, mem: 0.6, cpu: 0 }),
    rockylinux: P({ base: 'rhel', server: false, shell: 'bash', size: 70, mem: 0.6, cpu: 0 }),
    almalinux: P({ base: 'rhel', server: false, shell: 'bash', size: 70, mem: 0.6, cpu: 0 }),
    amazonlinux: P({ base: 'rhel', server: false, shell: 'bash', size: 55, mem: 0.6, cpu: 0 }),
    python: P({ server: false, repl: 'python3', shell: 'bash', extra: ['curl', 'wget', 'python', 'python3', 'pip'], size: 370, mem: 7, cpu: 0 }),
    node: P({ server: false, repl: 'node', shell: 'bash', extra: ['curl', 'wget', 'node', 'npm'], size: 380, mem: 20, cpu: 0 }),
    ruby: P({ server: false, repl: 'irb', shell: 'bash', extra: ['curl', 'wget', 'ruby'], size: 350, mem: 10, cpu: 0 }),
    golang: P({ server: false, shell: 'bash', extra: ['curl', 'wget', 'go'], size: 300, mem: 1, cpu: 0 }),
    openjdk: P({ server: false, repl: 'jshell', shell: 'bash', extra: ['java'], size: 250, mem: 30, cpu: 0 }),
    'eclipse-temurin': P({ base: 'ubuntu', server: false, repl: 'jshell', shell: 'bash', extra: ['java', 'curl'], size: 200, mem: 30, cpu: 0 }),
    php: P({ server: false, repl: 'php', shell: 'bash', extra: ['php'], size: 190, mem: 8, cpu: 0 }),
    perl: P({ server: false, repl: 'perl', shell: 'bash', extra: ['perl', 'curl', 'wget'], size: 330, mem: 3, cpu: 0 }),
    'hello-world': P({ base: 'scratch', server: false, oneshot: 'hello', size: 0.01, mem: 0.2, cpu: 0 }),
    'hpa-example': P({ ports: [80], cpu: 1, mem: 11, size: 180, http: 'php-ok', logs: 'httpd', cpuPerClient: 600 }),
    'http-echo': P({ base: 'scratch', ports: [5678], cpu: 0, mem: 2, size: 4, http: 'echo-text', logs: 'http-echo', entry: 'http-echo' }),
    echoserver: P({ ports: [8080], cpu: 0, mem: 3, size: 46, http: 'echoserver' }),
    'hello-app': P({ base: 'scratch', ports: [8080], cpu: 0, mem: 3, size: 11, http: 'hello-app', logs: 'hello-app' }),
    agnhost: P({ ports: [8080], cpu: 1, mem: 6, size: 60, http: 'agnhost' }),
    curl: P({ base: 'alpine', server: false, entry: 'curl', extra: ['curl'], size: 12, mem: 0.3, cpu: 0 }),
    netshoot: P({ base: 'alpine', server: false, shell: 'zsh', extra: NETTOOLS.concat(['zsh', 'bash']), size: 200, mem: 1, cpu: 0 }),
    dnsutils: P({ base: 'debian', server: false, shell: 'sh', extra: ['nslookup', 'dig', 'host'], size: 60, mem: 0.5, cpu: 0 }),
    pause: P({ base: 'scratch', ports: [], cpu: 0, mem: 0.3, size: 0.3 }),
    stress: P({ base: 'ubuntu', server: false, entry: 'stress', extra: ['stress'], size: 10, mem: 0.3, cpu: 0 }),
    wordpress: P({ ports: [80], cpu: 1, mem: 25, size: 250, http: 'wordpress', logs: 'httpd' }),
    ghost: P({ ports: [2368], cpu: 2, mem: 120, size: 190 }),
    tomcat: P({ ports: [8080], cpu: 3, mem: 140, size: 180, http: 'tomcat' }),
    jenkins: P({ ports: [8080, 50000], cpu: 8, mem: 450, size: 280, logs: 'jenkins' }),
    grafana: P({ base: 'alpine', ports: [3000], cpu: 2, mem: 60, size: 140, http: 'grafana' }),
    prometheus: P({ base: 'busybox', ports: [9090], cpu: 5, mem: 55, size: 110, http: 'prometheus' }),
    elasticsearch: P({ base: 'ubuntu', ports: [9200, 9300], cpu: 20, mem: 1100, size: 600 }),
    kibana: P({ base: 'ubuntu', ports: [5601], cpu: 10, mem: 420, size: 400 }),
    traefik: P({ base: 'alpine', ports: [80, 8080], cpu: 1, mem: 30, size: 50 }),
    caddy: P({ base: 'alpine', ports: [80, 443], cpu: 0, mem: 12, size: 20, http: 'caddy' }),
    haproxy: P({ ports: [80], cpu: 1, mem: 8, size: 40 }),
    consul: P({ base: 'alpine', ports: [8500, 8600], cpu: 5, mem: 40, size: 70 }),
    vault: P({ base: 'alpine', ports: [8200], cpu: 3, mem: 60, size: 150 }),
    etcd: P({ base: 'scratch', ports: [2379, 2380], cpu: 15, mem: 45, size: 22, logs: 'etcd' }),
    minio: P({ ports: [9000, 9001], cpu: 2, mem: 90, size: 60 }),
    registry: P({ base: 'alpine', ports: [5000], cpu: 0, mem: 8, size: 10 }),
    zookeeper: P({ ports: [2181], cpu: 3, mem: 70, size: 120 }),
    kafka: P({ ports: [9092], cpu: 8, mem: 350, size: 330 }),
    cassandra: P({ ports: [9042], cpu: 12, mem: 900, size: 150 }),
    adminer: P({ ports: [8080], cpu: 0, mem: 9, size: 40 }),
    // componentes do sistema
    coredns: P({ base: 'scratch', ports: [53, 9153], cpu: 3, mem: 14, size: 18, logs: 'coredns', proto: 'dns' }),
    'kube-apiserver': P({ base: 'scratch', ports: [6443], cpu: 45, mem: 280, size: 29, logs: 'apiserver' }),
    'kube-controller-manager': P({ base: 'scratch', ports: [10257], cpu: 14, mem: 55, size: 27, logs: 'kcm' }),
    'kube-scheduler': P({ base: 'scratch', ports: [10259], cpu: 3, mem: 22, size: 19, logs: 'sched' }),
    'kube-proxy': P({ base: 'debian', ports: [10249], cpu: 1, mem: 15, size: 30, logs: 'kube-proxy' }),
    kindnetd: P({ base: 'scratch', ports: [], cpu: 1, mem: 10, size: 36, logs: 'kindnet' }),
    'local-path-provisioner': P({ base: 'scratch', ports: [], cpu: 1, mem: 9, size: 17, logs: 'local-path' }),
    'metrics-server': P({ base: 'scratch', ports: [10250], cpu: 4, mem: 20, size: 19, logs: 'metrics-server' }),
    'ingress-nginx-controller': P({ ports: [80, 443], cpu: 2, mem: 90, size: 105, http: 'ingress' }),
    controller: P({ ports: [80, 443], cpu: 2, mem: 90, size: 105, http: 'ingress' }),
  };
  IM.catalog = CAT;

  IM.profile = (image) => {
    const ref = IM.parseRef(image);
    let p = CAT[ref.name];
    if (!p && /stress/.test(ref.name)) p = CAT.stress;
    if (!p && /nginx/.test(ref.name)) p = CAT.nginx;
    if (!p && /echo/.test(ref.name)) p = CAT.echoserver;
    const known = !!p;
    p = Object.assign({}, p || P({ ports: [], generic: true, cpu: 1, mem: 12, size: 40 }));
    p.ref = ref;
    p.known = known;
    let tools;
    if (p.base === 'busybox') tools = BUSYBOX;
    else if (p.base === 'alpine') tools = ALPINE;
    else if (p.base === 'scratch') tools = [];
    else tools = COREUTILS;
    p.tools = new Set([...tools, ...(p.extra || [])]);
    if (!p.shell) p.shell = p.base === 'scratch' ? null : p.base === 'busybox' || p.base === 'alpine' ? 'sh' : 'bash';
    if (p.shell === 'zsh') p.tools.add('zsh');
    p.sizeBytes = Math.round(p.size * 1024 * 1024);
    return p;
  };

  // ---------------- validade / pull ----------------
  const BAD = /(^|[-_.:/])(doesnotexist|does-not-exist|notexist|not-exist|nonexist\w*|non-existent|invalid|wrong|fake|bad|missing|typo|xxx|404|unknown)([-_.:/]|$)/i;
  IM.pullCheck = (image, { hasPullSecret } = {}) => {
    if (!image || !image.trim()) return { reason: 'InvalidImageName', message: 'Failed to apply default image tag "": couldn\'t parse image name "": invalid reference format' };
    if (/[A-Z\s]/.test(image.split('@')[0].split('/').slice(0, -1).join('/') + '/' + IM.parseRef(image).path) || /\s/.test(image)) {
      const ref = IM.parseRef(image);
      return {
        reason: 'InvalidImageName',
        message: `Failed to apply default image tag "${image}": couldn't parse image name "${image}": invalid reference format: repository name (${ref.path}) must be lowercase`,
      };
    }
    if (!/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(image) || /::|\/\/|:$/.test(image)) {
      return { reason: 'InvalidImageName', message: `Failed to apply default image tag "${image}": couldn't parse image name "${image}": invalid reference format` };
    }
    const ref = IM.parseRef(image);
    const full = ref.full;
    const notFound = () => ({
      reason: 'ErrImagePull',
      message: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": ${full}: not found`,
      code: 'NotFound',
    });
    const denied = () => ({
      reason: 'ErrImagePull',
      message: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": pull access denied, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed`,
      code: 'Unknown',
    });
    if (ref.tag && BAD.test(':' + ref.tag)) return notFound();
    if (BAD.test('/' + ref.path)) return denied();
    if (ref.tag && /^\d+/.test(ref.tag) && ref.tag.split(/[.\-]/).some((x) => /^\d+$/.test(x) && Number(x) > 200)) return notFound();
    if (ref.registry === 'docker.io') {
      if (ref.path.startsWith('library/') && !OFFICIAL.has(ref.name) && !CAT[ref.name]) return denied();
      return null;
    }
    const PUBLIC = ['registry.k8s.io', 'k8s.gcr.io', 'gcr.io', 'quay.io', 'ghcr.io', 'public.ecr.aws', 'mcr.microsoft.com', 'docker.elastic.co', 'nvcr.io', 'us-docker.pkg.dev', 'europe-docker.pkg.dev', 'registry.gitlab.com', 'docker.io', 'index.docker.io'];
    if (PUBLIC.some((r) => ref.registry === r || ref.registry.endsWith('.' + r))) return null;
    if (hasPullSecret) return null;
    if (/localhost|127\.0\.0\.1|\.local$|\.internal$|\.lan$|\.corp$|example\.(com|org)$/.test(ref.registry)) {
      return {
        reason: 'ErrImagePull',
        message: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": failed to do request: Head "https://${ref.registry}/v2/${ref.path}/manifests/${ref.tag}": dial tcp: lookup ${ref.registry.split(':')[0]}: no such host`,
        code: 'Unknown',
      };
    }
    return {
      reason: 'ErrImagePull',
      message: `failed to pull and unpack image "${full}": failed to resolve reference "${full}": failed to authorize: failed to fetch anonymous token: unexpected status from GET request to https://${ref.registry}/token?scope=repository%3A${encodeURIComponent(ref.path)}%3Apull: 401 Unauthorized`,
      code: 'Unknown',
    };
  };
  IM.pullSeconds = (image) => {
    const p = IM.profile(image);
    return Math.min(9, 0.6 + p.size / 60 + U.seeded(image) * 1.2);
  };
  IM.digest = (image) => {
    let h = '';
    let seed = image;
    for (let i = 0; i < 8; i++) { seed = String(U.fnv(seed + i)); h += U.fnv(seed).toString(16).padStart(8, '0'); }
    return h.slice(0, 64);
  };
  IM.imageID = (image) => {
    const ref = IM.parseRef(image);
    return `${ref.registry}/${ref.path}@sha256:${IM.digest(ref.registry + '/' + ref.path + ':' + ref.tag)}`;
  };

  // ---------------- logs de inicialização ----------------
  const hhmmss = (t) => new Date(t).toISOString().replace('T', ' ').replace('Z', '');
  const klog = (t, lvl, file, msg) => {
    const d = new Date(t);
    const p2 = (n) => String(n).padStart(2, '0');
    return `${lvl}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}${String(Math.floor(U.seeded(msg) * 1000)).padStart(3, '0')}       1 ${file}] ${msg}`;
  };
  const redisTime = (t) => {
    const d = new Date(t);
    const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(d.getUTCDate()).padStart(2, '0')} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()} ${d.toISOString().slice(11, 23)}`;
  };
  IM.startupLogs = (p, ctx, t0) => {
    const L = [];
    const at = (dt, line) => L.push({ t: dt, line });
    const nt = U.nginxTime(t0);
    switch (p.logs) {
      case 'nginx':
        [
          '/docker-entrypoint.sh: /docker-entrypoint.d/ is not empty, will attempt to perform configuration',
          '/docker-entrypoint.sh: Looking for shell scripts in /docker-entrypoint.d/',
          '/docker-entrypoint.sh: Launching /docker-entrypoint.d/10-listen-on-ipv6-by-default.sh',
          '10-listen-on-ipv6-by-default.sh: info: Getting the checksum of /etc/nginx/conf.d/default.conf',
          '10-listen-on-ipv6-by-default.sh: info: Enabled listen on IPv6 in /etc/nginx/conf.d/default.conf',
          '/docker-entrypoint.sh: Sourcing /docker-entrypoint.d/15-local-resolvers.envsh',
          '/docker-entrypoint.sh: Launching /docker-entrypoint.d/20-envsubst-on-templates.sh',
          '/docker-entrypoint.sh: Launching /docker-entrypoint.d/30-tune-worker-processes.sh',
          '/docker-entrypoint.sh: Configuration complete; ready for start up',
          `${nt} [notice] 1#1: using the "epoll" event method`,
          `${nt} [notice] 1#1: nginx/${p.version || '1.27.1'}`,
          `${nt} [notice] 1#1: built by gcc 12.2.0 (Debian 12.2.0-14) `,
          `${nt} [notice] 1#1: OS: Linux 6.10.14-linuxkit`,
          `${nt} [notice] 1#1: getrlimit(RLIMIT_NOFILE): 1048576:1048576`,
          `${nt} [notice] 1#1: start worker processes`,
          `${nt} [notice] 1#1: start worker process 29`,
          `${nt} [notice] 1#1: start worker process 30`,
          `${nt} [notice] 1#1: start worker process 31`,
          `${nt} [notice] 1#1: start worker process 32`,
        ].forEach((l, i) => at(i < 9 ? 0.01 * i : 0.1, l));
        break;
      case 'httpd': {
        const d = new Date(t0);
        const ts = `[${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, '0')} ${d.toISOString().slice(11, 19)}.${String(Math.floor(U.seeded(ctx.podName) * 999999)).padStart(6, '0')} ${d.getUTCFullYear()}]`;
        at(0, `AH00558: ${p.http === 'php-ok' || p.http === 'wordpress' ? 'apache2' : 'httpd'}: Could not reliably determine the server's fully qualified domain name, using ${ctx.podIP || '10.244.1.2'}. Set the 'ServerName' directive globally to suppress this message`);
        at(0, `AH00558: ${p.http === 'php-ok' || p.http === 'wordpress' ? 'apache2' : 'httpd'}: Could not reliably determine the server's fully qualified domain name, using ${ctx.podIP || '10.244.1.2'}. Set the 'ServerName' directive globally to suppress this message`);
        if (p.http === 'php-ok' || p.http === 'wordpress') {
          at(0.1, `${ts} [mpm_prefork:notice] [pid 1] AH00163: Apache/2.4.10 (Debian) PHP/5.6.14 configured -- resuming normal operations`);
          at(0.1, `${ts} [core:notice] [pid 1] AH00094: Command line: 'apache2 -D FOREGROUND'`);
        } else {
          at(0.1, `${ts} [mpm_event:notice] [pid 1:tid 1] AH00489: Apache/2.4.62 (Unix) configured -- resuming normal operations`);
          at(0.1, `${ts} [core:notice] [pid 1:tid 1] AH00094: Command line: 'httpd -D FOREGROUND'`);
        }
        break;
      }
      case 'redis': {
        const rt = redisTime(t0);
        at(0, `1:C ${rt} # WARNING Memory overcommit must be enabled! Without it, a background save or replication may fail under low memory condition. Being disabled, it can also cause failures without low memory condition, see https://github.com/jemalloc/jemalloc/issues/1328. To fix this issue add 'vm.overcommit_memory = 1' to /etc/sysctl.conf and then reboot or run the command 'sysctl vm.overcommit_memory=1' for this to take effect.`);
        at(0, `1:C ${rt} * oO0OoO0OoO0Oo Redis is starting oO0OoO0OoO0Oo`);
        at(0, `1:C ${rt} * Redis version=7.4.0, bits=64, commit=00000000, modified=0, pid=1, just started`);
        at(0, `1:C ${rt} # Warning: no config file specified, using the default config. In order to specify a config file use redis-server /path/to/redis.conf`);
        at(0.01, `1:M ${rt} * monotonic clock: POSIX clock_gettime`);
        at(0.01, `1:M ${rt} * Running mode=standalone, port=6379.`);
        at(0.01, `1:M ${rt} * Server initialized`);
        at(0.01, `1:M ${rt} * Ready to accept connections tcp`);
        break;
      }
      case 'postgres': {
        const ts = (dt) => hhmmss(t0 + dt * 1000).slice(0, 23) + ' UTC';
        [
          'The files belonging to this database system will be owned by user "postgres".',
          'This user must also own the server process.',
          '',
          'The database cluster will be initialized with locale "en_US.utf8".',
          'The default database encoding has accordingly been set to "UTF8".',
          'The default text search configuration will be set to "english".',
          '',
          'Data page checksums are disabled.',
          '',
          'fixing permissions on existing directory /var/lib/postgresql/data ... ok',
          'creating subdirectories ... ok',
          'selecting dynamic shared memory implementation ... posix',
          'selecting default max_connections ... 100',
          'selecting default shared_buffers ... 128MB',
          'selecting default time zone ... Etc/UTC',
          'creating configuration files ... ok',
          'running bootstrap script ... ok',
          'performing post-bootstrap initialization ... ok',
          'syncing data to disk ... ok',
          '',
          '',
          'Success. You can now start the database server using:',
          '',
          '    pg_ctl -D /var/lib/postgresql/data -l logfile start',
          '',
          'initdb: warning: enabling "trust" authentication for local connections',
          'initdb: hint: You can change this by editing pg_hba.conf or using the option -A, or --auth-local and --auth-host, the next time you run initdb.',
          'waiting for server to start....' + ts(1.1) + ' [48] LOG:  starting PostgreSQL 16.4 (Debian 16.4-1.pgdg120+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit',
          'done',
          'server started',
          '',
          '/usr/local/bin/docker-entrypoint.sh: ignoring /docker-entrypoint-initdb.d/*',
          '',
          'waiting for server to shut down....done',
          'server stopped',
          '',
          'PostgreSQL init process complete; ready for start up.',
          '',
          `${ts(2)} [1] LOG:  starting PostgreSQL 16.4 (Debian 16.4-1.pgdg120+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit`,
          `${ts(2)} [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432`,
          `${ts(2)} [1] LOG:  listening on IPv6 address "::", port 5432`,
          `${ts(2)} [1] LOG:  listening on Unix socket "/var/run/postgresql/.s.PGSQL.5432"`,
          `${ts(2)} [62] LOG:  database system was shut down at ${hhmmss(t0 + 1900).slice(0, 19)} UTC`,
          `${ts(2)} [1] LOG:  database system is ready to accept connections`,
        ].forEach((l, i) => at(Math.min(2, i * 0.05), l));
        break;
      }
      case 'mysql': case 'mariadb': {
        const ts = (dt) => new Date(t0 + dt * 1000).toISOString().slice(0, 19).replace('T', ' ') + '+00:00';
        const iso = (dt) => new Date(t0 + dt * 1000).toISOString().replace(/Z$/, '000Z');
        const prod = p.logs === 'mysql' ? 'MySQL Server 9.0.1-1.el9' : 'MariaDB Server 1:11.5.2+maria~ubu2404';
        at(0, `${ts(0)} [Note] [Entrypoint]: Entrypoint script for ${prod} started.`);
        at(0.1, `${ts(0.1)} [Note] [Entrypoint]: Switching to dedicated user 'mysql'`);
        at(0.2, `${ts(0.2)} [Note] [Entrypoint]: Entrypoint script for ${prod} started.`);
        at(0.3, `${ts(0.3)} [Note] [Entrypoint]: Initializing database files`);
        if (p.logs === 'mysql') {
          at(3, `${iso(3)} 0 [System] [MY-015017] [Server] MySQL Server Initialization - start.`);
          at(8, `${ts(8)} [Note] [Entrypoint]: Database files initialized`);
          at(12, `${iso(12)} 0 [System] [MY-010931] [Server] /usr/sbin/mysqld: ready for connections. Version: '9.0.1'  socket: '/var/run/mysqld/mysqld.sock'  port: 3306  MySQL Community Server - GPL.`);
        } else {
          at(4, `${ts(4)} [Note] [Entrypoint]: Database files initialized`);
          at(6, `${ts(6)} 0 [Note] mariadbd: ready for connections.`);
          at(6, "Version: '11.5.2-MariaDB-ubu2404'  socket: '/run/mysqld/mysqld.sock'  port: 3306  mariadb.org binary distribution");
        }
        break;
      }
      case 'mongo':
        at(0, `{"t":{"$date":"${new Date(t0).toISOString()}"},"s":"I",  "c":"CONTROL",  "id":23285,   "ctx":"main","msg":"Automatically disabling TLS 1.0, to force-enable TLS 1.0 specify --sslDisabledProtocols 'none'"}`);
        at(0.2, `{"t":{"$date":"${new Date(t0 + 200).toISOString()}"},"s":"I",  "c":"NETWORK",  "id":23015,   "ctx":"listener","msg":"Listening on","attr":{"address":"0.0.0.0"}}`);
        at(0.3, `{"t":{"$date":"${new Date(t0 + 300).toISOString()}"},"s":"I",  "c":"NETWORK",  "id":23016,   "ctx":"listener","msg":"Waiting for connections","attr":{"port":27017,"ssl":"off"}}`);
        break;
      case 'rabbitmq':
        at(0, `${hhmmss(t0).slice(0, 23)}+00:00 [notice] <0.44.0> Application syslog exited with reason: stopped`);
        at(3, `${hhmmss(t0 + 3000).slice(0, 23)}+00:00 [info] <0.229.0>  Starting RabbitMQ 3.13.7 on Erlang 26.2.5.3 [jit]`);
        at(6, `${hhmmss(t0 + 6000).slice(0, 23)}+00:00 [info] <0.682.0> Server startup complete; 5 plugins started.`);
        break;
      case 'http-echo':
        at(0, `${U.nginxTime(t0)} [INFO] server is listening on :${ctx.listenPort || 5678}`);
        break;
      case 'hello-app':
        at(0, `${U.nginxTime(t0)} Server listening on port 8080`);
        break;
      case 'jenkins':
        at(1, `${hhmmss(t0 + 1000).slice(0, 23)}+0000 [id=1]\tINFO\twinstone.Logger#logInternal: Beginning extraction from war file`);
        at(12, `${hhmmss(t0 + 12000).slice(0, 23)}+0000 [id=24]\tINFO\thudson.lifecycle.Lifecycle#onReady: Jenkins is fully up and running`);
        break;
      case 'coredns':
        at(0, '.:53');
        at(0, '[INFO] plugin/reload: Running configuration SHA512 = 591cf328cccc12bc490481273e738df59329c62c0b729d94e8b61db9961c2fa5f046dd37f1cf888b953814040d180f52594972691cd6ff41be96639138a43908');
        at(0, 'CoreDNS-1.11.3');
        at(0, 'linux/amd64, go1.21.11, a6338e9');
        break;
      case 'apiserver':
        at(0, klog(t0, 'I', 'options.go:228', '"external host was not specified, using 172.18.0.2"'));
        at(0.1, klog(t0 + 100, 'I', 'server.go:142', 'Version: v1.31.0'));
        at(2, klog(t0 + 2000, 'I', 'secure_serving.go:213', 'Serving securely on [::]:6443'));
        at(2.5, klog(t0 + 2500, 'I', 'controller.go:615', 'quota admission added evaluator for: namespaces'));
        break;
      case 'kcm':
        at(0, klog(t0, 'I', 'serving.go:386', 'Generated self-signed cert in-memory'));
        at(1, klog(t0 + 1000, 'I', 'controllermanager.go:197', '"Starting" version="v1.31.0"'));
        at(3, klog(t0 + 3000, 'I', 'leaderelection.go:268', 'successfully acquired lease kube-system/kube-controller-manager'));
        break;
      case 'sched':
        at(0, klog(t0, 'I', 'serving.go:386', 'Generated self-signed cert in-memory'));
        at(1, klog(t0 + 1000, 'I', 'server.go:167', '"Starting Kubernetes Scheduler" version="v1.31.0"'));
        at(2, klog(t0 + 2000, 'I', 'leaderelection.go:268', 'successfully acquired lease kube-system/kube-scheduler'));
        break;
      case 'kube-proxy':
        at(0, klog(t0, 'I', 'server_linux.go:66', '"Using iptables proxy"'));
        at(0.1, klog(t0 + 100, 'I', 'server.go:677', '"Successfully retrieved node IP(s)" IPs=["' + (ctx.hostIP || '172.18.0.3') + '"]'));
        at(0.3, klog(t0 + 300, 'I', 'shared_informer.go:320', 'Caches are synced for service config'));
        at(0.3, klog(t0 + 300, 'I', 'shared_informer.go:320', 'Caches are synced for endpoint slice config'));
        break;
      case 'kindnet':
        at(0, klog(t0, 'I', 'main.go:109', 'connected to apiserver: https://10.96.0.1:443'));
        at(0.1, klog(t0 + 100, 'I', 'main.go:139', 'hostIP = ' + (ctx.hostIP || '172.18.0.3')));
        at(0.1, klog(t0 + 100, 'I', 'main.go:149', 'setting mtu 1500 for CNI '));
        break;
      case 'local-path':
        at(0, klog(t0, 'I', 'controller.go:811', 'Starting provisioner controller rancher.io/local-path_local-path-provisioner'));
        at(0.1, klog(t0 + 100, 'I', 'controller.go:860', 'Started provisioner controller rancher.io/local-path_local-path-provisioner!'));
        break;
      case 'metrics-server':
        at(0, klog(t0, 'I', 'serving.go:374', 'Generated self-signed cert (/tmp/apiserver.crt, /tmp/apiserver.key)'));
        at(1, klog(t0 + 1000, 'I', 'secure_serving.go:213', 'Serving securely on [::]:10250'));
        break;
      case 'etcd':
        at(0, `{"level":"info","ts":"${new Date(t0).toISOString()}","caller":"etcdmain/etcd.go:73","msg":"Running: ","args":["etcd","--advertise-client-urls=https://172.18.0.2:2379"]}`);
        at(1, `{"level":"info","ts":"${new Date(t0 + 1000).toISOString()}","caller":"embed/serve.go:250","msg":"serving client traffic securely","traffic":"grpc+http","address":"127.0.0.1:2379"}`);
        break;
      default:
        break;
    }
    return L;
  };

  // ---------------- respostas HTTP ----------------
  IM.nginxWelcome = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
`;
  const nginxErr = (code, text, ver) => `<html>\n<head><title>${code} ${text}</title></head>\n<body>\n<center><h1>${code} ${text}</h1></center>\n<hr><center>nginx/${ver || '1.27.1'}</center>\n</body>\n</html>\n`;
  // req: {path, method, host, port, clientIP, ua}
  // ctx: {podName, readFile(path)->string|null}
  IM.http = (p, ctx, req) => {
    const path = (req.path || '/').split('?')[0];
    switch (p.http) {
      case 'nginx': {
        let f = path.endsWith('/') ? path + 'index.html' : path;
        const content = ctx.readFile('/usr/share/nginx/html' + f);
        if (content !== null && content !== undefined) return { status: 200, body: content, server: `nginx/${p.version || '1.27.1'}`, type: 'text/html' };
        return { status: 404, body: nginxErr(404, 'Not Found', p.version), server: `nginx/${p.version || '1.27.1'}`, type: 'text/html' };
      }
      case 'ingress':
        return { status: 404, body: nginxErr(404, 'Not Found'), server: 'nginx', type: 'text/html' };
      case 'httpd': {
        const content = ctx.readFile('/usr/local/apache2/htdocs' + (path.endsWith('/') ? path + 'index.html' : path));
        if (content !== null && content !== undefined) return { status: 200, body: content, server: 'Apache/2.4.62 (Unix)', type: 'text/html' };
        return { status: 404, body: `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n`, server: 'Apache/2.4.62 (Unix)' };
      }
      case 'php-ok':
        return { status: 200, body: 'OK!', server: 'Apache/2.4.10 (Debian)' };
      case 'coredns':
        return { status: 200, body: 'OK' };
      case 'echo-text':
        return { status: 200, body: (ctx.echoText ?? 'hello-world') + '\n', server: '' };
      case 'hello-app':
        return { status: 200, body: `Hello, world!\nVersion: ${/2\.0/.test(p.ref.tag) ? '2.0.0' : '1.0.0'}\nHostname: ${ctx.podName}\n` };
      case 'echoserver':
        return {
          status: 200,
          body: `\n\nHostname: ${ctx.podName}\n\nPod Information:\n\t-no pod information available-\n\nServer values:\n\tserver_version=nginx: 1.13.3 - lua: 10008\n\nRequest Information:\n\tclient_address=${req.clientIP}\n\tmethod=${req.method || 'GET'}\n\treal path=${path}\n\tquery=\n\trequest_version=1.1\n\trequest_scheme=http\n\trequest_uri=http://${req.host}:${req.port}${path}\n\nRequest Headers:\n\taccept=*/*\n\thost=${req.host}${req.port && req.port !== 80 ? ':' + req.port : ''}\n\tuser-agent=${req.ua || 'curl/8.10.1'}\n\nRequest Body:\n\t-no body in request-\n\n`,
        };
      case 'agnhost':
        return { status: 200, body: path.startsWith('/hostname') ? ctx.podName : `NOW: ${new Date().toISOString()}` };
      case 'wordpress':
        return { status: 302, body: '', location: `http://${req.host}/wp-admin/install.php` };
      case 'tomcat':
        return { status: 404, body: '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title></head><body><h1>HTTP Status 404 – Not Found</h1></body></html>' };
      case 'grafana':
        return { status: 302, body: '<a href="/login">Found</a>.\n\n', location: '/login' };
      case 'prometheus':
        return { status: 302, body: '<a href="/query">Found</a>.\n\n', location: '/query' };
      case 'caddy':
        return { status: 200, body: '<!DOCTYPE html>\n<html>\n<head>\n<title>Caddy works!</title>\n</head>\n<body>\n<h1>Caddy works!</h1>\n</body>\n</html>\n' };
      case 'python':
        return { status: 200, body: `<!DOCTYPE HTML>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Directory listing for ${path}</title>\n</head>\n<body>\n<h1>Directory listing for ${path}</h1>\n<hr>\n<ul>\n<li><a href="bin/">bin@</a></li>\n<li><a href="etc/">etc/</a></li>\n<li><a href="tmp/">tmp/</a></li>\n<li><a href="usr/">usr/</a></li>\n</ul>\n<hr>\n</body>\n</html>\n` };
      default:
        if (p.proto) return { status: -1, error: p.proto };
        return { status: 404, body: '404 page not found\n' };
    }
  };

  // ---------------- simulação de processos ----------------
  class Stop {
    constructor(reason, code) {
      this.reason = reason; // horizon | exit | forever | spin
      this.code = code;
    }
  }
  IM.Stop = Stop;

  const DEFAULT_ENV = (p) => ({
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
  });

  // Descobre o argv efetivo do container (ENTRYPOINT/CMD + command/args do Pod)
  IM.effectiveArgv = (p, c) => {
    const cmd = c.command && c.command.length ? c.command : null;
    const args = c.args && c.args.length ? c.args : null;
    if (cmd) return cmd.concat(args || []);
    if (p.entry) return [p.entry].concat(args || []);
    if (args && p.server && !p.entry && args[0].startsWith('-')) return null; // args vão para o ENTRYPOINT do servidor
    if (args) return args;
    return null; // CMD padrão da imagem
  };

  // Executa o programa do container em tempo virtual até `horizon` segundos.
  // Retorna { logs:[{t,line}], exit:{t,code,reason}|null, fs:[{t,op,path,content}], load:[hosts], cpu, mem, listen:[ports] }
  IM.run = (container, ctx, horizon, opts = {}) => {
    const p = IM.profile(container.image);
    const vm = {
      t: 0,
      horizon,
      logs: [],
      fs: [],
      load: new Set(),
      cpu: null,
      mem: null,
      listen: null,
      steps: 0,
      maxLines: opts.maxLines || 4000,
      env: Object.assign(DEFAULT_ENV(p), ctx.env || {}, { HOSTNAME: ctx.podName }),
      p,
      ctx,
      shellName: p.shell || 'sh',
      server: false,
      echoText: null,
    };
    const out = { logs: vm.logs, fs: vm.fs, load: vm.load, exit: null, profile: p };
    const argv = IM.effectiveArgv(p, container);
    try {
      if (p.oneshot === 'hello') {
        emit(vm, HELLO);
        throw new Stop('exit', 0);
      }
      if (!argv) {
        // CMD padrão
        if (p.server) return finishServer(vm, out, p, ctx);
        if (container.stdin || container.tty) { vm.t = Infinity; throw new Stop('forever'); }
        if (p.repl === 'python3') { throw new Stop('exit', 0); }
        throw new Stop('exit', 0); // shell sem TTY termina imediatamente
      }
      const bin = argv[0].split('/').pop();
      if (['sh', 'bash', 'ash', 'zsh', 'dash'].includes(bin)) {
        if (p.base === 'scratch' || (!p.tools.has(bin) && !(bin === 'sh' && p.shell))) {
          throw startError(argv[0]);
        }
        const ci = argv.indexOf('-c');
        if (ci < 0) {
          if (argv.length > 1 && !argv[1].startsWith('-')) {
            emit(vm, `${bin}: can't open '${argv[1]}': No such file or directory\n`);
            throw new Stop('exit', 2);
          }
          if (container.stdin || container.tty) { vm.t = Infinity; throw new Stop('forever'); }
          throw new Stop('exit', 0);
        }
        vm.shellName = bin;
        const script = argv[ci + 1] || '';
        const ast = SH.parse(script);
        const st = execList(vm, ast);
        throw new Stop('exit', st);
      }
      // comando direto (exec)
      if (!isKnownCommand(vm, bin, argv[0])) throw startError(argv[0]);
      const st = execArgv(vm, argv, '');
      throw new Stop('exit', st);
    } catch (e) {
      if (!(e instanceof Stop)) {
        if (e instanceof SH.SyntaxError || e.incomplete) {
          emit(vm, `${vm.shellName}: -c: line 1: ${e.incomplete ? 'syntax error: unexpected end of file' : e.message}\n`);
          out.exit = { t: vm.t, code: 2 };
        } else throw e;
      } else if (e.reason === 'exit') out.exit = { t: vm.t, code: e.code | 0 };
      else if (e.reason === 'start') out.exit = { t: 0, code: 128, reason: 'StartError', message: e.code };
      else if (e.reason === 'spin') { out.spin = true; out.exit = null; }
      else out.exit = null;
    }
    finalize(vm, out);
    return out;
  };
  function finalize(vm, out) {
    out.server = vm.server;
    out.cpu = vm.cpu;
    out.mem = vm.mem;
    out.listen = vm.listen;
    out.echoText = vm.echoText;
    out.httpKind = vm.httpKind;
  }
  function finishServer(vm, out, p, ctx) {
    vm.server = true;
    if (p.needEnv && !p.needEnv.some((k) => vm.env[k] !== undefined && vm.env[k] !== '')) {
      emitLines(vm, IM.missingEnvLogs(p, ctx.startTime));
      out.exit = { t: 0.4, code: 1 };
      finalize(vm, out);
      return out;
    }
    for (const l of IM.startupLogs(p, { ...ctx, listenPort: vm.listen && vm.listen[0] }, ctx.startTime || Date.now())) {
      if (l.t <= vm.horizon) vm.logs.push(l);
    }
    vm.listen = vm.listen || (p.ports.length ? p.ports : null);
    out.exit = null;
    finalize(vm, out);
    return out;
  }
  IM.missingEnvLogs = (p) => {
    if (p.logs === 'postgres')
      return 'Error: Database is uninitialized and superuser password is not specified.\n       You must specify POSTGRES_PASSWORD to a non-empty value for the\n       superuser. For example, "-e POSTGRES_PASSWORD=password" on "docker run".\n\n       You may also use "POSTGRES_HOST_AUTH_METHOD=trust" to allow all\n       connections without a password. This is *not* recommended.\n\n       See PostgreSQL documentation about "trust":\n       https://www.postgresql.org/docs/current/auth-trust.html\n';
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ') + '+00:00';
    if (p.logs === 'mysql')
      return `${now} [Note] [Entrypoint]: Entrypoint script for MySQL Server 9.0.1-1.el9 started.\n${now} [Note] [Entrypoint]: Switching to dedicated user 'mysql'\n${now} [Note] [Entrypoint]: Entrypoint script for MySQL Server 9.0.1-1.el9 started.\n${now} [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified\n    You need to specify one of the following as an environment variable:\n    - MYSQL_ROOT_PASSWORD\n    - MYSQL_ALLOW_EMPTY_PASSWORD\n    - MYSQL_RANDOM_ROOT_PASSWORD\n`;
    return `${now} [Note] [Entrypoint]: Entrypoint script for MariaDB Server 1:11.5.2+maria~ubu2404 started.\n${now} [ERROR] [Entrypoint]: Database is uninitialized and password option is not specified\n\tYou need to specify one of MARIADB_ROOT_PASSWORD, MARIADB_ROOT_PASSWORD_HASH, MARIADB_ALLOW_EMPTY_ROOT_PASSWORD and MARIADB_RANDOM_ROOT_PASSWORD\n`;
  };
  const HELLO = `
Hello from Docker!
This message shows that your installation appears to be working correctly.

To generate this message, Docker took the following steps:
 1. The Docker client contacted the Docker daemon.
 2. The Docker daemon pulled the "hello-world" image from the Docker Hub.
    (amd64)
 3. The Docker daemon created a new container from that image which runs the
    executable that produces the output you are currently reading.
 4. The Docker daemon streamed that output to the Docker client, which sent it
    to your terminal.

To try something more ambitious, you can run an Ubuntu container with:
 $ docker run -it ubuntu bash

Share images, automate workflows, and more with a free Docker ID:
 https://hub.docker.com/

For more examples and ideas, visit:
 https://docs.docker.com/get-started/

`;

  function startError(path) {
    return new Stop(
      'start',
      `failed to create containerd task: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: exec: "${path}": executable file not found in $PATH: unknown`
    );
  }
  const SERVER_BINS = {
    nginx: 'nginx', httpd: 'httpd', 'httpd-foreground': 'httpd', apache2: 'httpd', 'apache2-foreground': 'httpd',
    'redis-server': 'redis', postgres: 'postgres', mysqld: 'mysql', mariadbd: 'mariadb', mongod: 'mongo',
    'docker-entrypoint.sh': 'entry', 'rabbitmq-server': 'rabbitmq', memcached: 'memcached', 'http-echo': 'http-echo',
    '/hello-app': 'hello-app', 'hello-app': 'hello-app', pause: 'pause', '/pause': 'pause', agnhost: 'agnhost',
    'tail': null,
  };
  function isKnownCommand(vm, bin, full) {
    const p = vm.p;
    if (BUILTINS.has(bin)) return p.base !== 'scratch';
    if (p.tools.has(bin)) return true;
    if (SERVER_BINS[bin] !== undefined || SERVER_BINS[full] !== undefined) return true;
    if (p.generic) return true; // imagem desconhecida: aceita o binário
    if (p.server && (bin === p.ref.name || full.startsWith('/'))) return true;
    if (['python', 'python3', 'node', 'ruby', 'perl', 'php', 'java', 'go', 'stress', 'curl'].includes(bin)) return p.tools.has(bin);
    return false;
  }
  const BUILTINS_ALWAYS = new Set(['echo', 'exit', 'true', 'false', 'cd', 'export', 'test', '[', 'printf', 'read', 'set', 'trap', 'wait', 'unset', 'shift', ':', 'return', 'kill', 'exec', 'source', '.', 'type', 'eval']);
  const BUILTINS = new Set([...BUILTINS_ALWAYS, 'sleep', 'date', 'hostname', 'cat', 'touch', 'rm', 'mkdir', 'env', 'printenv', 'seq', 'expr', 'yes', 'tail', 'ls', 'pwd', 'whoami', 'id', 'uname', 'head', 'grep', 'wc', 'tee', 'nproc']);

  function emit(vm, text) {
    if (!text) return;
    if (vm.capture) { vm.capture.buf += text; return; }
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    for (const line of parts) {
      if (vm.t > vm.horizon) return;
      vm.logs.push({ t: vm.t, line });
      if (vm.logs.length > vm.maxLines * 2) vm.logs.splice(0, vm.logs.length - vm.maxLines);
    }
  }
  function emitLines(vm, text) {
    emit(vm, text);
  }
  function advance(vm, sec) {
    vm.t += sec;
    if (vm.t > vm.horizon) throw new Stop('horizon');
  }
  function tick(vm) {
    vm.steps++;
    if (vm.steps > 60000) {
      // loop sem sleep: processo roda para sempre consumindo CPU
      vm.cpu = Math.max(vm.cpu || 0, 1000);
      throw new Stop('spin');
    }
  }
  const getVar = (vm) => (name) => {
    if (name === '?') return String(vm.status ?? 0);
    if (name === '$') return '1';
    if (name === '#') return '0';
    if (name === '0') return vm.shellName;
    if (name === 'RANDOM') return String(Math.floor(U.seeded(vm.ctx.podName + vm.steps) * 32768));
    if (name === 'SECONDS') return String(Math.floor(vm.t));
    return vm.env[name];
  };
  function subst(vm) {
    return (src) => {
      const saved = vm.capture;
      vm.capture = { buf: '' };
      try {
        execList(vm, SH.parse(src));
      } catch (e) {
        if (!(e instanceof Stop) || e.reason !== 'exit') { vm.capture = saved; throw e; }
      }
      const r = vm.capture.buf;
      vm.capture = saved;
      return r;
    };
  }
  function expandAll(vm, words) {
    const out = [];
    for (const w of words) out.push(...SH.expandWord(w, getVar(vm), subst(vm)));
    return out;
  }
  function execList(vm, list) {
    let st = 0;
    for (const it of list.items) {
      if (it.bg) {
        const saveT = vm.t, saveH = vm.horizon;
        try {
          vm.horizon = Math.min(vm.horizon, vm.t + 3600);
          execAndOr(vm, it.ao);
        } catch (e) {
          if (!(e instanceof Stop)) throw e;
          if (e.reason === 'start') throw e;
        }
        vm.t = saveT;
        vm.horizon = saveH;
        st = 0;
        continue;
      }
      st = execAndOr(vm, it.ao);
    }
    vm.status = st;
    return st;
  }
  function execAndOr(vm, ao) {
    let st = execPipe(vm, ao.first);
    for (const r of ao.rest) {
      if ((r.op === '&&' && st === 0) || (r.op === '||' && st !== 0)) st = execPipe(vm, r.pipe);
    }
    vm.status = st;
    return st;
  }
  function execPipe(vm, pipe) {
    let input = '';
    let st = 0;
    for (let i = 0; i < pipe.cmds.length; i++) {
      const last = i === pipe.cmds.length - 1;
      if (!last) {
        const saved = vm.capture;
        vm.capture = { buf: '' };
        try {
          st = execCmd(vm, pipe.cmds[i], input);
        } finally {
          input = vm.capture.buf;
          vm.capture = saved;
        }
      } else st = execCmd(vm, pipe.cmds[i], input);
    }
    if (pipe.neg) st = st === 0 ? 1 : 0;
    return st;
  }
  function execCmd(vm, cmd, stdin) {
    tick(vm);
    // redireções de saída
    let redirect = null;
    for (const r of cmd.redirs || []) {
      if (r.op === '>' || r.op === '>>' || r.op === '&>') {
        const target = SH.expandWord(r.target, getVar(vm), subst(vm))[0];
        if (target === '/dev/null') redirect = { null: true };
        else if (target === '/dev/stdout' || target === '/proc/1/fd/1' || target === '/dev/stderr' || target === '/proc/1/fd/2') redirect = null;
        else redirect = { path: target, append: r.op === '>>' };
      } else if (r.op === '<') {
        const src = SH.expandWord(r.target, getVar(vm), subst(vm))[0];
        stdin = readFile(vm, src) ?? '';
      } else if (r.op === '<<') {
        stdin = r.quoted ? r.body : SH.expandHeredoc(r.body, getVar(vm), subst(vm));
      }
    }
    const saved = vm.capture;
    if (redirect) vm.capture = { buf: '' };
    let st = 0;
    try {
      if (cmd.t === 'simple') st = execSimple(vm, cmd, stdin);
      else if (cmd.t === 'group') st = execList(vm, cmd.body);
      else if (cmd.t === 'while') {
        st = 0;
        for (;;) {
          tick(vm);
          const c = execList(vm, cmd.cond);
          if (cmd.until ? c === 0 : c !== 0) break;
          try {
            st = execList(vm, cmd.body);
          } catch (e) {
            if (e === BREAK) break;
            if (e === CONTINUE) continue;
            throw e;
          }
        }
      } else if (cmd.t === 'for') {
        const items = cmd.words ? expandAll(vm, cmd.words) : [];
        for (const it of items) {
          vm.env[cmd.name] = it;
          try {
            st = execList(vm, cmd.body);
          } catch (e) {
            if (e === BREAK) break;
            if (e === CONTINUE) continue;
            throw e;
          }
        }
      } else if (cmd.t === 'if') {
        let done = false;
        for (const cl of cmd.clauses) {
          if (execList(vm, cl.cond) === 0) { st = execList(vm, cl.body); done = true; break; }
        }
        if (!done) st = cmd.elseBody ? execList(vm, cmd.elseBody) : 0;
      }
    } finally {
      if (redirect) {
        const buf = vm.capture.buf;
        vm.capture = saved;
        if (!redirect.null) {
          const prev = redirect.append ? readFile(vm, redirect.path) || '' : '';
          vm.fs.push({ t: vm.t, op: 'write', path: absPath(vm, redirect.path), content: prev + buf });
        }
      }
    }
    return st;
  }
  const BREAK = { brk: 1 }, CONTINUE = { cont: 1 };
  function absPath(vm, p) {
    if (p.startsWith('/')) return p;
    return (vm.env.PWD || '/') .replace(/\/$/, '') + '/' + p;
  }
  function readFile(vm, path) {
    path = absPath(vm, path);
    for (let i = vm.fs.length - 1; i >= 0; i--) {
      const e = vm.fs[i];
      if (e.path === path) return e.op === 'rm' ? null : e.content;
    }
    return vm.ctx.readFile ? vm.ctx.readFile(path) : null;
  }
  function execSimple(vm, cmd, stdin) {
    for (const a of cmd.assigns) {
      const i = a.indexOf('=');
      vm.env[a.slice(0, i)] = SH.expandWord(a.slice(i + 1), getVar(vm), subst(vm), { noSplit: true })[0] ?? '';
    }
    if (!cmd.words.length) return 0;
    const argv = expandAll(vm, cmd.words);
    if (!argv.length) return 0;
    return execArgv(vm, argv, stdin);
  }
  function notFound(vm, bin) {
    if (vm.shellName === 'bash') emit(vm, `bash: line 1: ${bin}: command not found\n`);
    else emit(vm, `${vm.shellName}: ${bin}: not found\n`);
    return 127;
  }
  function execArgv(vm, argv, stdin) {
    const full = argv[0];
    const bin = full.split('/').pop();
    const a = argv.slice(1);
    const p = vm.p;
    const has = (b) => p.tools.has(b) || BUILTINS_ALWAYS.has(b);
    switch (bin) {
      case ':': case 'true': case 'set': case 'trap': case 'wait': case 'unset': case 'shift': case 'kill': case 'sync': case 'cd':
        if (bin === 'cd') vm.env.PWD = a[0] ? absPath(vm, a[0]) : '/root';
        return 0;
      case 'false': return 1;
      case 'exit': throw new Stop('exit', a[0] !== undefined ? parseInt(a[0]) & 255 : vm.status || 0);
      case 'return': throw new Stop('exit', parseInt(a[0] || '0'));
      case 'break': throw BREAK;
      case 'continue': throw CONTINUE;
      case 'export':
        for (const kv of a) { const i = kv.indexOf('='); if (i > 0) vm.env[kv.slice(0, i)] = kv.slice(i + 1); }
        return 0;
      case 'exec': return a.length ? execArgv(vm, a, stdin) : 0;
      case 'echo': {
        let args = a, nl = true, esc = false;
        while (args[0] && /^-[neE]+$/.test(args[0])) { if (args[0].includes('n')) nl = false; if (args[0].includes('e')) esc = true; args = args.slice(1); }
        let s = args.join(' ');
        if (esc || vm.shellName === 'sh' && p.base !== 'busybox' && p.base !== 'alpine') s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        emit(vm, s + (nl ? '\n' : ''));
        return 0;
      }
      case 'printf': {
        const fmt = a[0] || '';
        let i = 1;
        let outS = '';
        do {
          outS += fmt.replace(/%(-?\d*)([sdfq%])/g, (m, w, t) => {
            if (t === '%') return '%';
            const v = a[i++] ?? '';
            const s = t === 'd' ? String(parseInt(v) || 0) : t === 'f' ? (parseFloat(v) || 0).toFixed(6) : String(v);
            return w ? (w.startsWith('-') ? s.padEnd(Math.abs(w)) : s.padStart(Number(w))) : s;
          }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        } while (i < a.length && /%[sdf]/.test(fmt));
        emit(vm, outS);
        return 0;
      }
      case 'sleep': {
        if (!has('sleep')) return notFound(vm, bin);
        let total = 0;
        for (const x of a) {
          if (x === 'infinity' || x === 'inf') { vm.t = Infinity; throw new Stop('forever'); }
          const m = x.match(/^(\d*\.?\d+)([smhd]?)$/);
          if (!m) { emit(vm, `sleep: invalid number '${x}'\n`); return 1; }
          total += parseFloat(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
        }
        advance(vm, total);
        return 0;
      }
      case 'date': {
        const now = (vm.ctx.startTime || Date.now()) + vm.t * 1000;
        const f = a.find((x) => x.startsWith('+'));
        if (f) {
          const d = new Date(now);
          const p2 = (n) => String(n).padStart(2, '0');
          emit(vm, f.slice(1).replace(/%s/g, String(Math.floor(now / 1000))).replace(/%T/g, `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`).replace(/%F/g, d.toISOString().slice(0, 10)).replace(/%H/g, p2(d.getUTCHours())).replace(/%M/g, p2(d.getUTCMinutes())).replace(/%S/g, p2(d.getUTCSeconds())).replace(/%Y/g, d.getUTCFullYear()).replace(/%m/g, p2(d.getUTCMonth() + 1)).replace(/%d/g, p2(d.getUTCDate())) + '\n');
        } else emit(vm, U.dateCmd(now) + '\n');
        return 0;
      }
      case 'hostname': emit(vm, vm.ctx.podName + '\n'); return 0;
      case 'whoami': emit(vm, 'root\n'); return 0;
      case 'id': emit(vm, 'uid=0(root) gid=0(root) groups=0(root)\n'); return 0;
      case 'pwd': emit(vm, (vm.env.PWD || '/') + '\n'); return 0;
      case 'nproc': emit(vm, '4\n'); return 0;
      case 'uname': emit(vm, a.includes('-a') ? `Linux ${vm.ctx.podName} 6.10.14-linuxkit #1 SMP PREEMPT_DYNAMIC Fri Nov 29 17:24:06 UTC 2024 x86_64 GNU/Linux\n` : 'Linux\n'); return 0;
      case 'env': case 'printenv': {
        if (bin === 'printenv' && a.length) { const v = vm.env[a[0]]; if (v === undefined) return 1; emit(vm, v + '\n'); return 0; }
        emit(vm, Object.entries(vm.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
        return 0;
      }
      case 'cat': {
        if (!has('cat')) return notFound(vm, bin);
        if (!a.length || a[0] === '-') { emit(vm, stdin); return 0; }
        let st = 0;
        for (const f of a) {
          const c = readFile(vm, f);
          if (c === null || c === undefined) { emit(vm, p.base === 'busybox' || p.base === 'alpine' ? `cat: can't open '${f}': No such file or directory\n` : `cat: ${f}: No such file or directory\n`); st = 1; }
          else emit(vm, c);
        }
        return st;
      }
      case 'touch': for (const f of a) if (!f.startsWith('-')) vm.fs.push({ t: vm.t, op: 'write', path: absPath(vm, f), content: readFile(vm, f) || '' }); return 0;
      case 'rm': for (const f of a) if (!f.startsWith('-')) vm.fs.push({ t: vm.t, op: 'rm', path: absPath(vm, f) }); return 0;
      case 'mkdir': return 0;
      case 'tee': for (const f of a) if (!f.startsWith('-')) vm.fs.push({ t: vm.t, op: 'write', path: absPath(vm, f), content: stdin }); emit(vm, stdin); return 0;
      case 'seq': {
        const n = a.map(Number);
        let [s, st, e] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : n;
        let o = '';
        for (let x = s; st > 0 ? x <= e : x >= e; x += st) { o += x + '\n'; if (o.length > 1e5) break; }
        emit(vm, o);
        return 0;
      }
      case 'expr': {
        try { const r = SH.evalArith(a.join(' ').replace(/\\\*/g, '*'), getVar(vm)); emit(vm, r + '\n'); return r === '0' ? 1 : 0; } catch { emit(vm, 'expr: syntax error\n'); return 2; }
      }
      case 'test': case '[': case '[[': return testCmd(vm, bin === 'test' ? a : a.slice(0, -1));
      case 'head': case 'tail': {
        if (bin === 'tail' && a.includes('-f')) {
          const f = a.filter((x) => !x.startsWith('-')).pop();
          if (f && f !== '/dev/null') { const c = readFile(vm, f); if (c) emit(vm, c.split('\n').slice(-10).join('\n')); }
          vm.t = Infinity;
          throw new Stop('forever');
        }
        const nIdx = a.indexOf('-n');
        const n = nIdx >= 0 ? parseInt(a[nIdx + 1]) : (a.find((x) => /^-\d+$/.test(x)) ? -parseInt(a.find((x) => /^-\d+$/.test(x))) : 10);
        const files = a.filter((x, i) => !x.startsWith('-') && i !== nIdx + 1);
        const txt = files.length ? readFile(vm, files[0]) || '' : stdin;
        const lines = txt.replace(/\n$/, '').split('\n');
        emit(vm, (bin === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') + '\n');
        return 0;
      }
      case 'grep': {
        const pat = a.find((x) => !x.startsWith('-'));
        const re = new RegExp(pat || '', a.includes('-i') ? 'i' : '');
        const inv = a.includes('-v');
        const res = stdin.split('\n').filter((l) => l !== '' && re.test(l) !== inv);
        if (!a.includes('-q')) emit(vm, res.length ? res.join('\n') + '\n' : '');
        return res.length ? 0 : 1;
      }
      case 'wc': {
        const lines = stdin.split('\n').length - 1;
        emit(vm, (a.includes('-l') ? String(lines) : `${lines} ${stdin.split(/\s+/).filter(Boolean).length} ${stdin.length}`) + '\n');
        return 0;
      }
      case 'yes': {
        const s = (a.join(' ') || 'y') + '\n';
        for (let i = 0; i < 2000; i++) emit(vm, s);
        vm.cpu = 1000;
        throw new Stop('spin');
      }
      case 'ls': emit(vm, 'bin\ndev\netc\nhome\nlib\nproc\nroot\nsys\ntmp\nusr\nvar\n'); return 0;
      case 'wget': case 'curl': {
        if (!has(bin)) return notFound(vm, bin);
        const url = a.find((x) => /^(https?:\/\/)?[\w.-]+(:\d+)?(\/.*)?$/.test(x) && !x.startsWith('-') && !/^\d+$/.test(x));
        if (!url) { emit(vm, bin === 'curl' ? "curl: try 'curl --help' or 'curl --manual' for more information\n" : 'BusyBox v1.37.0 (2024-09-26 21:31:42 UTC) multi-call binary.\n\nUsage: wget [-cqS] [--spider] [-O FILE] [-o LOGFILE] [--header STR]\n'); return bin === 'curl' ? 2 : 1; }
        const host = url.replace(/^https?:\/\//, '').split(/[/:]/)[0];
        vm.load.add(url);
        const quiet = a.some((x) => /^-[a-zA-Z]*[qs][a-zA-Z]*-?$/.test(x) && !x.startsWith('--')) || a.includes('--silent') || a.includes('--quiet');
        const res = vm.ctx.http ? vm.ctx.http(url, { quiet, tool: bin }) : null;
        advance(vm, 0.002);
        if (!res) { emit(vm, `${bin}: bad address '${host}'\n`); return 1; }
        if (res.error) { emit(vm, res.error + '\n'); return bin === 'curl' ? res.code || 7 : 1; }
        const toFile = a.includes('-O') && a[a.indexOf('-O') + 1] !== '-';
        if (bin === 'wget' && !quiet) emit(vm, `Connecting to ${host} (${res.ip}:${res.port})\n${toFile ? "saving to 'index.html'" : 'writing to stdout'}\n`);
        if (!toFile || bin === 'curl') emit(vm, res.body);
        if (bin === 'wget' && !quiet) emit(vm, `-                    100% |********************************|   ${res.body.length}  0:00:00 ETA\nwritten to stdout\n`);
        return 0;
      }
      case 'nslookup': case 'ping': {
        if (!has(bin)) return notFound(vm, bin);
        const r = vm.ctx.exec ? vm.ctx.exec(argv) : { out: '', code: 0 };
        emit(vm, r.out);
        return r.code;
      }
      case 'python': case 'python3': {
        if (!has(bin)) return notFound(vm, bin);
        const ci = a.indexOf('-c');
        if (a[0] === '-m' && a[1] === 'http.server') {
          vm.server = true;
          vm.httpKind = 'python';
          vm.listen = [parseInt(a[2]) || 8000];
          emit(vm, `Serving HTTP on 0.0.0.0 port ${vm.listen[0]} (http://0.0.0.0:${vm.listen[0]}/) ...\n`);
          vm.t = Infinity;
          throw new Stop('forever');
        }
        if (ci >= 0) {
          const code = a[ci + 1] || '';
          for (const m of code.matchAll(/print\((['"])(.*?)\1\)/g)) emit(vm, m[2] + '\n');
          if (/while\s+True/.test(code)) { vm.t = Infinity; throw new Stop('forever'); }
          const sm = code.match(/time\.sleep\((\d+(\.\d+)?)\)/);
          if (sm) advance(vm, parseFloat(sm[1]));
          return /raise|exit\(1\)|sys\.exit\([1-9]/.test(code) ? 1 : 0;
        }
        if (a.length) { vm.server = true; vm.t = Infinity; throw new Stop('forever'); }
        return 0;
      }
      case 'node': {
        if (!has(bin)) return notFound(vm, bin);
        const ei = a.indexOf('-e');
        if (ei >= 0) { for (const m of (a[ei + 1] || '').matchAll(/console\.log\((['"`])(.*?)\1\)/g)) emit(vm, m[2] + '\n'); return 0; }
        if (a.length) { vm.server = true; vm.t = Infinity; throw new Stop('forever'); }
        return 0;
      }
      case 'perl': {
        if (!has(bin)) return notFound(vm, bin);
        const script = a.filter((x) => !x.startsWith('-')).join(' ');
        const bpi = script.match(/bpi\((\d+)\)/);
        if (bpi) { advance(vm, Math.min(8, Number(bpi[1]) / 300)); emit(vm, U.piDigits(Number(bpi[1]) - 1) + '\n'); return 0; }
        for (const m of script.matchAll(/print\s+(['"])(.*?)\1/g)) emit(vm, m[2].replace(/\\n/g, '\n') + (a.some((x) => /l/.test(x) && x.startsWith('-')) ? '\n' : ''));
        return 0;
      }
      case 'stress': {
        if (!has('stress')) return notFound(vm, bin);
        const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
        const vmBytes = get('--vm-bytes') || get('-mem-total');
        const cpus = get('--cpu') || get('-c') || get('-cpus');
        emit(vm, `stress: info: [1] dispatching hogs: ${cpus || 0} cpu, 0 io, ${a.includes('--vm') ? get('--vm') : 0} vm, 0 hdd\n`);
        if (vmBytes) vm.mem = U.parseQuantity(vmBytes.replace(/([KMG])$/i, (m) => m.toUpperCase() + 'i').replace(/([KMG])B$/i, '$1i'));
        if (cpus) vm.cpu = parseInt(cpus) * 1000;
        const timeout = get('--timeout') || get('-t');
        if (timeout) {
          advance(vm, U.parseDuration(timeout) || 0);
          emit(vm, `stress: info: [1] successful run completed in ${U.parseDuration(timeout)}s\n`);
          return 0;
        }
        vm.t = Infinity;
        throw new Stop('forever');
      }
      case 'http-echo': {
        vm.server = true;
        vm.httpKind = 'echo-text';
        const txt = a.find((x) => x.startsWith('-text='));
        const ti = a.indexOf('-text');
        vm.echoText = txt ? txt.slice(6) : ti >= 0 ? a[ti + 1] : 'hello-world';
        const lp = a.find((x) => x.startsWith('-listen='));
        vm.listen = [lp ? parseInt(lp.split(':').pop()) : 5678];
        emit(vm, `${U.nginxTime(vm.ctx.startTime || Date.now())} [INFO] server is listening on :${vm.listen[0]}\n`);
        vm.t = Infinity;
        throw new Stop('forever');
      }
      default: {
        const srv = SERVER_BINS[bin] ?? SERVER_BINS[full];
        if (srv !== undefined && srv !== null) {
          vm.server = true;
          const prof = srv === 'entry' || srv === 'pause' ? p : IM.profile(srv) || p;
          const logs = IM.startupLogs(prof.known ? prof : p, vm.ctx, (vm.ctx.startTime || Date.now()) + vm.t * 1000);
          for (const l of logs) vm.logs.push({ t: vm.t + l.t, line: l.line });
          vm.listen = prof.ports.length ? prof.ports : p.ports;
          vm.httpKind = prof.http;
          vm.t = Infinity;
          throw new Stop('forever');
        }
        if (p.generic || (p.server && (full.startsWith('/') || bin === p.ref.name))) {
          vm.server = true;
          for (const l of IM.startupLogs(p, vm.ctx, (vm.ctx.startTime || Date.now()) + vm.t * 1000)) vm.logs.push({ t: vm.t + l.t, line: l.line });
          vm.t = Infinity;
          throw new Stop('forever');
        }
        return notFound(vm, bin);
      }
    }
  }
  function testCmd(vm, a) {
    if (!a.length) return 1;
    if (a[0] === '!') return testCmd(vm, a.slice(1)) === 0 ? 1 : 0;
    if (a.length === 1) return a[0] ? 0 : 1;
    if (a.length === 2) {
      const [op, v] = a;
      if (op === '-z') return v === '' ? 0 : 1;
      if (op === '-n') return v !== '' ? 0 : 1;
      if (op === '-f' || op === '-e' || op === '-s' || op === '-r') { const c = readFile(vm, v); return c !== null && c !== undefined && (op !== '-s' || c.length) ? 0 : 1; }
      if (op === '-d') return ['/', '/tmp', '/etc', '/usr', '/var', '/root', '/data'].includes(v) ? 0 : 1;
    }
    const [l, op, r] = a;
    switch (op) {
      case '=': case '==': return l === r ? 0 : 1;
      case '!=': return l !== r ? 0 : 1;
      case '-eq': return +l === +r ? 0 : 1;
      case '-ne': return +l !== +r ? 0 : 1;
      case '-gt': return +l > +r ? 0 : 1;
      case '-lt': return +l < +r ? 0 : 1;
      case '-ge': return +l >= +r ? 0 : 1;
      case '-le': return +l <= +r ? 0 : 1;
    }
    return 2;
  }

  // Estado do sistema de arquivos gerado pelo script até o instante t
  IM.fsAt = (fsEvents, t) => {
    const m = {};
    for (const e of fsEvents) {
      if (e.t > t) break;
      if (e.op === 'rm') m[e.path] = null;
      else m[e.path] = e.content;
    }
    return m;
  };

  // ---------------- arquivos base da imagem ----------------
  IM.osRelease = (p) => {
    switch (p.base) {
      case 'busybox': return null;
      case 'alpine': return 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.20.3\nPRETTY_NAME="Alpine Linux v3.20"\nHOME_URL="https://alpinelinux.org/"\nBUG_REPORT_URL="https://gitlab.alpinelinux.org/alpine/aports/-/issues"\n';
      case 'ubuntu': return 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.1 LTS (Noble Numbat)"\nVERSION_CODENAME=noble\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\n';
      case 'rhel': return 'NAME="Oracle Linux Server"\nVERSION="9.4"\nID="ol"\nID_LIKE="fedora"\nVERSION_ID="9.4"\nPRETTY_NAME="Oracle Linux Server 9.4"\n';
      case 'scratch': return null;
      default: return 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION="12 (bookworm)"\nVERSION_CODENAME=bookworm\nID=debian\nHOME_URL="https://www.debian.org/"\nSUPPORT_URL="https://www.debian.org/support"\nBUG_REPORT_URL="https://bugs.debian.org/"\n';
    }
  };
  IM.baseFiles = (p) => {
    const f = {};
    const os = IM.osRelease(p);
    if (os) { f['/etc/os-release'] = os; f['/usr/lib/os-release'] = os; }
    if (p.base === 'busybox' || p.base === 'alpine') {
      f['/etc/passwd'] = 'root:x:0:0:root:/root:/bin/sh\ndaemon:x:1:1:daemon:/usr/sbin:/bin/false\nbin:x:2:2:bin:/bin:/bin/false\nnobody:x:65534:65534:nobody:/home:/bin/false\n';
      if (p.base === 'alpine') f['/etc/alpine-release'] = '3.20.3\n';
    } else if (p.base !== 'scratch') {
      f['/etc/passwd'] = 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbin:x:2:2:bin:/bin:/usr/sbin/nologin\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n';
      f['/etc/debian_version'] = p.base === 'debian' ? '12.7\n' : undefined;
    }
    if (p.http === 'nginx') {
      f['/usr/share/nginx/html/index.html'] = IM.nginxWelcome;
      f['/usr/share/nginx/html/50x.html'] = '<!DOCTYPE html>\n<html>\n<head>\n<title>Error</title>\n</head>\n<body>\n<h1>An error occurred.</h1>\n</body>\n</html>\n';
      f['/etc/nginx/nginx.conf'] = `
user  nginx;
worker_processes  auto;

error_log  /var/log/nginx/error.log notice;
pid        /var/run/nginx.pid;


events {
    worker_connections  1024;
}


http {
    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    log_format  main  '$remote_addr - $remote_user [$time_local] "$request" '
                      '$status $body_bytes_sent "$http_referer" '
                      '"$http_user_agent" "$http_x_forwarded_for"';

    access_log  /var/log/nginx/access.log  main;

    sendfile        on;
    #tcp_nopush     on;

    keepalive_timeout  65;

    #gzip  on;

    include /etc/nginx/conf.d/*.conf;
}
`;
      f['/etc/nginx/conf.d/default.conf'] = `server {
    listen       80;
    listen  [::]:80;
    server_name  localhost;

    #access_log  /var/log/nginx/host.access.log  main;

    location / {
        root   /usr/share/nginx/html;
        index  index.html index.htm;
    }

    #error_page  404              /404.html;

    # redirect server error pages to the static page /50x.html
    #
    error_page   500 502 503 504  /50x.html;
    location = /50x.html {
        root   /usr/share/nginx/html;
    }
}
`;
    }
    if (p.http === 'httpd') f['/usr/local/apache2/htdocs/index.html'] = '<html><body><h1>It works!</h1></body></html>\n';
    Object.keys(f).forEach((k) => f[k] === undefined && delete f[k]);
    return f;
  };
  IM.rootDirs = (p) =>
    p.base === 'busybox' ? ['bin', 'dev', 'etc', 'home', 'lib', 'lib64', 'proc', 'root', 'sys', 'tmp', 'usr', 'var']
      : p.base === 'alpine' ? ['bin', 'dev', 'etc', 'home', 'lib', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var']
        : ['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var'].concat(p.http === 'nginx' ? ['docker-entrypoint.d', 'docker-entrypoint.sh'] : []);
})();
