// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Script of the utilization page of a Docker host (src/vscode/usagePage.ts). It only shows the view that the extension
// sends (usagePageModel.ts), and sends the clicks of its buttons. Texts from the extension are always set as text, never
// as HTML. A click or a key on the page is sent as `activity` (at most every ACTIVITY_EVERY_MS): after 30 minutes
// without one, the extension pauses the page.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const SVG = 'http://www.w3.org/2000/svg';
  const ACTIVITY_EVERY_MS = 10000;
  /** The width and the height of the drawing of the CPU use (its view box). */
  const SPARK_WIDTH = 280;
  const SPARK_HEIGHT = 40;
  const ACTIONS = ['pause', 'resume', 'retry', 'startVm', 'readSizes', 'showLog'];

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
    vscode.postMessage({ type });
  }

  function action(value) {
    return ACTIONS.includes(value) ? value : undefined;
  }

  let lastActivity = 0;
  function activity() {
    const now = Date.now();
    if (now - lastActivity < ACTIVITY_EVERY_MS) return;
    lastActivity = now;
    send('activity');
  }

  /** The action of the button Pause or Resume of the header, as the last view set it. */
  let pauseAction = undefined;
  $('pause').addEventListener('click', () => {
    if (pauseAction) send(pauseAction);
  });
  $('sizes').addEventListener('click', () => send('readSizes'));
  document.addEventListener('pointerdown', activity);
  document.addEventListener('keydown', activity);

  /** A bar of `percent` (0 to 100) with the class `className`. */
  function bar(percent, className) {
    const fill = el('span', { className: className ? `fill ${className}` : 'fill' });
    fill.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
    return el('span', { className: 'track', 'aria-hidden': 'true' }, [fill]);
  }

  /** The drawing of the CPU use: one line per run of points without a gap. */
  function spark(points) {
    const drawing = document.createElementNS(SVG, 'svg');
    drawing.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
    drawing.setAttribute('preserveAspectRatio', 'none');
    drawing.setAttribute('class', 'spark');
    drawing.setAttribute('aria-hidden', 'true');
    const count = points.length;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        const line = document.createElementNS(SVG, 'polyline');
        line.setAttribute('points', run.join(' '));
        drawing.appendChild(line);
      }
      run = [];
    };
    points.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        flush();
        return;
      }
      const x = count > 1 ? (index * SPARK_WIDTH) / (count - 1) : 0;
      const y = SPARK_HEIGHT - 1 - (Math.max(0, Math.min(100, value)) * (SPARK_HEIGHT - 2)) / 100;
      run.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    flush();
    return drawing;
  }

  function big(value, unit) {
    return el('div', { className: 'big-line' }, [el('span', { className: 'big', text: value }), el('span', { className: 'muted', text: unit })]);
  }

  function lines(items) {
    return items.map((item) => el('div', { className: 'line' }, [el('span', { className: 'muted', text: item.label }), el('span', { text: item.value })]));
  }

  function card(caption, children) {
    return el('section', { className: 'card' }, [el('h2', { className: 'caption', text: caption }), ...children]);
  }

  function cpuCard(cpu) {
    const cores = cpu.cores.map((core) =>
      el('div', { className: 'core' }, [el('span', { className: 'muted core-label', text: core.label }), bar(core.percent, core.level), el('span', { className: 'core-value', text: core.text })]),
    );
    return card(cpu.caption, [
      big(cpu.value, cpu.unit),
      spark(cpu.spark),
      ...cores,
      cpu.coresNote ? el('div', { className: 'muted small', text: cpu.coresNote }) : undefined,
      ...cpu.lines.map((line) => el('div', { className: 'muted small', text: line })),
    ]);
  }

  function amountCard(part) {
    return card(part.caption, [big(part.value, part.unit), typeof part.percent === 'number' ? bar(part.percent) : undefined, ...lines(part.lines)]);
  }

  function dockerCard(docker) {
    const segments = el(
      'div',
      { className: 'segments', 'aria-hidden': 'true' },
      docker.segments.map((segment) => {
        const node = el('span', { className: `segment ${segment.kind}` });
        node.style.width = `${Math.max(0, Math.min(100, Number(segment.percent) || 0))}%`;
        return node;
      }),
    );
    const rows = docker.rows.map((row) =>
      el('tr', {}, [
        el('td', {}, [el('span', { className: `swatch ${row.kind}`, 'aria-hidden': 'true' }), document.createTextNode(row.label)]),
        el('td', { className: 'number', text: row.size }),
        el('td', { className: 'number muted', text: row.free }),
      ]),
    );
    const table =
      rows.length > 0
        ? el('table', { className: 'small kinds' }, [
            el('thead', {}, [el('tr', {}, [el('th', { scope: 'col', text: 'Type' }), el('th', { scope: 'col', className: 'number', text: 'Size' }), el('th', { scope: 'col', className: 'number', text: 'Can be freed' })])]),
            el('tbody', {}, rows),
          ])
        : undefined;
    return card(docker.caption, [big(docker.value, docker.unit), docker.segments.length > 0 ? segments : undefined, table, el('div', { className: 'muted small', text: docker.note })]);
  }

  function nameCell(row) {
    return el('td', { className: `cell tone-${row.tone}`, text: row.name, title: row.name });
  }

  function containerRow(row) {
    return el('tr', {}, [
      nameCell(row),
      el('td', { className: `cell tone-${row.tone}`, text: row.purpose, title: row.purpose }),
      el('td', { className: 'cpu' }, [el('span', { className: 'cpu-value', text: row.cpu }), bar(row.cpuBar)]),
      el('td', { className: 'cell', text: row.memory }),
      el('td', { className: 'cell', text: row.network }),
      el('td', { className: 'cell', text: row.disk }),
      el('td', { className: 'number', text: row.pids }),
    ]);
  }

  function objectTable(table) {
    const head = el('tr', {}, table.headers.map((header, index) => el('th', { scope: 'col', className: index >= 2 ? 'number' : undefined, text: header })));
    const rows = table.rows.map((row) =>
      el('tr', {}, [
        nameCell(row),
        el('td', { className: `cell tone-${row.tone}`, text: row.purpose, title: row.purpose }),
        el('td', { className: 'number', text: row.values[0] }),
        el('td', { className: 'number muted', text: row.values[1] }),
      ]),
    );
    return el('section', { className: 'object-table' }, [
      el('div', { className: 'section-head' }, [el('h2', { text: table.title }), el('span', { className: 'muted', text: table.summary })]),
      el('div', { className: 'table-box' }, [el('table', { className: 'small' }, [el('thead', {}, [head]), el('tbody', {}, rows)])]),
      table.more ? el('p', { className: 'muted small', text: table.more }) : undefined,
    ]);
  }

  function render(view) {
    $('title').textContent = view.title;
    $('description').textContent = view.description;
    $('status').className = `status ${view.status.tone}`;
    $('status-text').textContent = view.status.text;
    const pause = $('pause');
    pauseAction = view.pause ? action(view.pause.action) : undefined;
    pause.hidden = !view.pause;
    pause.textContent = view.pause ? view.pause.label : '';
    const sizes = $('sizes');
    sizes.textContent = view.sizes.label;
    sizes.disabled = view.sizes.disabled === true;

    const banner = $('banner');
    banner.hidden = !view.banner;
    if (view.banner) {
      banner.className = `banner ${view.banner.tone}`;
      $('banner-message').textContent = view.banner.message;
      $('banner-detail').textContent = view.banner.detail || '';
      $('banner-detail').hidden = !view.banner.detail;
      $('banner-buttons').replaceChildren(
        ...view.banner.buttons.map((button) => {
          const node = el('button', { type: 'button', className: button.primary ? undefined : 'secondary', text: button.label });
          node.addEventListener('click', () => {
            const value = action(button.action);
            if (value) send(value);
          });
          return node;
        }),
      );
    } else {
      $('banner-buttons').replaceChildren();
    }

    $('values').className = view.stale ? 'values stale' : 'values';
    $('cards').replaceChildren(cpuCard(view.cpu), amountCard(view.memory), amountCard(view.disk), dockerCard(view.docker));

    const containers = view.containers;
    $('containers-summary').textContent = containers.summary;
    const rows = containers.rows.map(containerRow);
    if (containers.empty) rows.push(el('tr', {}, [el('td', { className: 'muted', colspan: '7', text: containers.empty })]));
    if (containers.more) rows.push(el('tr', {}, [el('td', { className: 'muted', colspan: '7', text: containers.more })]));
    $('containers').replaceChildren(...rows);
    $('containers-notes').textContent = containers.notes.join(' ');
    $('containers-notes').hidden = containers.notes.length === 0;

    const stopped = $('stopped');
    stopped.hidden = !view.stopped;
    if (view.stopped) {
      $('stopped-summary').textContent = view.stopped.summary;
      $('stopped-list').replaceChildren(
        ...view.stopped.rows.map((row) =>
          el('li', {}, [el('span', { className: `tone-${row.tone}`, text: row.name }), el('span', { className: 'muted', text: row.purpose ? ` · ${row.purpose}` : '' })]),
        ),
      );
    }

    $('tables').replaceChildren(...view.tables.map(objectTable));
    $('footer').replaceChildren(...view.footer.map((line) => el('p', { text: line })));
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message && message.type === 'view' && message.view) render(message.view);
  });
  send('ready');
})();
