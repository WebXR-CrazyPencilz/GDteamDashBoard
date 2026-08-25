/**
 * PMP — Module: HR Portal (pmp-hr.js)
 *
 * READ-ONLY attendance and working-time visibility for HR. Does not
 * create a second timing system — every hour/interval shown here comes
 * from the exact same ActivityLog + PmpUtils.computeWorkIntervals logic
 * the Employee Dashboard, Employee Portal, and Team Lead Attendance tab
 * already use. HR cannot Start/Pause/Resume/Complete work, edit Tasks/
 * Projects/Clients/Assignments, or touch Employee accounts from here —
 * none of those write paths are called anywhere in this file.
 *
 * STATUS RULES (see statusForEmployeeOnDate below for the exact logic):
 *   Working              = employee currently has an OPEN work interval
 *                           (only possible for today — you can't be
 *                           "currently" working on a past date).
 *   On Leave              = a submitted Timesheet entry with
 *                           Source === 'Leave' exists for that date.
 *   Present               = has a CLOSED work interval for that date, but
 *                           isn't currently working and isn't on Leave.
 *   No Attendance Recorded = none of the above. This is never inferred as
 *                           Leave — an empty ActivityLog day is just
 *                           unverified silence, exactly like PMP's
 *                           existing Attendance tab already treats it.
 *
 * Precedence when more than one could apply on the same day (e.g. a
 * half-day Leave entry alongside some logged activity): Working (today,
 * real-time truth) beats everything; a submitted Leave record beats
 * Present, since it's a deliberate, verified submission rather than an
 * inference. This ordering isn't explicitly spelled out in the original
 * brief's four bullet rules, so it's called out here as the one judgment
 * call this file makes.
 *
 * NO break/lunch tracking, NO productivity/idle scoring, NO employee
 * ranking — intentionally absent, not an oversight.
 *
 * Self-sufficient module: owns its own state, fed by init(containerId).
 * Assumes the caller (index.html's routeToPortal, same as every other
 * portal) has already authenticated via the normal PmpApi.login/pmp_login
 * flow — this module has no login UI of its own, same as every other
 * Pmp* module in this codebase.
 */

const PmpHR = (function () {

  let state = {
    employees: [],       // from PmpApi.getEmployeesFull() — ID, name, username, role, active
    activityLog: [],
    leaveEntries: [],     // from PmpApi.getAllLeaveEntries() — every submitted Leave row, all employees
    assignments: [],
    tasks: [],
    projects: [],
    clients: [],
    containerId: null,
    activeTab: 'dashboard', // 'dashboard' | 'attendance' | 'working' | 'timing' | 'leave' | 'employees'
    attendanceView: 'today', // 'today' | 'monthly' — sub-view within the Attendance tab
    filters: {
      employeeId: 'All',
      role: 'All',
      status: 'All',
      date: PmpUtils.toLocalDateStr(new Date())
    },
    monthly: {
      year: new Date().getFullYear(),
      month: new Date().getMonth() // 0-indexed
    },
    timing: {
      from: (() => { const d = new Date(); d.setDate(d.getDate() - 14); return PmpUtils.toLocalDateStr(d); })(),
      to: PmpUtils.toLocalDateStr(new Date()),
      sortBy: 'date',
      sortDir: 'desc'
    },
    refreshHandle: null
  };

  async function init(containerId) {
    state.containerId = containerId;
    renderShell();
    await refreshAll();
    // Currently Working needs to catch new starts/stops and keep live
    // durations current — refetches everything every 45s (within the
    // brief's 30-60s window) but ONLY while that tab is the one on
    // screen, so the other tabs don't churn the backend for no reason.
    if (state.refreshHandle) clearInterval(state.refreshHandle);
    state.refreshHandle = setInterval(() => {
      if (state.activeTab === 'working') refreshAll();
    }, 45000);
  }

  async function refreshAll() {
    const [employeesRes, logRes, leaveRes, assignmentsRes, tasksRes, projectsRes, clientsRes] = await Promise.all([
      PmpApi.getEmployeesFull(),
      PmpApi.getActivityLog(),
      PmpApi.getAllLeaveEntries(),
      PmpApi.getAssignments(),
      PmpApi.getTasks(),
      PmpApi.getProjects(),
      PmpApi.getClients()
    ]);

    if (employeesRes.success) state.employees = employeesRes.employees;
    if (logRes.success) state.activityLog = logRes.log;
    if (leaveRes.success) state.leaveEntries = leaveRes.leaveEntries;
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;

    render();
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  // ============================================================
  // Shell / tab navigation
  // ============================================================

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
        <button class="pmp-btn pmp-btn-primary" data-hr-tab="dashboard">HR Dashboard</button>
        <button class="pmp-btn" data-hr-tab="attendance">Attendance</button>
        <button class="pmp-btn" data-hr-tab="working">Currently Working</button>
        <button class="pmp-btn" data-hr-tab="timing">Timing Report</button>
        <button class="pmp-btn" data-hr-tab="leave">Leave</button>
        <button class="pmp-btn" data-hr-tab="employees">Employees</button>
      </div>
      <div id="pmp-hr-content"></div>
    `;

    container().querySelectorAll('[data-hr-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.hrTab;
        container().querySelectorAll('[data-hr-tab]').forEach(b => {
          b.classList.toggle('pmp-btn-primary', b.dataset.hrTab === state.activeTab);
        });
        render();
      });
    });
  }

  function render() {
    const content = document.getElementById('pmp-hr-content');
    if (!content) return;

    if (state.activeTab === 'dashboard') return renderDashboard(content);
    if (state.activeTab === 'attendance') return renderAttendance(content);
    if (state.activeTab === 'working') return renderCurrentlyWorking(content);
    if (state.activeTab === 'timing') return renderTimingReport(content);
    if (state.activeTab === 'leave') return renderLeave(content);
    if (state.activeTab === 'employees') return renderEmployees(content);
  }

  // ============================================================
  // Core status/time logic — the ONE place attendance status and
  // durations are computed, reused by every tab below.
  // ============================================================

  function activeEmployees() {
    return state.employees.filter(e => e.active);
  }

  // Real-time "is this person clocked in right now" check — same start/
  // end detection PmpUtils.computeWorkIntervals uses, but PmpUtils
  // deliberately excludes the still-open interval (it only returns
  // CLOSED ones). This walks the same state machine and, if it ends with
  // an unmatched start, returns that as the current open interval.
  function currentOpenInterval(employeeId) {
    const rows = state.activityLog
      .filter(r => r.EmployeeID === employeeId)
      .slice()
      .sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp));

    let openStart = null;
    let openAssignmentId = null;
    rows.forEach(row => {
      const isStart = (row.Action === 'StatusChange' && row.FromStatus === 'Assigned' && row.ToStatus === 'Working')
        || row.Action === 'Resumed';
      const isEnd = row.Action === 'Paused'
        || (row.Action === 'StatusChange' && row.FromStatus === 'Working' && row.ToStatus !== 'Working');

      if (isStart && !openStart) {
        openStart = row.Timestamp;
        openAssignmentId = row.AssignmentID;
      } else if (isEnd && openStart) {
        openStart = null;
        openAssignmentId = null;
      }
    });

    return openStart ? { start: openStart, assignmentId: openAssignmentId } : null;
  }

  function closedIntervalsFor(employeeId, dateStr) {
    return PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => iv.EmployeeID === employeeId && PmpUtils.toLocalDateStr(iv.start) === dateStr);
  }

  function leaveEntryFor(employeeId, dateStr) {
    return state.leaveEntries.find(e => e.EmployeeID === employeeId && e.Date === dateStr) || null;
  }

  // The single source of truth for status — see the file header comment
  // for the exact rules and the precedence judgment call.
  function statusForEmployeeOnDate(employeeId, dateStr) {
    const isToday = dateStr === PmpUtils.toLocalDateStr(new Date());
    const open = isToday ? currentOpenInterval(employeeId) : null;
    if (open) return 'Working';

    const leave = leaveEntryFor(employeeId, dateStr);
    if (leave) return 'Leave';

    const closed = closedIntervalsFor(employeeId, dateStr);
    if (closed.length > 0) return 'Present';

    return 'No Attendance Recorded';
  }

  function dayTimingFor(employeeId, dateStr) {
    const isToday = dateStr === PmpUtils.toLocalDateStr(new Date());
    const open = isToday ? currentOpenInterval(employeeId) : null;
    const closed = closedIntervalsFor(employeeId, dateStr);

    const allStarts = closed.map(iv => iv.start).concat(open ? [open.start] : []);
    const allEnds = closed.map(iv => iv.end);

    const firstIn = allStarts.length > 0 ? allStarts.reduce((a, b) => new Date(a) < new Date(b) ? a : b) : null;
    const lastOut = allEnds.length > 0 ? allEnds.reduce((a, b) => new Date(a) > new Date(b) ? a : b) : null;

    let totalMinutes = closed.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);
    if (open) totalMinutes += minutesBetween(open.start, new Date());

    return { firstIn, lastOut, totalMinutes, open, closed };
  }

  function statusBadge(status) {
    const map = {
      'Working': 'background:var(--status-working); color:#fff;',
      'Present': 'background:var(--status-completed); color:#fff;',
      'Leave': 'background:var(--status-review); color:#fff;',
      'No Attendance Recorded': 'background:var(--status-delayed); color:#fff;'
    };
    return `<span class="pmp-badge" style="${map[status] || ''}">${PmpUtils.escapeHtml(status)}</span>`;
  }

  // ============================================================
  // 1. HR Dashboard
  // ============================================================

  function renderDashboard(content) {
    const today = PmpUtils.toLocalDateStr(new Date());
    const active = activeEmployees();

    let present = 0, working = 0, onLeave = 0, noAttendance = 0, totalMinutesToday = 0;
    active.forEach(e => {
      const status = statusForEmployeeOnDate(e.employeeId, today);
      if (status === 'Working') { working++; present++; }
      else if (status === 'Present') present++;
      else if (status === 'Leave') onLeave++;
      else noAttendance++;

      totalMinutesToday += dayTimingFor(e.employeeId, today).totalMinutes;
    });

    content.innerHTML = `
      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom:20px;">
        ${dashCard('Total Employees', active.length, 'var(--pmp-text-muted)')}
        ${dashCard('Present Today', present, 'var(--status-completed)')}
        ${dashCard('Currently Working', working, 'var(--status-working)')}
        ${dashCard('On Leave', onLeave, 'var(--status-review)')}
        ${dashCard('No Attendance Recorded', noAttendance, 'var(--status-delayed)')}
        ${dashCard("Today's Hours (all employees)", formatDuration(totalMinutesToday), 'var(--status-working)')}
      </div>
      <div class="pmp-card">
        <div class="pmp-assignment-title" style="margin-bottom:8px;">Work Summary — Today</div>
        <div style="font-size:13px; color:var(--pmp-text-muted);">
          ${present} of ${active.length} employees have recorded attendance today
          ${onLeave > 0 ? `, ${onLeave} on Leave` : ''}
          ${noAttendance > 0 ? `, ${noAttendance} with no attendance recorded yet` : ''}.
        </div>
      </div>
    `;
  }

  function dashCard(label, value, color) {
    return `
      <div class="pmp-card" style="border-top:4px solid ${color};">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:0.03em; color:var(--pmp-text-muted);">${label}</div>
        <div style="font-size:22px; font-weight:700; margin-top:4px;">${value}</div>
      </div>
    `;
  }

  // ============================================================
  // 2 & 5. Attendance (Today + Monthly sub-views) + filters
  // ============================================================

  function renderAttendance(content) {
    content.innerHTML = `
      <div class="pmp-filters" style="margin-bottom:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <button class="pmp-btn ${state.attendanceView === 'today' ? 'pmp-btn-primary' : ''}" id="pmp-hr-view-today">Today's Attendance</button>
        <button class="pmp-btn ${state.attendanceView === 'monthly' ? 'pmp-btn-primary' : ''}" id="pmp-hr-view-monthly">Monthly Attendance</button>
        <div style="flex:1;"></div>
        ${state.attendanceView === 'today' ? filterBarHtml() : ''}
      </div>
      <div id="pmp-hr-attendance-body"></div>
    `;

    document.getElementById('pmp-hr-view-today').addEventListener('click', () => { state.attendanceView = 'today'; renderAttendance(content); });
    document.getElementById('pmp-hr-view-monthly').addEventListener('click', () => { state.attendanceView = 'monthly'; renderAttendance(content); });

    wireFilterBar(content);

    const body = document.getElementById('pmp-hr-attendance-body');
    if (state.attendanceView === 'today') renderTodayAttendance(body);
    else renderMonthlyAttendance(body);
  }

  function filterBarHtml() {
    const roles = (typeof PMP_CONFIG !== 'undefined' && PMP_CONFIG.ALL_ROLES) ? PMP_CONFIG.ALL_ROLES : ['Employee', 'Manager', 'TeamLead'];
    return `
      <input type="date" id="pmp-hr-filter-date" value="${state.filters.date}">
      <select id="pmp-hr-filter-employee">
        <option value="All">All Employees</option>
        ${activeEmployees().map(e => `<option value="${e.employeeId}" ${state.filters.employeeId === e.employeeId ? 'selected' : ''}>${PmpUtils.escapeHtml(e.name)}</option>`).join('')}
      </select>
      <select id="pmp-hr-filter-role">
        <option value="All">All Roles</option>
        ${roles.filter(r => r !== 'Admin').map(r => `<option value="${r}" ${state.filters.role === r ? 'selected' : ''}>${r === 'TeamLead' ? 'Team Lead' : r}</option>`).join('')}
      </select>
      <select id="pmp-hr-filter-status">
        <option value="All">All Statuses</option>
        <option value="Working" ${state.filters.status === 'Working' ? 'selected' : ''}>Working</option>
        <option value="Present" ${state.filters.status === 'Present' ? 'selected' : ''}>Present</option>
        <option value="Leave" ${state.filters.status === 'Leave' ? 'selected' : ''}>On Leave</option>
        <option value="No Attendance Recorded" ${state.filters.status === 'No Attendance Recorded' ? 'selected' : ''}>No Attendance Recorded</option>
      </select>
    `;
  }

  function wireFilterBar(content) {
    const dateEl = document.getElementById('pmp-hr-filter-date');
    const empEl = document.getElementById('pmp-hr-filter-employee');
    const roleEl = document.getElementById('pmp-hr-filter-role');
    const statusEl = document.getElementById('pmp-hr-filter-status');
    if (!dateEl) return;

    dateEl.addEventListener('change', e => { state.filters.date = e.target.value; renderTodayAttendance(document.getElementById('pmp-hr-attendance-body')); });
    empEl.addEventListener('change', e => { state.filters.employeeId = e.target.value; renderTodayAttendance(document.getElementById('pmp-hr-attendance-body')); });
    roleEl.addEventListener('change', e => { state.filters.role = e.target.value; renderTodayAttendance(document.getElementById('pmp-hr-attendance-body')); });
    statusEl.addEventListener('change', e => { state.filters.status = e.target.value; renderTodayAttendance(document.getElementById('pmp-hr-attendance-body')); });
  }

  function filteredEmployees() {
    return activeEmployees().filter(e => {
      if (state.filters.employeeId !== 'All' && e.employeeId !== state.filters.employeeId) return false;
      if (state.filters.role !== 'All' && e.role !== state.filters.role) return false;
      return true;
    });
  }

  function renderTodayAttendance(body) {
    if (!body) return;
    const dateStr = state.filters.date;
    const rows = filteredEmployees()
      .map(e => ({ employee: e, status: statusForEmployeeOnDate(e.employeeId, dateStr), timing: dayTimingFor(e.employeeId, dateStr) }))
      .filter(r => state.filters.status === 'All' || r.status === state.filters.status);

    if (rows.length === 0) {
      body.innerHTML = `<div class="pmp-empty">No employees match these filters.</div>`;
      return;
    }

    body.innerHTML = `
      <table class="pmp-table">
        <thead><tr><th>Employee ID</th><th>Name</th><th>Status</th><th>Check In</th><th>Check Out</th><th>Working Time</th><th>Total Hours</th><th>Remarks</th></tr></thead>
        <tbody>
          ${rows.map(r => {
            const leave = leaveEntryFor(r.employee.employeeId, dateStr);
            return `
              <tr data-hr-open-employee="${r.employee.employeeId}" style="cursor:pointer;">
                <td>${PmpUtils.escapeHtml(r.employee.employeeId)}</td>
                <td>${PmpUtils.escapeHtml(r.employee.name)}</td>
                <td>${statusBadge(r.status)}</td>
                <td>${r.timing.firstIn ? formatTime(r.timing.firstIn) : '—'}</td>
                <td>${(r.timing.lastOut && r.status !== 'Working') ? formatTime(r.timing.lastOut) : '—'}</td>
                <td>${r.status === 'Working' ? formatDuration(r.timing.totalMinutes) + ' (ongoing)' : '—'}</td>
                <td>${r.timing.totalMinutes > 0 ? formatDuration(r.timing.totalMinutes) : '—'}</td>
                <td>${leave && leave.Notes ? PmpUtils.escapeHtml(leave.Notes) : '—'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    body.querySelectorAll('[data-hr-open-employee]').forEach(row => {
      row.addEventListener('click', () => openEmployeeDetail(row.dataset.hrOpenEmployee));
    });
  }

  function renderMonthlyAttendance(body) {
    if (!body) return;
    const { year, month } = state.monthly;
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0);
    const daysInMonth = monthEnd.getDate();
    const monthLabel = monthStart.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

    const employees = filteredEmployees();

    body.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <button class="pmp-btn" id="pmp-hr-month-prev">← Previous</button>
        <span style="font-weight:600; min-width:160px; text-align:center;">${monthLabel}</span>
        <button class="pmp-btn" id="pmp-hr-month-next">Next →</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="pmp-table" style="min-width:${200 + daysInMonth * 34 + 400}px;">
          <thead>
            <tr>
              <th style="position:sticky; left:0; background:var(--pmp-bg,#fff); z-index:1;">Employee</th>
              ${Array.from({ length: daysInMonth }, (_, i) => `<th style="text-align:center; padding:4px;">${i + 1}</th>`).join('')}
              <th style="text-align:center;">Working Days</th>
              <th style="text-align:center;">Leave Days</th>
              <th style="text-align:center;">No Attendance</th>
              <th style="text-align:center;">Total Hours</th>
            </tr>
          </thead>
          <tbody>
            ${employees.map(e => monthlyRowHtml(e, year, month, daysInMonth)).join('')}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById('pmp-hr-month-prev').addEventListener('click', () => { shiftMonth(-1); renderMonthlyAttendance(body); });
    document.getElementById('pmp-hr-month-next').addEventListener('click', () => { shiftMonth(1); renderMonthlyAttendance(body); });
  }

  function shiftMonth(delta) {
    state.monthly.month += delta;
    if (state.monthly.month < 0) { state.monthly.month = 11; state.monthly.year -= 1; }
    if (state.monthly.month > 11) { state.monthly.month = 0; state.monthly.year += 1; }
  }

  const STATUS_ABBR = { 'Working': 'W', 'Present': 'P', 'Leave': 'L', 'No Attendance Recorded': '—' };
  const STATUS_ABBR_COLOR = {
    'Working': 'background:var(--status-working); color:#fff;',
    'Present': 'background:var(--status-completed); color:#fff;',
    'Leave': 'background:var(--status-review); color:#fff;',
    'No Attendance Recorded': 'color:var(--pmp-text-muted);'
  };

  function monthlyRowHtml(employee, year, month, daysInMonth) {
    let workingDays = 0, leaveDays = 0, noAttendanceDays = 0, totalMinutes = 0;
    const today = PmpUtils.toLocalDateStr(new Date());

    const cells = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = PmpUtils.toLocalDateStr(new Date(year, month, d));
      if (dateStr > today) { cells.push('<td></td>'); continue; } // future day — nothing to show, not fabricated

      const status = statusForEmployeeOnDate(employee.employeeId, dateStr);
      if (status === 'Working' || status === 'Present') workingDays++;
      else if (status === 'Leave') leaveDays++;
      else noAttendanceDays++;

      totalMinutes += dayTimingFor(employee.employeeId, dateStr).totalMinutes;

      cells.push(`<td style="text-align:center; padding:4px;"><span style="display:inline-block; width:20px; height:20px; line-height:20px; border-radius:4px; font-size:10px; font-weight:700; ${STATUS_ABBR_COLOR[status]}">${STATUS_ABBR[status]}</span></td>`);
    }

    return `
      <tr>
        <td style="position:sticky; left:0; background:var(--pmp-bg,#fff); z-index:1; white-space:nowrap; cursor:pointer;" data-hr-open-employee="${employee.employeeId}">
          <div style="font-weight:600;">${PmpUtils.escapeHtml(employee.name)}</div>
          <div style="font-size:11px; color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(employee.employeeId)}</div>
        </td>
        ${cells.join('')}
        <td style="text-align:center; font-weight:600;">${workingDays}</td>
        <td style="text-align:center; font-weight:600; color:var(--status-review);">${leaveDays}</td>
        <td style="text-align:center; font-weight:600; color:var(--status-delayed);">${noAttendanceDays}</td>
        <td style="text-align:center; font-weight:700;">${formatDuration(totalMinutes)}</td>
      </tr>
    `;
  }

  // ============================================================
  // 3. Currently Working
  // ============================================================

  function renderCurrentlyWorking(content) {
    const working = activeEmployees()
      .map(e => ({ employee: e, open: currentOpenInterval(e.employeeId) }))
      .filter(r => r.open);

    if (working.length === 0) {
      content.innerHTML = `<div class="pmp-empty">Nobody is currently working.</div>`;
      return;
    }

    content.innerHTML = `<div class="pmp-card-grid">${working.map(r => workingCardHtml(r.employee, r.open)).join('')}</div>`;
  }

  function workingCardHtml(employee, open) {
    const joined = joinAssignmentInfo(open.assignmentId);
    const elapsed = minutesBetween(open.start, new Date());

    return `
      <div class="pmp-card" style="border-left:3px solid var(--status-working);">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(employee.name)}</div>
        <div style="font-size:11px; color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(employee.employeeId)}</div>
        <div class="pmp-assignment-meta" style="margin-top:8px;">
          ${joined.taskName ? `<span>${PmpUtils.escapeHtml(joined.taskName)}</span>` : '<span style="color:var(--pmp-text-muted);">Task unknown</span>'}
          ${joined.projectName ? `<span>${PmpUtils.escapeHtml(joined.projectName)}</span>` : ''}
          ${joined.clientName ? `<span>${PmpUtils.escapeHtml(joined.clientName)}</span>` : ''}
        </div>
        <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:12px; color:var(--pmp-text-muted);">Started ${formatTime(open.start)}</span>
          <span class="pmp-badge" style="background:var(--status-working); color:#fff;">${formatDuration(elapsed)}</span>
        </div>
      </div>
    `;
  }

  // ============================================================
  // 7. Timing Report
  // ============================================================

  function renderTimingReport(content) {
    content.innerHTML = `
      <div class="pmp-filters" style="margin-bottom:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <label style="font-size:12px;">From <input type="date" id="pmp-hr-timing-from" value="${state.timing.from}"></label>
        <label style="font-size:12px;">To <input type="date" id="pmp-hr-timing-to" value="${state.timing.to}"></label>
      </div>
      <div id="pmp-hr-timing-body"></div>
    `;

    document.getElementById('pmp-hr-timing-from').addEventListener('change', e => { state.timing.from = e.target.value; renderTimingBody(); });
    document.getElementById('pmp-hr-timing-to').addEventListener('change', e => { state.timing.to = e.target.value; renderTimingBody(); });

    renderTimingBody();
  }

  function timingHeader(label, key) {
    const arrow = state.timing.sortBy === key ? (state.timing.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th style="cursor:pointer;" data-hr-sort="${key}">${label}${arrow}</th>`;
  }

  function renderTimingBody() {
    const body = document.getElementById('pmp-hr-timing-body');
    if (!body) return;

    const rows = [];
    activeEmployees().forEach(e => {
      let d = new Date(state.timing.from + 'T00:00:00');
      const end = new Date(state.timing.to + 'T00:00:00');
      while (d <= end) {
        const dateStr = PmpUtils.toLocalDateStr(d);
        const status = statusForEmployeeOnDate(e.employeeId, dateStr);
        if (status === 'Working' || status === 'Present') {
          const timing = dayTimingFor(e.employeeId, dateStr);
          rows.push({ employee: e, date: dateStr, timing, status });
        }
        d.setDate(d.getDate() + 1);
      }
    });

    rows.sort((a, b) => {
      let cmp = 0;
      if (state.timing.sortBy === 'employee') cmp = a.employee.name.localeCompare(b.employee.name);
      else if (state.timing.sortBy === 'date') cmp = a.date.localeCompare(b.date);
      else if (state.timing.sortBy === 'total') cmp = a.timing.totalMinutes - b.timing.totalMinutes;
      else if (state.timing.sortBy === 'checkin') cmp = new Date(a.timing.firstIn || 0) - new Date(b.timing.firstIn || 0);
      else if (state.timing.sortBy === 'checkout') cmp = new Date(a.timing.lastOut || 0) - new Date(b.timing.lastOut || 0);
      return state.timing.sortDir === 'asc' ? cmp : -cmp;
    });

    if (rows.length === 0) {
      body.innerHTML = `<div class="pmp-empty">No working time recorded in this range.</div>`;
      return;
    }

    body.innerHTML = `
      <table class="pmp-table">
        <thead><tr>
          ${timingHeader('Employee', 'employee')}
          ${timingHeader('Date', 'date')}
          ${timingHeader('First Check In', 'checkin')}
          ${timingHeader('Last Check Out', 'checkout')}
          ${timingHeader('Total Working', 'total')}
          <th>Status</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${PmpUtils.escapeHtml(r.employee.name)}</td>
              <td>${r.date}</td>
              <td>${r.timing.firstIn ? formatTime(r.timing.firstIn) : '—'}</td>
              <td>${r.timing.lastOut ? formatTime(r.timing.lastOut) : '—'}</td>
              <td style="font-weight:600;">${formatDuration(r.timing.totalMinutes)}</td>
              <td>${statusBadge(r.status)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    body.querySelectorAll('[data-hr-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.hrSort;
        if (state.timing.sortBy === key) state.timing.sortDir = state.timing.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.timing.sortBy = key; state.timing.sortDir = 'asc'; }
        renderTimingBody();
      });
    });
  }

  // ============================================================
  // 8. Leave
  // ============================================================

  function renderLeave(content) {
    const sorted = [...state.leaveEntries].sort((a, b) => b.Date.localeCompare(a.Date));

    if (sorted.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No Leave entries submitted.</div>`;
      return;
    }

    content.innerHTML = `
      <table class="pmp-table">
        <thead><tr><th>Employee</th><th>Employee ID</th><th>Date</th><th>Leave Status</th><th>Notes</th></tr></thead>
        <tbody>
          ${sorted.map(l => `
            <tr>
              <td>${PmpUtils.escapeHtml(employeeName(l.EmployeeID))}</td>
              <td>${PmpUtils.escapeHtml(l.EmployeeID)}</td>
              <td>${l.Date}</td>
              <td><span class="pmp-badge" style="background:var(--status-review); color:#fff;">Leave</span></td>
              <td>${l.Notes ? PmpUtils.escapeHtml(l.Notes) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ============================================================
  // 9. Employees (read-only)
  // ============================================================

  function renderEmployees(content) {
    if (state.employees.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No employees found.</div>`;
      return;
    }

    content.innerHTML = `
      <table class="pmp-table">
        <thead><tr><th>Employee ID</th><th>Name</th><th>Username</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>
          ${state.employees.map(e => `
            <tr>
              <td>${PmpUtils.escapeHtml(e.employeeId)}</td>
              <td>${PmpUtils.escapeHtml(e.name)}</td>
              <td>${PmpUtils.escapeHtml(e.username)}</td>
              <td><span class="pmp-badge">${e.role === 'TeamLead' ? 'Team Lead' : PmpUtils.escapeHtml(e.role)}</span></td>
              <td>${e.active
                ? '<span class="pmp-badge" style="background:var(--status-completed); color:#fff;">Active</span>'
                : '<span class="pmp-badge" style="background:var(--status-closed); color:#fff;">Inactive</span>'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ============================================================
  // 4. Employee Attendance Details modal
  // ============================================================

  function openEmployeeDetail(employeeId) {
    const employee = state.employees.find(e => e.employeeId === employeeId);
    if (!employee) return;

    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal" style="max-width:640px;">
        <div class="pmp-modal-header">
          <h3>${PmpUtils.escapeHtml(employee.name)} <span style="font-size:12px; font-weight:400; color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(employee.employeeId)} &middot; ${employee.role === 'TeamLead' ? 'Team Lead' : PmpUtils.escapeHtml(employee.role)}</span></h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <div id="pmp-hr-detail-today"></div>
        <div style="display:flex; gap:8px; margin:16px 0 10px; flex-wrap:wrap;">
          <button class="pmp-btn pmp-btn-primary" data-hr-range="last15">Last 15 Days</button>
          <button class="pmp-btn" data-hr-range="thisMonth">This Month</button>
          <button class="pmp-btn" data-hr-range="prevMonth">Previous Month</button>
          <input type="date" id="pmp-hr-detail-from" style="margin-left:8px;">
          <input type="date" id="pmp-hr-detail-to">
          <button class="pmp-btn" id="pmp-hr-detail-custom">Custom Range</button>
        </div>
        <div id="pmp-hr-detail-history" style="max-height:320px; overflow-y:auto;"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Today's snapshot
    const today = PmpUtils.toLocalDateStr(new Date());
    const status = statusForEmployeeOnDate(employeeId, today);
    const timing = dayTimingFor(employeeId, today);
    overlay.querySelector('#pmp-hr-detail-today').innerHTML = `
      <div class="pmp-card">
        <div style="font-weight:600; margin-bottom:6px;">Today's Attendance</div>
        <div class="pmp-assignment-meta">
          <span>Status: ${statusBadge(status)}</span>
          <span>Check In: ${timing.firstIn ? formatTime(timing.firstIn) : '—'}</span>
          <span>Check Out: ${(timing.lastOut && status !== 'Working') ? formatTime(timing.lastOut) : '—'}</span>
          <span>Total: <strong>${formatDuration(timing.totalMinutes)}</strong></span>
        </div>
      </div>
    `;

    function renderHistory(fromStr, toStr) {
      const rows = [];
      let d = new Date(fromStr + 'T00:00:00');
      const end = new Date(toStr + 'T00:00:00');
      const now = PmpUtils.toLocalDateStr(new Date());
      while (d <= end) {
        const dateStr = PmpUtils.toLocalDateStr(d);
        if (dateStr <= now) {
          const st = statusForEmployeeOnDate(employeeId, dateStr);
          const t = dayTimingFor(employeeId, dateStr);
          rows.push({ date: dateStr, day: d.toLocaleDateString('en-IN', { weekday: 'short' }), status: st, timing: t });
        }
        d.setDate(d.getDate() + 1);
      }
      rows.reverse();

      overlay.querySelector('#pmp-hr-detail-history').innerHTML = rows.length === 0
        ? `<div class="pmp-empty">No days in this range.</div>`
        : `
          <table class="pmp-table">
            <thead><tr><th>Date</th><th>Day</th><th>Status</th><th>First In</th><th>Last Out</th><th>Working Hours</th></tr></thead>
            <tbody>
              ${rows.map(r => `
                <tr>
                  <td>${r.date}</td>
                  <td>${r.day}</td>
                  <td>${statusBadge(r.status)}</td>
                  <td>${r.timing.firstIn ? formatTime(r.timing.firstIn) : '—'}</td>
                  <td>${r.timing.lastOut ? formatTime(r.timing.lastOut) : '—'}</td>
                  <td>${r.timing.totalMinutes > 0 ? formatDuration(r.timing.totalMinutes) : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
    }

    overlay.querySelectorAll('[data-hr-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('[data-hr-range]').forEach(b => b.classList.remove('pmp-btn-primary'));
        btn.classList.add('pmp-btn-primary');
        const now = new Date();
        let from, to;
        if (btn.dataset.hrRange === 'last15') {
          const f = new Date(); f.setDate(f.getDate() - 14);
          from = PmpUtils.toLocalDateStr(f); to = PmpUtils.toLocalDateStr(now);
        } else if (btn.dataset.hrRange === 'thisMonth') {
          from = PmpUtils.toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
          to = PmpUtils.toLocalDateStr(now);
        } else if (btn.dataset.hrRange === 'prevMonth') {
          from = PmpUtils.toLocalDateStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
          to = PmpUtils.toLocalDateStr(new Date(now.getFullYear(), now.getMonth(), 0));
        }
        renderHistory(from, to);
      });
    });

    overlay.querySelector('#pmp-hr-detail-custom').addEventListener('click', () => {
      overlay.querySelectorAll('[data-hr-range]').forEach(b => b.classList.remove('pmp-btn-primary'));
      const from = overlay.querySelector('#pmp-hr-detail-from').value;
      const to = overlay.querySelector('#pmp-hr-detail-to').value;
      if (!from || !to) { PmpUtils.toast('Pick both a start and end date.', 'error'); return; }
      renderHistory(from, to);
    });

    // Default view on open
    const f = new Date(); f.setDate(f.getDate() - 14);
    renderHistory(PmpUtils.toLocalDateStr(f), today);
  }

  // ============================================================
  // Shared helpers
  // ============================================================

  function employeeName(employeeId) {
    const e = state.employees.find(x => x.employeeId === employeeId);
    return e ? e.name : employeeId;
  }

  function joinAssignmentInfo(assignmentId) {
    const assignment = state.assignments.find(a => a.AssignmentID === assignmentId);
    const task = assignment ? state.tasks.find(t => t.TaskID === assignment.TaskID) : null;
    const project = task ? state.projects.find(p => p.ProjectID === task.ProjectID) : null;
    const client = project ? state.clients.find(c => c.ClientID === project.ClientID) : null;
    return {
      taskName: task ? task.TaskName : '',
      projectName: project ? project.ProjectName : '',
      clientName: client ? client.ClientName : ''
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

  function teardown() {
    if (state.refreshHandle) { clearInterval(state.refreshHandle); state.refreshHandle = null; }
  }

  return { init, refresh: refreshAll, teardown };
})();