// Capture the isolated E2E fixture for the README. Run after scripts/test-e2e.sh
// with E2E_KEEP_RUNNING=1; this script intentionally refuses other pipelines.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../tests/e2e/package.json', import.meta.url));
const { chromium, expect } = require('@playwright/test');
const destination = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
await mkdir(destination, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
const context = await browser.newContext({ baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:3001', viewport: { width: 1366, height: 900 } });
const page = await context.newPage();
const api = context.request;
async function json(response) {
  if (!response.ok()) throw new Error(`${response.status()}: ${await response.text()}`);
  return response.json();
}
async function capture(name) {
  await expect(page.getByRole('banner')).toBeInViewport();
  if (await page.evaluate(() => window.scrollY !== 0)) throw new Error('The document scrolled instead of its content pane.');
  await page.locator('.MuiDrawer-paper').evaluateAll(drawers => drawers.forEach(drawer => { drawer.scrollTop = 0; }));
  await page.evaluate(() => document.activeElement?.blur());
  await page.mouse.move(1350, 880);
  await page.screenshot({ path: `${destination}${name}.png`, animations: 'disabled' });
}
const resourceGroups = { Tables: 'table_info', Counters: 'counters', Registers: 'registers', Meters: 'meters' };
async function setResourceGroups(metadata, selected = null) {
  const menu = page.getByRole('navigation', { name: 'Switch resources', exact: true });
  await expect(menu).toBeVisible();
  for (const [title, field] of Object.entries(resourceGroups)) {
    const name = Object.keys(metadata[field] || {})[0];
    if (!name) continue;
    const button = menu.getByRole('button', { name: title, exact: true });
    const child = menu.getByRole('link', { name, exact: true });
    await expect(button).toBeEnabled();
    const open = title === selected;
    if (await child.isVisible() !== open) await button.click();
    if (open) await expect(child).toBeVisible();
    else await expect(child).not.toBeVisible();
  }
}
async function checkMenuIcons() {
  const menu = page.getByRole('navigation', { name: 'Switch resources', exact: true });
  const shapes = new Set();
  for (const title of ['Tables', 'Counters', 'Registers', 'Meters', 'Mirrors', 'Multicast', 'Digests', 'Queues']) {
    const item = menu.getByRole(title in resourceGroups ? 'button' : 'link', { name: title, exact: true });
    const icon = item.locator('svg').first();
    await expect(icon).toBeVisible();
    // Production MUI builds omit icon test IDs; compare their actual paths.
    const shape = await icon.evaluate(element => [...element.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|'));
    if (!shape || shapes.has(shape)) throw new Error(`The ${title} menu icon is missing or duplicates another resource icon.`);
    shapes.add(shape);
  }
}
async function positionTopology() {
  await page.getByRole('heading', { name: 'Topology', exact: true }).evaluate(element => {
    const main = element.closest('main');
    const bannerBottom = document.querySelector('header')?.getBoundingClientRect().bottom || 136;
    main.scrollTop += element.getBoundingClientRect().top - Math.max(main.getBoundingClientRect().top, bannerBottom) - 16;
  });
  await expect(page.getByRole('group', { name: 'Topology canvas', exact: true })).toBeVisible();
}
try {
  const online = await json(await api.get('/netsim/switches/online'));
  if (!online.switches_online.some(sw => sw.name === 's1')) throw new Error('Load the E2E topology before capturing screenshots.');
  const active = await json(await api.get('/api/switches/active'));
  const localSwitch = online.switches_online.find(sw => sw.name === 's1');
  if (localSwitch.dev_id !== 0) throw new Error('Only the isolated E2E switch s1 with device ID 0 may be captured.');
  const localAddress = `127.0.0.1:${localSwitch.grpc_port}`;
  const existing = active.connections.find(sw => sw.device_id === 0);
  if (existing && (existing.name !== 's1' || ![localAddress, `localhost:${localSwitch.grpc_port}`].includes(existing.address))) {
    throw new Error('Refusing to modify device 0 because it is not the local E2E switch s1.');
  }
  if (!active.connections.some(sw => sw.device_id === 0)) {
    await json(await api.post('/api/switches/active', { data: { switch_config: JSON.stringify({ name: 's1', address: localAddress, device_id: 0, proto_dump_file: null, register_adapter_enabled: false,
      register_thrift_host: localSwitch.thrift_port ? '127.0.0.1' : null, register_thrift_port: localSwitch.thrift_port ?? null }) } }));
  }
  const metadata = await json(await api.get('/api/init', { params: { switch_id: 0 } }));
  if (!metadata.registers?.['IngressImpl.test_register']) throw new Error('Only the E2E resources.p4 pipeline may be captured.');
  const registerId = metadata.registers['IngressImpl.test_register'].id;
  const meterId = metadata.meters['IngressImpl.test_meter'].id;
  await json(await api.patch('/api/registers', { data: { switch_id: 0, register_id: registerId, entries: [
    { index: 0, value: '123456' }, { index: 2, value: '65535' }, { index: 3, value: '4294967295' },
  ] } }));
  await json(await api.patch('/api/meters', { data: { switch_id: 0, meter_id: meterId, entries: [
    { index: 0, config: { cir: '1000', cburst: '100', pir: '2000', pburst: '200' } },
    { index: 1, config: { cir: '500', cburst: '50', pir: '1000', pburst: '100' } },
  ] } }));
  const mirrors = await json(await api.get('/api/mirrors', { params: { switch_id: 0 } }));
  if (mirrors.entries.some(session => session.session_id === 201)) await json(await api.delete('/api/mirrors', { data: { switch_id: 0, session_id: 201 } }));
  await json(await api.post('/api/mirrors', { data: { switch_id: 0, session_id: 201, replicas: [{ egress_port: '3', instance: 0 }], class_of_service: 0, packet_length_bytes: 0 } }));
  await context.addInitScript(() => {
    localStorage.setItem('darkMode', 'false');
  });
  await page.goto('/switches');
  await page.getByRole('tab', { name: 's1', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Initialization', exact: true })).toBeVisible();
  for (const [group, name, image] of [
    ['Tables', 'IngressImpl.forward', 'tables'],
    ['Registers', 'IngressImpl.test_register', 'registers'],
    ['Meters', 'IngressImpl.test_meter', 'meters'],
  ]) {
    // A group may already be expanded when its route first mounts the sidebar.
    await setResourceGroups(metadata, group);
    await page.getByRole('link', { name, exact: true }).click();
    await checkMenuIcons();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    if (group !== 'Tables') await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
    await expect(page.getByRole('cell').first()).toBeVisible();
    await capture(image);
  }
  await page.getByRole('link', { name: 'Mirrors', exact: true }).click();
  await setResourceGroups(metadata);
  await expect(page.getByTestId('mirror-session-201')).toBeVisible();
  await capture('mirrors');

  const multicast = await json(await api.get('/api/multicast-groups', { params: { switch_id: 0 } }));
  if (multicast.entries.some(group => group.multicast_group_id === 401)) await json(await api.delete('/api/multicast-groups', { data: { switch_id: 0, multicast_group_id: 401 } }));
  await json(await api.post('/api/multicast-groups', { data: { switch_id: 0, multicast_group_id: 401,
    replicas: [{ egress_port: '2', instance: 0 }, { egress_port: '3', instance: 1 }] } }));
  await page.goto('/multicast-groups');
  await setResourceGroups(metadata);
  await expect(page.getByTestId('multicast-group-401')).toBeVisible();
  await capture('multicast');

  await json(await api.patch('/api/queues', { data: { switch_id: 0, depth_packets: 64, rate_pps: '0' } }));
  await json(await api.patch('/api/queues', { data: { switch_id: 0, port: 2, depth_packets: 128, rate_pps: '1000' } }));
  await page.goto('/queues');
  await setResourceGroups(metadata);
  await expect(page.getByRole('button', { name: 'Refresh queues', exact: true })).toBeEnabled();
  await expect(page.getByRole('table', { name: 'Per-port queue configuration', exact: true })).toContainText('1000 packets/s');
  await capture('queues');

  const counterId = metadata.counters['IngressImpl.test_counter'].id;
  await json(await api.patch('/api/counters', { data: { switch_id: 0, counter_id: counterId, reset: true } }));
  await page.goto('/terminals');
  await expect(page.getByText('Connected. Output is kept while you switch between pages.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'h1 (Host)', exact: true }).click();
  await page.locator('input').last().fill('ping -c 40 -i 0.2 -W 2 10.0.1.2');
  await page.locator('input').last().press('Enter');
  await page.goto('/counters/IngressImpl.test_counter');
  await setResourceGroups(metadata, 'Counters');
  await page.setViewportSize({ width: 1366, height: 1200 });
  const graph = page.getByRole('img', { name: 'Packet rate over time', exact: true });
  await expect.poll(async () => graph.locator('circle').count(), { timeout: 20000 }).toBeGreaterThanOrEqual(5);
  await capture('counters');
  await expect.poll(async () => {
    const rows = await json(await api.get('/api/counters', { params: { switch_id: 0, counter_id: counterId } }));
    return Number(rows.entries.find(row => row.index === 2)?.packets || 0);
  }, { timeout: 20_000 }).toBeGreaterThanOrEqual(40);

  const digestId = metadata.digests.traffic_digest_t.id;
  const digests = await json(await api.get('/api/digests', { params: { switch_id: 0 } }));
  await json(await api[digests.entries.some(digest => digest.digest_id === digestId) ? 'patch' : 'post']('/api/digests', { data: {
    switch_id: 0, digest_id: digestId, config: { max_timeout_ns: '0', max_list_size: '1', ack_timeout_ns: '0' },
  } }));
  await json(await api.delete('/api/digest-events', { data: { switch_id: 0 } }));
  await page.goto('/terminals');
  await expect(page.getByText('Connected. Output is kept while you switch between pages.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'h1 (Host)', exact: true }).click();
  const marker = `DIGEST_CAPTURE_${Date.now()}`;
  await page.locator('input').last().fill(`ping -c 1 -W 2 10.0.1.2 && echo ${marker}`);
  await page.locator('input').last().press('Enter');
  await expect(page.locator('main')).toContainText(/(?:^|\s)0% packet loss/);
  await page.goto('/digests');
  await setResourceGroups(metadata);
  await page.setViewportSize({ width: 1366, height: 1400 });
  await expect(page.getByTestId(/^digest-event-/).first()).toContainText('source_mac');
  await capture('digests');
  await page.setViewportSize({ width: 1366, height: 900 });

  await json(await api.post('/api/topologies', { data: {
    name: 'docs-topology.json', overwrite: true,
    topology: { hosts: ['h1', 'h2'], switches: { s1: {}, s2: {} },
      links: [['h1', 's1', '2ms', 100], ['h2', 's1', '2ms', 100], ['s1', 's2', '1ms', 1000]],
      layout: { h1: { x: 120, y: 90 }, h2: { x: 120, y: 290 }, s1: { x: 380, y: 190 }, s2: { x: 650, y: 190 } } },
  } }));
  await page.getByRole('link', { name: 'Topology', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Topology canvas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Topology menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import saved topology', exact: true }).click();
  const topologyDialog = page.getByRole('dialog', { name: 'Import saved topology', exact: true });
  await topologyDialog.getByRole('combobox', { name: 'Saved topology', exact: true }).click();
  await page.getByRole('option', { name: 'docs-topology.json', exact: true }).click();
  // Import updates the unified draft canvas; it does not deploy the network.
  await topologyDialog.getByRole('button', { name: 'Import topology', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select switch s2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select link 1: h1 to s1', exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 1040 });
  await positionTopology();
  await capture('topology');
  await page.setViewportSize({ width: 390, height: 844 });
  await positionTopology();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('The topology builder overflows a mobile viewport.');
  await page.screenshot({ path: fileURLToPath(new URL('../test-results/mobile-topology.png', import.meta.url)), animations: 'disabled' });
  console.log(`Captured README screenshots in ${destination}`);
} finally {
  await browser.close();
}
