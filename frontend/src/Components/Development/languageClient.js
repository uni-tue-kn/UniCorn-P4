import axios from 'axios';

// A small LSP transport for the server's advertised P4 capabilities. Keeping
// JSON-RPC here lets the editor use an ordinary same-origin HTTP connection.
export class P4LanguageClient {
  constructor({ onDiagnostics, onStatus }) {
    this.onDiagnostics = onDiagnostics;
    this.onStatus = onStatus;
    this.documents = new Map();
    this.sent = new Map();
    this.pending = new Map();
    this.nextId = 1;
    this.nextVersion = 1;
    this.generation = 0;
    this.closed = false;
    this.sequence = Promise.resolve();
    this.onPageHide = event => { if (!event.persisted) this.dispose(true); };
    window.addEventListener('pagehide', this.onPageHide);
    this.ready = this.initialize();
  }
  async initialize() {
    const generation = ++this.generation;
    this.onStatus({ state: 'connecting' });
    try {
      const { data } = await axios.post('/language/sessions', {}, { timeout: 20000 });
      if (this.closed || generation !== this.generation) { await axios.delete(`/language/sessions/${data.session_id}`); return false; }
      this.session = data.session_id;
      this.capabilities = data.capabilities || {};
      this.onStatus({ state: 'ready', server: data.server, capabilities: this.capabilities });
      this.poll();
      return true;
    } catch (error) {
      if (!this.closed && generation === this.generation) this.onStatus({ state: 'unavailable', message: error.response?.data?.error || error.message });
      return false;
    }
  }
  receive(messages = []) {
    if (this.closed) return;
    for (const message of messages) {
      if (message.method === 'textDocument/publishDiagnostics') {
        const current = this.documents.get(message.params?.uri);
        if (current && (message.params.version == null || message.params.version === current.version)) this.onDiagnostics(message.params);
      } else if (message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || 'Language request failed.'));
        else pending.resolve(message.result);
      }
    }
  }
  async poll(generation = this.generation) {
    if (this.closed || generation !== this.generation) return;
    try {
      const { data } = await axios.get(`/language/sessions/${this.session}`, { timeout: 10000 });
      if (generation === this.generation) this.receive(data.messages);
    } catch (error) {
      if (!this.closed && generation === this.generation) this.onStatus({ state: 'unavailable', message: error.response?.data?.error || error.message });
      if ([404, 410].includes(error.response?.status)) return;
    }
    if (!this.closed && generation === this.generation) this.pollTimer = setTimeout(() => this.poll(generation), document.hidden ? 5000 : 800);
  }
  sync(documents) {
    const next = new Map();
    for (const doc of documents) {
      const previous = this.documents.get(doc.uri);
      // A reopened URI may still be open in an unacknowledged HTTP snapshot.
      // Never reuse its old version: that could skip changed text or accept
      // diagnostics from its earlier lifetime. One counter bounds bookkeeping.
      next.set(doc.uri, { ...doc, version: previous && previous.text === doc.text ? previous.version : this.nextVersion++ });
      if (!previous || previous.text !== doc.text) this.onDiagnostics({ uri: doc.uri, diagnostics: [], version: next.get(doc.uri).version });
    }
    this.documents = next;
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => { this.flush().catch(() => {}); }, 250);
  }
  flush() {
    const generation = this.generation, ready = this.ready;
    this.sequence = this.sequence.catch(() => {}).then(async () => {
      if (!(await ready) || this.closed || generation !== this.generation) return false;
      const snapshot = new Map(this.documents), messages = [];
      for (const uri of this.sent.keys()) if (!snapshot.has(uri)) messages.push({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri } } });
      for (const [uri, doc] of snapshot) {
        if (!this.sent.has(uri)) messages.push({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'p4', version: doc.version, text: doc.text } } });
        else if (this.sent.get(uri) !== doc.version) messages.push({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: doc.version }, contentChanges: [{ text: doc.text }] } });
      }
      if (messages.length) {
        let data;
        try { ({ data } = await axios.post(`/language/sessions/${this.session}`, { messages }, { timeout: 15000 })); }
        catch (error) { if (!this.closed && generation === this.generation) this.onStatus({ state: 'unavailable', message: error.response?.data?.error || error.message }); throw error; }
        if (this.closed || generation !== this.generation) return false;
        this.sent = new Map([...snapshot].map(([uri, doc]) => [uri, doc.version]));
        this.receive(data.messages);
      }
      return true;
    });
    return this.sequence;
  }
  async request(method, params) {
    const generation = this.generation;
    if (!(await this.flush()) || this.closed || generation !== this.generation) return null;
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Language request timed out.')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
    });
    // Attach a rejection handler immediately, including while HTTP is pending.
    response.catch(() => {});
    try {
      const { data } = await axios.post(`/language/sessions/${this.session}`, { messages: [{ jsonrpc: '2.0', id, method, params }] }, { timeout: 12000 });
      if (!this.closed && generation === this.generation) this.receive(data.messages);
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); }
    }
    return response;
  }
  async reconnect() {
    if (this.closed) return false;
    clearTimeout(this.pollTimer); clearTimeout(this.changeTimer);
    if (this.session) axios.delete(`/language/sessions/${this.session}`).catch(() => {});
    this.session = null; this.sent.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Language server reconnected.')); }
    this.pending.clear(); this.sequence = Promise.resolve();
    this.ready = this.initialize();
    return this.flush();
  }
  dispose(keepalive = false) {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.pollTimer); clearTimeout(this.changeTimer);
    window.removeEventListener('pagehide', this.onPageHide);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Editor closed.')); }
    this.pending.clear();
    if (this.session) {
      if (keepalive) fetch(`${(axios.defaults?.baseURL || '/api').replace(/\/$/, '')}/language/sessions/${this.session}`, { method: 'DELETE', keepalive: true }).catch(() => {});
      else axios.delete(`/language/sessions/${this.session}`).catch(() => {});
    }
  }
}
