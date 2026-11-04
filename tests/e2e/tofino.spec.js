import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// The native suite uses its own isolated stack; normal BMv2 runs skip every test.
const enabled = process.env.E2E_TOFINO === 'true';
const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3002';
const container = process.env.E2E_TOFINO_NETSIM_CONTAINER || 'unicorn-tofino-integration-netsim-1';
const execute = promisify(execFile);
const workshopSource = '/p4/workshop/tofino_workshop.p4';
let switchId;
let metadata;
let program;

test.use({ baseURL });
test.describe.configure({ mode: 'serial' });
test.skip(!enabled, 'Set E2E_TOFINO=true for the isolated native model stack.');

async function json(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function selectSwitch(page, name = 's1') {
  await page.goto('/switches');
  await page.getByRole('tab', { name, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Initialization', exact: true })).toBeVisible();
}
async function newBuilderDraft(page, hostCount, targets, links) {
  await page.goto('/topology');
  await page.getByRole('button', { name: 'Topology menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New draft', exact: true }).click();
  for (let host = 0; host < hostCount; host++) await page.getByRole('button', { name: 'Add host', exact: true }).click();
  for (const target of targets) {
    await page.getByRole('combobox', { name: 'New switch target', exact: true }).click();
    await page.getByRole('option', { name: target, exact: true }).click();
    await page.getByRole('button', { name: 'Add switch', exact: true }).click();
  }
  for (const [left, right] of links) {
    await page.getByRole('button', { name: 'Add link', exact: true }).click();
    await page.getByRole('button', { name: `Select ${left.startsWith('h') ? 'host' : 'switch'} ${left}`, exact: true }).click();
    await page.getByRole('button', { name: `Select switch ${right}`, exact: true }).click();
  }
}
async function openResource(page, category, name) {
  const link = page.getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) await page.getByRole('button', { name: category, exact: true }).click();
  await link.click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}
async function compiledWorkshop(request) {
  const files = await json(await request.get('/api/p4files', { params: { switch_id: switchId } }));
  const compatible = files.programs.filter(item => item.source === workshopSource);
  expect(compatible).toHaveLength(1);
  expect(compatible[0].target).toBe('tofino');
  expect(compatible[0].build_manifest).toBeTruthy();
  return compatible[0];
}
async function writeRegisterCell(page, register, index, value) {
  const row = page.getByTestId(`resource-row-${index}`);
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  await row.getByRole('textbox', { name: `${register.fields[0].name} for index ${index}`, exact: true }).fill(value);
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId(`value-${index}`)).toHaveText(value);
}
async function importNetworkFile(page, filename, buffer) {
  await page.getByRole('button', { name: 'Network archive', exact: true }).click();
  const selecting = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Import network', exact: true }).click();
  await (await selecting).setFiles({ name: filename, mimeType: 'application/zip', buffer });
}
function resource(collection, suffix) {
  const found = Object.entries(collection || {}).find(([name, definition]) => name.endsWith(suffix) || definition.alias === suffix);
  expect(found, `The workshop should expose ${suffix}`).toBeTruthy();
  return { name: found[0], ...found[1] };
}
async function genericScreen(page) {
  await expect(page.locator('main')).not.toContainText(/BF-?RT|\.unicorn-builds|manifest\.json|context\.json|tofino\.bin/);
}

test.beforeAll(async ({ request }) => {
  // Do not allow a mistaken environment variable to mutate the live BMv2 stack.
  expect(new URL(baseURL).origin).toBe(`http://127.0.0.1:${process.env.E2E_UI_PORT || '3002'}`);
  expect(Number(new URL(baseURL).port)).toBeGreaterThanOrEqual(3002);
  expect(container.startsWith('unicorn-tofino-')).toBeTruthy();
  const active = await json(await request.get('/api/switches/active'));
  switchId = active.connections.find(connection => connection.name === 's1' && connection.target === 'tofino')?.device_id ?? 0;
  if (active.connections.some(connection => connection.device_id === switchId)) metadata = await json(await request.get('/api/init', { params: { switch_id: switchId } }));

});

test('selects targets in the topology builder and deploys with automatic switch connections', async ({ page, request }) => {
  test.setTimeout(300_000);
  await newBuilderDraft(page, 3, ['Tofino model', 'BMv2'], [['h1', 's1'], ['h2', 's1'], ['h3', 's2'], ['s1', 's2']]);
  await page.getByRole('textbox', { name: 'Latency', exact: true }).fill('2ms');
  await page.getByRole('spinbutton', { name: 'Bandwidth (Mbps)', exact: true }).fill('100');
  await page.getByRole('button', { name: 'Update link', exact: true }).click();
  const deploying = page.waitForResponse(response => response.url().endsWith('/topology/deploy') && response.request().method() === 'POST');
  const connected = page.waitForResponse(response => response.url().endsWith('/api/switches/from_topology') && response.request().method() === 'POST', { timeout: 270_000 });
  await page.getByRole('button', { name: 'Deploy topology', exact: true }).click();
  const started = await deploying;
  expect(started.status(), await started.text()).toBe(202);
  const response = await connected;
  expect(response.status(), await response.text()).toBe(200);
  const sent = JSON.parse(response.request().postDataJSON().switch_configs);
  const nativeConfig = sent.find(config => config.name === 's1');
  expect(nativeConfig.target).toBe('tofino');
  expect(nativeConfig.target_options.runtime_device_id).toBe(0);
  expect(nativeConfig.runtime_device_id).toBeUndefined();
  const active = await json(await request.get('/api/switches/active'));
  expect(active.connections.find(connection => connection.name === 's1').target).toBe('tofino');
  expect(active.connections.find(connection => connection.name === 's2').target).toBe('bmv2');
  switchId = active.connections.find(connection => connection.name === 's1').device_id;
  expect(switchId).toBe(0);
  metadata = await json(await request.get('/api/init', { params: { switch_id: switchId } }));
  const topology = await json(await request.get('/netsim/topology/get'));
  const trunk = topology.links.find(link => link.node1 === 's1' && link.node2 === 's2');
  expect(trunk.latency).toBe('2ms');
  expect(trunk.bandwidth).toBe(100);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('tofino-builder-autoconnect.png'), fullPage: true });
});

test('compiles the workshop in the shared Editor and follows its asynchronous build', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.goto('/editor');
  await page.getByRole('combobox', { name: 'P4 source file', exact: true }).click();
  await page.getByRole('option', { name: workshopSource, exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Switch to workshop/tofino_workshop.p4', exact: true })).toHaveAttribute('aria-selected', 'true');
  const compiling = page.waitForResponse(response => response.url().endsWith('/api/compile') && response.request().method() === 'POST');
  const finished = page.waitForResponse(async response => response.url().includes('/api/compile/jobs/')
    && response.request().method() === 'GET' && response.status() === 200 && ['complete', 'failed'].includes((await response.json()).status), { timeout: 150_000 });
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  const started = await compiling;
  expect(started.status(), await started.text()).toBe(202);
  expect(started.request().postDataJSON()).toEqual({ file: workshopSource });
  const job = await json(started);
  expect(job.job_id).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Compiling…', exact: true })).toBeDisabled();
  const completed = await json(await finished);
  expect(completed.status, JSON.stringify(completed.result || completed.error)).toBe('complete');
  expect(completed.job_id).toBe(job.job_id);
  expect(completed.result.program.target).toBe('tofino');
  await expect(page.getByText('Compilation completed', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Compiler output', exact: true })).toHaveValue(/Success: Compilation completed\./);
  await expect(page.getByRole('textbox', { name: 'Compiler output', exact: true })).toHaveValue(/Command:/);
  program = await compiledWorkshop(request);
  expect(program.id).toBe(completed.result.program.id);
  await page.screenshot({ path: test.info().outputPath('tofino-editor-compiled.png'), fullPage: true });
});

test('connects mixed targets and initializes the workshop through the shared UI', async ({ page, request }) => {
  program = await compiledWorkshop(request);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await selectSwitch(page);
  const active = await json(await request.get('/api/switches/active'));
  if (!active.connections.some(connection => connection.name === 's2')) {
    await page.getByRole('button', { name: 'Connect switch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add New Switch', exact: true });
    await dialog.getByRole('combobox', { name: 'Switch', exact: true }).click();
    await page.getByRole('option', { name: 's2', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Switch target', exact: true })).toContainText('BMv2');
    await dialog.getByRole('button', { name: 'Add Switch', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('tab', { name: 's1', exact: true }).click();
  }
  const mixed = await json(await request.get('/api/switches/active'));
  expect(mixed.connections.find(connection => connection.name === 's1').target).toBe('tofino');
  expect(mixed.connections.find(connection => connection.name === 's2').target).toBe('bmv2');
  await page.getByRole('button', { name: 'Edit initialization', exact: true }).click();
  await page.getByRole('combobox', { name: 'Compiled program', exact: true }).click();
  await page.getByRole('option', { name: program.name, exact: true }).and(page.locator(`[data-value=${JSON.stringify(program.id)}]`)).click();
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Advanced', exact: true })).not.toBeVisible();
  const keepEntries = page.getByRole('checkbox', { name: 'Keep existing entries', exact: true });
  if (await keepEntries.count()) await expect(keepEntries).toBeDisabled();
  await genericScreen(page);
  await page.screenshot({ path: test.info().outputPath('tofino-program-selection.png'), fullPage: true });
  const initialized = page.waitForResponse(response => response.url().endsWith('/api/init') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Initialize', exact: true }).click();
  const response = await initialized;
  expect(response.request().postDataJSON()).toEqual({ switch_id: switchId, program_id: program.id, keep_entries: false });
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole('button', { name: 'Edit initialization', exact: true })).toBeVisible();
  metadata = await json(await request.get('/api/init', { params: { switch_id: switchId } }));
  expect(metadata.program_name).toBe('tofino_workshop');
  expect(metadata.program_manifest).toBe(program.id);
  expect(errors).toEqual([]);
});

test('edits the workshop registers through their typed shared controls', async ({ page, request }) => {
  await selectSwitch(page);
  for (const [alias, value] of [['lower_last_ts_series', '4294967295'], ['higher_last_ts_series', '65535']]) {
    const register = resource(metadata.registers, alias);
    await openResource(page, 'Registers', register.name);
    const index = String(register.size - 1);
    await page.getByRole('textbox', { name: 'Index', exact: true }).fill(index);
    await writeRegisterCell(page, register, index, value);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId(`value-${index}`)).toHaveText(value);
    const readback = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: register.id, index } }));
    expect(readback.entries[0].value).toBe(value);
    await genericScreen(page);
  }
  await page.screenshot({ path: test.info().outputPath('tofino-registers.png'), fullPage: true });
});

test('adds a workshop MAT entry and edits its direct meter with the declared units', async ({ page, request }) => {
  await selectSwitch(page);
  const meter = resource(metadata.direct_meters, 'flow_meter_instance');
  const table = Object.values(metadata.table_info).find(item => item.table_id === meter.table_id);
  expect(table).toBeTruthy();
  await openResource(page, 'Tables', table.table_name);
  await page.getByRole('button', { name: 'Add new Entry', exact: true }).click();
  const adding = page.getByRole('dialog', { name: 'Add a new entry', exact: true });
  await adding.locator('input[name="match_value1"]').fill('3325256926'); // 198.51.100.222
  await adding.locator('input[name="match_value2"]').fill('32');
  await adding.getByRole('combobox', { name: 'Action', exact: true }).click();
  await page.getByRole('option', { name: 'set_color_direct', exact: true }).click();
  await adding.getByRole('button', { name: 'Add Entry', exact: true }).click();
  await expect(adding).not.toBeVisible();
  const row = page.getByRole('row').filter({ hasText: /3325256926|198\.51\.100\.222/ }).filter({ has: page.getByRole('button', { name: 'Edit meter', exact: true }) }).first();
  await row.getByRole('button', { name: 'Edit meter', exact: true }).click();
  const editing = page.getByRole('dialog', { name: 'Edit direct meter', exact: true });
  await expect(editing).toContainText('kilobits/s');
  await expect(editing.getByRole('button', { name: 'Reset meter', exact: true })).not.toBeVisible();
  for (const [label, value] of Object.entries({ CIR: '5000', CBS: '512', PIR: '10000', PBS: '1024' })) {
    await editing.getByRole('textbox', { name: label, exact: true }).fill(value);
  }
  await editing.getByRole('button', { name: 'Save meter', exact: true }).click();
  await expect(editing.getByRole('status')).toContainText('Saved');
  const readback = await json(await request.get('/api/direct-meters', { params: { switch_id: switchId, meter_id: meter.id } }));
  const configured = readback.entries.find(item => item.table_entry.match_fields['hdr.ipv4.dst_addr'][0] === '3325256926');
  expect(BigInt(configured.config.pir)).toBeGreaterThan(0n);
  await expect(editing.getByRole('textbox', { name: 'PIR', exact: true })).toHaveValue(configured.config.pir);
  await page.screenshot({ path: test.info().outputPath('tofino-direct-meter.png'), fullPage: true });
  await editing.getByRole('button', { name: 'Cancel', exact: true }).click();
  await genericScreen(page);
});

test('saves and restores a native MAT snapshot through Saved and History', async ({ page, request }) => {
  await selectSwitch(page);
  const table = Object.values(metadata.table_info).find(item => item.table_name.endsWith('.meter_c.flow_meter_instance'));
  await openResource(page, 'Tables', table.table_name);
  const snapshotName = `Native E2E snapshot ${Date.now()}`;
  await page.getByRole('button', { name: 'Save state', exact: true }).click();
  const saving = page.getByRole('dialog', { name: 'Save State', exact: true });
  await saving.getByRole('textbox', { name: 'State Name', exact: true }).fill(snapshotName);
  await saving.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saving).not.toBeVisible();
  const saved = await json(await request.get('/api/saved'));
  const snapshot = saved.find(state => state.name === snapshotName);
  expect(snapshot.target).toBe('tofino');
  expect(snapshot.program_manifest).toBe(program.id);
  expect(snapshot.program_name).toBe('tofino_workshop');
  const key = '3325256926';
  const original = snapshot.table_entries[table.table_name].find(row => row.switch_entry.match_fields['hdr.ipv4.dst_addr']?.[0] === key).switch_entry;
  expect(original.action_name).toMatch(/set_color_direct$/);
  const row = page.getByRole('row').filter({ hasText: /3325256926|198\.51\.100\.222/ }).filter({ has: page.getByRole('button', { name: 'Edit meter', exact: true }) }).first();
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  const currentAction = async () => {
    const rows = await json(await request.get('/api/tables', { params: { switch_id: switchId, table_name: table.table_name } }));
    return rows.find(item => item.switch_entry.match_fields['hdr.ipv4.dst_addr']?.[0] === key)?.switch_entry.action_name;
  };
  await expect.poll(currentAction).toBeUndefined();
  await page.getByRole('link', { name: 'Saved', exact: true }).click();
  await page.getByText(snapshotName, { exact: true }).click();
  await expect(page.getByRole('cell', { name: 'tofino_workshop', exact: true })).toBeVisible();
  const restored = page.waitForResponse(response => response.url().endsWith('/api/init') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Re-Initialize state', exact: true }).click();
  const response = await restored;
  expect(response.request().postDataJSON()).toEqual({ switch_id: switchId, program_id: snapshot.program_manifest, keep_entries: false, state_id: snapshot.id });
  expect(response.status(), await response.text()).toBe(200);
  await expect.poll(currentAction).toBe(original.action_name);
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByText(/tofino_workshop.*currently initialized/).first()).toBeVisible();
  await genericScreen(page);
  await page.screenshot({ path: test.info().outputPath('tofino-native-snapshot-history.png'), fullPage: true });
  metadata = await json(await request.get('/api/init', { params: { switch_id: switchId } }));
});

test('shows real workshop counter and digest events after Mininet traffic', async ({ page, request }) => {
  test.setTimeout(180_000);
  const helper = fileURLToPath(new URL('../tofino/workshop_api.py', import.meta.url));
  const result = await execute(process.env.E2E_TOFINO_PYTHON || 'python3', [helper, '--base-url', baseURL, '--container', container], { timeout: 120_000 });
  const observed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  expect(observed.result).toBe('PASS');
  expect(observed.forwarded_bytes).toBeGreaterThan(0);
  expect(observed.digest_events).toBeGreaterThan(0);
  await test.info().attach('native-workshop-traffic', { body: result.stdout, contentType: 'application/json' });
  await selectSwitch(page);
  const table = Object.values(metadata.table_info).find(item => item.table_name.endsWith('.counter_c.mat_flow_counter'));
  await openResource(page, 'Tables', table.table_name);
  await expect(page.getByRole('button', { name: 'Reset non-default counters', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Digests', exact: true }).click();
  await expect(page.getByText('Digest delivery is managed by the switch. Timeout and list-size settings are unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enable digest', exact: true })).not.toBeVisible();
  const events = await json(await request.get('/api/digest-events', { params: { switch_id: switchId } }));
  expect(events.events.length).toBeGreaterThan(0);
  await expect(page.locator('[data-testid^="digest-event-"]').first()).toBeVisible();
  const decoded = page.getByRole('table', { name: 'Digest field values', exact: true }).first();
  await expect(decoded).toContainText('dst_addr');
  await expect(decoded).toContainText('ingress_mac_timestamp');
  await expect(decoded).toContainText('167772418'); // 10.0.1.2, preserved as an exact decimal string
  await genericScreen(page);
  await page.screenshot({ path: test.info().outputPath('tofino-digests.png'), fullPage: true });
});

test('uses the shared queue screen with supported port shaping fields', async ({ page }) => {
  await selectSwitch(page);
  await page.getByRole('link', { name: 'Queues', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Packet burst', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Queue depth (packets)', exact: true })).not.toBeVisible();
  await expect(page.getByText('Values come from switch readback. Rates may be rounded by the switch.', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Target queues', exact: true }).click();
  await expect(page.getByRole('option', { name: 'All ports', exact: true })).not.toBeVisible();
  await page.getByRole('option', { name: 'One port', exact: true }).click();
  await expect(page.getByRole('listbox')).not.toBeVisible();
  await genericScreen(page);
  await page.screenshot({ path: test.info().outputPath('tofino-queues.png'), fullPage: true });
});


test('exports and asynchronously restores the native network through the shared archive UI', async ({ page, request }) => {
  test.setTimeout(420_000); // Capture can take 90s; restoration has its own 240s budget.
  // Every switch in a mixed archive needs a restorable pipeline. Exercise the
  // same selector on BMv2 as on the native switch, preserving legacy init args.
  const compiled = await request.post('/api/compile', { data: { file: '/p4/resources.p4' } });
  expect(compiled.status(), await compiled.text()).toBe(200);
  const active = await json(await request.get('/api/switches/active'));
  const otherId = active.connections.find(connection => connection.name === 's2').device_id;
  const files = await json(await request.get('/api/p4files', { params: { switch_id: otherId } }));
  expect(files.programs.some(item => item.target === 'tofino')).toBe(false);
  const legacy = files.programs.find(item => item.source === '/p4/resources.p4');
  expect(legacy.p4_info).toBeTruthy();
  expect(legacy.bmv2).toBeTruthy();
  await page.goto('/switches');
  await page.getByRole('tab', { name: 's2', exact: true }).click();
  await page.getByRole('button', { name: 'Edit initialization', exact: true }).click();
  await page.getByRole('combobox', { name: 'Compiled program', exact: true }).click();
  await expect(page.getByRole('option').filter({ hasText: 'tofino_workshop' })).toHaveCount(0);
  await page.getByRole('option', { name: legacy.name, exact: true }).and(page.locator(`[data-value=${JSON.stringify(legacy.id)}]`)).click();
  const initialized = page.waitForResponse(response => response.url().endsWith('/api/init') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Initialize', exact: true }).click();
  const response = await initialized;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ switch_id: otherId, p4_info_file: legacy.p4_info, bmv2_file: legacy.bmv2, keep_entries: false, state_id: null });
  await expect(page.getByRole('button', { name: 'Edit initialization', exact: true })).toBeVisible();
  await selectSwitch(page);
  const register = resource(metadata.registers, 'lower_last_ts_series');
  const index = String(register.size - 1), marker = '3141592653';
  await openResource(page, 'Registers', register.name);
  await page.getByRole('textbox', { name: 'Index', exact: true }).fill(index);
  await writeRegisterCell(page, register, index, marker);
  const downloading = page.waitForEvent('download', { timeout: 120_000 });
  const exported = page.waitForResponse(response => response.url().endsWith('/api/network/export') && response.request().method() === 'GET', { timeout: 120_000 });
  await page.getByRole('button', { name: 'Network archive', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export network', exact: true }).click();
  const exportResponse = await exported;
  expect(exportResponse.status(), exportResponse.status() === 200 ? '' : await exportResponse.text()).toBe(200);
  expect(exportResponse.headers()['content-type']).toContain('application/zip');
  const bundle = await readFile(await (await downloading).path());
  expect(bundle.length).toBeGreaterThan(1000);
  // A changed running value proves import replays the captured state.
  await writeRegisterCell(page, register, index, '17');
  const changed = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: register.id, index } }));
  expect(changed.entries[0].value).toBe('17');
  await importNetworkFile(page, 'native-roundtrip.zip', bundle);
  const dialog = page.getByRole('dialog', { name: 'Import network', exact: true });
  await expect(dialog.getByRole('table', { name: 'Switches in network bundle', exact: true })).toContainText('s1');
  await expect(dialog.getByRole('table', { name: 'Switches in network bundle', exact: true })).toContainText('s2');
  const deploying = page.waitForResponse(response => response.url().endsWith('/api/network/import/deploy') && response.request().method() === 'POST');
  const finished = page.waitForResponse(async response => new URL(response.url()).pathname === '/api/network/import/deploy'
    && response.request().method() === 'GET' && response.status() === 200 && !['pending', 'running'].includes((await response.json()).status), { timeout: 270_000 });
  await dialog.getByRole('button', { name: 'Import and deploy', exact: true }).click();
  const started = await deploying;
  expect(started.status(), await started.text()).toBe(202);
  expect(started.request().postDataJSON().async).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Importing network…', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('status').filter({ hasText: /Preparing import|Starting network|Restoring/ }).first()).toBeVisible();
  const deployed = await json(await finished);
  expect(deployed.status).toBe('complete');
  const report = deployed.result;
  await test.info().attach('mixed-network-restoration', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(report.error).toBeFalsy();
  for (const target of report.switches) expect(target.errors || [], target.name).toEqual([]);
  const native = report.switches.find(target => target.name === 's1');
  expect(native.errors || []).toEqual([]);
  expect(native.categories.registers.failed || 0).toBe(0);
  expect(native.categories.registers.restored).toBeGreaterThan(0);
  expect(report.topology.switches.s1.target).toBe('tofino');
  const restoration = dialog.getByRole('region', { name: 'Network restoration report', exact: true });
  await expect(restoration).toBeVisible();
  await expect(restoration.getByText(/^(?:Network imported successfully|Network imported with warnings)\.$/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await restoration.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('tofino-network-restored.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  metadata = await json(await request.get('/api/init', { params: { switch_id: switchId } }));
  expect(metadata.target).toBe('tofino');
  expect(metadata.program_name).toBe('tofino_workshop');
  const restored = resource(metadata.registers, 'lower_last_ts_series');
  const values = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: restored.id, index } }));
  expect(values.entries[0].value).toBe(marker);
  await selectSwitch(page);
  await openResource(page, 'Registers', restored.name);
  await page.getByRole('textbox', { name: 'Index', exact: true }).fill(index);
  await expect(page.getByTestId(`value-${index}`)).toHaveText(marker);
  await genericScreen(page);
});

test('isolates two simultaneous native models with the same runtime device ID', async ({ page, request }) => {
  test.setTimeout(600_000);
  await newBuilderDraft(page, 2, ['Tofino model', 'Tofino model'], [['h1', 's1'], ['h2', 's2']]);
  const connected = page.waitForResponse(response => response.url().endsWith('/api/switches/from_topology')
    && response.request().method() === 'POST', { timeout: 510_000 });
  await page.getByRole('button', { name: 'Deploy topology', exact: true }).click();
  const response = await connected;
  expect(response.status(), await response.text()).toBe(200);
  const active = await json(await request.get('/api/switches/active'));
  expect(active.connections).toHaveLength(2);
  expect(active.connections.map(connection => connection.device_id).sort()).toEqual([0, 1]);
  expect(new Set(active.connections.map(connection => connection.address)).size).toBe(2);
  for (const connection of active.connections) {
    expect(connection.target).toBe('tofino');
    expect(connection.target_options.runtime_device_id).toBe(0);
    expect(connection.target_options.pipe_id).toBe(0);
  }
  switchId = active.connections.find(connection => connection.name === 's1').device_id;
  const sharedProgram = await compiledWorkshop(request);
  const values = { s1: '4294967295', s2: '1234567890' };
  const registers = {};
  for (const connection of active.connections) {
    await selectSwitch(page, connection.name);
    await page.getByRole('button', { name: 'Edit initialization', exact: true }).click();
    await page.getByRole('combobox', { name: 'Compiled program', exact: true }).click();
    await page.getByRole('option', { name: sharedProgram.name, exact: true }).and(page.locator(`[data-value=${JSON.stringify(sharedProgram.id)}]`)).click();
    const initialized = page.waitForResponse(result => result.url().endsWith('/api/init') && result.request().method() === 'POST');
    await page.getByRole('button', { name: 'Initialize', exact: true }).click();
    const result = await initialized;
    expect(result.status(), await result.text()).toBe(200);
    expect(result.request().postDataJSON()).toEqual({ switch_id: connection.device_id, program_id: sharedProgram.id, keep_entries: false });
    await expect(page.getByRole('button', { name: 'Edit initialization', exact: true })).toBeVisible();
    const info = await json(await request.get('/api/init', { params: { switch_id: connection.device_id } }));
    expect(info.program_manifest).toBe(sharedProgram.id);
    const register = resource(info.registers, 'lower_last_ts_series');
    registers[connection.name] = register;
    await openResource(page, 'Registers', register.name);
    await page.getByRole('textbox', { name: 'Index', exact: true }).fill('4095');
    await writeRegisterCell(page, register, '4095', values[connection.name]);
  }
  // Re-read both after the second write: separate endpoint strings alone do not
  // establish that the runtime state and native device zero are isolated.
  for (const connection of active.connections) {
    const register = registers[connection.name];
    const readback = await json(await request.get('/api/registers', { params: { switch_id: connection.device_id, register_id: register.id, index: '4095' } }));
    expect(readback.entries[0].value).toBe(values[connection.name]);
    await selectSwitch(page, connection.name);
    await openResource(page, 'Registers', register.name);
    await page.getByRole('textbox', { name: 'Index', exact: true }).fill('4095');
    await expect(page.getByTestId('value-4095')).toHaveText(values[connection.name]);
    await genericScreen(page);
    await page.screenshot({ path: test.info().outputPath(`tofino-isolated-${connection.name}.png`), fullPage: true });
  }
});
