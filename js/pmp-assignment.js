/**
 * PMP — Module 1: Assignment Management
 * Manager-only: create/edit Tasks and their Assignments (one Task can have
 * several assignees, each with an independent Assignment), plus the
 * supporting Clients/Projects they depend on. Employee status-transition UI
 * lives in Module 2 (pmp-employee.js).
 *
 * Self-sufficient module: owns its own state, fed by init(). No dependency
 * on manager.js internals beyond the container it's told to render into.
 */

const PmpAssignment = (function () {

  let state = {
    clients: [],
    projects: [],
    tasks: [],
    assignments: [],
    employees: [],
    containerId: null,
    activeTab: 'assignments', // 'assignments' | 'projects' | 'clients'
    filters: { status: 'All', priority: 'All', assignedTo: 'All' }
  };

  // ------------------------------------------------------------
  // Init / data loading
  // ------------------------------------------------------------

  async function init(containerId) {
    state.containerId = containerId;
    renderShell();
    await refreshAll();
  }

  async function refreshAll() {
    const [clientsRes, projectsRes, tasksRes, assignmentsRes, employeesRes] = await Promise.all([
      PmpApi.getClients(),
      PmpApi.getProjects(),
      PmpApi.getTasks(),
      PmpApi.getAssignments(),
      PmpApi.getEmployees()
    ]);

    if (clientsRes.success) state.clients = clientsRes.clients;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (employeesRes.success) state.employees = employeesRes.employees;

    render();
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  // Joins an Assignment onto its parent Task's shared fields. Falls back to
  // the assignment's own flat fields for legacy (pre-migration) rows.
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

  // ------------------------------------------------------------
  // Shell + tab switching
  // ------------------------------------------------------------

  function renderShell() {
    container().innerHTML = `
      <div class="pmp-tabs" style="display:flex; gap:8px; margin-bottom:16px;">
        <button class="pmp-btn" data-tab="assignments">Assignments</button>
        <button class="pmp-btn" data-tab="attendance">Attendance</button>
        <button class="pmp-btn" data-tab="projects">Projects</button>
        <button class="pmp-btn" data-tab="clients">Clients</button>
        <div style="flex:1;"></div>
        <button class="pmp-btn pmp-btn-primary" id="pmp-new-btn">+ New</button>
      </div>
      <div id="pmp-tab-content"></div>
    `;

    container().querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        render();
      });
    });

    document.getElementById('pmp-new-btn').addEventListener('click', () => {
      if (state.activeTab === 'assignments') openTaskModal();
      else if (state.activeTab === 'projects') openProjectModal();
      else if (state.activeTab === 'clients') openClientModal();
      // No create action on the Timesheet tab — it's a computed report, not editable data.
    });
  }

  function render() {
    highlightActiveTab();
    const newBtn = document.getElementById('pmp-new-btn');
    newBtn.style.display = state.activeTab === 'attendance' ? 'none' : 'inline-block';

    const content = document.getElementById('pmp-tab-content');
    if (!content) return;

    // Timesheet is its own self-sufficient module (own state, own data
    // fetch) rather than a plain render function — it reads ActivityLog,
    // which nothing else on this tab needs.
    if (state.activeTab === 'attendance') { PmpAttendance.init('pmp-tab-content'); return; }
    if (state.activeTab === 'assignments') renderAssignments(content);
    else if (state.activeTab === 'projects') renderProjects(content);
    else renderClients(content);
  }

  function highlightActiveTab() {
    container().querySelectorAll('[data-tab]').forEach(btn => {
      const active = btn.dataset.tab === state.activeTab;
      btn.classList.toggle('pmp-btn-primary', active);
    });
  }

  // ------------------------------------------------------------
  // Assignments tab
  // ------------------------------------------------------------

  function renderAssignments(content) {
    const joined = state.assignments.map(withTask);
    const filtered = applyFilters(joined);
    const grouped = PmpUtils.groupAssignmentsByTask(state.tasks, filtered);

    content.innerHTML = `
      <div class="pmp-filters">
        <select id="filter-status">
          <option value="All">All statuses</option>
          ${PMP_CONFIG.STATUS_FLOW.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <select id="filter-priority">
          <option value="All">All priorities</option>
          ${PMP_CONFIG.PRIORITIES.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <select id="filter-assignee">
          <option value="All">All employees</option>
          ${state.employees.map(e => `<option value="${e.employeeId}">${PmpUtils.escapeHtml(e.name)}</option>`).join('')}
        </select>
      </div>
      ${grouped.length === 0 ? emptyState('No assignments match these filters.') : taskGroupList(grouped)}
    `;

    content.querySelector('#filter-status').value = state.filters.status;
    content.querySelector('#filter-priority').value = state.filters.priority;
    content.querySelector('#filter-assignee').value = state.filters.assignedTo;

    content.querySelector('#filter-status').addEventListener('change', e => {
      state.filters.status = e.target.value; render();
    });
    content.querySelector('#filter-priority').addEventListener('change', e => {
      state.filters.priority = e.target.value; render();
    });
    content.querySelector('#filter-assignee').addEventListener('change', e => {
      state.filters.assignedTo = e.target.value; render();
    });

    content.querySelectorAll('[data-edit-task]').forEach(btn => {
      btn.addEventListener('click', () => openTaskModal(btn.dataset.editTask));
    });
    content.querySelectorAll('[data-delete-assignment]').forEach(btn => {
      btn.addEventListener('click', () => confirmDeleteAssignment(btn.dataset.deleteAssignment));
    });
    content.querySelectorAll('[data-update-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        const select = content.querySelector('[data-status-select="' + btn.dataset.updateStatus + '"]');
        setAssignmentStatus(btn.dataset.updateStatus, select.value);
      });
    });
    content.querySelectorAll('[data-pause-assignment]').forEach(btn => {
      btn.addEventListener('click', () => pauseAssignment(btn.dataset.pauseAssignment));
    });
    content.querySelectorAll('[data-resume-assignment]').forEach(btn => {
      btn.addEventListener('click', () => resumeAssignment(btn.dataset.resumeAssignment));
    });
  }

  function applyFilters(assignments) {
    return assignments.filter(a => {
      if (state.filters.status !== 'All' && a.Status !== state.filters.status) return false;
      if (state.filters.priority !== 'All' && a.Priority !== state.filters.priority) return false;
      if (state.filters.assignedTo !== 'All' && a.AssignedTo !== state.filters.assignedTo) return false;
      return true;
    });
  }

  // One block per Task, one row per assignee — mirrors the Team Lead portal
  // so a Task with several people on it reads the same way in both places.
  function taskGroupList(grouped) {
    return `<div class="pmp-task-groups">${grouped.map(taskBlock).join('')}</div>`;
  }

  function taskBlock(group) {
    const task = group.task;
    const project = state.projects.find(p => p.ProjectID === task.ProjectID);
    const delayed = group.assignments.some(a => PmpUtils.isDelayed({ Status: a.Status, DueDate: task.DueDate }));

    const rows = group.assignments.map(a => {
      const employee = state.employees.find(e => e.employeeId === a.AssignedTo);
      return `
        <tr>
          <td>${PmpUtils.escapeHtml(a.AssignmentID)}</td>
          <td>${PmpUtils.escapeHtml(employee ? employee.name : a.AssignedTo)} ${a.Status === 'Assigned' ? '<span class="pmp-badge" style="background:var(--status-assigned); color:#fff;">New Task</span>' : ''} ${a.IsPaused === true ? '<span class="pmp-badge" style="background:#B08D57; color:#fff;">Paused</span>' : ''}</td>
          <td>
            <select class="pmp-status-select" data-status-select="${a.AssignmentID}" style="background:${PMP_CONFIG.STATUS_COLORS[a.Status] || '#eee'};">
              ${PMP_CONFIG.STATUS_FLOW.map(s => `<option value="${s}" ${s === a.Status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </td>
          <td>
            <button class="pmp-btn pmp-btn-primary" data-update-status="${a.AssignmentID}">Update</button>
            ${a.Status === 'Working' ? (a.IsPaused === true
              ? `<button class="pmp-btn" data-resume-assignment="${a.AssignmentID}">Resume</button>`
              : `<button class="pmp-btn" data-pause-assignment="${a.AssignmentID}">Pause</button>`) : ''}
            <button class="pmp-btn pmp-btn-danger" data-delete-assignment="${a.AssignmentID}">Remove</button>
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="pmp-card" data-task-card="${task.TaskID}" style="margin-bottom:16px;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div class="pmp-assignment-title">${PmpUtils.escapeHtml(task.TaskName)}</div>
            <div class="pmp-assignment-meta">
              <span>${PmpUtils.escapeHtml(project ? project.ProjectName : task.ProjectID)}</span>
              ${task.Dimension ? `<span>${PmpUtils.escapeHtml(task.Dimension)}</span>` : ''}
              <span class="pmp-badge pmp-badge-priority-${task.Priority}">${PmpUtils.escapeHtml(task.Priority || '')}</span>
              <span>Due ${PmpUtils.formatDate(task.DueDate)} ${delayed ? '<span class="pmp-badge pmp-badge-delayed">Delayed</span>' : ''}</span>
            </div>
          </div>
          ${task._legacy ? '' : `<button class="pmp-btn" data-edit-task="${task.TaskID}">Edit Task</button>`}
        </div>
        <table class="pmp-table" style="margin-top:10px;">
          <thead><tr><th>ID</th><th>Assigned To</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function statusPill(status) {
    return `<span class="pmp-badge" style="background:${PMP_CONFIG.STATUS_COLORS[status] || '#eee'};">${PmpUtils.escapeHtml(status)}</span>`;
  }

  // ------------------------------------------------------------
  // Assignment modal (create / edit)
  // ------------------------------------------------------------

  // Creates or edits a Task and its assignee list. Mirrors the Team Lead
  // portal's task modal — the Manager can create/assign work the same way
  // any Team Lead can, just with visibility across everyone and everything.
  function openTaskModal(taskId) {
    const editing = taskId ? state.tasks.find(t => t.TaskID === taskId) : null;
    const currentAssigneeIds = editing
      ? state.assignments.filter(a => a.TaskID === editing.TaskID).map(a => a.AssignedTo)
      : [];
    const editingProject = editing ? state.projects.find(p => p.ProjectID === editing.ProjectID) : null;
    const initialClientId = editingProject ? editingProject.ClientID : '';

    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>${editing ? 'Edit Task' : 'New Task'}</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-task-form">
          <div class="pmp-form-row">
            <label>Client</label>
            <select id="pmp-task-client">
              <option value="">Select client</option>
              ${state.clients.map(c => `<option value="${c.ClientID}" ${initialClientId === c.ClientID ? 'selected' : ''}>${PmpUtils.escapeHtml(c.ClientName)}</option>`).join('')}
            </select>
          </div>
          <div class="pmp-form-row">
            <label>Project</label>
            <select name="projectId" id="pmp-task-project" required>
              <option value="">${initialClientId ? 'Select project' : 'Select a client first'}</option>
              ${state.projects.filter(p => p.ClientID === initialClientId).map(p => `<option value="${p.ProjectID}" ${editing && editing.ProjectID === p.ProjectID ? 'selected' : ''}>${PmpUtils.escapeHtml(p.ProjectName)}</option>`).join('')}
            </select>
          </div>
          <div class="pmp-form-row">
            <label>Task</label>
            <input type="text" name="taskName" required value="${editing ? PmpUtils.escapeHtml(editing.TaskName) : ''}">
          </div>
          <div class="pmp-form-grid">
            <div class="pmp-form-row">
              <label>Dimension</label>
              <input type="text" name="dimension" value="${editing ? PmpUtils.escapeHtml(editing.Dimension) : ''}">
            </div>
            <div class="pmp-form-row">
              <label>Priority</label>
              <select name="priority">
                ${PMP_CONFIG.PRIORITIES.map(p => `<option value="${p}" ${editing && editing.Priority === p ? 'selected' : ''}>${p}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="pmp-form-grid">
            <div class="pmp-form-row">
              <label>Due Date</label>
              <input type="date" name="dueDate" value="${editing && editing.DueDate ? new Date(editing.DueDate).toISOString().slice(0,10) : ''}">
            </div>
            <div class="pmp-form-row">
              <label>Time Duration (hrs)</label>
              <input type="number" name="estimatedHours" min="0" step="0.5" placeholder="e.g. 4">
            </div>
          </div>
          <div class="pmp-form-row">
            <label>+ Add People</label>
            ${PmpUtils.employeeCheckboxList(state.employees, currentAssigneeIds, 'assigneeIds')}
          </div>
          <div class="pmp-form-row">
            <label>Notes</label>
            <textarea name="notes" rows="3">${editing ? PmpUtils.escapeHtml(editing.Notes) : ''}</textarea>
          </div>
          <p id="pmp-task-error" style="color:var(--status-delayed); font-size:12px; display:none;"></p>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">${editing ? 'Save changes' : 'Create task'}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Client is a pure UI filter — never sent to the backend, since Project
    // already implies its Client. Picking one just narrows the Project
    // dropdown down to that client's projects.
    overlay.querySelector('#pmp-task-client').addEventListener('change', e => {
      const projectSelect = overlay.querySelector('#pmp-task-project');
      const filtered = state.projects.filter(p => p.ClientID === e.target.value);
      projectSelect.innerHTML = `
        <option value="">${e.target.value ? 'Select project' : 'Select a client first'}</option>
        ${filtered.map(p => `<option value="${p.ProjectID}">${PmpUtils.escapeHtml(p.ProjectName)}</option>`).join('')}
      `;
    });

    overlay.querySelector('#pmp-task-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const assigneeIds = fd.getAll('assigneeIds');
      const errorEl = overlay.querySelector('#pmp-task-error');
      errorEl.style.display = 'none';

      if (assigneeIds.length === 0) {
        errorEl.textContent = 'Add at least one person to this task.';
        errorEl.style.display = 'block';
        return;
      }

      const taskPayload = {
        projectId: fd.get('projectId'),
        taskName: fd.get('taskName'),
        dimension: fd.get('dimension'),
        priority: fd.get('priority'),
        dueDate: fd.get('dueDate'),
        notes: fd.get('notes')
      };
      const estimatedHours = fd.get('estimatedHours');

      const session = PmpUtils.getSession();
      const actorId = session ? session.employeeId : '';
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      let res;
      if (editing) {
        res = await PmpApi.updateTask(Object.assign({ taskId: editing.TaskID }, taskPayload));
        if (res.success) {
          const toAdd = assigneeIds.filter(id => !currentAssigneeIds.includes(id));
          const toRemove = currentAssigneeIds.filter(id => !assigneeIds.includes(id));
          if (toAdd.length > 0) {
            await PmpApi.createAssignments({ taskId: editing.TaskID, employeeIds: toAdd, createdBy: actorId, estimatedHours });
          }
          for (const removedId of toRemove) {
            const a = state.assignments.find(x => x.TaskID === editing.TaskID && x.AssignedTo === removedId);
            if (a) await PmpApi.deleteAssignment({ assignmentId: a.AssignmentID, deletedBy: actorId });
          }
        }
      } else {
        // Atomic: if anything fails partway, the backend rolls back
        // everything itself — no orphan Task can be left behind here.
        res = await PmpApi.createTaskWithAssignments(Object.assign(
          { employeeIds: assigneeIds, createdBy: actorId, estimatedHours },
          taskPayload
        ));
      }

      if (res.success) {
        PmpUtils.toast(editing ? 'Task updated' : 'Task created', 'success');
        close();
        await refreshAll();
      } else {
        errorEl.textContent = res.error || 'Something went wrong';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
      }
    });
  }

  async function confirmDeleteAssignment(assignmentId) {
    if (!confirm('Delete this assignment? This cannot be undone.')) return;
    const session = PmpUtils.getSession();
    const res = await PmpApi.deleteAssignment({ assignmentId, deletedBy: session ? session.employeeId : '' });
    if (res.success) {
      PmpUtils.toast('Assignment deleted', 'success');
      await refreshAll();
    } else {
      PmpUtils.toast(res.error || 'Delete failed', 'error');
    }
  }

  // Manager can set any status directly, in either direction — same
  // capability as the Team Lead portal, not just approving forward.
  async function setAssignmentStatus(assignmentId, toStatus) {
    const session = PmpUtils.getSession();
    const res = await PmpApi.updateAssignmentStatus({
      assignmentId,
      status: toStatus,
      employeeId: session ? session.employeeId : '',
      managerOverride: true
    });
    if (res.success) {
      PmpUtils.toast(`Status set to ${toStatus}`, 'success');
      await refreshAll();
    } else {
      PmpUtils.toast(res.error || 'Could not update status', 'error');
    }
  }

  // Manager can pause/resume on anyone's behalf, same as Team Lead.
  async function pauseAssignment(assignmentId) {
    const session = PmpUtils.getSession();
    const reason = prompt('Reason for pausing? (optional — Cancel to not pause)');
    if (reason === null) return;
    const res = await PmpApi.pauseAssignment({
      assignmentId,
      employeeId: session ? session.employeeId : '',
      reason,
      managerOverride: true
    });
    if (res.success) {
      PmpUtils.toast('Task paused', 'success');
      await refreshAll();
    } else {
      PmpUtils.toast(res.error || 'Could not pause task', 'error');
    }
  }

  async function resumeAssignment(assignmentId) {
    const session = PmpUtils.getSession();
    const res = await PmpApi.resumeAssignment({
      assignmentId,
      employeeId: session ? session.employeeId : '',
      managerOverride: true
    });
    if (res.success) {
      PmpUtils.toast('Task resumed', 'success');
      await refreshAll();
    } else {
      PmpUtils.toast(res.error || 'Could not resume task', 'error');
    }
  }


  // ------------------------------------------------------------
  // Projects tab
  // ------------------------------------------------------------

  function renderProjects(content) {
    if (state.projects.length === 0) {
      content.innerHTML = emptyState('No projects yet. Create one to start assigning work.');
      return;
    }

    content.innerHTML = `<div class="pmp-card-grid">${state.projects.map(projectCard).join('')}</div>`;

    content.querySelectorAll('[data-edit-project]').forEach(btn => {
      btn.addEventListener('click', () => openProjectModal(btn.dataset.editProject));
    });
  }

  function projectCard(project) {
    const client = state.clients.find(c => c.ClientID === project.ClientID);
    const assignmentCount = state.assignments.map(withTask).filter(a => a.ProjectID === project.ProjectID).length;
    const color = PmpUtils.colorFromId(project.ProjectID);

    return `
      <div class="pmp-card" style="border-top: 4px solid ${color};">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(project.ProjectName)}</div>
        <div class="pmp-assignment-meta">
          <span>${PmpUtils.escapeHtml(client ? client.ClientName : project.ClientID)}</span>
          <span>${assignmentCount} assignment${assignmentCount === 1 ? '' : 's'}</span>
        </div>
        <div>${statusPill(project.Status)}</div>
        <div class="pmp-assignment-actions">
          <button class="pmp-btn" data-edit-project="${project.ProjectID}">Edit</button>
        </div>
      </div>
    `;
  }

  function openProjectModal(projectId) {
    const editing = projectId ? state.projects.find(p => p.ProjectID === projectId) : null;

    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>${editing ? 'Edit Project' : 'New Project'}</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-project-form">
          <div class="pmp-form-row">
            <label>Client</label>
            <select name="clientId" required ${editing ? 'disabled' : ''}>
              <option value="">Select client</option>
              ${state.clients.map(c => `<option value="${c.ClientID}" ${editing && editing.ClientID === c.ClientID ? 'selected' : ''}>${PmpUtils.escapeHtml(c.ClientName)}</option>`).join('')}
            </select>
          </div>
          <div class="pmp-form-row">
            <label>Project Name</label>
            <input type="text" name="projectName" required value="${editing ? PmpUtils.escapeHtml(editing.ProjectName) : ''}">
          </div>
          <div class="pmp-form-row">
            <label>Start Date</label>
            <input type="date" name="startDate" value="${editing && editing.StartDate ? new Date(editing.StartDate).toISOString().slice(0,10) : ''}">
          </div>
          ${editing ? `
          <div class="pmp-form-row">
            <label>Status</label>
            <select name="status">
              ${['Active','ReadyForBilling','Billed','Archived'].map(s => `<option value="${s}" ${editing.Status === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>` : ''}
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">${editing ? 'Save changes' : 'Create project'}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-project-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      let res;
      if (editing) {
        res = await PmpApi.updateProject({
          projectId: editing.ProjectID,
          projectName: fd.get('projectName'),
          startDate: fd.get('startDate'),
          status: fd.get('status')
        });
      } else {
        res = await PmpApi.createProject({
          clientId: fd.get('clientId'),
          projectName: fd.get('projectName'),
          startDate: fd.get('startDate')
        });
      }

      if (res.success) {
        PmpUtils.toast(editing ? 'Project updated' : 'Project created', 'success');
        close();
        await refreshAll();
      } else {
        PmpUtils.toast(res.error || 'Something went wrong', 'error');
        submitBtn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------
  // Clients tab
  // ------------------------------------------------------------

  function renderClients(content) {
    if (state.clients.length === 0) {
      content.innerHTML = emptyState('No clients yet. Add one to create projects.');
      return;
    }

    content.innerHTML = `<div class="pmp-card-grid">${state.clients.map(clientCard).join('')}</div>`;

    content.querySelectorAll('[data-edit-client]').forEach(btn => {
      btn.addEventListener('click', () => openClientModal(btn.dataset.editClient));
    });
  }

  function clientCard(client) {
    const projectCount = state.projects.filter(p => p.ClientID === client.ClientID).length;
    return `
      <div class="pmp-card">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(client.ClientName)}</div>
        <div class="pmp-assignment-meta">
          <span>${PmpUtils.escapeHtml(client.ContactPerson || 'No contact set')}</span>
          <span>${projectCount} project${projectCount === 1 ? '' : 's'}</span>
        </div>
        <div class="pmp-assignment-actions">
          <button class="pmp-btn" data-edit-client="${client.ClientID}">Edit</button>
        </div>
      </div>
    `;
  }

  function openClientModal(clientId) {
    const editing = clientId ? state.clients.find(c => c.ClientID === clientId) : null;

    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>${editing ? 'Edit Client' : 'New Client'}</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-client-form">
          <div class="pmp-form-row">
            <label>Client Name</label>
            <input type="text" name="clientName" required value="${editing ? PmpUtils.escapeHtml(editing.ClientName) : ''}">
          </div>
          <div class="pmp-form-grid">
            <div class="pmp-form-row">
              <label>Contact Person</label>
              <input type="text" name="contactPerson" value="${editing ? PmpUtils.escapeHtml(editing.ContactPerson) : ''}">
            </div>
            <div class="pmp-form-row">
              <label>Phone</label>
              <input type="text" name="phone" value="${editing ? PmpUtils.escapeHtml(editing.Phone) : ''}">
            </div>
          </div>
          <div class="pmp-form-row">
            <label>Email</label>
            <input type="email" name="email" value="${editing ? PmpUtils.escapeHtml(editing.Email) : ''}">
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">${editing ? 'Save changes' : 'Create client'}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-client-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const payload = {
        clientName: fd.get('clientName'),
        contactPerson: fd.get('contactPerson'),
        phone: fd.get('phone'),
        email: fd.get('email')
      };

      const res = editing
        ? await PmpApi.updateClient(Object.assign({ clientId: editing.ClientID }, payload))
        : await PmpApi.createClient(payload);

      if (res.success) {
        PmpUtils.toast(editing ? 'Client updated' : 'Client created', 'success');
        close();
        await refreshAll();
      } else {
        PmpUtils.toast(res.error || 'Something went wrong', 'error');
        submitBtn.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------
  // Shared bits
  // ------------------------------------------------------------

  function emptyState(message) {
    return `<div class="pmp-empty">${PmpUtils.escapeHtml(message)}</div>`;
  }

  return { init, refreshAll };
})();