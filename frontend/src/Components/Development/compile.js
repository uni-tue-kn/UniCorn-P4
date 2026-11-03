export function formatCompileCommand(command) {
  if (Array.isArray(command) && command.every(argument => typeof argument === 'string')) return command.join(' ');
  return typeof command === 'string' ? command : '';
}

export function compileErrorMessage(error) {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data;
  for (const key of ['stderr', 'error', 'message']) {
    if (typeof data?.[key] === 'string' && data[key].trim()) return data[key];
  }
  if (data?.message && typeof data.message === 'object') {
    const messages = Object.values(data.message).filter(value => typeof value === 'string');
    if (messages.length) return messages.join('\n');
  }
  return error?.message || 'Compilation failed.';
}

export function compilerDiagnostics(output, root, source = '', knownPaths = []) {
  const result = [];
  for (const line of output.split('\n')) {
    if (/^\s*(?:In file included from|from\s+)/.test(line)) continue;
    // Both p4c styles occur: source.p4(12): ... and source.p4:12:3: ... .
    const match = line.match(/^(.+?)\((\d+)(?:(?::|,)(\d+))?\):\s*(.*)$/)
      || line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(.*)$/);
    if (!match) continue;
    const absolute = match[1].replace(/^['"]|['"]$/g, '');
    let path = absolute.startsWith(root + '/') ? absolute.slice(root.length + 1) : absolute;
    if (path.startsWith('/')) continue;
    if (!knownPaths.includes(path) && !absolute.startsWith(root + '/') && source) {
      const relativeSource = source.startsWith(root + '/') ? source.slice(root.length + 1) : source;
      const directory = relativeSource.split('/').slice(0, -1).join('/');
      path = directory ? `${directory}/${path}` : path;
    }
    const normalized = [];
    for (const part of path.split('/')) {
      if (part === '..') { if (!normalized.length) { normalized.push('..'); break; } normalized.pop(); }
      else if (part && part !== '.') normalized.push(part);
    }
    if (normalized.includes('..') || !normalized.length) continue;
    path = normalized.join('/');
    result.push({ path, line: Math.max(1, Number(match[2])), column: Math.max(1, Number(match[3] || 1)),
      severity: /^(?:\[[^\]]*\]\s*)?warning\s*:/i.test(match[4]) ? 'warning' : 'error', message: match[4] });
  }
  return result;
}
