// ScreenPilot - Enterprise Context Service
// Detects enterprise application context from DOM signals.
// Enriches Gemini prompts with: application, module, workspace, page type,
// and navigation hierarchy — without touching DOM matching or navigation logic.
//
// Architecture notes:
//  - No ES module exports — runs as a plain injected content script
//  - Sets window.EnterpriseContextService for content.js to access
//  - Data-driven: app identity lives in APP_REGISTRY (data), not in if-else branches (logic)
//  - Application-agnostic detection algorithm; adding an enterprise app = adding a registry entry
//  - Zero network calls, no PII, synchronous DOM reads only

(function () {

  // ─── APP REGISTRY ────────────────────────────────────────────────────────────
  // Matching algorithm is identical for all entries.
  // hostTokens:  substrings to search in location.hostname
  // bodyTokens:  class names / identifiers injected by the app's front-end framework
  // metaTokens:  meta tag names/properties injected by the app
  // confidence:  0–1 reliability of this entry's identification

  const APP_REGISTRY = [
    {
      name:        'SAP',
      hostTokens:  ['.sap.com', 'sap.com/', 'fiori.ondemand'],
      bodyTokens:  ['sap-ui-', 'sapM', 'sapUiBody', 'sapUShell', 'sapFiori'],
      metaTokens:  ['sap-ui', 'saptheme'],
      confidence:  0.90,
    },
    {
      name:        'Salesforce',
      hostTokens:  ['salesforce.com', 'force.com', 'lightning.force', 'my.salesforce'],
      bodyTokens:  ['slds-', 'forceContent', 'aura-', 'LightningPage', 'salesforce1'],
      metaTokens:  ['salesforce'],
      confidence:  0.90,
    },
    {
      name:        'ServiceNow',
      hostTokens:  ['service-now.com', 'servicenow.com'],
      bodyTokens:  ['sn-', 'glide', 'SNFormButton', 'servicenow'],
      metaTokens:  ['servicenow', 'glide'],
      confidence:  0.90,
    },
    {
      name:        'Jira',
      hostTokens:  ['atlassian.net', 'jira.'],
      bodyTokens:  ['jira-', 'aui-', 'issue-type', 'jiraLogo'],
      metaTokens:  ['jira', 'atlassian'],
      confidence:  0.85,
    },
    {
      name:        'Confluence',
      hostTokens:  ['atlassian.net/wiki', 'confluence.'],
      bodyTokens:  ['confluence-', 'wiki-', 'page-metadata'],
      metaTokens:  ['confluence'],
      confidence:  0.85,
    },
    {
      name:        'Azure DevOps',
      hostTokens:  ['dev.azure.com', 'visualstudio.com'],
      bodyTokens:  ['azure-devops', 'vss-', 'repos-viewer', 'work-item'],
      metaTokens:  ['azure', 'devops'],
      confidence:  0.90,
    },
    {
      name:        'Microsoft 365',
      hostTokens:  ['office.com', 'sharepoint.com', 'teams.microsoft.com', 'outlook.office', 'microsoftonline.com'],
      bodyTokens:  ['o365', 'ms-', 'fluent-', 'SharePoint', 'o365-nav', 'owa'],
      metaTokens:  ['office', 'microsoft'],
      confidence:  0.85,
    },
    {
      name:        'Workday',
      hostTokens:  ['workday.com', 'myworkday.com'],
      bodyTokens:  ['wd-', 'WDGUI', 'workday-', 'WD-', 'gwt-'],
      metaTokens:  ['workday'],
      confidence:  0.90,
    },
    {
      name:        'Oracle Cloud',
      hostTokens:  ['oraclecloud.com', 'oracle.com/cloud'],
      bodyTokens:  ['oj-', 'ojInputText', 'oracle-jet', 'oj-form', 'OracleJET'],
      metaTokens:  ['oracle'],
      confidence:  0.85,
    },
  ];

  // ─── GENERIC SELECTORS ────────────────────────────────────────────────────────

  const BREADCRUMB_SEL = [
    '[aria-label="Breadcrumb"] a', '[aria-label="breadcrumb"] a',
    'nav[aria-label*="breadcrumb" i] a', '[class*="breadcrumb" i] a',
    '[data-testid*="breadcrumb"] a', '[role="navigation"] ol li a',
  ].join(',');

  const ACTIVE_NAV_SEL = [
    '[aria-current="page"]', '[aria-selected="true"]',
    '.nav-item.active > a', '[class*="nav-item"][class*="active"]',
    '[class*="sidebar-item"][class*="active"]', '[class*="selected"][role="menuitem"]',
  ].join(',');

  const WORKSPACE_SEL = [
    '[data-workspace]', '[data-project]', '[data-testid*="workspace" i]',
    '[class*="workspace-name" i]', '[class*="project-name" i]',
    '[class*="org-name" i]', '[class*="tenant-name" i]',
  ].join(',');

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  var EnterpriseContextService = {

    /**
     * Detects enterprise context from the current page DOM.
     * Safe to call on any page — returns low-confidence defaults on non-enterprise pages.
     *
     * @returns {{application, module, workspace, pageType, navigationHierarchy, confidence, detectedAt}}
     */
    detect: function () {
      try {
        var hostname   = location.hostname.toLowerCase();
        var bodyClass  = (document.body && document.body.className) || '';
        var bodySnip   = _bodySnippet();
        var appMatch   = _matchRegistry(hostname, bodySnip, bodyClass);

        return {
          application:         appMatch ? appMatch.name : null,
          module:              _detectModule(),
          workspace:           _detectWorkspace(),
          pageType:            _detectStructuralPageType(),
          navigationHierarchy: _detectNavigationHierarchy(),
          confidence:          appMatch ? appMatch.confidence : 0,
          detectedAt:          Date.now(),
        };
      } catch (e) {
        return { application: null, module: null, workspace: null, pageType: 'other', navigationHierarchy: [], confidence: 0, detectedAt: Date.now() };
      }
    },

    /**
     * Converts context into a compact one-liner for Gemini prompt injection.
     * Returns empty string when confidence is too low to be helpful.
     */
    toPromptString: function (ctx) {
      if (!ctx || !ctx.application || ctx.confidence < 0.5) return '';
      var parts = [];
      if (ctx.application)                  parts.push('Application: ' + ctx.application);
      if (ctx.module)                        parts.push('Module: ' + ctx.module);
      if (ctx.workspace)                     parts.push('Workspace: ' + ctx.workspace);
      if (ctx.pageType && ctx.pageType !== 'other') parts.push('Page type: ' + ctx.pageType);
      if (ctx.navigationHierarchy && ctx.navigationHierarchy.length) {
        parts.push('Nav: ' + ctx.navigationHierarchy.join(' > '));
      }
      return parts.join(' | ');
    },
  };

  // ─── PRIVATE: REGISTRY MATCHING ──────────────────────────────────────────────

  function _matchRegistry(hostname, bodySnip, bodyClass) {
    var combined = bodyClass + ' ' + bodySnip;
    var bestMatch = null, bestScore = 0;

    for (var i = 0; i < APP_REGISTRY.length; i++) {
      var entry = APP_REGISTRY[i];
      var score = 0;

      var hostHit = entry.hostTokens.some(function (t) { return hostname.indexOf(t) !== -1; });
      if (hostHit) score += 60;

      var bodyHits = entry.bodyTokens.filter(function (t) { return combined.indexOf(t) !== -1; }).length;
      score += bodyHits * 12;

      var metaHit = entry.metaTokens.some(function (k) { return _metaContains(k); });
      if (metaHit) score += 20;

      if ((hostHit || bodyHits >= 2) && score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }
    return bestMatch;
  }

  function _metaContains(keyword) {
    var metas = document.querySelectorAll('meta[name],meta[property],meta[content]');
    for (var i = 0; i < metas.length; i++) {
      var attr = (metas[i].getAttribute('name') || metas[i].getAttribute('property') || metas[i].getAttribute('content') || '').toLowerCase();
      if (attr.indexOf(keyword) !== -1) return true;
    }
    return false;
  }

  function _bodySnippet() {
    if (!document.body) return '';
    var parts = [document.body.className, document.body.id, document.body.getAttribute('data-app') || ''];
    var els = document.querySelectorAll('body > div, body > main, body > header, #app, #root, #shell, #wrapper');
    for (var i = 0; i < Math.min(els.length, 10); i++) {
      parts.push(els[i].className, els[i].id);
    }
    return parts.filter(Boolean).join(' ').slice(0, 3000);
  }

  // ─── PRIVATE: MODULE ─────────────────────────────────────────────────────────

  function _detectModule() {
    var el = document.querySelector(ACTIVE_NAV_SEL);
    if (el) {
      var t = _clean(el.textContent || el.getAttribute('aria-label') || '');
      if (t.length >= 2 && t.length <= 60) return t;
    }
    var h1 = document.querySelector('main h1, [role="main"] h1, #content h1');
    if (h1) {
      var t2 = _clean(h1.textContent || '');
      if (t2.length >= 2 && t2.length <= 80) return t2;
    }
    var titleParts = document.title.split(/[-|·—]/);
    if (titleParts.length >= 2) {
      var t3 = _clean(titleParts[0]);
      if (t3.length >= 2 && t3.length <= 60) return t3;
    }
    return null;
  }

  // ─── PRIVATE: WORKSPACE ──────────────────────────────────────────────────────

  function _detectWorkspace() {
    var el = document.querySelector(WORKSPACE_SEL);
    if (el) {
      var t = _clean(el.textContent || el.getAttribute('data-workspace') || el.getAttribute('data-project') || '');
      if (t.length >= 1 && t.length <= 60) return t;
    }
    return null;
  }

  // ─── PRIVATE: STRUCTURAL PAGE TYPE ───────────────────────────────────────────

  function _detectStructuralPageType() {
    var main = document.querySelector('main, [role="main"], #main-content, #content') || document.body;

    if (main.querySelector('input[type="password"]')) return 'login';

    var inputs = main.querySelectorAll(
      'input:not([type="hidden"]):not([type="search"]):not([type="checkbox"]):not([type="radio"]), select, textarea'
    ).length;
    if (inputs >= 3) return 'form';

    var editors = main.querySelectorAll(
      '[contenteditable="true"][class], .CodeMirror, .monaco-editor, [role="textbox"][aria-multiline="true"]'
    ).length;
    if (editors >= 1) return 'editor';

    var grids = main.querySelectorAll('table, [role="grid"], [role="table"]').length;
    if (grids >= 1) return 'table';

    var cards = main.querySelectorAll('[class*="card"], [class*="widget"], [class*="tile"], [class*="metric"]').length;
    if (cards >= 4) return 'dashboard';

    var labels = main.querySelectorAll('label, dt, [class*="form-label"], [class*="field-label"]').length;
    if (labels >= 5) return 'settings';

    var lists = main.querySelectorAll('[role="listbox"], ul[class], [role="list"]').length;
    if (lists >= 2) return 'list';

    var pageTitle = (document.title + ' ' + (_textOf(document.querySelector('h1')))).toLowerCase();
    if (/settings|configuration|preferences/.test(pageTitle)) return 'settings';
    if (/dashboard|overview|home/.test(pageTitle)) return 'dashboard';

    return 'other';
  }

  // ─── PRIVATE: NAVIGATION HIERARCHY ───────────────────────────────────────────

  function _detectNavigationHierarchy() {
    var items = [];
    var els = document.querySelectorAll(BREADCRUMB_SEL);
    for (var i = 0; i < els.length && items.length < 5; i++) {
      var t = _clean(els[i].textContent || els[i].getAttribute('aria-label') || '');
      if (t.length >= 1 && t.length <= 60 && items.indexOf(t) === -1) items.push(t);
    }
    return items;
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────────

  function _clean(raw) { return (raw || '').replace(/\s+/g, ' ').trim(); }
  function _textOf(el) { return el ? (el.textContent || '') : ''; }

  // ─── EXPORT ──────────────────────────────────────────────────────────────────
  // Dual export: window global for content script injection, CommonJS for tests.

  if (typeof window !== 'undefined') {
    window.EnterpriseContextService = EnterpriseContextService;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EnterpriseContextService;
  }

})();
