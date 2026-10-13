import { expect, test } from '@playwright/test';

const shot = (name: string) => `e2e/screenshots/${name}.png`;
const EVO = 'http://127.0.0.1:4010';
const CW = 'http://127.0.0.1:4020';

test.describe.configure({ mode: 'serial' });

test('first run: admin, onboarding, new instance paired by QR, two-way messages', async ({ page, request }) => {
  // Create the administrator.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create the administrator' })).toBeVisible();
  await page.getByLabel('Name').fill('Admin');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('weak');
  await expect(page.getByText('One special character')).toBeVisible();
  await page.getByLabel('Password').fill('Secret#123');
  await page.screenshot({ path: shot('01-setup') });
  await page.getByRole('button', { name: 'Create account' }).click();

  // Onboarding, before the dashboard: Evolution Go then Chatwoot.
  await expect(page.getByRole('heading', { name: 'Connect your Evolution Go' })).toBeVisible();
  await page.getByLabel('Server URL').fill(EVO);
  await page.getByLabel('Global API key').fill('wrong-key');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('rejected');
  await page.getByLabel('Global API key').fill('global-key-123');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('2 instances found');
  await page.screenshot({ path: shot('02-onboarding-evolution') });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByRole('heading', { name: 'Connect your Chatwoot' })).toBeVisible();
  await page.getByLabel('Server URL').fill(CW);
  await page.getByLabel('Access token').fill('admin-token');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('Signed in as Ana Admin');
  await page.getByRole('button', { name: 'Save and finish' }).click();

  // Dashboard, empty.
  await expect(page.getByRole('heading', { name: 'No connections yet' })).toBeVisible();
  await page.screenshot({ path: shot('03-overview-empty') });
  await page.getByRole('link', { name: 'Create connection' }).click();

  // Step 1: create a new instance and link the phone by QR, inside EvoBridge.
  await expect(page.getByRole('heading', { name: 'Which WhatsApp number?' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Instance' }).click();
  await page.getByRole('option', { name: 'Create a new instance' }).click();
  await page.getByLabel('Instance name').fill('vendas');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByAltText('WhatsApp QR code')).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: shot('04-wizard-qr') });
  await request.post(`${EVO}/__demo/scan`, { data: { instance: 'vendas' } });
  await expect(page.getByText('vendas is linked to WhatsApp')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 2: inbox.
  await expect(page.getByRole('heading', { name: 'Which Chatwoot inbox?' })).toBeVisible();
  await expect(page.getByLabel('Inbox name')).toHaveValue('WhatsApp vendas');
  await expect(page.getByLabel('EvoBridge public URL')).toHaveValue('http://localhost:3950');
  await page.screenshot({ path: shot('05-wizard-inbox') });
  await page.getByRole('button', { name: 'Create connection' }).click();

  // Step 3: provisioning, every step verified.
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: shot('06-wizard-connected') });
  const cwAfterSetup = await (await request.get(`${CW}/__demo/state`)).json();
  expect(cwAfterSetup.messages.some((m: { private: boolean; content: string }) => m.private && /WhatsApp conectado/.test(m.content))).toBe(true);
  await page.getByRole('button', { name: 'Open connection' }).click();

  // A customer writes; an agent answers.
  const incoming = await request.post(`${EVO}/__demo/incoming`, { data: { text: 'Oi! Vocês entregam hoje?', instance: 'vendas' } });
  expect((await incoming.json()).delivered).toBe(200);
  await expect(page.getByText('Text message').first()).toBeVisible({ timeout: 10_000 });
  const reply = await request.post(`${CW}/__demo/reply`, { data: { text: 'Entregamos sim!' } });
  expect((await reply.json()).ok).toBe(true);
  await expect(page.getByText('Agent reply').first()).toBeVisible({ timeout: 10_000 });
  const evoState = await (await request.get(`${EVO}/__demo/state`)).json();
  expect(evoState.sent.at(-1).text).toBe('*Ana:*\nEntregamos sim!');
  await page.screenshot({ path: shot('07-connection') });

  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByText('Connected').first()).toBeVisible();
  await page.screenshot({ path: shot('08-overview') });

  await page.getByRole('link', { name: 'Events & Logs' }).click();
  await expect(page.getByRole('cell', { name: /Agent reply/ }).first()).toBeVisible();
  await page.screenshot({ path: shot('09-events') });
  await page.getByRole('cell', { name: /Agent reply/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('WhatsApp message');
  await page.keyboard.press('Escape');

  await page.getByRole('link', { name: 'Providers' }).click();
  await expect(page.getByText('glob••••-123')).toBeVisible();
  await expect(page.getByText('global-key-123')).toHaveCount(0);
  await page.screenshot({ path: shot('10-providers') });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();
});

test('mobile layout has a working menu', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await page.goto('/');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('Secret#123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.screenshot({ path: shot('11-mobile-overview'), fullPage: true });
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Connections' }).click();
  await expect(page.getByRole('heading', { name: 'Connections' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});
