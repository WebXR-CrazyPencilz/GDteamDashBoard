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
    login: (username, password) => call('pmp_login', { username, password }),

    // Clients
    getClients: () => call('pmp_getClients'),
    createClient: (data) => call('pmp_createClient', data),
    updateClient: (data) => call('pmp_updateClient', data),

    // Projects
    getProjects: () => call('pmp_getProjects'),
    createProject: (data) => call('pmp_createProject', data),
    updateProject: (data) => call('pmp_updateProject', data),

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
    updateAssignment: (data) => call('pmp_updateAssignment', data),
    updateAssignmentStatus: (data) => call('pmp_updateAssignmentStatus', data),
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

    // Setup (dev use only)
    setupSheets: () => call('pmp_setupSheets')
  };
})();