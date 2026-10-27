#!/usr/bin/env node
'use strict';

/**
 * Real production-renderer title-bar checks. Only /user/data requests bearing
 * this synthetic token are fulfilled; other NovelAI traffic retains the
 * caller's deny route. The caller owns the isolated Electron/profile/Xvfb.
 */
const assert = require('node:assert/strict');
const path = require('node:path');

module.exports = async function verifyTitlebar({
  application,
  page,
  reportDirectory,
  result,
}) {
  const routePattern = /^https:\/\/image\.novelai\.net\/user\/data(?:\?.*)?$/i;
  const fixtureToken = 'sdstudio-titlebar-smoke-fixture';
  let credits = 12345;
  let percent = 73;
  let mode = 'ready';
  let nextValidation = false;
  let releaseRead;
  let pendingRead = Promise.resolve();
  const metadataRequests = [];
  const geometry = [];
  const windowState = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().startsWith('file:'),
    );
    if (!window) throw new Error('No owned production BrowserWindow');
    return {
      id: window.id,
      size: window.getSize(),
      minimum: window.getMinimumSize(),
    };
  });
  const body = () => ({
    subscription: {
      active: true,
      tier: 3,
      trainingStepsLeft: {
        fixedTrainingStepsLeft: credits,
        purchasedTrainingSteps: 0,
      },
      usage: { percent, isNegative: false, timeUntilNextPercent: 60 },
    },
  });
  const handler = async (route) => {
    const request = route.request();
    assert.equal(request.method(), 'GET');
    assert.equal(
      request.headers().authorization,
      `Bearer ${fixtureToken}`,
      'The titlebar fixture may intercept only its own synthetic token',
    );
    metadataRequests.push({ mode, method: request.method() });
    if (nextValidation) {
      nextValidation = false;
      await route.fulfill({ status: 200, json: body() });
      return;
    }
    const capturedMode = mode;
    if (capturedMode === 'pending') await pendingRead;
    if (capturedMode === 'error') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Synthetic metadata failure' }),
      });
      return;
    }
    await route.fulfill({ status: 200, json: body() });
  };
  const waitForAccount = async ({
    balance,
    quota,
    balanceTitle,
    quotaTitle,
  }) => {
    await page.waitForFunction(
      (expected) => {
        const group = document.querySelector(
          '[aria-label="계정 잔액 및 생성 할당량"]',
        );
        const output = group?.querySelector('output');
        const button = group?.querySelector('button');
        return (
          output?.getAttribute('aria-label') === expected.balance &&
          button?.getAttribute('aria-label') === expected.quota &&
          (!expected.balanceTitle ||
            output.title.includes(expected.balanceTitle)) &&
          (!expected.quotaTitle || button.title.includes(expected.quotaTitle))
        );
      },
      { balance, quota, balanceTitle, quotaTitle },
    );
  };
  const refreshAccount = () =>
    page.evaluate(() => {
      // Existing post-encoding notification, with no encoding or generation
      // submitted and no display values assigned by the test.
      window.imageService.dispatchEvent(new Event('encode-vibe'));
    });

  await page.context().route(routePattern, handler);
  try {
    await page.evaluate(
      (token) => window.loginService.loginWithToken(token),
      fixtureToken,
    );
    await waitForAccount({
      balance: 'Anlas 12,345',
      quota: '무료 생성 할당량 73%, 상세 보기',
    });
    assert.equal(
      metadataRequests.length,
      2,
      'Login validation and one coalesced account read expected',
    );

    for (const width of [1280, 1024, 768, 480]) {
      await application.evaluate(
        ({ BrowserWindow }, { id, width }) => {
          const window = BrowserWindow.fromId(id);
          if (!window) throw new Error('Owned window disappeared');
          window.setMinimumSize(0, 0);
          window.setSize(width, 800);
        },
        { id: windowState.id, width },
      );
      await page.waitForFunction(
        (expectedWidth) => window.innerWidth === expectedWidth,
        width,
      );
      const layout = await page.evaluate(() => {
        const account = document.querySelector(
          '[aria-label="계정 잔액 및 생성 할당량"]',
        );
        const controls = document.querySelector('[aria-label="창 제어"]');
        const titlebar = account.closest('.zone-bar.titlebar-drag');
        const projectSelector = Array.from(
          titlebar.querySelectorAll('button'),
        ).find((button) => button.textContent.trim() === '프로젝트 선택');
        let projectRegion = projectSelector;
        while (projectRegion && projectRegion.parentElement !== titlebar) {
          projectRegion = projectRegion.parentElement;
        }
        const rectangle = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            right: rect.right,
            bottom: rect.bottom,
          };
        };
        const hitAtCenter = (element) => {
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          );
          return hit === element || element.contains(hit);
        };
        const projectControls = projectRegion
          ? Array.from(
              projectRegion.querySelectorAll(
                'button, [role="button"], select, summary, a[href]',
              ),
            )
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  getComputedStyle(element).visibility !== 'hidden'
                );
              })
              .map((element, index) => ({
                label:
                  element.getAttribute('aria-label') ||
                  element.getAttribute('title') ||
                  element.textContent.trim() ||
                  `project control ${index + 1}`,
                ...rectangle(element),
                hit: hitAtCenter(element),
                disabled:
                  element.matches(':disabled, [aria-disabled="true"]') ||
                  getComputedStyle(element).pointerEvents === 'none',
              }))
          : [];
        const generationDock = document.querySelector('[data-gen-dock]');
        const generationRegion = generationDock?.querySelector(
          '[data-slot="gencontrol"]',
        );
        const generationControls = generationRegion
          ? Array.from(generationRegion.querySelectorAll('button, input'))
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  getComputedStyle(element).visibility !== 'hidden'
                );
              })
              .map((element) => ({
                label:
                  element.getAttribute('aria-label') ||
                  element.getAttribute('title') ||
                  element.textContent.trim(),
                ...rectangle(element),
                hit: hitAtCenter(element),
                disabled: element.matches(':disabled, [aria-disabled="true"]'),
              }))
          : [];
        return {
          generationDock: generationDock ? rectangle(generationDock) : null,
          generationControls,
          viewport: { width: window.innerWidth, height: window.innerHeight },
          titlebar: rectangle(titlebar),
          projectRegion: projectRegion ? rectangle(projectRegion) : null,
          projectControls,
          account: rectangle(account),
          controls: rectangle(controls),
          values: Array.from(account.querySelectorAll('output,button')).map(
            (element) => ({
              label: element.getAttribute('aria-label'),
              ...rectangle(element),
              hit: hitAtCenter(element),
            }),
          ),
          buttons: Array.from(controls.querySelectorAll('button')).map(
            (button) => {
              const rect = button.getBoundingClientRect();
              const atCenter = document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2,
              );
              return {
                label: button.getAttribute('aria-label'),
                ...rectangle(button),
                hit: atCenter === button || button.contains(atCenter),
              };
            },
          ),
        };
      });
      result.titlebarLayoutProbe = layout;
      assert.equal(layout.buttons.length, 3);
      assert.equal(layout.values.length, 2);
      assert(
        layout.account.right <= layout.controls.x + 1,
        'Account overlaps window controls',
      );
      // The titlebar and bottom dock share desktop breakpoints. Real native
      // controls must remain present and reachable when project navigation moves.
      for (const label of [
        '생성 개수',
        '작업 진행 상황',
        '씬 일괄 예약',
        '모든 예약 제거',
        '생성 시작',
      ]) {
        assert(
          layout.generationControls.some((control) => control.label === label),
          `Generation control disappeared: ${label}`,
        );
      }
      for (const control of layout.generationControls) {
        assert(
          control.x >= 0 &&
            control.right <= layout.viewport.width + 1 &&
            control.y >= layout.generationDock.y - 1 &&
            control.bottom <= layout.viewport.height + 1,
          `Generation control is outside the visible dock: ${control.label}`,
        );
        if (!control.disabled) {
          assert(
            control.hit,
            `Generation control is covered: ${control.label}`,
          );
        }
      }
      const overlaps = (a, b) =>
        Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
      for (const project of layout.projectControls) {
        assert(
          !overlaps(project, layout.account),
          `Project control overlaps account status: ${project.label}`,
        );
        assert(
          !overlaps(project, layout.controls),
          `Project control overlaps window controls: ${project.label}`,
        );
        assert(
          project.x >= layout.projectRegion.x - 1 &&
            project.right <= layout.projectRegion.right + 1 &&
            project.y >= layout.projectRegion.y - 1 &&
            project.bottom <= layout.projectRegion.bottom + 1,
          `Project control escapes its titlebar slot: ${project.label}`,
        );
        if (!project.disabled) {
          assert(project.hit, `Project control is covered: ${project.label}`);
        }
      }
      assert(
        Math.abs(
          layout.account.y +
            layout.account.height / 2 -
            (layout.controls.y + layout.controls.height / 2),
        ) <= 1,
        'Account and native controls are no longer on the same titlebar row',
      );
      if (width < 768) {
        assert(
          layout.projectControls.length > 0,
          'Narrow titlebar lost project navigation',
        );
        await page
          .locator('.zone-bar.titlebar-drag')
          .getByRole('button', {
            name: '프로젝트 목록 열기 (폴더 드로어)',
            exact: true,
          })
          .click({ trial: true });
      }
      for (const value of layout.values) {
        assert(value.hit, `Account status is covered: ${value.label}`);
      }
      for (const item of [
        ...layout.values,
        ...layout.buttons,
        ...layout.projectControls,
      ]) {
        assert(
          item.width > 8 && item.height > 8,
          `Invisible titlebar control: ${item.label}`,
        );
        assert(
          item.x >= 0 && item.right <= layout.viewport.width + 1,
          `Offscreen control: ${item.label}`,
        );
      }
      for (const button of layout.buttons) {
        assert(button.hit, `Window button is covered: ${button.label}`);
        const target = page
          .getByRole('group', { name: '창 제어', exact: true })
          .getByRole('button', { name: button.label, exact: true });
        // Check the actual rendered hit target without closing/minimizing the
        // only test window midway through the remaining runtime checks.
        await target.click({ trial: true });
        await target.focus();
        assert(
          await target.evaluate(
            (element) => document.activeElement === element,
          ),
        );
      }
      const quota = page.getByRole('button', {
        name: '무료 생성 할당량 73%, 상세 보기',
        exact: true,
      });
      const dialog = page.getByRole('dialog', {
        name: 'Opus 무료 생성 할당량',
        exact: true,
      });
      for (const activation of ['Enter', 'Space']) {
        await quota.focus();
        await quota.press(activation);
        await dialog.waitFor({ state: 'visible' });
        const bounds = await dialog.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        const close = dialog.getByRole('button', { name: '닫기', exact: true });
        const refresh = dialog.getByRole('button', {
          name: '새로고침',
          exact: true,
        });
        await page.waitForFunction(() => {
          const panel = document.querySelector(
            '[role="dialog"][aria-label="Opus 무료 생성 할당량"]',
          );
          return panel?.querySelector('button') === document.activeElement;
        });
        // These are ordinary middle transitions, not only the trap's edge wrapping.
        await page.keyboard.press('Tab');
        assert(
          await refresh.evaluate(
            (element) => document.activeElement === element,
          ),
          'Tab did not move from the dialog close button to refresh',
        );
        await page.keyboard.press('Shift+Tab');
        assert(
          await close.evaluate((element) => document.activeElement === element),
          'Shift+Tab did not return from refresh to the dialog close button',
        );
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert(
          await quota.evaluate((element) => document.activeElement === element),
        );
      }
      await page.screenshot({
        path: path.join(reportDirectory, `titlebar-${width}.png`),
      });
      geometry.push(layout);
    }

    mode = 'pending';
    pendingRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await refreshAccount();
    await waitForAccount({
      balance: 'Anlas 12,345',
      quota: '무료 생성 할당량 73%, 상세 보기',
      balanceTitle: '확인 중',
      quotaTitle: '확인 중',
    });
    await page.screenshot({
      path: path.join(reportDirectory, 'titlebar-pending.png'),
    });
    credits = 0;
    percent = 0;
    mode = 'ready';
    releaseRead();
    await waitForAccount({
      balance: 'Anlas 0',
      quota: '무료 생성 할당량 0%, 상세 보기',
    });
    await page.screenshot({
      path: path.join(reportDirectory, 'titlebar-zero.png'),
    });

    mode = 'error';
    await refreshAccount();
    await waitForAccount({
      balance: 'Anlas 0',
      quota: '무료 생성 할당량 0%, 상세 보기',
      balanceTitle: '조회 실패',
      quotaTitle: '이전 조회값',
    });
    await page.screenshot({
      path: path.join(reportDirectory, 'titlebar-stale.png'),
    });

    // A confirmed login followed by failed metadata must not retain old zero.
    // Reload gives the synthetic account a fresh production service/cache.
    nextValidation = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAccount({
      balance: 'Anlas 미확인',
      quota: '무료 생성 할당량 —, 상세 보기',
      balanceTitle: '조회 실패',
      quotaTitle: '조회 실패',
    });
    await page.screenshot({
      path: path.join(reportDirectory, 'titlebar-unknown.png'),
    });
    result.titlebar = {
      metadataRequests,
      geometry,
      syntheticAccountOnly: true,
      states: ['ready', 'refreshing', 'zero', 'stale', 'unknown-error'],
      nativeWindowButtons:
        'visible, unobstructed, keyboard-focusable and click-actionable',
      quotaDialog:
        'Enter/Space open, middle Tab/Shift+Tab, Escape/focus-return and viewport bounds',
    };
    return result.titlebar;
  } finally {
    if (releaseRead) releaseRead();
    // Only the newly-created profile receives this fixture. Clear it before
    // the caller's reload/restart and local-data checks, then remove the route.
    await page.evaluate(async () => {
      await window.electron.ipcRenderer.invoke(
        'write-global-file',
        'TOKEN.txt',
        '',
      );
      await window.loginService.refresh(true);
    });
    await page.context().unroute(routePattern, handler);
    await application.evaluate(({ BrowserWindow }, saved) => {
      const window = BrowserWindow.fromId(saved.id);
      if (!window) return;
      window.setMinimumSize(...saved.minimum);
      window.setSize(...saved.size);
    }, windowState);
  }
};
