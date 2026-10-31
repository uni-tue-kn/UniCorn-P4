import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.describe.configure({ mode: 'serial' });
let switchId;
let otherId;
let metadata;
const forward = 'IngressImpl.forward';
const register = 'IngressImpl.test_register';
const meter = 'IngressImpl.test_meter';
const directMeter = 'IngressImpl.test_direct_meter';
const entry = (ingress, port) => ({
  table_name: forward, match_fields: { 'standard_metadata.ingress_port': String(ingress) },
  action_name: 'IngressImpl.send', action_params: { port: String(port) }, priority: null,
});

async function json(response) {
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function selectSwitch(page) {
  await page.goto('/switches');
  await page.getByRole('tab', { name: 's1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Initialization', exact: true })).toBeVisible();
}

async function topologyAction(page, name) {
  await page.getByRole('button', { name: 'Topology menu', exact: true }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

async function importSavedTopology(page, filename) {
  await topologyAction(page, 'Import saved topology');
  const dialog = page.getByRole('dialog', { name: 'Import saved topology', exact: true });
  await dialog.getByRole('combobox', { name: 'Saved topology', exact: true }).click();
  await page.getByRole('option', { name: filename, exact: true }).click();
  await dialog.getByRole('button', { name: 'Import topology', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function importNetworkFile(page, filename, buffer) {
  await page.getByRole('button', { name: 'Network archive', exact: true }).click();
  const selecting = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: 'Import network', exact: true }).click();
  await (await selecting).setFiles({ name: filename, mimeType: 'application/zip', buffer });
}

async function openTerminals(page) {
  await page.goto('/terminals');
  await expect(page.getByText('Connected. Output is kept while you switch between pages.', { exact: true })).toBeVisible();
}

async function hostTraffic(page, count = 2, wait = true) {
  await openTerminals(page);
  await page.getByRole('tab', { name: 'h1 (Host)', exact: true }).click();
  const marker = `TRAFFIC_DONE_${Date.now()}`;
  const input = page.locator('input').last();
  await input.fill(`ping -c ${count} -i 0.2 -W 2 10.0.1.2; unicorn_ping_status=$?; echo ${marker}=$unicorn_ping_status`);
  await input.press('Enter');
  if (wait) {
    // The completion marker cannot match the echoed command. Old terminal
    // output containing "0% packet loss" must not satisfy a fresh traffic test.
    await expect(page.locator('main')).toContainText(`${marker}=0`, { timeout: 25_000 });
    const losses = [...(await page.locator('main').innerText()).matchAll(/(\d+(?:\.\d+)?)% packet loss/g)];
    expect(losses.length).toBeGreaterThan(0);
    expect(Number(losses.at(-1)[1])).toBe(0);
  }
  return marker;
}

test('compile, load a two-switch topology and initialize through the browser', async ({ page, request }) => {
  // Serial retries reuse the isolated database; remove only this suite's snapshot.
  const previousSnapshots = await json(await request.get('/api/saved'));
  for (const snapshot of previousSnapshots.filter(state => state.name === 'E2E snapshot')) {
    expect((await request.delete('/api/saved', { data: { state_id: snapshot.id } })).ok()).toBeTruthy();
  }
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/compile');
  await page.getByRole('combobox', { name: 'P4 source file' }).click();
  await page.getByRole('option', { name: '/p4/resources.p4', exact: true }).click();
  const compiled = page.waitForResponse(r => r.url().endsWith('/api/compile') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Compile', exact: true }).click();
  expect((await compiled).status()).toBe(200);
  const compiledFiles = await json(await request.get('/api/p4files'));
  expect(compiledFiles.programs.filter(program => program.id === '/p4/resources.json')).toEqual([
    { id: '/p4/resources.json', name: 'resources', p4_info: '/p4/resources.p4info.txt', bmv2: '/p4/resources.json', source: '/p4/resources.p4' },
  ]);

  await page.getByRole('link', { name: 'Topology', exact: true }).click();
  await importSavedTopology(page, 'topology.json');
  await expect(page.getByRole('group', { name: 'Topology canvas', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Select switch s2', exact: true })).toBeVisible();
  const connected = page.waitForResponse(r => r.url().endsWith('/api/switches/from_topology') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Deploy topology', exact: true }).click();
  expect((await connected).status()).toBe(200);
  await expect(page.getByRole('tab', { name: 's2', exact: true })).toBeVisible();
  await selectSwitch(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Edit initialization', exact: true }).click();
  await page.getByRole('combobox', { name: 'Compiled program', exact: true }).click();
  await page.getByRole('option', { name: 'resources', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'P4Info file', exact: true })).not.toBeVisible();
  await page.screenshot({ path: test.info().outputPath('program-selection.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'P4Info file', exact: true })).toContainText('/resources.p4info.txt');
  await expect(page.getByRole('combobox', { name: 'BMv2 JSON file', exact: true })).toContainText('/resources.json');
  await page.locator('main').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ path: test.info().outputPath('program-selection-advanced.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const initialized = page.waitForResponse(r => r.url().endsWith('/api/init') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Initialize', exact: true }).click();
  expect((await initialized).status()).toBe(200);

  const active = await json(await request.get('/api/switches/active'));
  switchId = active.connections.find(s => s.name === 's1').device_id;
  otherId = active.connections.find(s => s.name === 's2').device_id;
  metadata = await json(await request.get('/api/init', { params: { switch_id: switchId } }));
  expect(metadata.registers[register]).toBeTruthy();
  expect(metadata.meters[meter]).toBeTruthy();
  expect(metadata.direct_meters[directMeter]).toBeTruthy();
  expect(metadata.digests.traffic_digest_t).toBeTruthy();
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('initialized.png'), fullPage: true });
});

test('MAT single and bulk editing round-trip through the UI', async ({ page, request }) => {
  await selectSwitch(page);
  await page.getByRole('button', { name: 'Tables', exact: true }).click();
  await page.getByRole('link', { name: forward, exact: true }).click();
  await page.getByRole('button', { name: 'Add new Entry', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a new entry' });
  await dialog.getByRole('textbox', { name: 'Value', exact: true }).fill('1');
  await dialog.getByRole('combobox', { name: 'Action', exact: true }).click();
  await page.getByRole('option', { name: 'send', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'port', exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Add Entry', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'port', exact: true }).fill('3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => {
    const rows = await json(await request.get('/api/tables', { params: { switch_id: switchId, table_name: forward } }));
    return String(rows[0]?.switch_entry.action_params.port);
  }).toBe('3');
  await page.getByRole('button', { name: 'Edit Table Entries', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(/The table is empty/)).toBeVisible();
});

test('registers preserve index zero and 64-bit values through P4Runtime', async ({ request }) => {
  const registerId = metadata.registers[register].id;
  await json(await request.patch('/api/registers', { data: {
    switch_id: switchId, register_id: registerId, entries: [{ index: 0, value: '4294967295' }],
  } }));
  let response = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: registerId, index: 0 } }));
  expect(response.entries).toEqual([{ index: 0, value: '4294967295' }]);
  const wideId = metadata.registers['IngressImpl.wide_register'].id;
  await json(await request.patch('/api/registers', { data: {
    switch_id: switchId, register_id: wideId, entries: [{ index: 0, value: '18446744073709551615' }],
  } }));
  response = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: wideId, index: 0 } }));
  expect(response.entries[0].value).toBe('18446744073709551615');
  for (const [name, value] of [['IngressImpl.signed_register', '-65536'], ['IngressImpl.signed_wide_register', '-9223372036854775808']]) {
    const id = metadata.registers[name].id;
    await json(await request.patch('/api/registers', { data: {
      switch_id: switchId, register_id: id, entries: [{ index: 0, value }],
    } }));
    const read = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: id, index: 0 } }));
    expect(read.entries[0].value).toBe(value);
  }
  const invalid = await request.patch('/api/registers', { data: {
    switch_id: switchId, register_id: registerId, entries: [{ index: 8, value: '1' }],
  } });
  expect(invalid.status()).toBe(400);
});

test('meter and direct-meter configurations read back exactly', async ({ request }) => {
  const config = { cir: '100', cburst: '10', pir: '200', pburst: '20' };
  const meterId = metadata.meters[meter].id;
  await json(await request.patch('/api/meters', { data: { switch_id: switchId, meter_id: meterId, entries: [{ index: 0, config }] } }));
  const read = await json(await request.get('/api/meters', { params: { switch_id: switchId, meter_id: meterId, index: 0 } }));
  expect(read.entries[0].config).toEqual(config);
  expect((await request.post('/api/tables', { data: { switch_id: switchId, entry: JSON.stringify(entry(1, 2)) } })).ok()).toBeTruthy();
  const directId = metadata.direct_meters[directMeter].id;
  await json(await request.patch('/api/direct-meters', { data: { switch_id: switchId, meter_id: directId, entries: [{ table_entry: entry(1, 2), config }] } }));
  const directRead = await json(await request.get('/api/direct-meters', { params: { switch_id: switchId, meter_id: directId } }));
  expect(directRead.entries.find(row => row.table_entry.match_fields['standard_metadata.ingress_port'] == 1).config).toEqual(config);
});

test('mirror sessions create, read, modify and delete through P4Runtime', async ({ request }) => {
  const original = { switch_id: switchId, session_id: 101, replicas: [{ egress_port: '2', instance: 0 }], class_of_service: 0, packet_length_bytes: 0 };
  await json(await request.post('/api/mirrors', { data: original }));
  let read = await json(await request.get('/api/mirrors', { params: { switch_id: switchId } }));
  expect(read.entries.find(session => session.session_id === 101)).toEqual({ session_id: 101, replicas: original.replicas, class_of_service: 0, packet_length_bytes: 0 });
  const modified = { ...original, replicas: [{ egress_port: '3', instance: 1 }] };
  await json(await request.patch('/api/mirrors', { data: modified }));
  read = await json(await request.get('/api/mirrors', { params: { switch_id: switchId } }));
  expect(read.entries.find(session => session.session_id === 101).replicas).toEqual(modified.replicas);
  await json(await request.delete('/api/mirrors', { data: { switch_id: switchId, session_id: 101 } }));
  read = await json(await request.get('/api/mirrors', { params: { switch_id: switchId } }));
  expect(read.entries.some(session => session.session_id === 101)).toBeFalsy();
});

test('mirror sessions create, edit, refresh and delete through the browser', async ({ page, request }) => {
  await selectSwitch(page);
  await page.getByRole('link', { name: 'Mirrors', exact: true }).click();
  await page.getByRole('button', { name: 'Add mirror session', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add mirror session', exact: true });
  await dialog.getByRole('textbox', { name: 'Session ID', exact: true }).fill('102');
  await dialog.getByRole('textbox', { name: 'Egress port 1', exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Save session', exact: true }).click();
  const row = page.getByTestId('mirror-session-102');
  await expect(row).toContainText('2 / 0');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit mirror session', exact: true });
  await expect(dialog.getByRole('textbox', { name: 'Session ID', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Egress port 1', exact: true }).fill('3');
  await dialog.getByRole('button', { name: 'Save session', exact: true }).click();
  await expect(row).toContainText('3 / 0');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Refreshed');
  await expect(row).toContainText('3 / 0');
  const read = await json(await request.get('/api/mirrors', { params: { switch_id: switchId } }));
  expect(read.entries.find(session => session.session_id === 102).replicas).toEqual([{ egress_port: '3', instance: 0 }]);
  await page.screenshot({ path: test.info().outputPath('mirrors.png'), fullPage: true });
  await row.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(row).not.toBeVisible();
});

test('register and meter editors save and refresh values through the browser', async ({ page }) => {
  await selectSwitch(page);
  await page.getByRole('button', { name: 'Registers', exact: true }).click();
  await page.getByRole('link', { name: register, exact: true }).click();
  const registerRow = page.getByTestId('resource-row-0');
  await registerRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Value for index 0', exact: true }).fill('123456');
  await registerRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('value-0')).toHaveText('123456');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Refreshed');
  await expect(page.getByTestId('value-0')).toHaveText('123456');
  await page.screenshot({ path: test.info().outputPath('registers.png'), fullPage: true });

  await page.getByRole('button', { name: 'Meters', exact: true }).click();
  await page.getByRole('link', { name: meter, exact: true }).click();
  const meterRow = page.getByTestId('resource-row-0');
  await meterRow.getByRole('button', { name: 'Edit', exact: true }).click();
  for (const [label, value] of Object.entries({ CIR: '1000', CBS: '100', PIR: '2000', PBS: '200' })) {
    await page.getByRole('textbox', { name: `${label} for index 0`, exact: true }).fill(value);
  }
  await meterRow.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(meterRow).toContainText('2000');
  await page.getByRole('columnheader', { name: /^CIR \(/ }).hover();
  await expect(page.getByRole('tooltip', { name: /^Committed information rate \(CIR\)\./ })).toContainText('packets per second');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(meterRow).toContainText('2000');
  await page.screenshot({ path: test.info().outputPath('meters.png'), fullPage: true });

  await page.goto(`/tables/${forward}`);
  await page.getByRole('button', { name: 'Edit meter', exact: true }).click();
  let directDialog = page.getByRole('dialog', { name: 'Edit direct meter', exact: true });
  for (const [label, value] of Object.entries({ CIR: '300', CBS: '30', PIR: '600', PBS: '60' })) {
    await directDialog.getByRole('textbox', { name: label, exact: true }).fill(value);
  }
  await directDialog.getByRole('button', { name: 'Save meter', exact: true }).click();
  await expect(directDialog.getByRole('status')).toContainText('Saved');
  await directDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Edit meter', exact: true }).click();
  directDialog = page.getByRole('dialog', { name: 'Edit direct meter', exact: true });
  await expect(directDialog.getByRole('textbox', { name: 'PIR', exact: true })).toHaveValue('600');
  await directDialog.getByRole('button', { name: 'Reset meter', exact: true }).click();
  await expect(directDialog.getByText('Unconfigured — always green.', { exact: true })).toBeVisible();
  await expect(directDialog.getByRole('textbox', { name: 'CIR', exact: true })).toHaveValue('');
  for (const [label, value] of Object.entries({ CIR: '300', CBS: '30', PIR: '600', PBS: '60' })) await directDialog.getByRole('textbox', { name: label, exact: true }).fill(value);
  await directDialog.getByRole('button', { name: 'Save meter', exact: true }).click();
  await expect(directDialog.getByRole('status')).toContainText('Saved');
  await directDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await page.getByRole('banner').evaluate(element => element.getBoundingClientRect().top)).toBe(0);
});

test('resource navigation stays usable on a narrow viewport', async ({ page }) => {
  await selectSwitch(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/registers/${register}`);
  await expect(page.getByRole('heading', { name: register, exact: true })).toBeVisible();
  await expect(page.getByTestId('value-0')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Open resource menu', exact: true }).click();
  await page.getByRole('link', { name: 'Mirrors', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mirrors', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Mirrors', exact: true })).not.toBeVisible();
  await page.screenshot({ path: test.info().outputPath('mobile-mirrors.png'), fullPage: true });
});

test('sidebar collapses, resizes and preserves its settings after reload', async ({ page }) => {
  await page.goto('/switches');
  await page.evaluate(() => localStorage.removeItem('unicorn.sidebar.v1'));
  await selectSwitch(page);
  await page.goto('/dashboard');
  const sidebar = page.getByRole('navigation', { name: 'Switch resources', exact: true });
  const handle = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-valuenow', '240');
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeLessThan(90);

  // Resource groups remain accessible from the icon rail and expand the
  // sidebar when the user asks to see a group's entries.
  await sidebar.getByRole('button', { name: 'Registers', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
  await sidebar.getByRole('link', { name: register, exact: true }).click();
  await expect(page.getByRole('heading', { name: register, exact: true })).toBeVisible();
  const bounds = await handle.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(288);
  const resized = Number(await handle.getAttribute('aria-valuenow'));
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', String(resized));
  await handle.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', String(resized - 16));
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', String(resized - 16));
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox()).width).toBeLessThan(90);
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(handle).toHaveAttribute('aria-valuenow', String(resized - 16));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('unicorn.sidebar.v1')))).toEqual({ collapsed: false, width: resized - 16 });
});

test('real host traffic increments counters and registers and appears in the UI', async ({ page, request }) => {
  expect((await request.post('/api/tables', { data: { switch_id: switchId, entry: JSON.stringify(entry(2, 1)) } })).ok()).toBeTruthy();
  for (const ingress of [1, 2]) {
    expect((await request.post('/api/tables', { data: { switch_id: switchId, entry: JSON.stringify({
      table_name: 'IngressImpl.observation', match_fields: { 'standard_metadata.ingress_port': String(ingress) },
      action_name: 'IngressImpl.observe', action_params: {}, priority: null,
    }) } })).ok()).toBeTruthy();
  }
  await openTerminals(page);
  await page.getByRole('tab', { name: 'h1 (Host)', exact: true }).click();
  const input = page.locator('input').last();
  await input.fill('ping -c 2 -W 2 10.0.1.2');
  await input.press('Enter');
  await expect(page.getByText(/ 0% packet loss/)).toBeVisible({ timeout: 20_000 });
  const counterId = metadata.counters['IngressImpl.test_counter'].id;
  const counters = await json(await request.get('/api/counters', { params: { switch_id: switchId, counter_id: counterId, index: 1 } }));
  expect(BigInt(counters.entries[0].packets)).toBeGreaterThan(0n);
  const registers = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: metadata.registers[register].id, index: 1 } }));
  expect(BigInt(registers.entries[0].value)).toBeGreaterThan(0n);
  const direct = await json(await request.get('/api/tables', { params: { switch_id: switchId, table_name: 'IngressImpl.observation' } }));
  expect(direct.some(row => BigInt(row.counters.packets) > 0n)).toBeTruthy();

  await selectSwitch(page);
  await page.getByRole('button', { name: 'Counters', exact: true }).click();
  await page.getByRole('link', { name: 'IngressImpl.test_counter', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'IngressImpl.test_counter', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /Packets/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('counters.png'), fullPage: true });
});

test('terminals preserve their selected host and output across topology navigation', async ({ page }) => {
  // Existing bookmarks retain compatibility with the renamed Topology page.
  await page.goto('/mininet');
  await expect(page).toHaveURL(/\/topology$/);
  await page.getByRole('link', { name: 'Terminals', exact: true }).click();
  await expect(page.getByText('Connected. Output is kept while you switch between pages.', { exact: true })).toBeVisible();
  const host = page.getByRole('tab', { name: 'h2 (Host)', exact: true });
  await host.click();
  const nonce = String(Date.now());
  const marker = `PERSISTED_TERMINAL_${nonce}`;
  const input = page.locator('input').last();
  await input.fill(`printf 'PERSISTED_TERMINAL_%s\\n' '${nonce}'`);
  await input.press('Enter');
  await expect(page.locator('main')).toContainText(marker);
  await page.getByRole('link', { name: 'Topology', exact: true }).click();
  await expect(page).toHaveURL(/\/topology$/);
  await expect(page.getByRole('group', { name: 'Topology canvas', exact: true })).toBeVisible();
  await expect(host).not.toBeVisible();
  await page.getByRole('link', { name: 'Terminals', exact: true }).click();
  await expect(page).toHaveURL(/\/terminals$/);
  await expect(host).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('main')).toContainText(marker);
});

test('mirror packets reach the observer after the primary output link fails', async ({ page, request }) => {
  await json(await request.post('/api/init', { data: {
    switch_id: otherId, p4_info_file: '/p4/resources.p4info.txt', bmv2_file: '/p4/resources.json', keep_entries: false,
  } }));
  await json(await request.post('/api/tables', { data: { switch_id: otherId, entry: JSON.stringify({
    table_name: 'IngressImpl.observation', match_fields: { 'standard_metadata.ingress_port': '1' },
    action_name: 'IngressImpl.observe', action_params: {}, priority: null,
  }) } }));
  await json(await request.post('/api/mirrors', { data: {
    switch_id: switchId, session_id: 77, replicas: [{ egress_port: '3', instance: 0 }], class_of_service: 0, packet_length_bytes: 0,
  } }));
  const observedPackets = async () => {
    const rows = await json(await request.get('/api/tables', { params: { switch_id: otherId, table_name: 'IngressImpl.observation' } }));
    return BigInt(rows[0].counters.packets);
  };
  const command = async (target, text) => {
    await page.getByRole('tab', { name: target, exact: true }).click();
    const input = page.locator('input').last();
    await input.fill(text);
    await input.press('Enter');
  };
  await openTerminals(page);
  try {
    const before = await observedPackets();
    await command('h1 (Host)', 'ping -c 2 -W 1 10.0.1.2');
    await expect(page.getByText(/ 0% packet loss/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(observedPackets).toBeGreaterThan(before);
    const beforeFailure = await observedPackets();
    await command('s1 (Switch)', 'ip link set s1-eth2 down && echo PRIMARY_LINK_DOWN');
    await expect(page.getByText('PRIMARY_LINK_DOWN', { exact: true })).toBeVisible();
    await command('h1 (Host)', 'clear');
    await command('h1 (Host)', 'ping -c 3 -W 1 10.0.1.2');
    await expect(page.getByText(/100% packet loss/)).toBeVisible({ timeout: 20_000 });
    await expect.poll(observedPackets).toBeGreaterThan(beforeFailure);
    // The blocked primary output must leave the control plane responsive too.
    const rows = await json(await request.get('/api/tables', { params: { switch_id: switchId, table_name: forward } }));
    expect(rows).toHaveLength(2);
  } finally {
    await command('s1 (Switch)', 'ip link set s1-eth2 up && echo PRIMARY_LINK_RESTORED');
    await expect(page.getByText('PRIMARY_LINK_RESTORED', { exact: true })).toBeVisible();
    await request.delete('/api/mirrors', { data: { switch_id: switchId, session_id: 77 } });
  }
});

test('multicast groups edit through the UI and replicate real packets', async ({ page, request }) => {
  await selectSwitch(page);
  await page.getByRole('link', { name: 'Multicast', exact: true }).click();
  await page.getByRole('button', { name: 'Add multicast group', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Add multicast group', exact: true });
  await dialog.getByRole('textbox', { name: 'Group ID', exact: true }).fill('301');
  await dialog.getByRole('textbox', { name: 'Egress port 1', exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Add replica', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Egress port 2', exact: true }).fill('3');
  await dialog.getByRole('button', { name: 'Save group', exact: true }).click();
  const row = page.getByTestId('multicast-group-301');
  await expect(row).toContainText('2 / 0, 3 / 0');
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Edit multicast group', exact: true });
  await dialog.getByRole('textbox', { name: 'Instance 2', exact: true }).fill('1');
  await dialog.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(row).toContainText('3 / 1');
  const observed = async () => {
    const rows = await json(await request.get('/api/tables', { params: { switch_id: otherId, table_name: 'IngressImpl.observation' } }));
    return rows.reduce((total, item) => total + BigInt(item.counters?.packets || '0'), 0n);
  };
  const before = await observed();
  const original = entry(1, 2);
  const replicated = { ...original, action_name: 'IngressImpl.multicast', action_params: { group: '301' } };
  try {
    await json(await request.patch('/api/tables', { data: { switch_id: switchId, old: JSON.stringify(original), new: JSON.stringify(replicated) } }));
    await hostTraffic(page);
    await expect.poll(observed).toBeGreaterThan(before);
  } finally {
    await request.patch('/api/tables', { data: { switch_id: switchId, old: JSON.stringify(replicated), new: JSON.stringify(original) } });
  }
  await page.goto('/multicast-groups');
  await page.getByTestId('multicast-group-301').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(page.getByTestId('multicast-group-301')).not.toBeVisible();
});

test('digest configuration and packet events work through the browser', async ({ page, request }) => {
  await selectSwitch(page);
  await page.getByRole('link', { name: 'Digests', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable digest', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Acknowledgement timeout (ns)', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Enable digest', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save configuration', exact: true })).toBeEnabled();
  await hostTraffic(page);
  await page.goto('/digests');
  await expect.poll(async () => page.getByTestId(/^digest-event-/).count()).toBeGreaterThan(0);
  await expect(page.getByTestId(/^digest-event-/).first()).toContainText('ingress_port');
  await expect(page.getByTestId(/^digest-event-/).first()).toContainText('source_mac');
  const events = await json(await request.get('/api/digest-events', { params: { switch_id: switchId } }));
  expect(events.stream.primary).toBeTruthy();
  expect(events.stream.active).toBeTruthy();
  expect(events.events.length).toBeGreaterThan(0);
  await page.getByRole('textbox', { name: 'Maximum list size', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
  const configured = await json(await request.get('/api/digests', { params: { switch_id: switchId } }));
  expect(configured.entries[0].config.max_list_size).toBe('2');
  await page.getByRole('button', { name: 'Disable digest', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm disable', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enable digest', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Clear events', exact: true }).click();
  await expect(page.getByText('No digest events captured.', { exact: true })).toBeVisible();
});

test('counter resets and live traffic graphs preserve forwarding and direct meters', async ({ page, request }) => {
  await selectSwitch(page);
  const counterId = metadata.counters['IngressImpl.test_counter'].id;
  await json(await request.patch('/api/counters', { data: { switch_id: switchId, counter_id: counterId, reset: true } }));
  const trafficDone = await hostTraffic(page, 40, false);
  // Stay within the app so the terminal connection retains ping's completion
  // output while the traffic graph is visible.
  await page.getByRole('link', { name: 'Switch Menu', exact: true }).click();
  await page.getByRole('tab', { name: 's1', exact: true }).click();
  const counterLink = page.getByRole('link', { name: 'IngressImpl.test_counter', exact: true });
  if (!(await counterLink.isVisible())) await page.getByRole('button', { name: 'Counters', exact: true }).click();
  await counterLink.click();
  const plot = page.getByRole('img', { name: 'Packet rate over time', exact: true });
  await expect(plot).toBeVisible();
  await expect.poll(async () => (await plot.locator('circle title').allTextContents()).some(text => Number.parseFloat(text) > 0), { timeout: 15_000 }).toBeTruthy();
  const counterRows = async () => (await json(await request.get('/api/counters', { params: { switch_id: switchId, counter_id: counterId } }))).entries;
  await expect.poll(async () => Number((await counterRows()).find(item => item.index === 2)?.packets || 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(40);
  await page.getByRole('checkbox', { name: 'Live traffic', exact: true }).uncheck();
  await page.getByRole('link', { name: 'Terminals', exact: true }).click();
  await page.getByRole('tab', { name: 'h1 (Host)', exact: true }).click();
  await expect(page.locator('main')).toContainText(`${trafficDone}=0`);
  const setHostLinks = async state => {
    await page.getByRole('link', { name: 'Terminals', exact: true }).click();
    await expect(page.getByText('Connected. Output is kept while you switch between pages.', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 's1 (Switch)', exact: true }).click();
    const marker = `COUNTER_LINKS_${state}_${Date.now()}`;
    const input = page.locator('input').last();
    await input.fill(`ip link set s1-eth1 ${state} && ip link set s1-eth2 ${state} && echo ${marker}`);
    await input.press('Enter');
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
  };
  try {
    // Live traffic controls UI polling, not the dataplane. Even after ping
    // finishes, host ARP/IPv6 traffic can increment counters. Pause both host
    // links so exact zero and non-target preservation checks are meaningful.
    await setHostLinks('down');
    let previous;
    let stableReads = 0;
    await expect.poll(async () => {
      const current = JSON.stringify(await counterRows());
      stableReads = current === previous ? stableReads + 1 : 0;
      previous = current;
      return stableReads;
    }, { intervals: [250], timeout: 10_000 }).toBeGreaterThanOrEqual(4);
    const second = (await counterRows()).find(item => item.index === 2);
    expect(BigInt(second.packets)).toBeGreaterThanOrEqual(40n);
    await selectSwitch(page);
    await page.goto('/counters/IngressImpl.test_counter');
    await page.getByRole('button', { name: 'Reset counter index 1', exact: true }).click();
    await expect.poll(async () => (await counterRows()).find(item => item.index === 1).packets).toBe('0');
    expect((await counterRows()).find(item => item.index === 2)).toEqual(second);
    await page.getByRole('button', { name: 'Reset all counters', exact: true }).click();
    await expect.poll(async () => (await counterRows()).every(item => item.packets === '0' && item.bytes === '0')).toBeTruthy();
    await page.goto('/tables/IngressImpl.observation');
    await page.getByRole('button', { name: 'Reset counters', exact: true }).click();
    await expect.poll(async () => {
      const rows = await json(await request.get('/api/tables', { params: { switch_id: switchId, table_name: 'IngressImpl.observation' } }));
      return rows.length === 2 && rows.every(item => item.counters.packets === '0' && item.switch_entry.action_name === 'IngressImpl.observe');
    }).toBeTruthy();
    const direct = await json(await request.get('/api/direct-meters', { params: { switch_id: switchId, meter_id: metadata.direct_meters[directMeter].id } }));
    expect(direct.entries.find(item => item.table_entry.match_fields['standard_metadata.ingress_port'] == 1).config.pir).toBe('600');
  } finally {
    await setHostLinks('up');
  }
  await hostTraffic(page);
});

test('queue controls apply explicit native depth and rate settings through the browser', async ({ page, request }) => {
  await selectSwitch(page);
  await page.getByRole('link', { name: 'Queues', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply queue settings', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Target queues', exact: true }).click();
  await page.getByRole('option', { name: 'One port', exact: true }).click();
  await page.getByRole('textbox', { name: 'Egress port', exact: true }).fill('2');
  await page.getByRole('textbox', { name: 'Queue depth (packets)', exact: true }).fill('64');
  await page.getByRole('textbox', { name: 'Queue rate (packets/s)', exact: true }).fill('1000');
  await page.getByRole('button', { name: 'Apply queue settings', exact: true }).click();
  await expect(page.getByText('Queue changes acknowledged by BMv2.', { exact: true })).toBeVisible();
  const history = await json(await request.get('/api/queues', { params: { switch_id: switchId } }));
  expect(history.readback_available).toBeFalsy();
  expect(history.last_applied.some(item => item.port === 2 && item.depth_packets === 64)).toBeTruthy();
  expect(history.last_applied.some(item => item.port === 2 && item.rate_pps === '1000')).toBeTruthy();
  await json(await request.patch('/api/queues', { data: { switch_id: switchId, port: 2, rate_pps: '0' } }));
});

test('history and saved MAT snapshots remain usable', async ({ page, request }) => {
  const snapshotName = `E2E snapshot ${Date.now()}`;
  await selectSwitch(page);
  await page.getByRole('button', { name: 'Tables', exact: true }).click();
  await page.getByRole('link', { name: forward, exact: true }).click();
  await page.getByRole('button', { name: 'Save state', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save State' });
  await dialog.getByRole('textbox', { name: 'State Name', exact: true }).fill(snapshotName);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const saved = await json(await request.get('/api/saved'));
  const snapshot = saved.find(state => state.name === snapshotName);
  expect(snapshot.table_entries[forward]).toHaveLength(2);
  await page.getByRole('link', { name: 'Saved', exact: true }).click();
  await expect(page.getByText(snapshotName, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'History', exact: true }).click();
  await expect(page.getByText(/resources\.p4info\.txt.*currently initialized/).first()).toBeVisible();
  await page.getByRole('link', { name: 'Logs', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Switch Log File', exact: true })).toBeVisible();
});

test('version endpoints and visible component versions use the same release', async ({ page, request }) => {
  const backend = await json(await request.get('/api/version'));
  const netsim = await json(await request.get('/netsim/version'));
  expect(backend.version).toBe(netsim.version);
  expect(backend.update.status).toBe('disabled');
  expect(netsim.runtime.mininet).not.toContain('dev6');
  await page.goto('/');
  await page.getByRole('button', { name: 'Component versions', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText(backend.version);
});

test('external register adapter requires explicit opt-in and a chosen endpoint', async ({ page }) => {
  await page.goto('/switches');
  await page.getByRole('button', { name: 'New Switch Connection', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add New Switch', exact: true });
  const adapter = dialog.getByRole('checkbox', { name: 'Enable BMv2 register adapter', exact: true });
  await expect(adapter).not.toBeChecked();
  await expect(dialog.getByRole('textbox', { name: 'BMv2 Thrift host', exact: true })).toHaveValue('');
  await adapter.check();
  const host = dialog.getByRole('textbox', { name: 'BMv2 Thrift host', exact: true });
  await expect(host).toHaveValue('');
  await expect(host).toHaveAttribute('required', '');
  await host.fill('192.0.2.123');
  await dialog.getByRole('textbox', { name: 'BMv2 Thrift port', exact: true }).fill('9091');
  await expect(dialog.getByText(/supports registers up to 63 bits/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('topology builder saves, imports and edits a draggable topology draft', async ({ page, request }) => {
  await page.goto('/topology');
  await topologyAction(page, 'New draft');
  await page.getByRole('button', { name: 'Add host', exact: true }).click();
  await page.getByRole('button', { name: 'Add switch', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Link from', exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  await page.getByRole('button', { name: 'Select host h1', exact: true }).click();
  const link = page.getByRole('button', { name: 'Select link 1: h1 to s1', exact: true });
  await expect(link).toHaveCount(0);
  await page.getByRole('button', { name: 'Select switch s1', exact: true }).click();
  await expect(link).toBeVisible();
  const properties = page.getByRole('region', { name: 'Link properties', exact: true });
  await properties.getByRole('textbox', { name: 'Latency', exact: true }).fill('2ms');
  await properties.getByRole('spinbutton', { name: 'Bandwidth (Mbps)', exact: true }).fill('100');
  await properties.getByRole('button', { name: 'Update link', exact: true }).click();
  await page.getByRole('button', { name: 'Add host', exact: true }).click();
  await page.getByRole('textbox', { name: 'Node name', exact: true }).fill('edge2');
  await page.getByRole('button', { name: 'Apply name', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select host edge2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete node', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select host edge2', exact: true })).not.toBeVisible();

  const host = page.getByRole('button', { name: 'Select host h1', exact: true });
  await host.scrollIntoViewIfNeeded();
  const originalPosition = await host.getAttribute('transform');
  const bounds = await host.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2 + 30, { steps: 6 });
  await page.mouse.up();
  await expect(host).not.toHaveAttribute('transform', originalPosition);
  const draggedPosition = await host.getAttribute('transform');
  await host.press('ArrowRight');
  await expect(host).not.toHaveAttribute('transform', draggedPosition);

  const filename = `e2e-builder-${Date.now()}.json`;
  await topologyAction(page, 'Save topology');
  const saveDialog = page.getByRole('dialog', { name: 'Save topology', exact: true });
  await saveDialog.getByRole('textbox', { name: 'Topology filename', exact: true }).fill(filename);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/topologies') && response.request().method() === 'POST');
  await saveDialog.getByRole('button', { name: 'Save topology', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(saveDialog).not.toBeVisible();
  await expect(page.getByText('Topology saved. Deploy to update the running network.', { exact: true })).toBeVisible();
  const path = `/topologies/${filename}`;
  const read = await json(await request.get('/api/topologies', { params: { name: path } }));
  expect(read[path].hosts).toEqual(['h1']);
  expect(read[path].switches).toEqual({ s1: {} });
  expect(read[path].links).toEqual([['h1', 's1', '2ms', 100]]);
  expect(read[path].layout.h1.x).toBeGreaterThan(100);

  await topologyAction(page, 'New draft');
  await expect(host).not.toBeVisible();
  await importSavedTopology(page, filename);
  await expect(host).toHaveAttribute('transform', `translate(${read[path].layout.h1.x},${read[path].layout.h1.y})`);
  const downloaded = page.waitForEvent('download');
  await topologyAction(page, 'Export topology JSON');
  const exported = JSON.parse(await readFile(await (await downloaded).path(), 'utf8'));
  expect(exported.layout).toEqual(read[path].layout);
  expect(exported.links).toEqual(read[path].links);
  await expect(link).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('topology-builder.png'), fullPage: true });
  await page.getByRole('group', { name: 'Topology canvas', exact: true }).screenshot({ path: test.info().outputPath('topology-builder-canvas.png') });
  await link.press('Enter');
  await properties.getByRole('button', { name: /^Delete link/ }).click();
  await expect(link).not.toBeVisible();
  // Create a replacement entirely by keyboard. Focusing a node alone must not
  // pick an endpoint, and both Enter and Space activate canvas nodes.
  await page.getByRole('button', { name: 'Add link', exact: true }).press('Enter');
  await host.focus();
  await expect(link).toHaveCount(0);
  await host.press('Enter');
  await page.getByRole('button', { name: 'Select switch s1', exact: true }).press('Space');
  await expect(link).toBeVisible();
  // Escape cancels a pending second connection. Activating its former target
  // afterwards must only select it rather than create a parallel link.
  await page.getByRole('button', { name: 'Add link', exact: true }).press('Enter');
  await host.press('Enter');
  await host.press('Escape');
  await page.getByRole('button', { name: 'Select switch s1', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: /^Select link \d+:/ })).toHaveCount(1);
});

test('external stock BMv2 keeps MATs available and enables registers only with the chosen adapter', async ({ page, request }) => {
  const externalId = 42;
  const connection = {
    name: 'ExternalBMv2', device_id: externalId, address: '127.0.0.1:55051',
    proto_dump_file: null, register_adapter_enabled: false,
  };
  const connect = async config => json(await request.post('/api/switches/active', {
    data: { switch_config: JSON.stringify(config) },
  }));
  const readInit = async () => json(await request.get('/api/init', { params: { switch_id: externalId } }));
  try {
    await connect(connection);
    await json(await request.post('/api/init', { data: {
      switch_id: externalId, p4_info_file: '/p4/resources.p4info.txt', bmv2_file: '/p4/resources.json', keep_entries: false,
    } }));
    let externalMetadata = await readInit();
    expect(externalMetadata.register_access.status).toBe('unsupported');
    const registerId = externalMetadata.registers[register].id;
    const unsupported = await request.get('/api/registers', { params: { switch_id: externalId, register_id: registerId, index: 0 } });
    expect(unsupported.status()).toBe(501);
    const unavailableQueues = await json(await request.get('/api/queues', { params: { switch_id: externalId } }));
    expect(unavailableQueues.write_available).toBeFalsy();

    // A stock target's missing RegisterEntry support must not disable normal MAT access.
    await json(await request.post('/api/tables', { data: { switch_id: externalId, entry: JSON.stringify(entry(1, 2)) } }));
    const table = await json(await request.get('/api/tables', { params: { switch_id: externalId, table_name: forward } }));
    expect(String(table[0].switch_entry.action_params.port)).toBe('2');
    await page.goto('/switches');
    await page.getByRole('tab', { name: 'ExternalBMv2', exact: true }).click();
    await page.getByRole('button', { name: 'Registers', exact: true }).click();
    await page.getByRole('link', { name: register, exact: true }).click();
    await expect(page.getByText(/enable the BMv2 register adapter in its saved connection settings/)).toBeVisible();

    await json(await request.delete('/api/switches/active', { data: { device_id: externalId } }));
    await connect({ ...connection, register_thrift_host: '127.0.0.1', register_thrift_port: 59090 });
    externalMetadata = await readInit();
    expect(externalMetadata.register_access.status).toBe('unsupported');
    await json(await request.patch('/api/queues', { data: { switch_id: externalId, port: 2, depth_packets: 64, rate_pps: '0' } }));
    const stillUnsupported = await request.get('/api/registers', { params: { switch_id: externalId, register_id: registerId, index: 0 } });
    expect(stillUnsupported.status()).toBe(501);
    await json(await request.delete('/api/switches/active', { data: { device_id: externalId } }));
    await connect({ ...connection, register_adapter_enabled: true, register_thrift_host: '127.0.0.1', register_thrift_port: 59090 });
    externalMetadata = await readInit();
    expect(externalMetadata.register_access).toMatchObject({ mode: 'adapter', status: 'supported', max_bitwidth: 63 });
    for (const [name, value] of [[register, '123456'], ['IngressImpl.signed_register', '-12345']]) {
      const id = externalMetadata.registers[name].id;
      await json(await request.patch('/api/registers', { data: { switch_id: externalId, register_id: id, entries: [{ index: 0, value }] } }));
      const read = await json(await request.get('/api/registers', { params: { switch_id: externalId, register_id: id, index: 0 } }));
      expect(read.entries[0].value).toBe(value);
    }
    const wideId = externalMetadata.registers['IngressImpl.wide_register'].id;
    const tooWide = await request.get('/api/registers', { params: { switch_id: externalId, register_id: wideId, index: 0 } });
    expect(tooWide.status()).toBe(501);

    // Reload providers after reconnecting the same device ID to adopt its new capabilities.
    await page.reload();
    await expect(page.getByText('Register access: BMv2 Thrift adapter · up to 63 bits')).toBeVisible();
    const row = page.getByTestId('resource-row-0');
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('textbox', { name: 'Value for index 0', exact: true }).fill('424242');
    await row.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByTestId('value-0')).toHaveText('424242');
    const readback = await json(await request.get('/api/registers', { params: { switch_id: externalId, register_id: registerId, index: 0 } }));
    expect(readback.entries[0].value).toBe('424242');
  } finally {
    await request.delete('/api/switches/active', { data: { device_id: externalId } });
  }
  const active = await json(await request.get('/api/switches/active'));
  expect(active.connections.map(s => s.device_id).sort()).toEqual([switchId, otherId].sort());
});

test('dark mode keeps action buttons readable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('darkMode', 'true'));
  await selectSwitch(page);
  await page.goto(`/registers/${register}`);
  const button = page.getByRole('button', { name: 'Refresh', exact: true });
  await expect(button).toBeEnabled();
  const contrast = await button.evaluate(element => {
    const luminance = color => {
      const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const linear = value / 255;
        return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const style = getComputedStyle(element), a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({ path: test.info().outputPath('dark-registers.png'), animations: 'disabled' });
});

test('network bundles export and restore topology, programs and live switch resources', async ({ page, request }) => {
  await selectSwitch(page);
  // An untouched internal switch has a valid native endpoint but no recorded
  // queue settings. BMv2 has no queue getters; export must report this unknown
  // state rather than infer defaults or pretend to capture it.
  const otherQueues = await json(await request.get('/api/queues', { params: { switch_id: otherId } }));
  expect(otherQueues.write_available).toBeTruthy();
  expect(otherQueues.state).toBe('unknown');
  expect(otherQueues.configuration.defaults).toEqual({ depth_packets: null, rate_pps: null });
  expect(otherQueues.last_applied).toHaveLength(0);
  await json(await request.post('/api/mirrors', { data: { switch_id: switchId, session_id: 501, replicas: [{ egress_port: '3', instance: 0 }] } }));
  await json(await request.post('/api/multicast-groups', { data: { switch_id: switchId, multicast_group_id: 601, replicas: [{ egress_port: '2', instance: 0 }, { egress_port: '3', instance: 1 }] } }));
  const digestId = metadata.digests.traffic_digest_t.id;
  await json(await request.post('/api/digests', { data: { switch_id: switchId, digest_id: digestId,
    config: { max_timeout_ns: '0', max_list_size: '1', ack_timeout_ns: '0' } } }));
  await hostTraffic(page, 8);
  const counterId = metadata.counters['IngressImpl.test_counter'].id;
  const beforeCounters = await json(await request.get('/api/counters', { params: { switch_id: switchId, counter_id: counterId } }));
  // Network archives are a global header action, available away from Topology.
  await page.goto(`/registers/${register}`);
  await expect(page.getByRole('heading', { name: register, exact: true })).toBeVisible();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Network archive', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export network', exact: true }).click();
  const bundle = await readFile(await (await downloading).path());
  expect(bundle.length).toBeGreaterThan(1000);
  await importNetworkFile(page, 'roundtrip.zip', bundle);
  const dialog = page.getByRole('dialog', { name: 'Import network', exact: true });
  await expect(dialog.getByRole('table', { name: 'Switches in network bundle' })).toContainText('s1');
  await expect(dialog.getByRole('table', { name: 'Switches in network bundle' })).toContainText('s2');
  await expect(dialog.getByRole('checkbox', { name: 'Restore recorded queue settings (not switch readback)' })).toBeChecked();
  const deployed = page.waitForResponse(response => response.url().endsWith('/api/network/import/deploy') && response.request().method() === 'POST', { timeout: 90_000 });
  await dialog.getByRole('button', { name: 'Import and deploy', exact: true }).click();
  const restored = await json(await deployed);
  expect(restored.switches.every(target => target.status === 'complete')).toBeTruthy();
  expect(restored.status).toBe('partial');
  expect(restored.warnings).toContain('Some queue fields are unknown and will not be inferred or restored');
  expect(restored.warnings).toContain('queues: unavailable');
  await expect(dialog.getByText('Network imported with incomplete state.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('table', { name: 'Switches in network bundle' }).locator('tbody tr').filter({ hasText: 's2' })).toContainText('queues: unavailable');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const init = await json(await request.get('/api/init', { params: { switch_id: switchId } }));
  expect(init.p4_info_file).toContain('imported-network-');
  const wide = await json(await request.get('/api/registers', { params: { switch_id: switchId, register_id: metadata.registers['IngressImpl.wide_register'].id, index: 0 } }));
  expect(wide.entries[0].value).toBe('18446744073709551615');
  const meters = await json(await request.get('/api/direct-meters', { params: { switch_id: switchId, meter_id: metadata.direct_meters[directMeter].id } }));
  expect(meters.entries.find(item => item.table_entry.match_fields['standard_metadata.ingress_port'] == 1).config.pir).toBe('600');
  expect(meters.entries.find(item => item.table_entry.match_fields['standard_metadata.ingress_port'] == 2).config).toBeNull();
  const afterCounters = await json(await request.get('/api/counters', { params: { switch_id: switchId, counter_id: counterId } }));
  for (const index of [1, 2]) expect(BigInt(afterCounters.entries.find(item => item.index === index).packets)).toBeGreaterThanOrEqual(BigInt(beforeCounters.entries.find(item => item.index === index).packets));
  const groups = await json(await request.get('/api/multicast-groups', { params: { switch_id: switchId } }));
  expect(groups.entries.some(group => group.multicast_group_id === 601)).toBeTruthy();
  const mirrors = await json(await request.get('/api/mirrors', { params: { switch_id: switchId } }));
  expect(mirrors.entries.some(session => session.session_id === 501)).toBeTruthy();
  const digests = await json(await request.get('/api/digests', { params: { switch_id: switchId } }));
  expect(digests.entries[0].config.max_list_size).toBe('1');
  const queues = await json(await request.get('/api/queues', { params: { switch_id: switchId } }));
  expect(queues.configuration.ports.some(port => port.port === 2 && port.depth_packets === 64 && port.rate_pps === '0')).toBeTruthy();
  const otherAfter = await json(await request.get('/api/queues', { params: { switch_id: otherId } }));
  expect(otherAfter.write_available).toBeTruthy();
  expect(otherAfter.state).toBe('unknown');
  expect(otherAfter.configuration.defaults).toEqual({ depth_packets: null, rate_pps: null });
  expect(otherAfter.last_applied).toHaveLength(0);
  await hostTraffic(page);
});

test('disconnecting device zero preserves the other switch', async ({ request }) => {
  expect(switchId).toBe(0);
  expect((await request.delete('/api/switches/active', { data: { device_id: switchId } })).ok()).toBeTruthy();
  const active = await json(await request.get('/api/switches/active'));
  expect(active.connections.map(s => s.device_id)).toEqual([otherId]);
});

async function sampleTerminal(page, host, command) {
  await expect(page.getByText('Connected. Output is kept while you switch between pages.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: `${host} (Host)`, exact: true }).click();
  const input = page.locator('input').last();
  await input.fill(command);
  await input.press('Enter');
}

async function samplePing(page, count = 3, interval = '0.2', { host = 'h1', destination = '10.0.1.2' } = {}) {
  await sampleTerminal(page, host, 'clear');
  const marker = `PUBLIC_SAMPLE_DONE_${Date.now()}`;
  await sampleTerminal(page, host, `ping -c ${count} -i ${interval} -W 1 ${destination}; sample_ping_status=$?; echo ${marker}=$sample_ping_status`);
  // Stream chunks can combine summary and marker. The echoed command contains
  // a shell variable here, so it cannot satisfy the completed numeric status.
  await expect(page.locator('main')).toContainText(new RegExp(`${marker}=[01](?:\\s|$)`), { timeout: 25_000 });
  const text = await page.locator('main').innerText();
  const losses = [...text.matchAll(/(\d+(?:\.\d+)?)% packet loss/g)];
  expect(losses.length, text).toBeGreaterThan(0);
  return Number(losses.at(-1)[1]);
}

async function sampleHostRX(page) {
  await sampleTerminal(page, 'h3', 'clear');
  await sampleTerminal(page, 'h3', 'printf \'PUBLIC_SAMPLE_RX_%s\\n\' "$(cat /sys/class/net/h3-eth0/statistics/rx_packets)"');
  await expect(page.locator('main')).toContainText(/PUBLIC_SAMPLE_RX_\d+/);
  return BigInt((await page.locator('main').innerText()).match(/PUBLIC_SAMPLE_RX_(\d+)/)[1]);
}

for (const name of ['two-host-forwarding', 'multicast-hub', 'mirror-observer', 'metering-queues', 'campus-telemetry']) {
  test(`public network sample ${name} imports through the UI and forwards real packets`, async ({ page, request }) => {
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto('/topology');
    const archive = await readFile(new URL(`../../examples/networks/${name}.zip`, import.meta.url));
    const validated = page.waitForResponse(response => response.url().endsWith('/api/network/import') && response.request().method() === 'POST');
    await importNetworkFile(page, `${name}.zip`, archive);
    const preview = await json(await validated);
    expect(preview.preview.switches.every(target => target.pipeline && target.source?.endsWith('/runtime-lab.p4'))).toBeTruthy();
    const dialog = page.getByRole('dialog', { name: 'Import network', exact: true });
    await expect(dialog.getByRole('table', { name: 'Switches in network bundle' })).toContainText('s1');
    await expect(dialog.getByRole('checkbox', { name: 'Restore recorded queue settings (not switch readback)' })).toBeChecked();
    const deploying = page.waitForResponse(response => response.url().endsWith('/api/network/import/deploy') && response.request().method() === 'POST', { timeout: 90_000 });
    await dialog.getByRole('button', { name: 'Import and deploy', exact: true }).click();
    const restored = await json(await deploying);
    expect(restored.error).toBeUndefined();
    for (const target of restored.switches) {
      for (const category of ['tables', 'registers', 'counters', 'meters', 'direct_meters', 'multicast_groups', 'mirrors', 'digests']) {
        expect(target.categories[category].status, `${name}: ${target.name}/${category}`).toBe('complete');
      }
    }
    if (restored.status === 'partial') {
      expect(restored.warnings.length).toBeGreaterThan(0);
      expect(restored.warnings.every(warning => warning === 'Some queue fields are unknown and will not be inferred or restored' || warning === 'queues: unavailable')).toBeTruthy();
      await expect(dialog.getByText('Network imported with incomplete state.', { exact: true })).toBeVisible();
    } else {
      expect(restored.status).toBe('complete');
      await expect(dialog.getByText('Network imported successfully.', { exact: true })).toBeVisible();
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    const active = await json(await request.get('/api/switches/active'));
    const ids = Object.fromEntries(active.connections.map(connection => [connection.name, connection.device_id]));
    expect(Object.keys(ids).sort()).toEqual(Object.keys(preview.preview.topology.switches).sort());
    const info = Object.fromEntries(await Promise.all(active.connections.map(async connection => [connection.name,
      await json(await request.get('/api/init', { params: { switch_id: connection.device_id } }))])));
    expect(info.s1.p4_info_file).toContain('imported-network-');
    expect(info.s1.register_access.max_bitwidth).toBe(64);
    const counter = async target => BigInt((await json(await request.get('/api/counters', { params: {
      switch_id: ids[target], counter_id: info[target].counters['LabIngress.port_counter'].id, index: 1,
    } }))).entries[0].packets);
    const counterTotal = async target => (await json(await request.get('/api/counters', { params: {
      switch_id: ids[target], counter_id: info[target].counters['LabIngress.port_counter'].id,
    } }))).entries.reduce((total, row) => total + BigInt(row.packets), 0n);
    const before = await counter('s1');
    const observerBefore = name === 'mirror-observer' ? await counter('s2') : null;
    let campusBefore;
    if (name === 'campus-telemetry') {
      expect(Object.keys(ids).sort()).toEqual(['s1', 's2', 's3', 's4']);
      expect(preview.preview.topology.hosts).toHaveLength(6);
      expect(preview.preview.topology.links).toHaveLength(10);
      campusBefore = Object.fromEntries(await Promise.all(Object.keys(ids).map(async target => [target, await counterTotal(target)])));
    }
    await page.goto('/topology');
    await expect(page.getByRole('group', { name: 'Topology canvas', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Terminals', exact: true }).click();
    await expect(page).toHaveURL(/\/terminals$/);
    const beforeRX = name === 'multicast-hub' ? await sampleHostRX(page) : null;
    expect(await samplePing(page)).toBe(0);
    await expect.poll(() => counter('s1')).toBeGreaterThan(before);
    for (const resource of ['LabIngress.packet_count', 'LabIngress.wide_packet_count']) {
      const state = await json(await request.get('/api/registers', { params: { switch_id: ids.s1, register_id: info.s1.registers[resource].id, index: 1 } }));
      expect(BigInt(state.entries[0].value)).toBeGreaterThan(0n);
    }
    if (name === 'two-host-forwarding') {
      await expect.poll(async () => (await json(await request.get('/api/digest-events', { params: {
        switch_id: ids.s1, digest_id: info.s1.digests.packet_digest_t.id,
      } }))).events.length).toBeGreaterThan(0);
    }
    if (name === 'multicast-hub') {
      expect(await sampleHostRX(page)).toBeGreaterThan(beforeRX);
      const groups = await json(await request.get('/api/multicast-groups', { params: { switch_id: ids.s1 } }));
      expect(groups.entries.map(group => group.multicast_group_id)).toEqual([101, 102, 103]);
    }
    if (name === 'mirror-observer') {
      await expect.poll(() => counter('s2')).toBeGreaterThan(observerBefore);
      const rows = await json(await request.get('/api/tables', { params: { switch_id: ids.s2, table_name: 'LabIngress.forward' } }));
      expect(rows).toEqual([]);
    }
    if (name === 'metering-queues') {
      const queues = await json(await request.get('/api/queues', { params: { switch_id: ids.s1, port: 2 } }));
      expect(queues.readback_available).toBeFalsy();
      expect(queues.configuration.ports.find(port => port.port === 2)).toMatchObject({ depth_packets: 8, rate_pps: '10' });
      const direct = await json(await request.get('/api/direct-meters', { params: { switch_id: ids.s1, meter_id: info.s1.direct_meters['LabIngress.flow_meter'].id } }));
      expect(direct.entries.find(row => row.table_entry.match_fields['standard_metadata.ingress_port'] == 1).config).toEqual({ cir: '5', cburst: '2', pir: '10', pburst: '4' });
      const loss = await samplePing(page, 30, '0.02');
      expect(loss).toBeGreaterThan(0);
      expect(loss).toBeLessThan(100);
    }
    if (name === 'campus-telemetry') {
      // The h1↔h2 circuit traverses every switch. Transit links on s2/s3 do
      // not use port1, so verify the full counter rather than a single cell.
      for (const target of Object.keys(ids)) {
        await expect.poll(() => counterTotal(target), { message: `${target} carries campus forwarding traffic` }).toBeGreaterThan(campusBefore[target]);
        const queues = await json(await request.get('/api/queues', { params: { switch_id: ids[target] } }));
        expect(queues.readback_available).toBeFalsy();
        expect(queues.configuration.defaults).toEqual({ depth_packets: 256, rate_pps: '0' });
      }
      const mirrors = await json(await request.get('/api/mirrors', { params: { switch_id: ids.s1 } }));
      expect(mirrors.entries.find(session => session.session_id === 20).replicas).toEqual([{ egress_port: '4', instance: 0 }]);
      const multicast = await json(await request.get('/api/multicast-groups', { params: { switch_id: ids.s4 } }));
      expect(multicast.entries.find(group => group.multicast_group_id === 102).replicas).toEqual([
        { egress_port: '2', instance: 0 }, { egress_port: '4', instance: 1 },
      ]);
      const wide = await json(await request.get('/api/registers', { params: { switch_id: ids.s1,
        register_id: info.s1.registers['LabIngress.wide_packet_count'].id, index: 0 } }));
      expect(wide.entries[0].value).toBe('9007199254740993');
      expect(await samplePing(page, 3, '0.2', { host: 'h5', destination: '10.0.4.6' })).toBe(0);
    }
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath(`${name}.png`), animations: 'disabled' });
  });
}
