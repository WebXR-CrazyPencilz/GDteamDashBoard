/**
 * PMP — Module 2: Employee Portal ("My Assigned Tasks")
 *
 * Employees never create work — they only move their own assignments through
 * the status flow: Start Work -> (Add Notes anytime) -> Complete Task (hands
 * off to Team Lead / Manager for Review). There is no Accept step; the first
 * "Start Work" click auto-transitions Assigned -> Working. Task fields
 * (Sub Task, Dimension, Priority, Due Date, Manager Notes) are shared across
 * everyone assigned to the same Task and are always read-only here — only
 * this employee's own Status and Notes can change.
 *
 * Self-sufficient module: owns its own state, fed by init(). Reads Tasks,
 * Projects, and Clients too, purely to display names instead of raw IDs and
 * to join shared Task fields onto each of this employee's Assignment rows.
 */

const PmpEmployee = (function () {

  let state = {
    employeeId: null,
    assignments: [],
    tasks: [],
    projects: [],
    clients: [],
    containerId: null,
    filter: 'active' // 'active' | 'all'
  };

  async function init(containerId, employeeId) {
    state.containerId = containerId;
    state.employeeId = employeeId;
    renderShell();
    await refresh();
  }

  async function refresh() {
    const [assignmentsRes, tasksRes, projectsRes, clientsRes] = await Promise.all([
      PmpApi.getMyAssignments(state.employeeId),
      PmpApi.getTasks(),
      PmpApi.getProjects(),
      PmpApi.getClients()
    ]);

    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;

    render();
  }

  // Joins an Assignment onto its parent Task's shared fields. Falls back to
  // the assignment's own flat fields if no Task match is found, so legacy
  // (pre-migration) rows keep rendering correctly.
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

  function container() {
    return document.getElementById(state.containerId);
  }

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="margin:0;">My Assigned Tasks</h3>
        <div class="pmp-filters" style="margin:0;">
          <select id="pmp-emp-filter">
            <option value="active">Active tasks</option>
            <option value="all">All tasks</option>
          </select>
        </div>
      </div>
      <div id="pmp-emp-task-content"></div>
    `;

    document.getElementById('pmp-emp-filter').addEventListener('change', e => {
      state.filter = e.target.value;
      render();
    });
  }

  function render() {
    const content = document.getElementById('pmp-emp-task-content');
    if (!content) return;

    const joined = state.assignments.map(withTask);

    const visible = state.filter === 'active'
      ? joined.filter(a => a.Status !== 'Completed' && a.Status !== 'Closed')
      : joined;

    if (visible.length === 0) {
      content.innerHTML = `<div class="pmp-empty">${state.filter === 'active' ? 'No active tasks. Nice and clear!' : 'No tasks assigned yet.'}</div>`;
      return;
    }

    // Sort: overdue first, then by due date
    const sorted = [...visible].sort((a, b) => {
      const aDelayed = PmpUtils.isDelayed(a) ? 0 : 1;
      const bDelayed = PmpUtils.isDelayed(b) ? 0 : 1;
      if (aDelayed !== bDelayed) return aDelayed - bDelayed;
      return new Date(a.DueDate || 0) - new Date(b.DueDate || 0);
    });

    content.innerHTML = `<div class="pmp-card-grid">${sorted.map(taskCard).join('')}</div>`;

    content.querySelectorAll('[data-start]').forEach(btn => {
      btn.addEventListener('click', () => transitionStatus(btn.dataset.start, 'Working'));
    });
    content.querySelectorAll('[data-complete]').forEach(btn => {
      btn.addEventListener('click', () => transitionStatus(btn.dataset.complete, 'Review'));
    });
    content.querySelectorAll('[data-add-notes]').forEach(btn => {
      btn.addEventListener('click', () => openNotesModal(btn.dataset.addNotes));
    });
  }

  function taskCard(assignment) {
    const project = state.projects.find(p => p.ProjectID === assignment.ProjectID);
    const client = project ? state.clients.find(c => c.ClientID === project.ClientID) : null;
    const delayed = PmpUtils.isDelayed(assignment);
    const color = PmpUtils.colorFromId(assignment.ProjectID);

    return `
      <div class="pmp-card pmp-assignment-card ${delayed ? 'is-delayed' : ''}" data-assignment-card="${assignment.AssignmentID}" style="border-left-color:${delayed ? 'var(--status-delayed)' : color};">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(assignment.SubTask)}</div>
        <div class="pmp-assignment-meta">
          <span>${PmpUtils.escapeHtml(project ? project.ProjectName : assignment.ProjectID)}</span>
          ${client ? `<span>${PmpUtils.escapeHtml(client.ClientName)}</span>` : ''}
          ${assignment.Dimension ? `<span>${PmpUtils.escapeHtml(assignment.Dimension)}</span>` : ''}
        </div>
        <div class="pmp-assignment-meta">
          <span class="pmp-badge pmp-badge-priority-${assignment.Priority}">${PmpUtils.escapeHtml(assignment.Priority)}</span>
          <span>Due ${PmpUtils.formatDate(assignment.DueDate)} ${delayed ? '<span class="pmp-badge pmp-badge-delayed">Delayed</span>' : ''}</span>
          <span class="pmp-badge" style="background:${PMP_CONFIG.STATUS_COLORS[assignment.Status] || '#eee'};">${PmpUtils.escapeHtml(assignment.Status)}</span>
        </div>
        ${assignment.Notes ? `<div style="font-size:12px;"><strong>Manager notes:</strong> <span style="color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(assignment.Notes)}</span></div>` : ''}
        ${assignment.EmployeeNotes ? `<div style="font-size:12px; color:var(--pmp-text-muted); background:#FBF8F0; padding:8px; border-radius:6px;"><strong>Your notes:</strong> ${PmpUtils.escapeHtml(assignment.EmployeeNotes)}</div>` : ''}
        <div class="pmp-assignment-actions">
          ${actionButtons(assignment)}
        </div>
      </div>
    `;
  }

  function actionButtons(assignment) {
    if (assignment.Status === 'Assigned') {
      return `<button class="pmp-btn pmp-btn-primary" data-start="${assignment.AssignmentID}">Start Work</button>`;
    }
    if (assignment.Status === 'Working') {
      return `
        <button class="pmp-btn" data-add-notes="${assignment.AssignmentID}">Add Notes</button>
        <button class="pmp-btn pmp-btn-primary" data-complete="${assignment.AssignmentID}">Complete Task</button>
      `;
    }
    if (assignment.Status === 'Review') {
      return `<span style="font-size:12px; color:var(--pmp-text-muted);">Waiting for manager review</span>`;
    }
    return ''; // Completed / Closed — no actions
  }

  async function transitionStatus(assignmentId, toStatus) {
    const res = await PmpApi.updateAssignmentStatus({
      assignmentId,
      status: toStatus,
      employeeId: state.employeeId
    });

    if (res.success) {
      PmpUtils.toast(`Moved to ${toStatus}`, 'success');
      await refresh();
    } else {
      PmpUtils.toast(res.error || 'Could not update status', 'error');
    }
  }

  function openNotesModal(assignmentId) {
    const assignment = state.assignments.find(a => a.AssignmentID === assignmentId);
    if (!assignment) return;

    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>Add Notes</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-notes-form">
          <div class="pmp-form-row">
            <label>Your Notes</label>
            <textarea name="notes" rows="4" placeholder="What's the update on this task?">${PmpUtils.escapeHtml(assignment.EmployeeNotes)}</textarea>
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">Save notes</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-notes-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      // Notes-only save: re-send the current status unchanged, just with new employee notes.
      const res = await PmpApi.updateAssignmentStatus({
        assignmentId: assignment.AssignmentID,
        status: assignment.Status,
        employeeId: state.employeeId,
        employeeNotes: fd.get('notes'),
        notesOnly: true // allows same-status resubmission without bypassing ownership
      });

      if (res.success) {
        PmpUtils.toast('Notes saved', 'success');
        close();
        await refresh();
      } else {
        PmpUtils.toast(res.error || 'Could not save notes', 'error');
        submitBtn.disabled = false;
      }
    });
  }

  return { init, refresh };
})();