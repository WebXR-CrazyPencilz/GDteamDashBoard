/**
 * PMP — Module: Team Lead Dashboard ("Team Control")
 *
 * Team-wide counterpart to PmpDashboard (Employee "My Work" home). Answers
 * "what is everyone working on" instead of "what am I working on" — same
 * principle as the Employee dashboard: every number is derived from data
 * the existing API already returns (getMyTeam, getTeamAssignments,
 * getTasks, getProjects, getClients, getActivityLog, getAllTimesheetEntries
 * per employee for today's Leave check). Nothing fabricated, nothing
 * persisted by this module, no new backend endpoints.
 *
 * "Team" continues to mean the full active Employee pool, not a
 * ReportsTo-scoped set — same as everywhere else in PMP (see Code.gs's
 * v2 architecture note). This dashboard doesn't restrict who a Team Lead
 * sees; it just summarizes the same pool pmp-teamlead.js's other tabs
 * already show.
 *
 * Leave detection reuses the same rule as pmp-attendance.js: a real
 * submitted Timesheet entry with Source === 'Leave' for today, never an
 * inference from an empty ActivityLog. That logic isn't factored into a
 * shared helper yet (both files currently read their own fetched
 * submittedEntries) — worth doing in a later pass if it drifts.
 *
 * Self-sufficient module: owns its own state, fed by init().
 */

const PmpTeamLeadDashboard = (function () {

  let state = {
    containerId: null,
    teamLeadId: null,
    employees: [],
    tasks: [],
    assignments: [],
    projects: [],
    clients: [],
    activityLog: [],
    leaveEmployeeIds: new Set(), // employees with a submitted Leave entry for today
    onNavigate: null
  };

  async function init(containerId, teamLeadId, opts) {
    state.containerId = containerId;
    state.teamLeadId = teamLeadId;
    state.onNavigate = (opts && opts.onNavigate) || null;
    await refresh();
  }

  async function refresh() {
    const [employeesRes, tasksRes, assignmentsRes, projectsRes, clientsRes, logRes] = await Promise.all([
      PmpApi.getMyTeam(state.teamLeadId),
      PmpApi.getTasks(),
      PmpApi.getTeamAssignments(state.teamLeadId),
      PmpApi.getProjects(),
      PmpApi.getClients(),
      PmpApi.getActivityLog()
    ]);

    if (employeesRes.success) state.employees = employeesRes.employees;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;
    if (logRes.success) state.activityLog = logRes.log;

    await loadTodaysLeave();
    render();
  }

  // One getAllTimesheetEntries call per employee, in parallel — bounded by
  // team size. Flagged as a performance item to revisit (Code.gs has no
  // "get today's Leave entries for N employees in one call" endpoint yet;
  // adding one would let this become a single request instead of N).
  async function loadTodaysLeave() {
    const today = PmpUtils.toLocalDateStr(new Date());
    state.leaveEmployeeIds = new Set();
    const results = await Promise.all(
      state.employees.map(e => PmpApi.getAllTimesheetEntries({ employeeId: e.employeeId }))
    );
    results.forEach((res, idx) => {
      if (!res.success) return;
      const onLeaveToday = res.entries.some(entry => entry.Date === today && entry.Source === 'Leave');
      if (onLeaveToday) state.leaveEmployeeIds.add(state.employees[idx].employeeId);
    });
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  // ------------------------------------------------------------
  // Joins
  // ------------------------------------------------------------

  function withTask(assignment) {
    const task = state.tasks.find(t => t.TaskID === assignment.TaskID);
    return {
      ...assignment,
      ProjectID: task ? task.ProjectID : assignment.ProjectID,
      SubTask: task ? task.TaskName : assignment.SubTask,
      Dimension: task ? task.Dimension : assignment.Dimension,
      Priority: task ? task.Priority : assignment.Priority,
      DueDate: task ? task.DueDate : assignment.DueDate,
      Notes: task ? task.Notes : assignment.Notes
    };
  }

  function joinedAssignments() {
    return state.assignments.map(withTask);
  }

  function projectAndClient(assignment) {
    const project = state.projects.find(p => p.ProjectID === assignment.ProjectID);
    const client = project ? state.clients.find(c => c.ClientID === project.ClientID) : null;
    return { project, client };
  }

  function employeeName(employeeId) {
    const e = state.employees.find(x => x.employeeId === employeeId);
    return e ? e.name : employeeId;
  }

  // Same open-interval reconstruction as PmpDashboard, parameterized by
  // employee instead of hardcoded to "me". No shared helper yet since
  // PmpDashboard's version lives in a different module scope — same
  // caveat as the Leave-detection duplication above.
  function findOpenInterval(employeeId) {
    const working = joinedAssignments().filter(a => a.AssignedTo === employeeId && a.Status === 'Working' && a.IsPaused !== true);
    if (working.length === 0) return null;

    const rowsByAssignment = {};
    (state.activityLog || []).forEach(row => {
      if (row.EmployeeID !== employeeId) return;
      if (!rowsByAssignment[row.AssignmentID]) rowsByAssignment[row.AssignmentID] = [];
      rowsByAssignment[row.AssignmentID].push(row);
    });

    let best = null;
    working.forEach(a => {
      const rows = (rowsByAssignment[a.AssignmentID] || []).slice().sort((x, y) => new Date(x.Timestamp) - new Date(y.Timestamp));
      let openStart = null;
      rows.forEach(row => {
        const isStart = (row.Action === 'StatusChange' && row.FromStatus === 'Assigned' && row.ToStatus === 'Working') || row.Action === 'Resumed';
        const isEnd = row.Action === 'Paused' || (row.Action === 'StatusChange' && row.FromStatus === 'Working' && row.ToStatus !== 'Working');
        if (isStart) openStart = row.Timestamp;
        else if (isEnd) openStart = null;
      });
      if (openStart && (!best || new Date(openStart) > new Date(best.start))) best = { assignment: a, start: openStart };
    });
    return best;
  }

  // Employee's current status for "Who's Working Now" / KPI counts.
  function employeeStatus(employeeId) {
    if (state.leaveEmployeeIds.has(employeeId)) return 'OnLeave';
    const paused = joinedAssignments().find(a => a.AssignedTo === employeeId && a.Status === 'Working' && a.IsPaused === true);
    if (paused) return 'Paused';
    const open = findOpenInterval(employeeId);
    if (open) return 'Working';
    return 'Available';
  }

  function minutesToday(employeeId) {
    const today = PmpUtils.toLocalDateStr(new Date());
    return PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => iv.EmployeeID === employeeId && PmpUtils.toLocalDateStr(iv.start) === today)
      .reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
  }

  function minutesBetween(start, end) {
    return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  }

  function formatHM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------

  function render() {
    const joined = joinedAssignments();
    const active = joined.filter(a => a.Status !== 'Completed' && a.Status !== 'Closed');
    const statuses = {};
    state.employees.forEach(e => { statuses[e.employeeId] = employeeStatus(e.employeeId); });

    const workingCount = Object.values(statuses).filter(s => s === 'Working').length;
    const pausedCount = Object.values(statuses).filter(s => s === 'Paused').length;
    const availableCount = Object.values(statuses).filter(s => s === 'Available').length;
    const onLeaveCount = Object.values(statuses).filter(s => s === 'OnLeave').length;

    const pending = active.filter(a => a.Status !== 'Review');
    const overdue = active.filter(a => PmpUtils.isDelayed(a));
    const review = joined.filter(a => a.Status === 'Review');

    const now = new Date();
    const today = PmpUtils.toLocalDateStr(now);
    const completedThisMonth = joined.filter(a => {
      if (a.Status !== 'Completed' && a.Status !== 'Closed') return false;
      const rows = (state.activityLog || []).filter(r => r.AssignmentID === a.AssignmentID && r.Action === 'StatusChange');
      if (rows.length === 0) return false;
      const last = rows.sort((x, y) => new Date(y.Timestamp) - new Date(x.Timestamp))[0];
      const d = new Date(last.Timestamp);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
    const completedToday = completedThisMonth.filter(a => {
      const rows = (state.activityLog || []).filter(r => r.AssignmentID === a.AssignmentID && r.Action === 'StatusChange');
      const last = rows.sort((x, y) => new Date(y.Timestamp) - new Date(x.Timestamp))[0];
      return last && PmpUtils.toLocalDateStr(last.Timestamp) === today;
    });

    const teamMinutesToday = state.employees.reduce((sum, e) => sum + minutesToday(e.employeeId), 0);

    container().innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; flex-wrap:wrap; gap:12px;">
        <div>
          <h2 style="margin:0 0 4px 0;">Team Control Center</h2>
          <div style="color:var(--pmp-text-muted); font-size:13px;">What is everyone working on right now.</div>
        </div>
        <div style="font-size:13px; color:var(--pmp-text-muted);">${now.toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })}</div>
      </div>

      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin-bottom:16px;">
        ${kpiCard('Team Members', state.employees.length, `${workingCount} Working · ${availableCount} Available · ${onLeaveCount} On Leave`)}
        ${kpiCard('Currently Working', workingCount, pausedCount > 0 ? `${pausedCount} Paused` : null)}
        ${kpiCard('Pending Tasks', pending.length, overdue.length > 0 ? `${overdue.length} Overdue` : null, overdue.length > 0 ? 'delayed' : null)}
        ${kpiCard('In Review', review.length, null)}
        ${kpiCard('Completed', completedThisMonth.length, `${completedToday.length} Today · This Month`, 'completed')}
        ${kpiCard('Team Hours Today', formatHM(teamMinutesToday), null)}
      </div>

      <div id="pmp-tld-working" class="pmp-card" style="margin-bottom:16px;"></div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
        <div id="pmp-tld-workload" class="pmp-card"></div>
        <div id="pmp-tld-priority" class="pmp-card"></div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:16px;">
        <div id="pmp-tld-overdue" class="pmp-card"></div>
        <div id="pmp-tld-review" class="pmp-card"></div>
      </div>

      <div id="pmp-tld-activity" class="pmp-card"></div>
    `;

    renderWorkingNow(statuses);
    renderWorkload(joined);
    renderPriority(active);
    renderOverdue(overdue);
    renderReviewQueue(review);
    renderActivity();
  }

  function kpiCard(label, value, sublabel, tone) {
    const toneVar = tone === 'delayed' ? 'var(--status-delayed)' : tone === 'completed' ? 'var(--status-completed)' : 'var(--pmp-text-muted)';
    return `
      <div class="pmp-card" style="padding:14px 16px;">
        <div style="font-size:22px; font-weight:700;">${value}</div>
        <div style="font-size:12px; color:var(--pmp-text-muted); margin-top:2px;">${PmpUtils.escapeHtml(label)}</div>
        ${sublabel ? `<div style="font-size:11px; color:${toneVar}; margin-top:4px; font-weight:600;">${PmpUtils.escapeHtml(sublabel)}</div>` : ''}
      </div>
    `;
  }

  // ------------------------------------------------------------
  // Who's Working Now
  // ------------------------------------------------------------

  const STATUS_LABELS = { Working: 'Working', Paused: 'Paused', Available: 'Available', OnLeave: 'On Leave' };
  const STATUS_DOT = { Working: 'var(--status-working)', Paused: 'var(--status-review)', Available: 'var(--status-completed)', OnLeave: '#9A958C' };

  function renderWorkingNow(statuses) {
    const el = document.getElementById('pmp-tld-working');
    if (!el) return;

    // Working/Paused first (most actionable), then Available, then On Leave.
    const order = { Working: 0, Paused: 1, Available: 2, OnLeave: 3 };
    const sorted = [...state.employees].sort((a, b) => order[statuses[a.employeeId]] - order[statuses[b.employeeId]]);

    const rows = sorted.map(e => {
      const status = statuses[e.employeeId];
      const open = status === 'Working' ? findOpenInterval(e.employeeId) : null;
      const pausedAssignment = status === 'Paused' ? joinedAssignments().find(a => a.AssignedTo === e.employeeId && a.Status === 'Working' && a.IsPaused === true) : null;
      const activeAssignment = open ? open.assignment : pausedAssignment;
      const { project, client } = activeAssignment ? projectAndClient(activeAssignment) : {};

      return `
        <tr>
          <td><span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:8px; height:8px; border-radius:50%; background:${PmpUtils.colorFromId(e.employeeId, 55)}; display:inline-block; flex-shrink:0;"></span>${PmpUtils.escapeHtml(e.name)}</span></td>
          <td><span style="display:inline-flex; align-items:center; gap:6px;"><span style="width:8px; height:8px; border-radius:50%; background:${STATUS_DOT[status]}; display:inline-block;"></span>${STATUS_LABELS[status]}</span></td>
          <td>${activeAssignment ? PmpUtils.escapeHtml(activeAssignment.SubTask) : '—'}</td>
          <td>${client ? `${PmpUtils.escapeHtml(client.ClientName)} <strong style="font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;">${PmpUtils.escapeHtml(client.ClientID)}</strong>` : '—'}</td>
          <td>${project ? `${PmpUtils.escapeHtml(project.ProjectName)} <strong style="font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;">${PmpUtils.escapeHtml(project.ProjectID)}</strong>` : '—'}</td>
          <td>${activeAssignment ? `<span class="pmp-badge pmp-badge-priority-${activeAssignment.Priority}">${PmpUtils.escapeHtml(activeAssignment.Priority || '')}</span>` : '—'}</td>
          <td>${open ? formatTime(open.start) : '—'}</td>
        </tr>
      `;
    }).join('');

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Who's Working Now</div>
      <table class="pmp-table">
        <thead><tr><th>Employee</th><th>Status</th><th>Current Task</th><th>Client</th><th>Project</th><th>Priority</th><th>Since</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center; color:var(--pmp-text-muted);">No employees found.</td></tr>'}</tbody>
      </table>
    `;
  }

  // ------------------------------------------------------------
  // Team Workload
  // ------------------------------------------------------------

  function renderWorkload(joined) {
    const el = document.getElementById('pmp-tld-workload');
    if (!el) return;

    const rows = state.employees.map(e => {
      const mine = joined.filter(a => a.AssignedTo === e.employeeId);
      const counts = {
        Assigned: mine.filter(a => a.Status === 'Assigned').length,
        Working: mine.filter(a => a.Status === 'Working').length,
        Review: mine.filter(a => a.Status === 'Review').length,
        Completed: mine.filter(a => a.Status === 'Completed' || a.Status === 'Closed').length,
        Overdue: mine.filter(a => PmpUtils.isDelayed(a)).length
      };
      return `
        <tr>
          <td><span style="display:inline-flex; align-items:center; gap:7px;"><span style="width:8px; height:8px; border-radius:50%; background:${PmpUtils.colorFromId(e.employeeId, 55)}; display:inline-block; flex-shrink:0;"></span>${PmpUtils.escapeHtml(e.name)}</span></td>
          <td>${counts.Assigned}</td>
          <td>${counts.Working}</td>
          <td>${counts.Review}</td>
          <td>${counts.Completed}</td>
          <td style="color:${counts.Overdue > 0 ? 'var(--status-delayed)' : 'inherit'}; font-weight:${counts.Overdue > 0 ? '700' : '400'};">${counts.Overdue}</td>
        </tr>
      `;
    }).join('');

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Team Workload</div>
      <table class="pmp-table">
        <thead><tr><th>Employee</th><th>Assigned</th><th>Working</th><th>Review</th><th>Completed</th><th>Overdue</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center; color:var(--pmp-text-muted);">No data.</td></tr>'}</tbody>
      </table>
    `;
  }

  // ------------------------------------------------------------
  // Priority Tasks
  // ------------------------------------------------------------

  function renderPriority(active) {
    const el = document.getElementById('pmp-tld-priority');
    if (!el) return;

    const order = { High: 0, Medium: 1, Low: 2 };
    const top = [...active].sort((a, b) => (order[a.Priority] ?? 3) - (order[b.Priority] ?? 3) || new Date(a.DueDate || 0) - new Date(b.DueDate || 0)).slice(0, 6);

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Priority Tasks</div>
      ${top.length === 0 ? '<div class="pmp-empty" style="margin:0;">No active tasks.</div>' : top.map(a => {
        const { project, client } = projectAndClient(a);
        const borderColor = a.Priority === 'High' ? 'var(--status-delayed)' : a.Priority === 'Medium' ? 'var(--priority-medium)' : 'var(--pmp-border, #ddd)';
        return `
          <div data-tld-open-task="${a.AssignmentID}" style="border-left:3px solid ${borderColor}; padding:8px 10px; margin-bottom:8px; cursor:pointer;">
            <div style="font-size:13px; font-weight:600;">${PmpUtils.escapeHtml(a.SubTask)}</div>
            <div style="font-size:12px; color:var(--pmp-text-muted);">${employeeName(a.AssignedTo)} · ${project ? PmpUtils.escapeHtml(project.ProjectName) + ' <strong style=\'font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;\'>' + PmpUtils.escapeHtml(project.ProjectID) + '</strong>' : ''}${client ? ' · ' + PmpUtils.escapeHtml(client.ClientName) + ' <strong style=\'font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;\'>' + PmpUtils.escapeHtml(client.ClientID) + '</strong>' : ''}</div>
            <div style="font-size:11px; color:var(--pmp-text-muted); margin-top:2px;">Due ${PmpUtils.formatDate(a.DueDate)}</div>
          </div>
        `;
      }).join('')}
    `;

    el.querySelectorAll('[data-tld-open-task]').forEach(row => {
      row.addEventListener('click', () => navigate('assignments', row.dataset.tldOpenTask));
    });
  }

  // ------------------------------------------------------------
  // Overdue Tasks
  // ------------------------------------------------------------

  function renderOverdue(overdue) {
    const el = document.getElementById('pmp-tld-overdue');
    if (!el) return;

    const rows = overdue.slice(0, 8).map(a => {
      const { project, client } = projectAndClient(a);
      const days = -1 * (PmpUtils.daysUntil(a.DueDate) || 0);
      return `
        <tr data-tld-open-task="${a.AssignmentID}" style="cursor:pointer;">
          <td>${PmpUtils.escapeHtml(a.SubTask)}</td>
          <td>${employeeName(a.AssignedTo)}</td>
          <td>${project ? `${PmpUtils.escapeHtml(project.ProjectName)} <strong style="font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;">${PmpUtils.escapeHtml(project.ProjectID)}</strong>` : '—'}</td>
          <td>${client ? `${PmpUtils.escapeHtml(client.ClientName)} <strong style="font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;">${PmpUtils.escapeHtml(client.ClientID)}</strong>` : '—'}</td>
          <td>${PmpUtils.formatDate(a.DueDate)}</td>
          <td style="color:var(--status-delayed); font-weight:700;">${days}d</td>
          <td><span class="pmp-badge" style="background:${PMP_CONFIG.STATUS_COLORS[a.Status] || '#eee'};">${PmpUtils.escapeHtml(a.Status)}</span></td>
        </tr>
      `;
    }).join('');

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Overdue Tasks</div>
      ${overdue.length === 0 ? '<div class="pmp-empty" style="margin:0;">Nothing overdue. 🎉</div>' : `
      <table class="pmp-table">
        <thead><tr><th>Task</th><th>Employee</th><th>Project</th><th>Client</th><th>Due</th><th>Overdue</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
    `;

    el.querySelectorAll('[data-tld-open-task]').forEach(row => {
      row.addEventListener('click', () => navigate('assignments', row.dataset.tldOpenTask));
    });
  }

  // ------------------------------------------------------------
  // Review Queue — View / Send Back to Working / Complete, same
  // managerOverride path pmp-teamlead.js's Assignments tab already uses.
  // ------------------------------------------------------------

  function renderReviewQueue(review) {
    const el = document.getElementById('pmp-tld-review');
    if (!el) return;

    const rows = review.map(a => {
      const { project, client } = projectAndClient(a);
      return `
        <div class="pmp-card" style="margin-bottom:8px; padding:10px 12px;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div>
              <div style="font-size:13px; font-weight:600;">${PmpUtils.escapeHtml(a.SubTask)}</div>
              <div style="font-size:12px; color:var(--pmp-text-muted);">${employeeName(a.AssignedTo)} · ${project ? PmpUtils.escapeHtml(project.ProjectName) + ' <strong style=\'font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;\'>' + PmpUtils.escapeHtml(project.ProjectID) + '</strong>' : ''}${client ? ' · ' + PmpUtils.escapeHtml(client.ClientName) + ' <strong style=\'font-family:monospace; font-size:14px; font-weight:700; background:#FDECC8; color:#7A5B00; padding:2px 6px; border-radius:5px; display:inline-block;\'>' + PmpUtils.escapeHtml(client.ClientID) + '</strong>' : ''}</div>
            </div>
            <span class="pmp-badge pmp-badge-priority-${a.Priority}">${PmpUtils.escapeHtml(a.Priority || '')}</span>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:6px; margin-top:8px;">
            <button class="pmp-btn" data-tld-open-task="${a.AssignmentID}" style="padding:4px 10px; font-size:12px;">View</button>
            <button class="pmp-btn" data-tld-send-back="${a.AssignmentID}" style="padding:4px 10px; font-size:12px;">Send Back to Working</button>
            <button class="pmp-btn pmp-btn-primary" data-tld-complete="${a.AssignmentID}" style="padding:4px 10px; font-size:12px;">Complete</button>
          </div>
        </div>
      `;
    }).join('');

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Review Queue</div>
      ${review.length === 0 ? '<div class="pmp-empty" style="margin:0;">Nothing waiting for review.</div>' : rows}
    `;

    el.querySelectorAll('[data-tld-open-task]').forEach(btn => {
      btn.addEventListener('click', () => navigate('assignments', btn.dataset.tldOpenTask));
    });
    el.querySelectorAll('[data-tld-send-back]').forEach(btn => {
      btn.addEventListener('click', () => reviewAction(btn.dataset.tldSendBack, 'Working'));
    });
    el.querySelectorAll('[data-tld-complete]').forEach(btn => {
      btn.addEventListener('click', () => reviewAction(btn.dataset.tldComplete, 'Completed'));
    });
  }

  async function reviewAction(assignmentId, toStatus) {
    const res = await PmpApi.updateAssignmentStatus({
      assignmentId,
      status: toStatus,
      employeeId: state.teamLeadId,
      managerOverride: true
    });
    if (res.success) {
      PmpUtils.toast(toStatus === 'Working' ? 'Sent back for rework' : 'Marked complete', 'success');
      await refresh();
    } else {
      PmpUtils.toast(res.error || 'Could not update', 'error');
    }
  }

  // ------------------------------------------------------------
  // Today's Team Activity
  // ------------------------------------------------------------

  function renderActivity() {
    const el = document.getElementById('pmp-tld-activity');
    if (!el) return;

    const today = PmpUtils.toLocalDateStr(new Date());
    const events = [];

    (state.activityLog || [])
      .filter(r => PmpUtils.toLocalDateStr(r.Timestamp) === today)
      .forEach(r => {
        const name = employeeName(r.EmployeeID);
        const assignment = state.assignments.find(a => a.AssignmentID === r.AssignmentID);
        const task = assignment ? state.tasks.find(t => t.TaskID === assignment.TaskID) : null;
        const taskName = task ? task.TaskName : '';

        if (r.Action === 'StatusChange' && r.FromStatus === 'Assigned' && r.ToStatus === 'Working') {
          events.push({ time: r.Timestamp, text: `${name} started working`, detail: taskName });
        } else if (r.Action === 'Paused') {
          events.push({ time: r.Timestamp, text: `${name} paused work`, detail: taskName });
        } else if (r.Action === 'Resumed') {
          events.push({ time: r.Timestamp, text: `${name} resumed work`, detail: taskName });
        } else if (r.Action === 'StatusChange' && r.FromStatus === 'Working' && r.ToStatus === 'Review') {
          events.push({ time: r.Timestamp, text: `${name} submitted for review`, detail: taskName });
        } else if (r.Action === 'StatusChange' && (r.ToStatus === 'Completed' || r.ToStatus === 'Closed')) {
          events.push({ time: r.Timestamp, text: `${name} completed`, detail: taskName });
        }
      });

    events.sort((a, b) => new Date(b.time) - new Date(a.time)); // most recent first

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Today's Team Activity</div>
      ${events.length === 0 ? '<div class="pmp-empty" style="margin:0;">Nothing logged yet today.</div>' : `
      <div style="max-height:260px; overflow-y:auto;">
        ${events.map(ev => `
          <div style="display:flex; gap:10px; padding:6px 0; border-bottom:1px solid var(--pmp-border, #f0f0f0);">
            <div style="font-size:11px; color:var(--pmp-text-muted); width:56px; flex-shrink:0;">${formatTime(ev.time)}</div>
            <div style="flex:1; min-width:0;">
              <div style="font-size:12px; font-weight:600;">${PmpUtils.escapeHtml(ev.text)}</div>
              ${ev.detail ? `<div style="font-size:11px; color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(ev.detail)}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>`}
    `;
  }

  // ------------------------------------------------------------

  function navigate(target, extra) {
    if (typeof state.onNavigate === 'function') state.onNavigate({ target, extra });
  }

  return { init, refresh };
})();