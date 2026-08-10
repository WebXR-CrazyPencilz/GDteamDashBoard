/**
 * PMP — Module: Attendance & Activity
 *
 * Combined Attendance + Timesheet view for Team Lead/Manager — one
 * dashboard per employee rather than two separate tabs, since they're
 * really the same underlying data (real Pause/Resume/StatusChange
 * ActivityLog events, via PmpUtils.computeWorkIntervals) viewed two ways.
 *
 * Honesty note about the summary cards: "No-Activity Days" is logged-PMP-
 * activity days, NOT verified leave/absence — PMP has no leave-tracking
 * system. Someone could be working without touching a PMP task that day
 * and would show here as no-activity. Labeled accordingly rather than
 * called "Leaves," which would claim something this data can't verify.
 *
 * This is Team Lead/Manager's read-only review view. It's separate from
 * the Employee's own editable Timesheet ('edit' mode in pmp-timesheet.js),
 * which still exists unchanged — employees still submit/correct their own
 * entries there; this dashboard is purely for reviewing that same
 * underlying activity, per employee, over time.
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
    submittedEntries: [], // this employee's own submitted Timesheet rows, all dates — distinguishes "logged" (light) from "submitted" (dark)
    containerId: null,
    selectedEmployeeId: null,
    viewedYear: new Date().getFullYear(),
    viewedMonth: new Date().getMonth() // 0-indexed
  };

  async function init(containerId) {
    state.containerId = containerId;
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

    if (!state.selectedEmployeeId && state.employees.length > 0) {
      state.selectedEmployeeId = state.employees[0].employeeId;
    }

    await loadSubmittedEntries();
    render();
  }

  // Submitted entries are per-employee (each employee has their own
  // Timesheet sheet), so this needs its own fetch whenever the selected
  // employee changes — not part of the shared refresh() above.
  async function loadSubmittedEntries() {
    if (!state.selectedEmployeeId) { state.submittedEntries = []; return; }
    const res = await PmpApi.getAllTimesheetEntries({ employeeId: state.selectedEmployeeId });
    state.submittedEntries = res.success ? res.entries : [];
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:16px; align-items:center; flex-wrap:wrap;">
        <select id="pmp-att-employee"></select>
        <div style="flex:1;"></div>
        <button class="pmp-btn" id="pmp-att-prev-month">←</button>
        <span id="pmp-att-month-label" style="font-weight:600; min-width:120px; text-align:center;"></span>
        <button class="pmp-btn" id="pmp-att-next-month">→</button>
      </div>
      <div style="font-size:12px; color:var(--pmp-text-muted); margin-bottom:12px; display:flex; gap:16px; align-items:center;">
        <span><span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:hsl(210,65%,88%); vertical-align:middle; margin-right:4px;"></span>Logged (not yet submitted)</span>
        <span><span style="display:inline-block; width:12px; height:12px; border-radius:2px; background:hsl(210,65%,40%); vertical-align:middle; margin-right:4px;"></span>Submitted</span>
      </div>
      <div id="pmp-att-content"></div>
    `;

    document.getElementById('pmp-att-employee').addEventListener('change', async e => {
      state.selectedEmployeeId = e.target.value;
      await loadSubmittedEntries();
      render();
    });
    document.getElementById('pmp-att-prev-month').addEventListener('click', () => shiftMonth(-1));
    document.getElementById('pmp-att-next-month').addEventListener('click', () => shiftMonth(1));
  }

  function shiftMonth(delta) {
    state.viewedMonth += delta;
    if (state.viewedMonth < 0) { state.viewedMonth = 11; state.viewedYear -= 1; }
    if (state.viewedMonth > 11) { state.viewedMonth = 0; state.viewedYear += 1; }
    render();
  }

  function render() {
    const empSelect = document.getElementById('pmp-att-employee');
    if (empSelect) {
      empSelect.innerHTML = state.employees.map(e =>
        `<option value="${e.employeeId}" ${e.employeeId === state.selectedEmployeeId ? 'selected' : ''}>${PmpUtils.escapeHtml(e.name)}</option>`
      ).join('');
    }

    const monthLabel = document.getElementById('pmp-att-month-label');
    if (monthLabel) {
      monthLabel.textContent = new Date(state.viewedYear, state.viewedMonth, 1)
        .toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
    }

    const content = document.getElementById('pmp-att-content');
    if (!content) return;

    if (!state.selectedEmployeeId) {
      content.innerHTML = `<div class="pmp-empty">No employees found.</div>`;
      return;
    }

    const allIntervals = PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => iv.EmployeeID === state.selectedEmployeeId);

    const monthStart = new Date(state.viewedYear, state.viewedMonth, 1);
    const monthEnd = new Date(state.viewedYear, state.viewedMonth + 1, 0);
    const today = new Date();
    const lastRelevantDay = monthEnd < today ? monthEnd : today;

    const monthIntervals = allIntervals.filter(iv => {
      const d = new Date(iv.start);
      return d >= monthStart && d <= monthEnd;
    });

    content.innerHTML = `
      ${summaryCardsHtml(allIntervals, monthIntervals, monthStart, lastRelevantDay)}
      ${dailyActivityHtml(monthIntervals, monthStart, lastRelevantDay)}
      ${monthlyProjectContributionHtml(monthIntervals)}
    `;
  }

  // ============================================================
  // Summary cards
  // ============================================================

  function summaryCardsHtml(allIntervals, monthIntervals, monthStart, lastRelevantDay) {
    const totalAllTimeMinutes = allIntervals.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
    const monthMinutes = monthIntervals.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);

    const workingDates = new Set(monthIntervals.map(iv => PmpUtils.toLocalDateStr(iv.start)));
    const workingDaysCount = workingDates.size;

    let noActivityDays = 0;
    let leaveDays = 0;
    for (let d = new Date(monthStart); d <= lastRelevantDay; d.setDate(d.getDate() + 1)) {
      const dateStr = PmpUtils.toLocalDateStr(d);
      if (isDateOnLeave(dateStr)) {
        leaveDays++;
      } else if (!workingDates.has(dateStr)) {
        noActivityDays++;
      }
    }

    return `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:20px;">
        ${summaryCard('Total Hours (all time)', formatDuration(totalAllTimeMinutes), 'var(--status-working)')}
        ${summaryCard('Working Days (this month)', String(workingDaysCount), 'var(--status-completed)')}
        ${summaryCard('Leave Days (this month)', String(leaveDays), 'var(--status-review)')}
        ${summaryCard('No-Activity Days (this month)', String(noActivityDays), 'var(--status-delayed)')}
        ${summaryCard("This Month's Hours", formatDuration(monthMinutes), 'var(--status-review)')}
      </div>
    `;
  }

  function summaryCard(label, value, color) {
    return `
      <div class="pmp-card" style="border-top:4px solid ${color};">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.03em; color:var(--pmp-text-muted);">${label}</div>
        <div style="font-size:22px; font-weight:700; margin-top:4px;">${value}</div>
      </div>
    `;
  }

  // ============================================================
  // Daily Attendance & Activity
  // ============================================================

  function dailyActivityHtml(monthIntervals, monthStart, lastRelevantDay) {
    const byDate = {};
    monthIntervals.forEach(iv => {
      const dateStr = PmpUtils.toLocalDateStr(iv.start);
      if (!byDate[dateStr]) byDate[dateStr] = [];
      byDate[dateStr].push(iv);
    });

    const days = [];
    for (let d = new Date(lastRelevantDay); d >= monthStart; d.setDate(d.getDate() - 1)) {
      days.push(new Date(d));
    }

    const rows = days.map(d => dayRowHtml(d, byDate[PmpUtils.toLocalDateStr(d)] || [])).join('');

    return `
      <div class="pmp-card" style="margin-bottom:20px;">
        <div class="pmp-assignment-title" style="margin-bottom:12px;">Attendance & Activity</div>
        ${rows || '<div class="pmp-empty">No activity this month.</div>'}
      </div>
    `;
  }

  function dayRowHtml(date, intervals) {
    const dateLabel = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    const dateStr = PmpUtils.toLocalDateStr(date);
    const leaveEntry = findLeaveEntry(dateStr);
    const hasActivity = intervals.length > 0;

    // A real submitted Leave record always wins over "no activity" — this
    // is verified data (the employee explicitly submitted it), not an
    // inference from an empty ActivityLog. Shown even on a day that also
    // happens to have some activity (e.g. half-day leave), since the Leave
    // submission itself is still a fact worth surfacing either way.
    if (leaveEntry) {
      return `
        <div style="display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid var(--pmp-border, #eee);">
          <span class="pmp-badge" style="min-width:60px; text-align:center;">${dateLabel}</span>
          <span class="pmp-badge" style="background:var(--status-review); color:#fff;">Leave</span>
          <div style="flex:1; color:var(--pmp-text-muted); font-size:12px;">${leaveEntry.Notes ? PmpUtils.escapeHtml(leaveEntry.Notes) : '—'}</div>
          ${hasActivity ? `<span style="font-size:12px; color:var(--pmp-text-muted);">Also logged ${formatDuration(intervals.reduce((s, iv) => s + minutesBetween(iv.start, iv.end), 0))}</span>` : ''}
        </div>
      `;
    }

    if (!hasActivity) {
      return `
        <div style="display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid var(--pmp-border, #eee);">
          <span class="pmp-badge" style="min-width:60px; text-align:center;">${dateLabel}</span>
          <span class="pmp-badge" style="background:#eee;">No activity</span>
          <div style="flex:1; color:var(--pmp-text-muted); font-size:12px;">—</div>
        </div>
      `;
    }

    const sorted = [...intervals].sort((a, b) => new Date(a.start) - new Date(b.start));
    const firstIn = sorted[0].start;
    const lastOut = sorted[sorted.length - 1].end;
    const totalWorkedMinutes = sorted.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
    const totalSpanMinutes = minutesBetween(firstIn, lastOut);
    const totalBreakMinutes = Math.max(0, totalSpanMinutes - totalWorkedMinutes);

    // Submission status is checked PER INTERVAL, not per day — a day with
    // one submitted 6-minute entry and three unsubmitted ones should show
    // one dark segment and three light ones, not the whole bar as dark.
    const intervalSubmittedFlags = sorted.map(iv => isIntervalSubmitted(iv));
    const submittedCount = intervalSubmittedFlags.filter(Boolean).length;
    const dayStatus = submittedCount === 0 ? 'none' : (submittedCount === sorted.length ? 'full' : 'partial');

    // Timeline bar spans the full firstIn->lastOut clock range (not just
    // worked time), so pauses show up as visible gaps rather than being
    // silently absorbed — a day that's "10:53am to 4:01pm, 2h45m worked"
    // now visually shows where the other ~2h23m of break time actually sat.
    const segmentParts = [];
    sorted.forEach((iv, idx) => {
      const workedMins = minutesBetween(iv.start, iv.end);
      const workedPct = totalSpanMinutes > 0 ? (workedMins / totalSpanMinutes) * 100 : 0;
      // Same hue per task either way (colorFromId) — just darker once this
      // specific interval is submitted, so a task's color identity stays
      // recognizable before and after submitting.
      const lightness = intervalSubmittedFlags[idx] ? 42 : 88;
      const color = PmpUtils.colorFromId(iv.AssignmentID, lightness);
      segmentParts.push(`<div style="width:${workedPct}%; background:${color}; height:100%;" title="Worked ${formatTime(iv.start)}\u2013${formatTime(iv.end)} (${formatDuration(workedMins)})${intervalSubmittedFlags[idx] ? ' \u2014 Submitted' : ' \u2014 Not yet submitted'}"></div>`);

      const next = sorted[idx + 1];
      if (next) {
        const breakMins = minutesBetween(iv.end, next.start);
        if (breakMins > 0) {
          const breakPct = totalSpanMinutes > 0 ? (breakMins / totalSpanMinutes) * 100 : 0;
          segmentParts.push(`<div style="width:${breakPct}%; height:100%; background:repeating-linear-gradient(45deg, #ddd, #ddd 4px, #f2f2f2 4px, #f2f2f2 8px);" title="Break ${formatTime(iv.end)}\u2013${formatTime(next.start)} (${formatDuration(breakMins)})"></div>`);
        }
      }
    });
    const segments = segmentParts.join('');

    const taskNames = [...new Set(sorted.map(iv => joinTaskInfo(iv.AssignmentID).taskName).filter(Boolean))];

    const badgeHtml = {
      full: '<span class="pmp-badge" style="background:#1B5E20; color:#fff;">Submitted</span>',
      partial: '<span class="pmp-badge" style="background:#F57F17; color:#fff;">Partially Submitted</span>',
      none: '<span class="pmp-badge" style="background:#C8E6C9; color:#1B5E20;">Logged</span>'
    }[dayStatus];

    return `
      <div style="padding:10px 0; border-bottom:1px solid var(--pmp-border, #eee);">
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
          <span class="pmp-badge" style="min-width:60px; text-align:center;">${dateLabel}</span>
          ${badgeHtml}
          <span style="font-size:13px;">${formatTime(firstIn)} \u2192 ${formatTime(lastOut)}</span>
          <div style="flex:1; min-width:120px; height:10px; border-radius:5px; overflow:hidden; display:flex;">${segments}</div>
          <span style="font-size:13px; font-weight:600;">${formatDuration(totalWorkedMinutes)}${totalBreakMinutes > 0 ? ` <span style="font-weight:400; color:var(--pmp-text-muted);">(+${formatDuration(totalBreakMinutes)} break)</span>` : ''}</span>
        </div>
        ${taskNames.length > 0 ? `<div style="font-size:12px; color:var(--pmp-text-muted); margin-top:4px; margin-left:72px;">${PmpUtils.escapeHtml(taskNames.join(' \u00b7 '))}</div>` : ''}
      </div>
    `;
  }

  // ============================================================
  // Monthly Project Contribution
  // ============================================================

  function monthlyProjectContributionHtml(monthIntervals) {
    const byProject = {};
    monthIntervals.forEach(iv => {
      const joined = joinTaskInfo(iv.AssignmentID);
      const key = joined.projectId || 'unknown';
      if (!byProject[key]) byProject[key] = { name: joined.projectName || 'Unknown project', minutes: 0 };
      byProject[key].minutes += minutesBetween(iv.start, iv.end);
    });

    const entries = Object.keys(byProject).map(id => ({ id, ...byProject[id] })).sort((a, b) => b.minutes - a.minutes);
    if (entries.length === 0) {
      return `
        <div class="pmp-card">
          <div class="pmp-assignment-title" style="margin-bottom:12px;">Monthly Project Contribution</div>
          <div class="pmp-empty">No work logged this month.</div>
        </div>
      `;
    }

    const maxMinutes = Math.max(...entries.map(e => e.minutes));
    const rows = entries.map(e => {
      const pct = maxMinutes > 0 ? (e.minutes / maxMinutes) * 100 : 0;
      const color = PmpUtils.colorFromId(e.id);
      return `
        <div style="display:flex; align-items:center; gap:12px; padding:6px 0;">
          <span style="min-width:160px; font-size:13px;">${PmpUtils.escapeHtml(e.name)}</span>
          <div style="flex:1; height:14px; background:#eee; border-radius:7px; overflow:hidden;">
            <div style="width:${pct}%; height:100%; background:${color};"></div>
          </div>
          <span style="min-width:70px; text-align:right; font-size:13px; font-weight:600;">${formatDuration(e.minutes)}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="pmp-card">
        <div class="pmp-assignment-title" style="margin-bottom:12px;">Monthly Project Contribution</div>
        ${rows}
      </div>
    `;
  }

  // ============================================================
  // Shared helpers
  // ============================================================

  // True if some submitted entry for this task overlaps this interval's
  // time range. Overlap (not exact equality) so a minor time correction
  // made during Submit still counts — the interval it came from is
  // considered covered, not left showing as unsubmitted.
  // Real Leave record check — a submitted Timesheet entry with
  // Source === 'Leave' (see pmp-timesheet.js markDayAsLeave), never an
  // inference from an empty ActivityLog. Per the "Holiday/No-Activity !=
  // Leave" rule: a day with zero logged work is just unverified silence,
  // not evidence of leave, so this only ever returns true when an actual
  // Leave row was submitted for that date.
  function findLeaveEntry(dateStr) {
    return state.submittedEntries.find(e => e.Date === dateStr && e.Source === 'Leave') || null;
  }

  function isDateOnLeave(dateStr) {
    return !!findLeaveEntry(dateStr);
  }

  function isIntervalSubmitted(iv) {
    const ivStart = new Date(iv.start).getTime();
    const ivEnd = new Date(iv.end).getTime();
    return state.submittedEntries.some(e => {
      if (e.AssignmentID !== iv.AssignmentID) return false;
      const entryStart = new Date(e.StartTime).getTime();
      const entryEnd = new Date(e.EndTime).getTime();
      if (isNaN(entryStart) || isNaN(entryEnd)) return false;
      return entryStart <= ivEnd && entryEnd >= ivStart;
    });
  }

  function joinTaskInfo(assignmentId) {
    const assignment = state.assignments.find(a => a.AssignmentID === assignmentId);
    const task = assignment ? state.tasks.find(t => t.TaskID === assignment.TaskID) : null;
    const project = task ? state.projects.find(p => p.ProjectID === task.ProjectID) : null;
    return {
      taskName: task ? task.TaskName : '',
      projectId: project ? project.ProjectID : '',
      projectName: project ? project.ProjectName : ''
    };
  }

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