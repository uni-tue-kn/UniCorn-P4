import { describe, expect, it } from 'vitest';
import { compileErrorMessage, compilerDiagnostics, formatCompileCommand } from './compile';

describe('compiler command formatting', () => {
  it('keeps argument strings and legacy repr verbatim, including quoted filenames', () => {
    const file = "/p4/O'Brien program.p4";
    const legacy = `['p4c', "/p4/O'Brien program.p4", '--target', 'bmv2']`;
    expect(formatCompileCommand(['p4c', file, '--target', 'bmv2'])).toBe(`p4c ${file} --target bmv2`);
    expect(formatCompileCommand(legacy)).toBe(legacy);
  });

  it.each([undefined, null, { command: 'unexpected' }, ['p4c', 3], 23])('ignores malformed command metadata (%s)', command => {
    expect(formatCompileCommand(command)).toBe('');
  });
});

describe('compiler error messages', () => {
  it('prefers actual compiler stderr over generic HTTP messages', () => {
    expect(compileErrorMessage({ message: 'Request failed', response: { data: { stderr: 'Syntax error', error: 'Compilation failed' } } })).toBe('Syntax error');
  });
  it('accepts plain server errors, structured errors, and request-parser messages', () => {
    expect(compileErrorMessage({ response: { data: 'Compiler unavailable' } })).toBe('Compiler unavailable');
    expect(compileErrorMessage({ response: { data: { error: 'Source outside workspace' } } })).toBe('Source outside workspace');
    expect(compileErrorMessage({ response: { data: { message: { file: 'Missing source file', other: 'Missing option' } } } })).toBe('Missing source file\nMissing option');
  });
  it('handles network failures and incomplete error responses', () => {
    expect(compileErrorMessage(new Error('Network Error'))).toBe('Network Error');
    expect(compileErrorMessage({ response: { data: { stderr: '', message: {} } } })).toBe('Compilation failed.');
    expect(compileErrorMessage(undefined)).toBe('Compilation failed.');
  });
});

describe('compiler source diagnostics', () => {
  it('parses p4c parenthesized line/column and conventional colon locations', () => {
    expect(compilerDiagnostics([
      '/p4/main.p4(12): error: unexpected token',
      '/p4/src/headers.p4(4:7): warning: unused declaration',
      '/p4/types.p4(5,9): error: invalid type',
      '/p4/main.p4:8:3: error: expected semicolon',
    ].join('\n'), '/p4')).toEqual([
      { path: 'main.p4', line: 12, column: 1, severity: 'error', message: 'error: unexpected token' },
      { path: 'src/headers.p4', line: 4, column: 7, severity: 'warning', message: 'warning: unused declaration' },
      { path: 'types.p4', line: 5, column: 9, severity: 'error', message: 'error: invalid type' },
      { path: 'main.p4', line: 8, column: 3, severity: 'error', message: 'error: expected semicolon' },
    ]);
  });

  it('retains spaces and apostrophes in quoted source filenames', () => {
    const output = `"/p4/O'Brien program.p4"(3:2): error: bad field\n'/p4/other program.p4':4:9: warning: unused header`;
    expect(compilerDiagnostics(output, '/p4').map(item => [item.path, item.line, item.column])).toEqual([
      ["O'Brien program.p4", 3, 2], ['other program.p4', 4, 9],
    ]);
  });

  it('does not turn external file locations or parent traversals into editor links', () => {
    const output = ['/outside/main.p4:2:3: error: external', '/p4-other/main.p4(1): error: outside root', '../secret.p4(5): error: parent traversal', 'src/../../secret.p4:2: error: traversal'].join('\n');
    expect(compilerDiagnostics(output, '/p4')).toEqual([]);
  });

  it('uses valid one-based source coordinates', () => {
    expect(compilerDiagnostics('/p4/main.p4:0:0: error: invalid location', '/p4')[0]).toMatchObject({ line: 1, column: 1 });
  });

  it('does not classify an error mentioning an identifier named warning as a warning', () => {
    expect(compilerDiagnostics('/p4/main.p4(3): error: unknown identifier warning', '/p4')[0].severity).toBe('error');
  });

  it('skips include-stack context lines rather than creating invalid file links', () => {
    expect(compilerDiagnostics('In file included from /p4/main.p4:12: included here', '/p4')).toEqual([]);
  });
});
