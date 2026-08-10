/**
 * PMP — Module: Timesheet
 *
 * Two modes, one module:
 *
 * - 'view' (Team Lead / Manager, default): read-only report across all
 *   employees for a chosen date. Computed entirely from ActivityLog
 *   (Paused/Resumed/StatusChange events) — nothing is saved anywhere,
 *   nothing is editable. This is what Team Lead/Manager sees.
 *
 * - 'edit' (Employee): the employee's own timesheet for a chosen date,
 *   which THEY review and submit — not the Team Lead. If they haven't
 *   submitted anything for that date yet, it starts from the same
 *   computed ActivityLog suggestions as a starting point; they can edit
 *   times, delete a suggested entry, add a free-text manual entry (for
 *   things like meetings that aren't tied to any assigned Task), and Save.
 *   Saved entries live in their own Timesheet sheet — the ActivityLog
 *   itself is never modified, ever, by either mode.
 *
 * Init signature: PmpTimesheet.init(containerId, opts)
 *   opts.mode: 'view' | 'edit' (default 'view')
 *   opts.employeeId: required for 'edit' mode — whose timesheet this is
 */

const PmpTimesheet = (function () {

  let state = {
    mode: 'view',
    employeeId: null,
    activityLog: [],
    assignments: [],
    tasks: [],
    projects: [],
    clients: [],
    employees: [],
    savedEntries: [],   // 'edit' mode only — what's already been submitted for the selected date
    editRows: [],       // 'edit' mode only — the live editable rows currently on screen
    containerId: null,
    filters: {
      date: PmpUtils.toLocalDateStr(new Date()),
      employeeId: 'All', // 'view' mode only
      team: 'All' // 'view' mode only — 'All' | 'GD' (projects whose ID starts with GDP-)
    }
  };

  async function init(containerId, opts) {
    state.containerId = containerId;
    state.mode = (opts && opts.mode) || 'view';
    state.employeeId = (opts && opts.employeeId) || null;
    renderShell();
    await refresh();
  }

  async function refresh() {
    if (state.mode === 'edit') {
      await refreshEdit();
    } else {
      await refreshView();
    }
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  // ============================================================
  // Shared shell
  // ============================================================

  function renderShell() {
    // Employees can only edit today or the previous 10 days — no future
    // dates, and nothing older than the 10-day window. Team Lead/Manager
    // 'view' mode is unrestricted since it's read-only reporting, not editing.
    const dateRange = editableDateRange();
    const dateAttrs = state.mode === 'edit' ? `min="${dateRange.min}" max="${dateRange.max}"` : '';

    container().innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
        <input type="date" id="pmp-ts-date" value="${state.filters.date}" ${dateAttrs}>
        ${state.mode === 'view' ? `
          <select id="pmp-ts-employee">
            <option value="All">All employees</option>
          </select>
          <select id="pmp-ts-team-filter">
            <option value="All">All teams</option>
            <option value="GD">GD Team</option>
          </select>
        ` : ''}
        ${state.mode === 'edit' ? `
          <div id="pmp-ts-total" style="font-size:13px; color:var(--pmp-text-muted); font-weight:600;"></div>
          <div style="flex:1;"></div>
          <button class="pmp-btn" id="pmp-ts-mark-leave-btn">Mark Day as Leave</button>
          <button class="pmp-btn" id="pmp-ts-add-lunch-btn">+ Add Lunch</button>
          <button class="pmp-btn" id="pmp-ts-add-row-btn">+ Add Manual Entry</button>
          <button class="pmp-btn pmp-btn-primary" id="pmp-ts-save-btn">Save Day</button>
        ` : ''}
      </div>
      <div id="pmp-ts-content"></div>
    `;

    document.getElementById('pmp-ts-date').addEventListener('change', async e => {
      state.filters.date = e.target.value;
      await refresh();
    });

    if (state.mode === 'view') {
      document.getElementById('pmp-ts-employee').addEventListener('change', e => {
        state.filters.employeeId = e.target.value;
        renderView();
      });
      document.getElementById('pmp-ts-team-filter').addEventListener('change', e => {
        state.filters.team = e.target.value;
        renderView();
      });
    } else {
      document.getElementById('pmp-ts-mark-leave-btn').addEventListener('click', markDayAsLeave);
      document.getElementById('pmp-ts-add-lunch-btn').addEventListener('click', addLunchRow);
      document.getElementById('pmp-ts-add-row-btn').addEventListener('click', addManualRow);
      document.getElementById('pmp-ts-save-btn').addEventListener('click', saveTimesheet);
    }
  }

  // { min, max } as "YYYY-MM-DD" — today is the latest editable date
  // (can't fill in a timesheet for a day that hasn't happened), and 10
  // days ago is the earliest (old entries lock out after that).
  function editableDateRange() {
    const today = new Date();
    const max = PmpUtils.toLocalDateStr(today);
    const tenDaysAgo = new Date(today);
    tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
    const min = PmpUtils.toLocalDateStr(tenDaysAgo);
    return { min, max };
  }

  // ============================================================
  // 'view' mode — Team Lead / Manager, read-only, all employees
  // ============================================================

  async function refreshView() {
    const [logRes, assignmentsRes, tasksRes, projectsRes, clientsRes, employeesRes] = await Promise.all([
      PmpApi.getActivityLog(),
      PmpApi.getAssignments(),
      PmpApi.getTasks(),
      PmpApi.getProjects(),
      PmpApi.getClients(),
      PmpApi.getEmployees()
    ]);

    if (logRes.success) state.activityLog = logRes.log;
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;
    if (employeesRes.success) state.employees = employeesRes.employees;

    renderView();
  }

  function renderView() {
    const empSelect = document.getElementById('pmp-ts-employee');
    if (empSelect && empSelect.children.length <= 1 && state.employees.length > 0) {
      empSelect.innerHTML = `
        <option value="All">All employees</option>
        ${state.employees.map(e => `<option value="${e.employeeId}">${PmpUtils.escapeHtml(e.name)}</option>`).join('')}
      `;
      empSelect.value = state.filters.employeeId;
    }

    const content = document.getElementById('pmp-ts-content');
    if (!content) return;

    const intervals = PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => PmpUtils.toLocalDateStr(iv.start) === state.filters.date)
      .filter(iv => state.filters.employeeId === 'All' || iv.EmployeeID === state.filters.employeeId)
      .filter(iv => state.filters.team === 'All' || isGdTeamInterval(iv));

    if (intervals.length === 0) {
      content.innerHTML = `<div class="pmp-empty">${state.filters.team === 'GD' ? 'No GD Team work logged for this date.' : 'No work logged for this date.'}</div>`;
      return;
    }

    const byEmployee = {};
    intervals.forEach(iv => {
      if (!byEmployee[iv.EmployeeID]) byEmployee[iv.EmployeeID] = [];
      byEmployee[iv.EmployeeID].push(iv);
    });

    content.innerHTML = Object.keys(byEmployee)
      .sort((a, b) => employeeName(a).localeCompare(employeeName(b)))
      .map(empId => viewEmployeeBlock(empId, byEmployee[empId]))
      .join('');
  }

  function viewEmployeeBlock(employeeId, intervals) {
    const sorted = [...intervals].sort((a, b) => new Date(a.start) - new Date(b.start));
    const totalMinutes = sorted.reduce((sum, iv) => sum + minutesBetween(iv.start, iv.end), 0);

    const rows = sorted.map(iv => {
      const joined = joinTaskInfo(iv.AssignmentID);
      const mins = minutesBetween(iv.start, iv.end);
      return `
        <tr>
          <td>${formatTime(iv.start)} – ${formatTime(iv.end)}</td>
          <td>${joined.clientName ? PmpUtils.escapeHtml(joined.clientName) : '—'}</td>
          <td>${joined.projectName ? PmpUtils.escapeHtml(joined.projectName) : '—'}</td>
          <td>${joined.taskName ? PmpUtils.escapeHtml(joined.taskName) : '<span style="color:var(--pmp-text-muted);">Unknown task</span>'}</td>
          <td>${joined.dimension ? PmpUtils.escapeHtml(joined.dimension) : '—'}</td>
          <td>${formatDuration(mins)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="pmp-card" style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div class="pmp-assignment-title">${PmpUtils.escapeHtml(employeeName(employeeId))}</div>
          <span class="pmp-badge">${formatDuration(totalMinutes)} total</span>
        </div>
        <table class="pmp-table" style="margin-top:10px;">
          <thead><tr><th>Time</th><th>Client</th><th>Project</th><th>Task</th><th>Dimension</th><th>Duration</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // "GD Team" = anyone with work logged against a project whose ProjectID
  // starts with "GDP-" (that prefix convention, not a real team/department
  // field — PMP deliberately has no fixed-team concept on Employees).
  function isGdTeamInterval(iv) {
    const assignment = state.assignments.find(a => a.AssignmentID === iv.AssignmentID);
    const task = assignment ? state.tasks.find(t => t.TaskID === assignment.TaskID) : null;
    const projectId = task ? task.ProjectID : (assignment ? assignment.ProjectID : '');
    return String(projectId || '').toUpperCase().indexOf('GDP-') === 0;
  }

  function employeeName(employeeId) {
    const employee = state.employees.find(e => e.employeeId === employeeId);
    return employee ? employee.name : employeeId;
  }

  // ============================================================
  // 'edit' mode — Employee's own timesheet, editable, saveable
  // ============================================================

  async function refreshEdit() {
    const [logRes, savedRes, assignmentsRes, tasksRes, projectsRes, clientsRes] = await Promise.all([
      PmpApi.getActivityLog(),
      PmpApi.getTimesheetEntries({ employeeId: state.employeeId, date: state.filters.date }),
      PmpApi.getAssignments(),
      PmpApi.getTasks(),
      PmpApi.getProjects(),
      PmpApi.getClients()
    ]);

    if (logRes.success) state.activityLog = logRes.log;
    if (savedRes.success) state.savedEntries = savedRes.entries;
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;

    // Submitted rows show exactly what was saved (including the
    // Client/Project/Dimension snapshot from when it was saved), so
    // edits aren't silently overwritten and renamed Tasks/Projects don't
    // retroactively change what a past submission says.
    const savedRows = state.savedEntries.map(e => ({
      localId: e.EntryID,
      assignmentId: e.AssignmentID || '',
      clientName: e.ClientName || '',
      projectName: e.ProjectName || '',
      taskName: e.TaskName || '',
      dimension: e.Dimension || '',
      startTime: toTimeInputValue(e.StartTime),
      endTime: toTimeInputValue(e.EndTime),
      notes: e.Notes || '',
      source: e.Source || 'Manual',
      locked: !!e.AssignmentID, // task-linked entries keep their task/project/client read-only
      submitted: true
    }));

    // Any computed ActivityLog interval NOT already covered by a saved
    // entry still shows as a fresh suggestion — submitting one entry for
    // the day used to hide every other still-unsubmitted interval; now
    // both submitted and pending rows show together.
    const intervals = PmpUtils.computeWorkIntervals(state.activityLog)
      .filter(iv => iv.EmployeeID === state.employeeId)
      .filter(iv => PmpUtils.toLocalDateStr(iv.start) === state.filters.date)
      .sort((a, b) => new Date(a.start) - new Date(b.start));

    const suggestedRows = intervals
      .filter(iv => !isCoveredBySavedEntry(iv))
      .map((iv, idx) => {
        const joined = joinTaskInfo(iv.AssignmentID);
        return {
          localId: 'suggested-' + idx + '-' + iv.AssignmentID,
          assignmentId: iv.AssignmentID,
          clientName: joined.clientName,
          projectName: joined.projectName,
          taskName: joined.taskName,
          dimension: joined.dimension,
          startTime: toTimeInputValue(iv.start),
          endTime: toTimeInputValue(iv.end),
          notes: '',
          source: 'Suggested',
          locked: true,
          submitted: false
        };
      });

    // Lunch Break (1:00-1:45pm) and Tea Break (4:00-4:15pm) are fixed
    // company schedule slots, not optional add-ons — nobody works during
    // them. They show up by default AND are auto-saved immediately (no
    // manual Submit needed), since they're a fixed policy fact for every
    // day, not something that needs day-to-day confirmation. Still fully
    // editable (times can be corrected, e.g. a short day) and removable
    // if a particular day's actual break differed or didn't happen.
    const existingRows = [...savedRows, ...suggestedRows];
    const missingFixedBreaks = PMP_FIXED_BREAKS
      .filter(fb => !existingRows.some(r => r.taskName.toLowerCase() === fb.taskName.toLowerCase()));

    const fixedBreakRows = [];
    for (const fb of missingFixedBreaks) {
      const upsertRes = await PmpApi.upsertTimesheetEntry({
        employeeId: state.employeeId,
        date: state.filters.date,
        assignmentId: '',
        clientName: '',
        projectName: '',
        taskName: fb.taskName,
        dimension: '',
        startTime: state.filters.date + ' ' + fb.startTime,
        endTime: state.filters.date + ' ' + fb.endTime,
        notes: '',
        source: 'Manual'
      });
      fixedBreakRows.push({
        localId: upsertRes.success ? upsertRes.entryId : ('break-' + fb.taskName.replace(/\s+/g, '') + '-' + state.filters.date),
        assignmentId: '',
        clientName: '',
        projectName: '',
        taskName: fb.taskName,
        dimension: '',
        startTime: fb.startTime,
        endTime: fb.endTime,
        notes: '',
        source: 'Manual',
        locked: true, // fixed schedule slot — task name itself isn't editable, but time/notes still are
        submitted: !!upsertRes.success
      });
    }

    state.editRows = [...savedRows, ...suggestedRows, ...fixedBreakRows].sort((a, b) => a.startTime.localeCompare(b.startTime));

    renderEdit();
  }

  // Fixed company schedule breaks — see the Office Timing spec: Session 1
  // (9:30-1:00), Lunch (1:00-1:45), Session 2 (1:45-4:00), Tea (4:00-4:15),
  // Session 3 (4:15-7:30).
  const PMP_FIXED_BREAKS = [
    { taskName: 'Lunch Break', startTime: '13:00', endTime: '13:45' },
    { taskName: 'Tea Break', startTime: '16:00', endTime: '16:15' }
  ];

  // True if some saved entry for this task overlaps this computed
  // interval's time range — overlap, not exact equality, so a minor time
  // correction made during Submit still counts as covering the interval
  // it came from, rather than that interval reappearing as a duplicate
  // suggestion right next to the entry it was already submitted as.
  function isCoveredBySavedEntry(iv) {
    const ivStart = new Date(iv.start).getTime();
    const ivEnd = new Date(iv.end).getTime();
    return state.savedEntries.some(e => {
      if (e.AssignmentID !== iv.AssignmentID) return false;
      const entryStart = new Date(e.StartTime).getTime();
      const entryEnd = new Date(e.EndTime).getTime();
      if (isNaN(entryStart) || isNaN(entryEnd)) return false;
      return entryStart <= ivEnd && entryEnd >= ivStart;
    });
  }

  // Task -> Project -> Client join, used to fill in Client/Project/Dimension
  // for a suggested entry before it's ever saved.
  function joinTaskInfo(assignmentId) {
    const assignment = state.assignments.find(a => a.AssignmentID === assignmentId);
    const task = assignment ? state.tasks.find(t => t.TaskID === assignment.TaskID) : null;
    const project = task ? state.projects.find(p => p.ProjectID === task.ProjectID) : null;
    const client = project ? state.clients.find(c => c.ClientID === project.ClientID) : null;
    return {
      clientName: client ? client.ClientName : '',
      projectName: project ? project.ProjectName : '',
      taskName: task ? task.TaskName : '',
      dimension: task ? task.Dimension : ''
    };
  }

  function renderEdit() {
    const content = document.getElementById('pmp-ts-content');
    if (!content) return;

    const totalEl = document.getElementById('pmp-ts-total');
    if (totalEl) {
      const totalMins = state.editRows.reduce((sum, r) => {
        if (!r.startTime || !r.endTime) return sum;
        return sum + minutesBetweenTimeStrings(r.startTime, r.endTime);
      }, 0);
      totalEl.textContent = totalMins > 0 ? `Total: ${formatDuration(totalMins)}` : '';
    }

    if (state.editRows.length === 0) {
      content.innerHTML = `<div class="pmp-empty">Nothing logged for this date yet. Use "+ Add Manual Entry" to add something.</div>`;
      return;
    }

    content.innerHTML = `<div class="pmp-ts-row-list">${state.editRows.map(rowHtml).join('')}</div>`;

    content.querySelectorAll('[data-delete-row]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.editRows = state.editRows.filter(r => r.localId !== btn.dataset.deleteRow);
        renderEdit();
      });
    });
    content.querySelectorAll('[data-submit-row]').forEach(btn => {
      btn.addEventListener('click', () => submitRow(btn.dataset.submitRow));
    });
    content.querySelectorAll('input[data-row]').forEach(input => {
      input.addEventListener('change', () => {
        const row = state.editRows.find(r => r.localId === input.dataset.row);
        if (row) { row[input.dataset.field] = input.value; renderEdit(); }
      });
    });
  }

  // Same-day duration only (breaks/tasks never span midnight in this UI).
  function minutesBetweenTimeStrings(start, end) {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    if (isNaN(sh) || isNaN(eh)) return 0;
    return Math.max(0, (eh * 60 + em) - (sh * 60 + sm));
  }

  const ROW_ICONS = {
    Suggested: '\u{1F5C2}\uFE0F', // computed from ActivityLog
    Manual: '\u270E',
    Leave: '\u{1F3D6}\uFE0F'
  };
  const FIXED_BREAK_NAMES = ['lunch break', 'tea break'];

  function rowIcon(row) {
    if (FIXED_BREAK_NAMES.indexOf((row.taskName || '').toLowerCase()) !== -1) return '\u2615';
    return ROW_ICONS[row.source] || '\u2022';
  }

  function rowAccentColor(row) {
    if (row.taskName === 'Leave') return 'var(--status-delayed)';
    if (FIXED_BREAK_NAMES.indexOf((row.taskName || '').toLowerCase()) !== -1) return 'var(--status-review)';
    if (row.source === 'Suggested') return 'var(--status-working)';
    return 'var(--pmp-border, #ddd)';
  }

  function rowHtml(row) {
    const isFixedBreak = FIXED_BREAK_NAMES.indexOf((row.taskName || '').toLowerCase()) !== -1;
    const mins = (row.startTime && row.endTime) ? minutesBetweenTimeStrings(row.startTime, row.endTime) : 0;

    const taskField = row.locked
      ? `<div class="pmp-assignment-title" style="font-size:14px;">${PmpUtils.escapeHtml(row.taskName || 'Untitled task')}</div>`
      : `<input type="text" data-field="taskName" data-row="${row.localId}" value="${PmpUtils.escapeHtml(row.taskName)}" placeholder="e.g. Team meeting" style="font-weight:600; font-size:14px; border:none; background:transparent; padding:2px 0; width:100%;">`;

    const metaBits = [];
    if (row.clientName) metaBits.push(`<span>${PmpUtils.escapeHtml(row.clientName)}</span>`);
    if (row.projectName) metaBits.push(`<span>${PmpUtils.escapeHtml(row.projectName)}</span>`);

    return `
      <div class="pmp-card pmp-ts-row" data-row-id="${row.localId}" style="border-left:3px solid ${rowAccentColor(row)}; padding:12px 14px; margin-bottom:10px;">
        <div style="display:flex; align-items:flex-start; gap:10px;">
          <div style="font-size:16px; line-height:1.4; flex-shrink:0;">${rowIcon(row)}</div>
          <div style="flex:1; min-width:220px;">
            ${taskField}
            <div class="pmp-assignment-meta" style="margin-top:2px; align-items:center; font-size:11px;">
              ${metaBits.join('')}
              ${isFixedBreak ? '' : `<input type="text" data-field="dimension" data-row="${row.localId}" value="${PmpUtils.escapeHtml(row.dimension)}" placeholder="Dimension" style="border:1px solid var(--pmp-border, #ddd); border-radius:4px; padding:2px 6px; font-size:11px; width:110px;">`}
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <input type="time" data-field="startTime" data-row="${row.localId}" value="${row.startTime}" style="font-size:12px;">
            <span style="color:var(--pmp-text-muted); font-size:12px;">–</span>
            <input type="time" data-field="endTime" data-row="${row.localId}" value="${row.endTime}" style="font-size:12px;">
            ${mins > 0 ? `<span class="pmp-badge" style="margin-left:4px;">${formatDuration(mins)}</span>` : ''}
          </div>
        </div>
        <div style="margin-top:8px; padding-left:26px;">
          <input type="text" data-field="notes" data-row="${row.localId}" value="${PmpUtils.escapeHtml(row.notes)}" placeholder="Add notes..." style="width:100%; box-sizing:border-box; font-size:12px;">
        </div>
        <div style="display:flex; justify-content:flex-end; align-items:center; gap:8px; margin-top:8px; padding-left:26px;">
          ${row.submitted ? '<span class="pmp-badge" style="background:var(--status-completed); color:#fff;">Submitted</span>' : ''}
          <button class="pmp-btn ${row.submitted ? '' : 'pmp-btn-primary'}" data-submit-row="${row.localId}" style="padding:4px 12px; font-size:12px;">${row.submitted ? 'Update' : 'Submit'}</button>
          <button class="pmp-btn pmp-btn-danger" data-delete-row="${row.localId}" style="padding:4px 12px; font-size:12px;">Remove</button>
        </div>
      </div>
    `;
  }

  function addLunchRow() {
    state.editRows.push({
      localId: 'manual-' + Date.now(),
      assignmentId: '',
      clientName: '',
      projectName: '',
      taskName: 'Lunch Break',
      dimension: '',
      startTime: '13:00',
      endTime: '13:45',
      notes: '',
      source: 'Manual',
      locked: false,
      submitted: false
    });
    renderEdit();
  }

  // Replaces the whole day's rows with a single fixed Leave entry spanning
  // the full working day. Still just sits in state.editRows until the
  // employee clicks Submit or Save Whole Day — same as any other row,
  // nothing is persisted just by clicking this. Locked so the "Leave"
  // label itself can't be accidentally retyped into something else — the
  // time range and Notes stay fully editable either way (see rowHtml,
  // those two fields are never gated by `locked`).
  function markDayAsLeave() {
    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>Mark Day as Leave</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-ts-leave-form">
          <p style="font-size:13px; color:var(--pmp-text-muted); margin-top:0;">This clears all entries for this date and replaces them with a single Leave entry.</p>
          <div class="pmp-form-grid">
            <div class="pmp-form-row">
              <label>Start</label>
              <input type="time" name="startTime" value="09:30" required>
            </div>
            <div class="pmp-form-row">
              <label>End</label>
              <input type="time" name="endTime" value="19:30" required>
            </div>
          </div>
          <div class="pmp-form-row">
            <label>Notes (reason, optional)</label>
            <textarea name="notes" rows="3" placeholder="e.g. Sick leave, Personal leave"></textarea>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">Mark as Leave</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-ts-leave-form').addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      state.editRows = [{
        localId: 'leave-' + Date.now(),
        assignmentId: '',
        clientName: '',
        projectName: '',
        taskName: 'Leave',
        dimension: '',
        startTime: fd.get('startTime'),
        endTime: fd.get('endTime'),
        notes: fd.get('notes') || '',
        source: 'Leave',
        locked: true,
        submitted: false
      }];
      close();
      renderEdit();
    });
  }

  function addManualRow() {
    state.editRows.push({
      localId: 'manual-' + Date.now(),
      assignmentId: '',
      clientName: '',
      projectName: '',
      taskName: '',
      dimension: '',
      startTime: '',
      endTime: '',
      notes: '',
      source: 'Manual',
      locked: false,
      submitted: false
    });
    renderEdit();
  }

  function collectEditRowsFromDom() {
    const content = document.getElementById('pmp-ts-content');
    content.querySelectorAll('input[data-row]').forEach(input => {
      const row = state.editRows.find(r => r.localId === input.dataset.row);
      if (row) row[input.dataset.field] = input.value;
    });
  }

  // Saves just this one row right now, independent of the others — the
  // per-row "Submit" button. A row that's already been submitted before
  // (real "TSE-..." localId) gets updated in place rather than duplicated;
  // a never-submitted row (still "suggested-..." or "manual-...") gets a
  // real EntryID assigned by the backend, which becomes its localId going
  // forward so re-submitting the same row again updates it, not adds a copy.
  async function submitRow(localId) {
    collectEditRowsFromDom(); // pull in this row's (and everyone else's) current input values first

    const row = state.editRows.find(r => r.localId === localId);
    if (!row) return;

    if (!row.startTime || !row.endTime) {
      PmpUtils.toast('This entry needs a start and end time', 'error');
      return;
    }

    const isAlreadySaved = row.localId.indexOf('TSE-') === 0;

    const res = await PmpApi.upsertTimesheetEntry({
      employeeId: state.employeeId,
      date: state.filters.date,
      entryId: isAlreadySaved ? row.localId : undefined,
      assignmentId: row.assignmentId || '',
      clientName: row.clientName || '',
      projectName: row.projectName || '',
      taskName: row.taskName || '',
      dimension: row.dimension || '',
      startTime: state.filters.date + ' ' + row.startTime,
      endTime: state.filters.date + ' ' + row.endTime,
      notes: row.notes || '',
      source: row.source || 'Manual'
    });

    if (res.success) {
      row.localId = res.entryId; // so the next Submit on this row updates it, not duplicates it
      row.submitted = true;
      PmpUtils.toast('Entry submitted', 'success');
      renderEdit();
    } else {
      PmpUtils.toast(res.error || 'Could not submit entry', 'error');
    }
  }

  async function saveTimesheet() {
    collectEditRowsFromDom();

    const incomplete = state.editRows.some(r => !r.startTime || !r.endTime);
    if (incomplete) {
      PmpUtils.toast('Every entry needs a start and end time', 'error');
      return;
    }

    const saveBtn = document.getElementById('pmp-ts-save-btn');
    saveBtn.disabled = true;

    const entries = state.editRows.map(r => ({
      assignmentId: r.assignmentId || '',
      clientName: r.clientName || '',
      projectName: r.projectName || '',
      taskName: r.taskName || '',
      dimension: r.dimension || '',
      startTime: state.filters.date + ' ' + r.startTime,
      endTime: state.filters.date + ' ' + r.endTime,
      notes: r.notes || '',
      source: r.source || 'Manual'
    }));

    const res = await PmpApi.saveTimesheetEntries({
      employeeId: state.employeeId,
      date: state.filters.date,
      entries: entries
    });

    if (res.success) {
      PmpUtils.toast('Timesheet saved', 'success');
      await refreshEdit();
    } else {
      PmpUtils.toast(res.error || 'Could not save timesheet', 'error');
    }
    saveBtn.disabled = false;
  }

  // ============================================================
  // Shared formatting helpers
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

  // Converts a stored timestamp (ISO string, or "YYYY-MM-DD HH:MM" as saved
  // by this module) into the "HH:MM" 24-hour format <input type="time">
  // requires — using LOCAL hours/minutes, not UTC, so a saved entry redisplays
  // at the same wall-clock time it was entered at.
  function toTimeInputValue(value) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  return { init, refresh };
})();