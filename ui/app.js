/* Larkhaven UI — Alpine.js component. All server data is rendered with x-text (never x-html). */
function app() {
  return {
    ready: false,
    me: null,
    baseUrl: location.origin,
    authError: new URLSearchParams(location.search).get('auth_error') || '',
    route: { name: 'tunnels' },
    now: Date.now(),
    toasts: [],
    confirm: null,

    // tunnels
    tunnels: [],
    tunnelsLoaded: false,
    tunnel: null,
    tab: 'events',
    settings: {},
    revealToken: false,
    createOpen: false,
    form: { name: '', description: '' },

    // events
    events: [],
    eventsMore: false,
    selected: null,
    ws: null,
    wsState: 'closed',
    wsTimer: null,

    // logs
    logs: [],
    logsMore: false,
    logsLive: true,
    logSource: null,
    logFilters: { level: '', source: '', tunnel: '', q: '' },
    expandedLog: null,

    // ---------- lifecycle ----------
    async init() {
      if (this.authError) history.replaceState(null, '', location.pathname + location.hash);
      setInterval(() => (this.now = Date.now()), 30000);
      window.addEventListener('hashchange', () => this.onRoute());
      try {
        const r = await this.api('/api/me');
        this.me = r.user;
        this.baseUrl = r.baseUrl || location.origin;
      } catch (_) { /* not signed in */ }
      this.ready = true;
      if (this.me) {
        await this.loadTunnels();
        await this.onRoute();
      }
    },

    get initials() {
      return ((this.me?.name || this.me?.email || '?').trim()[0] || '?');
    },
    get hookUrl() {
      return this.tunnel ? `${this.baseUrl}/hook/${this.tunnel.id}` : '';
    },

    async api(path, { method = 'GET', body } = {}) {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && this.me) {
        this.me = null;
        this.authError = 'Your session expired. Please sign in again.';
      }
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || res.statusText);
      return data;
    },

    toast(message, type = 'ok') {
      const t = { id: Math.random(), message, type };
      this.toasts.push(t);
      setTimeout(() => (this.toasts = this.toasts.filter((x) => x !== t)), 3500);
    },
    fail(e) { this.toast(e.message || String(e), 'error'); },

    async logout() {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      location.href = '/';
    },

    // ---------- routing ----------
    async onRoute() {
      if (!this.me) return;
      const h = location.hash.replace(/^#\/?/, '').split('/');
      this.stopWs();
      this.stopLogStream();
      if (h[0] === 'logs') {
        this.route = { name: 'logs' };
        await this.loadTunnels();
        await this.loadLogs();
        if (this.logsLive) this.startLogStream();
      } else if (h[0] === 'tunnels' && h[1]) {
        this.route = { name: 'tunnel', id: h[1] };
        await this.openTunnel(h[1]);
      } else {
        this.route = { name: 'tunnels' };
        this.tunnel = null;
        await this.loadTunnels();
      }
    },

    // ---------- tunnels ----------
    async loadTunnels() {
      try {
        this.tunnels = (await this.api('/api/tunnels')).tunnels;
        this.tunnelsLoaded = true;
      } catch (e) { if (this.me) this.fail(e); }
    },
    openCreate() {
      this.form = { name: '', description: '' };
      this.createOpen = true;
      this.$nextTick(() => this.$refs.createName?.focus());
    },
    async createTunnel() {
      try {
        const { tunnel } = await this.api('/api/tunnels', { method: 'POST', body: this.form });
        this.createOpen = false;
        this.toast('Tunnel created');
        location.hash = `#/tunnels/${tunnel.id}`;
      } catch (e) { this.fail(e); }
    },
    async openTunnel(id) {
      this.events = []; this.selected = null; this.tab = 'events'; this.revealToken = false;
      try {
        this.tunnel = (await this.api(`/api/tunnels/${id}`)).tunnel;
        this.settings = { name: this.tunnel.name, description: this.tunnel.description,
          responseStatus: this.tunnel.responseStatus, enabled: this.tunnel.enabled };
      } catch (e) {
        this.fail(e);
        location.hash = '#/tunnels';
        return;
      }
      await this.loadEvents();
      this.connectWs();
    },
    async saveSettings() {
      try {
        this.tunnel = (await this.api(`/api/tunnels/${this.tunnel.id}`, { method: 'PATCH', body: this.settings })).tunnel;
        this.toast('Settings saved');
      } catch (e) { this.fail(e); }
    },
    async rotateToken() {
      try {
        this.tunnel = (await this.api(`/api/tunnels/${this.tunnel.id}/rotate-token`, { method: 'POST' })).tunnel;
        this.toast('Token rotated');
        this.tab = 'connect';
      } catch (e) { this.fail(e); }
    },
    async clearEvents() {
      try {
        await this.api(`/api/tunnels/${this.tunnel.id}/events`, { method: 'DELETE' });
        this.events = []; this.selected = null; this.eventsMore = false;
        this.toast('Events cleared');
      } catch (e) { this.fail(e); }
    },
    async deleteTunnel() {
      try {
        await this.api(`/api/tunnels/${this.tunnel.id}`, { method: 'DELETE' });
        this.toast('Tunnel deleted');
        location.hash = '#/tunnels';
      } catch (e) { this.fail(e); }
    },
    askConfirm(title, text, action, fn) { this.confirm = { title, text, action, fn }; },
    async runConfirm() {
      const fn = this.confirm?.fn;
      this.confirm = null;
      if (fn) await fn.call(this);
    },

    // ---------- events ----------
    async loadEvents(more = false) {
      if (!this.tunnel) return;
      const q = new URLSearchParams({ order: 'desc', limit: '50', include: 'body' });
      if (more && this.events.length) q.set('before', this.events[this.events.length - 1].id);
      try {
        const r = await this.api(`/api/tunnels/${this.tunnel.id}/events?${q}`);
        this.events = more ? this.events.concat(r.events) : r.events;
        this.eventsMore = r.hasMore;
        if (!more && !this.selected && this.events.length) this.selected = this.events[0];
      } catch (e) { this.fail(e); }
    },
    selectEvent(e) { this.selected = e; },
    async ackEvent(e) {
      try {
        const r = await this.api(`/api/tunnels/${this.tunnel.id}/events/${e.id}/ack`, { method: 'POST' });
        e.ackedAt = r.event.ackedAt;
      } catch (err) { this.fail(err); }
    },
    async removeEvent(e) {
      try {
        await this.api(`/api/tunnels/${this.tunnel.id}/events/${e.id}`, { method: 'DELETE' });
        this.events = this.events.filter((x) => x.id !== e.id);
        if (this.selected?.id === e.id) this.selected = this.events[0] || null;
      } catch (err) { this.fail(err); }
    },

    connectWs() {
      if (!this.tunnel) return;
      const id = this.tunnel.id;
      const url = this.baseUrl.replace(/^http/, 'ws') + `/api/tunnels/${id}/ws`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => (this.wsState = 'open');
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type !== 'event' || this.tunnel?.id !== id) return;
        if (this.events.some((e) => e.id === msg.event.id)) return;
        this.events.unshift(msg.event);
        if (!this.selected) this.selected = msg.event;
        this.tunnel.received++;
      };
      ws.onclose = () => {
        this.wsState = 'closed';
        if (this.ws === ws && this.tunnel?.id === id) {
          this.wsTimer = setTimeout(() => this.connectWs(), 2000);
        }
      };
    },
    stopWs() {
      clearTimeout(this.wsTimer);
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      this.wsState = 'closed';
    },

    // ---------- logs ----------
    logQuery() {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(this.logFilters)) if (v) q.set(k, v);
      return q;
    },
    async loadLogs(more = false) {
      const q = this.logQuery();
      q.set('limit', '100');
      if (more && this.logs.length) q.set('before', this.logs[this.logs.length - 1].id);
      try {
        const r = await this.api(`/api/logs?${q}`);
        this.logs = more ? this.logs.concat(r.logs) : r.logs;
        this.logsMore = r.hasMore;
      } catch (e) { this.fail(e); }
      if (!more && this.logsLive && this.route.name === 'logs') this.startLogStream();
    },
    startLogStream() {
      this.stopLogStream();
      const es = new EventSource(`/api/logs/stream?${this.logQuery()}`);
      es.onmessage = (m) => {
        const l = JSON.parse(m.data);
        if (this.logs.some((x) => x.id === l.id)) return;
        this.logs.unshift(l);
        if (this.logs.length > 1000) this.logs.length = 1000;
      };
      this.logSource = es;
    },
    stopLogStream() { this.logSource?.close(); this.logSource = null; },
    toggleLive() {
      this.logsLive = !this.logsLive;
      this.logsLive ? this.startLogStream() : this.stopLogStream();
    },
    tunnelName(id) { return this.tunnels.find((t) => t.id === id)?.name || id.slice(0, 6) + '…'; },

    // ---------- formatting ----------
    rel(ts) {
      const s = Math.max(0, Math.round((this.now - ts) / 1000));
      if (s < 10) return 'just now';
      if (s < 60) return `${s}s ago`;
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    },
    clock(ts) { return new Date(ts).toLocaleTimeString([], { hour12: false }); },
    bytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; },
    methodClass(m) {
      return { GET: 'bg-sky-100 text-sky-700', POST: 'bg-emerald-100 text-emerald-700', PUT: 'bg-amber-100 text-amber-700',
        PATCH: 'bg-amber-100 text-amber-700', DELETE: 'bg-red-100 text-red-700' }[m] || 'bg-neutral-100 text-neutral-700';
    },
    levelClass(l) {
      return { debug: 'bg-neutral-100 text-neutral-600', info: 'bg-sky-100 text-sky-700',
        warn: 'bg-amber-100 text-amber-700', error: 'bg-red-100 text-red-700' }[l] || '';
    },
    bodyText(e) {
      if (!e.size) return '(empty body)';
      if (e.bodyEncoding === 'base64') return `(binary, ${e.size} bytes, base64)\n${e.body}`;
      try { return JSON.stringify(JSON.parse(e.body), null, 2); } catch (_) { return e.body; }
    },
    curlFor(e) {
      const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
      const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
      let c = `curl -X ${e.method} ${q('http://localhost:3000' + e.path + e.query)}`;
      for (const [k, v] of Object.entries(e.headers)) if (!skip.has(k)) c += ` \\\n  -H ${q(`${k}: ${v}`)}`;
      if (e.size && e.bodyEncoding !== 'base64') c += ` \\\n  --data-raw ${q(e.body)}`;
      return c;
    },
    async copy(text) {
      try { await navigator.clipboard.writeText(text); this.toast('Copied to clipboard'); }
      catch (_) { this.toast('Copy failed', 'error'); }
    },

    get snippets() {
      if (!this.tunnel) return [];
      const base = `${this.baseUrl}/api/tunnels/${this.tunnel.id}`;
      const tok = this.tunnel.token;
      const ws = base.replace(/^http/, 'ws');
      return [
        { title: 'REST — fetch new events', code:
`curl -H "Authorization: Bearer ${tok}" \\
  "${base}/events?unacked=1&include=body"` },
        { title: 'REST — acknowledge an event', code:
`curl -X POST -H "Authorization: Bearer ${tok}" \\
  "${base}/events/<EVENT_ID>/ack"` },
        { title: 'REST — resume after a cursor', code:
`curl -H "Authorization: Bearer ${tok}" \\
  "${base}/events?after=<LAST_EVENT_ID>&include=body"` },
        { title: 'WebSocket (browser / Deno / Node 22)', code:
`const ws = new WebSocket(
  "${ws}/ws?token=${tok}&replay=unacked"
);
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.type === "event") {
    console.log(msg.event.method, msg.event.body);
    ws.send(JSON.stringify({ type: "ack", id: msg.event.id }));
  }
};` },
        { title: 'WebSocket (websocat)', code:
`websocat -H "Authorization: Bearer ${tok}" \\
  "${ws}/ws?replay=unacked"` },
      ];
    },
  };
}
