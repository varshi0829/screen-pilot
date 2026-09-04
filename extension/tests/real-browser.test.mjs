// ScreenPilot — Real-Browser DOMMatcher Verification Suite
// Executes inside a real Chromium instance via Playwright.
// Run: node extension/tests/real-browser.test.mjs

import { chromium } from 'playwright';
import fs from 'fs';

const domMatcherSource = fs.readFileSync('extension/lib/dom-matcher.js', 'utf-8');

async function runBrowserTests() {
  console.log('Launching Chromium for real-browser testing...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  let passed = 0;
  let failed = 0;
  const testResults = [];

  async function testScenario(id, name, htmlContent, testFn) {
    console.log(`\n[Scenario ${id}] ${name}`);
    try {
      await page.setContent(htmlContent);
      // Inject dom-matcher.js
      await page.evaluate((src) => {
        const script = document.createElement('script');
        script.textContent = src;
        document.head.appendChild(script);
      }, domMatcherSource);

      const result = await page.evaluate(testFn);
      if (result.error) {
        throw new Error(result.error);
      }
      console.log(`  ✓ PASS: ${name}`);
      if (result.details) {
        console.log(`    Details: ${JSON.stringify(result.details)}`);
      }
      passed++;
      testResults.push({ id, name, status: 'PASS', details: result.details });
    } catch (err) {
      console.error(`  ✗ FAIL: ${name}`);
      console.error(`    Error: ${err.message}`);
      failed++;
      testResults.push({ id, name, status: 'FAIL', error: err.message });
    }
  }

  // 1. specific link vs large navigation container
  await testScenario(
    1,
    'Specific link vs large navigation container',
    `<!DOCTYPE html>
    <html>
      <body>
        <header>
          <nav id="repo-nav" aria-label="Repository" class="js-repo-nav">
            <a id="code-tab" href="/repo/code">Code</a>
            <a id="issues-tab" href="/repo/issues">Issues <span class="Counter">5.2k</span></a>
            <a id="pulls-tab" href="/repo/pulls">Pull requests <span class="Counter">2.5k</span></a>
            <a id="actions-tab" href="/repo/actions">Actions</a>
            <a id="projects-tab" href="/repo/projects">Projects</a>
            <a id="wiki-tab" href="/repo/wiki">Wiki</a>
            <a id="security-tab" href="/repo/security">Security</a>
            <a id="insights-tab" href="/repo/insights">Insights</a>
            <a id="settings-tab" href="/repo/settings">Settings</a>
          </nav>
        </header>
      </body>
    </html>`,
    () => {
      const rIssues = window.DOMMatcher.matchElement({ text: 'Issues', type: 'link' });
      if (!rIssues) return { error: 'No match for Issues' };
      if (rIssues.element.id !== 'issues-tab') {
        return { error: `Expected #issues-tab, got #${rIssues.element.id || rIssues.element.tagName}` };
      }

      const rPulls = window.DOMMatcher.matchElement({ text: 'Pull requests', type: 'link' });
      if (!rPulls) return { error: 'No match for Pull requests' };
      if (rPulls.element.id !== 'pulls-tab') {
        return { error: `Expected #pulls-tab, got #${rPulls.element.id || rPulls.element.tagName}` };
      }

      const navScore = rPulls.candidates.find(c => c.element.id === 'repo-nav')?.score ?? 0;

      return {
        details: {
          issuesWinner: rIssues.element.id,
          issuesScore: rIssues.score,
          pullsWinner: rPulls.element.id,
          pullsScore: rPulls.score,
          navContainerScore: navScore
        }
      };
    }
  );

  // 2. badge-suffixed target
  await testScenario(
    2,
    'Badge-suffixed target',
    `<!DOCTYPE html>
    <html>
      <body>
        <nav>
          <a id="notifs" href="/notifications">Notifications <span class="badge">12</span></a>
          <a id="inbox" href="/inbox">Inbox <span class="badge">99+</span></a>
          <a id="archive" href="/archive">Archive</a>
        </nav>
      </body>
    </html>`,
    () => {
      const rNotifs = window.DOMMatcher.matchElement({ text: 'Notifications', type: 'link' });
      if (!rNotifs) return { error: 'No match for Notifications' };
      if (rNotifs.element.id !== 'notifs') return { error: `Expected #notifs, got #${rNotifs.element.id}` };

      const rInbox = window.DOMMatcher.matchElement({ text: 'Inbox', type: 'link' });
      if (!rInbox) return { error: 'No match for Inbox' };
      if (rInbox.element.id !== 'inbox') return { error: `Expected #inbox, got #${rInbox.element.id}` };

      return {
        details: {
          notifsScore: rNotifs.score,
          notifsReason: rNotifs.reason,
          inboxScore: rInbox.score,
          inboxReason: rInbox.reason
        }
      };
    }
  );

  // 3. target phrase inside unrelated descriptive text
  await testScenario(
    3,
    'Target phrase inside unrelated descriptive text',
    `<!DOCTYPE html>
    <html>
      <body>
        <header>
          <nav>
            <a id="real-pulls-tab" href="/pulls">Pull requests <span class="count">2.5k</span></a>
          </nav>
        </header>
        <main>
          <div id="contributing-section" class="doc-section">
            <h2>Contributing Guidelines</h2>
            <p id="doc-para">Before submitting pull requests, please read our contribution guide carefully and adhere to standards.</p>
            <a id="doc-link" href="/contributing">Submitting pull requests and guidelines for authors</a>
          </div>
        </main>
      </body>
    </html>`,
    () => {
      const r = window.DOMMatcher.matchElement({ text: 'Pull requests', type: 'link' });
      if (!r) return { error: 'No match found' };
      if (r.element.id !== 'real-pulls-tab') {
        return { error: `Expected #real-pulls-tab, got #${r.element.id} (text: "${r.element.innerText}")` };
      }

      const realTabScore = r.candidates.find(c => c.element.id === 'real-pulls-tab')?.score;
      const docLinkScore = r.candidates.find(c => c.element.id === 'doc-link')?.score;

      return {
        details: {
          winner: r.element.id,
          realTabScore,
          docLinkScore
        }
      };
    }
  );

  // 4. duplicate labels
  await testScenario(
    4,
    'Duplicate labels (DOM order & region disambiguation)',
    `<!DOCTYPE html>
    <html>
      <body>
        <header style="height: 60px;">
          <button id="header-profile" class="btn">Profile</button>
          <button id="header-settings" class="btn">Settings</button>
        </header>
        <aside style="position: absolute; left: 0; top: 100px; width: 200px;">
          <button id="sidebar-profile" class="btn">Profile</button>
          <button id="sidebar-settings" class="btn">Settings</button>
        </aside>
        <footer>
          <button id="footer-profile" class="btn">Profile</button>
        </footer>
      </body>
    </html>`,
    () => {
      // 4A: Without region hint -> first in DOM order
      const rNoRegion = window.DOMMatcher.matchElement({ text: 'Profile', type: 'button' });
      if (!rNoRegion) return { error: 'No match for Profile without region' };
      if (rNoRegion.element.id !== 'header-profile') {
        return { error: `Expected #header-profile without region, got #${rNoRegion.element.id}` };
      }

      // 4B: With side_navigation region hint -> sidebar button
      const rSidebar = window.DOMMatcher.matchElement({ text: 'Profile', type: 'button', region: 'side_navigation' });
      if (!rSidebar) return { error: 'No match for Profile with side_navigation' };
      if (rSidebar.element.id !== 'sidebar-profile') {
        return { error: `Expected #sidebar-profile for side_navigation, got #${rSidebar.element.id}` };
      }

      // 4C: With top_navigation region hint -> header button
      const rTop = window.DOMMatcher.matchElement({ text: 'Profile', type: 'button', region: 'top_navigation' });
      if (!rTop) return { error: 'No match for Profile with top_navigation' };
      if (rTop.element.id !== 'header-profile') {
        return { error: `Expected #header-profile for top_navigation, got #${rTop.element.id}` };
      }

      return {
        details: {
          noRegionWinner: rNoRegion.element.id,
          sidebarWinner: rSidebar.element.id,
          topNavWinner: rTop.element.id
        }
      };
    }
  );

  // 5. legitimate standalone heading/navigation destination
  await testScenario(
    5,
    'Legitimate standalone heading/navigation destination',
    `<!DOCTYPE html>
    <html>
      <body>
        <nav aria-label="Main Navigation">
          <a id="nav-dashboard" href="/dashboard">Dashboard</a>
          <a id="nav-analytics" href="/analytics">Analytics</a>
          <a id="nav-billing" href="/billing">Billing</a>
        </nav>
        <main>
          <section>
            <h1 id="page-title">Billing & Subscription</h1>
          </section>
        </main>
      </body>
    </html>`,
    () => {
      const rBilling = window.DOMMatcher.matchElement({ text: 'Billing', type: 'link' });
      if (!rBilling) return { error: 'No match for Billing' };
      if (rBilling.element.id !== 'nav-billing') {
        return { error: `Expected #nav-billing, got #${rBilling.element.id}` };
      }

      const rAnalytics = window.DOMMatcher.matchElement({ text: 'Analytics', type: 'link' });
      if (!rAnalytics) return { error: 'No match for Analytics' };
      if (rAnalytics.element.id !== 'nav-analytics') {
        return { error: `Expected #nav-analytics, got #${rAnalytics.element.id}` };
      }

      return {
        details: {
          billingWinner: rBilling.element.id,
          billingScore: rBilling.score,
          analyticsWinner: rAnalytics.element.id,
          analyticsScore: rAnalytics.score
        }
      };
    }
  );

  // 6. clickable element whose heading matches the goal
  await testScenario(
    6,
    'Clickable element whose heading matches the goal',
    `<!DOCTYPE html>
    <html>
      <body>
        <div class="cards-grid">
          <div id="card-deployments" role="button" tabindex="0" class="card">
            <h3 class="card-title">Deployments</h3>
            <p class="card-desc">Manage CI/CD deployments and production releases across all environments.</p>
          </div>
          <a id="card-monitoring" href="/monitoring" class="card-link">
            <h3 class="card-title">Monitoring</h3>
            <p class="card-desc">View real-time error rates, request latency, and application health metrics.</p>
          </a>
        </div>
      </body>
    </html>`,
    () => {
      const rDep = window.DOMMatcher.matchElement({ text: 'Deployments', type: 'button' });
      if (!rDep) return { error: 'No match for Deployments' };
      if (rDep.element.id !== 'card-deployments') {
        return { error: `Expected #card-deployments, got #${rDep.element.id}` };
      }

      const rMon = window.DOMMatcher.matchElement({ text: 'Monitoring', type: 'link' });
      if (!rMon) return { error: 'No match for Monitoring' };
      if (rMon.element.id !== 'card-monitoring') {
        return { error: `Expected #card-monitoring, got #${rMon.element.id}` };
      }

      return {
        details: {
          deploymentsWinner: rDep.element.id,
          deploymentsScore: rDep.score,
          monitoringWinner: rMon.element.id,
          monitoringScore: rMon.score
        }
      };
    }
  );

  // 7. hidden matching element
  await testScenario(
    7,
    'Hidden matching element exclusion',
    `<!DOCTYPE html>
    <html>
      <body>
        <div id="mobile-drawer" style="display: none;">
          <a id="hidden-settings-1" href="/settings">Settings</a>
          <button id="hidden-save-1">Save</button>
        </div>
        <div id="collapsed-panel" hidden>
          <a id="hidden-settings-2" href="/settings">Settings</a>
        </div>
        <div id="offscreen-panel" style="visibility: hidden;">
          <a id="hidden-settings-3" href="/settings">Settings</a>
        </div>
        <main>
          <a id="visible-settings" href="/settings">Settings</a>
          <button id="visible-save">Save</button>
        </main>
      </body>
    </html>`,
    () => {
      const rSettings = window.DOMMatcher.matchElement({ text: 'Settings', type: 'link' });
      if (!rSettings) return { error: 'No match for Settings' };
      if (rSettings.element.id !== 'visible-settings') {
        return { error: `Expected #visible-settings, got #${rSettings.element.id}` };
      }

      const rSave = window.DOMMatcher.matchElement({ text: 'Save', type: 'button' });
      if (!rSave) return { error: 'No match for Save' };
      if (rSave.element.id !== 'visible-save') {
        return { error: `Expected #visible-save, got #${rSave.element.id}` };
      }

      return {
        details: {
          settingsWinner: rSettings.element.id,
          settingsScore: rSettings.score,
          saveWinner: rSave.element.id,
          saveScore: rSave.score
        }
      };
    }
  );

  await browser.close();

  console.log(`\n========================================`);
  console.log(`Real-Browser Test Summary: ${passed} passed, ${failed} failed`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runBrowserTests().catch((err) => {
  console.error('Browser testing fatal error:', err);
  process.exit(1);
});
