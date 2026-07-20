/**
 * PMP — Module: Work Inbox
 *
 * Shows notifications for the logged-in person (Employee or Team Lead) —
 * right now that's just "New Assignment" cards, since that's the only type
 * the backend fires yet (see PMP_CONFIG.NOTIFICATION_TYPES / Code.gs
 * pmp_notifyEmployee). Review Request / Rework / Deadline Reminder /
 * Completed Approval / Announcement all render fine here too — the schema
 * and this UI are ready for them — they just aren't produced by the backend
 * yet, so in practice you'll only see New Assignment cards for now.
 *
 * Self-sufficient module: owns its own state, fed by init(). Portal-agnostic
 * — takes containerId plus an optional onOpenTask callback so whichever
 * shell embeds it (Employee portal, Team Lead portal) decides what "Open
 * Task" actually navigates to, rather than this module hardcoding a route.
 */

const PmpInbox = (function () {

  const TYPE_LABELS = {
    NewAssignment: 'New Assignment',
    ReviewRequest: 'Review Request',
    Rework: 'Rework',
    DeadlineReminder: 'Deadline Reminder',
    CompletedApproval: 'Completed Approval',
    Announcement: 'Announcement'
  };

  let state = {
    recipientId: null,
    notifications: [],
    tasks: [],
    employees: [],
    containerId: null,
    filter: 'unread', // 'unread' | 'all'
    onOpenTask: null,
    onUnreadCountChange: null
  };

  async function init(containerId, recipientId, opts) {
    state.containerId = containerId;
    state.recipientId = recipientId;
    state.onOpenTask = (opts && opts.onOpenTask) || null;
    state.onUnreadCountChange = (opts && opts.onUnreadCountChange) || null;
    renderShell();
    await refresh();
  }

  async function refresh() {
    const [inboxRes, tasksRes, employeesRes] = await Promise.all([
      PmpApi.getMyInbox(state.recipientId),
      PmpApi.getTasks(),
      PmpApi.getEmployees()
    ]);

    if (inboxRes.success) state.notifications = inboxRes.notifications;
    if (tasksRes.success) state.tasks = tasksRes.tasks;
    if (employeesRes.success) state.employees = employeesRes.employees;

    render();
    notifyUnreadCount();
  }

  function unreadCount() {
    return state.notifications.filter(n => !n.Read).length;
  }

  function notifyUnreadCount() {
    if (typeof state.onUnreadCountChange === 'function') {
      state.onUnreadCountChange(unreadCount());
    }
  }

  function container() {
    return document.getElementById(state.containerId);
  }

  function renderShell() {
    container().innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <h3 style="margin:0;">Work Inbox</h3>
        <div class="pmp-filters" style="margin:0;">
          <select id="pmp-inbox-filter">
            <option value="unread">Unread</option>
            <option value="all">All</option>
          </select>
        </div>
      </div>
      <div id="pmp-inbox-content"></div>
    `;

    document.getElementById('pmp-inbox-filter').addEventListener('change', e => {
      state.filter = e.target.value;
      render();
    });
  }

  function render() {
    const content = document.getElementById('pmp-inbox-content');
    if (!content) return;

    const visible = state.filter === 'unread'
      ? state.notifications.filter(n => !n.Read)
      : state.notifications;

    const sorted = [...visible].sort((a, b) => new Date(b.CreatedDate || 0) - new Date(a.CreatedDate || 0));

    if (sorted.length === 0) {
      content.innerHTML = `<div class="pmp-empty">${state.filter === 'unread' ? "You're all caught up." : 'No notifications yet.'}</div>`;
      return;
    }

    content.innerHTML = `<div class="pmp-card-grid">${sorted.map(notificationCard).join('')}</div>`;

    content.querySelectorAll('[data-open-notification]').forEach(btn => {
      btn.addEventListener('click', () => openNotification(btn.dataset.openNotification));
    });
  }

  function notificationCard(n) {
    const task = state.tasks.find(t => t.TaskID === n.RelatedTaskID);
    const assignedBy = task ? state.employees.find(e => e.employeeId === task.CreatedBy) : null;
    const label = TYPE_LABELS[n.Type] || n.Type;

    return `
      <div class="pmp-card" style="${n.Read ? '' : 'border-left-color:var(--status-assigned);'}">
        <div class="pmp-assignment-meta">
          <span class="pmp-badge">${PmpUtils.escapeHtml(label)}</span>
          ${!n.Read ? '<span class="pmp-badge" style="background:var(--status-assigned); color:#fff;">New</span>' : ''}
        </div>
        <div class="pmp-assignment-title">${task ? PmpUtils.escapeHtml(task.TaskName) : PmpUtils.escapeHtml(n.Title)}</div>
        ${task ? `
        <div class="pmp-assignment-meta">
          <span class="pmp-badge pmp-badge-priority-${task.Priority}">${PmpUtils.escapeHtml(task.Priority || '')}</span>
          <span>Due ${PmpUtils.formatDate(task.DueDate)}</span>
          ${assignedBy ? `<span>Assigned by ${PmpUtils.escapeHtml(assignedBy.name)}</span>` : ''}
        </div>` : ''}
        ${n.Message ? `<div style="font-size:12px; color:var(--pmp-text-muted);">${PmpUtils.escapeHtml(n.Message)}</div>` : ''}
        <div class="pmp-assignment-actions">
          <button class="pmp-btn pmp-btn-primary" data-open-notification="${n.NotificationID}">Open Task</button>
        </div>
      </div>
    `;
  }

  async function openNotification(notificationId) {
    const notification = state.notifications.find(n => n.NotificationID === notificationId);
    if (!notification) return;

    if (!notification.Read) {
      notification.Read = true; // optimistic — avoids waiting on the network to update the badge/list
      render();
      notifyUnreadCount();
      const res = await PmpApi.markNotificationRead(notificationId);
      if (!res.success) {
        notification.Read = false; // roll back if the backend call actually failed
        render();
        notifyUnreadCount();
        PmpUtils.toast(res.error || 'Could not mark as read', 'error');
        return;
      }
    }

    if (typeof state.onOpenTask === 'function') {
      state.onOpenTask({
        taskId: notification.RelatedTaskID || '',
        assignmentId: notification.RelatedAssignmentID || ''
      });
    }
  }

  return { init, refresh, unreadCount };
})();