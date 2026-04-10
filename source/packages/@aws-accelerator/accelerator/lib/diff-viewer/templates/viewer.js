// Client-side diff viewer logic — embedded into the generated HTML.
// Expects diffMeta, diffBlob, and DELIM to be defined before this script runs.

async function decompressBlob(b64) {
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  writer.write(bin);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(merged);
}

function ansiToHtml(str) {
  let h = str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Convert ANSI escape codes to spans
  h = h
    .replace(/\x1b\[1m/g,'<span class="ansi-bold">').replace(/\x1b\[4m/g,'<span class="ansi-underline">')
    .replace(/\x1b\[22m/g,'</span>').replace(/\x1b\[24m/g,'</span>')
    .replace(/\x1b\[31m/g,'<span class="ansi-red">').replace(/\x1b\[32m/g,'<span class="ansi-green">')
    .replace(/\x1b\[33m/g,'<span class="ansi-yellow">').replace(/\x1b\[34m/g,'<span class="ansi-blue">')
    .replace(/\x1b\[36m/g,'<span class="ansi-cyan">').replace(/\x1b\[37m/g,'<span class="ansi-muted">')
    .replace(/\x1b\[39m/g,'</span>').replace(/\x1b\[\d+m/g,'');
  // Colorize plain-text lines that have [-], [+], [~] but no existing spans
  // Also handle CDK diff table format: │ - │ and │ + │ with continuation rows │   │
  h = h.split('\n').map(function(line) {
    if (line.indexOf('<span') !== -1) return line;
    if (/\[-\]/.test(line)) return '<span class="ansi-red">' + line + '</span>';
    if (/\[\+\]/.test(line)) return '<span class="ansi-green">' + line + '</span>';
    if (/\[~\]/.test(line)) return '<span class="ansi-yellow">' + line + '</span>';
    return line;
  }).join('\n');
  // Second pass: colorize IAM table rows (│ - │ starts a block, │   │ continues it)
  var tableLines = h.split('\n');
  var tableColor = null;
  for (var i = 0; i < tableLines.length; i++) {
    var tl = tableLines[i];
    if (tl.indexOf('<span') !== -1) { tableColor = null; continue; }
    if (/^│\s*-\s*│/.test(tl)) { tableColor = 'ansi-red'; }
    else if (/^│\s*\+\s*│/.test(tl)) { tableColor = 'ansi-green'; }
    else if (/^[├└┌]/.test(tl) || !/^│/.test(tl)) { tableColor = null; continue; }
    if (tableColor && /^│/.test(tl)) {
      tableLines[i] = '<span class="' + tableColor + '">' + tl + '</span>';
    }
  }
  h = tableLines.join('\n');
  return h;
}
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

const container = document.getElementById('cards');
const sidebarList = document.getElementById('sidebar-list');
const mainEl = document.getElementById('main');
const summaryEl = document.getElementById('summary');

let diffs = [];
const sectionOrder = [];
const collapsed = {};
const reviewed = {};
let currentFilter = 'unreviewed';
let searchTimeout;
let activeKey = null;
const cardCache = {};

// Initialize diffs immediately from metadata so sidebar renders instantly
diffs = diffMeta.map(m => ({ section: m.s, name: m.n, hasChanges: m.c, content: null }));
const sectionSet = new Set();
diffs.forEach(d => { if (!sectionSet.has(d.section)) { sectionSet.add(d.section); sectionOrder.push(d.section); } });
sectionOrder.forEach(s => { collapsed[s] = true; });
diffs.forEach(d => { if (!d.hasChanges) reviewed[d.section + '/' + d.name] = true; });
renderSidebar();
setupEventListeners();

// Track which resource types are selected for the summary
var selectedTypes = {};
(function() {
  var saved = localStorage.getItem('lza-diff-notable-types');
  if (saved) { try { selectedTypes = JSON.parse(saved); } catch(e) { selectedTypes = {}; } }
  // Default: notable types on, others off
  for (var i = 0; i < impactReport.allResourceTypes.length; i++) {
    var t = impactReport.allResourceTypes[i];
    if (selectedTypes[t] === undefined) {
      selectedTypes[t] = impactReport.notableResourceTypes.indexOf(t) !== -1;
    }
  }
})();

renderImpactReport();

function getSelectedTypes() {
  return impactReport.allResourceTypes.filter(function(t) { return selectedTypes[t]; });
}

function renderImpactReport() {
  if (!impactReport) return;
  var r = impactReport;
  var sel = new Set(getSelectedTypes());

  // Recompute notable changes and stacks based on selected types
  var filteredChanges = [];
  var changeMap = {};
  var filteredStacks = [];

  for (var si = 0; si < r.allStackSummaries.length; si++) {
    var s = r.allStackSummaries[si];
    var filteredRes = s.resources.filter(function(res) { return sel.has(res.resourceType) && res.action !== 'create'; });
    if (filteredRes.length > 0) {
      filteredStacks.push({ stackName: s.stackName, account: s.account, region: s.region, section: s.section, resources: filteredRes });
    }
    for (var ri = 0; ri < filteredRes.length; ri++) {
      var res2 = filteredRes[ri];
      var cmKey = res2.resourceType + '|' + res2.action;
      if (!changeMap[cmKey]) { changeMap[cmKey] = { resourceType: res2.resourceType, action: res2.action, count: 0, stacks: {} }; }
      changeMap[cmKey].count++;
      changeMap[cmKey].stacks[s.stackName] = true;
    }
  }
  var cmKeys = Object.keys(changeMap);
  cmKeys.sort(function(a, b) { return changeMap[b].count - changeMap[a].count; });
  for (var ci = 0; ci < cmKeys.length; ci++) {
    var cm = changeMap[cmKeys[ci]];
    filteredChanges.push({ resourceType: cm.resourceType, action: cm.action, count: cm.count, stacks: Object.keys(cm.stacks) });
  }

  var html = '<div class="impact-report">';
  html += '<h2 class="report-title">CloudFormation Diff Summary</h2>';
  html += '<div class="report-summary">';
  html += '<div class="report-stat"><span class="stat-value">' + r.totalStacks + '</span><span class="stat-label">Total Stacks</span></div>';
  html += '<div class="report-stat"><span class="stat-value">' + r.stacksWithChanges + '</span><span class="stat-label">With Changes</span></div>';
  html += '<div class="report-stat stat-create"><span class="stat-value">' + r.resourceCounts.creates + '</span><span class="stat-label">Creates</span></div>';
  html += '<div class="report-stat stat-modify"><span class="stat-value">' + r.resourceCounts.modifies + '</span><span class="stat-label">Modifies</span></div>';
  html += '<div class="report-stat stat-delete"><span class="stat-value">' + r.resourceCounts.deletes + '</span><span class="stat-label">Deletes</span></div>';
  html += '</div>';

  // Resource type filter
  html += '<div class="report-section"><h3 class="report-section-title">Resource Types to Track</h3>';
  html += '<div class="type-filter-grid">';
  for (var ti = 0; ti < r.allResourceTypes.length; ti++) {
    var t = r.allResourceTypes[ti];
    var checked = sel.has(t) ? ' checked' : '';
    html += '<label class="type-filter-item"><input type="checkbox" class="type-cb" data-type="' + esc(t) + '"' + checked + '><code>' + esc(t) + '</code></label>';
  }
  html += '</div></div>';

  if (filteredChanges.length > 0) {
    html += '<div class="report-section"><h3 class="report-section-title risk-high">Notable Resource Changes</h3>';
    html += '<table class="report-table"><thead><tr><th>Resource Type</th><th>Action</th><th>Count</th><th>Stacks Affected</th></tr></thead><tbody>';
    for (var i = 0; i < filteredChanges.length; i++) {
      var c = filteredChanges[i];
      var actionClass = c.action === 'delete' ? 'action-delete' : 'action-modify';
      html += '<tr><td><code>' + esc(c.resourceType) + '</code></td>';
      html += '<td><span class="action-badge ' + actionClass + '">' + c.action.toUpperCase() + '</span></td>';
      html += '<td>' + c.count + '</td>';
      html += '<td>' + c.stacks.length + ' stack' + (c.stacks.length !== 1 ? 's' : '') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }

  if (filteredStacks.length > 0) {
    html += '<div class="report-section"><h3 class="report-section-title">Stacks Requiring Review</h3>';
    html += '<div class="report-controls">';
    html += '<input type="text" id="stack-search" class="report-search" placeholder="Filter stacks...">';
    html += '<select id="stack-filter" class="report-select"><option value="all">All</option><option value="unreviewed" selected>Unreviewed</option><option value="reviewed">Reviewed</option></select>';
    html += '</div>';
    html += '<table class="report-table"><thead><tr><th>Stack</th><th>Notable Resources</th><th>Reviewed</th></tr></thead><tbody id="stack-tbody"></tbody></table>';
    html += '<div class="report-pagination" id="stack-pagination"></div>';
    html += '</div>';
  }

  if (filteredChanges.length === 0) {
    html += '<div class="report-section"><p class="report-ok">✅ No notable resource changes detected.</p></div>';
  }

  html += '<div class="report-section"><h3 class="report-section-title">Scope</h3>';
  html += '<p>' + r.accountsAffected.length + ' account' + (r.accountsAffected.length !== 1 ? 's' : '') + ' · ' + r.regionsAffected.length + ' region' + (r.regionsAffected.length !== 1 ? 's' : '') + '</p></div>';
  html += '</div>';
  container.innerHTML = html;

  // Stack table pagination state
  var stackPage = 0;
  var STACK_PAGE_SIZE = 25;

  function renderStackTable() {
    var tbody = document.getElementById('stack-tbody');
    var pagination = document.getElementById('stack-pagination');
    if (!tbody) return;

    var searchVal = (document.getElementById('stack-search').value || '').toLowerCase();
    var filterVal = document.getElementById('stack-filter').value;

    var visible = filteredStacks.filter(function(fs) {
      var fsKey = fs.section + '/' + fs.stackName;
      var isRev = !!reviewed[fsKey];
      if (filterVal === 'unreviewed' && isRev) return false;
      if (filterVal === 'reviewed' && !isRev) return false;
      if (searchVal && fs.stackName.toLowerCase().indexOf(searchVal) === -1) return false;
      return true;
    });

    var totalPages = Math.max(1, Math.ceil(visible.length / STACK_PAGE_SIZE));
    if (stackPage >= totalPages) stackPage = totalPages - 1;
    var start = stackPage * STACK_PAGE_SIZE;
    var pageItems = visible.slice(start, start + STACK_PAGE_SIZE);

    var rowsHtml = '';
    for (var j = 0; j < pageItems.length; j++) {
      var fs = pageItems[j];
      var fsKey = fs.section + '/' + fs.stackName;
      var isRev = !!reviewed[fsKey];
      var typeCounts = {};
      for (var k = 0; k < fs.resources.length; k++) {
        var res = fs.resources[k];
        var key2 = res.resourceType + '|' + res.action;
        typeCounts[key2] = (typeCounts[key2] || 0) + 1;
      }
      var resDetail = Object.keys(typeCounts).map(function(k2) {
        var parts = k2.split('|');
        return '<span class="action-badge action-' + parts[1] + '">' + parts[1][0].toUpperCase() + '</span> ' + typeCounts[k2] + ' <code>' + esc(parts[0]) + '</code>';
      }).join('<br>');
      rowsHtml += '<tr class="report-stack-row' + (isRev ? ' report-reviewed' : '') + '" data-key="' + esc(fsKey) + '">';
      rowsHtml += '<td><a href="#" class="stack-link' + (isRev ? ' reviewed-link' : '') + '" data-stack="' + esc(fs.stackName) + '">' + esc(fs.stackName) + '</a></td>';
      rowsHtml += '<td>' + resDetail + '</td>';
      rowsHtml += '<td style="text-align:center"><input type="checkbox" class="report-review-cb" data-key="' + esc(fsKey) + '"' + (isRev ? ' checked' : '') + '></td>';
      rowsHtml += '</tr>';
    }
    tbody.innerHTML = rowsHtml;

    // Pagination controls
    var pagHtml = '<span class="page-info">' + visible.length + ' stacks · Page ' + (stackPage + 1) + ' of ' + totalPages + '</span>';
    if (totalPages > 1) {
      pagHtml += '<span class="page-buttons">';
      pagHtml += '<button class="page-btn" id="page-prev"' + (stackPage === 0 ? ' disabled' : '') + '>‹ Prev</button>';
      pagHtml += '<button class="page-btn" id="page-next"' + (stackPage >= totalPages - 1 ? ' disabled' : '') + '>Next ›</button>';
      pagHtml += '</span>';
    }
    pagination.innerHTML = pagHtml;

    // Wire up pagination buttons
    var prevBtn = document.getElementById('page-prev');
    var nextBtn = document.getElementById('page-next');
    if (prevBtn) prevBtn.addEventListener('click', function() { stackPage--; renderStackTable(); });
    if (nextBtn) nextBtn.addEventListener('click', function() { stackPage++; renderStackTable(); });

    // Wire up review checkboxes
    tbody.querySelectorAll('.report-review-cb').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var k = this.getAttribute('data-key');
        reviewed[k] = this.checked;
        var row = this.closest('.report-stack-row');
        var link = row.querySelector('.stack-link');
        row.classList.toggle('report-reviewed', this.checked);
        link.classList.toggle('reviewed-link', this.checked);
        renderSidebar();
      });
    });

    // Wire up stack links
    tbody.querySelectorAll('.stack-link').forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        var stackName = this.getAttribute('data-stack');
        var target = diffs.find(function(d) { return d.name === stackName; });
        if (target) showDiff(target);
      });
    });
  }

  // Wire up search and filter
  var stackSearchEl = document.getElementById('stack-search');
  var stackFilterEl = document.getElementById('stack-filter');
  var stackSearchTimeout;
  if (stackSearchEl) {
    stackSearchEl.addEventListener('input', function() {
      clearTimeout(stackSearchTimeout);
      stackSearchTimeout = setTimeout(function() { stackPage = 0; renderStackTable(); }, 200);
    });
  }
  if (stackFilterEl) {
    stackFilterEl.addEventListener('change', function() { stackPage = 0; renderStackTable(); });
  }

  renderStackTable();

  // Wire up type checkboxes
  container.querySelectorAll('.type-cb').forEach(function(cb) {
    cb.addEventListener('change', function() {
      selectedTypes[this.getAttribute('data-type')] = this.checked;
      localStorage.setItem('lza-diff-notable-types', JSON.stringify(selectedTypes));
      renderImpactReport();
    });
  });
}

// Decompress blob in background
let blobReady = false;
const blobPromise = decompressBlob(diffBlob).then(text => {
  const contents = text.split('\n' + DELIM + '\n');
  for (let i = 0; i < diffs.length; i++) diffs[i].content = (contents[i] || '').trim();
  blobReady = true;
  summaryEl.textContent = diffs.length + ' stacks \u00b7 ' + diffs.filter(d => d.hasChanges).length + ' changed \u00b7 ' + diffs.filter(d => !d.hasChanges).length + ' unchanged';
}).catch(function(err) {
  container.innerHTML = '<div style="padding:2rem;color:var(--red)"><h2>Failed to decompress diff data</h2><p>' + esc(String(err)) + '</p><p>Try regenerating the diff-viewer HTML file.</p></div>';
});

function getFiltered(filter, search) {
  const s = (search || '').toLowerCase();
  return diffs.filter(d => {
    const key = d.section + '/' + d.name;
    if (filter === 'changes' && !d.hasChanges) return false;
    if (filter === 'no-changes' && d.hasChanges) return false;
    if (filter === 'reviewed' && !reviewed[key]) return false;
    if (filter === 'unreviewed' && reviewed[key]) return false;
    if (s && !d.name.toLowerCase().includes(s) && !d.section.toLowerCase().includes(s)) return false;
    return true;
  });
}

function renderSidebar() {
  const filtered = getFiltered(currentFilter, document.getElementById('search').value);
  const groups = {};
  sectionOrder.forEach(s => { groups[s] = []; });
  filtered.forEach(d => { if (!groups[d.section]) groups[d.section] = []; groups[d.section].push(d); });

  const totalF = filtered.length;
  const changedF = filtered.filter(d => d.hasChanges).length;
  summaryEl.textContent = totalF + ' stacks \u00b7 ' + changedF + ' changed \u00b7 ' + (totalF - changedF) + ' unchanged';
  sidebarList.innerHTML = '';

  sectionOrder.forEach(section => {
    const items = groups[section];
    if (!items || items.length === 0) return;
    const changedCount = items.filter(d => d.hasChanges).length;

    const header = document.createElement('div');
    header.className = 'section-header' + (collapsed[section] ? ' collapsed' : '');
    header.innerHTML = '<span><span class="section-chevron">\u25bc</span>' + esc(section) + '</span><span class="section-counts">' + changedCount + '/' + items.length + '</span>';
    const itemsUl = document.createElement('ul');
    itemsUl.className = 'section-items';
    itemsUl.style.display = collapsed[section] ? 'none' : '';
    header.addEventListener('click', () => { collapsed[section] = !collapsed[section]; header.classList.toggle('collapsed'); itemsUl.style.display = collapsed[section] ? 'none' : ''; });
    sidebarList.appendChild(header);

    const PAGE_SIZE = 500;
    let shown = 0;
    function renderItem(d) {
      const key = d.section + '/' + d.name;
      const li = document.createElement('li');
      li.className = 'sidebar-item' + (key === activeKey ? ' active' : '') + (reviewed[key] ? ' reviewed' : '');
      li.setAttribute('role', 'button'); li.setAttribute('tabindex', '0');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'review-cb'; cb.checked = !!reviewed[key];
      cb.title = 'Mark as reviewed';
      cb.setAttribute('aria-label', 'Mark ' + d.name + ' as reviewed');
      cb.addEventListener('click', e => { e.stopPropagation(); reviewed[key] = cb.checked; li.classList.toggle('reviewed', cb.checked); if (currentFilter === 'reviewed' || currentFilter === 'unreviewed') renderSidebar(); });
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name'; nameSpan.title = d.name; nameSpan.textContent = d.name;
      const dot = document.createElement('span');
      dot.className = 'dot ' + (d.hasChanges ? 'changes' : 'no-changes');
      li.appendChild(cb); li.appendChild(nameSpan); li.appendChild(dot);
      li.addEventListener('click', () => showDiff(d));
      return li;
    }
    function loadPage() {
      const oldBtn = itemsUl.querySelector('.load-more-btn');
      if (oldBtn) oldBtn.remove();
      const end = Math.min(shown + PAGE_SIZE, items.length);
      for (let i = shown; i < end; i++) itemsUl.appendChild(renderItem(items[i]));
      shown = end;
      if (shown < items.length) {
        const more = document.createElement('li');
        more.className = 'sidebar-item load-more-btn';
        more.style.cssText = 'justify-content:center;color:var(--blue);cursor:pointer;font-size:0.78rem;padding:0.5rem';
        more.textContent = 'Load more (' + (items.length - shown) + ' remaining)';
        more.addEventListener('click', loadPage);
        itemsUl.appendChild(more);
      }
    }
    loadPage();
    sidebarList.appendChild(itemsUl);
  });
}

async function showDiff(d) {
  const key = d.section + '/' + d.name;
  activeKey = key;

  // Expand the section this stack belongs to and switch filter to 'all' so it's visible
  if (collapsed[d.section]) {
    collapsed[d.section] = false;
    renderSidebar();
  }

  // If current filter hides this stack, switch to 'all'
  var matchingItem = sidebarList.querySelector('.sidebar-item .name[title="' + d.name.replace(/"/g, '\\"') + '"]');
  if (!matchingItem) {
    currentFilter = 'all';
    document.querySelectorAll('.filter-option').forEach(function(b) { b.classList.remove('active'); });
    var allBtn = document.querySelector('.filter-option[data-filter="all"]');
    if (allBtn) allBtn.classList.add('active');
    document.getElementById('filter-label').textContent = 'All';
    renderSidebar();
  }

  // Highlight active item and scroll into view
  // If the item is beyond the current pagination page, load more until it appears
  var attempts = 0;
  var foundItem = null;
  while (attempts < 20) {
    sidebarList.querySelectorAll('.sidebar-item').forEach(el => {
      const nameEl = el.querySelector('.name');
      const isActive = nameEl && nameEl.title === d.name && el.closest('.section-items').previousElementSibling.textContent.includes(d.section);
      el.classList.toggle('active', !!isActive);
      if (isActive) foundItem = el;
    });
    if (foundItem) break;
    var loadMoreBtn = null;
    sidebarList.querySelectorAll('.section-header').forEach(function(hdr) {
      if (hdr.textContent.includes(d.section)) {
        var items = hdr.nextElementSibling;
        if (items) loadMoreBtn = items.querySelector('.load-more-btn');
      }
    });
    if (!loadMoreBtn) break;
    loadMoreBtn.click();
    attempts++;
  }
  if (foundItem) foundItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (d.content === null) {
    container.innerHTML = '<div class="diff-card open"><div class="diff-header"><div class="diff-title"><span class="chevron">\u25b6</span>' + esc(d.name) + '</div></div><div class="diff-body" style="display:block"><pre style="color:var(--muted)">Decompressing...</pre></div></div>';
    mainEl.scrollTop = 0;
    await blobPromise;
    delete cardCache[key];
  }
  if (!cardCache[key]) {
    const card = document.createElement('div');
    card.className = 'diff-card open';
    card.innerHTML = '<div class="diff-header" role="button" tabindex="0" aria-expanded="true"><div class="diff-title"><span class="chevron">\u25b6</span>' + esc(d.name) + '</div><span class="badge ' + (d.hasChanges ? 'changes' : 'no-changes') + '">' + (d.hasChanges ? 'Changes' : 'No Changes') + '</span></div><div class="diff-body"><pre>' + ansiToHtml(d.content) + '</pre></div>';
    card.querySelector('.diff-header').addEventListener('click', () => { card.classList.toggle('open'); card.querySelector('.diff-header').setAttribute('aria-expanded', card.classList.contains('open')); });
    cardCache[key] = card;
  }
  container.innerHTML = '';
  var backLink = document.createElement('a');
  backLink.href = '#';
  backLink.className = 'back-to-summary';
  backLink.textContent = '\u2190 Back to Summary';
  backLink.addEventListener('click', function(e) { e.preventDefault(); renderImpactReport(); });
  container.appendChild(backLink);
  container.appendChild(cardCache[key]);
  mainEl.scrollTop = 0;
}

function applyFilter() { activeKey = null; container.innerHTML = ''; renderSidebar(); }

function setupEventListeners() {
  document.querySelectorAll('.filter-option').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-option').forEach(b => b.classList.remove('active'));
      btn.classList.add('active'); currentFilter = btn.dataset.filter;
      document.getElementById('filter-label').textContent = btn.textContent;
      document.getElementById('filter-overlay').classList.remove('open'); applyFilter();
    });
  });
  const filterOverlay = document.getElementById('filter-overlay');
  document.getElementById('filter-toggle').addEventListener('click', () => { filterOverlay.classList.add('open'); });
  document.getElementById('filter-close').addEventListener('click', () => { filterOverlay.classList.remove('open'); });
  filterOverlay.addEventListener('click', e => { if (e.target === filterOverlay) filterOverlay.classList.remove('open'); });
  document.getElementById('search').addEventListener('input', () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(applyFilter, 200); });

  document.getElementById('summary-link').addEventListener('click', function() {
    activeKey = null;
    sidebarList.querySelectorAll('.sidebar-item').forEach(function(el) { el.classList.remove('active'); });
    renderImpactReport();
  });

  const themeBtn = document.getElementById('theme-toggle');
  const saved = localStorage.getItem('cdk-diff-theme');
  if (saved === 'light') { document.documentElement.setAttribute('data-theme', 'light'); themeBtn.textContent = '\ud83c\udf19'; }
  themeBtn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) { document.documentElement.removeAttribute('data-theme'); themeBtn.textContent = '\u2600\ufe0f'; localStorage.setItem('cdk-diff-theme', 'dark'); }
    else { document.documentElement.setAttribute('data-theme', 'light'); themeBtn.textContent = '\ud83c\udf19'; localStorage.setItem('cdk-diff-theme', 'light'); }
  });

  const helpOverlay = document.getElementById('help-overlay');
  document.getElementById('help-toggle').addEventListener('click', () => { helpOverlay.classList.add('open'); });
  document.getElementById('help-close').addEventListener('click', () => { helpOverlay.classList.remove('open'); });
  helpOverlay.addEventListener('click', e => { if (e.target === helpOverlay) helpOverlay.classList.remove('open'); });

  const handle = document.getElementById('resize-handle');
  const sidebar = document.querySelector('.sidebar');
  let isResizing = false;
  handle.addEventListener('mousedown', e => { isResizing = true; handle.classList.add('dragging'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (!isResizing) return; sidebar.style.width = Math.min(Math.max(200, e.clientX), window.innerWidth * 0.6) + 'px'; });
  document.addEventListener('mouseup', () => { if (isResizing) { isResizing = false; handle.classList.remove('dragging'); document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
}
