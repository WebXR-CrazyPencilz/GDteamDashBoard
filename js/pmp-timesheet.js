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
      employeeId: 'All' // 'view' mode only
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
        ` : ''}
        ${state.mode === 'edit' ? `<div style="flex:1;"></div><button class="pmp-btn" id="pmp-ts-add-lunch-btn">+ Add Lunch</button><button class="pmp-btn" id="pmp-ts-add-row-btn">+ Add Manual Entry</button><button class="pmp-btn pmp-btn-primary" id="pmp-ts-save-btn">Save Whole Day</button>` : ''}
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
    } else {
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
      .filter(iv => state.filters.employeeId === 'All' || iv.EmployeeID === state.filters.employeeId);

    if (intervals.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No work logged for this date.</div>`;
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

    state.editRows = [...savedRows, ...suggestedRows].sort((a, b) => a.startTime.localeCompare(b.startTime));

    renderEdit();
  }

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

    if (state.editRows.length === 0) {
      content.innerHTML = `<div class="pmp-empty">Nothing logged for this date yet. Use "+ Add Manual Entry" to add something.</div>`;
      return;
    }

    const rows = state.editRows.map(rowHtml).join('');

    content.innerHTML = `
      <table class="pmp-table">
        <thead><tr><th>Client</th><th>Project</th><th>Task</th><th>Dimension</th><th>Start</th><th>End</th><th>Notes</th><th></th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    content.querySelectorAll('[data-delete-row]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.editRows = state.editRows.filter(r => r.localId !== btn.dataset.deleteRow);
        renderEdit();
      });
    });
    content.querySelectorAll('[data-submit-row]').forEach(btn => {
      btn.addEventListener('click', () => submitRow(btn.dataset.submitRow));
    });
  }

  function rowHtml(row) {
    return `
      <tr data-row-id="${row.localId}">
        <td>${row.locked ? PmpUtils.escapeHtml(row.clientName || '—') : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
        <td>${row.locked ? PmpUtils.escapeHtml(row.projectName || '—') : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
        <td>
          ${row.locked
            ? PmpUtils.escapeHtml(row.taskName || 'Untitled task')
            : `<input type="text" data-field="taskName" data-row="${row.localId}" value="${PmpUtils.escapeHtml(row.taskName)}" placeholder="e.g. Team meeting">`}
        </td>
        <td><input type="text" data-field="dimension" data-row="${row.localId}" value="${PmpUtils.escapeHtml(row.dimension)}" placeholder="e.g. 1080x1920"></td>
        <td><input type="time" data-field="startTime" data-row="${row.localId}" value="${row.startTime}"></td>
        <td><input type="time" data-field="endTime" data-row="${row.localId}" value="${row.endTime}"></td>
        <td><input type="text" data-field="notes" data-row="${row.localId}" value="${PmpUtils.escapeHtml(row.notes)}" placeholder="Optional"></td>
        <td>
          <button class="pmp-btn ${row.submitted ? '' : 'pmp-btn-primary'}" data-submit-row="${row.localId}">${row.submitted ? 'Update' : 'Submit'}</button>
          ${row.submitted ? '<span class="pmp-badge" style="background:var(--status-completed); color:#fff;">Submitted</span>' : ''}
        </td>
        <td><button class="pmp-btn pmp-btn-danger" data-delete-row="${row.localId}">Remove</button></td>
      </tr>
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