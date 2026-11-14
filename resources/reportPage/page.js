// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Script of the report page of a resource of the view Docker Hosts (src/vscode/reportPage.ts). It only shows the view
// that the extension sends (reportPageModel.ts), and sends the clicks of its buttons. Texts from the extension are
// always set as text, never as HTML. While text on the page is selected, the page keeps its content, so that the
// selection can be copied; it shows the newest view when the selection ends. The content is built again only when it
// changed, so that a Refresh keeps the place of the scroll while it reads.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const ACTIONS = ['refresh', 'showLog', 'showFiles', 'startVm'];
  const TONES = ['keep', 'remove', 'info', 'warn', 'new'];
  const NAME_TONES = ['inactive', 'notDevspaces', 'notDevspacesInactive'];

  const $ = (id) => document.getElementById(id);

  function el(tag, attributes, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === false) continue;
      if (key === 'text') node.textContent = value;
      else if (key === 'className') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children || []) if (child) node.appendChild(child);
    return node;
  }

  function send(type) {
    if (ACTIONS.includes(type) || type === 'ready') vscode.postMessage({ type });
  }

  /** The JSON of the parts that the page showed last, so that a part that did not change is not built again. */
  const shown = {};
  function changed(part, value) {
    const json = JSON.stringify(value === undefined ? null : value);
    if (shown[part] === json) return false;
    shown[part] = json;
    return true;
  }

  function selecting() {
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    return !!selection && !selection.isCollapsed;
  }

  /** The newest view while text is selected. */
  let waiting = undefined;
  document.addEventListener('selectionchange', () => {
    if (waiting && !selecting()) {
      const view = waiting;
      waiting = undefined;
      render(view);
    }
  });

  function buttons(list) {
    return (list || [])
      .filter((button) => ACTIONS.includes(button.action))
      .map((button) => {
        const node = el('button', { type: 'button', className: button.primary ? undefined : 'secondary', text: button.label, disabled: !!button.disabled });
        node.addEventListener('click', () => send(button.action));
        return node;
      });
  }

  /** A tag with the rule of Devspaces, or nothing. */
  function chip(value) {
    if (!value || typeof value.text !== 'string') return undefined;
    const tone = TONES.includes(value.tone) ? value.tone : 'info';
    return el('span', { className: `chip tone-${tone}`, text: value.text });
  }

  /** The text of a value or a cell, with its tag. */
  function cellParts(value) {
    const parts = [];
    if (value && typeof value.text === 'string' && value.text !== '') parts.push(document.createTextNode(value.text));
    const tag = chip(value && value.chip);
    if (tag) parts.push(tag);
    return parts;
  }

  function factsBody(body) {
    const items = [];
    for (const item of body.facts || []) {
      items.push(el('dt', { text: item.label }));
      items.push(el('dd', {}, cellParts(item.value)));
    }
    return el('dl', { className: 'facts' }, items);
  }

  function tableBody(body) {
    const columns = body.columns || [];
    const rows = body.rows || [];
    if (rows.length === 0) return el('p', { className: 'empty', text: body.empty || '' });
    const head = el('thead', {}, [el('tr', {}, columns.map((name) => el('th', { scope: 'col', text: name })))]);
    const lines = rows.map((row) => el('tr', {}, row.map((value) => el('td', {}, cellParts(value)))));
    if (body.more) lines.push(el('tr', { className: 'more' }, [el('td', { colspan: String(Math.max(1, columns.length)), text: body.more })]));
    return el('div', { className: 'table-box' }, [el('table', {}, [head, el('tbody', {}, lines)])]);
  }

  function section(value) {
    const heading = el('h2', { text: value.title }, [chip(value.chip)]);
    const body = value.body && value.body.kind === 'table' ? tableBody(value.body) : factsBody(value.body || { facts: [] });
    return el('section', { className: 'report' }, [heading, body, value.from ? el('p', { className: 'from', text: value.from }) : undefined]);
  }

  function render(view) {
    document.title = view.title;
    const title = $('title');
    title.textContent = view.title;
    title.className = NAME_TONES.includes(view.tone) ? `name-${view.tone}` : '';
    $('kind').textContent = view.kindLine;
    $('status').textContent = view.status || '';
    if (changed('buttons', view.buttons)) $('buttons').replaceChildren(...buttons(view.buttons));

    const banner = $('banner');
    banner.hidden = !view.banner;
    if (changed('banner', view.banner) && view.banner) {
      $('banner-message').textContent = view.banner.message;
      $('banner-detail').textContent = view.banner.detail || '';
      $('banner-detail').hidden = !view.banner.detail;
      $('banner-buttons').replaceChildren(...buttons(view.banner.buttons));
    }

    const content = view.content;
    if (changed('summary', content && content.summary)) $('summary').replaceChildren(...((content && content.summary) || []).map(chip).filter(Boolean));
    const notices = (content && content.notices) || [];
    $('notices').hidden = notices.length === 0;
    if (changed('notices', notices)) $('notices').replaceChildren(...notices.map((text) => el('li', { text })));
    if (changed('sections', content && content.sections)) $('sections').replaceChildren(...((content && content.sections) || []).map(section));
    $('sections').classList.toggle('stale', !!view.busy);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.type !== 'view' || !message.view) return;
    if (selecting()) waiting = message.view;
    else {
      waiting = undefined;
      render(message.view);
    }
  });
  send('ready');
})();
