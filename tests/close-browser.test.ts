/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import {describe, it} from 'node:test';

import puppeteer, {executablePath} from 'puppeteer';

import {BrowserManager} from '../src/BrowserManager.js';
import {McpServer} from '../src/index.js';

import {createMockServerConfig} from './mocks.js';

describe('close_browser lifecycle', () => {
  it('closes only its own Chrome process and supports a fresh session', async () => {
    const config = createMockServerConfig({
      headless: true,
      isolated: true,
      executablePath: await executablePath(),
      usageStatistics: false,
    });
    const firstManager = new BrowserManager(config);
    const secondManager = new BrowserManager(config);
    await using firstServer = await McpServer.from(config, {
      browserManager: firstManager,
    });
    await using secondServer = await McpServer.from(config, {
      browserManager: secondManager,
    });

    const firstListing = await firstServer.callTool('list_pages');
    const secondListing = await secondServer.callTool('list_pages');
    assert.strictEqual(firstListing.isError, undefined);
    assert.strictEqual(secondListing.isError, undefined);
    const firstBrowser = await firstManager.ensureBrowser();
    const secondBrowser = await secondManager.ensureBrowser();
    const firstProcess = firstBrowser.process();
    const secondProcess = secondBrowser.process();
    assert.ok(firstProcess);
    assert.ok(secondProcess);
    assert.notStrictEqual(firstProcess.pid, secondProcess.pid);
    const profileArg = firstProcess.spawnargs.find(arg =>
      arg.startsWith('--user-data-dir='),
    );
    assert.ok(profileArg);
    const profilePath = profileArg.slice('--user-data-dir='.length);

    const cleanup = await firstServer.callTool('close_browser');
    assert.strictEqual(cleanup.isError, undefined);
    assert.strictEqual(firstBrowser.connected, false);
    assert.ok(
      firstProcess.exitCode !== null || firstProcess.signalCode !== null,
      'The owned Chrome process must have exited before cleanup returns',
    );
    assert.strictEqual(fs.existsSync(profilePath), false);

    assert.strictEqual(secondBrowser.connected, true);
    assert.strictEqual(secondProcess.exitCode, null);
    assert.strictEqual(secondProcess.signalCode, null);
    const [secondPage] = await secondBrowser.pages();
    assert.strictEqual(await secondPage.evaluate(() => 42), 42);
    const unaffectedListing = await secondServer.callTool('list_pages');
    assert.strictEqual(unaffectedListing.isError, undefined);

    const repeatedCleanup = await firstServer.callTool('close_browser');
    assert.strictEqual(repeatedCleanup.isError, undefined);
    const reopenedListing = await firstServer.callTool('list_pages');
    assert.strictEqual(reopenedListing.isError, undefined);
    const reopenedBrowser = await firstManager.ensureBrowser();
    assert.notStrictEqual(reopenedBrowser, firstBrowser);
    assert.notStrictEqual(reopenedBrowser.process()?.pid, firstProcess.pid);
    const [reopenedPage] = await reopenedBrowser.pages();
    assert.strictEqual(await reopenedPage.evaluate(() => 43), 43);
  });

  it('disconnects from an attached Chrome without closing it', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath: await executablePath(),
    });
    try {
      const config = createMockServerConfig({
        wsEndpoint: browser.wsEndpoint(),
        usageStatistics: false,
      });
      const browserManager = new BrowserManager(config);
      await using server = await McpServer.from(config, {browserManager});
      const listing = await server.callTool('list_pages');
      assert.strictEqual(listing.isError, undefined);
      const attachedBrowser = await browserManager.ensureBrowser();

      const cleanup = await server.callTool('close_browser');
      assert.strictEqual(cleanup.isError, undefined);
      assert.strictEqual(attachedBrowser.connected, false);
      assert.strictEqual(browser.connected, true);
      const [page] = await browser.pages();
      assert.strictEqual(await page.evaluate(() => 42), 42);
    } finally {
      await browser.close();
    }
  });
});
