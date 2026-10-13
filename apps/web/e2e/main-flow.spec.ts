import { expect, test } from '@playwright/test';

const shot = (name: string) => `e2e/screenshots/${name}.png`;

test.describe.configure({ mode: 'serial' });

test('admin sets up EvoBridge and bridges a WhatsApp instance to Chatwoot', async ({ page, request }) => {
  // First run: create the administrator.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create the administrator' })).toBeVisible();
  await page.getByLabel('Name').fill('Rodrigo');
  await page.getByLabel('Email').fill('admin@example.com');
  await page.getByLabel('Password').fill('weak');
  await expect(page.getByText('One special character')).toBeVisible();
  await page.getByLabel('Password').fill('Secret#123');
  await page.screenshot({ path: shot('01-setup') });
  await page.getByRole('button', { name: 'Create account' }).click();

  // Empty overview.
  await expect(page.getByRole('heading', { name: 'No connections yet' })).toBeVisible();
  await page.screenshot({ path: shot('02-overview-empty') });
  await page.getByRole('link', { name: 'Create connection' }).click();

  // Step 1: Evolution Go.
  await expect(page.getByRole('heading', { name: 'Where is your Evolution Go?' })).toBeVisible();
  await page.getByLabel('Server URL').fill('http://127.0.0.1:4010');
  await page.getByLabel('Global API key').fill('wrong-key');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('rejected');
  await page.getByLabel('Global API key').fill('global-key-123');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('2 instances found');
  await page.screenshot({ path: shot('03-wizard-evolution') });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 2: Chatwoot.
  await expect(page.getByRole('heading', { name: 'Where is your Chatwoot?' })).toBeVisible();
  await page.getByLabel('Server URL').fill('http://127.0.0.1:4020');
  await page.getByLabel('Access token').fill('admin-token');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('status')).toContainText('Signed in as Ana Admin');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 3: link instance -> inbox.
  await expect(page.getByRole('heading', { name: 'Link a WhatsApp number to an inbox' })).toBeVisible();
  await page.getByRole('combobox', { name: 'WhatsApp instance' }).click();
  await page.getByRole('option', { name: /loja/ }).click();
  await expect(page.getByLabel('Inbox name')).toHaveValue('WhatsApp loja');
  await expect(page.getByLabel('EvoBridge public URL')).toHaveValue('http://localhost:3950');
  await page.screenshot({ path: shot('04-wizard-link') });
  await page.getByRole('button', { name: 'Create connection' }).click();

  // Step 4: provisioning, every step verified.
  await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Two-way sync is active')).toBeVisible();
  await page.screenshot({ path: shot('05-wizard-connected') });
  await page.getByRole('button', { name: 'Open connection' }).click();

  // A customer writes on WhatsApp; an agent answers in Chatwoot.
  const incoming = await request.post('http://127.0.0.1:4010/__demo/incoming', { data: { text: 'Oi! Vocês entregam hoje?' } });
  expect((await incoming.json()).delivered).toBe(200);
  await expect(page.getByText('Text message').first()).toBeVisible({ timeout: 10_000 });
  const reply = await request.post('http://127.0.0.1:4020/__demo/reply', { data: { text: 'Entregamos sim!' } });
  expect((await reply.json()).ok).toBe(true);
  await expect(page.getByText('Agent reply').first()).toBeVisible({ timeout: 10_000 });
  const cwState = await (await request.get('http://127.0.0.1:4020/__demo/state')).json();
  expect(cwState.messages.some((m: { source_id: string; message_type: string }) => m.message_type === 'incoming' && m.source_id?.startsWith('WAID:'))).toBe(true);
  const evoState = await (await request.get('http://127.0.0.1:4010/__demo/state')).json();
  expect(evoState.sent.at(-1).text).toBe('*Ana:*\nEntregamos sim!');
  await page.screenshot({ path: shot('06-connection') });

  // Overview reflects real state.
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page.getByText('Connected').first()).toBeVisible();
  await page.screenshot({ path: shot('07-overview') });

  // Logs: filter and inspect an event.
  await page.getByRole('link', { name: 'Events & Logs' }).click();
  await expect(page.getByRole('cell', { name: /Agent reply/ }).first()).toBeVisible();
  await page.screenshot({ path: shot('08-events') });
  await page.getByRole('cell', { name: /Agent reply/ }).first().click();
  await expect(page.getByRole('dialog')).toContainText('WhatsApp message');
  await page.keyboard.press('Escape');

  // Providers never show the stored key.
  await page.getByRole('link', { name: 'Providers' }).click();
  await expect(page.getByText('glob••••-123')).toBeVisible();
  await expect(page.getByText('global-key-123')).toHaveCount(0);
  await page.screenshot({ path: shot('09-providers') });

  // Light theme renders too.
  await page.getByRole('button', { name: /Rodrigo/ }).click();
  await page.getByRole('menuitem', { name: 'Light theme' }).click();
  await page.getByRole('link', { name: 'Overview' }).click();
  await page.screenshot({ path: shot('10-overview-light') });

  // Session survives a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
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
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
