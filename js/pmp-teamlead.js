/**
 * PMP — Team Leader Portal
 *
 * A Team Leader gets full assignment management (create/edit/status changes).
 * There is no fixed team: any Team Lead can assign a Task to any active
 * Employee, and an Employee can carry work from several Team Leads at once.
 * "Employees" tab is a read-only roster of the whole active pool, not a
 * personal team.
 *
 * A Task (the deliverable) can be assigned to multiple Employees at once;
 * each gets an independent Assignment with its own Status/Notes.
 *
 * Self-sufficient module: owns its own state, fed by init(teamLeadId).
 */

const PmpTeamLead = (function () {

  let state = {
    teamLeadId: null,
    team: [], // full active Employee pool, not a personal team — name kept for minimal churn
    tasks: [],
    assignments: [],
    projects: [],
    clients: [],
    containerId: null,
    activeTab: 'dashboard',
    filters: { status: 'All', priority: 'All', assignedTo: 'All' }
  };

  async function init(containerId, teamLeadId) {
    state.containerId = containerId;
    state.teamLeadId = teamLeadId;
    renderShell();
    await refreshAll();
  }

  async function refreshAll() {
    const [teamRes, tasksRes, assignmentsRes, projectsRes, clientsRes] = await Promise.all([
      PmpApi.getMyTeam(state.teamLeadId),
      PmpApi.getTasks(),
      PmpApi.getTeamAssignments(state.teamLeadId),
      PmpApi.getProjects(),
      PmpApi.getClients()
    ]);

    if (teamRes.success) state.team = teamRes.employees;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (assignmentsRes.success) state.assignments = assignmentsRes.assignments;
    if (projectsRes.success) state.projects = projectsRes.projects;
    if (clientsRes.success) state.clients = clientsRes.clients;

    render();
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
        <button class="pmp-btn pmp-btn-primary" data-tab="dashboard">Dashboard</button>
        <button class="pmp-btn" data-tab="assignments">Assignments</button>
        <button class="pmp-btn" data-tab="attendance">Attendance</button>
        <button class="pmp-btn" data-tab="timesheet">Timesheet</button>
        <button class="pmp-btn" data-tab="projects">Projects</button>
        <button class="pmp-btn" data-tab="clients">Clients</button>
        <button class="pmp-btn" data-tab="team">Employees</button>
        <div style="flex:1;"></div>
        <button class="pmp-btn pmp-btn-primary" id="pmp-tl-new-btn">+ New Task</button>
      </div>
      <div id="pmp-tl-content"></div>
    `;

    container().querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.dataset.tab;
        render();
      });
    });

    document.getElementById('pmp-tl-new-btn').addEventListener('click', () => {
      if (state.activeTab === 'projects') openProjectModal();
      else if (state.activeTab === 'clients') openClientModal();
      else if (state.activeTab === 'assignments') openTaskModal();
      // No create action on the Employees tab — that's Manager-only, via People.
    });
  }

  // Joins an Assignment onto its parent Task's shared fields (Project,
  // TaskName, Dimension, Priority, DueDate, Notes). Falls back to the
  // assignment's own flat fields for legacy (pre-migration) rows.
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

  function render() {
    container().querySelectorAll('[data-tab]').forEach(btn => {
      btn.classList.toggle('pmp-btn-primary', btn.dataset.tab === state.activeTab);
    });

    const newBtn = document.getElementById('pmp-tl-new-btn');
    const newBtnLabels = { assignments: '+ New Task', projects: '+ New Project', clients: '+ New Client', team: '', attendance: '', timesheet: '', dashboard: '' };
    newBtn.textContent = newBtnLabels[state.activeTab] || '';
    newBtn.style.display = newBtn.textContent ? 'inline-block' : 'none';

    const content = document.getElementById('pmp-tl-content');
    if (!content) return;

    if (state.activeTab === 'dashboard') {
      PmpTeamLeadDashboard.init('pmp-tl-content', state.teamLeadId, {
        onNavigate: ({ target }) => {
          if (target === 'assignments') {
            state.activeTab = 'assignments';
            render();
          }
        }
      });
      return;
    }

    // Timesheet is its own self-sufficient module (own state, own data
    // fetch) rather than a plain render function like Projects/Clients —
    // it reads ActivityLog, which nothing else on this tab needs. Reuses
    // the exact same 'view' mode Manager gets — no separate Team Lead
    // timesheet logic to keep in sync with it.
    if (state.activeTab === 'attendance') { PmpAttendance.init('pmp-tl-content'); return; }
    if (state.activeTab === 'timesheet') { PmpTimesheet.init('pmp-tl-content', { mode: 'view' }); return; }
    if (state.activeTab === 'projects') { renderProjects(content); return; }
    if (state.activeTab === 'clients') { renderClients(content); return; }

    // Assignments and Employees both need the active pool to mean anything.
    if (state.team.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No employees found. Ask your Manager to add people in the People panel.</div>`;
      return;
    }

    if (state.activeTab === 'assignments') renderAssignments(content);
    else renderTeam(content);
  }

  // ------------------------------------------------------------
  // Projects tab — same capability as the Manager's Work > Projects view.
  // A Team Lead is effectively a mini-manager: they can see and create
  // Projects/Clients directly rather than asking the Manager to do it.
  // ------------------------------------------------------------

  function renderProjects(content) {
    if (state.projects.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No projects yet. Create one to start assigning work.</div>`;
      return;
    }

    content.innerHTML = `<div class="pmp-card-grid">${state.projects.map(projectCard).join('')}</div>`;

    content.querySelectorAll('[data-edit-project]').forEach(btn => {
      btn.addEventListener('click', () => openProjectModal(btn.dataset.editProject));
    });
  }

  function projectCard(project) {
    const client = state.clients.find(c => c.ClientID === project.ClientID);
    const taskCount = state.tasks.filter(t => t.ProjectID === project.ProjectID).length;
    const color = PmpUtils.colorFromId(project.ProjectID);

    return `
      <div class="pmp-card" style="border-top: 4px solid ${color};">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(project.ProjectName)}</div>
        <div class="pmp-assignment-meta">
          <span>${PmpUtils.escapeHtml(client ? client.ClientName : project.ClientID)}</span>
          <span>${taskCount} task${taskCount === 1 ? '' : 's'}</span>
        </div>
        <div><span class="pmp-badge" style="background:${PMP_CONFIG.STATUS_COLORS[project.Status] || '#eee'};">${PmpUtils.escapeHtml(project.Status)}</span></div>
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
        <form id="pmp-tl-project-form">
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

    overlay.querySelector('#pmp-tl-project-form').addEventListener('submit', async e => {
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
  // Clients tab — same capability as the Manager's Work > Clients view.
  // ------------------------------------------------------------

  function renderClients(content) {
    if (state.clients.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No clients yet. Add one to create projects.</div>`;
      return;
    }

    content.innerHTML = `<div class="pmp-card-grid">${state.clients.map(clientCard).join('')}</div>`;

    content.querySelectorAll('[data-edit-client]').forEach(btn => {
      btn.addEventListener('click', () => openClientModal(btn.dataset.editClient));
    });
  }

  function clientCard(client) {
    const projectCount = state.projects.filter(p => p.ClientID === client.ClientID).length;
    const color = PmpUtils.colorFromId(client.ClientID);
    return `
      <div class="pmp-card" style="border-top:4px solid ${color};">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(client.ClientName)}</div>
        <div class="pmp-assignment-meta">
          <span style="color:var(--pmp-text-muted); font-family:monospace;">${PmpUtils.escapeHtml(client.ClientID)}</span>
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
        <form id="pmp-tl-client-form">
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

    overlay.querySelector('#pmp-tl-client-form').addEventListener('submit', async e => {
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

  function renderAssignments(content) {
    const joined = state.assignments.map(withTask);
    const filtered = joined.filter(a => {
      if (state.filters.status !== 'All' && a.Status !== state.filters.status) return false;
      if (state.filters.priority !== 'All' && a.Priority !== state.filters.priority) return false;
      if (state.filters.assignedTo !== 'All' && a.AssignedTo !== state.filters.assignedTo) return false;
      return true;
    });

    const grouped = PmpUtils.groupAssignmentsByTask(state.tasks, filtered);

    content.innerHTML = `
      <div class="pmp-filters">
        <select id="tl-filter-status">
          <option value="All">All statuses</option>
          ${PMP_CONFIG.STATUS_FLOW.map(s => `<option value="${s}">${s}</option>`).join('')}
        </select>
        <select id="tl-filter-priority">
          <option value="All">All priorities</option>
          ${PMP_CONFIG.PRIORITIES.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <select id="tl-filter-assignee">
          <option value="All">All employees</option>
          ${state.team.map(e => `<option value="${e.employeeId}">${PmpUtils.escapeHtml(e.name)}</option>`).join('')}
        </select>
      </div>
      ${grouped.length === 0 ? `<div class="pmp-empty">No assignments match these filters.</div>` : taskGroupList(grouped)}
    `;

    content.querySelector('#tl-filter-status').value = state.filters.status;
    content.querySelector('#tl-filter-priority').value = state.filters.priority;
    content.querySelector('#tl-filter-assignee').value = state.filters.assignedTo;

    content.querySelector('#tl-filter-status').addEventListener('change', e => { state.filters.status = e.target.value; render(); });
    content.querySelector('#tl-filter-priority').addEventListener('change', e => { state.filters.priority = e.target.value; render(); });
    content.querySelector('#tl-filter-assignee').addEventListener('change', e => { state.filters.assignedTo = e.target.value; render(); });

    content.querySelectorAll('[data-edit-task]').forEach(btn => {
      btn.addEventListener('click', () => openTaskModal(btn.dataset.editTask));
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

  // One block per Task, with one row per assignee inside it — this is the
  // "+ Add People" model: a single deliverable, several independent workers.
  function taskGroupList(grouped) {
    return `<div class="pmp-task-groups">${grouped.map(taskBlock).join('')}</div>`;
  }

  function taskBlock(group) {
    const task = group.task;
    const project = state.projects.find(p => p.ProjectID === task.ProjectID);
    const client = project ? state.clients.find(c => c.ClientID === project.ClientID) : null;
    const clientColor = client ? PmpUtils.colorFromId(client.ClientID) : 'var(--pmp-border, #ddd)';
    const delayed = group.assignments.some(a => PmpUtils.isDelayed({ Status: a.Status, DueDate: task.DueDate }));

    const rows = group.assignments.map(a => {
      const employee = state.team.find(e => e.employeeId === a.AssignedTo);
      const empColor = PmpUtils.colorFromId(a.AssignedTo, 55);
      return `
        <tr>
          <td><span style="display:inline-flex; align-items:center; gap:6px;"><span style="width:8px; height:8px; border-radius:50%; background:${empColor}; display:inline-block; flex-shrink:0;"></span>${PmpUtils.escapeHtml(employee ? employee.name : a.AssignedTo)}</span> ${a.Status === 'Assigned' ? '<span class="pmp-badge" style="background:var(--status-assigned); color:#fff;">New Task</span>' : ''} ${a.IsPaused === true ? '<span class="pmp-badge" style="background:var(--status-review); color:#fff;">Paused</span>' : ''}</td>
          <td>
            <select class="pmp-status-select" data-status-select="${a.AssignmentID}" style="background:${PMP_CONFIG.STATUS_COLORS[a.Status] || '#eee'};">
              ${PMP_CONFIG.STATUS_FLOW.map(s => `<option value="${s}" ${s === a.Status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </td>
          <td>${a.EmployeeNotes ? PmpUtils.escapeHtml(a.EmployeeNotes) : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
          <td>
            <button class="pmp-btn pmp-btn-primary" data-update-status="${a.AssignmentID}">Update</button>
            ${a.Status === 'Working' ? (a.IsPaused === true
              ? `<button class="pmp-btn" data-resume-assignment="${a.AssignmentID}">Resume</button>`
              : `<button class="pmp-btn" data-pause-assignment="${a.AssignmentID}">Pause</button>`) : ''}
          </td>
        </tr>
      `;
    }).join('');

    return `
      <div class="pmp-card" data-task-card="${task.TaskID}" style="margin-bottom:16px; border-left:4px solid ${clientColor};">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
          <div>
            <div class="pmp-assignment-title">${PmpUtils.escapeHtml(task.TaskName)}</div>
            <div class="pmp-assignment-meta">
              <span>${PmpUtils.escapeHtml(project ? project.ProjectName : task.ProjectID)}${project ? ` <span style="color:var(--pmp-text-muted); font-family:monospace; font-size:11px;">(${PmpUtils.escapeHtml(project.ProjectID)})</span>` : ''}</span>
              ${client ? `<span style="display:inline-flex; align-items:center; gap:5px;"><span style="width:7px; height:7px; border-radius:50%; background:${clientColor}; display:inline-block;"></span>${PmpUtils.escapeHtml(client.ClientName)} <span style="color:var(--pmp-text-muted); font-family:monospace; font-size:11px;">(${PmpUtils.escapeHtml(client.ClientID)})</span></span>` : ''}
              ${task.Dimension ? `<span>${PmpUtils.escapeHtml(task.Dimension)}</span>` : ''}
              <span class="pmp-badge pmp-badge-priority-${task.Priority}">${PmpUtils.escapeHtml(task.Priority || '')}</span>
              <span>Due ${PmpUtils.formatDate(task.DueDate)} ${delayed ? '<span class="pmp-badge pmp-badge-delayed">Delayed</span>' : ''}</span>
            </div>
          </div>
          ${task._legacy ? '' : `<button class="pmp-btn" data-edit-task="${task.TaskID}">Edit Task</button>`}
        </div>
        <table class="pmp-table" style="margin-top:10px;">
          <thead><tr><th>Team Member</th><th>Status</th><th>Notes</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Team Lead can set any status, in either direction — not just the next
  // step forward. This is what lets a task in Review get sent back to
  // Working for rework, not just approved on to Completed.
  async function setAssignmentStatus(assignmentId, toStatus) {
    const res = await PmpApi.updateAssignmentStatus({
      assignmentId,
      status: toStatus,
      employeeId: state.teamLeadId,
      managerOverride: true
    });
    if (res.success) {
      PmpUtils.toast(`Status set to ${toStatus}`, 'success');
      await refreshAll();
    } else {
      PmpUtils.toast(res.error || 'Could not update status', 'error');
    }
  }

  // Team Lead can pause/resume on behalf of the assignee — useful when the
  // Team Lead is the one who knows a more urgent Task just came up for them.
  async function pauseAssignment(assignmentId) {
    const reason = prompt('Reason for pausing? (optional — Cancel to not pause)');
    if (reason === null) return;
    const res = await PmpApi.pauseAssignment({
      assignmentId,
      employeeId: state.teamLeadId,
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
    const res = await PmpApi.resumeAssignment({
      assignmentId,
      employeeId: state.teamLeadId,
      managerOverride: true
    });
    if (res.success) {
      PmpUtils.toast('Task resumed', 'success');
      await refreshAll();
    } else {
      PmpUtils.toast(res.error || 'Could not resume task', 'error');
    }
  }

  // Creates or edits a Task, and manages its assignee list. On create, one
  // independent Assignment is generated per checked employee ("+ Add People").
  // On edit, checking/unchecking people diffs against the current assignee
  // list — newly checked people get a fresh Assignment, unchecked people
  // have theirs removed. Task-level fields (Project, Sub Task, Dimension,
  // Priority, Due Date, Notes) apply to everyone on the Task at once.
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
        <form id="pmp-tl-task-form">
          <div class="pmp-form-row">
            <label>Client</label>
            <select id="pmp-tl-task-client">
              <option value="">Select client</option>
              ${state.clients.map(c => `<option value="${c.ClientID}" ${initialClientId === c.ClientID ? 'selected' : ''}>${PmpUtils.escapeHtml(c.ClientName)}</option>`).join('')}
            </select>
          </div>
          <div class="pmp-form-row">
            <label>Project</label>
            <select name="projectId" id="pmp-tl-task-project" required>
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
            ${PmpUtils.employeeCheckboxList(state.team, currentAssigneeIds, 'assigneeIds')}
          </div>
          <div class="pmp-form-row">
            <label>Notes</label>
            <textarea name="notes" rows="3">${editing ? PmpUtils.escapeHtml(editing.Notes) : ''}</textarea>
          </div>
          <p id="pmp-tl-task-error" style="color:var(--status-delayed); font-size:12px; display:none;"></p>
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

    // Client is a pure UI filter — it's never sent to the backend, since
    // Project already implies its Client. Picking one just narrows the
    // Project dropdown down to that client's projects.
    overlay.querySelector('#pmp-tl-task-client').addEventListener('change', e => {
      const projectSelect = overlay.querySelector('#pmp-tl-task-project');
      const filtered = state.projects.filter(p => p.ClientID === e.target.value);
      projectSelect.innerHTML = `
        <option value="">${e.target.value ? 'Select project' : 'Select a client first'}</option>
        ${filtered.map(p => `<option value="${p.ProjectID}">${PmpUtils.escapeHtml(p.ProjectName)}</option>`).join('')}
      `;
    });

    overlay.querySelector('#pmp-tl-task-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const assigneeIds = fd.getAll('assigneeIds');
      const errorEl = overlay.querySelector('#pmp-tl-task-error');
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

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      let res;
      if (editing) {
        res = await PmpApi.updateTask(Object.assign({ taskId: editing.TaskID }, taskPayload));
        if (res.success) {
          const toAdd = assigneeIds.filter(id => !currentAssigneeIds.includes(id));
          const toRemove = currentAssigneeIds.filter(id => !assigneeIds.includes(id));
          if (toAdd.length > 0) {
            await PmpApi.createAssignments({ taskId: editing.TaskID, employeeIds: toAdd, createdBy: state.teamLeadId, estimatedHours });
          }
          for (const removedId of toRemove) {
            const a = state.assignments.find(x => x.TaskID === editing.TaskID && x.AssignedTo === removedId);
            if (a) await PmpApi.deleteAssignment({ assignmentId: a.AssignmentID, deletedBy: state.teamLeadId });
          }
        }
      } else {
        // Atomic: if anything fails partway (task created but an
        // assignment write fails, etc.), the backend rolls back everything
        // itself — no orphan Task can be left behind here.
        res = await PmpApi.createTaskWithAssignments(Object.assign(
          { employeeIds: assigneeIds, createdBy: state.teamLeadId, estimatedHours },
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

  function renderTeam(content) {
    content.innerHTML = `<div class="pmp-card-grid">${state.team.map(teamCard).join('')}</div>`;
  }

  function teamCard(employee) {
    const activeCount = state.assignments.filter(a =>
      a.AssignedTo === employee.employeeId && a.Status !== 'Completed' && a.Status !== 'Closed'
    ).length;

    return `
      <div class="pmp-card">
        <div class="pmp-assignment-title">${PmpUtils.escapeHtml(employee.name)}</div>
        <div class="pmp-assignment-meta">
          <span>${activeCount} active task${activeCount === 1 ? '' : 's'}</span>
        </div>
      </div>
    `;
  }

  return { init, refreshAll };
})();