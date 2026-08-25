/**
 * PMP — Module: Projects Explorer (pmp-projects-explorer.js)
 *
 * A new browsing view for Projects & Clients — client list on the left,
 * that client's projects in the middle, selected project's detail +
 * breakdown panels on the right. Added ALONGSIDE the existing card-grid
 * Projects tab in pmp-teamlead.js, not replacing it.
 *
 * Every number shown here comes directly from existing PMP data
 * (Projects, Clients, Tasks, Assignments) — there is no hours-per-project
 * or "Views Planned/Completed" concept anywhere in PMP's schema, so
 * unlike the TimeTrack layout this is modeled on, this view deliberately
 * does NOT show hour totals, salary, or a Views field. The three side
 * panels are real, PMP-native equivalents instead:
 *   - Task Breakdown   : how many of this project's Assignments sit in
 *                        each status (Assigned/Working/Review/Completed/
 *                        Closed).
 *   - Team Performance : per-employee assigned vs completed count, for
 *                        just this project.
 *   - Project Progress : overall % of this project's Assignments that
 *                        are Completed or Closed.
 *
 * Read/write split: browsing (client list, project list, selecting a
 * project) is read-only exploration. Editing a project's own fields
 * (Name/Status/Start Date) and creating new Clients/Projects reuse the
 * EXACT SAME backend calls (pmp_updateProject/pmp_createProject/
 * pmp_createClient) the existing Projects tab already uses — no new
 * write path introduced.
 *
 * Self-sufficient module: owns its own state, fed by init(containerId, opts).
 * opts.viewerId: the logged-in Team Lead/Manager's employeeId — currently
 * unused by any write call here (create/update endpoints don't require
 * it), kept for signature stability in case that changes.
 */

const PmpProjectsExplorer = (function () {

  let state = {
    clients: [],
    projects: [],
    tasks: [],
    assignments: [],
    employees: [],
    containerId: null,
    viewerId: null,
    selectedClientId: 'All',
    selectedProjectId: null,
    clientSearch: '',
    projectSearch: '',
    sortOrder: 'newest' // 'newest' | 'oldest'
  };

  async function init(containerId, opts) {
    state.containerId = containerId;
    state.viewerId = (opts && opts.viewerId) || null;
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

  // ============================================================
  // Shell
  // ============================================================

  function renderShell() {
    container().innerHTML = `
      <div style="width:100vw; position:relative; left:50%; margin-left:-50vw; padding:0 32px; box-sizing:border-box;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:20px; flex-wrap:wrap;">
          <div>
            <div style="font-size:20px; font-weight:700;">📁 Projects &amp; Clients</div>
            <div style="font-size:12px; color:var(--pmp-text-muted); margin-top:2px;">Browse projects by client. Not a task board.</div>
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
            <input type="text" id="pmp-pe-project-search" placeholder="🔎 Search projects..." style="min-width:220px;">
            <select id="pmp-pe-sort">
              <option value="newest">Newest → Oldest</option>
              <option value="oldest">Oldest → Newest</option>
            </select>
            <button class="pmp-btn" id="pmp-pe-new-client-btn">+ New Client</button>
            <button class="pmp-btn pmp-btn-primary" id="pmp-pe-new-project-btn">+ New Project</button>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:270px 360px 1fr; gap:18px; align-items:start;">
          <div class="pmp-card" id="pmp-pe-clients-col" style="padding:16px; box-shadow:0 1px 3px rgba(0,0,0,0.15);"></div>
          <div class="pmp-card" id="pmp-pe-projects-col" style="padding:16px; max-height:76vh; overflow-y:auto; box-shadow:0 1px 3px rgba(0,0,0,0.15);"></div>
          <div id="pmp-pe-detail-col"></div>
        </div>
      </div>
    `;

    document.getElementById('pmp-pe-project-search').addEventListener('input', e => {
      state.projectSearch = e.target.value;
      renderProjectsColumn();
    });
    document.getElementById('pmp-pe-sort').addEventListener('change', e => {
      state.sortOrder = e.target.value;
      renderProjectsColumn();
    });
    document.getElementById('pmp-pe-new-client-btn').addEventListener('click', () => openClientModal());
    document.getElementById('pmp-pe-new-project-btn').addEventListener('click', () => openProjectModal());
  }

  function render() {
    renderClientsColumn();
    renderProjectsColumn();
    renderDetailColumn();
  }

  // ============================================================
  // Left column — Clients
  // ============================================================

  function projectCountForClient(clientId) {
    return state.projects.filter(p => p.ClientID === clientId).length;
  }

  function renderClientsColumn() {
    const col = document.getElementById('pmp-pe-clients-col');
    if (!col) return;

    const search = state.clientSearch.trim().toLowerCase();
    const filtered = state.clients.filter(c => !search || c.ClientName.toLowerCase().includes(search));

    col.innerHTML = `
      <div style="font-size:11px; font-weight:700; letter-spacing:0.06em; color:var(--pmp-text-muted); margin-bottom:10px;">CLIENTS</div>
      <input type="text" id="pmp-pe-client-search" placeholder="🔎 Search clients..." style="width:100%; margin-bottom:12px;" value="${PmpUtils.escapeHtml(state.clientSearch)}">
      <div style="display:flex; flex-direction:column; gap:3px; max-height:60vh; overflow-y:auto;">
        <div class="pmp-pe-client-row" data-pe-client="All" style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-radius:7px; cursor:pointer; font-weight:700; ${state.selectedClientId === 'All' ? 'background:var(--status-working); color:#fff;' : ''}">
          <span>⭐ All Clients</span>
          <span style="font-size:11px; ${state.selectedClientId === 'All' ? 'background:rgba(255,255,255,0.25);' : 'background:var(--pmp-border,#eee); color:var(--pmp-text-muted);'} padding:1px 7px; border-radius:10px; font-weight:700;">${state.projects.length}</span>
        </div>
        ${filtered.map(c => {
          const selected = state.selectedClientId === c.ClientID;
          const dotColor = PmpUtils.colorFromId(c.ClientID, 55);
          return `
          <div class="pmp-pe-client-row" data-pe-client="${c.ClientID}" title="${PmpUtils.escapeHtml(c.ClientName)}" style="display:flex; justify-content:space-between; align-items:center; padding:7px 10px; border-radius:7px; cursor:pointer; gap:8px; ${selected ? 'background:var(--status-working); color:#fff;' : ''}">
            <span style="display:flex; align-items:flex-start; gap:7px; min-width:0;">
              <span style="width:8px; height:8px; border-radius:50%; background:${dotColor}; flex-shrink:0; margin-top:4px;"></span>
              <span style="font-size:13px; line-height:1.3; word-break:break-word;">${PmpUtils.escapeHtml(c.ClientName)}</span>
            </span>
            <span style="font-size:11px; flex-shrink:0; ${selected ? 'background:rgba(255,255,255,0.25);' : 'background:var(--pmp-border,#eee); color:var(--pmp-text-muted);'} padding:1px 7px; border-radius:10px; font-weight:700;">${projectCountForClient(c.ClientID)}</span>
          </div>
        `;
        }).join('')}
      </div>
    `;

    document.getElementById('pmp-pe-client-search').addEventListener('input', e => {
      state.clientSearch = e.target.value;
      renderClientsColumn();
    });

    col.querySelectorAll('[data-pe-client]').forEach(row => {
      row.addEventListener('click', () => {
        state.selectedClientId = row.dataset.peClient;
        renderClientsColumn();
        renderProjectsColumn();
      });
    });
  }

  // ============================================================
  // Middle column — Projects for the selected client
  // ============================================================

  function renderProjectsColumn() {
    const col = document.getElementById('pmp-pe-projects-col');
    if (!col) return;

    const search = state.projectSearch.trim().toLowerCase();
    let list = state.projects.filter(p =>
      (state.selectedClientId === 'All' || p.ClientID === state.selectedClientId)
      && (!search || p.ProjectName.toLowerCase().includes(search))
    );

    list = list.slice().sort((a, b) => {
      const cmp = new Date(a.CreatedDate || 0) - new Date(b.CreatedDate || 0);
      return state.sortOrder === 'newest' ? -cmp : cmp;
    });

    if (list.length === 0) {
      col.innerHTML = `<div class="pmp-empty">No projects found.</div>`;
      return;
    }

    col.innerHTML = list.map(p => {
      const client = state.clients.find(c => c.ClientID === p.ClientID);
      const selected = state.selectedProjectId === p.ProjectID;
      const accent = PmpUtils.colorFromId(p.ProjectID, 55);
      return `
        <div class="pmp-pe-project-row" data-pe-project="${p.ProjectID}" title="${PmpUtils.escapeHtml(p.ProjectName)}" style="padding:9px 10px; border-radius:7px; cursor:pointer; margin-bottom:3px; border-left:3px solid ${accent}; ${selected ? 'background:var(--status-working); color:#fff;' : ''}">
          <div style="font-weight:600; font-size:13px;">${PmpUtils.escapeHtml(p.ProjectName)}</div>
          <div style="font-size:11px; ${selected ? 'color:rgba(255,255,255,0.85);' : 'color:var(--pmp-text-muted);'} margin-top:2px;">${PmpUtils.escapeHtml(p.ProjectID)}${client ? ' · ' + PmpUtils.escapeHtml(client.ClientName) : ''}</div>
        </div>
      `;
    }).join('');

    col.querySelectorAll('[data-pe-project]').forEach(row => {
      row.addEventListener('click', () => {
        state.selectedProjectId = row.dataset.peProject;
        renderProjectsColumn();
        renderDetailColumn();
      });
    });
  }

  // ============================================================
  // Right column — selected project's detail + real-data panels
  // ============================================================

  function tasksForProject(projectId) {
    return state.tasks.filter(t => t.ProjectID === projectId);
  }

  function assignmentsForProject(projectId) {
    const taskIds = tasksForProject(projectId).map(t => t.TaskID);
    return state.assignments.filter(a => taskIds.indexOf(a.TaskID) !== -1);
  }

  function employeeName(employeeId) {
    const e = state.employees.find(x => x.employeeId === employeeId);
    return e ? e.name : employeeId;
  }

  function renderDetailColumn() {
    const col = document.getElementById('pmp-pe-detail-col');
    if (!col) return;

    if (!state.selectedProjectId) {
      col.innerHTML = `<div class="pmp-card"><div class="pmp-empty">Select a project to view its details.</div></div>`;
      return;
    }

    const project = state.projects.find(p => p.ProjectID === state.selectedProjectId);
    if (!project) {
      state.selectedProjectId = null;
      col.innerHTML = `<div class="pmp-card"><div class="pmp-empty">Select a project to view its details.</div></div>`;
      return;
    }

    const client = state.clients.find(c => c.ClientID === project.ClientID);
    const projectAssignments = assignmentsForProject(project.ProjectID);

    // Task Breakdown — real Assignment status counts for this project.
    const statusCounts = {};
    (typeof PMP_CONFIG !== 'undefined' && PMP_CONFIG.STATUS_FLOW ? PMP_CONFIG.STATUS_FLOW : ['Assigned', 'Working', 'Review', 'Completed', 'Closed']).forEach(s => { statusCounts[s] = 0; });
    projectAssignments.forEach(a => { if (statusCounts[a.Status] !== undefined) statusCounts[a.Status]++; });

    // Team Performance — per-employee assigned vs completed, this project only.
    const byEmployee = {};
    projectAssignments.forEach(a => {
      if (!byEmployee[a.AssignedTo]) byEmployee[a.AssignedTo] = { assigned: 0, completed: 0 };
      byEmployee[a.AssignedTo].assigned++;
      if (a.Status === 'Completed' || a.Status === 'Closed') byEmployee[a.AssignedTo].completed++;
    });

    // Project Progress — % of this project's Assignments that are done.
    const totalAssignments = projectAssignments.length;
    const doneAssignments = projectAssignments.filter(a => a.Status === 'Completed' || a.Status === 'Closed').length;
    const progressPct = totalAssignments > 0 ? Math.round((doneAssignments / totalAssignments) * 100) : 0;

    // Task-wise Distribution — one row per (Task, Assignee) pair, since a
    // Task can have several independent Assignments (one per assignee).
    // A Task with nobody assigned yet still gets a row, shown as
    // "Unassigned", so the table reflects the whole project's task list,
    // not just the ones someone's already on.
    const taskRows = [];
    tasksForProject(project.ProjectID).forEach(t => {
      const taskAssignments = state.assignments.filter(a => a.TaskID === t.TaskID);
      if (taskAssignments.length === 0) {
        taskRows.push({ taskName: t.TaskName, dimension: t.Dimension, priority: t.Priority, dueDate: t.DueDate, assigneeName: null, status: null });
      } else {
        taskAssignments.forEach(a => {
          taskRows.push({ taskName: t.TaskName, dimension: t.Dimension, priority: t.Priority, dueDate: t.DueDate, assigneeName: employeeName(a.AssignedTo), status: a.Status });
        });
      }
    });

    const statusColorFallback = { Assigned: '#B0A4E3', Working: '#F2C14E', Review: '#7EC8E3', Completed: '#6FCF97', Closed: '#9E9E9E' };
    const statusColor = s => (typeof PMP_CONFIG !== 'undefined' && PMP_CONFIG.STATUS_COLORS && PMP_CONFIG.STATUS_COLORS[s]) || statusColorFallback[s] || '#ccc';

    col.innerHTML = `
      <div style="display:grid; grid-template-columns:1fr 320px; gap:16px; align-items:start;">
        <div class="pmp-card" style="border-top:4px solid ${PmpUtils.colorFromId(project.ProjectID, 55)};">
          <div style="font-weight:700; font-size:15px; margin-bottom:4px;">📝 Project Details</div>
          <div style="font-size:12px; color:var(--pmp-text-muted); margin-bottom:16px;">You can edit this project's name, status, and start date.</div>
          <form id="pmp-pe-project-form">
            <div class="pmp-form-row">
              <label>Project Name</label>
              <input type="text" name="projectName" value="${PmpUtils.escapeHtml(project.ProjectName)}" required>
            </div>
            <div class="pmp-form-grid">
              <div class="pmp-form-row">
                <label>Project ID</label>
                <input type="text" value="${PmpUtils.escapeHtml(project.ProjectID)}" disabled style="font-family:monospace; font-weight:700;">
              </div>
              <div class="pmp-form-row">
                <label>Client</label>
                <input type="text" value="${client ? PmpUtils.escapeHtml(client.ClientName) : ''}" disabled>
              </div>
            </div>
            <div class="pmp-form-grid">
              <div class="pmp-form-row">
                <label>Status</label>
                <select name="status">
                  ${['Active', 'ReadyForBilling', 'Billed', 'Archived'].map(s => `<option value="${s}" ${project.Status === s ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
              </div>
              <div class="pmp-form-row">
                <label>Start Date</label>
                <input type="date" name="startDate" value="${project.StartDate ? new Date(project.StartDate).toISOString().slice(0, 10) : ''}">
              </div>
            </div>
            <button type="submit" class="pmp-btn pmp-btn-primary" style="margin-top:6px;">Save changes</button>
          </form>
        </div>

        <div style="display:flex; flex-direction:column; gap:16px;">
          <div class="pmp-card">
            <div style="font-weight:700; margin-bottom:12px;">🗂️ Task Breakdown</div>
            ${totalAssignments === 0 ? '<div class="pmp-empty" style="margin:0;">No tasks assigned on this project yet.</div>' : Object.keys(statusCounts).map(s => `
              <div style="display:flex; align-items:center; justify-content:space-between; padding:5px 0;">
                <span style="display:flex; align-items:center; gap:7px; font-size:13px;">
                  <span style="width:9px; height:9px; border-radius:50%; background:${statusColor(s)}; flex-shrink:0;"></span>
                  ${s}
                </span>
                <span style="font-weight:700; font-size:13px; background:var(--pmp-border,#f0f0f0); padding:1px 9px; border-radius:10px;">${statusCounts[s]}</span>
              </div>
            `).join('')}
          </div>

          <div class="pmp-card">
            <div style="font-weight:700; margin-bottom:8px;">📈 Project Progress</div>
            <div style="display:flex; align-items:baseline; gap:8px; margin-bottom:8px;">
              <span style="font-size:26px; font-weight:800; color:var(--status-completed);">${progressPct}%</span>
              <span style="font-size:12px; color:var(--pmp-text-muted);">${doneAssignments} of ${totalAssignments} assignments completed</span>
            </div>
            <div style="height:9px; border-radius:5px; background:var(--pmp-border,#eee); overflow:hidden;">
              <div style="height:100%; width:${progressPct}%; background:linear-gradient(90deg, var(--status-working), var(--status-completed)); border-radius:5px; transition:width 0.3s;"></div>
            </div>
          </div>

          <div class="pmp-card">
            <div style="font-weight:700; margin-bottom:12px;">👥 Team Performance</div>
            ${Object.keys(byEmployee).length === 0 ? '<div class="pmp-empty" style="margin:0;">No task activity logged against this project yet.</div>' : Object.keys(byEmployee).map(empId => {
              const stats = byEmployee[empId];
              const pct = stats.assigned > 0 ? Math.round((stats.completed / stats.assigned) * 100) : 0;
              const dot = PmpUtils.colorFromId(empId, 55);
              return `
                <div style="margin-bottom:10px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                    <span style="display:flex; align-items:center; gap:7px; font-size:13px; font-weight:600;">
                      <span style="width:8px; height:8px; border-radius:50%; background:${dot}; flex-shrink:0;"></span>
                      ${PmpUtils.escapeHtml(employeeName(empId))}
                    </span>
                    <span style="font-size:12px; color:var(--pmp-text-muted);">${stats.completed}/${stats.assigned} done</span>
                  </div>
                  <div style="height:6px; border-radius:3px; background:var(--pmp-border,#eee); overflow:hidden;">
                    <div style="height:100%; width:${pct}%; background:${dot};"></div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="pmp-card" style="margin-top:16px;">
        <div style="font-weight:700; margin-bottom:12px;">📋 Task-wise Distribution</div>
        ${taskRows.length === 0 ? '<div class="pmp-empty" style="margin:0;">No tasks under this project yet.</div>' : `
          <table class="pmp-table">
            <thead><tr><th>Task</th><th>Dimension</th><th>Priority</th><th>Due</th><th>Assignee</th><th>Status</th></tr></thead>
            <tbody>
              ${taskRows.map((r, idx) => `
                <tr style="${idx % 2 === 1 ? 'background:rgba(0,0,0,0.02);' : ''}">
                  <td style="font-weight:600;">${PmpUtils.escapeHtml(r.taskName)}</td>
                  <td>${r.dimension ? PmpUtils.escapeHtml(r.dimension) : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
                  <td>${r.priority ? `<span class="pmp-badge pmp-badge-priority-${r.priority}">${PmpUtils.escapeHtml(r.priority)}</span>` : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
                  <td>${r.dueDate ? PmpUtils.formatDate(r.dueDate) : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
                  <td>${r.assigneeName ? PmpUtils.escapeHtml(r.assigneeName) : '<span style="color:var(--pmp-text-muted); font-style:italic;">Unassigned</span>'}</td>
                  <td>${r.status ? `<span class="pmp-badge" style="background:${statusColor(r.status)}; color:#fff;">${PmpUtils.escapeHtml(r.status)}</span>` : '<span style="color:var(--pmp-text-muted);">—</span>'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `}
      </div>
    `;

    col.querySelector('#pmp-pe-project-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const res = await PmpApi.updateProject({
        projectId: project.ProjectID,
        projectName: fd.get('projectName'),
        startDate: fd.get('startDate'),
        status: fd.get('status')
      });

      if (res.success) {
        PmpUtils.toast('Project updated', 'success');
        await refreshAll();
      } else {
        PmpUtils.toast(res.error || 'Could not update project', 'error');
        submitBtn.disabled = false;
      }
    });
  }

  // ============================================================
  // Create Client / Create Project modals — same backend calls the
  // existing Projects tab already uses, just reachable from here too.
  // ============================================================

  function openClientModal() {
    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>New Client</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-pe-client-form">
          <div class="pmp-form-row">
            <label>Client Name</label>
            <input type="text" name="clientName" required>
          </div>
          <div class="pmp-form-grid">
            <div class="pmp-form-row">
              <label>Contact Person</label>
              <input type="text" name="contactPerson">
            </div>
            <div class="pmp-form-row">
              <label>Phone</label>
              <input type="text" name="phone">
            </div>
          </div>
          <div class="pmp-form-row">
            <label>Email</label>
            <input type="email" name="email">
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">Create client</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-pe-client-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const res = await PmpApi.createClient({
        clientName: fd.get('clientName'),
        contactPerson: fd.get('contactPerson'),
        phone: fd.get('phone'),
        email: fd.get('email')
      });

      if (res.success) {
        PmpUtils.toast('Client created', 'success');
        close();
        await refreshAll();
      } else {
        PmpUtils.toast(res.error || 'Could not create client', 'error');
        submitBtn.disabled = false;
      }
    });
  }

  function openProjectModal() {
    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>New Project</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-pe-project-create-form">
          <div class="pmp-form-row">
            <label>Client</label>
            <select name="clientId" required>
              <option value="">Select client</option>
              ${state.clients.map(c => `<option value="${c.ClientID}">${PmpUtils.escapeHtml(c.ClientName)}</option>`).join('')}
            </select>
          </div>
          <div class="pmp-form-row">
            <label>Project Name</label>
            <input type="text" name="projectName" required>
          </div>
          <div class="pmp-form-row">
            <label>Start Date</label>
            <input type="date" name="startDate">
          </div>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">Create project</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-pe-project-create-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const res = await PmpApi.createProject({
        clientId: fd.get('clientId'),
        projectName: fd.get('projectName'),
        startDate: fd.get('startDate')
      });

      if (res.success) {
        PmpUtils.toast('Project created', 'success');
        close();
        await refreshAll();
      } else {
        PmpUtils.toast(res.error || 'Could not create project', 'error');
        submitBtn.disabled = false;
      }
    });
  }

  return { init, refresh: refreshAll };
})();