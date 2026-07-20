/**
 * PMP — Employee Management (Manager-only admin panel)
 *
 * Lets a Manager create and edit user accounts (Employee / Manager / TeamLead)
 * without touching the spreadsheet by hand. Self-sufficient module: owns its
 * own state, fed by init(). Rendered into whatever containerId it's given.
 *
 * Employee / TeamLead / Manager are flat, equal-tier roles — there is no
 * "reports to" relationship to configure here. Any Team Lead can assign work
 * to any active Employee; the Manager just administers accounts.
 */

const PmpEmployees = (function () {

  let state = {
    employees: [],
    containerId: null
  };

  async function init(containerId) {
    state.containerId = containerId;
    renderShell();
    await refresh();
  }

  async function refresh() {
    const res = await PmpApi.getEmployeesFull();
    if (res.success) state.employees = res.employees;
    render();
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="margin:0;">Employee Management</h3>
        <button class="pmp-btn pmp-btn-primary" id="pmp-emp-new-btn">+ Add person</button>
      </div>
      <div id="pmp-emp-content"></div>
    `;
    document.getElementById('pmp-emp-new-btn').addEventListener('click', () => openEmployeeModal());
  }

  function render() {
    const content = document.getElementById('pmp-emp-content');
    if (!content) return;

    if (state.employees.length === 0) {
      content.innerHTML = `<div class="pmp-empty">No accounts yet. Add your first person to get started.</div>`;
      return;
    }

    const rows = state.employees.map(emp => `
      <tr>
        <td>${PmpUtils.escapeHtml(emp.employeeId)}</td>
        <td>${PmpUtils.escapeHtml(emp.name)}</td>
        <td>${PmpUtils.escapeHtml(emp.username)}</td>
        <td><span class="pmp-badge" style="background:#F0E9D8;">${PmpUtils.escapeHtml(emp.role)}</span></td>
        <td>${emp.active
          ? '<span class="pmp-badge" style="background:var(--status-completed); color:#fff;">Active</span>'
          : '<span class="pmp-badge" style="background:var(--status-closed); color:#fff;">Inactive</span>'}</td>
        <td><button class="pmp-btn" data-edit-emp="${emp.employeeId}">Edit</button></td>
      </tr>
    `).join('');

    content.innerHTML = `
      <table class="pmp-table">
        <thead>
          <tr><th>ID</th><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    content.querySelectorAll('[data-edit-emp]').forEach(btn => {
      btn.addEventListener('click', () => openEmployeeModal(btn.dataset.editEmp));
    });
  }

  function openEmployeeModal(employeeId) {
    const editing = employeeId ? state.employees.find(e => e.employeeId === employeeId) : null;

    const overlay = document.createElement('div');
    overlay.className = 'pmp-modal-overlay';
    overlay.innerHTML = `
      <div class="pmp-modal">
        <div class="pmp-modal-header">
          <h3>${editing ? 'Edit Person' : 'Add Person'}</h3>
          <button class="pmp-modal-close">&times;</button>
        </div>
        <form id="pmp-emp-form">
          <div class="pmp-form-row">
            <label>Full Name</label>
            <input type="text" name="name" required value="${editing ? PmpUtils.escapeHtml(editing.name) : ''}">
          </div>
          <div class="pmp-form-grid">
            <div class="pmp-form-row">
              <label>Username</label>
              <input type="text" name="username" required value="${editing ? PmpUtils.escapeHtml(editing.username) : ''}">
            </div>
            <div class="pmp-form-row">
              <label>Role</label>
              <select name="role">
                ${PMP_CONFIG.ALL_ROLES.map(r => `<option value="${r}" ${editing && editing.role === r ? 'selected' : ''}>${r === 'TeamLead' ? 'Team Lead' : r}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="pmp-form-row">
            <label>${editing ? 'Reset Password (leave blank to keep current)' : 'Password'}</label>
            <input type="text" name="password" ${editing ? '' : 'required'} placeholder="${editing ? 'Leave blank to keep current password' : ''}">
          </div>
          ${editing ? `
          <div class="pmp-form-row">
            <label>Status</label>
            <select name="active">
              <option value="true" ${editing.active ? 'selected' : ''}>Active</option>
              <option value="false" ${!editing.active ? 'selected' : ''}>Inactive</option>
            </select>
          </div>` : ''}
          <p id="pmp-emp-error" style="color:var(--status-delayed); font-size:12px; display:none;"></p>
          <div style="display:flex; justify-content:flex-end; gap:8px;">
            <button type="button" class="pmp-btn pmp-modal-cancel">Cancel</button>
            <button type="submit" class="pmp-btn pmp-btn-primary">${editing ? 'Save changes' : 'Create account'}</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('.pmp-modal-close').addEventListener('click', close);
    overlay.querySelector('.pmp-modal-cancel').addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#pmp-emp-form').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const errorEl = document.getElementById('pmp-emp-error');
      errorEl.style.display = 'none';

      const submitBtn = e.target.querySelector('button[type="submit"]');
      submitBtn.disabled = true;

      const payload = {
        name: fd.get('name'),
        username: fd.get('username'),
        role: fd.get('role')
      };
      const password = fd.get('password');
      if (password) payload.password = password;

      let res;
      if (editing) {
        payload.employeeId = editing.employeeId;
        payload.active = fd.get('active') === 'true';
        res = await PmpApi.updateEmployee(payload);
      } else {
        res = await PmpApi.createEmployee(payload);
      }

      if (res.success) {
        PmpUtils.toast(editing ? 'Account updated' : 'Account created', 'success');
        close();
        await refresh();
      } else {
        errorEl.textContent = res.error || 'Something went wrong';
        errorEl.style.display = 'block';
        submitBtn.disabled = false;
      }
    });
  }

  return { init, refresh };
})();