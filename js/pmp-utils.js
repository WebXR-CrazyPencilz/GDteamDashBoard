/**
 * PMP — Shared utilities
 */

const PmpUtils = (function () {

  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function daysUntil(dueDate) {
    if (!dueDate) return null;
    const due = new Date(dueDate);
    if (isNaN(due.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    due.setHours(0, 0, 0, 0);
    return Math.round((due - today) / (1000 * 60 * 60 * 24));
  }

  function isDelayed(assignment) {
    if (assignment.Status === 'Completed' || assignment.Status === 'Closed') return false;
    const days = daysUntil(assignment.DueDate);
    return days !== null && days < 0;
  }

  // Deterministic pastel color per ID, same pattern as TimeTrack's per-project color hash
  function colorFromId(id) {
    let hash = 0;
    const str = String(id);
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 65%, 88%)`;
  }

  // Groups flat Assignment rows under their parent Task. One Task can have
  // many Assignments (one per assignee). Returns an array of
  // { task, assignments } sorted by the task's due date.
  // Falls back gracefully if a Task lookup is missing (e.g. legacy rows that
  // haven't been migrated yet) by synthesizing a minimal task shape from the
  // assignment itself, so older data doesn't disappear from the UI.
  function groupAssignmentsByTask(tasks, assignments) {
    const byTaskId = {};
    const taskLookup = {};
    (tasks || []).forEach(t => { taskLookup[t.TaskID] = t; });

    (assignments || []).forEach(a => {
      const taskId = a.TaskID || ('legacy:' + a.AssignmentID);
      if (!byTaskId[taskId]) {
        const task = taskLookup[a.TaskID] || {
          TaskID: taskId,
          ProjectID: a.ProjectID,
          TaskName: a.SubTask,
          Dimension: a.Dimension,
          Priority: a.Priority,
          DueDate: a.DueDate,
          Notes: a.Notes,
          _legacy: true
        };
        byTaskId[taskId] = { task, assignments: [] };
      }
      byTaskId[taskId].assignments.push(a);
    });

    return Object.values(byTaskId).sort((x, y) =>
      new Date(x.task.DueDate || 0) - new Date(y.task.DueDate || 0)
    );
  }

  // Renders a scrollable checkbox list for picking one or more employees,
  // used anywhere a Task needs to be assigned to several people at once.
  function employeeCheckboxList(employees, selectedIds, inputName) {
    const selected = new Set(selectedIds || []);
    return `
      <div class="pmp-checkbox-list" style="max-height:160px; overflow-y:auto; border:1px solid var(--pmp-border, #ddd); border-radius:6px; padding:8px;">
        ${employees.map(e => `
          <label style="display:flex; align-items:center; gap:8px; padding:4px 0; font-size:13px; cursor:pointer;">
            <input type="checkbox" name="${inputName}" value="${e.employeeId}" ${selected.has(e.employeeId) ? 'checked' : ''}>
            ${escapeHtml(e.name)}
          </label>
        `).join('') || '<div style="font-size:12px; color:var(--pmp-text-muted);">No employees available</div>'}
      </div>
    `;
  }

  function toast(message, type) {
    const el = document.createElement('div');
    el.className = 'pmp-toast pmp-toast-' + (type || 'info');
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('pmp-toast-show'));
    setTimeout(() => {
      el.classList.remove('pmp-toast-show');
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getSession() {
    try {
      return JSON.parse(localStorage.getItem(PMP_CONFIG.SESSION_KEY));
    } catch (e) {
      return null;
    }
  }

  function setSession(session) {
    localStorage.setItem(PMP_CONFIG.SESSION_KEY, JSON.stringify(session));
  }

  function clearSession() {
    localStorage.removeItem(PMP_CONFIG.SESSION_KEY);
  }

  return {
    formatDate,
    daysUntil,
    isDelayed,
    colorFromId,
    groupAssignmentsByTask,
    employeeCheckboxList,
    toast,
    escapeHtml,
    getSession,
    setSession,
    clearSession
  };
})();