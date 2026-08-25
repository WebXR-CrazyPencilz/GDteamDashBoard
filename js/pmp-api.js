/**
 * PMP — API wrapper
 * Thin fetch layer around the Apps Script Web App. All calls are POST
 * with a JSON body containing `action` plus action-specific params.
 */

const PmpApi = (function () {

  async function call(action, params) {
    const payload = Object.assign({ action: action }, params || {});

    let response;
    try {
      response = await fetch(PMP_CONFIG.API_URL, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    } catch (networkErr) {
      return { success: false, error: 'Network error: ' + networkErr.message };
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      return { success: false, error: 'Invalid server response' };
    }

    return data;
  }

  return {
    // Auth
    login: (username, password) => call('pmp_login', { username, password }), // HR signs in through this SAME action too — HR is a real Employees-sheet row (Role = 'HR'), authenticated the normal way, not a ghost account
    changeOwnPassword: (data) => call('pmp_changeOwnPassword', data), // { employeeId, currentPassword, newPassword }

    // Clients
    getClients: () => call('pmp_getClients'),
    createClient: (data) => call('pmp_createClient', data),
    updateClient: (data) => call('pmp_updateClient', data),

    // Projects
    getProjects: () => call('pmp_getProjects'),
    createProject: (data) => call('pmp_createProject', data),
    updateProject: (data) => call('pmp_updateProject', data),
    // Monthly random Project -> Team Lead assignment. Generates once per
    // calendar month and is stored server-side so it stays fixed for that
    // month no matter how many times the page reloads or who loads it.
    // Calling generate again for a month that's already been generated
    // must be a no-op on the backend (return the existing assignment,
    // don't re-roll) — see pmp-teamlead.js for how this is used.
    getMonthlyProjectAssignments: (month) => call('pmp_getMonthlyProjectAssignments', { month }), // { month: 'YYYY-MM' }
    generateMonthlyProjectAssignments: (data) => call('pmp_generateMonthlyProjectAssignments', data), // { month: 'YYYY-MM', generatedBy }

    // Tasks
    // A Task is the deliverable (e.g. "Brochure Page 5"); it can carry many
    // Assignments, one per assignee. Shared fields (project, priority, due
    // date, notes) live on the Task, not on each Assignment.
    getTasks: () => call('pmp_getTasks'),
    createTask: (data) => call('pmp_createTask', data),
    updateTask: (data) => call('pmp_updateTask', data),

    // Assignments
    // getMyTeam / getTeamAssignments keep their names for now to minimize
    // frontend churn, but no longer scope by ReportsTo — there's no fixed
    // team ownership, so these return the full active pool / all assignments.
    getAssignments: () => call('pmp_getAssignments'),
    getMyAssignments: (employeeId) => call('pmp_getMyAssignments', { employeeId }),
    getTeamAssignments: (teamLeadId) => call('pmp_getTeamAssignments', { teamLeadId }),
    // Creates one independent Assignment per employeeId against a single Task.
    createAssignments: (data) => call('pmp_createAssignments', data), // { taskId, employeeIds, createdBy }
    // Atomic "new Task + its initial assignees" in one call — used by the
    // "+ New Task" creation flow. If anything fails partway, the backend
    // rolls back everything it created, so a failed attempt never leaves an
    // orphan Task with nobody assigned to it. Adding/removing people on an
    // already-existing Task still uses updateTask + createAssignments +
    // deleteAssignment separately — this is only for brand-new Tasks.
    createTaskWithAssignments: (data) => call('pmp_createTaskWithAssignments', data), // { projectId, taskName, dimension, priority, dueDate, notes, employeeIds, createdBy, estimatedHours }
    updateAssignment: (data) => call('pmp_updateAssignment', data),
    updateAssignmentStatus: (data) => call('pmp_updateAssignmentStatus', data),
    // Pause/Resume are independent of Status — see Code.gs for why. Either
    // the assignee themself or a Team Lead/Manager (managerOverride: true)
    // can call these.
    pauseAssignment: (data) => call('pmp_pauseAssignment', data), // { assignmentId, employeeId, reason?, managerOverride? }
    resumeAssignment: (data) => call('pmp_resumeAssignment', data), // { assignmentId, employeeId, managerOverride? }
    deleteAssignment: (data) => call('pmp_deleteAssignment', data),

    // Employees
    // getMyTeam intentionally has no teamLeadId-based filtering server-side
    // anymore — see note above. Any active Team Lead or Manager can see and
    // assign to the full Employee pool.
    getEmployees: () => call('pmp_getEmployees'),
    getEmployeesFull: () => call('pmp_getEmployeesFull'),
    getMyTeam: (teamLeadId) => call('pmp_getMyTeam', { teamLeadId }),
    createEmployee: (data) => call('pmp_createEmployee', data),
    updateEmployee: (data) => call('pmp_updateEmployee', data),

    // Work Inbox (architecture in place, UI not built yet)
    getMyInbox: (recipientId) => call('pmp_getMyInbox', { recipientId }),
    markNotificationRead: (notificationId) => call('pmp_markNotificationRead', { notificationId }),

    // Timesheet (read-only ActivityLog access, plus employee-entered entries)
    getActivityLog: () => call('pmp_getActivityLog'),
    getTimesheetEntries: (data) => call('pmp_getTimesheetEntries', data), // { employeeId, date }
    getAllTimesheetEntries: (data) => call('pmp_getAllTimesheetEntries', data), // { employeeId } — every submitted entry, all dates
    // Every submitted Leave entry across ALL active employees in one call —
    // added for the HR Portal (pmp-hr.js), see pmp_getAllLeaveEntries in
    // Code.gs for why this exists instead of looping getAllTimesheetEntries
    // per employee.
    getAllLeaveEntries: () => call('pmp_getAllLeaveEntries'),
    upsertTimesheetEntry: (data) => call('pmp_upsertTimesheetEntry', data), // { employeeId, date, entryId?, assignmentId, clientName, projectName, taskName, dimension, startTime, endTime, notes, source }
    saveTimesheetEntries: (data) => call('pmp_saveTimesheetEntries', data), // { employeeId, date, entries }

    // Setup (dev use only)
    setupSheets: () => call('pmp_setupSheets')
  };
})();