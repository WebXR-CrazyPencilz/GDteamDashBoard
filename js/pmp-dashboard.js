/**
 * PMP — Module: Employee Dashboard ("Home")
 *
 * New landing page for the Employee portal. Pure presentation layer — every
 * number here is derived from data the existing API already returns
 * (getMyAssignments, getTasks, getProjects, getClients, getActivityLog,
 * getTimesheetEntries). Nothing is fabricated and nothing is persisted by
 * this module.
 *
 * Reuses PmpUtils.computeWorkIntervals (ActivityLog -> closed work
 * intervals) as the single source of truth for "how much did I actually
 * work" everywhere on this page, same as PmpTimesheet — so the dashboard
 * numbers and the Timesheet numbers can never silently disagree.
 *
 * The "Currently Working On" card additionally reconstructs any *open*
 * interval (a Working, non-paused assignment whose last ActivityLog event
 * was a start with no matching end yet) since computeWorkIntervals only
 * returns closed intervals by design. That reconstruction is local to this
 * module — it does not change PmpUtils' contract.
 *
 * No Daily Goal card yet — deferred until a configurable per-employee/global
 * target exists in the backend (Phase 4).
 *
 * Self-sufficient module: owns its own state, fed by init().
 */

const PmpDashboard = (function () {

  let state = {
    employeeId: null,
    containerId: null,
    assignments: [],
    tasks: [],
    projects: [],
    clients: [],
    activityLog: [],
    todaysEntries: [], // saved Timesheet entries for today (Other Work / Manual)
    onNavigate: null,  // (target: 'mytasks-pending'|'mytasks-completed'|'mytasks'|'timesheet'|task) => void
    tickHandle: null
  };

  async function init(containerId, employeeId, opts) {
    state.containerId = containerId;
    state.employeeId = employeeId;
    state.onNavigate = (opts && opts.onNavigate) || null;
    await refresh();
  }

  async function refresh() {
    const today = PmpUtils.toLocalDateStr(new Date());
    const [assignmentsRes, tasksRes, projectsRes, clientsRes, logRes, entriesRes] = await Promise.all([
      PmpApi.getMyAssignments(state.employeeId),
      PmpApi.getTasks(),
      PmpApi.getProjects(),
      PmpApi.getClients(),
      PmpApi.getActivityLog(),
      PmpApi.getTimesheetEntries({ employeeId: state.employeeId, date: today })
    ]);

    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;
    if (logRes.success) state.activityLog = logRes.log;
    if (entriesRes.success) state.todaysEntries = entriesRes.entries;

    render();
  }

  function destroy() {
    if (state.tickHandle) { clearInterval(state.tickHandle); state.tickHandle = null; }
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

  function projectAndClient(assignment) {
    const project = state.projects.find(p => p.ProjectID === assignment.ProjectID);
    const client = project ? state.clients.find(c => c.ClientID === project.ClientID) : null;
    return { project, client };
  }

  // ------------------------------------------------------------
  // Derived data
  // ------------------------------------------------------------

  function joinedAssignments() {
    return state.assignments.map(withTask);
  }

  // Any assignment that's Working and not paused is "open". Normally there's
  // at most one (the UI only lets you start one at a time), but if there
  // happen to be several, the one with the most recent open start wins.
  function findOpenInterval() {
    const working = joinedAssignments().filter(a => a.Status === 'Working' && a.IsPaused !== true);
    if (working.length === 0) return null;

    const byAssignment = {};
    (state.activityLog || []).forEach(row => {
      if (row.EmployeeID !== state.employeeId) return;
      if (!byAssignment[row.AssignmentID]) byAssignment[row.AssignmentID] = [];
      byAssignment[row.AssignmentID].push(row);
    });

    let best = null;
    working.forEach(a => {
      const rows = (byAssignment[a.AssignmentID] || []).slice()
        .sort((x, y) => new Date(x.Timestamp) - new Date(y.Timestamp));
      let openStart = null;
      rows.forEach(row => {
        const isStart = (row.Action === 'StatusChange' && row.FromStatus === 'Assigned' && row.ToStatus === 'Working')
          || row.Action === 'Resumed';
        const isEnd = row.Action === 'Paused'
          || (row.Action === 'StatusChange' && row.FromStatus === 'Working' && row.ToStatus !== 'Working');
        if (isStart) openStart = row.Timestamp;
        else if (isEnd) openStart = null;
      });
      if (openStart && (!best || new Date(openStart) > new Date(best.start))) {
        best = { assignment: a, start: openStart };
      }
    });

    return best;
  }

  function minutesToday() {
    const today = PmpUtils.toLocalDateStr(new Date());
    return PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => iv.EmployeeID === state.employeeId && PmpUtils.toLocalDateStr(iv.start) === today)
      .reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
  }

  function minutesBetween(start, end) {
    return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  }

  // Last 7 calendar days (today inclusive), oldest first.
  function weeklyMinutes() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(PmpUtils.toLocalDateStr(d));
    }
    const intervals = PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => iv.EmployeeID === state.employeeId);

    return days.map(dateStr => {
      const mins = intervals
        .filter(iv => PmpUtils.toLocalDateStr(iv.start) === dateStr)
        .reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
      return { date: dateStr, minutes: mins };
    });
  }

  function taskCounts() {
    const joined = joinedAssignments();
    const active = joined.filter(a => a.Status !== 'Completed' && a.Status !== 'Closed');
    const overdue = active.filter(a => PmpUtils.isDelayed(a));
    const highPriorityActive = active.filter(a => a.Priority === 'High');
    const inProgress = joined.filter(a => a.Status === 'Working');

    const now = new Date();
    const completedThisMonth = joined.filter(a => {
      if (a.Status !== 'Completed' && a.Status !== 'Closed') return false;
      // No completion timestamp on the Assignment itself — approximate with
      // the most recent StatusChange-to-Review/Completed ActivityLog event
      // for this assignment, this month. Falls back to "not counted" if no
      // such event is found rather than guessing.
      const rows = (state.activityLog || []).filter(r =>
        r.AssignmentID === a.AssignmentID && r.EmployeeID === state.employeeId && r.Action === 'StatusChange'
      );
      if (rows.length === 0) return false;
      const last = rows.sort((x, y) => new Date(y.Timestamp) - new Date(x.Timestamp))[0];
      const d = new Date(last.Timestamp);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });

    return {
      pending: active.length,
      overdue: overdue.length,
      completedThisMonth: completedThisMonth.length,
      highPriorityActive: highPriorityActive.length,
      inProgress: inProgress.length,
      completedTotal: joined.filter(a => a.Status === 'Completed' || a.Status === 'Closed').length
    };
  }

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------

  function render() {
    destroy(); // clear any previous timer before re-rendering

    const joined = joinedAssignments();
    const counts = taskCounts();
    const open = findOpenInterval();
    const todayMins = minutesToday();
    const week = weeklyMinutes();

    container().innerHTML = `
      <div class="pmp-dash-wrap" style="display:flex; flex-direction:column; height:calc(100vh - var(--pmp-dash-chrome, 112px)); min-height:480px;">
        <div class="pmp-dash-header" style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; flex-wrap:wrap; gap:12px; flex:0 0 auto;">
          <div>
            <h2 style="margin:0 0 4px 0;">${greeting()}</h2>
            <div style="color:var(--pmp-text-muted); font-size:13px;">Here's what's happening with your work today.</div>
          </div>
          <div style="font-size:13px; color:var(--pmp-text-muted); text-align:right;">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })}</div>
        </div>

        <div class="pmp-dash-summary" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:10px; margin-bottom:12px; flex:0 0 auto;">
          ${summaryCard('Pending Tasks', counts.pending, counts.overdue > 0 ? `${counts.overdue} Overdue` : null, 'delayed')}
          ${summaryCard('Completed Tasks', counts.completedThisMonth, 'This Month', 'completed')}
          ${summaryCard('Hours Worked', formatHM(todayMins), 'Today', 'working')}
        </div>

        <div style="flex:1 1 auto; min-height:0; display:grid; grid-template-rows:1fr 1fr 1fr; gap:12px;">
          <div style="display:grid; grid-template-columns:2fr 1fr; gap:12px; min-height:0;">
            <div id="pmp-dash-current" style="min-height:0; overflow-y:auto;"></div>
            <div id="pmp-dash-priority" class="pmp-card" style="min-height:0; overflow-y:auto;"></div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; min-height:0;">
            <div class="pmp-card" id="pmp-dash-overview" style="min-height:0; overflow-y:auto;"></div>
            <div class="pmp-card" id="pmp-dash-weekly" style="min-height:0; overflow-y:auto;"></div>
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; min-height:0;">
            <div class="pmp-card" id="pmp-dash-timeline" style="min-height:0; overflow-y:auto;"></div>
            <div class="pmp-card" id="pmp-dash-recent" style="min-height:0; overflow-y:auto;"></div>
          </div>
        </div>
      </div>
    `;

    renderCurrentTask(open);
    renderPriorityTasks(joined);
    renderOverview(counts);
    renderWeekly(week);
    renderTimeline();
    renderRecentTasks(joined);
  }

  function greeting() {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const session = PmpUtils.getSession && PmpUtils.getSession();
    const name = (session && session.name) ? session.name.split(' ')[0] : '';
    return `Good ${part}${name ? ', ' + PmpUtils.escapeHtml(name) : ''}!`;
  }

  function summaryCard(label, value, sublabel, tone) {
    const toneVar = tone === 'delayed' ? 'var(--status-delayed)'
      : tone === 'completed' ? 'var(--status-completed)'
      : 'var(--status-working)';
    return `
      <div class="pmp-card" style="padding:14px 16px;">
        <div style="font-size:22px; font-weight:700;">${value}</div>
        <div style="font-size:12px; color:var(--pmp-text-muted); margin-top:2px;">${PmpUtils.escapeHtml(label)}</div>
        ${sublabel ? `<div style="font-size:11px; color:${toneVar}; margin-top:4px; font-weight:600;">${PmpUtils.escapeHtml(sublabel)}</div>` : ''}
      </div>
    `;
  }

  function formatHM(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // ------------------------------------------------------------
  // Currently Working On + live timer
  // ------------------------------------------------------------

  function renderCurrentTask(open) {
    const el = document.getElementById('pmp-dash-current');
    if (!el) return;

    if (!open) {
      // Still show a paused task here if there is one, so Resume is one click away.
      const paused = joinedAssignments().find(a => a.Status === 'Working' && a.IsPaused === true);
      if (paused) {
        el.innerHTML = currentTaskShell(paused, null, true);
        wireCurrentTaskActions(paused);
        return;
      }
      el.innerHTML = `<div class="pmp-card"><div class="pmp-empty" style="margin:0;">Nothing in progress right now. Start a task from My Tasks to see it here.</div></div>`;
      return;
    }

    el.innerHTML = currentTaskShell(open.assignment, open.start, false);
    wireCurrentTaskActions(open.assignment);

    const timerEl = () => document.getElementById('pmp-dash-timer');
    state.tickHandle = setInterval(() => {
      const t = timerEl();
      if (!t) { clearInterval(state.tickHandle); return; }
      t.textContent = elapsedStr(open.start);
    }, 1000);
  }

  function currentTaskShell(assignment, openStart, isPaused) {
    const { project, client } = projectAndClient(assignment);
    return `
      <div class="pmp-card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px;">
          <div>
            <div style="font-size:12px; color:var(--pmp-text-muted); margin-bottom:6px;">Currently Working On</div>
            <div class="pmp-assignment-title" style="font-size:17px;">${PmpUtils.escapeHtml(assignment.SubTask)}</div>
            <div class="pmp-assignment-meta" style="margin-top:6px;">
              ${client ? `<span>${PmpUtils.escapeHtml(client.ClientName)}</span>` : ''}
              ${project ? `<span>${PmpUtils.escapeHtml(project.ProjectName)}</span>` : ''}
              ${assignment.Dimension ? `<span>${PmpUtils.escapeHtml(assignment.Dimension)}</span>` : ''}
              <span class="pmp-badge pmp-badge-priority-${assignment.Priority}">${PmpUtils.escapeHtml(assignment.Priority || '')}</span>
              <span>Due ${PmpUtils.formatDate(assignment.DueDate)}</span>
            </div>
          </div>
          <div style="text-align:right;">
            ${isPaused
              ? `<span class="pmp-badge" style="background:var(--status-review); color:#fff;">Paused</span>`
              : `<div style="font-size:11px; color:var(--pmp-text-muted);">Working since ${formatTime(openStart)}</div>
                 <div id="pmp-dash-timer" style="font-size:24px; font-weight:700; font-variant-numeric:tabular-nums;">${elapsedStr(openStart)}</div>`
            }
          </div>
        </div>
        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:12px;">
          ${isPaused
            ? `<button class="pmp-btn pmp-btn-primary" data-dash-resume="${assignment.AssignmentID}">Resume</button>`
            : `<button class="pmp-btn" data-dash-pause="${assignment.AssignmentID}">Pause</button>`
          }
        </div>
      </div>
    `;
  }

  function wireCurrentTaskActions(assignment) {
    const pauseBtn = document.querySelector(`[data-dash-pause="${assignment.AssignmentID}"]`);
    const resumeBtn = document.querySelector(`[data-dash-resume="${assignment.AssignmentID}"]`);
    // One-click pause — no mandatory reason popup, per spec. Reason stays
    // available from the full My Tasks card for anyone who wants to log one.
    if (pauseBtn) pauseBtn.addEventListener('click', async () => {
      pauseBtn.disabled = true;
      const res = await PmpApi.pauseAssignment({ assignmentId: assignment.AssignmentID, employeeId: state.employeeId, reason: '' });
      if (res.success) { PmpUtils.toast('Task paused', 'success'); await refresh(); }
      else { PmpUtils.toast(res.error || 'Could not pause task', 'error'); pauseBtn.disabled = false; }
    });
    if (resumeBtn) resumeBtn.addEventListener('click', async () => {
      resumeBtn.disabled = true;
      const res = await PmpApi.resumeAssignment({ assignmentId: assignment.AssignmentID, employeeId: state.employeeId });
      if (res.success) { PmpUtils.toast('Task resumed', 'success'); await refresh(); }
      else { PmpUtils.toast(res.error || 'Could not resume task', 'error'); resumeBtn.disabled = false; }
    });
  }

  function elapsedStr(startIso) {
    const secs = Math.max(0, Math.floor((Date.now() - new Date(startIso).getTime()) / 1000));
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  // ------------------------------------------------------------
  // Priority Tasks
  // ------------------------------------------------------------

  function renderPriorityTasks(joined) {
    const el = document.getElementById('pmp-dash-priority');
    if (!el) return;

    const order = { High: 0, Medium: 1, Low: 2 };
    const active = joined
      .filter(a => a.Status !== 'Completed' && a.Status !== 'Closed')
      .sort((a, b) => (order[a.Priority] ?? 3) - (order[b.Priority] ?? 3) || new Date(a.DueDate || 0) - new Date(b.DueDate || 0))
      .slice(0, 5);

    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div style="font-weight:600;">Priority Tasks</div>
      </div>
      ${active.length === 0 ? '<div class="pmp-empty" style="margin:0;">No active tasks.</div>' : active.map(a => {
        const { project, client } = projectAndClient(a);
        const borderColor = a.Priority === 'High' ? 'var(--status-delayed)' : a.Priority === 'Medium' ? 'var(--priority-medium)' : 'var(--pmp-border, #ddd)';
        return `
          <div data-dash-open-task="${a.AssignmentID}" style="border-left:3px solid ${borderColor}; padding:8px 10px; margin-bottom:8px; cursor:pointer;">
            <div style="font-size:13px; font-weight:600;">${PmpUtils.escapeHtml(a.SubTask)}</div>
            <div style="font-size:11px; color:var(--pmp-text-muted);">${project ? PmpUtils.escapeHtml(project.ProjectName) : ''}${client ? ' · ' + PmpUtils.escapeHtml(client.ClientName) : ''}</div>
            <div style="font-size:11px; color:var(--pmp-text-muted); margin-top:2px;">Due ${PmpUtils.formatDate(a.DueDate)}</div>
          </div>
        `;
      }).join('')}
    `;

    el.querySelectorAll('[data-dash-open-task]').forEach(row => {
      row.addEventListener('click', () => navigate('mytasks', row.dataset.dashOpenTask));
    });
  }

  // ------------------------------------------------------------
  // Task Overview (donut)
  // ------------------------------------------------------------

  function renderOverview(counts) {
    const el = document.getElementById('pmp-dash-overview');
    if (!el) return;

    const segments = [
      { key: 'overdue', label: 'Overdue', value: counts.overdue, color: 'var(--status-delayed)' },
      { key: 'highPriorityActive', label: 'High Priority', value: counts.highPriorityActive, color: 'var(--pmp-accent-dark)' },
      { key: 'inProgress', label: 'In Progress', value: counts.inProgress, color: 'var(--status-working)' },
      { key: 'completedTotal', label: 'Completed', value: counts.completedTotal, color: 'var(--status-completed)' }
    ];
    const total = segments.reduce((s, x) => s + x.value, 0);

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Task Overview</div>
      <div style="display:flex; align-items:center; gap:20px; flex-wrap:wrap;">
        ${donutSvg(segments, total)}
        <div style="flex:1; min-width:140px;">
          ${segments.map(s => `
            <div data-dash-overview-filter="${s.key}" style="display:flex; align-items:center; gap:8px; font-size:12px; padding:3px 0; cursor:pointer;">
              <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; display:inline-block;"></span>
              <span style="flex:1;">${s.label}</span>
              <span style="font-weight:600;">${s.value}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;

    el.querySelectorAll('[data-dash-overview-filter]').forEach(row => {
      row.addEventListener('click', () => navigate('mytasks-filter', row.dataset.dashOverviewFilter));
    });
  }

  function donutSvg(segments, total) {
    const r = 42, cx = 50, cy = 50, circumference = 2 * Math.PI * r;
    let offset = 0;
    const arcs = total === 0 ? '' : segments.filter(s => s.value > 0).map(s => {
      const frac = s.value / total;
      const dash = frac * circumference;
      const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="12"
        stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
      offset += dash;
      return circle;
    }).join('');

    return `
      <svg viewBox="0 0 100 100" width="120" height="120">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--pmp-border, #eee)" stroke-width="12" />
        ${arcs}
        <text x="50" y="47" text-anchor="middle" font-size="20" font-weight="700" fill="var(--pmp-text)">${total}</text>
        <text x="50" y="62" text-anchor="middle" font-size="9" fill="var(--pmp-text-muted)">Total</text>
      </svg>
    `;
  }

  // ------------------------------------------------------------
  // Weekly Activity
  // ------------------------------------------------------------

  function renderWeekly(week) {
    const el = document.getElementById('pmp-dash-weekly');
    if (!el) return;

    const max = Math.max(60, ...week.map(w => w.minutes)); // at least 1hr scale so a zero week isn't all full-height bars
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div style="font-weight:600;">This Week's Activity</div>
      </div>
      <div style="display:flex; align-items:flex-end; gap:8px; height:110px;">
        ${week.map(w => {
          const h = Math.round((w.minutes / max) * 90);
          const label = new Date(w.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });
          return `
            <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px;">
              <div style="font-size:10px; color:var(--pmp-text-muted);">${w.minutes > 0 ? formatHM(w.minutes) : ''}</div>
              <div style="width:100%; max-width:28px; height:${Math.max(h, 2)}px; background:var(--status-working); border-radius:4px 4px 0 0; opacity:${w.minutes > 0 ? 1 : 0.25};"></div>
              <div style="font-size:10px; color:var(--pmp-text-muted);">${label}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div style="margin-top:8px;"><a href="#" id="pmp-dash-view-timesheet" style="font-size:12px;">View full timesheet →</a></div>
    `;

    document.getElementById('pmp-dash-view-timesheet').addEventListener('click', e => {
      e.preventDefault();
      navigate('timesheet');
    });
  }

  // ------------------------------------------------------------
  // Today's Timeline
  // ------------------------------------------------------------

  const TIMELINE_ICONS = {
    start: '▶',
    pause: '⏸',
    resume: '▶',
    complete: '✓',
    manual: '✎'
  };

  function renderTimeline() {
    const el = document.getElementById('pmp-dash-timeline');
    if (!el) return;

    const today = PmpUtils.toLocalDateStr(new Date());
    const events = [];

    (state.activityLog || [])
      .filter(r => r.EmployeeID === state.employeeId && PmpUtils.toLocalDateStr(r.Timestamp) === today)
      .forEach(r => {
        const task = taskNameForAssignment(r.AssignmentID);
        if (r.Action === 'StatusChange' && r.FromStatus === 'Assigned' && r.ToStatus === 'Working') {
          events.push({ time: r.Timestamp, icon: 'start', title: 'Started working', detail: task });
        } else if (r.Action === 'Paused') {
          events.push({ time: r.Timestamp, icon: 'pause', title: 'Paused', detail: task });
        } else if (r.Action === 'Resumed') {
          events.push({ time: r.Timestamp, icon: 'resume', title: 'Resumed work', detail: task });
        } else if (r.Action === 'StatusChange' && r.FromStatus === 'Working' && r.ToStatus === 'Review') {
          events.push({ time: r.Timestamp, icon: 'complete', title: 'Marked complete', detail: task });
        }
      });

    // Manual/Other Work timesheet entries for today (e.g. meetings, lunch)
    // — these are real submitted rows, not fabricated. Shown as their own
    // start event since they don't produce ActivityLog rows.
    (state.todaysEntries || []).forEach(e => {
      if (e.Source === 'Manual' || !e.AssignmentID) {
        events.push({ time: e.StartTime, icon: 'manual', title: e.TaskName || 'Other work', detail: e.Notes || '' });
      }
    });

    events.sort((a, b) => new Date(a.time) - new Date(b.time));

    el.innerHTML = `
      <div style="font-weight:600; margin-bottom:10px;">Today's Timeline</div>
      ${events.length === 0 ? '<div class="pmp-empty" style="margin:0;">Nothing logged yet today.</div>' : events.map(ev => `
        <div style="display:flex; gap:10px; padding:6px 0; border-bottom:1px solid var(--pmp-border, #f0f0f0);">
          <div style="font-size:11px; color:var(--pmp-text-muted); width:56px; flex-shrink:0;">${formatTime(ev.time)}</div>
          <div style="width:18px; flex-shrink:0; text-align:center;">${TIMELINE_ICONS[ev.icon] || '•'}</div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:12px; font-weight:600;">${PmpUtils.escapeHtml(ev.title)}</div>
            ${ev.detail ? `<div style="font-size:11px; color:var(--pmp-text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${PmpUtils.escapeHtml(ev.detail)}</div>` : ''}
          </div>
        </div>
      `).join('')}
    `;
  }

  function taskNameForAssignment(assignmentId) {
    const a = state.assignments.find(x => x.AssignmentID === assignmentId);
    if (!a) return '';
    const t = state.tasks.find(x => x.TaskID === a.TaskID);
    return t ? t.TaskName : (a.SubTask || '');
  }

  // ------------------------------------------------------------
  // Recent Tasks
  // ------------------------------------------------------------

  function renderRecentTasks(joined) {
    const el = document.getElementById('pmp-dash-recent');
    if (!el) return;

    const sorted = [...joined].sort((a, b) => new Date(b.DueDate || 0) - new Date(a.DueDate || 0)).slice(0, 6);

    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <div style="font-weight:600;">Recent Tasks</div>
        <a href="#" id="pmp-dash-view-all-tasks" style="font-size:12px;">View all →</a>
      </div>
      ${sorted.length === 0 ? '<div class="pmp-empty" style="margin:0;">No tasks yet.</div>' : `
      <table class="pmp-table">
        <thead><tr><th>Task</th><th>Priority</th><th>Status</th><th>Due</th></tr></thead>
        <tbody>
          ${sorted.map(a => `
            <tr data-dash-open-task="${a.AssignmentID}" style="cursor:pointer;">
              <td>${PmpUtils.escapeHtml(a.SubTask)}</td>
              <td><span class="pmp-badge pmp-badge-priority-${a.Priority}">${PmpUtils.escapeHtml(a.Priority || '')}</span></td>
              <td><span class="pmp-badge" style="background:${PMP_CONFIG.STATUS_COLORS[a.Status] || '#eee'};">${PmpUtils.escapeHtml(a.Status)}</span></td>
              <td>${PmpUtils.formatDate(a.DueDate)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`}
    `;

    document.getElementById('pmp-dash-view-all-tasks').addEventListener('click', e => {
      e.preventDefault();
      navigate('mytasks');
    });
    el.querySelectorAll('[data-dash-open-task]').forEach(row => {
      row.addEventListener('click', () => navigate('mytasks', row.dataset.dashOpenTask));
    });
  }

  // ------------------------------------------------------------
  // Navigation out of the dashboard — the shell (index.html) decides what
  // each target actually means, same pattern as PmpInbox's onOpenTask.
  // ------------------------------------------------------------

  function navigate(target, extra) {
    if (typeof state.onNavigate === 'function') {
      state.onNavigate({ target, extra });
    }
  }

  return { init, refresh, destroy };
})();