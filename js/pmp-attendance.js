/**
 * PMP — Module: Attendance
 *
 * Grid view — every employee as a row, each day as a column — same shape
 * as TimeTrack's Attendance tab (webxr-crazypencilz.github.io/3Dtimesheet),
 * built from PMP's own data: real Pause/Resume/StatusChange ActivityLog
 * events (via PmpUtils.computeWorkIntervals) for the hours/check-in-out
 * per cell, and each employee's submitted Timesheet entries (Source ===
 * 'Leave') for Leave days.
 *
 * Two view modes:
 * - 'last15': the last 15 calendar days ending today, oldest to newest.
 * - 'month': a full calendar month, with prev/next navigation — same
 *   month-browsing pattern the old per-employee view used.
 *
 * Honesty note: PMP has no "Permission Hours" or "Overtime" concept
 * anywhere in its data model (no shift schedule, no standard-hours
 * threshold, no permission-request workflow) the way TimeTrack does, so
 * this view does NOT show those two columns — inventing a threshold to
 * fake "Overtime" would be showing a number nobody actually configured.
 * Leave Days, Working Days, and Total Hours are all backed by real data
 * and are shown. If Permission/Overtime tracking gets added to the PMP
 * backend later, columns for them can be added the same way.
 *
 * Self-sufficient module: owns its own state, fed by init(containerId).
 */

const PmpAttendance = (function () {

  let state = {
    activityLog: [],
    employees: [],
    assignments: [],
    tasks: [],
    projects: [],
    clients: [],
    submittedByEmployee: {}, // employeeId -> that employee's submitted Timesheet entries (all dates)
    containerId: null,
    viewMode: 'last15', // 'last15' | 'month'
    viewedYear: new Date().getFullYear(),
    viewedMonth: new Date().getMonth(), // 0-indexed
    onForceAction: null // (employeeId, dateStr, 'entry'|'leave') => void — set via init opts, wired by the shell to jump into Timesheet
  };

  async function init(containerId, opts) {
    state.containerId = containerId;
    state.onForceAction = (opts && opts.onForceAction) || null;
    renderShell();
    await refresh();
  }

  async function refresh() {
    const [logRes, employeesRes, assignmentsRes, tasksRes, projectsRes, clientsRes] = await Promise.all([
      PmpApi.getActivityLog(),
      PmpApi.getEmployees(),
      PmpApi.getAssignments(),
      PmpApi.getTasks(),
      PmpApi.getProjects(),
      PmpApi.getClients()
    ]);

    if (logRes.success) state.activityLog = logRes.log;
    if (employeesRes.success) state.employees = employeesRes.employees.filter(e => e.role === 'Employee');
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;

    // Submitted entries live in each employee's own Timesheet sheet, so
    // this is one call per employee — fine at PMP's team sizes, and it's
    // the only way to know which days were actually submitted vs. just
    // logged, or marked Leave.
    const entryResults = await Promise.all(
      state.employees.map(e => PmpApi.getAllTimesheetEntries({ employeeId: e.employeeId }))
    );
    state.submittedByEmployee = {};
    state.employees.forEach((e, idx) => {
      state.submittedByEmployee[e.employeeId] = entryResults[idx].success ? entryResults[idx].entries : [];
    });

    render();
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:12px; align-items:center; flex-wrap:wrap;">
        <div class="pmp-filters" style="margin:0;">
          <button class="pmp-btn ${state.viewMode === 'last15' ? 'pmp-btn-primary' : ''}" id="pmp-att-mode-last15">Last 15 Days</button>
          <button class="pmp-btn ${state.viewMode === 'month' ? 'pmp-btn-primary' : ''}" id="pmp-att-mode-month">Month Wise</button>
        </div>
        <div style="flex:1;"></div>
        <div id="pmp-att-month-nav" style="display:${state.viewMode === 'month' ? 'flex' : 'none'}; align-items:center; gap:8px;">
          <button class="pmp-btn" id="pmp-att-prev-month">←</button>
          <span id="pmp-att-month-label" style="font-weight:600; min-width:120px; text-align:center;"></span>
          <button class="pmp-btn" id="pmp-att-next-month">→</button>
        </div>
      </div>
      <div style="font-size:12px; color:var(--pmp-text-muted); margin-bottom:12px; display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
        <span><span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:var(--status-completed); vertical-align:middle; margin-right:4px;"></span>Worked</span>
        <span><span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:var(--status-review); vertical-align:middle; margin-right:4px;"></span>Leave</span>
        <span><span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:var(--status-delayed); vertical-align:middle; margin-right:4px;"></span>No Entry (working day, nothing logged)</span>
      </div>
      <div id="pmp-att-content" style="overflow-x:auto;"></div>
    `;

    document.getElementById('pmp-att-mode-last15').addEventListener('click', () => { state.viewMode = 'last15'; renderShell(); render(); });
    document.getElementById('pmp-att-mode-month').addEventListener('click', () => { state.viewMode = 'month'; renderShell(); render(); });

    const prevBtn = document.getElementById('pmp-att-prev-month');
    const nextBtn = document.getElementById('pmp-att-next-month');
    if (prevBtn) prevBtn.addEventListener('click', () => shiftMonth(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => shiftMonth(1));
  }

  function shiftMonth(delta) {
    state.viewedMonth += delta;
    if (state.viewedMonth < 0) { state.viewedMonth = 11; state.viewedYear -= 1; }
    if (state.viewedMonth > 11) { state.viewedMonth = 0; state.viewedYear += 1; }
    render();
  }

  // Days to show as columns, oldest first, either the last 15 calendar
  // days ending today or every day in the viewed month.
  function visibleDays() {
    const days = [];
    if (state.viewMode === 'last15') {
      for (let i = 14; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d);
      }
    } else {
      const monthStart = new Date(state.viewedYear, state.viewedMonth, 1);
      const monthEnd = new Date(state.viewedYear, state.viewedMonth + 1, 0);
      const today = new Date();
      const lastDay = monthEnd < today ? monthEnd : today;
      for (let d = new Date(monthStart); d <= lastDay; d.setDate(d.getDate() + 1)) {
        days.push(new Date(d));
      }
    }
    return days;
  }

  function render() {
    const monthLabel = document.getElementById('pmp-att-month-label');
    if (monthLabel) {
      monthLabel.textContent = new Date(state.viewedYear, state.viewedMonth, 1)
        .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }

    const content = document.getElementById('pmp-att-content');
    if (!content) return;

    if (state.employees.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No employees found.</div>`;
      return;
    }

    const days = visibleDays();
    const allIntervals = PmpUtils.computeWorkIntervals(state.activityLog);

    content.innerHTML = `
      <table class="pmp-table" style="min-width:${200 + days.length * 110 + 260}px;">
        <thead>
          <tr>
            <th style="position:sticky; left:0; background:var(--pmp-bg, #fff); z-index:1;">Employee</th>
            ${days.map(d => `<th style="text-align:center; white-space:nowrap;">${d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</th>`).join('')}
            <th style="text-align:center;">Leave Days</th>
            <th style="text-align:center;">Working Days</th>
            <th style="text-align:center;">Total Hours</th>
          </tr>
        </thead>
        <tbody>
          ${state.employees.map(e => employeeRowHtml(e, days, allIntervals.filter(iv => iv.EmployeeID === e.employeeId))).join('')}
        </tbody>
      </table>
    `;

    content.querySelectorAll('.pmp-att-no-entry-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        showNoEntryPopover(btn, btn.dataset.emp, btn.dataset.date);
      });
    });
  }

  // Tiny two-button popover ("Force Entry" / "Force Leave") anchored to
  // the clicked cell — picking either one hands off to the Timesheet
  // module (via onForceAction) with that employee + date pre-filled, so
  // the Team Lead doesn't have to re-select both from scratch.
  let openPopover = null;

  function closeNoEntryPopover() {
    if (openPopover) { openPopover.remove(); openPopover = null; }
    document.removeEventListener('click', closeNoEntryPopover);
  }

  function showNoEntryPopover(anchorEl, employeeId, dateStr) {
    closeNoEntryPopover();

    const rect = anchorEl.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.className = 'pmp-modal-overlay-none'; // no dedicated class needed; inline-styled below
    pop.style.cssText = `position:fixed; top:${rect.bottom + window.scrollY + 4}px; left:${rect.left + window.scrollX}px; z-index:1000; background:#fff; border:1px solid var(--pmp-border, #ddd); border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.15); padding:6px; display:flex; flex-direction:column; gap:4px; min-width:140px;`;
    pop.innerHTML = `
      <button type="button" class="pmp-btn pmp-btn-primary" style="text-align:left;" data-pop-action="entry">Force Entry</button>
      <button type="button" class="pmp-btn" style="text-align:left;" data-pop-action="leave">Force Leave</button>
    `;
    document.body.appendChild(pop);
    openPopover = pop;

    pop.querySelector('[data-pop-action="entry"]').addEventListener('click', () => {
      closeNoEntryPopover();
      if (typeof state.onForceAction === 'function') state.onForceAction(employeeId, dateStr, 'entry');
    });
    pop.querySelector('[data-pop-action="leave"]').addEventListener('click', () => {
      closeNoEntryPopover();
      if (typeof state.onForceAction === 'function') state.onForceAction(employeeId, dateStr, 'leave');
    });

    // Defer attaching the outside-click closer so this same click doesn't
    // immediately close the popover it just opened.
    setTimeout(() => document.addEventListener('click', closeNoEntryPopover), 0);
  }

  function employeeRowHtml(employee, days, empIntervals) {
    const submitted = state.submittedByEmployee[employee.employeeId] || [];
    const byDate = {};
    empIntervals.forEach(iv => {
      const dateStr = PmpUtils.toLocalDateStr(iv.start);
      if (!byDate[dateStr]) byDate[dateStr] = [];
      byDate[dateStr].push(iv);
    });

    let leaveDays = 0;
    let workingDays = 0;
    let totalMinutes = 0;

    const cells = days.map(d => {
      const dateStr = PmpUtils.toLocalDateStr(d);
      const dayIntervals = byDate[dateStr] || [];
      const isSunday = d.getDay() === 0;
      const isLeave = submitted.some(e => e.Date === dateStr && e.Source === 'Leave');

      if (isLeave) {
        leaveDays++;
        return `<td style="text-align:center; vertical-align:top;"><span class="pmp-badge" style="background:var(--status-review); color:#fff;">Leave</span></td>`;
      }

      if (dayIntervals.length === 0) {
        if (isSunday) {
          return `<td style="text-align:center; color:var(--pmp-text-muted);">—</td>`;
        }
        return `<td style="text-align:center; vertical-align:top;"><button type="button" class="pmp-att-no-entry-btn" data-emp="${employee.employeeId}" data-date="${dateStr}" style="background:none; border:none; cursor:pointer; padding:2px 4px; color:var(--status-delayed); font-size:12px; font-weight:600;">✕ No Entry</button></td>`;
      }

      workingDays++;
      const sorted = [...dayIntervals].sort((a, b) => new Date(a.start) - new Date(b.start));
      const firstIn = sorted[0].start;
      const lastOut = sorted[sorted.length - 1].end;
      const dayMinutes = sorted.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
      totalMinutes += dayMinutes;

      return `
        <td style="text-align:center; vertical-align:top; white-space:nowrap;">
          <div style="font-weight:700; color:var(--status-completed);">${formatDuration(dayMinutes)}</div>
          <div style="font-size:11px; color:var(--pmp-text-muted);">${formatTime(firstIn)} → ${formatTime(lastOut)}</div>
        </td>
      `;
    }).join('');

    return `
      <tr>
        <td style="position:sticky; left:0; background:var(--pmp-bg, #fff); z-index:1; white-space:nowrap;">
          <div style="font-weight:600;">${PmpUtils.escapeHtml(employee.name)}</div>
          <div style="font-size:11px; color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(employee.employeeId)}</div>
        </td>
        ${cells}
        <td style="text-align:center; font-weight:600; color:var(--status-review);">${leaveDays}</td>
        <td style="text-align:center; font-weight:600;">${workingDays}</td>
        <td style="text-align:center; font-weight:700; color:var(--status-completed);">${formatDuration(totalMinutes)}</td>
      </tr>
    `;
  }

  // ============================================================
  // Shared helpers
  // ============================================================

  function minutesBetween(start, end) {
    return Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));
  }

  function formatDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  return { init, refresh };
})();